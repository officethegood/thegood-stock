-- supabase/migrations/20260521040000_fix_oxygen_state_machine_initial.sql
-- Phase 5.1 hotfix — enforce_oxygen_state_machine() rejected the initial
-- placement movement, which made "เพิ่มถัง O2" fail for every new tank.
--
-- Bug:
--   _saveNewTank() (js/oxygen.js) creates a tank in two steps:
--     1. INSERT oxygen_tanks      → status defaults to 'ready' (table default).
--     2. INSERT oxygen_movements (from_status = NULL, to_status = 'ready')
--        to record the initial placement in the movement log.
--   The BEFORE INSERT trigger enforce_oxygen_state_machine() step 3 checked:
--       IF NEW.from_status IS DISTINCT FROM v_current_status THEN RAISE ...
--   For the initial movement from_status is NULL and the freshly-created tank
--   already sits at 'ready', so NULL IS DISTINCT FROM 'ready' is TRUE and the
--   movement was rejected with:
--       'สถานะปัจจุบันของถัง (ready) ไม่ตรงกับ from_status (NULL)'
--   Step 1 had already committed the tank row, so the user saw an error AND a
--   half-created tank with no movement history was left behind.
--
--   The step-3 comment already documented the intended exception
--   ("unless initial placement where from_status IS NULL") — the code never
--   implemented it. The step-4 transition table DOES allow NULL → ready
--   (Admin only); step 3 fired first and blocked it.
--
-- Fix:
--   Compare COALESCE(NEW.from_status, 'ready') against v_current_status.
--   An initial-placement movement (from_status NULL) conceptually starts from
--   the table-default 'ready' state, so it is accepted only while the tank
--   still sits at 'ready'. A NULL from_status against a tank that has already
--   moved on (e.g. on_board) is still rejected — no security hole is opened.
--
-- Carried forward VERBATIM from 20260519050700: search_path = public, the
-- step-2 terminal check, the step-4 transition table. ONLY step 3 changes.
--
-- Depends on: 20260519050700_tighten_oxygen_triggers_search_path.sql
-- Idempotent: CREATE OR REPLACE FUNCTION. Trigger not recreated (binds by name).

CREATE OR REPLACE FUNCTION enforce_oxygen_state_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $enforce_oxygen_state_machine$
DECLARE
  v_current_status oxygen_tank_status;
  v_serial         text;
  v_role           text;
BEGIN
  -- 1. Fetch the tank's current authoritative status and serial.
  SELECT status, serial
  INTO v_current_status, v_serial
  FROM oxygen_tanks
  WHERE id = NEW.tank_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'oxygen_tanks row not found for tank_id %', NEW.tank_id;
  END IF;

  v_role := app_user_role();  -- Phase 0 helper: returns 'Admin' or 'Employee'

  -- 2. Terminal state check: retired tanks block ALL further transitions.
  IF v_current_status = 'retired' THEN
    RAISE EXCEPTION 'ถังหมายเลข % ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้', v_serial;
  END IF;

  -- 3. Validate from_status matches the tank's current status.
  --    Initial placement records from_status = NULL. A freshly-created tank
  --    sits at the table-default status 'ready', so treat a NULL from_status
  --    as 'ready' for this comparison: the initial NULL→ready movement is
  --    accepted, while a NULL from_status against a tank that has already
  --    moved away from 'ready' is still rejected (HOTFIX 20260521040000).
  IF COALESCE(NEW.from_status, 'ready'::oxygen_tank_status)
       IS DISTINCT FROM v_current_status THEN
    RAISE EXCEPTION 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)',
      v_current_status::text, COALESCE(NEW.from_status::text, 'NULL');
  END IF;

  -- 4. State machine transition table.
  --    Decisions-locked derived #5. FE grep string for the blocked case:
  --    'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'
  IF NOT (
    -- Initial placement (NULL → ready, Admin only)
    (NEW.from_status IS NULL          AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- ready → on_board (Admin or Staff)
    (NEW.from_status = 'ready'        AND NEW.to_status = 'on_board') OR
    -- on_board → ready (Admin or Staff: ambulance returned, tank unused)
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'ready') OR
    -- on_board → refilling (Admin or Staff: tank emptied during run)
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'refilling') OR
    -- refilling → ready (Admin only: refill batch completed)
    (NEW.from_status = 'refilling'    AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → maintenance (Admin only: pulled for service)
    (NEW.to_status = 'maintenance'    AND v_role = 'Admin') OR
    -- maintenance → ready (Admin only: maintenance complete)
    (NEW.from_status = 'maintenance'  AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → retired (Admin only: terminal — no return from retired)
    (NEW.to_status = 'retired'        AND v_role = 'Admin')
  ) THEN
    -- FE grep target string (decisions-locked derived #5, verbatim):
    RAISE EXCEPTION 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง';
  END IF;

  RETURN NEW;
END;
$enforce_oxygen_state_machine$;

COMMENT ON FUNCTION enforce_oxygen_state_machine() IS
  'Phase 5. BEFORE INSERT on oxygen_movements. Validates state-machine transitions. '
  'FE grep string for blocked transitions: ''การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'' '
  '(decisions-locked derived #5, verbatim). '
  'SECURITY DEFINER — reads oxygen_tanks and app_user_role() past RLS. '
  'search_path = public (Phase 0.5.1 polish, 20260519050700). '
  'Step 3 treats a NULL from_status as ''ready'' so the initial placement '
  'movement (NULL→ready) is accepted (hotfix 20260521040000).';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Confirm the function still has search_path = public:
--    SELECT proname, proconfig::text FROM pg_proc
--    WHERE proname = 'enforce_oxygen_state_machine';
--    Expected: {search_path=public}
--
-- B) End-to-end smoke test — add a tank through the admin UI as an Admin user:
--    open the อ๊อกซิเจน tab → เพิ่มถัง → fill serial/size/location → บันทึก.
--    Expected: "เพิ่มถังแล้ว" toast, tank appears in the list, and the
--    movement log shows one "เริ่มต้น → พร้อมใช้" row.
