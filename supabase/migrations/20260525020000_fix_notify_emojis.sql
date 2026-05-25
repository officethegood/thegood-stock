-- supabase/migrations/20260525020000_fix_notify_emojis.sql
-- Hotfix — supplementary-plane emojis (>U+FFFF) in 20260525000000 and
-- 20260525010000 were written with `U&'\1F4E5'` style escapes. Postgres'
-- 4-digit U& escape only covers the BMP, so `\1F4E5` was parsed as
-- `\1F4E` followed by the literal '5' — every supplementary-plane glyph
-- (📥 📤 🤝 🆕 🚐 🏠 🔧 🛠 🔄) came out broken in Telegram.
--
-- This migration CREATE OR REPLACEs both functions with literal UTF-8
-- emoji characters in the source (no escapes). Trigger bindings are by
-- name, so they keep pointing at the new function bodies — no trigger
-- recreate needed. Logic is otherwise unchanged.

-- ==========================================================================
-- 1) stock_movements notifier
-- ==========================================================================

CREATE OR REPLACE FUNCTION notify_stock_movement_to_tg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net
AS $notify_stock_movement$
DECLARE
  v_enabled          boolean;
  v_chat_id          text;
  v_supabase_url     text;
  v_service_role_key text;
  v_item_sku         text;
  v_item_name        text;
  v_loc_code         text;
  v_lot_number       text;
  v_action_emoji     text;
  v_action_label     text;
  v_qty_abs          int;
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
    RAISE WARNING 'notify_stock_movement: settings read failed: %', SQLERRM;
    RETURN NEW;
  END;

  BEGIN
    SELECT sku, name INTO v_item_sku, v_item_name FROM stock_items WHERE id = NEW.item_id;
    SELECT code       INTO v_loc_code             FROM locations   WHERE id = NEW.location_id;
    IF NEW.lot_id IS NOT NULL THEN
      SELECT lot_number INTO v_lot_number FROM stock_lots WHERE id = NEW.lot_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_stock_movement: name lookup failed: %', SQLERRM;
  END;

  v_qty_abs := abs(NEW.qty_delta);
  CASE NEW.movement_type
    WHEN 'receive'         THEN v_action_emoji := '📥'; v_action_label := 'รับเข้า';
    WHEN 'issue'           THEN v_action_emoji := '📤'; v_action_label := 'เบิก';
    WHEN 'adjustment_gain' THEN v_action_emoji := '➕'; v_action_label := 'ปรับยอดเพิ่ม';
    WHEN 'adjustment_loss' THEN v_action_emoji := '➖'; v_action_label := 'ของหาย/ปรับลด';
    WHEN 'borrow'          THEN v_action_emoji := '🤝'; v_action_label := 'ยืม';
    WHEN 'return'          THEN v_action_emoji := '↩️'; v_action_label := 'คืน';
    WHEN 'transfer_out'    THEN v_action_emoji := '→'; v_action_label := 'ย้ายออก';
    WHEN 'transfer_in'     THEN v_action_emoji := '←'; v_action_label := 'ย้ายเข้า';
    ELSE                        v_action_emoji := '•'; v_action_label := NEW.movement_type::text;
  END CASE;

  v_message := format('%s %s · %s %s ×%s · %s · %s',
    v_action_emoji,
    v_action_label,
    COALESCE(v_item_sku,  '?'),
    COALESCE(v_item_name, ''),
    v_qty_abs,
    COALESCE(v_loc_code,  '?'),
    COALESCE(NEW.performed_by, '?')
  );

  IF v_lot_number IS NOT NULL THEN
    v_message := v_message || ' · ล็อต ' || v_lot_number;
  END IF;

  IF NEW.movement_type = 'borrow' AND NEW.due_at IS NOT NULL THEN
    v_message := v_message || ' · ครบกำหนด ' ||
                 to_char(NEW.due_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM');
  END IF;

  IF NEW.reason IS NOT NULL AND btrim(NEW.reason) <> '' THEN
    v_message := v_message || ' · เหตุ: ' || NEW.reason;
  END IF;

  v_dedupe_key := 'sm:' || NEW.id::text;
  v_payload := jsonb_build_object(
    'event_type',  'stock_movement',
    'entity_type', 'stock_movement',
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
    RAISE WARNING 'notify_stock_movement: pg_net.http_post failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$notify_stock_movement$;

-- ==========================================================================
-- 2) oxygen_movements notifier
-- ==========================================================================

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

  IF NEW.from_status IS NULL AND NEW.to_status = 'ready' THEN
    v_action_emoji := '🆕'; v_action_label := 'รับถังใหม่';
  ELSIF NEW.from_status = 'ready' AND NEW.to_status = 'on_board' THEN
    v_action_emoji := '🚐'; v_action_label := 'ขึ้นรถ';
  ELSIF NEW.from_status = 'on_board' AND NEW.to_status = 'ready' THEN
    v_action_emoji := '🏠'; v_action_label := 'คืนถัง';
  ELSIF NEW.to_status = 'refilling' THEN
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

-- ==========================================================================
-- Verify after applying
-- ==========================================================================
-- After running this hotfix, a fresh stock_movement insert should produce
-- a notification_log row whose payload.message begins with the proper
-- single-character emoji (📥 / 📤 / 🤝 / 🆕 / 🚐 / 🏠 / 🔧 / 🛠️ / 🔄)
-- rather than the broken 2-codepoint sequence the previous migrations
-- produced.
