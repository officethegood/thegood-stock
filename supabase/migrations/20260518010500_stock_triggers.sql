-- supabase/migrations/20260518010500_stock_triggers.sql
-- Phase 1 — stock_movements triggers. Spec §5.5.1, §5.5.2, §5.5.3.
-- Q-Phase1-I (no new Edge Function), Q-Phase1-O (Asia/Bangkok dedupe key),
-- Q-Phase1-H (24h dedupe enforced inside tg-notify against notification_log).
--
-- Three triggers, all on stock_movements:
--   1) trg_sm_sign       BEFORE INSERT   — enforce qty_delta sign matches movement_type
--   2) trg_sm_apply      AFTER  INSERT   — upsert stock_item_locations + write qty_after
--   3) trg_sm_lowstock   AFTER  INSERT   — if total qty <= reorder_threshold, POST to tg-notify
--
-- apply / lowstock are SECURITY DEFINER so they can write stock_item_locations
-- (which has no client write policy) and read the service-role key from
-- the Phase 0 `settings` table. Owner is the migration applier (postgres in
-- Supabase), which bypasses RLS on stock_item_locations and stock_movements.
--
-- DEPLOY NOTE (2026-05-18 deviation): Original spec used `current_setting('app.*')`
-- with ALTER DATABASE to seed the GUC. Supabase pg-meta and the dashboard postgres
-- role both lack permission to ALTER DATABASE/ROLE for the `app.*` namespace
-- (ERROR 42501). We therefore read NOTIFY_SUPABASE_URL and NOTIFY_SERVICE_ROLE_KEY
-- from the Phase 0 `settings` table instead — same end-to-end behaviour, no
-- superuser dependency. Settings rows are seeded by 20260518010700 below.

-- ---------------------------------------------------------------------------
-- 1) BEFORE INSERT — enforce qty_delta sign matches movement_type (§5.5.1)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_movement_sign() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.movement_type IN ('receive','adjustment_gain','return','transfer_in')
     AND NEW.qty_delta <= 0 THEN
    RAISE EXCEPTION 'qty_delta must be positive for %', NEW.movement_type;
  ELSIF NEW.movement_type IN ('issue','adjustment_loss','borrow','transfer_out')
        AND NEW.qty_delta >= 0 THEN
    RAISE EXCEPTION 'qty_delta must be negative for %', NEW.movement_type;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_movement_sign()
  IS 'Phase 1 BEFORE INSERT guard. Ensures qty_delta sign matches movement_type semantics.';

DROP TRIGGER IF EXISTS trg_sm_sign ON stock_movements;
CREATE TRIGGER trg_sm_sign BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_movement_sign();

-- ---------------------------------------------------------------------------
-- 2) AFTER INSERT — apply movement to stock_item_locations + snapshot qty_after (§5.5.2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_movement_to_sil() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_qty int;
BEGIN
  -- Upsert (item, location) qty. On first movement for a pair, GREATEST(0,delta)
  -- handles the seed case (a receive of 5 → new row with qty=5; a negative delta
  -- against a missing row would seed qty=0 and then be caught by the
  -- "would drive qty negative" guard below after the UPDATE branch isn't taken).
  INSERT INTO stock_item_locations(item_id, location_id, qty, last_movement_at)
  VALUES (NEW.item_id, NEW.location_id, GREATEST(0, NEW.qty_delta), NEW.performed_at)
  ON CONFLICT (item_id, location_id) DO UPDATE
    SET qty              = stock_item_locations.qty + NEW.qty_delta,
        last_movement_at = NEW.performed_at
  RETURNING qty INTO v_new_qty;

  -- Belt-and-braces: also guards the "no existing row + negative delta" path,
  -- because then the INSERT branch fires with GREATEST(0, negative)=0 and we'd
  -- return 0. Reject explicitly if delta was negative and no row existed.
  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'movement would drive qty negative for item % at location %',
      NEW.item_id, NEW.location_id;
  END IF;

  IF v_new_qty = 0 AND NEW.qty_delta < 0 THEN
    -- The INSERT branch ran (no existing pair) with a negative delta. Reject.
    -- The INSERT above will have created a phantom (qty=0) row; clean it up.
    DELETE FROM stock_item_locations
      WHERE item_id = NEW.item_id AND location_id = NEW.location_id AND qty = 0;
    RAISE EXCEPTION 'movement would drive qty negative for item % at location % (no existing stock)',
      NEW.item_id, NEW.location_id;
  END IF;

  UPDATE stock_movements SET qty_after = v_new_qty WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION apply_movement_to_sil()
  IS 'Phase 1 AFTER INSERT. Upserts stock_item_locations qty and writes qty_after snapshot. SECURITY DEFINER to bypass sil RLS.';

DROP TRIGGER IF EXISTS trg_sm_apply ON stock_movements;
CREATE TRIGGER trg_sm_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_sil();

-- ---------------------------------------------------------------------------
-- 3) AFTER INSERT — low-stock check on negative deltas only (§5.5.3)
--     - Uses pg_net to POST tg-notify; tg-notify enforces 24h dedupe via
--       notification_log (Q-Phase1-H, reusing Phase 0 LOW_STOCK_DEDUPE_HOURS).
--     - Dedupe key timezone is Asia/Bangkok (Q-Phase1-O).
-- ---------------------------------------------------------------------------
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

COMMENT ON FUNCTION check_low_stock()
  IS 'Phase 1 AFTER INSERT. On negative qty_delta, if SUM(qty) <= reorder_threshold, POST low_stock event to tg-notify via pg_net. Dedupe enforced downstream against notification_log within LOW_STOCK_DEDUPE_HOURS.';

DROP TRIGGER IF EXISTS trg_sm_lowstock ON stock_movements;
CREATE TRIGGER trg_sm_lowstock AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_low_stock();

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Three triggers wired on stock_movements:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid='stock_movements'::regclass AND NOT tgisinternal
--    ORDER BY tgname;
--    -- expected: trg_sm_apply, trg_sm_lowstock, trg_sm_sign
--
-- 2) Trigger functions exist and SECURITY DEFINER where required:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('enforce_movement_sign','apply_movement_to_sil','check_low_stock')
--    ORDER BY proname;
--    -- expected:
--    --   apply_movement_to_sil   | true
--    --   check_low_stock         | true
--    --   enforce_movement_sign   | false
--
-- 3) Sign-mismatch rejected (negative delta on 'receive'):
--    INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
--    SELECT (SELECT id FROM stock_items LIMIT 1),
--           (SELECT id FROM locations  LIMIT 1),
--           'receive', -1;
--    -- expected: ERROR qty_delta must be positive for receive
--
-- 4) pg_net extension present (Phase 0 installed):
--    SELECT extname FROM pg_extension WHERE extname='pg_net';
--    -- expected: 1 row
--
-- 5) Settings rows present (seeded by 20260518010700_notify_settings.sql):
--    SELECT key, length(value) AS len FROM settings
--    WHERE key IN ('NOTIFY_SUPABASE_URL','NOTIFY_SERVICE_ROLE_KEY');
--    -- expected: 2 rows. Missing rows means trigger will WARN-and-skip the pg_net call.
