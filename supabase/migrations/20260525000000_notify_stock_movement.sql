-- supabase/migrations/20260525000000_notify_stock_movement.sql
-- Real-time Telegram notification for every stock_movements row.
--
-- Fires AFTER INSERT and posts a one-line Thai message to the admin chat
-- (NOTIFY_TELEGRAM_CHAT_ID in the settings table) via the existing
-- tg-notify → ocr-proxy worker chain. Catches ALL movement types:
--   receive · issue · adjustment_gain · adjustment_loss
--   borrow  · return · transfer_out   · transfer_in
-- (Linen laundry actions also flow through this table — AppLaundry posts
-- stock_movements rows — so they are automatically included.)
--
-- Design choices (decided 2026-05-25 with PM):
--   • single chat (NOTIFY_TELEGRAM_CHAT_ID — admin group)
--   • every event, no filtering
--   • concise format, includes performer username
--
-- Format (≤200 chars typical):
--   {emoji} {action} · {sku} {name} ×{qty} · {loc} · {performed_by}
--   + optional: · ล็อต {lot}  · ครบกำหนด DD/MM (borrow)  · เหตุ: {reason}
--
-- Fail-soft: settings-read failures, lookup failures, and pg_net failures
-- are SWALLOWED (RAISE WARNING only). A bug in this notification path must
-- never block a legitimate stock operation. The inner BEGIN…EXCEPTION
-- block guarantees the outer INSERT transaction succeeds regardless.
--
-- Existing critical-alert triggers are unchanged — check_low_stock /
-- expiry-cron / etc. continue to fire on top of this. The user accepted
-- the resulting alert volume (alert-fatigue risk acknowledged).
--
-- Depends on: stock_movements (Phase 1), stock_items, locations,
-- stock_lots, settings, pg_net.
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

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
  -- 1. Read settings — fail-soft (any missing key → no notification, no error).
  BEGIN
    SELECT (value = 'true')           INTO v_enabled
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

  -- 2. Resolve display names — fail-soft (fall through with raw ids).
  BEGIN
    SELECT sku, name INTO v_item_sku, v_item_name
      FROM stock_items WHERE id = NEW.item_id;
    SELECT code INTO v_loc_code
      FROM locations WHERE id = NEW.location_id;
    IF NEW.lot_id IS NOT NULL THEN
      SELECT lot_number INTO v_lot_number
        FROM stock_lots WHERE id = NEW.lot_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_stock_movement: name lookup failed: %', SQLERRM;
  END;

  -- 3. Action label per movement_type.
  v_qty_abs := abs(NEW.qty_delta);
  CASE NEW.movement_type
    WHEN 'receive'         THEN v_action_emoji := U&'\1F4E5'; v_action_label := 'รับเข้า';
    WHEN 'issue'           THEN v_action_emoji := U&'\1F4E4'; v_action_label := 'เบิก';
    WHEN 'adjustment_gain' THEN v_action_emoji := U&'\2795';  v_action_label := 'ปรับยอดเพิ่ม';
    WHEN 'adjustment_loss' THEN v_action_emoji := U&'\2796';  v_action_label := 'ของหาย/ปรับลด';
    WHEN 'borrow'          THEN v_action_emoji := U&'\1F91D'; v_action_label := 'ยืม';
    WHEN 'return'          THEN v_action_emoji := U&'\21A9';  v_action_label := 'คืน';
    WHEN 'transfer_out'    THEN v_action_emoji := U&'\2192';  v_action_label := 'ย้ายออก';
    WHEN 'transfer_in'     THEN v_action_emoji := U&'\2190';  v_action_label := 'ย้ายเข้า';
    ELSE                        v_action_emoji := U&'\2022';  v_action_label := NEW.movement_type::text;
  END CASE;

  -- 4. Compose message.
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

  -- 5. Build payload + post via pg_net — fail-soft.
  v_dedupe_key := 'sm:' || NEW.id::text;   -- unique per row → no dedupe hit
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

COMMENT ON FUNCTION notify_stock_movement_to_tg() IS
  'Phase post-5.1. AFTER INSERT on stock_movements. Posts a one-line Thai '
  'Telegram message per movement via tg-notify → ocr-proxy. Covers every '
  'movement_type (incl. linen laundry actions that ride on stock_movements). '
  'Fail-soft: settings / lookup / pg_net errors emit RAISE WARNING only — '
  'they MUST NOT block the inserting transaction.';

DROP TRIGGER IF EXISTS trg_sm_notify_tg ON stock_movements;
CREATE TRIGGER trg_sm_notify_tg
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION notify_stock_movement_to_tg();

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function present and SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='notify_stock_movement_to_tg';
--    Expected: 1 row, prosecdef = true.
--
-- B) Trigger wired:
--    SELECT tgname, tgenabled FROM pg_trigger WHERE tgname='trg_sm_notify_tg';
--    Expected: 1 row, tgenabled='O'.
--
-- C) End-to-end: from the admin app, do any operation (รับเข้า /
--    เบิก / ย้าย / ปรับยอด …). Expected: a Telegram message arrives in
--    the admin group within ~1 second.
