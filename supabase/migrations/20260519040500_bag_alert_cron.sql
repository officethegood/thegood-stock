-- supabase/migrations/20260519040500_bag_alert_cron.sql
-- Phase 4 — run_bag_status_alert() function + pg_cron schedule.
--
-- Spec refs:
--   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §5.4
--   docs/superpowers/specs/2026-05-19-phase4-decisions-locked.md Q-Phase4-C (nearest expiry per bag)
--
-- Decisions enforced here:
--   Q-Phase4-C  — Telegram alert = nearest expiry per bag, ONE LINE PER BAG (not per lot).
--   Project.md §8 gotcha 9 — MUST read NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY
--                             from settings table. NEVER use current_setting().
--
-- Alert schedule: 02:00 UTC = 09:00 Asia/Bangkok (matches Phase 2 expiry_alert pattern).
--
-- Dedupe key pattern: 'bag_alert:YYYY-MM-DD' (one alert per calendar day Bangkok time).
--
-- SECURITY DEFINER: required — pg_cron runs jobs under supabase_admin, which lacks
--   access to settings table and net.http_post without elevated privilege.
--
-- Idempotent:
--   CREATE OR REPLACE FUNCTION — always safe.
--   DO block unschedules existing job before scheduling.

-- ==========================================================================
-- SECTION 1: run_bag_status_alert() function
-- ==========================================================================

CREATE OR REPLACE FUNCTION run_bag_status_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $run_bag_status_alert$
DECLARE
  v_url       text;
  v_srk       text;
  v_enabled   text;
  v_msg       text;
  v_dedupe    text;
  v_bags      jsonb;
  v_today     date := CURRENT_DATE;
BEGIN
  -- ─────────────────────────────────────────────────────────────────────────
  -- Read notify credentials from settings table.
  -- MUST use settings table — NOT current_setting('app.*').
  -- Project.md §8 gotcha 9: ALTER DATABASE for app.* blocked on Free/Nano.
  -- ─────────────────────────────────────────────────────────────────────────
  SELECT value INTO v_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk     FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT value INTO v_enabled FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';

  -- Guard: skip pg_net calls if notify credentials not configured.
  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING
      'run_bag_status_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in '
      'settings table. Telegram alert skipped.';
    RETURN;
  END IF;

  -- Guard: skip if Telegram explicitly disabled.
  IF v_enabled IS NOT NULL AND v_enabled = 'false' THEN
    RETURN;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────────
  -- Collect bags with issues (Q-Phase4-C: one object per bag, nearest expiry).
  -- Ordered by severity: expired first, then expiring, then low_stock.
  -- ─────────────────────────────────────────────────────────────────────────
  SELECT jsonb_agg(
    jsonb_build_object(
      'bag_code',       vbs.bag_code,
      'bag_name',       vbs.bag_name,
      'alert_level',    vbs.alert_level,
      'completion_pct', vbs.completion_pct,
      'deficit_count',  vbs.mandatory_deficit_count,
      'nearest_expiry', vbs.nearest_expiry,
      'expired_lots',   vbs.expired_lots_count,
      'expiring_30d',   vbs.expiring_30d_count
    )
    ORDER BY
      CASE vbs.alert_level
        WHEN 'expired'   THEN 1
        WHEN 'expiring'  THEN 2
        WHEN 'low_stock' THEN 3
        ELSE                  4
      END,
      vbs.bag_code
  )
  INTO v_bags
  FROM v_bag_status vbs
  WHERE vbs.alert_level IN ('low_stock', 'expiring', 'expired')
    AND vbs.bag_active  = true;

  -- Skip if no issues.
  IF v_bags IS NULL OR jsonb_array_length(v_bags) = 0 THEN
    RETURN;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────────
  -- Build Thai-language summary message.
  -- One message per day (dedupe key = 'bag_alert:YYYY-MM-DD').
  -- Q-Phase4-C: the bags array payload contains one entry per bag (not per lot).
  -- ─────────────────────────────────────────────────────────────────────────
  v_msg := format(
    E'\U0001FA7A สถานะถุงยา / ชุดปฐมพยาบาล — %s — มี %s ถุงที่ต้องตรวจสอบ',
    to_char(v_today AT TIME ZONE 'Asia/Bangkok', 'DD Mon YYYY'),
    jsonb_array_length(v_bags)
  );

  v_dedupe := 'bag_alert:' || to_char(v_today, 'YYYY-MM-DD');

  -- ─────────────────────────────────────────────────────────────────────────
  -- Post to tg-notify via pg_net (same transport as Phase 1 + Phase 2 crons).
  -- ─────────────────────────────────────────────────────────────────────────
  PERFORM net.http_post(
    url     := v_url || '/functions/v1/tg-notify',
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'apikey',        v_srk,
      'authorization', 'Bearer ' || v_srk,
      'X-Internal',    'true'
    ),
    body    := jsonb_build_object(
      'event_type',  'bag_alert',
      'entity_type', 'bag_location',
      'entity_id',   null,
      'dedupe_key',  v_dedupe,
      'message',     v_msg,
      'payload',     jsonb_build_object(
        'run_date', v_today,
        'bags',     v_bags
      )
    )
  );
END;
$run_bag_status_alert$;

COMMENT ON FUNCTION run_bag_status_alert() IS
  'Phase 4 daily cron (02:00 UTC = 09:00 Asia/Bangkok). '
  'Queries v_bag_status for bags with alert_level IN (low_stock, expiring, expired) '
  'and posts ONE grouped Telegram message (one entry per bag — Q-Phase4-C). '
  'Reads NOTIFY_SUPABASE_URL/NOTIFY_SERVICE_ROLE_KEY from settings table '
  '(NOT current_setting — Project.md §8 gotcha 9). '
  'Dedupe key: bag_alert:YYYY-MM-DD (one alert per calendar day).';

-- ==========================================================================
-- SECTION 2: pg_cron schedule (idempotent)
-- Pre-condition: pg_cron must be enabled (Phase 2 enables it in 20260519010800).
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron_bag_alert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'bag_status_alert'
  ) THEN
    PERFORM cron.unschedule('bag_status_alert');
  END IF;
END
$cron_bag_alert$;

SELECT cron.schedule(
  'bag_status_alert',
  '0 2 * * *',
  $cron_cmd$SELECT run_bag_status_alert()$cron_cmd$
);

-- ==========================================================================
-- Verification SQL
-- ==========================================================================
-- 1) Function present and SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='run_bag_status_alert';
--    -- Expected: 1 row, prosecdef=true
--
-- 2) pg_cron job scheduled:
--    SELECT jobname, schedule, command FROM cron.job WHERE jobname='bag_status_alert';
--    -- Expected: 1 row, schedule='0 2 * * *'
--
-- 3) Smoke run (manual — safe if NOTIFY settings are blank):
--    SELECT run_bag_status_alert();
--    -- Expected: no exception.
--    -- If NOTIFY settings blank: WARNING logged, returns immediately.
--    -- If bags with issues exist AND settings configured: notification_log row inserted.
--
-- 4) Dedupe check:
--    SELECT run_bag_status_alert(); SELECT run_bag_status_alert();
--    -- Expected: second call returns dedupe_hit=true from tg-notify; only 1 Telegram sent.
--
-- 5) No-issues skip:
--    -- When all bags are 'complete': function returns before pg_net call.
--    -- No notification_log row inserted.
