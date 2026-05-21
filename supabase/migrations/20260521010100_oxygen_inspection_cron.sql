-- supabase/migrations/20260521010100_oxygen_inspection_cron.sql
-- Phase 5.1 — Daily Telegram alert for oxygen tanks due for hydrostatic test.
--
-- Behaviour: one alert per tank, fired once when the tank's next_inspection_due
-- enters the window (today + OXYGEN_INSPECTION_ALERT_DAYS) OR is already
-- overdue. The dedupe key includes the due date, so re-scheduling the
-- inspection (Admin edits the date) produces a fresh alert next cycle.
--
-- Reuses the Phase 0 tg-notify Edge Function. Reads NOTIFY_* and the new
-- OXYGEN_INSPECTION_ALERT_DAYS from the settings table (NOT current_setting —
-- Project.md gotcha: ALTER DATABASE app.* is blocked on Supabase Free/Nano).
--
-- Dependency note: tg-notify writes a notification_log row keyed by the
-- payload dedupe_key on success — the same mechanism check_oxygen_refill_batch()
-- relies on. Task 8 verifies a notification_log row appears after a test run.
--
-- Depends on:
--   20260519050200_oxygen_tanks.sql, settings (Phase 0), notification_log,
--   pg_net + pg_cron extensions, tg-notify Edge Function (Phase 0).
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING; CREATE OR REPLACE FUNCTION;
--             cron.unschedule guard + cron.schedule.

-- ── 1. Seed the configurable alert window (default 30 days) ─────────────────
INSERT INTO settings (key, value)
VALUES ('OXYGEN_INSPECTION_ALERT_DAYS', '30')
ON CONFLICT (key) DO NOTHING;

-- ── 2. The alert function ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_oxygen_inspection_due()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $check_oxygen_inspection_due$
DECLARE
  v_supabase_url     text;
  v_service_role_key text;
  v_enabled          boolean;
  v_chat_id          text;
  v_alert_days       int;
  v_today            date;
  v_tank             record;
  v_dedupe_key       text;
  v_already_sent     int;
  v_days_diff        int;
  v_when_text        text;
  v_payload          jsonb;
BEGIN
  -- Read settings from the settings table.
  SELECT value INTO v_supabase_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_service_role_key FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT (value = 'true') INTO v_enabled
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
  SELECT value INTO v_chat_id
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
  SELECT value::int INTO v_alert_days
    FROM settings WHERE key = 'OXYGEN_INSPECTION_ALERT_DAYS';

  -- Guard: notify credentials not configured.
  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE WARNING
      'check_oxygen_inspection_due: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY '
      'ยังไม่ได้ตั้งค่า — ข้ามการแจ้งเตือน';
    RETURN;
  END IF;

  -- Guard: Telegram globally disabled.
  IF v_enabled IS NOT TRUE THEN
    RETURN;
  END IF;

  -- Guard: chat destination not configured. Without this a NULL chat_id would
  -- be POSTed to tg-notify as "chat_id":null and the alert would silently go
  -- nowhere. (The sibling check_oxygen_refill_batch lacks this guard — tracked
  -- separately for a consistency fix.)
  IF v_chat_id IS NULL THEN
    RAISE WARNING
      'check_oxygen_inspection_due: NOTIFY_TELEGRAM_CHAT_ID ยังไม่ได้ตั้งค่า — ข้ามการแจ้งเตือน';
    RETURN;
  END IF;

  v_alert_days := COALESCE(v_alert_days, 30);
  v_today      := (now() AT TIME ZONE 'Asia/Bangkok')::date;

  -- One alert per tank in the window (due-soon OR overdue), excluding retired.
  FOR v_tank IN
    SELECT id, serial, tank_size, next_inspection_due
    FROM oxygen_tanks
    WHERE next_inspection_due IS NOT NULL
      AND next_inspection_due <= v_today + v_alert_days
      AND status <> 'retired'
    ORDER BY next_inspection_due
  LOOP
    v_dedupe_key := 'oxygen_inspection_due:' || v_tank.id || ':'
                    || v_tank.next_inspection_due;

    SELECT count(*) INTO v_already_sent
    FROM notification_log
    WHERE dedupe_key = v_dedupe_key AND success = true;

    IF v_already_sent > 0 THEN
      CONTINUE;  -- this tank+due-date already alerted
    END IF;

    v_days_diff := v_tank.next_inspection_due - v_today;
    IF v_days_diff < 0 THEN
      v_when_text := format('เกินกำหนด %s วัน', abs(v_days_diff));
    ELSIF v_days_diff = 0 THEN
      v_when_text := 'ครบกำหนดวันนี้';
    ELSE
      v_when_text := format('อีก %s วัน', v_days_diff);
    END IF;

    v_payload := jsonb_build_object(
      'event_type', 'oxygen_inspection_due',
      'dedupe_key', v_dedupe_key,
      'message', format(
        '[Stock] ถังออกซิเจน %s (%s) ครบกำหนดทดสอบถัง %s (%s)',
        v_tank.serial, v_tank.tank_size, v_tank.next_inspection_due, v_when_text
      ),
      'chat_id', v_chat_id
    );

    PERFORM net.http_post(
      url     := v_supabase_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_role_key,
        'apikey',        v_service_role_key,
        'X-Internal',    'true'
      ),
      body    := v_payload::text
    );
  END LOOP;

  RETURN;
END;
$check_oxygen_inspection_due$;

COMMENT ON FUNCTION check_oxygen_inspection_due() IS
  'Phase 5.1. Daily pg_cron job. Sends one Telegram alert per oxygen tank whose '
  'next_inspection_due is within OXYGEN_INSPECTION_ALERT_DAYS (or already '
  'overdue) and not retired. Dedupe key '
  'oxygen_inspection_due:<tank_id>:<due_date> — one alert per tank per '
  'due-date. Reuses tg-notify; reads NOTIFY_* from the settings table.';

-- ── 3. Schedule daily at 02:00 UTC = 09:00 Asia/Bangkok ────────────────────
DO $cron_oxygen_inspection$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'oxygen_inspection_alert') THEN
    PERFORM cron.unschedule('oxygen_inspection_alert');
  END IF;
END
$cron_oxygen_inspection$;

SELECT cron.schedule(
  'oxygen_inspection_alert',
  '0 2 * * *',
  $$SELECT check_oxygen_inspection_due()$$
);

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Setting seeded:
--    SELECT key, value FROM settings WHERE key = 'OXYGEN_INSPECTION_ALERT_DAYS';
--    Expected: 1 row, value = '30'.
--
-- B) Function exists, SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname = 'check_oxygen_inspection_due';
--    Expected: 1 row, prosecdef = true.
--
-- C) Cron job registered:
--    SELECT jobname, schedule FROM cron.job
--    WHERE jobname = 'oxygen_inspection_alert';
--    Expected: 1 row, schedule = '0 2 * * *'.
--
-- D) Manual smoke run (does nothing harmful if no tanks are due):
--    SELECT check_oxygen_inspection_due();
--    Expected: no error.
