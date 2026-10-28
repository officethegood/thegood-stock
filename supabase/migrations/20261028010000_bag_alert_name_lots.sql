-- supabase/migrations/20261028010000_bag_alert_name_lots.sql
-- UX fix — the daily bag alert now names WHICH lot is expired / expiring.
--
-- Report (staff question in the Stock-The Good group, 2026-10-28): the 09:00
-- message said "❌ BAG-ALS-001 ALS Bag 1 — มีของหมดอายุ 1 ล็อต" and staff asked
-- "กระเป๋ามีของหมดอายุ นี่ดูตรงไหนครับ" — the message gave a count but not the
-- drug, the lot or the date, so they had to dig through the app to find it.
--
-- Change (message text + payload only; schedule, dedupe key, filter unchanged):
--   run_bag_status_alert(): under each ❌ (expired) and ⏳ (expiring) bag line,
--   list the actual lots IN that bag — drug name, lot number, expiry date, qty —
--   from v_bag_lot_contents (20261015020000, ledger qty inside the bag's
--   subtree). Up to 5 lots per bag (the header line still carries the full
--   count). Example:
--     ❌ BAG-ALS-001 ALS Bag 1 — มีของหมดอายุ 1 ล็อต
--        – 50% Glucose (Dextrose) Injection 50mL ล็อต 091546 หมด 01 Oct 2026 (1 ชิ้น)
--   ⚠ (low_stock) lines are unchanged. If a bag is flagged but no matching lot
--   is found inside it, the line degrades to the previous count-only text.
--   The payload gains each bag's location_id (additive).
--
-- LESSON APPLIED: body is a VERBATIM copy of the current latest version
--   (20260715010000_alert_messages_detail.sql) with only the documented delta.
--   run_expiry_alert() is NOT touched.
--
-- Depends on: 20260715010000 (body copied from here), 20261015020000
--   (v_bag_lot_contents). Pairs with 20261026010000 (v_bag_status counts only
--   in-bag lots) so the header count and the listed lots agree — apply that too.
-- Idempotent: CREATE OR REPLACE FUNCTION only (cron job untouched).

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
      'location_id',    vbs.location_id,          -- 20261028010000: for the lot lookup
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
  -- 20261028010000: expired / expiring lines also list the lots inside the bag.
  SELECT string_agg(line, E'\n')
  INTO v_lines
  FROM (
    SELECT CASE e->>'alert_level'
             WHEN 'expired' THEN format(
               E'❌ %s %s — มีของหมดอายุ %s ล็อต',
               e->>'bag_code', COALESCE(e->>'bag_name', ''),
               COALESCE(e->>'expired_lots', '?'))
               || COALESCE(E'\n' || (
                    SELECT string_agg(
                             format(E'   – %s ล็อต %s หมด %s (%s %s)',
                                    d.name, d.lot_number,
                                    to_char(d.expiry_date, 'DD Mon YYYY'),
                                    d.qty_in_bag, COALESCE(d.unit, 'ชิ้น')),
                             E'\n' ORDER BY d.expiry_date, d.name)
                    FROM (
                      SELECT v.name, v.lot_number, v.expiry_date, v.qty_in_bag, si.unit
                      FROM   v_bag_lot_contents v
                      JOIN   stock_items si ON si.id = v.item_id
                      WHERE  v.bag_location_id = (e->>'location_id')::uuid
                        AND  v.expiry_date < v_today
                        AND  v.status IN ('active', 'expired')
                      ORDER  BY v.expiry_date, v.name
                      LIMIT  5
                    ) d
                  ), '')
             WHEN 'expiring' THEN format(
               E'⏳ %s %s — ของใกล้หมดอายุ (ใกล้สุด %s)',
               e->>'bag_code', COALESCE(e->>'bag_name', ''),
               COALESCE(to_char((e->>'nearest_expiry')::date, 'DD Mon YYYY'), '?'))
               || COALESCE(E'\n' || (
                    SELECT string_agg(
                             format(E'   – %s ล็อต %s หมด %s (%s %s)',
                                    d.name, d.lot_number,
                                    to_char(d.expiry_date, 'DD Mon YYYY'),
                                    d.qty_in_bag, COALESCE(d.unit, 'ชิ้น')),
                             E'\n' ORDER BY d.expiry_date, d.name)
                    FROM (
                      SELECT v.name, v.lot_number, v.expiry_date, v.qty_in_bag, si.unit
                      FROM   v_bag_lot_contents v
                      JOIN   stock_items si ON si.id = v.item_id
                      WHERE  v.bag_location_id = (e->>'location_id')::uuid
                        AND  v.expiry_date >= v_today
                        AND  v.expiry_date <= v_today + 30
                        AND  v.status IN ('active', 'expired')
                      ORDER  BY v.expiry_date, v.name
                      LIMIT  5
                    ) d
                  ), '')
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
  'and posts ONE grouped Telegram message, one line per bag with its reason '
  '(max 10 bags, 20260715010000). 20261028010000: expired/expiring bags also list '
  'the lots inside them (drug, lot, expiry, qty — max 5 per bag) from '
  'v_bag_lot_contents, so staff know exactly what to pull. '
  'Reads NOTIFY_* from settings table (NOT current_setting). '
  'Dedupe key: bag_alert:YYYY-MM-DD (one alert per calendar day).';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function replaced, SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'run_bag_status_alert';
--    -- Expected: 1 row, prosecdef = true
--
-- B) Preview tomorrow's lot lines WITHOUT sending anything — what each flagged
--    bag will list:
--    SELECT b.code AS bag_code, v.name, v.lot_number, v.expiry_date, v.qty_in_bag
--    FROM v_bag_lot_contents v JOIN locations b ON b.id = v.bag_location_id
--    WHERE v.expiry_date <= CURRENT_DATE + 30 AND v.status IN ('active','expired')
--    ORDER BY b.code, v.expiry_date;
--
-- C) The real message arrives with the next 09:00 cron (today's dedupe key is
--    already used, so a manual SELECT run_bag_status_alert() today is dropped
--    by tg-notify dedupe).
