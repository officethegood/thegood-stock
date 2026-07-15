-- supabase/migrations/20260715021000_lock_oxygen_state_transition.sql
-- Fix — enforce_oxygen_state_machine() reads the oxygen_tanks row WITHOUT a row
-- lock, so two concurrent transitions from the same state can both pass the
-- from_status == current_status check and both insert a movement.
--
-- Bug:
--   enforce_oxygen_state_machine() (latest body: 20260529010100_oxygen_awaiting_
--   refill_logic.sql — confirmed the last file to CREATE OR REPLACE this function;
--   the 3 earlier definitions are 20260519050500 / 20260519050700 / 20260521040000)
--   does:
--     SELECT status, serial INTO v_current_status, v_serial
--     FROM oxygen_tanks WHERE id = NEW.tank_id;   -- no FOR UPDATE
--   Two transactions (e.g. both "ready → on_board" for the same tank) each read
--   status='ready', each pass NEW.from_status IS DISTINCT FROM v_current_status,
--   and each INSERT an oxygen_movements row — a duplicated history row and a
--   double transition.
--
-- Fix:
--   CREATE OR REPLACE the function copying the 20260529010100 body VERBATIM,
--   changing ONLY that SELECT to add FOR UPDATE so the tank row is locked for
--   the remainder of the transaction. The second concurrent transaction now
--   blocks until the first commits, then re-reads the *new* current status; its
--   NEW.from_status no longer matches, so it raises the existing state-mismatch
--   Thai error instead of writing a duplicate row.
--   The transition matrix, awaiting_refill logic, role checks, and every Thai
--   string are byte-identical to 20260529010100.
--
-- LESSON APPLIED (see 20260712010000): verbatim copy of the latest body, ONLY
--   the documented delta changed.
--
-- Depends on: 20260529010100_oxygen_awaiting_refill_logic.sql
-- Idempotent: CREATE OR REPLACE FUNCTION. Trigger binds by name (not recreated).

CREATE OR REPLACE FUNCTION enforce_oxygen_state_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $enforce_oxygen_state_machine$
DECLARE
  v_current_status oxygen_tank_status;
  v_serial         text;
  v_role           text;
BEGIN
  SELECT status, serial
  INTO v_current_status, v_serial
  FROM oxygen_tanks
  WHERE id = NEW.tank_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'oxygen_tanks row not found for tank_id %', NEW.tank_id;
  END IF;

  v_role := app_user_role();  -- Phase 0 helper: 'Admin' or 'Employee'

  IF v_current_status = 'retired' THEN
    RAISE EXCEPTION 'ถังหมายเลข % ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้', v_serial;
  END IF;

  IF NEW.from_status IS DISTINCT FROM v_current_status THEN
    RAISE EXCEPTION 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)',
      v_current_status::text, COALESCE(NEW.from_status::text, 'NULL');
  END IF;

  IF NOT (
    -- Initial placement (NULL → ready, Admin only)
    (NEW.from_status IS NULL          AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- ready → on_board (Admin or Staff): ขึ้นรถ
    (NEW.from_status = 'ready'        AND NEW.to_status = 'on_board') OR
    -- on_board → ready (Admin or Staff): คืนถัง — ambulance returned, tank unused
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'ready') OR
    -- on_board → awaiting_refill (Admin or Staff): ลงรอเติม — off truck, staged at base
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'awaiting_refill') OR
    -- on_board → refilling (Admin or Staff): ส่งเติม — sent straight from truck
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'refilling') OR
    -- awaiting_refill → refilling (Admin or Staff): ส่งร้าน — batch sent to vendor
    (NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'refilling') OR
    -- awaiting_refill → ready (Admin only): ยกเลิกรอเติม — tank still has gas, correction
    (NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- refilling → ready (Admin only): เติมเสร็จ
    (NEW.from_status = 'refilling'    AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → maintenance (Admin only)
    (NEW.to_status = 'maintenance'    AND v_role = 'Admin') OR
    -- maintenance → ready (Admin only)
    (NEW.from_status = 'maintenance'  AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → retired (Admin only, terminal)
    (NEW.to_status = 'retired'        AND v_role = 'Admin')
  ) THEN
    -- FE grep target string (decisions-locked derived #5, verbatim):
    RAISE EXCEPTION 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง';
  END IF;

  RETURN NEW;
END;
$enforce_oxygen_state_machine$;

COMMENT ON FUNCTION enforce_oxygen_state_machine() IS
  'BEFORE INSERT on oxygen_movements. Validates from_status == current tank '
  'status and the allowed transition matrix (roles enforced per transition). '
  '20260715021000: reads oxygen_tanks FOR UPDATE so two concurrent transitions '
  'from the same state serialize — the loser re-reads the new status and hits '
  'the existing state-mismatch error instead of writing a duplicate history row.';

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- A) Function present & SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'enforce_oxygen_state_machine';
--    Expected: 1 row, prosecdef = true
--
-- B) Concurrency note (behavioural — no schema check):
--    With FOR UPDATE, if two sessions both attempt the same transition for one
--    tank (e.g. ready → on_board), the second session BLOCKS on the row lock
--    until the first commits, then re-reads current status and raises the
--    existing Thai error 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)'
--    instead of inserting a second oxygen_movements row. Only ONE movement is
--    recorded per real transition. (Reproduce with two psql sessions: BEGIN in
--    both, INSERT the same movement — the 2nd waits, then errors on COMMIT of
--    the 1st.)
--
-- C) Single-session happy path is unchanged (rolled back):
--    BEGIN;
--      WITH t AS (SELECT id, status FROM oxygen_tanks WHERE status='ready' LIMIT 1)
--      INSERT INTO oxygen_movements(tank_id, from_status, to_status, performed_by)
--      SELECT id, 'ready', 'on_board', 'audit' FROM t;
--      -- Expected: 1 row inserted, no error.
--    ROLLBACK;
