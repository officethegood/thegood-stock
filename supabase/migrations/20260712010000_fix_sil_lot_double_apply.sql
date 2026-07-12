-- supabase/migrations/20260712010000_fix_sil_lot_double_apply.sql
-- Hotfix — stock_lots.current_qty double-applied since 20260709010000.
--
-- Bug report (Chittawan 2026-07-12): ORS 3.3 gm — admin item page (ledger-
-- derived v_item_location_lots) shows 30 (13+17) but the staff เบิก lot picker
-- (v_lots_with_remaining ← stock_lots.current_qty) shows 34 (14+20).
--
-- Root cause — 20260709010000_borrow_lot_support.sql §4 replaced
-- apply_movement_to_sil() "to add un-deplete", but it rebuilt the function from
-- the OLD Phase 2 body (20260519010400) instead of the current one. That old
-- body still contained the stock_lots.current_qty update — which had been
-- removed from this function by the Phase 0.7 xmax hotfix (20260519080000) and
-- re-homed as the SINGLE responsibility of apply_movement_to_lot_qty()
-- (20260522030000). Since 20260709 both AFTER-INSERT triggers on
-- stock_movements applied qty_delta to stock_lots.current_qty:
--
--   trg_lot_qty_apply → apply_movement_to_lot_qty  (correct owner)   ±q
--   trg_sm_apply      → apply_movement_to_sil      (regressed copy)  ±q  ← extra
--
-- Consequences while the regression was live:
--   * every lot-tagged movement moved current_qty by 2× its qty_delta
--     (receives inflate — the reported 30 vs 34; outflows deflate, and can
--     spuriously reject with 'would drive lot current_qty negative' =
--     "ของในล็อตไม่พอ" even though stock exists, or auto-deplete a half-full lot)
--   * the same §4 also reverted the xmax INSERT/UPDATE detection, so a
--     legitimate exhaust-to-zero (issue/transfer ALL stock out of a location)
--     is rejected again with '(no existing stock)' — BUG-0.7-R3-02 returned.
--
-- Fix (this file):
--   1) apply_movement_to_sil() — restore the canonical body: sil upsert +
--      qty_after snapshot + xmax-based guards ONLY. No stock_lots writes.
--      The 20260709 "un-deplete on return" intent is ALREADY covered by the
--      single owner: apply_movement_to_lot_qty() auto-reactivates a depleted
--      lot on ANY qty_delta > 0 with lot_id (20260703010000) — a backfilled
--      'return' included. Nothing is lost by removing §4's copy.
--   2) One-time reconcile — recompute current_qty from the movement ledger for
--      every non-recalled lot (recalled lots are excluded: rpc_recall_lot
--      zeroes them deliberately outside the ledger, 20260703010100), then
--      revive lots the double-decrement wrongly auto-depleted.
--
-- The lot_id backfill on return (validate_borrow_movement) and stock_loans.lot_id
-- from 20260709010000 are correct and remain in place.
--
-- Depends on: 20260709010000. Idempotent: CREATE OR REPLACE + deterministic
--             reconcile UPDATEs.

-- ==========================================================================
-- 1) apply_movement_to_sil — canonical body (20260519080000), sil only
-- ==========================================================================

CREATE OR REPLACE FUNCTION apply_movement_to_sil() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_new_qty    int;
  v_was_insert boolean;
BEGIN
  -- Upsert (item, location) qty. RETURNING (xmax = 0) reliably distinguishes
  -- the INSERT branch (xmax=0 — never been a tuple before) from the DO UPDATE
  -- branch (xmax = the deleting xid of the prior version, always > 0).
  INSERT INTO stock_item_locations(item_id, location_id, qty, last_movement_at)
  VALUES (NEW.item_id, NEW.location_id, GREATEST(0, NEW.qty_delta), NEW.performed_at)
  ON CONFLICT (item_id, location_id) DO UPDATE
    SET qty              = stock_item_locations.qty + NEW.qty_delta,
        last_movement_at = NEW.performed_at
  RETURNING qty, (xmax = 0) INTO v_new_qty, v_was_insert;

  -- INSERT branch fired (no prior (item, location) pair) AND delta negative:
  -- this is the "no existing stock" case. Reject and clean up the phantom
  -- qty=0 row the INSERT branch created.
  IF v_was_insert AND NEW.qty_delta < 0 THEN
    DELETE FROM stock_item_locations
      WHERE item_id = NEW.item_id AND location_id = NEW.location_id AND qty = 0;
    RAISE EXCEPTION 'movement would drive qty negative for item % at location % (no existing stock)',
      NEW.item_id, NEW.location_id;
  END IF;

  -- UPDATE branch ran, but qty went negative. Reject (no phantom row to clean).
  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'movement would drive qty negative for item % at location %',
      NEW.item_id, NEW.location_id;
  END IF;

  -- Reaching qty=0 via UPDATE is a LEGITIMATE exhaust-to-zero — allow it.

  UPDATE stock_movements SET qty_after = v_new_qty WHERE id = NEW.id;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION apply_movement_to_sil() IS
  'Phase 1 AFTER INSERT trigger fn. Upserts stock_item_locations.qty and snapshots qty_after. '
  'Uses RETURNING (xmax = 0) to distinguish INSERT vs UPDATE branch so legitimate '
  'exhaust-to-zero is not rejected (BUG-0.7-R3-02). Owns stock_item_locations ONLY — '
  'stock_lots.current_qty is owned exclusively by apply_movement_to_lot_qty() '
  '(20260522030000; double-apply regression from 20260709010000 removed by 20260712010000). '
  'SECURITY DEFINER to bypass sil RLS.';

