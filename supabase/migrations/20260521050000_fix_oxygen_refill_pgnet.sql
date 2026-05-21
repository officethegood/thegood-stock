-- supabase/migrations/20260521050000_fix_oxygen_refill_pgnet.sql
-- Phase 5.1 hotfix — correct the net.http_post() body cast in
-- check_oxygen_refill_batch().
--
-- Bug:
--   check_oxygen_refill_batch() (defined 20260519050500, search_path tightened
--   in 20260519050700) called:
--       net.http_post(url := text, headers := jsonb, body := v_payload::text)
--   pg_net's http_post() takes the body as JSONB, not text, so the named-arg
--   call resolves to no function and raises at runtime:
--       ERROR 42883: function net.http_post(url => text, headers => jsonb,
--                    body => text) does not exist
--   CREATE OR REPLACE does not type-check the PERFORM target, so the function
--   compiled fine and the defect only surfaces when the trigger actually fires
--   (needs OXYGEN_REFILL_THRESHOLD tanks in 'refilling' at once — it has never
--   fired in production, so the bug stayed latent).
--
--   This is the same defect already fixed for the sibling
--   check_oxygen_inspection_due() in hotfix 20260521020000. That hotfix
--   intentionally left this sibling untouched to keep its scope tight and
--   noted it would be corrected separately — this migration is that fix.
--
-- Fix:
--   Pass the JSONB payload directly as `body` (drop the ::text cast).
--   v_payload is declared jsonb and built with jsonb_build_object().
--
-- Carried forward VERBATIM from 20260519050700: search_path = public, net, all
-- guards and the dedupe logic. ONLY the `body` argument changes.
--
-- Depends on: 20260519050700_tighten_oxygen_triggers_search_path.sql
-- Idempotent: CREATE OR REPLACE FUNCTION. Trigger not recreated (binds by name).

CREATE OR REPLACE FUNCTION check_oxygen_refill_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net
AS $check_oxygen_refill_batch$
DECLARE
  v_refilling_count  int;
  v_threshold        int;
  v_supabase_url     text;
  v_service_role_key text;
  v_enabled          boolean;
  v_chat_id          text;
  v_dedupe_key       text;
  v_already_sent     int;
  v_tank_list        text;
  v_payload          jsonb;
BEGIN
  -- Guard: only fire when a tank enters 'refilling' status.
  IF NEW.to_status <> 'refilling' THEN
    RETURN NEW;
  END IF;

  -- 1. Read settings from settings table.
  --    MUST use settings table — NOT current_setting('app.*').
  --    Project.md §8 gotcha 9: ALTER DATABASE for app.* blocked on Supabase Free/Nano.
  SELECT value INTO v_supabase_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_service_role_key FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT (value = 'true') INTO v_enabled
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
  SELECT value INTO v_chat_id
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
  SELECT value::int INTO v_threshold
    FROM settings WHERE key = 'OXYGEN_REFILL_THRESHOLD';

  -- 2. Guard: skip if notify credentials not configured.
  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE WARNING
      'check_oxygen_refill_batch: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY '
      'ยังไม่ได้ตั้งค่า — ข้ามการส่งแจ้งเตือน';
    RETURN NEW;
  END IF;

  -- 3. Guard: skip if Telegram globally disabled.
  IF v_enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- 4. Count tanks currently in 'refilling' state.
  SELECT count(*) INTO v_refilling_count
  FROM oxygen_tanks WHERE status = 'refilling';

  -- 5. Below threshold — no alert.
  IF v_refilling_count < COALESCE(v_threshold, 5) THEN
    RETURN NEW;
  END IF;

  -- 6. Dedupe: one alert per calendar day (Bangkok timezone).
  --    Key format: 'oxygen_refill_batch:YYYY-MM-DD'
  --    Mirrors Phase 1 'low_stock:<sku>:<date>' pattern.
  v_dedupe_key := 'oxygen_refill_batch:' ||
    to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

  SELECT count(*) INTO v_already_sent
  FROM notification_log
  WHERE dedupe_key = v_dedupe_key
    AND success = true;

  IF v_already_sent > 0 THEN
    RETURN NEW;  -- Already alerted today — silent skip.
  END IF;

  -- 7. Build grouped tank list for Telegram message body.
  SELECT string_agg(
    serial || ' (' || tank_size || ')',
    E'\n' ORDER BY serial
  ) INTO v_tank_list
  FROM oxygen_tanks WHERE status = 'refilling';

  v_payload := jsonb_build_object(
    'event_type', 'oxygen_refill_batch',
    'dedupe_key', v_dedupe_key,
    'message',    format(
      '[Stock] ถังออกซิเจนรอเติม %s ถัง (ถึงเกณฑ์ %s ถัง)%s%s',
      v_refilling_count,
      COALESCE(v_threshold, 5),
      E'\n',
      COALESCE(v_tank_list, '(ไม่พบรายการ)')
    ),
    'chat_id',    v_chat_id
  );

  -- 8. POST via pg_net to the existing tg-notify Edge Function (Phase 0).
  --    No new Edge Function required — reuses tg-notify with event_type='oxygen_refill_batch'.
  --    FIX (hotfix 20260521050000): pass the JSONB payload as `body` directly —
  --    pg_net http_post() takes body as jsonb, not text.
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

  RETURN NEW;
END;
$check_oxygen_refill_batch$;

COMMENT ON FUNCTION check_oxygen_refill_batch() IS
  'Phase 5. AFTER INSERT on oxygen_movements WHERE to_status=refilling. '
  'Counts refilling tanks vs OXYGEN_REFILL_THRESHOLD from settings table. '
  'If >= threshold and no alert today: pg_net POST to tg-notify (Phase 0) '
  'with event_type=oxygen_refill_batch. '
  'Dedupe key: oxygen_refill_batch:YYYY-MM-DD (Bangkok TZ). '
  'Reads NOTIFY_* from settings table — NOT current_setting (Project.md §8 gotcha 9). '
  'NO pg_cron — event-driven only. '
  'search_path = public, net (Phase 0.5.1 polish, 20260519050700). '
  'net.http_post body is passed as jsonb (hotfix 20260521050000).';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Confirm the installed pg_net http_post signature (informational):
--    SELECT pg_get_function_identity_arguments(oid)
--    FROM pg_proc
--    WHERE proname = 'http_post' AND pronamespace = 'net'::regnamespace;
--    Expected: the `body` parameter is typed `jsonb`.
--
-- B) Confirm search_path is unchanged:
--    SELECT proname, proconfig::text FROM pg_proc
--    WHERE proname = 'check_oxygen_refill_batch';
--    Expected: {search_path=public,net}
