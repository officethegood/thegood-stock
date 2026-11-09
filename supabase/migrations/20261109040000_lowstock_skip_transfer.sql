-- 20261109040000_lowstock_skip_transfer.sql
-- Moving stock no longer sends a false "ของใกล้หมด" Telegram alert (review 2026-11-08, #13).
--
-- transfer_stock writes transfer_out then transfer_in. check_low_stock (AFTER INSERT) ran on
-- the transfer_out row while the destination had not been credited yet, so the item total
-- looked short by the moved qty. The alert is deduped per item per Bangkok day, so the false
-- alert also blocked the real one later that day. Bag restock now moves stock with transfers
-- (20261109050000), which would have made this fire on every restock.
--
-- Body is the LATEST (and only) version, 20260518010500, plus the transfer_out skip.
-- The trigger trg_sm_lowstock is unchanged. Idempotent. Ends with go/no-go SELECT.

CREATE OR REPLACE FUNCTION check_low_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
DECLARE
  v_total     int;
  v_threshold int;
  v_sku       text;
  v_name      text;
  v_dedupe    text;
  v_msg       text;
  v_payload   jsonb;
  v_url       text;
  v_srk       text;
BEGIN
  -- Only fire on outgoing movements (negative qty_delta).
  IF NEW.qty_delta >= 0 THEN
    RETURN NEW;
  END IF;

  -- 20261109040000: a transfer does not change the item's total, and the transfer_out row
  -- fires before its transfer_in, so the total read here is short by the moved qty. That
  -- sent false "ของใกล้หมด" alerts and, through the per-day dedupe, swallowed the real one.
  IF NEW.movement_type = 'transfer_out' THEN
    RETURN NEW;
  END IF;

  SELECT sku, name, reorder_threshold
    INTO v_sku, v_name, v_threshold
  FROM stock_items
  WHERE id = NEW.item_id;

  -- Alert disabled for this item (threshold=0 sentinel).
  IF v_threshold IS NULL OR v_threshold <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(qty), 0)
    INTO v_total
  FROM stock_item_locations
  WHERE item_id = NEW.item_id;

  -- Still above threshold — no alert.
  IF v_total > v_threshold THEN
    RETURN NEW;
  END IF;

  -- Read tg-notify endpoint + key from Phase 0 settings table. The settings
  -- table has RLS; SECURITY DEFINER on this function lets us bypass it.
  SELECT value INTO v_url FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

  -- Skip the net call entirely if not configured. Avoids noisy errors during
  -- local SQL-editor smoke tests; tg-notify caller is the source of truth
  -- for dedupe and Telegram delivery.
  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING 'check_low_stock: settings NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set; skipping pg_net call for sku=%', v_sku;
    RETURN NEW;
  END IF;

  -- Q-Phase1-O: dedupe key in Asia/Bangkok local date.
  v_dedupe := 'low_stock:' || v_sku || ':' || to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');
  v_msg    := format('⚠️ ของใกล้หมด: %s (%s) คงเหลือรวม %s จากเกณฑ์ %s',
                     v_name, v_sku, v_total, v_threshold);
  v_payload := jsonb_build_object(
    'item_id',          NEW.item_id,
    'sku',              v_sku,
    'name',             v_name,
    'total_qty',        v_total,
    'threshold',        v_threshold,
    'last_movement_id', NEW.id,
    'location_id',      NEW.location_id
  );

  PERFORM net.http_post(
    url     := v_url || '/functions/v1/tg-notify',
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'apikey',        v_srk,
      'authorization', 'Bearer ' || v_srk,
      'X-Internal',    'true'
    ),
    body    := jsonb_build_object(
      'event_type',  'low_stock',
      'entity_type', 'stock_item',
      'entity_id',   NEW.item_id::text,
      'dedupe_key',  v_dedupe,
      'message',     v_msg,
      'payload',     v_payload
    )
  );
  RETURN NEW;
END;
$$;

-- Go/no-go: skips_transfer = true.
SELECT proname, prosecdef AS security_definer,
       position('transfer_out' IN prosrc) > 0 AS skips_transfer
FROM pg_proc WHERE proname = 'check_low_stock';
