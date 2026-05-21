-- supabase/migrations/20260521020000_fix_oxygen_inspection_pgnet.sql
-- Phase 5.1 hotfix — correct the net.http_post() call in
-- check_oxygen_inspection_due().
--
-- Bug:
--   20260521010100_oxygen_inspection_cron.sql called
--     net.http_post(url := text, headers := jsonb, body := v_payload::text)
--   The pg_net extension's http_post() takes the body as JSONB, not text, so
--   the named-argument call resolved to no function and raised at runtime:
--     ERROR 42883: function net.http_post(url => text, headers => jsonb,
--                  body => text) does not exist
--   The function compiled fine (CREATE OR REPLACE does not type-check the
--   PERFORM target), so the defect only surfaced when the function ran.
--
-- Fix:
--   Pass the JSONB payload directly as `body` (drop the ::text cast). v_payload
--   is already declared jsonb and built with jsonb_build_object().
--
-- Scope note:
--   The sibling check_oxygen_refill_batch() in 20260519050500_oxygen_triggers.sql
--   has the identical `body := v_payload::text` defect. It is latent (that
--   alert has never fired — it needs OXYGEN_REFILL_THRESHOLD tanks in
--   'refilling' at once). It is tracked for a separate fix and is intentionally
--   NOT changed here to keep this hotfix scoped to the inspection feature.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

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

    -- FIX: pass the JSONB payload as `body` directly — pg_net http_post()
    -- takes body as jsonb, not text.
    PERFORM net.http_post(
      url     := v_supabase_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_role_key,
        'apikey',        v_service_role_key,
        'X-Internal',    'true'
      ),
      body    := v_payload
    );
  END LOOP;

  RETURN;
END;
$check_oxygen_inspection_due$;

COMMENT ON FUNCTION check_oxygen_inspection_due() IS
  'Phase 5.1 (hotfix 20260521020000). Daily pg_cron job. Sends one Telegram '
  'alert per oxygen tank whose next_inspection_due is within '
  'OXYGEN_INSPECTION_ALERT_DAYS (or already overdue) and not retired. Dedupe '
  'key oxygen_inspection_due:<tank_id>:<due_date> — one alert per tank per '
  'due-date. Reuses tg-notify; reads NOTIFY_* from the settings table. '
  'net.http_post body is passed as jsonb.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Confirm the installed pg_net http_post signature (informational):
--    SELECT pg_get_function_identity_arguments(oid)
--    FROM pg_proc
--    WHERE proname = 'http_post' AND pronamespace = 'net'::regnamespace;
--    Expected: the `body` parameter is typed `jsonb`.
--
-- B) Smoke run — must complete with NO error now:
--    SELECT check_oxygen_inspection_due();
--    Expected: no error (returns void).
