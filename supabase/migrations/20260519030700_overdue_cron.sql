-- supabase/migrations/20260519030700_overdue_cron.sql
-- Phase 3 — run_overdue_alert() function + pg_cron schedule.
--
-- Decisions-locked:
--   Q-Phase3-F  — grouped alert when overdue count > OVERDUE_GROUP_THRESHOLD (default 10)
--   Derived #6  — pg_cron at 02:00 + 10:00 UTC = 09:00 + 17:00 Asia/Bangkok
--   Derived #8  — MUST read NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY from
--                 settings table (NOT current_setting('app.*'))
--                 Project.md §8 gotcha 9: ALTER DATABASE blocked on Supabase Free/Nano.
--
-- Two-pass logic:
--   Pass A: UPDATE stock_loans SET status='overdue' WHERE status='active' AND due_at < now()
--   Pass B: If count of ALL overdue loans > OVERDUE_GROUP_THRESHOLD → one grouped message
--           else → one message per overdue loan
--
-- Dedupe key pattern:
--   Individual: 'overdue_loan:{loan_id}:{YYYY-MM-DD HH24}' (Bangkok local time, hour granularity)
--   Grouped:    'overdue_batch:{YYYY-MM-DD HH24}'
--
-- SECURITY DEFINER: required — pg_cron runs jobs under supabase_admin role, which cannot
-- read settings or call net.http_post without elevated privilege.
--
-- Idempotent:
--   CREATE OR REPLACE FUNCTION — always safe to re-run.
--   pg_cron schedule: DO block unschedules existing job before creating.

-- ==========================================================================
-- SECTION 1: run_overdue_alert() function
-- ==========================================================================

CREATE OR REPLACE FUNCTION run_overdue_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $run_overdue_alert$
DECLARE
  v_url        text;
  v_srk        text;
  v_enabled    text;
  v_threshold  int  := 10;
  v_thresh_raw text;
  v_count      int  := 0;
  v_dedupe     text;
  v_msg        text;
  v_payload    jsonb;
  v_loan       record;
BEGIN
  -- ─────────────────────────────────────────────────────────────────────
  -- Read notify credentials from settings table.
  -- MUST use settings table — NOT current_setting('app.*').
  -- Project.md §8 gotcha 9: ALTER DATABASE for app.* blocked on Free/Nano.
  -- ─────────────────────────────────────────────────────────────────────
  SELECT value INTO v_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk     FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT value INTO v_enabled FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';

  -- Read configurable grouping threshold (Q-Phase3-F default 10).
  SELECT value INTO v_thresh_raw FROM settings WHERE key = 'OVERDUE_GROUP_THRESHOLD';
  IF v_thresh_raw IS NOT NULL AND v_thresh_raw ~ '^[0-9]+$' THEN
    v_threshold := v_thresh_raw::int;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────
  -- Pass A: Mark newly overdue loans.
  -- Runs regardless of notification settings so state stays accurate.
  -- ─────────────────────────────────────────────────────────────────────
  UPDATE stock_loans
  SET status     = 'overdue',
      updated_by = 'system:cron'
  WHERE status = 'active'
    AND due_at  < now();

  -- ─────────────────────────────────────────────────────────────────────
  -- Guard: skip pg_net calls if notify credentials not configured.
  -- ─────────────────────────────────────────────────────────────────────
  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING
      'run_overdue_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in settings. '
      'Pass A (overdue status update) ran. Telegram alerts skipped.';
    RETURN;
  END IF;

  -- Guard: skip if Telegram explicitly disabled.
  IF v_enabled IS NOT NULL AND v_enabled = 'false' THEN
    RETURN;
  END IF;

  -- ─────────────────────────────────────────────────────────────────────
  -- Pass B: Count all currently overdue loans (including those just marked).
  -- ─────────────────────────────────────────────────────────────────────
  SELECT count(*) INTO v_count
  FROM stock_loans
  WHERE status = 'overdue';

  IF v_count = 0 THEN
    RETURN;  -- nothing to alert
  END IF;

  -- ─────────────────────────────────────────────────────────────────────
  -- Q-Phase3-F: Grouped vs individual message.
  -- ─────────────────────────────────────────────────────────────────────
  IF v_count > v_threshold THEN
    -- Grouped summary — one message for all overdue loans this run.
    v_dedupe := 'overdue_batch:' ||
                to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24');
    v_msg    := format(
      E'⚠️ มีอุปกรณ์เลยกำหนดคืน %s รายการ กรุณาตรวจสอบแท็บอุปกรณ์ยืม-คืน',
      v_count
    );
    v_payload := jsonb_build_object(
      'event_type',    'overdue_batch',
      'overdue_count',  v_count,
      'threshold',      v_threshold,
      'checked_at',     now()
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
        'event_type',  'overdue_batch',
        'entity_type', 'stock_loans',
        'entity_id',   'batch',
        'dedupe_key',  v_dedupe,
        'message',     v_msg,
        'payload',     v_payload
      )
    );

  ELSE
    -- Individual alert per overdue loan.
    FOR v_loan IN
      SELECT sl.id,
             sl.borrower_username,
             sl.due_at,
             sl.qty,
             si.name AS item_name,
             si.sku
      FROM stock_loans sl
      JOIN stock_items si ON si.id = sl.item_id
      WHERE sl.status = 'overdue'
      ORDER BY sl.due_at ASC
    LOOP
      -- Dedupe key: one alert per loan per Bangkok calendar hour.
      v_dedupe := 'overdue_loan:' || v_loan.id::text || ':' ||
                  to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24');

      v_msg := format(
        E'⚠️ เลยกำหนดคืน: %s (%s) จำนวน %s — ยืมโดย %s — ครบกำหนด %s',
        v_loan.item_name,
        v_loan.sku,
        v_loan.qty,
        v_loan.borrower_username,
        to_char(v_loan.due_at AT TIME ZONE 'Asia/Bangkok', 'DD Mon YYYY HH24:MI')
      );

      v_payload := jsonb_build_object(
        'loan_id',           v_loan.id,
        'item_name',         v_loan.item_name,
        'sku',               v_loan.sku,
        'borrower_username', v_loan.borrower_username,
        'due_at',            v_loan.due_at,
        'qty',               v_loan.qty
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
          'event_type',  'overdue_loan',
          'entity_type', 'stock_loan',
          'entity_id',   v_loan.id::text,
          'dedupe_key',  v_dedupe,
          'message',     v_msg,
          'payload',     v_payload
        )
      );
    END LOOP;
  END IF;

