-- supabase/migrations/20260519030600_overdue_settings.sql
-- Phase 3 — Seed OVERDUE_GROUP_THRESHOLD setting.
--
-- Decisions-locked:
--   Q-Phase3-F  — OVERDUE_GROUP_THRESHOLD = 10 (default; configurable via Settings tab)
--
-- When the count of overdue loans > OVERDUE_GROUP_THRESHOLD, run_overdue_alert()
-- sends a single grouped Telegram message instead of per-loan messages.
--
-- Idempotent: ON CONFLICT (key) DO NOTHING.

INSERT INTO settings (key, value, is_secret)
VALUES ('OVERDUE_GROUP_THRESHOLD', '10', false)
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN settings.key IS
  'Phase 0+1+2+3 KV. Phase 3 added OVERDUE_GROUP_THRESHOLD (default 10).';

-- ============================================================
-- Verification SQL
-- ============================================================
-- SELECT key, value, is_secret FROM settings WHERE key = 'OVERDUE_GROUP_THRESHOLD';
-- Expected: 1 row — key=OVERDUE_GROUP_THRESHOLD, value=10, is_secret=false
--
-- Idempotency: run twice → ON CONFLICT DO NOTHING → no error; value unchanged.