-- ==========================================================================
-- 2) One-time reconcile — current_qty back to ledger truth
-- ==========================================================================

-- 2a) Recompute every non-recalled lot from the movement ledger.
--     (recalled lots keep their deliberate zero from rpc_recall_lot.)
UPDATE stock_lots sl
SET current_qty = COALESCE(
      (SELECT SUM(sm.qty_delta) FROM stock_movements sm WHERE sm.lot_id = sl.id),
      0),
    updated_at = now()
WHERE sl.status <> 'recalled';

-- 2b) Revive lots the double-decrement wrongly auto-depleted: recomputed
--     balance says stock remains. Same active/expired split as the
--     auto-reactivate rule in apply_movement_to_lot_qty (20260703010000).
UPDATE stock_lots
SET status = CASE WHEN expiry_date >= CURRENT_DATE
                  THEN 'active'::stock_lot_status
                  ELSE 'expired'::stock_lot_status END,
    updated_at = now()
WHERE status = 'depleted'
  AND current_qty > 0;

-- 2c) Deplete active lots whose recomputed balance is 0 AND that actually had
--     outflow (a freshly created lot legitimately sits at 0 while awaiting its
--     receive movement — leave those alone).
UPDATE stock_lots sl
SET status = 'depleted', updated_at = now()
WHERE sl.status = 'active'
  AND sl.current_qty = 0
  AND EXISTS (SELECT 1 FROM stock_movements sm
              WHERE sm.lot_id = sl.id AND sm.qty_delta < 0);

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) No non-recalled lot deviates from its ledger sum (expect 0):
--    SELECT count(*) FROM stock_lots sl
--    WHERE sl.status <> 'recalled'
--      AND sl.current_qty <> COALESCE(
--        (SELECT SUM(qty_delta) FROM stock_movements WHERE lot_id = sl.id), 0);
--
-- B) Reported case — ORS 3.3 gm: staff picker must now equal the admin view:
--    SELECT sl.lot_number, sl.current_qty, sl.status
--    FROM stock_lots sl
--    JOIN stock_items si ON si.id = sl.item_id
--    WHERE si.sku = 'MED-ORS-3.3gm-SA'
--    ORDER BY sl.expiry_date;
--    -- Expected: 9-2908 = 13, 9-34-59 = 17 (sum 30 = stock_item_locations).
--
-- C) Double-apply is gone — lot movement moves current_qty by exactly qty_delta
--    (rolled-back test with real ids):
--    BEGIN;
--      SELECT current_qty FROM stock_lots WHERE id = '<active lot>';   -- q0
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, client_ref_id)
--      VALUES ('<its item>', '<location with stock>', 'receive', 1,
--              '<active lot>', gen_random_uuid());
--      SELECT current_qty FROM stock_lots WHERE id = '<active lot>';   -- q0 + 1 (NOT q0 + 2)
--    ROLLBACK;
--
-- D) Exhaust-to-zero works again (BUG-0.7-R3-02):
--    BEGIN;
--      WITH cand AS (SELECT item_id, location_id, qty
--                    FROM stock_item_locations
--                    WHERE qty > 0
--                      AND item_id IN (SELECT id FROM stock_items WHERE tracks_lots = false)
--                    LIMIT 1)
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, client_ref_id)
--      SELECT item_id, location_id, 'issue', -qty, gen_random_uuid() FROM cand;
--      -- Expected: succeeds, qty_after = 0 (no '(no existing stock)' error).
--    ROLLBACK;
--
-- E) Return of a borrowed lot unit still restores lot qty ONCE
--    (borrow -1 → current_qty -1; return +1 → back to start).
