-- supabase/migrations/20260715010000_alert_messages_detail.sql
-- UX fix — daily Telegram alerts now NAME the items/bags instead of a bare count.
--
-- Report (Chittawan 2026-07-14/15): received "🩺 สถานะถุงยา … มี 1 ถุงที่ต้อง
-- ตรวจสอบ" and "⏳ แจ้เตือนวันหมดอายุ (ภายใน 90 วัน) — มี 2 รายการ" and asked
-- อันนี้คือรายการอะไร — the messages carried only counts; the per-item detail
-- was buried in the JSON payload which Telegram never displays.
--
-- Changes (message text only + one bucket-logic fix; schedules/dedupe keys
-- unchanged):
--   1) run_bag_status_alert(): message lists each bag on its own line with the
--      reason — ❌ มีของหมดอายุ N ล็อต / ⏳ ของใกล้หมดอายุ (ใกล้สุด <date>) /
--      ⚠ ของไม่ครบ ขาด N รายการบังคับ. Capped at 10 lines + "…และอีก N ใบ".
--   2) run_expiry_alert(): message lists each lot — item, lot, expiry, qty.
--      Capped at 10 lines + "…และอีก N รายการ". Fixes the "แจ้เตือน" typo.
--   3) run_expiry_alert() buckets are now EXCLUSIVE ranges (0–30, 31–60,
--      61–90) instead of cumulative — previously a lot expiring in 20 days was
--      counted in ALL THREE daily messages (30, 60, and 90), which is why the
--      90-day message double-reported items already alerted at 30 days.
--
-- LESSON APPLIED: both function bodies are verbatim copies of the CURRENT
-- latest versions (20260519040500 / 20260519010800 — each has only one prior
-- version) with only the documented changes. Do not rebuild from older files.
--
-- Depends on: 20260519040500_bag_alert_cron.sql, 20260519010800_expiry_cron.sql
-- Idempotent: CREATE OR REPLACE FUNCTION only (cron jobs untouched).

-- ==========================================================================
-- 1) run_bag_status_alert — per-bag lines in the Telegram message
-- ==========================================================================

CREATE OR REPLACE FUNCTION run_bag_status_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $run_bag_status_alert$
DECLARE
  v_url       text;
  v_srk       text;
  v_enabled   text;
  v_msg       text;
  v_lines     text;
  v_total     int;
  v_dedupe    text;
  v_bags      jsonb;
  v_today     date := CURRENT_DATE;
BEGIN
  SELECT value INTO v_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk     FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT value INTO v_enabled FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';

  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING
      'run_bag_status_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in '
      'settings table. Telegram alert skipped.';
    RETURN;
  END IF;

  IF v_enabled IS NOT NULL AND v_enabled = 'false' THEN
    RETURN;
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'bag_code',       vbs.bag_code,
      'bag_name',       vbs.bag_name,
      'alert_level',    vbs.alert_level,
      'completion_pct', vbs.completion_pct,
      'deficit_count',  vbs.mandatory_deficit_count,
      'nearest_expiry', vbs.nearest_expiry,
      'expired_lots',   vbs.expired_lots_count,
      'expiring_30d',   vbs.expiring_30d_count
    )
    ORDER BY
      CASE vbs.alert_level
        WHEN 'expired'   THEN 1
        WHEN 'expiring'  THEN 2
        WHEN 'low_stock' THEN 3
        ELSE                  4
      END,
      vbs.bag_code
  )
  INTO v_bags
  FROM v_bag_status vbs
  WHERE vbs.alert_level IN ('low_stock', 'expiring', 'expired')
    AND vbs.bag_active  = true;

  IF v_bags IS NULL OR jsonb_array_length(v_bags) = 0 THEN
    RETURN;
  END IF;

  v_total := jsonb_array_length(v_bags);

  -- 20260715010000: one line per bag with the REASON (first 10 bags).
  SELECT string_agg(line, E'\n')
  INTO v_lines
  FROM (
    SELECT CASE e->>'alert_level'
             WHEN 'expired' THEN format(
               E'❌ %s %s — มีของหมดอายุ %s ล็อต',
               e->>'bag_code', COALESCE(e->>'bag_name', ''),
               COALESCE(e->>'expired_lots', '?'))
             WHEN 'expiring' THEN format(
               E'⏳ %s %s — ของใกล้หมดอายุ (ใกล้สุด %s)',
               e->>'bag_code', COALESCE(e->>'bag_name', ''),
               COALESCE(to_char((e->>'nearest_expiry')::date, 'DD Mon YYYY'), '?'))
             ELSE format(
               E'⚠ %s %s — ของไม่ครบ ขาด %s รายการบังคับ (%s%% สมบูรณ์)',
               e->>'bag_code', COALESCE(e->>'bag_name', ''),
               COALESCE(e->>'deficit_count', '?'),
               COALESCE(e->>'completion_pct', '?'))
           END AS line
    FROM jsonb_array_elements(v_bags) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 10
  ) s;

  v_msg := format(
    E'\U0001FA7A สถานะกระเป๋ายา/ชุดปฐมพยาบาล — %s — ต้องตรวจสอบ %s ใบ\n%s',
    to_char(v_today AT TIME ZONE 'Asia/Bangkok', 'DD Mon YYYY'),
    v_total,
    v_lines
  );
  IF v_total > 10 THEN
    v_msg := v_msg || format(E'\n…และอีก %s ใบ (ดูในหน้า คลัง › ALS Bags)', v_total - 10);
  END IF;

  v_dedupe := 'bag_alert:' || to_char(v_today, 'YYYY-MM-DD');

  PERFORM net.http_post(
    url     := v_url || '/functions/v1/tg-notify',
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'apikey',        v_srk,
      'authorization', 'Bearer ' || v_srk,
      'X-Internal',    'true'
    ),
    body    := jsonb_build_object(
      'event_type',  'bag_alert',
      'entity_type', 'bag_location',
      'entity_id',   null,
      'dedupe_key',  v_dedupe,
      'message',     v_msg,
      'payload',     jsonb_build_object(
        'run_date', v_today,
        'bags',     v_bags
      )
    )
  );
