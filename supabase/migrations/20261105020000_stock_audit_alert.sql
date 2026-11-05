-- supabase/migrations/20261105020000_stock_audit_alert.sql
-- Daily stock self-check: tell the group when numbers stop agreeing, instead of
-- waiting for someone on the floor to notice.
--
-- Why: every drift so far (double-apply, lot-less outflows, lots taken across
-- locations) sat unnoticed until a person compared a screen with a shelf, by which
-- time compensating adjustments had made it harder to untangle. The same checks as
-- sql/audit-stock-consistency.sql existed but only ran when someone remembered.
--
-- Adds:
--   v_stock_audit_issues  — one row per problem. 0 rows = every number agrees.
--   run_stock_audit_alert() — posts the list to Telegram via tg-notify. Silent when clean.
--   cron 'stock_audit_daily' — 01:45 UTC = 08:45 Asia/Bangkok.
--
-- Checks (ledger stock_movements is the single source of truth):
--   1 a lot is negative at a location     (guard_lot_at_location now prevents new ones)
--   2 stock_lots.current_qty <> ledger    (non-recalled lots)
--   3 stock_item_locations.qty <> ledger
--   4 a lot-tracked location's qty <> the sum of its lots
--
-- Reads NOTIFY_* from settings like the other crons. Fail-safe: the cron only reads
-- and posts; it never changes stock.
-- Depends on: stock_movements, stock_lots, stock_item_locations, settings, pg_net,
--             pg_cron, tg-notify.
-- Idempotent: CREATE OR REPLACE + cron.unschedule guard.

CREATE OR REPLACE VIEW v_stock_audit_issues AS
WITH loc_lot AS (
  SELECT item_id, location_id, lot_id, SUM(qty_delta) AS net
  FROM   stock_movements
  WHERE  lot_id IS NOT NULL
  GROUP  BY item_id, location_id, lot_id
),
lot_ledger AS (
  SELECT lot_id, SUM(net) AS qty FROM loc_lot GROUP BY lot_id
),
loc_ledger AS (
  SELECT item_id, location_id, SUM(qty_delta) AS qty
  FROM   stock_movements
  GROUP  BY item_id, location_id
),
loc_lot_sum AS (
  SELECT item_id, location_id, SUM(net) AS qty FROM loc_lot GROUP BY item_id, location_id
)
SELECT 1 AS check_no, 'ล็อตติดลบในตำแหน่ง'::text AS issue, si.sku, si.name AS item_name,
       l.code AS location, sl.lot_number, ('ยอด ' || ll.net)::text AS detail
FROM   loc_lot ll
JOIN   stock_items si ON si.id = ll.item_id
JOIN   locations   l  ON l.id  = ll.location_id
JOIN   stock_lots  sl ON sl.id = ll.lot_id
WHERE  ll.net < 0
UNION ALL
SELECT 2, 'ยอดล็อตไม่ตรงประวัติ', si.sku, si.name, NULL, sl.lot_number,
       'ระบบ ' || sl.current_qty || ' / ประวัติ ' || COALESCE(lg.qty, 0)
FROM   stock_lots sl
JOIN   stock_items si ON si.id = sl.item_id
LEFT   JOIN lot_ledger lg ON lg.lot_id = sl.id
WHERE  sl.status <> 'recalled'
  AND  sl.current_qty <> COALESCE(lg.qty, 0)
UNION ALL
SELECT 3, 'ยอดตำแหน่งไม่ตรงประวัติ', si.sku, si.name, l.code, NULL,
       'ระบบ ' || COALESCE(s.qty, 0) || ' / ประวัติ ' || COALESCE(lg.qty, 0)
FROM   loc_ledger lg
FULL   OUTER JOIN stock_item_locations s
       ON s.item_id = lg.item_id AND s.location_id = lg.location_id
