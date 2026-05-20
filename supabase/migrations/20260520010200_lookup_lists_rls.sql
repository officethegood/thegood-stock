-- supabase/migrations/20260520010200_lookup_lists_rls.sql
-- Phase 0.7 D14 — RLS policies and realtime publication for lookup_lists.
--
-- Policy matrix (mirrors stock_categories pattern in 20260518010400_stock_rls.sql):
--   SELECT:                  all authenticated users
--   INSERT / UPDATE / DELETE: Admin only (app_user_role() = 'Admin')
--
-- Realtime: lookup_lists added to supabase_realtime publication so the FE
-- taxonomy dropdowns update live when an admin adds/edits a value.
--
-- Assumptions:
--   app_user_role() helper — created in 20260518000000_init.sql.
--   supabase_realtime publication exists (created by Supabase platform).
--   Idempotent: DROP POLICY IF EXISTS before each CREATE POLICY.
--               DO block guards ALTER PUBLICATION against duplicate membership.

-- ==========================================================================
-- 1. ENABLE RLS
-- ==========================================================================

ALTER TABLE lookup_lists ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- 2. POLICIES
-- ==========================================================================

DROP POLICY IF EXISTS ll_read  ON lookup_lists;
DROP POLICY IF EXISTS ll_write ON lookup_lists;

-- All authenticated users can read taxonomy values (needed to populate dropdowns).
CREATE POLICY ll_read ON lookup_lists
  FOR SELECT TO authenticated USING (true);

-- Only Admin can create/modify/remove taxonomy values.
CREATE POLICY ll_write ON lookup_lists
  FOR ALL TO authenticated
  USING      (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- ==========================================================================
-- 3. REALTIME PUBLICATION
-- ==========================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname    = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'lookup_lists'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lookup_lists';
  END IF;
END $$;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
--
-- A) RLS is enabled:
--    SELECT relname, relrowsecurity
--    FROM pg_class WHERE relname = 'lookup_lists';
--    Expected: relrowsecurity = true
--
-- B) Policies present:
--    SELECT policyname, cmd, roles
--    FROM pg_policies WHERE tablename = 'lookup_lists'
--    ORDER BY policyname;
--    Expected:
--      ll_read  | SELECT | {authenticated}
--      ll_write | ALL    | {authenticated}
--
-- C) In realtime publication:
--    SELECT tablename FROM pg_publication_tables
--    WHERE pubname = 'supabase_realtime' AND tablename = 'lookup_lists';
--    Expected: 1 row
--
-- D) Staff JWT can SELECT but cannot INSERT:
--    (Test with a Staff token via Dashboard API or curl)
--    GET /rest/v1/lookup_lists?kind=eq.tank_size  → 200
--    POST /rest/v1/lookup_lists { kind:'tank_size', code:'xl', name:'ใหญ่พิเศษ' } → 403
--
-- E) Admin JWT can INSERT (idempotent seed already exists; use a new code):
--    POST /rest/v1/lookup_lists
--      { "kind":"tank_size","code":"xl","name":"ใหญ่พิเศษ","sort_order":4 } → 201
--    Then DELETE it to leave the table clean.
