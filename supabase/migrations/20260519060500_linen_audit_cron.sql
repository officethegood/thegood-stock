-- supabase/migrations/20260519060500_linen_audit_cron.sql
-- Phase 6 — Linens & Laundry: daily audit cron + notification function.
--
-- Decisions-locked (docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md):
--   Q6-A — Daily 06:00 BKK = 23:00 UTC (UTC+7). pg_cron '0 23 * * *'.
--   Q6-C — Discrepancy threshold: max(ceil(qty * 5%), 2 pieces). Both configurable in settings.
--   Q6-K — LINEN_AUDIT_CRON_HOUR setting is documentation only; pg_cron must be manually
--           updated if schedule changes (no dynamic scheduling in pg_cron).
--
-- Trigger error string (FE greps): 'นับผ้าผิดมากกว่าเกณฑ์'
-- The error appears in tg-notify message body — NOT as a PL/pgSQL RAISE (cron runs silently).
-- FE grep key for toast: 'นับผ้าผิดมากกว่าเกณฑ์' matches the message prefix in the Telegram post.
--
-- Credentials read from settings table (Project.md §8 gotcha 9 — no hard-coded values).
-- Reads: NOTIFY_SUPABASE_URL, NOTIFY_SERVICE_ROLE_KEY, NOTIFY_TELEGRAM_CHAT_ID,
--        NOTIFY_TELEGRAM_ENABLED, LINEN_AUDIT_THRESHOLD_PCT (or LINEN_DISCREPANCY_PCT),
--        LINEN_AUDIT_MIN_PIECES (or LINEN_DISCREPANCY_MIN).
-- Settings seeded in: 20260519060500 (this file) via separate seed block below.
--
-- Requires: pg_cron extension (enabled in Phase 2 expiry cron).
--           If Phase 6 deploys before Phase 2: run CREATE EXTENSION IF NOT EXISTS pg_cron first.
--
-- Idempotent: CREATE OR REPLACE for function; cron.unschedule + cron.schedule pattern.
-- Depends on: v_linen_audit (20260519060300), settings (Phase 0), pg_net extension.

-- ==========================================================================
-- 1) Seed settings keys
--    Using LINEN_AUDIT_THRESHOLD_PCT / LINEN_AUDIT_MIN_PIECES as primary keys.
--    v_linen_audit also reads LINEN_DISCREPANCY_PCT / LINEN_DISCREPANCY_MIN as aliases.
--    Both sets seeded here so either naming convention works.
-- ==========================================================================

INSERT INTO settings(key, value) VALUES
  ('LINEN_AUDIT_THRESHOLD_PCT', '5'),   -- % discrepancy threshold (default 5%)
  ('LINEN_AUDIT_MIN_PIECES',    '2'),   -- minimum absolute piece tolerance (default 2)
  ('LINEN_DISCREPANCY_PCT',     '5'),   -- alias used by v_linen_audit COALESCE chain
  ('LINEN_DISCREPANCY_MIN',     '2'),   -- alias used by v_linen_audit COALESCE chain
  ('LINEN_AUDIT_CRON_HOUR',     '6')    -- documentation only — actual cron is UTC hard-coded below
ON CONFLICT (key) DO NOTHING;

-- ==========================================================================
-- 2) run_linen_audit() notification function
--    SECURITY DEFINER — runs with owner privileges to read settings + call pg_net.
--    Pass A: compute discrepancies via v_linen_audit (WHERE is_discrepancy=true)
--    Pass B: post tg-notify for each row; uses dedupe_key to suppress same-day repeats.
--
--    Trigger error string in message body (FE grep): 'นับผ้าผิดมากกว่าเกณฑ์'
-- ==========================================================================

CREATE OR REPLACE FUNCTION run_linen_audit()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url     text;
  v_srk     text;
  v_enabled text;
  v_rec     record;
  v_dedupe  text;
  v_msg     text;
  v_payload jsonb;
  v_sent    int := 0;
