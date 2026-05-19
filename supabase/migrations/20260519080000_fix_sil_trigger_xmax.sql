-- supabase/migrations/20260519080000_fix_sil_trigger_xmax.sql
-- Phase 0.7 hotfix — fix apply_movement_to_sil() to correctly distinguish
-- INSERT branch (phantom row) vs UPDATE branch (legitimate exhaust to zero).
--
-- BUG-0.7-R3-02: The original trigger (20260518010500_stock_triggers.sql) used
-- `v_new_qty = 0 AND qty_delta < 0` to detect the "INSERT branch fired with
-- negative delta" case. But this condition is also TRUE when DO UPDATE
-- legitimately brings qty exactly to 0 (e.g. transfer of all the stock out, or
-- the D10 auto-migrate flow that moves all of a parent's direct stock to a new
-- sublocation).
--
-- Fix: use the `xmax = 0` pseudo-column to detect the INSERT branch
-- explicitly. xmax is 0 for newly inserted rows, non-zero for updated rows.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. Trigger binding is unchanged.

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
  -- (Pre-fix bug treated this as an error.)

  UPDATE stock_movements SET qty_after = v_new_qty WHERE id = NEW.id;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION apply_movement_to_sil() IS
  'Phase 1 AFTER INSERT trigger fn. Upserts stock_item_locations.qty and snapshots qty_after. '
  'BUG-0.7-R3-02 fix (2026-05-19): uses RETURNING (xmax = 0) to distinguish INSERT vs UPDATE '
  'branch so legitimate exhaust-to-zero (e.g. D10 auto-migrate) is not rejected. '
  'SECURITY DEFINER to bypass sil RLS.';

-- Trigger binding unchanged — DROP/CREATE not needed because CREATE OR REPLACE
-- FUNCTION rebinds the existing trigger automatically.

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Function updated:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='apply_movement_to_sil';
--    -- expected: 1 row, prosecdef=true
--
-- 2) Smoke test the exhaust-to-zero case (run in a transaction so it rolls back):
--    BEGIN;
--      -- Find an item with stock at some location
--      WITH cand AS (
--        SELECT item_id, location_id, qty
--        FROM   stock_item_locations
--        WHERE  qty > 0
--        LIMIT 1
--      )
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
--      SELECT item_id, location_id, 'issue', -qty FROM cand;
--      -- expected BEFORE fix: ERROR 'movement would drive qty negative ... (no existing stock)'
--      -- expected AFTER  fix: 1 row inserted; qty_after = 0; trigger does NOT raise.
--    ROLLBACK;
--
-- 3) The "no existing stock" path still works (negative delta at fresh pair):
--    INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
--    VALUES ('<random_item_uuid>', '<random_location_uuid>', 'issue', -1);
--    -- expected: ERROR 'movement would drive qty negative ... (no existing stock)'
--    -- AND no phantom row left behind.