END;
$run_overdue_alert$;

COMMENT ON FUNCTION run_overdue_alert() IS
  'Phase 3 daily cron (09:00 + 17:00 Asia/Bangkok). '
  'Pass A: UPDATE stock_loans SET status=overdue WHERE status=active AND due_at < now(). '
  'Pass B: send Telegram alerts — grouped if overdue count > OVERDUE_GROUP_THRESHOLD '
  '(Q-Phase3-F, default 10 from settings table), otherwise one message per loan. '
  'Reads NOTIFY_SUPABASE_URL and NOTIFY_SERVICE_ROLE_KEY from settings table '
  '(NOT current_setting — Project.md §8 gotcha 9). '
  'Dedupe key pattern: overdue_loan:{id}:{YYYY-MM-DD HH24} or overdue_batch:{YYYY-MM-DD HH24}.';

-- ==========================================================================
-- SECTION 2: pg_cron schedules (idempotent)
-- Pre-condition: pg_cron extension must be enabled (Phase 2 already enables it).
-- Verify: SELECT extname FROM pg_extension WHERE extname='pg_cron';
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Morning alert — 02:00 UTC = 09:00 Asia/Bangkok
DO $cron_morning$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'overdue_alert_morning'
  ) THEN
    PERFORM cron.unschedule('overdue_alert_morning');
  END IF;
END
$cron_morning$;

SELECT cron.schedule(
  'overdue_alert_morning',
  '0 2 * * *',
  $cron_cmd_morning$SELECT run_overdue_alert()$cron_cmd_morning$
);

-- Evening alert — 10:00 UTC = 17:00 Asia/Bangkok
DO $cron_evening$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'overdue_alert_evening'
  ) THEN
    PERFORM cron.unschedule('overdue_alert_evening');
  END IF;
END
$cron_evening$;

SELECT cron.schedule(
  'overdue_alert_evening',
  '0 10 * * *',
  $cron_cmd_evening$SELECT run_overdue_alert()$cron_cmd_evening$
);

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Function present + SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'run_overdue_alert';
--    -- Expected: 1 row, prosecdef=true
--
-- 2) pg_cron jobs registered:
--    SELECT jobname, schedule, command
--    FROM cron.job
--    WHERE jobname IN ('overdue_alert_morning', 'overdue_alert_evening')
--    ORDER BY jobname;
--    -- Expected: 2 rows
--    --   overdue_alert_evening  | 0 10 * * *  | SELECT run_overdue_alert()
--    --   overdue_alert_morning  | 0 2 * * *   | SELECT run_overdue_alert()
--
-- 3) Smoke run (manual):
--    SELECT run_overdue_alert();
--    -- Expected: no exception.
--    -- If NOTIFY settings blank: WARNING logged, no error.
--    -- After run: any stock_loans with due_at < now() AND status=active → now status=overdue.
--
-- 4) OVERDUE_GROUP_THRESHOLD in settings:
--    SELECT key, value FROM settings WHERE key = 'OVERDUE_GROUP_THRESHOLD';
--    -- Expected: 1 row, value='10'
--
-- 5) Idempotency: run twice → CREATE OR REPLACE + DO block unschedule → no error.