BEGIN
  -- Read config from settings (required — no hard-coded credentials per Project.md §8 gotcha 9)
  SELECT value INTO v_url  FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk  FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT value INTO v_enabled FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';

  IF v_url IS NULL OR v_srk IS NULL THEN
    RAISE WARNING 'linen_audit: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — ข้ามการแจ้งเตือน';
    RETURN;
  END IF;

  IF v_enabled IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'linen_audit: การแจ้งเตือน Telegram ถูกปิดอยู่ — ข้าม';
    RETURN;
  END IF;

  -- Pass A: iterate over discrepancies
  FOR v_rec IN
    SELECT *
    FROM v_linen_audit
    WHERE is_discrepancy = true
  LOOP
    -- Dedupe key: one alert per (location, item, day) in BKK time
    v_dedupe := 'linen_audit:' || v_rec.location_code || ':' || v_rec.sku
                || ':' || to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

    -- Pass B: message body — FE grep key: 'นับผ้าผิดมากกว่าเกณฑ์'
    v_msg := format(
      'นับผ้าผิดมากกว่าเกณฑ์: %s ที่ตู้ %s — นับได้ %s ผืน, ระบบบันทึก %s ผืน (ต่างกัน %s)',
      v_rec.item_name,
      v_rec.location_name,
      COALESCE(v_rec.counted_qty::text, '—'),
      v_rec.current_qty::text,
      v_rec.delta::text
    );

    v_payload := jsonb_build_object(
      'location_id',   v_rec.location_id,
      'location_code', v_rec.location_code,
      'item_id',       v_rec.item_id,
      'sku',           v_rec.sku,
      'current_qty',   v_rec.current_qty,
      'counted_qty',   v_rec.counted_qty,
      'delta',         v_rec.delta,
      'counted_at',    v_rec.counted_at,
      'counted_by',    v_rec.counted_by
    );

    PERFORM net.http_post(
      url     := v_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'content-type',  'application/json',
        'apikey',        v_srk,
        'authorization', 'Bearer ' || v_srk,
        'X-Internal',    'true'
      ),
      body    := jsonb_build_object(
        'event_type',  'linen_audit',
        'entity_type', 'linen_count',
        'entity_id',   v_rec.location_id::text || ':' || v_rec.item_id::text,
        'dedupe_key',  v_dedupe,
        'message',     v_msg,
        'payload',     v_payload
      )
    );

    v_sent := v_sent + 1;
  END LOOP;

  RAISE NOTICE 'linen_audit: ส่งการแจ้งเตือน % รายการ', v_sent;
END;
$$;

COMMENT ON FUNCTION run_linen_audit() IS
  'Phase 6: daily linen audit notification function. '
  'Reads v_linen_audit WHERE is_discrepancy=true; posts one tg-notify per row. '
  'Dedupe key: linen_audit:{location_code}:{sku}:{BKK-date}. '
  'Message body contains: นับผ้าผิดมากกว่าเกณฑ์ (FE grep key). '
  'SECURITY DEFINER — reads settings table + calls pg_net. '
  'Scheduled at 23:00 UTC (= 06:00 Asia/Bangkok) via pg_cron.';

-- ==========================================================================
-- 3) pg_cron schedule — 06:00 BKK = 23:00 UTC
--    NOTE: pg_cron uses UTC exclusively.
--    06:00 BKK (Asia/Bangkok, UTC+7) = 23:00 UTC previous calendar day.
--    LINEN_AUDIT_CRON_HOUR setting is for documentation only — changing it
--    requires a manual unschedule + reschedule; pg_cron has no dynamic scheduling.
-- ==========================================================================

-- Unschedule if already registered (idempotency)
SELECT cron.unschedule('linen_daily_audit')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'linen_daily_audit'
);

SELECT cron.schedule(
  'linen_daily_audit',
  '0 23 * * *',   -- 23:00 UTC = 06:00 Asia/Bangkok next day
  $$ SELECT run_linen_audit(); $$
);

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Settings seeded:
--    SELECT key, value FROM settings WHERE key LIKE 'LINEN_%' ORDER BY key;
--    Expected: 5 rows (LINEN_AUDIT_CRON_HOUR, LINEN_AUDIT_MIN_PIECES, LINEN_AUDIT_THRESHOLD_PCT,
--                       LINEN_DISCREPANCY_MIN, LINEN_DISCREPANCY_PCT)
--
-- 2) Function exists:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'run_linen_audit';
--    Expected: 1 row, prosecdef=true (SECURITY DEFINER)
--
-- 3) Cron job registered:
--    SELECT jobname, schedule, command
--    FROM cron.job WHERE jobname = 'linen_daily_audit';
--    Expected: 1 row with schedule '0 23 * * *'
--
-- 4) Manual test (after T162 discrepancy in place):
--    SELECT run_linen_audit();
--    Expected: NOTICE 'linen_audit: ส่งการแจ้งเตือน 1 รายการ' (or more)
--    Check: SELECT * FROM notification_log WHERE event_type='linen_audit' ORDER BY created_at DESC LIMIT 1;
