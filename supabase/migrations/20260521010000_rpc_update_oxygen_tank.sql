-- supabase/migrations/20260521010000_rpc_update_oxygen_tank.sql
-- Phase 5.1 — Admin RPC to edit mutable oxygen_tanks fields after creation.
--
-- Background:
--   oxygen_tanks RLS is FOR UPDATE USING (false) — all direct updates are
--   blocked; only apply_oxygen_movement() (SECURITY DEFINER) may write the
--   table. That makes tank_size / next_inspection_due / last_pressure_psi /
--   notes write-once-at-INSERT. This RPC is the controlled edit path for those
--   four columns. It NEVER references status / current_location_id /
--   last_refill_* — those change only through the oxygen_movements ledger.
--
-- Depends on:
--   20260519050200_oxygen_tanks.sql   (oxygen_tanks table)
--   20260520010000_lookup_lists.sql   (lookup_lists — tank_size validation)
--   Phase 0: app_user_role(), app_username() helpers.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION rpc_update_oxygen_tank(
  p_tank_id             uuid,
  p_tank_size           text,
  p_next_inspection_due date,
  p_last_pressure_psi   int,
  p_notes               text
) RETURNS oxygen_tanks
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_update_oxygen_tank$
DECLARE
  v_row oxygen_tanks;
BEGIN
  -- 1. Admin only.
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขข้อมูลถังได้';
  END IF;

  -- 2. tank_size must be an active lookup_lists value.
  IF NOT EXISTS (
    SELECT 1 FROM lookup_lists
    WHERE kind = 'tank_size' AND code = p_tank_size AND active = true
  ) THEN
    RAISE EXCEPTION 'ขนาดถังไม่ถูกต้อง: %', COALESCE(p_tank_size, 'NULL');
  END IF;

  -- 3. PSI, if provided, must be positive.
  IF p_last_pressure_psi IS NOT NULL AND p_last_pressure_psi <= 0 THEN
    RAISE EXCEPTION 'ค่าแรงดันต้องมากกว่า 0';
  END IF;

  -- 4. Update ONLY the four mutable columns + audit columns.
  UPDATE oxygen_tanks SET
    tank_size           = p_tank_size,
    next_inspection_due = p_next_inspection_due,
    last_pressure_psi   = p_last_pressure_psi,
    notes               = p_notes,
    updated_at          = now(),
    updated_by          = app_username()
  WHERE id = p_tank_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบถังที่ต้องการแก้ไข';
  END IF;

  RETURN v_row;
END;
$rpc_update_oxygen_tank$;

COMMENT ON FUNCTION rpc_update_oxygen_tank(uuid, text, date, int, text) IS
  'Phase 5.1. Admin-only edit path for oxygen_tanks mutable columns '
  '(tank_size, next_inspection_due, last_pressure_psi, notes). SECURITY DEFINER '
  'bypasses the USING(false) UPDATE RLS. Never touches status/location/refill — '
  'those change only via oxygen_movements.';

GRANT EXECUTE ON FUNCTION rpc_update_oxygen_tank(uuid, text, date, int, text)
  TO authenticated;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function exists and is SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname = 'rpc_update_oxygen_tank';
--    Expected: 1 row, prosecdef = true.
--
-- B) oxygen_tanks UPDATE RLS is UNCHANGED (still USING(false)):
--    SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--    FROM pg_policy WHERE polrelid = 'oxygen_tanks'::regclass
--      AND polname = 'oxygen_tanks_update_trigger_only';
--    Expected: using_expr = 'false'.
