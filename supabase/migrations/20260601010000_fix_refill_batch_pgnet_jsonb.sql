-- supabase/migrations/20260601010000_fix_refill_batch_pgnet_jsonb.sql
-- CRITICAL fix — check_oxygen_refill_batch() called net.http_post with
-- `body := v_payload::text`, which re-introduced the bug that
-- 20260521050000_fix_oxygen_refill_pgnet.sql had fixed: net.http_post's body
-- parameter is JSONB, so the ::text form resolves to a non-existent overload
-- and raises SQLSTATE 42883 at runtime.
--
-- The regression slipped back in when 20260529010100 (awaiting_refill) rewrote
-- this function from the older 20260519050500 source (which still used ::text).
--
-- Because this is an AFTER INSERT trigger on oxygen_movements with NO exception
-- handler around the PERFORM, the error would propagate and ROLL BACK the very
-- movement that crossed the threshold — i.e. the first time ≥ OXYGEN_REFILL_THRESHOLD
-- tanks reach 'awaiting_refill', the staff/admin transition would fail and no
-- alert would send. The sibling notify_* functions already pass jsonb and wrap
-- the call in BEGIN…EXCEPTION; this brings check_oxygen_refill_batch in line.
--
-- Changes vs 20260529010100:
--   1. body := v_payload  (jsonb, not ::text)
--   2. wrap net.http_post in BEGIN…EXCEPTION WHEN OTHERS → RAISE WARNING, so a
--      transient pg_net failure can never roll back a legitimate tank movement.
-- Logic (guard on awaiting_refill, count, dedupe, threshold) is otherwise
-- unchanged. Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION check_oxygen_refill_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $check_oxygen_refill_batch$
DECLARE
  v_awaiting_count   int;
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
  -- Guard: only fire when a tank enters 'awaiting_refill' (staged at base).
  IF NEW.to_status <> 'awaiting_refill' THEN
    RETURN NEW;
  END IF;

  SELECT value INTO v_supabase_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_service_role_key FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT (value = 'true') INTO v_enabled
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
  SELECT value INTO v_chat_id
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
  SELECT value::int INTO v_threshold
    FROM settings WHERE key = 'OXYGEN_REFILL_THRESHOLD';

  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE WARNING
      'check_oxygen_refill_batch: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY '
      'ยังไม่ได้ตั้งค่า — ข้ามการส่งแจ้งเตือน';
    RETURN NEW;
  END IF;

  IF v_enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_awaiting_count
  FROM oxygen_tanks WHERE status = 'awaiting_refill';

  IF v_awaiting_count < COALESCE(v_threshold, 5) THEN
    RETURN NEW;
  END IF;

  v_dedupe_key := 'oxygen_refill_batch:' ||
    to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

  SELECT count(*) INTO v_already_sent
  FROM notification_log
  WHERE dedupe_key = v_dedupe_key
    AND success = true;

  IF v_already_sent > 0 THEN
    RETURN NEW;  -- Already alerted today — silent skip.
  END IF;

  SELECT string_agg(
    serial || ' (' || tank_size || ')',
    E'\n' ORDER BY serial
  ) INTO v_tank_list
  FROM oxygen_tanks WHERE status = 'awaiting_refill';

  v_payload := jsonb_build_object(
    'event_type', 'oxygen_refill_batch',
    'dedupe_key', v_dedupe_key,
    'message',    format(
      '[Stock] ถังรอส่งเติม %s ถัง (ถึงเกณฑ์ %s ถัง) — รวบส่งร้านได้แล้ว%s%s',
      v_awaiting_count,
      COALESCE(v_threshold, 5),
      E'\n',
      COALESCE(v_tank_list, '(ไม่พบรายการ)')
    ),
    'chat_id',    v_chat_id
  );

  -- Fail-soft: a pg_net hiccup must never roll back the tank movement that
  -- fired this AFTER INSERT trigger.
  BEGIN
    PERFORM net.http_post(
      url     := v_supabase_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_role_key,
        'apikey',        v_service_role_key,
        'X-Internal',    'true'
      ),
      body    := v_payload      -- jsonb (NOT ::text — net.http_post overload is jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'check_oxygen_refill_batch: pg_net.http_post failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$check_oxygen_refill_batch$;

-- Verify after applying:
-- SELECT pg_get_functiondef('check_oxygen_refill_batch'::regproc) LIKE '%v_payload::text%'
--        AS still_has_bug;   -- expect: false
