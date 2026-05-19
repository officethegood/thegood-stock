-- supabase/migrations/20260519050500_oxygen_triggers.sql
-- Phase 5 — Three trigger functions on oxygen_movements.
--
-- Function A: enforce_oxygen_state_machine() — BEFORE INSERT
--   Validates state-machine transitions. FE grep string:
--   'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง' (decisions-locked derived #5, verbatim).
--
-- Function B: apply_oxygen_movement() — AFTER INSERT
--   Updates oxygen_tanks.status, current_location_id, last_refill_at/by.
--
-- Function C: check_oxygen_refill_batch() — AFTER INSERT WHERE to_status='refilling'
--   Counts refilling tanks vs OXYGEN_REFILL_THRESHOLD.
--   If >= threshold and no alert today: pg_net POST to tg-notify (Phase 0) reused.
--   Dedupe key: 'oxygen_refill_batch:YYYY-MM-DD' (Bangkok timezone).
--   Reads NOTIFY_* from settings table — NOT current_setting('app.*').
--   Project.md §8 gotcha 9.
--
-- NO pg_cron job — Phase 5 alerting is event-driven (trigger-based).
-- Pattern mirrors Phase 2 stock_lot_triggers.sql BEFORE INSERT state machine
-- (check_lot_status) and Phase 0/1 tg-notify trigger pattern.
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION A: State machine — BEFORE INSERT on oxygen_movements
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION enforce_oxygen_state_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $enforce_oxygen_state_machine$
DECLARE
  v_current_status oxygen_tank_status;
  v_serial         text;
  v_role           text;
BEGIN
  -- 1. Fetch the tank's current authoritative status and serial.
  SELECT status, serial
  INTO v_current_status, v_serial
  FROM oxygen_tanks
  WHERE id = NEW.tank_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'oxygen_tanks row not found for tank_id %', NEW.tank_id;
  END IF;

  v_role := app_user_role();  -- Phase 0 helper: returns 'Admin' or 'Employee'

  -- 2. Terminal state check: retired tanks block ALL further transitions.
  IF v_current_status = 'retired' THEN
    RAISE EXCEPTION 'ถังหมายเลข % ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้', v_serial;
  END IF;

  -- 3. Validate from_status matches current (unless initial placement where from_status IS NULL).
  IF NEW.from_status IS DISTINCT FROM v_current_status THEN
    RAISE EXCEPTION 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)',
      v_current_status::text, COALESCE(NEW.from_status::text, 'NULL');
  END IF;

  -- 4. State machine transition table.
  --    Decisions-locked derived #5. FE grep string for the blocked case:
  --    'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'
  IF NOT (
    -- Initial placement (NULL → ready, Admin only)
    (NEW.from_status IS NULL          AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- ready → on_board (Admin or Staff)
    (NEW.from_status = 'ready'        AND NEW.to_status = 'on_board') OR
    -- on_board → ready (Admin or Staff: ambulance returned, tank unused)
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'ready') OR
    -- on_board → refilling (Admin or Staff: tank emptied during run)
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'refilling') OR
    -- refilling → ready (Admin only: refill batch completed)
    (NEW.from_status = 'refilling'    AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → maintenance (Admin only: pulled for service)
    (NEW.to_status = 'maintenance'    AND v_role = 'Admin') OR
    -- maintenance → ready (Admin only: maintenance complete)
    (NEW.from_status = 'maintenance'  AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → retired (Admin only: terminal — no return from retired)
    (NEW.to_status = 'retired'        AND v_role = 'Admin')
  ) THEN
    -- FE grep target string (decisions-locked derived #5, verbatim):
    RAISE EXCEPTION 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง';
  END IF;

  RETURN NEW;
END;
$enforce_oxygen_state_machine$;

COMMENT ON FUNCTION enforce_oxygen_state_machine() IS
  'Phase 5. BEFORE INSERT on oxygen_movements. Validates state-machine transitions. '
  'FE grep string for blocked transitions: ''การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'' '
  '(decisions-locked derived #5, verbatim). '
  'SECURITY DEFINER — reads oxygen_tanks and app_user_role() past RLS.';

DROP TRIGGER IF EXISTS trg_oxygen_state_machine ON oxygen_movements;
CREATE TRIGGER trg_oxygen_state_machine
  BEFORE INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_oxygen_state_machine();


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION B: Apply movement to oxygen_tanks — AFTER INSERT on oxygen_movements
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_oxygen_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $apply_oxygen_movement$
BEGIN
  UPDATE oxygen_tanks SET
    status              = NEW.to_status,
    current_location_id = COALESCE(NEW.to_location_id, current_location_id),
      -- Keep existing location if to_location_id not supplied (e.g., maintenance in-place).
    last_refill_at      = CASE
                            WHEN NEW.to_status = 'ready'
                             AND NEW.from_status = 'refilling'
                            THEN NEW.performed_at
                            ELSE last_refill_at
                          END,
    last_refill_by      = CASE
                            WHEN NEW.to_status = 'ready'
                             AND NEW.from_status = 'refilling'
                            THEN NEW.performed_by
                            ELSE last_refill_by
                          END,
    updated_at          = now(),
    updated_by          = NEW.performed_by
  WHERE id = NEW.tank_id;

  RETURN NEW;
END;
$apply_oxygen_movement$;

COMMENT ON FUNCTION apply_oxygen_movement() IS
  'Phase 5. AFTER INSERT on oxygen_movements. Updates oxygen_tanks.status, '
  'current_location_id, last_refill_at/by. SECURITY DEFINER bypasses RLS UPDATE block. '
  'last_refill_at/by set only when to_status=ready AND from_status=refilling.';

DROP TRIGGER IF EXISTS trg_oxygen_apply_movement ON oxygen_movements;
CREATE TRIGGER trg_oxygen_apply_movement
  AFTER INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION apply_oxygen_movement();


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION C: Refill-batch alert — AFTER INSERT on oxygen_movements
-- Only fires when to_status = 'refilling'.
-- Reads settings table (NOT current_setting — Project.md §8 gotcha 9).
-- Dedupe key: 'oxygen_refill_batch:YYYY-MM-DD' (Bangkok timezone).
-- Posts to tg-notify Edge Function via pg_net.
-- NO pg_cron — event-driven.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_oxygen_refill_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
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
  'NO pg_cron — event-driven only.';

DROP TRIGGER IF EXISTS trg_oxygen_refill_alert ON oxygen_movements;
CREATE TRIGGER trg_oxygen_refill_alert
  AFTER INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION check_oxygen_refill_batch();

-- Verification:
-- SELECT proname, prosecdef
-- FROM pg_proc
-- WHERE proname IN (
--   'enforce_oxygen_state_machine',
--   'apply_oxygen_movement',
--   'check_oxygen_refill_batch'
-- )
-- AND pronamespace = 'public'::regnamespace;
-- Expected: 3 rows, all prosecdef = true.
--
-- SELECT trigger_name, event_manipulation, action_timing
-- FROM information_schema.triggers
-- WHERE event_object_table = 'oxygen_movements'
-- ORDER BY trigger_name;
-- Expected:
--   trg_oxygen_refill_alert   — INSERT — AFTER
--   trg_oxygen_apply_movement — INSERT — AFTER
--   trg_oxygen_state_machine  — INSERT — BEFORE
