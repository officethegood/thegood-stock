-- supabase/migrations/20261105010000_guard_lot_at_location.sql
-- Guard — an outgoing movement may only take a lot from a location that holds it.
--
-- Report (Chittawan 2026-11-05): after moving Miracid / Strong-K between boxes the
-- lot numbers "swap by themselves" and the drawer warns the lots exceed the
-- location's qty. Same class as the recurring "จำนวนรวมไม่เท่ากัน" reports.
--
-- Root cause (the real one behind the recurring per-location-lot drift):
--   stock_lots.current_qty is GLOBAL and stock_item_locations.qty is per location,
--   but nothing checked the pair (location, lot). The transfer modal, the เบิก/ของหาย
--   lot picker and the borrow lot picker all list lots of the WHOLE item, and the
--   transfer modal silently preselects the soonest-expiry lot. So moving 15 out of
--   box 3 (holding only lot B) with lot A preselected writes:
--     box 3: lot A -15   (negative — hidden by v_item_location_lots HAVING SUM>0)
--     box 1: lot A +15   (a lot that was never physically in box 3)
--   Every existing guard passes: sil at box 3 has 21, lot A has stock somewhere.
--   20260715034000 requiring lot_id did NOT close this.
--
-- Fix:
--   BEFORE INSERT trigger: a movement with lot_id and qty_delta < 0 is rejected
--   unless SUM(qty_delta) for that (location, lot) covers it. Enforced in the DB so
--   every path is covered (transfer_stock RPC, direct inserts, future screens). An
--   advisory lock per (location, lot) closes the check-then-insert race.
--   Incoming movements and lot-less movements are untouched. rpc_recall_lot only
--   removes qty the ledger shows at each location, so it passes.
--
-- PREFLIGHT: sql/diag-lot-location-20261105.sql section B lists stock with no lot
--   on lot-tracked items. Those units cannot be taken out through a lot once this
--   is applied (they could only have been taken by creating a negative lot before).
--
-- Depends on: stock_movements. Does not touch check_lot_status / apply_* triggers.
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS, CREATE INDEX IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_sm_location_lot
  ON stock_movements(location_id, lot_id)
  WHERE lot_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_lot_at_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guard_lot_at_location$
DECLARE
  v_here bigint;
BEGIN
  -- Serialize concurrent takes from the same (location, lot); released at txn end.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.location_id::text || ':' || NEW.lot_id::text, 0)
  );

  SELECT COALESCE(SUM(qty_delta), 0)
    INTO v_here
  FROM stock_movements
  WHERE location_id = NEW.location_id
    AND lot_id      = NEW.lot_id;

  IF v_here < -NEW.qty_delta THEN
    RAISE EXCEPTION 'ล็อตนี้มีของไม่พอในตำแหน่งนี้ (มี % ต้องการ %)',
      GREATEST(v_here, 0), -NEW.qty_delta;
  END IF;

  RETURN NEW;
END;
$guard_lot_at_location$;

COMMENT ON FUNCTION guard_lot_at_location() IS
  'BEFORE INSERT on stock_movements (lot_id set, qty_delta < 0). Rejects taking more '
  'of a lot from a location than the ledger shows there, so per-(location, lot) '
  'balance can never go negative. 20261105010000.';

DROP TRIGGER IF EXISTS trg_sm_lot_at_location ON stock_movements;
CREATE TRIGGER trg_sm_lot_at_location
  BEFORE INSERT ON stock_movements
  FOR EACH ROW
  WHEN (NEW.lot_id IS NOT NULL AND NEW.qty_delta < 0)
  EXECUTE FUNCTION guard_lot_at_location();

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Trigger present:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'stock_movements'::regclass AND tgname = 'trg_sm_lot_at_location';
--    -- Expected: 1 row
--
-- B) No NEW negative spots after a day of normal use (expect the list not to grow):
--    SELECT count(*) FROM (
--      SELECT 1 FROM stock_movements WHERE lot_id IS NOT NULL
--      GROUP BY location_id, lot_id HAVING SUM(qty_delta) < 0) x;
