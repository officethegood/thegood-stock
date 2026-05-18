-- supabase/migrations/20260518010700_notify_settings.sql
-- Phase 1 — seed Phase 0 `settings` table with the two rows that check_low_stock()
-- needs in order to POST to tg-notify (NOTIFY_SUPABASE_URL + NOTIFY_SERVICE_ROLE_KEY).
--
-- DEPLOY NOTE: the original Phase 1 spec relied on `current_setting('app.*')` with
-- ALTER DATABASE to inject these. On Supabase Free/Nano the dashboard postgres role
-- lacks permission for that GUC namespace (ERROR 42501), so we store them in the
-- existing settings KV table instead. See 20260518010500_stock_triggers.sql for
-- the corresponding function change.
--
-- The actual values must be set by the deploy operator (or via the future
-- Admin → Settings UI). Insert empty placeholders here so the keys exist; the
-- trigger will WARN-and-skip if values are empty.

INSERT INTO settings(key, value) VALUES
  ('NOTIFY_SUPABASE_URL',      ''),
  ('NOTIFY_SERVICE_ROLE_KEY',  '')
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN settings.key IS 'Phase 0+1 KV. Phase 1 added NOTIFY_SUPABASE_URL and NOTIFY_SERVICE_ROLE_KEY for the low-stock trigger pg_net call.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Both keys present (values may be blank in fresh deploy):
--    SELECT key, length(value) AS len FROM settings
--    WHERE key IN ('NOTIFY_SUPABASE_URL','NOTIFY_SERVICE_ROLE_KEY')
--    ORDER BY key;
--    -- expected: 2 rows
--
-- 2) Trigger picks up the values (after operator fills them in):
--    SELECT value INTO STRICT @url FROM settings WHERE key='NOTIFY_SUPABASE_URL';
--    -- expected: equals SUPABASE_URL from shared/config.js
