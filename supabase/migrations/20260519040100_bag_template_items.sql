-- supabase/migrations/20260519040100_bag_template_items.sql
-- Phase 4 — RLS for bag_templates + bag_template_items.
--
-- Spec refs:
--   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §5.6, §8
--
-- Role matrix (per spec §8 table):
--   bag_templates      — SELECT: authenticated (all roles);  ALL (INSERT/UPDATE/DELETE): Admin only
--   bag_template_items — SELECT: authenticated (all roles);  ALL (INSERT/UPDATE/DELETE): Admin only
--
-- Reuses app_user_role() helper (Phase 0 convention — same as all other tables).
-- Policies are idempotent: DROP IF EXISTS before CREATE.
--
-- Idempotent: DO blocks check existence before CREATE POLICY.

-- ==========================================================================
-- SECTION 1: Enable RLS
-- ==========================================================================

ALTER TABLE bag_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bag_template_items ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- SECTION 2: bag_templates policies
-- ==========================================================================

DO $bag_tpl_pol$
BEGIN
  -- Read: all authenticated roles (Admin + Employee)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='bag_templates' AND policyname='bt_read'
  ) THEN
    CREATE POLICY bt_read ON bag_templates
      FOR SELECT TO authenticated USING (true);
  END IF;

  -- Write: Admin only (INSERT, UPDATE, DELETE)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='bag_templates' AND policyname='bt_write'
  ) THEN
    CREATE POLICY bt_write ON bag_templates
      FOR ALL TO authenticated
      USING     (app_user_role() = 'Admin')
      WITH CHECK (app_user_role() = 'Admin');
  END IF;
END
$bag_tpl_pol$;

-- ==========================================================================
-- SECTION 3: bag_template_items policies
-- ==========================================================================

DO $bag_tpl_items_pol$
BEGIN
  -- Read: all authenticated roles
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='bag_template_items' AND policyname='bti_read'
  ) THEN
    CREATE POLICY bti_read ON bag_template_items
      FOR SELECT TO authenticated USING (true);
  END IF;

  -- Write: Admin only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='bag_template_items' AND policyname='bti_write'
  ) THEN
    CREATE POLICY bti_write ON bag_template_items
      FOR ALL TO authenticated
      USING     (app_user_role() = 'Admin')
      WITH CHECK (app_user_role() = 'Admin');
  END IF;
END
$bag_tpl_items_pol$;

-- ==========================================================================
-- Verification SQL
-- ==========================================================================
-- 1) RLS enabled on both tables:
--    SELECT tablename, relrowsecurity::text
--    FROM pg_tables pt JOIN pg_class pc ON pc.relname=pt.tablename
--    WHERE schemaname='public'
--      AND tablename IN ('bag_templates','bag_template_items');
--    -- Expected: both rows show relrowsecurity='t'
--
-- 2) Policies exist (4 total):
--    SELECT policyname, cmd, roles FROM pg_policies
--    WHERE tablename IN ('bag_templates','bag_template_items')
--    ORDER BY tablename, policyname;
--    -- Expected: bt_read, bt_write, bti_read, bti_write
--
-- 3) Staff cannot INSERT bag_templates (test in SQL Editor as Employee JWT):
--    INSERT INTO bag_templates(code, name, created_by)
--    VALUES ('TPL-TEST','test','tester');
--    -- Expected: 403 / new row violates RLS
