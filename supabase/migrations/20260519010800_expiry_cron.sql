-- supabase/migrations/20260519010800_expiry_cron.sql
-- Phase 2 — Daily expiry auto-expire + 30/60/90-day Telegram alert.
--
-- Decisions-locked:
--   Q-Phase2-3  — always-on auto-expire at 09:00 Asia/Bangkok (02:00 UTC)
--   derived #7  — Two-pass: Pass A auto-expire, Pass B per-bucket tg-notify alert
--   derived #8  — MUST read NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY from
--                 `settings` table (NOT current_setting('app.*'))
--                 Project.md §8 gotcha 9: ALTER DATABASE for app.* namespace is
--                 blocked on Supabase Free/Nano (ERROR 42501 on postgres role).
--
-- Assumed extensions: pg_net (Phase 0), pg_cron (must check PF-7 before deploy).
-- Assumed secrets: NOTIFY_SUPABASE_URL, NOTIFY_SERVICE_ROLE_KEY in settings table.
-- Assumed settings key: EXPIRY_ALERT_DAYS (seeded below, default '30,60,90').
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEPLOY DECISION (operator must choose before running this file):
--
--   PATH A — pg_cron (preferred):
--     Pre-condition PF-7 must pass:
--       SELECT extname FROM pg_available_extensions WHERE name='pg_cron';
--       -- Expected: 1 row
--     If pg_cron IS available: run this entire file as-is.
--     The pg_cron path is active by default (uncommented).
--
--   PATH B — Cloudflare Worker fallback:
--     If pg_cron is NOT available (PF-7 returns 0 rows):
--     1. Run only the SETTINGS SEED and FUNCTION sections of this file
--        (comment out the pg_cron section at the bottom).
--     2. Deploy the Edge Function and configure the Cloudflare Worker cron
--        as documented in the FALLBACK PATH section at the end of this file.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- ==========================================================================
-- SECTION 1: Seed EXPIRY_ALERT_DAYS setting (always run, both paths)
-- ==========================================================================

INSERT INTO settings(key, value)
VALUES ('EXPIRY_ALERT_DAYS', '30,60,90')
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN settings.key IS
  'Phase 0+1+2 KV. Phase 2 added EXPIRY_ALERT_DAYS (default 30,60,90 day buckets).';

-- ==========================================================================
-- SECTION 2: run_expiry_alert() function (always run, both paths)
--
-- Two-pass logic:
--   Pass A: UPDATE stock_lots SET status='expired' (Q-Phase2-3)
--   Pass B: Per-bucket POST to tg-notify via pg_net
--
-- Settings read pattern: SELECT value FROM settings WHERE key='...'
-- NOT current_setting('app.*') — Project.md §8 gotcha 9.
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
  v_bucket_lots jsonb;
  v_msg         text;
  v_dedupe      text;
  v_today       date := CURRENT_DATE;
BEGIN
  -- ─────────────────────────────────────────────────────────────────────
  -- Read notify credentials from settings table.
  -- MUST use settings table — NOT current_setting('app.*').
  -- Project.md §8 gotcha 9: ALTER DATABASE for app.* blocked on Free/Nano.
  -- ─────────────────────────────────────────────────────────────────────
  SELECT value INTO v_url FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

  -- ─────────────────────────────────────────────────────────────────────
  -- Pass A: Auto-expire stale lots BEFORE the alert query.
  -- Running auto-expire first ensures the alert never counts a just-expired
  -- lot as still active in the 30/60/90-day buckets.
  -- Q-Phase2-3: always-on; no Admin confirmation required.
  -- ─────────────────────────────────────────────────────────────────────
  UPDATE stock_lots
    SET status     = 'expired',
        updated_at = now()
  WHERE expiry_date < v_today
    AND status      = 'active';

  -- ─────────────────────────────────────────────────────────────────────
  -- Guard: skip pg_net calls if notify credentials are not configured.
  -- Avoids noisy pg_net errors in fresh deployments (values may be blank).
  -- ─────────────────────────────────────────────────────────────────────
  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING
      'run_expiry_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in settings table. '
      'Auto-expire (Pass A) ran successfully. Alert notifications (Pass B) skipped.';
    RETURN;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────
  -- Parse EXPIRY_ALERT_DAYS setting into integer array.
  -- Default '30,60,90' if setting is missing or blank.
  -- ─────────────────────────────────────────────────────────────────────
  SELECT value INTO v_days_raw FROM settings WHERE key = 'EXPIRY_ALERT_DAYS';
  IF v_days_raw IS NULL OR v_days_raw = '' THEN
    v_days_raw := '30,60,90';
  END IF;

  SELECT ARRAY(
    SELECT trim(t)::int
    FROM unnest(string_to_array(v_days_raw, ',')) AS t(t)
    WHERE trim(t) ~ '^[0-9]+$'
  ) INTO v_thresholds;

  -- ─────────────────────────────────────────────────────────────────────
  -- Pass B: Per-bucket alert.
  -- One pg_net POST per threshold bucket, deduplicated per-day per-bucket.
  -- Dedupe key pattern: 'expiry:<days>:<YYYY-MM-DD>' (Bangkok local date).
  -- Same pattern as Phase 1 'low_stock:<sku>:<date>' (Q-Phase1-O).
  -- ─────────────────────────────────────────────────────────────────────
  FOREACH v_threshold IN ARRAY v_thresholds LOOP

    -- Aggregate lots expiring within [today, today + v_threshold] days.
    -- Lots expiring exactly today are already expired (Pass A ran first).
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
      AND sl.current_qty  > 0;

    -- Skip bucket when no qualifying lots.
    IF v_bucket_lots IS NULL OR jsonb_array_length(v_bucket_lots) = 0 THEN
      CONTINUE;
    END IF;

    v_msg := format(
      E'⏳ แจ้เตือนวันหมดอายุ (ภายใน %s วัน) — มี %s รายการ',
      v_threshold,
      jsonb_array_length(v_bucket_lots)
    );

    -- Dedupe key: one alert per bucket per Bangkok calendar day.
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

  END LOOP;

