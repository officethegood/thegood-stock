-- supabase/migrations/20260529010100_oxygen_awaiting_refill_logic.sql
-- Companion to 20260529010000_oxygen_awaiting_refill_enum.sql.
-- MUST run after that migration has committed (uses the new 'awaiting_refill'
-- enum value, which Postgres forbids in the same transaction it was added).
--
-- Contents:
--   1. Backfill: every tank currently 'refilling' → 'awaiting_refill'
--      (semantics changed: refilling now = "at vendor" only). Plain UPDATE,
--      no synthetic oxygen_movements rows — keeps it simple and avoids the
--      BEFORE INSERT state-machine trigger.
--   2. enforce_oxygen_state_machine() — add 3 transition combos.
--   3. notify_oxygen_movement_to_tg()  — add 4 label branches (correct order).
--   4. check_oxygen_refill_batch()      — alert now fires/counts on awaiting_refill.
--
-- Triggers are bound by function name → CREATE OR REPLACE keeps them wired.
-- Idempotent: UPDATE is naturally idempotent; CREATE OR REPLACE FUNCTION.

-- ══════════════════════════════════════════════════════════════════════════════
-- 1) Backfill existing 'refilling' tanks → 'awaiting_refill'
-- ══════════════════════════════════════════════════════════════════════════════