END;
$run_bag_status_alert$;

COMMENT ON FUNCTION run_bag_status_alert() IS
  'Phase 4 daily cron (02:00 UTC = 09:00 Asia/Bangkok). '
  'Queries v_bag_status for bags with alert_level IN (low_stock, expiring, expired) '
  'and posts ONE grouped Telegram message. 20260715010000: the message now names '
  'each bag with its reason (max 10 lines) — previously it was a bare count and '
  'staff could not tell which bag needed attention. '
  'Reads NOTIFY_* from settings table (NOT current_setting). '
  'Dedupe key: bag_alert:YYYY-MM-DD (one alert per calendar day).';

-- ==========================================================================
-- 2) run_expiry_alert — per-lot lines + exclusive buckets + typo fix
-- ==========================================================================

CREATE OR REPLACE FUNCTION run_expiry_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $run_expiry_alert$
DECLARE
  v_url         text;
  v_srk         text;
  v_days_raw    text;
  v_thresholds  int[];
  v_threshold   int;
  v_prev        int := 0;
  v_bucket_lots jsonb;
  v_lines       text;
  v_total       int;
  v_label       text;
  v_msg         text;
  v_dedupe      text;
  v_today       date := CURRENT_DATE;
BEGIN
  SELECT value INTO v_url FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

  -- Pass A: Auto-expire stale lots BEFORE the alert query (Q-Phase2-3).
  UPDATE stock_lots
    SET status     = 'expired',
        updated_at = now()
  WHERE expiry_date < v_today
    AND status      = 'active';

  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING
      'run_expiry_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in settings table. '
      'Auto-expire (Pass A) ran successfully. Alert notifications (Pass B) skipped.';
    RETURN;
  END IF;

  SELECT value INTO v_days_raw FROM settings WHERE key = 'EXPIRY_ALERT_DAYS';
  IF v_days_raw IS NULL OR v_days_raw = '' THEN
    v_days_raw := '30,60,90';
  END IF;

  -- Sorted ascending — required for the exclusive-range logic below.
  SELECT ARRAY(
    SELECT trim(t)::int
    FROM unnest(string_to_array(v_days_raw, ',')) AS t(t)
    WHERE trim(t) ~ '^[0-9]+$'
    ORDER BY 1
  ) INTO v_thresholds;

  -- Pass B: one alert per EXCLUSIVE bucket (20260715010000): 0–30, 31–60,
  -- 61–90. Previously buckets were cumulative, so the same lot was counted in
  -- every bucket ≥ its days-left — three near-identical daily messages.
  FOREACH v_threshold IN ARRAY v_thresholds LOOP

    SELECT jsonb_agg(
      jsonb_build_object(
        'lot_id',      sl.id,
        'lot_number',  sl.lot_number,
        'item_name',   si.name,
        'sku',         si.sku,
        'expiry_date', sl.expiry_date,
        'current_qty', sl.current_qty,
        'unit',        si.unit,
        'days_left',   (sl.expiry_date - v_today)
      )
      ORDER BY sl.expiry_date ASC
    )
    INTO v_bucket_lots
    FROM stock_lots sl
    JOIN stock_items si ON si.id = sl.item_id
    WHERE sl.status       = 'active'
      AND sl.expiry_date  >= v_today
      AND sl.expiry_date  <= (v_today + v_threshold)
      AND (v_prev = 0 OR sl.expiry_date > (v_today + v_prev))
      AND sl.current_qty  > 0;

    IF v_bucket_lots IS NULL OR jsonb_array_length(v_bucket_lots) = 0 THEN
      v_prev := v_threshold;
      CONTINUE;
    END IF;

    v_total := jsonb_array_length(v_bucket_lots);
    v_label := CASE WHEN v_prev = 0
                    THEN format('ภายใน %s วัน', v_threshold)
                    ELSE format('%s–%s วัน', v_prev + 1, v_threshold)
               END;

    -- One line per lot (first 10): item, lot, expiry date, remaining qty.
    SELECT string_agg(line, E'\n')
    INTO v_lines
    FROM (
      SELECT format(
        E'• %s ล็อต %s — หมดอายุ %s (เหลือ %s %s)',
        e->>'item_name',
        e->>'lot_number',
        to_char((e->>'expiry_date')::date, 'DD Mon YYYY'),
        e->>'current_qty',
        COALESCE(e->>'unit', 'ชิ้น')
      ) AS line
      FROM jsonb_array_elements(v_bucket_lots) WITH ORDINALITY AS t(e, ord)
      WHERE ord <= 10
    ) s;

    v_msg := format(
      E'⏳ แจ้งเตือนวันหมดอายุ (%s) — %s รายการ\n%s',
      v_label, v_total, v_lines
    );
    IF v_total > 10 THEN
      v_msg := v_msg || format(E'\n…และอีก %s รายการ (ดูในหน้า คลัง › ล็อตยา)', v_total - 10);
    END IF;

    v_dedupe := 'expiry:' || v_threshold || ':' ||
                to_char(v_today AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

    PERFORM net.http_post(
      url     := v_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'content-type',  'application/json',
        'apikey',        v_srk,
        'authorization', 'Bearer ' || v_srk,
        'X-Internal',    'true'
      ),
      body    := jsonb_build_object(
        'event_type',  'expiry',
        'entity_type', 'stock_lot',
        'entity_id',   null,
        'dedupe_key',  v_dedupe,
        'message',     v_msg,
        'payload',     jsonb_build_object(
          'bucket_days', v_threshold,
          'run_date',    v_today,
          'lots',        v_bucket_lots
        )
      )
    );

    v_prev := v_threshold;
  END LOOP;