END;
$run_expiry_alert$;

COMMENT ON FUNCTION run_expiry_alert() IS
  'Phase 2 daily cron / Edge Function RPC. '
  'Pass A: auto-expires stock_lots where expiry_date < CURRENT_DATE and status=active (Q-Phase2-3). '
  'Pass B: posts one tg-notify alert per EXPIRY_ALERT_DAYS bucket (default 30,60,90). '
  'Reads NOTIFY_SUPABASE_URL and NOTIFY_SERVICE_ROLE_KEY from settings table '
  '(NOT current_setting — Project.md §8 gotcha 9).';

-- ==========================================================================
-- SECTION 3: pg_cron schedule (PATH A — run only if pg_cron is available)
--
-- Pre-condition: PF-7 must pass before running this section.
-- Schedule: 02:00 UTC = 09:00 Asia/Bangkok (UTC+7).
-- ==========================================================================

-- Enable pg_cron extension (idempotent; harmless if already enabled).
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule existing job with same name before re-scheduling (idempotent).
-- cron.unschedule() raises if job does not exist, so guard with EXISTS check.
DO $pg_cron_unschedule$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'expiry_alert_daily'
  ) THEN
    PERFORM cron.unschedule('expiry_alert_daily');
  END IF;
END
$pg_cron_unschedule$;

SELECT cron.schedule(
  'expiry_alert_daily',
  '0 2 * * *',
  $cron_body$SELECT run_expiry_alert()$cron_body$
);