UPDATE oxygen_tanks
SET    status = 'awaiting_refill', updated_at = now()
WHERE  status = 'refilling';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2) State machine — BEFORE INSERT on oxygen_movements
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
  SELECT status, serial
  INTO v_current_status, v_serial
  FROM oxygen_tanks
  WHERE id = NEW.tank_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'oxygen_tanks row not found for tank_id %', NEW.tank_id;
  END IF;

  v_role := app_user_role();  -- Phase 0 helper: 'Admin' or 'Employee'

  IF v_current_status = 'retired' THEN
    RAISE EXCEPTION 'ถังหมายเลข % ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้', v_serial;
  END IF;

  IF NEW.from_status IS DISTINCT FROM v_current_status THEN
    RAISE EXCEPTION 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)',
      v_current_status::text, COALESCE(NEW.from_status::text, 'NULL');
  END IF;

  IF NOT (
    -- Initial placement (NULL → ready, Admin only)
    (NEW.from_status IS NULL          AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- ready → on_board (Admin or Staff): ขึ้นรถ
    (NEW.from_status = 'ready'        AND NEW.to_status = 'on_board') OR
    -- on_board → ready (Admin or Staff): คืนถัง — ambulance returned, tank unused
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'ready') OR
    -- on_board → awaiting_refill (Admin or Staff): ลงรอเติม — off truck, staged at base
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'awaiting_refill') OR
    -- on_board → refilling (Admin or Staff): ส่งเติม — sent straight from truck
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'refilling') OR
    -- awaiting_refill → refilling (Admin or Staff): ส่งร้าน — batch sent to vendor
    (NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'refilling') OR
    -- awaiting_refill → ready (Admin only): ยกเลิกรอเติม — tank still has gas, correction
    (NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- refilling → ready (Admin only): เติมเสร็จ
    (NEW.from_status = 'refilling'    AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → maintenance (Admin only)
    (NEW.to_status = 'maintenance'    AND v_role = 'Admin') OR
    -- maintenance → ready (Admin only)
    (NEW.from_status = 'maintenance'  AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → retired (Admin only, terminal)
    (NEW.to_status = 'retired'        AND v_role = 'Admin')
  ) THEN
    -- FE grep target string (decisions-locked derived #5, verbatim):
    RAISE EXCEPTION 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง';
  END IF;

  RETURN NEW;
END;
$enforce_oxygen_state_machine$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3) Telegram notifier — AFTER INSERT on oxygen_movements
--    Specific (from,to) branches BEFORE the broad to='refilling' branch.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION notify_oxygen_movement_to_tg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net
AS $notify_oxygen_movement$
DECLARE
  v_enabled          boolean;
  v_chat_id          text;
  v_supabase_url     text;
  v_service_role_key text;
  v_serial           text;
  v_tank_size        text;
  v_from_loc         text;
  v_to_loc           text;
  v_action_emoji     text;
  v_action_label     text;
  v_message          text;
  v_payload          jsonb;
  v_dedupe_key       text;
BEGIN
  BEGIN
    SELECT (value = 'true') INTO v_enabled
      FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
    IF v_enabled IS NOT TRUE THEN RETURN NEW; END IF;

    SELECT value INTO v_chat_id          FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
    SELECT value INTO v_supabase_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
    SELECT value INTO v_service_role_key FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

    IF v_chat_id          IS NULL OR v_chat_id          = '' THEN RETURN NEW; END IF;
    IF v_supabase_url     IS NULL OR v_supabase_url     = '' THEN RETURN NEW; END IF;
    IF v_service_role_key IS NULL OR v_service_role_key = '' THEN RETURN NEW; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_oxygen_movement: settings read failed: %', SQLERRM;
    RETURN NEW;
  END;

  BEGIN
    SELECT serial, tank_size INTO v_serial, v_tank_size FROM oxygen_tanks WHERE id = NEW.tank_id;
    IF NEW.from_location_id IS NOT NULL THEN
      SELECT code INTO v_from_loc FROM locations WHERE id = NEW.from_location_id;
    END IF;
    IF NEW.to_location_id IS NOT NULL THEN
      SELECT code INTO v_to_loc   FROM locations WHERE id = NEW.to_location_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_oxygen_movement: name lookup failed: %', SQLERRM;
  END;

  -- Action label by (from_status, to_status). Specific combos first.
  IF NEW.from_status IS NULL AND NEW.to_status = 'ready' THEN
    v_action_emoji := '🆕'; v_action_label := 'รับถังใหม่';
  ELSIF NEW.from_status = 'ready' AND NEW.to_status = 'on_board' THEN
    v_action_emoji := '🚐'; v_action_label := 'ขึ้นรถ';
  ELSIF NEW.from_status = 'on_board' AND NEW.to_status = 'ready' THEN
    v_action_emoji := '🏠'; v_action_label := 'คืนถัง';
  ELSIF NEW.from_status = 'on_board' AND NEW.to_status = 'awaiting_refill' THEN
    v_action_emoji := '⬇️'; v_action_label := 'ลงรอเติม';
  ELSIF NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'refilling' THEN
    v_action_emoji := '🚚'; v_action_label := 'ส่งร้าน';
  ELSIF NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'ready' THEN
    v_action_emoji := '↩️'; v_action_label := 'ยกเลิกรอเติม';
  ELSIF NEW.to_status = 'refilling' THEN
    -- Catches on_board → refilling (sent straight from truck).
    v_action_emoji := '⛽'; v_action_label := 'ส่งเติม';
  ELSIF NEW.from_status = 'refilling' AND NEW.to_status = 'ready' THEN
    v_action_emoji := '✅'; v_action_label := 'เติมเสร็จ';
  ELSIF NEW.to_status = 'maintenance' THEN
    v_action_emoji := '🔧'; v_action_label := 'ส่งซ่อม';
  ELSIF NEW.from_status = 'maintenance' AND NEW.to_status = 'ready' THEN
    v_action_emoji := '🛠️'; v_action_label := 'ซ่อมเสร็จ';
  ELSIF NEW.to_status = 'retired' THEN
    v_action_emoji := '⛔'; v_action_label := 'ปลดระวาง';
  ELSE
    v_action_emoji := '🔄';
    v_action_label := format('%s→%s',
      COALESCE(NEW.from_status::text, '∅'),
      NEW.to_status::text);
  END IF;

  v_message := format('%s %s · %s (%s) · %s',
    v_action_emoji,
    v_action_label,
    COALESCE(v_serial,    '?'),
    COALESCE(v_tank_size, '?'),
    COALESCE(NEW.performed_by, '?')
  );

  IF v_to_loc IS NOT NULL AND v_to_loc <> COALESCE(v_from_loc, '') THEN
    v_message := v_message || ' · ' || v_to_loc;
  END IF;

  v_dedupe_key := 'oxmv:' || NEW.id::text;
  v_payload := jsonb_build_object(
    'event_type',  'oxygen_movement',
    'entity_type', 'oxygen_movement',
    'entity_id',   NEW.id::text,
    'dedupe_key',  v_dedupe_key,
    'message',     v_message,
    'chat_id',     v_chat_id
  );

  BEGIN
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
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_oxygen_movement: pg_net.http_post failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$notify_oxygen_movement$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 4) Refill-batch alert — now fires when tanks pile up in 'awaiting_refill'.
--    Cue: "you have enough staged tanks to be worth a vendor trip."
-- ══════════════════════════════════════════════════════════════════════════════

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

  -- Count tanks currently staged awaiting refill.
  SELECT count(*) INTO v_awaiting_count
  FROM oxygen_tanks WHERE status = 'awaiting_refill';

  IF v_awaiting_count < COALESCE(v_threshold, 5) THEN
    RETURN NEW;
  END IF;

  -- Dedupe: one alert per calendar day (Bangkok timezone).
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

-- Verification:
-- A) Enum has 6 values incl awaiting_refill before refilling.
-- B) No tank left in 'refilling' right after migration (all backfilled):
--    SELECT status, count(*) FROM oxygen_tanks GROUP BY status;
-- C) Functions present & SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('enforce_oxygen_state_machine','notify_oxygen_movement_to_tg','check_oxygen_refill_batch');
-- D) End-to-end: on_board → awaiting_refill yields '⬇️ ลงรอเติม' Telegram message.
