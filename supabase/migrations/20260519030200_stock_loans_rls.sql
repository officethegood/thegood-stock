-- supabase/migrations/20260519030200_stock_loans_rls.sql
-- Phase 3 — RLS policies for stock_loans + immutability guards.
--
-- Policy matrix (spec §8.3):
--   SELECT  — all authenticated (Admin + Employee read all loans)
--   INSERT  — blocked to clients; trigger runs as postgres (bypasses RLS); no direct client INSERT
--   UPDATE  — Employee: own loans' photo fields only
--             Admin: all columns on any loan
--   DELETE  — blocked (immutable audit trail; trigger raises exception)
--
-- Additional:
--   trg_no_delete_loans      — prevents DELETE on stock_loans (even from Admin)
--   trg_loan_immutable       — prevents changing critical columns after creation
--
-- Depends on:
--   stock_loans table (20260519030100)
--   app_user_role() + app_username() (Phase 0)

ALTER TABLE stock_loans ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- SELECT — all authenticated users (Admin + Employee)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sl3_read ON stock_loans;
CREATE POLICY sl3_read ON stock_loans
  FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- INSERT — no direct client INSERT; trigger creates rows (runs as postgres role)
-- Note: no INSERT policy = all direct client INSERTs rejected by default deny.
-- The trigger (create_loan_from_borrow) runs SECURITY DEFINER under postgres and
-- bypasses RLS, so it can INSERT without a policy.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- UPDATE — Employee: own loans' photo fields only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sl3_update_photo_own ON stock_loans;
CREATE POLICY sl3_update_photo_own ON stock_loans
  FOR UPDATE
  TO authenticated
  USING (
    borrower_username = app_username()
    AND app_user_role() = 'Employee'
  )
  WITH CHECK (
    borrower_username = app_username()
    AND app_user_role() = 'Employee'
  );

-- ---------------------------------------------------------------------------
-- UPDATE — Admin: any loan, any column (for admin-recorded returns + corrections)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sl3_update_admin ON stock_loans;
CREATE POLICY sl3_update_admin ON stock_loans
  FOR UPDATE
  TO authenticated
  USING     (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- No DELETE policy → all DELETEs rejected by default RLS deny rule.
-- Belt-and-braces: trigger below also raises EXCEPTION on DELETE.

-- ---------------------------------------------------------------------------
-- Delete guard trigger (belt-and-braces; even Admin cannot delete loans)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_loan_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $prevent_loan_delete$
BEGIN
  RAISE EXCEPTION 'stock_loans rows are immutable — close loans via return movement, not DELETE';
END;
$prevent_loan_delete$;

COMMENT ON FUNCTION prevent_loan_delete() IS
  'Phase 3 — prevents DELETE on stock_loans. Loans are permanent audit records. '
  'To close a loan, insert a stock_movements row with movement_type=''return''.';

DROP TRIGGER IF EXISTS trg_no_delete_loans ON stock_loans;
CREATE TRIGGER trg_no_delete_loans
  BEFORE DELETE ON stock_loans
  FOR EACH ROW EXECUTE FUNCTION prevent_loan_delete();

-- ---------------------------------------------------------------------------
-- Immutability guard — prevent altering identity columns after creation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_loan_immutable_cols()
RETURNS trigger
LANGUAGE plpgsql
AS $guard_loan_immutable_cols$
BEGIN
  IF OLD.movement_id_borrow   IS DISTINCT FROM NEW.movement_id_borrow
     OR OLD.item_id            IS DISTINCT FROM NEW.item_id
     OR OLD.location_id_from   IS DISTINCT FROM NEW.location_id_from
     OR OLD.borrower_username  IS DISTINCT FROM NEW.borrower_username
     OR OLD.borrowed_at        IS DISTINCT FROM NEW.borrowed_at
     OR OLD.qty                IS DISTINCT FROM NEW.qty
  THEN
    RAISE EXCEPTION
      'stock_loans: movement_id_borrow, item_id, location_id_from, '
      'borrower_username, borrowed_at, qty are immutable after loan creation';
  END IF;
  RETURN NEW;
END;
$guard_loan_immutable_cols$;

COMMENT ON FUNCTION guard_loan_immutable_cols() IS
  'Phase 3 — prevents mutation of identity columns on stock_loans after INSERT. '
  'Only photo_borrow_url, photo_return_url, status, returned_at, updated_by, notes '
  'may change after creation. Mirrors S-11 pattern from Phase 2 security audit.';

DROP TRIGGER IF EXISTS trg_loan_immutable ON stock_loans;
CREATE TRIGGER trg_loan_immutable
  BEFORE UPDATE ON stock_loans
  FOR EACH ROW EXECUTE FUNCTION guard_loan_immutable_cols();

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) RLS enabled:
--    SELECT relrowsecurity FROM pg_class WHERE relname = 'stock_loans';
--    -- Expected: t (true)
--
-- 2) Policies present:
--    SELECT policyname, cmd, roles::text
--    FROM pg_policies
--    WHERE tablename = 'stock_loans'
--    ORDER BY policyname;
--    -- Expected: sl3_read (SELECT), sl3_update_admin (UPDATE), sl3_update_photo_own (UPDATE)
--
-- 3) No INSERT or DELETE policy:
--    SELECT policyname FROM pg_policies
--    WHERE tablename = 'stock_loans' AND cmd IN ('INSERT','DELETE');
--    -- Expected: 0 rows
--
-- 4) Delete guard active:
--    SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'stock_loans'::regclass AND tgname = 'trg_no_delete_loans';
--    -- Expected: 1 row, tgenabled = 'O'
--
-- 5) Immutability guard active:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'stock_loans'::regclass AND tgname = 'trg_loan_immutable';
--    -- Expected: 1 row
--
-- 6) Idempotency: run twice → no error (DROP POLICY IF EXISTS + CREATE OR REPLACE + DROP TRIGGER IF EXISTS)
