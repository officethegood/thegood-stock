-- supabase/migrations/20260601020000_fix_oxygen_rls_awaiting_refill.sql
-- CRITICAL regression fix — staff (Employee) cannot do "ลงรอเติม".
--
-- The awaiting_refill feature (20260529010100) made on_board → awaiting_refill a
-- STAFF-allowed transition in the state-machine trigger and the FE, but the
-- oxygen_movements INSERT RLS policy (20260519050400) still only let Employees
-- insert to_status IN ('ready','on_board','refilling'). RLS is checked BEFORE
-- the state-machine trigger, so a staff "ลงรอเติม" (to_status='awaiting_refill')
-- was rejected with: new row violates row-level security policy for table
-- "oxygen_movements". Admin was unaffected (app_user_role()='Admin' branch).
--
-- Fix: add 'awaiting_refill' to the Employee-allowed to_status set so RLS matches
-- the state machine (which already permits on_board->awaiting_refill and
-- awaiting_refill->refilling for staff). awaiting_refill->ready stays Admin-only
-- and is still enforced by the state-machine trigger (RLS is a coarse first
-- pass). Idempotent: DROP POLICY IF EXISTS + CREATE.

DROP POLICY IF EXISTS oxygen_movements_insert_staff ON oxygen_movements;
CREATE POLICY oxygen_movements_insert_staff
  ON oxygen_movements FOR INSERT
  TO authenticated
  WITH CHECK (
    app_user_role() = 'Admin'
    OR (
      app_user_role() = 'Employee'
      AND to_status IN ('ready', 'on_board', 'awaiting_refill', 'refilling')
    )
  );

-- Verify:
-- SELECT polname, pg_get_expr(polwithcheck, polrelid) AS with_check
-- FROM pg_policy WHERE polname = 'oxygen_movements_insert_staff';
-- Expected: with_check lists 'awaiting_refill'.
