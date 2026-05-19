-- supabase/migrations/20260519060400_linen_counts_rls.sql
-- Phase 6 — Linens & Laundry: RLS policies for linen_counts.
--
-- Decisions-locked (docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md):
--   Role matrix:
--     SELECT — all authenticated users
--     INSERT — Admin or Employee (own username only; counted_by = app_username())
--     UPDATE — none (linen_counts is immutable; corrections = new row)
--     DELETE — none (immutable; Admin can add note in Phase 6.1 if needed)
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE POLICY.
-- Depends on: linen_counts table (20260519060300),
--             app_user_role() + app_username() functions (Phase 0).

ALTER TABLE linen_counts ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- 1) SELECT: all authenticated users can read all linen_counts rows
-- ==========================================================================

DROP POLICY IF EXISTS lc_read ON linen_counts;
CREATE POLICY lc_read ON linen_counts
  FOR SELECT
  TO authenticated
  USING (true);

-- ==========================================================================
-- 2) INSERT: Admin or Employee (Staff) may insert.
--    counted_by must equal own JWT username — no proxy-counting in Phase 6.
-- ==========================================================================

DROP POLICY IF EXISTS lc_insert ON linen_counts;
CREATE POLICY lc_insert ON linen_counts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    app_user_role() IN ('Admin', 'Employee')
    AND counted_by = app_username()
  );

-- No UPDATE policy (immutable)
-- No DELETE policy (immutable)

COMMENT ON POLICY lc_read ON linen_counts IS
  'Phase 6: all authenticated users may read all linen count rows.';

COMMENT ON POLICY lc_insert ON linen_counts IS
  'Phase 6: Admin and Employee may INSERT linen counts. '
  'counted_by must equal own JWT username — prevents proxy-counting.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- SELECT policyname, cmd, with_check
-- FROM pg_policies
-- WHERE tablename = 'linen_counts'
-- ORDER BY policyname;
-- Expected: 2 rows — lc_read (SELECT) + lc_insert (INSERT)
--
-- Functional test (run as Employee JWT):
-- const { error } = await supabase.from('linen_counts').insert({
--   location_id: '<cabinet-uuid>',
--   item_id:     '<linen-item-uuid>',
--   counted_qty: 5
-- });
-- Expected: 201 (not 403) — policy allows Employee INSERT
--
-- Tamper test (run as Employee JWT, set counted_by to another user):
-- const { error } = await supabase.from('linen_counts').insert({
--   location_id: '<cabinet-uuid>',
--   item_id:     '<linen-item-uuid>',
--   counted_qty: 5,
--   counted_by:  'other_user'
-- });
-- Expected: 403 — counted_by != app_username()
