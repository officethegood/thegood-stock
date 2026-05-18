-- supabase/migrations/20260519005000_hotfix_settings_secret_rls.sql
-- HOTFIX: settings table SELECT policy leaked NOTIFY_SERVICE_ROLE_KEY to Employee role.
--
-- Background: Phase 1 deployment deviation (Project.md §8 gotcha 9) parked the
-- service_role key in `settings(NOTIFY_SERVICE_ROLE_KEY)` because Supabase Free/Nano
-- rejects `ALTER DATABASE postgres SET app.*` (ERROR 42501). The original Phase 0
-- RLS policy on `settings` was:
--     CREATE POLICY set_read ON settings FOR SELECT TO authenticated USING (true);
-- which gave every authenticated user (including Employee) the ability to
-- `GET /rest/v1/settings` and retrieve the service_role key — a full RLS bypass.
--
-- Discovered by: security-engineer audit 2026-05-19 (finding S-1 HIGH).
-- Applied to live DB: 2026-05-19 via Mgmt API before Phase 2 migrations.
-- This file is the source-of-truth so a fresh deploy reproduces the secure state.
--
-- Filename timestamp 20260519005000 is BEFORE the Phase 2 010000+ series so it
-- ordered in cleanly between Phase 1 (20260518...) and Phase 2 (20260519010000...).

-- ---------------------------------------------------------------------------
-- 1) Add is_secret flag to settings rows
-- ---------------------------------------------------------------------------
ALTER TABLE settings ADD COLUMN IF NOT EXISTS is_secret boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN settings.is_secret IS
  'Hotfix S-1 (2026-05-19): when true, SELECT is Admin-only. Set for secrets like NOTIFY_SERVICE_ROLE_KEY.';

-- ---------------------------------------------------------------------------
-- 2) Mark known secret keys
-- ---------------------------------------------------------------------------
UPDATE settings SET is_secret = true
WHERE key IN ('NOTIFY_SERVICE_ROLE_KEY');
-- Phase 2 may add more secret keys; gate them by adding `is_secret=true` in the
-- INSERT or via UPDATE. Future contributors: see §8 gotcha 9 in Project.md.

-- ---------------------------------------------------------------------------
-- 3) Replace the over-permissive SELECT policy
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS set_read ON settings;

CREATE POLICY set_read ON settings
  FOR SELECT TO authenticated
  USING (is_secret = false OR app_user_role() = 'Admin');

-- Write policy (set_write) is unchanged — Admin only. Verified pre-hotfix and
-- not re-declared here because Phase 0 already locks it.

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Column exists with default false:
--    SELECT column_name, data_type, column_default, is_nullable
--    FROM information_schema.columns
--    WHERE table_name='settings' AND column_name='is_secret';
--
-- 2) Service role key now flagged secret (and only that key by default):
--    SELECT key, is_secret FROM settings WHERE is_secret = true;
--    -- expected: 1 row, NOTIFY_SERVICE_ROLE_KEY
--
-- 3) Policy uses the new clause:
--    SELECT policyname, cmd, qual FROM pg_policies WHERE tablename='settings'
--    ORDER BY policyname;
--    -- expected set_read qual to include 'is_secret' and "app_user_role() = 'Admin'"
--
-- 4) Smoke (with an Employee JWT, see Phase 1 test T31 pattern):
--    GET /rest/v1/settings?select=key,is_secret
--    -- expected: 200 with rows where is_secret=false; NO rows where is_secret=true
