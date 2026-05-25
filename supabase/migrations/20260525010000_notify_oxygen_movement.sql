-- supabase/migrations/20260525010000_notify_oxygen_movement.sql
-- Real-time Telegram notification for every oxygen_movements row.
--
-- Companion to 20260525000000_notify_stock_movement.sql. Same chat, same
-- fail-soft pattern, same concise + performer format.
--
-- Covers all oxygen state transitions:
--   NULL→ready (initial placement)  · ready→on_board (ขึ้นรถ)
--   on_board→ready (คืนถัง)         · *→refilling (ส่งเติม)
--   refilling→ready (เติมเสร็จ)      · *→maintenance (ส่งซ่อม)
--   maintenance→ready (ซ่อมเสร็จ)    · *→retired (ปลดระวาง)
--
-- Format (≤200 chars):
--   {emoji} {action} · {serial} ({size}) · {performed_by}  [· {to_loc}]
--
-- Fail-soft: settings / lookup / pg_net errors emit RAISE WARNING and the
-- inserting transaction succeeds regardless.
--
-- Depends on: oxygen_movements (Phase 5), oxygen_tanks, locations,
-- settings, pg_net.
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

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
  -- 1. Read settings — fail-soft.
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

  -- 2. Resolve display names — fail-soft.
  BEGIN
    SELECT serial, tank_size INTO v_serial, v_tank_size
      FROM oxygen_tanks WHERE id = NEW.tank_id;
    IF NEW.from_location_id IS NOT NULL THEN
      SELECT code INTO v_from_loc FROM locations WHERE id = NEW.from_location_id;
    END IF;
    IF NEW.to_location_id IS NOT NULL THEN
      SELECT code INTO v_to_loc   FROM locations WHERE id = NEW.to_location_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_oxygen_movement: name lookup failed: %', SQLERRM;
  END;

  -- 3. Action label by (from_status, to_status).
  IF NEW.from_status IS NULL AND NEW.to_status = 'ready' THEN
    v_action_emoji := U&'\1F195'; v_action_label := 'รับถังใหม่';
  ELSIF NEW.from_status = 'ready' AND NEW.to_status = 'on_board' THEN
    v_action_emoji := U&'\1F695'; v_action_label := 'ขึ้นรถ';
  ELSIF NEW.from_status = 'on_board' AND NEW.to_status = 'ready' THEN
    v_action_emoji := U&'\1F3E0'; v_action_label := 'คืนถัง';
  ELSIF NEW.to_status = 'refilling' THEN
    v_action_emoji := U&'\26FD';  v_action_label := 'ส่งเติม';
  ELSIF NEW.from_status = 'refilling' AND NEW.to_status = 'ready' THEN
    v_action_emoji := U&'\2705';  v_action_label := 'เติมเสร็จ';
  ELSIF NEW.to_status = 'maintenance' THEN
    v_action_emoji := U&'\1F527'; v_action_label := 'ส่งซ่อม';
  ELSIF NEW.from_status = 'maintenance' AND NEW.to_status = 'ready' THEN
    v_action_emoji := U&'\1F6E0'; v_action_label := 'ซ่อมเสร็จ';
  ELSIF NEW.to_status = 'retired' THEN
    v_action_emoji := U&'\26D4';  v_action_label := 'ปลดระวาง';
  ELSE
    v_action_emoji := U&'\1F504';
    v_action_label := format('%s→%s',
      COALESCE(NEW.from_status::text, '∅'),
      NEW.to_status::text);
  END IF;

  -- 4. Compose message.
  v_message := format('%s %s · %s (%s) · %s',
    v_action_emoji,
    v_action_label,
    COALESCE(v_serial,    '?'),
    COALESCE(v_tank_size, '?'),
    COALESCE(NEW.performed_by, '?')
  );

  -- Show destination location when it changed (skip when same / null).
  IF v_to_loc IS NOT NULL AND v_to_loc <> COALESCE(v_from_loc, '') THEN
    v_message := v_message || ' · ' || v_to_loc;
  END IF;

  -- 5. Post via pg_net — fail-soft.
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

COMMENT ON FUNCTION notify_oxygen_movement_to_tg() IS
  'Phase post-5.1. AFTER INSERT on oxygen_movements. Posts a one-line Thai '
  'Telegram message per tank state transition via tg-notify → ocr-proxy. '
  'Fail-soft: settings / lookup / pg_net errors emit RAISE WARNING only '
  'and must not block the inserting transaction.';

DROP TRIGGER IF EXISTS trg_oxygen_notify_tg ON oxygen_movements;
CREATE TRIGGER trg_oxygen_notify_tg
  AFTER INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION notify_oxygen_movement_to_tg();

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function present and SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='notify_oxygen_movement_to_tg';
--    Expected: 1 row, prosecdef = true.
--
-- B) Trigger wired:
--    SELECT tgname, tgenabled FROM pg_trigger WHERE tgname='trg_oxygen_notify_tg';
--    Expected: 1 row, tgenabled='O'.
--
-- C) End-to-end: transition a tank's status (e.g. ready→on_board via the
--    "เปลี่ยนสถานะ" modal). Expected: a Telegram message arrives in the
--    admin group within ~1 second.
