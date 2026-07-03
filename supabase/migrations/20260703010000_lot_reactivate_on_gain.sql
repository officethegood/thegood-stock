-- supabase/migrations/20260703010000_lot_reactivate_on_gain.sql
-- Bug fix — re-receiving a fully-issued lot number was impossible (deadlock).
--
-- Bug:
--   lot_number is UNIQUE per item (uq_lot_per_item). When a lot is fully issued
--   the trigger auto-sets status='depleted' — the row stays (correct, audit).
--   When more stock of the SAME batch arrives:
--     * "ล็อตใหม่" tab      → INSERT hits 23505 → FE says use "เพิ่มให้ล็อตเดิม" (M-47)
--     * "เพิ่มให้ล็อตเดิม" → FE only listed status='active' lots → empty → dead end.
--   FE side is fixed (inventory.js now lists non-expired depleted lots). This
--   migration fixes the DB side: a receive into a depleted lot must bring the
--   lot BACK to 'active' — otherwise the topped-up lot stays status='depleted'
--   and remains invisible to the FEFO picker (fetchAvailableLots filters
--   status='active'), i.e. stock exists but can never be issued.
--
-- Fix:
--   apply_movement_to_lot_qty(): add the symmetric counterpart of auto-deplete —
--   an incoming movement (qty_delta > 0) that raises a DEPLETED lot's balance
--   above 0 re-activates it. If the lot's expiry date has already passed it goes
--   to 'expired' instead (matches the daily cron; prevents a resurrected lot
--   from being issuable during the pre-cron window). recalled/expired lots are
--   NOT touched — recall/expiry are terminal by design.
--
-- Everything else in the function is carried forward VERBATIM from
-- 20260522030000_lot_current_qty_maintenance.sql.
--
-- Depends on: 20260522030000. Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION apply_movement_to_lot_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $apply_lot_qty$
DECLARE
  v_new_lot_qty int;
BEGIN
  -- Only act when a lot is referenced.
  IF NEW.lot_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Apply the movement to the lot's running balance. This is the SINGLE place
  -- stock_lots.current_qty is maintained.
  UPDATE stock_lots
    SET current_qty = current_qty + NEW.qty_delta,
        updated_at  = now(),
        updated_by  = NEW.performed_by
  WHERE id = NEW.lot_id
  RETURNING current_qty INTO v_new_lot_qty;

  IF v_new_lot_qty IS NULL THEN
    RAISE EXCEPTION
      'apply_movement_to_lot_qty: stock_lots row % not found (movement %)',
      NEW.lot_id, NEW.id;
  END IF;

  -- Negative balance is not allowed — reject the movement (rolls back the txn).
  IF v_new_lot_qty < 0 THEN
    RAISE EXCEPTION
      'movement would drive lot current_qty negative for lot % (item %, movement %)',
      NEW.lot_id, NEW.item_id, NEW.id;
  END IF;

  -- Auto-deplete: an outgoing movement that empties an active lot marks it
  -- depleted. (No-op for lots already expired/recalled/depleted.)
  IF v_new_lot_qty = 0 AND NEW.qty_delta < 0 THEN
    UPDATE stock_lots
      SET status = 'depleted', updated_at = now()
    WHERE id = NEW.lot_id
      AND status = 'active';
  END IF;

  -- Auto-reactivate (20260703010000): an incoming movement that refills a
  -- DEPLETED lot brings it back — 'active' normally, 'expired' if its expiry
  -- date already passed. Symmetric with auto-deplete. recalled stays recalled.
  IF v_new_lot_qty > 0 AND NEW.qty_delta > 0 THEN
    UPDATE stock_lots
      SET status = CASE WHEN expiry_date >= CURRENT_DATE
                        THEN 'active'::stock_lot_status
                        ELSE 'expired'::stock_lot_status END,
          updated_at = now()
    WHERE id = NEW.lot_id
      AND status = 'depleted';
  END IF;

  RETURN NEW;
END;
$apply_lot_qty$;

COMMENT ON FUNCTION apply_movement_to_lot_qty() IS
  'Phase 2 AFTER INSERT on stock_movements. SINGLE owner of '
  'stock_lots.current_qty: applies qty_delta, rejects negative balance, '
  'auto-depletes an emptied active lot, and (20260703010000) auto-reactivates '
  'a depleted lot on refill (active, or expired when past expiry_date). '
  'SECURITY DEFINER to bypass stock_lots RLS.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Depleted lot revives on receive (rolled-back test with a real depleted lot):
--    BEGIN;
--      INSERT INTO stock_movements(client_ref_id,item_id,location_id,movement_type,qty_delta,lot_id)
--      SELECT gen_random_uuid(), sl.item_id,
--             (SELECT location_id FROM stock_movements WHERE lot_id = sl.id LIMIT 1),
--             'receive', 5, sl.id
--      FROM stock_lots sl
--      WHERE sl.status='depleted' AND sl.expiry_date >= CURRENT_DATE
--      LIMIT 1;
--      SELECT id, status, current_qty FROM stock_lots
--      WHERE status='active' AND current_qty=5;   -- expect the revived lot
--    ROLLBACK;
--
-- B) Recalled lot is NOT revived by a gain (should stay recalled):
--    (same pattern with a recalled lot — status must remain 'recalled')