JOIN   stock_items si ON si.id = COALESCE(s.item_id, lg.item_id)
JOIN   locations   l  ON l.id  = COALESCE(s.location_id, lg.location_id)
WHERE  COALESCE(s.qty, 0) <> COALESCE(lg.qty, 0)
UNION ALL
SELECT 4, 'ยอดตำแหน่งไม่ตรงผลรวมล็อต', si.sku, si.name, l.code, NULL,
       'ตำแหน่ง ' || s.qty || ' / ล็อตรวม ' || COALESCE(ls.qty, 0)
FROM   stock_item_locations s
JOIN   stock_items si ON si.id = s.item_id AND si.tracks_lots
JOIN   locations   l  ON l.id  = s.location_id
LEFT   JOIN loc_lot_sum ls ON ls.item_id = s.item_id AND ls.location_id = s.location_id
WHERE  s.qty <> COALESCE(ls.qty, 0);

COMMENT ON VIEW v_stock_audit_issues IS
  'One row per stock inconsistency; 0 rows = healthy. Source for the daily '
  'stock_audit_daily Telegram alert. SECURITY INVOKER. 20261105020000.';

CREATE OR REPLACE FUNCTION run_stock_audit_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $run_stock_audit_alert$
DECLARE
  v_url     text;
  v_srk     text;
  v_enabled text;
  v_total   int;
  v_lines   text;
  v_msg     text;
BEGIN
  SELECT value INTO v_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk     FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT value INTO v_enabled FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';

  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING 'run_stock_audit_alert: NOTIFY_* not set in settings. Alert skipped.';
    RETURN;
  END IF;
  IF v_enabled IS NOT NULL AND v_enabled = 'false' THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_total FROM v_stock_audit_issues;
  IF v_total = 0 THEN
    RETURN;
  END IF;

  SELECT string_agg(line, E'\n')
  INTO   v_lines
  FROM (
    SELECT format('• %s: %s%s%s — %s', issue, sku,
                  COALESCE(' @ ' || location, ''),
                  COALESCE(' ล็อต ' || lot_number, ''),
                  detail) AS line
    FROM   v_stock_audit_issues
    ORDER  BY check_no, sku, location, lot_number
    LIMIT  10
  ) s;

  v_msg := format(E'🔍 ตรวจยอดสต็อกประจำวัน — %s — ยอดไม่ตรง %s จุด\n%s',
                  to_char(now() AT TIME ZONE 'Asia/Bangkok', 'DD Mon YYYY'), v_total, v_lines);
  IF v_total > 10 THEN
    v_msg := v_msg || format(E'\n…และอีก %s จุด', v_total - 10);
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/functions/v1/tg-notify',
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'apikey',        v_srk,
      'authorization', 'Bearer ' || v_srk,
      'X-Internal',    'true'
    ),
    body    := jsonb_build_object(
      'event_type',  'stock_audit',
      'entity_type', 'stock',
      'entity_id',   null,
      'dedupe_key',  'stock_audit:' || to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD'),
      'message',     v_msg,
      'payload',     jsonb_build_object('total', v_total)
    )
  );
END;
$run_stock_audit_alert$;

COMMENT ON FUNCTION run_stock_audit_alert() IS
  'Daily cron (01:45 UTC = 08:45 Asia/Bangkok). Posts v_stock_audit_issues to '
  'Telegram via tg-notify, silent when clean. Read-only on stock. 20261105020000.';

DO $cron_stock_audit$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stock_audit_daily') THEN
    PERFORM cron.unschedule('stock_audit_daily');
  END IF;
END
$cron_stock_audit$;

SELECT cron.schedule(
  'stock_audit_daily',
  '45 1 * * *',
  $cron_cmd$SELECT run_stock_audit_alert()$cron_cmd$
);

-- Last statement on purpose: the SQL Editor shows only this result. It lists what
-- the check finds right now. 0 rows = every number agrees.
SELECT check_no, issue, sku, location, lot_number, detail
FROM   v_stock_audit_issues
ORDER  BY check_no, sku, location, lot_number;