-- ==========================================================================
-- SECTION 4: Cloudflare Worker fallback path (PATH B)
-- Run ONLY if pg_cron is unavailable (PF-7 returned 0 rows).
-- All SQL in this section is COMMENTED OUT.
-- Steps are documented for the deploy operator.
-- ==========================================================================
--
-- PATH B DEPLOY STEPS (operator action — skip if pg_cron is available):
--
-- Step CF-1: Run SECTIONS 1 + 2 only from this file (comment out SECTION 3).
--            run_expiry_alert() DB function handles both auto-expire and alert logic.
--
-- Step CF-2: Deploy Edge Function 'expiry-alert-daily' in Supabase Dashboard.
--            Navigate to: Edge Functions → New Function → name: expiry-alert-daily
--            Paste the following TypeScript (single file, inline imports, no import_map):
--
--   ──────────────────────────────────────────────────────────────────────────
--   // supabase/functions/expiry-alert-daily/index.ts
--   // Phase 2 fallback — Cloudflare Worker cron calls this when pg_cron is
--   // unavailable. Invokes run_expiry_alert() DB function via service_role RPC.
--   // Auth: service_role key in Authorization + apikey headers (Phase 1 pattern).
--
--   import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
--
--   const corsHeaders = {
--     'Access-Control-Allow-Origin': '*',
--     'Access-Control-Allow-Headers':
--       'authorization, x-client-info, apikey, content-type, x-internal',
--   };
--
--   Deno.serve(async (req: Request) => {
--     if (req.method === 'OPTIONS') {
--       return new Response('ok', { headers: corsHeaders });
--     }
--
--     const authHeader  = req.headers.get('Authorization') ?? '';
--     const srk         = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
--     const isInternal  = req.headers.get('X-Internal') === 'true';
--
--     if (!isInternal || !authHeader.includes(srk)) {
--       return new Response(JSON.stringify({ error: 'Unauthorized' }), {
--         status: 401,
--         headers: { ...corsHeaders, 'Content-Type': 'application/json' },
--       });
--     }
--
--     const client = createClient(Deno.env.get('SUPABASE_URL') ?? '', srk);
--     const { data, error } = await client.rpc('run_expiry_alert');
--
--     if (error) {
--       console.error('run_expiry_alert RPC error:', error);
--       return new Response(JSON.stringify({ ok: false, error: error.message }), {
--         status: 500,
--         headers: { ...corsHeaders, 'Content-Type': 'application/json' },
--       });
--     }
--
--     return new Response(JSON.stringify({ ok: true, data }), {
--       headers: { ...corsHeaders, 'Content-Type': 'application/json' },
--     });
--   });
--   ──────────────────────────────────────────────────────────────────────────
--
-- Step CF-3: In Edge Function settings, DISABLE "Verify JWT with legacy secret"
--            (same pattern as Phase 0 auth-bridge).
--
-- Step CF-4: In Cloudflare Worker 'thegood-ocr-proxy', add cron trigger:
--   Schedule: 0 2 * * *  (02:00 UTC = 09:00 Bangkok)
--   Worker code: POST to https://xtjsjrfixngfdkaahton.supabase.co/functions/v1/expiry-alert-daily
--   Headers: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
--            apikey: <SUPABASE_SERVICE_ROLE_KEY>
--            X-Internal: true
--            Content-Type: application/json
--   Body: {}
--   Store SUPABASE_SERVICE_ROLE_KEY as a Cloudflare Worker secret (not in code).
--
-- Step CF-5: Verify fallback:
--   curl -X POST \
--     "https://xtjsjrfixngfdkaahton.supabase.co/functions/v1/expiry-alert-daily" \
--     -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
--     -H "apikey: <SERVICE_ROLE_KEY>" \
--     -H "X-Internal: true" \
--     -H "Content-Type: application/json" \
--     -d '{}'
--   Expected: {"ok":true,"data":null}
--
-- PM decision note: pg_cron path is preferred (same DB, no extra network hop,
-- no additional Edge Function to maintain). Cloudflare Worker path adds operational
-- complexity. Default to pg_cron if PF-7 passes.

-- ============================================================
-- Verification SQL (run after deploying PATH A or PATH B)
-- ============================================================
-- 1) EXPIRY_ALERT_DAYS setting seeded:
--    SELECT key, value FROM settings WHERE key = 'EXPIRY_ALERT_DAYS';
--    -- Expected: 1 row, value='30,60,90'
--
-- 2) run_expiry_alert function present:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'run_expiry_alert';
--    -- Expected: 1 row, prosecdef=true (SECURITY DEFINER)
--
-- 3) [PATH A only] pg_cron extension and job:
--    SELECT extname FROM pg_extension WHERE extname = 'pg_cron';
--    -- Expected: 1 row
--
--    SELECT jobname, schedule, command
--    FROM cron.job
--    WHERE jobname = 'expiry_alert_daily';
--    -- Expected: 1 row, schedule='0 2 * * *', command='SELECT run_expiry_alert()'
--
-- 4) Smoke run (manual trigger — works for both PATH A and PATH B DB function):
--    SELECT run_expiry_alert();
--    -- Expected: no exception.
--    -- If NOTIFY settings are blank: WARNING in logs, no error.
--    -- If NOTIFY settings are populated: notification_log rows appear.
--
-- 5) After smoke run — confirm auto-expire ran (if any test lots with past expiry):
--    SELECT lot_number, expiry_date, status
--    FROM stock_lots
--    WHERE expiry_date < CURRENT_DATE
--    ORDER BY expiry_date;
--    -- Expected: all rows have status='expired'
--
-- 6) After smoke run — notification_log entries (if NOTIFY settings populated):
--    SELECT dedupe_key, event_type, success, created_at
--    FROM notification_log
--    WHERE event_type = 'expiry'
--    ORDER BY created_at DESC
--    LIMIT 5;