END;
$run_expiry_alert$;

COMMENT ON FUNCTION run_expiry_alert() IS
  'Phase 2 daily cron. Pass A: auto-expires lots past expiry (Q-Phase2-3). '
  'Pass B: one tg-notify alert per EXPIRY_ALERT_DAYS bucket. 20260715010000: '
  'buckets are exclusive ranges (0-30, 31-60, 61-90 — no double counting), the '
  'message names each lot (max 10 lines), and the แจ้เตือน typo is fixed. '
  'Reads NOTIFY_* from settings table (NOT current_setting).';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Functions replaced, SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('run_bag_status_alert','run_expiry_alert');
--    -- Expected: 2 rows, both prosecdef = true
--
-- B) Manual smoke run (sends real Telegram messages if there are qualifying
--    rows AND today's dedupe keys are unused — run after 09:00 sends nothing
--    new because of dedupe):
--    SELECT run_bag_status_alert();
--    SELECT run_expiry_alert();
--    -- Expected: no exception; Telegram messages now list bag/lot names.
--
-- C) Exclusive buckets sanity — a lot expiring in 20 days must appear in the
--    30-day message ONLY (not 60/90):
--    -- inspect notification_log payloads for today:
--    SELECT dedupe_key, message FROM notification_log
--    WHERE event_type IN ('expiry','bag_alert')
--    ORDER BY created_at DESC LIMIT 5;
