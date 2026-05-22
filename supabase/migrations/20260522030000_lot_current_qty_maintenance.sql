-- supabase/migrations/20260522030000_lot_current_qty_maintenance.sql
-- Phase 2 structural fix — restore stock_lots.current_qty maintenance.
--
-- Bug (structural):
--   Phase 2 (20260519010400) had apply_movement_to_sil() update
--   stock_lots.current_qty on every movement that carried a lot_id. The Phase
--   0.7 hotfix 20260519080000_fix_sil_trigger_xmax.sql rewrote
--   apply_movement_to_sil() to fix the xmax INSERT/UPDATE detection — but it
--   based the rewrite on the Phase 1 body and DROPPED the Phase 2 lot-qty
--   update. apply_movement_to_lot_qty() only ever READ current_qty (guard +
--   auto-deplete); it never applied qty_delta. Result: since Phase 0.7, NOTHING
--   updates stock_lots.current_qty. It stays frozen at the value createLot()
--   inserted — so issuing, adjusting, or topping up a lot does not move its
--   balance, and v_lots_with_remaining / the ล็อตยา list show stale numbers.
--
-- Fix:
--   apply_movement_to_lot_qty() becomes the SINGLE owner of
--   stock_lots.current_qty: it now applies qty_delta, then keeps its existing
--   negative-balance guard and auto-deplete. apply_movement_to_sil() stays
--   focused on stock_item_locations only (it is shared with non-lot movements).
--   The matching FE change sets createLot() current_qty = 0 so the lot's own
--   receive movement — not the INSERT — establishes the balance (single source
--   of truth = the movement ledger).
--
-- One-time reconcile:
--   Every existing lot's current_qty is recomputed from the ledger
--   (SUM(stock_movements.qty_delta)), correcting values frozen by the bug.
--
-- Trigger firing order on stock_movements INSERT is unchanged: trg_lot_qty_apply
-- and trg_sm_apply are both AFTER INSERT on disjoint tables (stock_lots vs
-- stock_item_locations); either raising rolls back the whole transaction.
--
-- Scope: only movements with a non-NULL lot_id (i.e. lot-tracked medication).
-- Non-lot inventory, oxygen, linen, bags are untouched.
--
-- Depends on: 20260519010400_stock_lot_triggers.sql, 20260519020000.
-- Idempotent: CREATE OR REPLACE FUNCTION + the reconcile UPDATE is deterministic.

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
  -- stock_lots.current_qty is maintained (structural fix 20260522030000 —
  -- restores the lot-qty update the Phase 0.7 xmax hotfix dropped).
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

  RETURN NEW;
END;
$apply_lot_qty$;

COMMENT ON FUNCTION apply_movement_to_lot_qty() IS
  'Phase 2 AFTER INSERT on stock_movements. SINGLE owner of '
  'stock_lots.current_qty: applies qty_delta, rejects negative balance, '
  'auto-depletes an emptied active lot. SECURITY DEFINER to bypass stock_lots '
  'RLS. Structural fix 20260522030000 restored the qty_delta application that '
  'the Phase 0.7 xmax hotfix dropped from apply_movement_to_sil.';

-- ──────────────────────────────────────────────────────────────────────────
-- One-time reconcile — recompute every lot's current_qty from the ledger.
-- ──────────────────────────────────────────────────────────────────────────
UPDATE stock_lots sl
SET current_qty = COALESCE(
      (SELECT SUM(sm.qty_delta) FROM stock_movements sm WHERE sm.lot_id = sl.id),
      0),
    updated_at = now();

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Every lot's current_qty now equals its ledger sum (expect 0 mismatches):
--    SELECT count(*) FROM stock_lots sl
--    WHERE sl.current_qty <> COALESCE(
--      (SELECT SUM(qty_delta) FROM stock_movements WHERE lot_id = sl.id), 0);
--    Expected: 0
--
-- B) Function is SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='apply_movement_to_lot_qty';
--    Expected: 1 row, prosecdef = true
