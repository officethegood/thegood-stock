-- supabase/migrations/20260519010500_v_lots_with_remaining.sql
-- Phase 2 — v_lots_with_remaining view (Task A5b).
--
-- Spec §5.3: FEFO lot picker data source.
-- Active lots with current_qty > 0, ordered soonest-expiry first (FEFO).
--
-- Contradiction C-2 from plan: this view was omitted from the original task list
-- (A1–A8). Added as A5b between triggers (A5) and realtime (A6).
-- File timestamp 20260519010500 resolves the gap (realtime moved to 010600).
--
-- RLS note: this is a SECURITY INVOKER view (Postgres default). It inherits
-- the calling user's RLS context on stock_lots (sl_read: SELECT authenticated).
-- No separate policy needed.
--
-- days_until_expiry: computed at query time (CURRENT_DATE). Negative values
-- indicate expired lots (should not appear here since status='active' filter
-- is applied, but cron race between midnight and 09:00 could produce them
-- transiently — FE should treat negative as expired).
--
-- Depends on: stock_lots (20260519010100), stock_items (Phase 1).

CREATE OR REPLACE VIEW v_lots_with_remaining AS
SELECT
  sl.id,
  sl.item_id,
  si.sku,
  si.name          AS item_name,
  si.unit,
  sl.lot_number,
  sl.expiry_date,
  sl.received_at,
  sl.received_qty,
  sl.current_qty,
  sl.supplier,
  sl.note,
  sl.status,
  (sl.expiry_date - CURRENT_DATE) AS days_until_expiry
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
WHERE sl.status = 'active'
  AND sl.current_qty > 0
ORDER BY sl.expiry_date ASC NULLS LAST, sl.received_at ASC;

COMMENT ON VIEW v_lots_with_remaining IS
  'Phase 2 FEFO lot picker source (spec §5.3). '
  'Active lots with current_qty > 0, ordered soonest expiry first. '
  'days_until_expiry computed at query time. '
  'Inherits stock_lots RLS (SECURITY INVOKER). No explicit policy required.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) View exists and is queryable (expect 0 rows on fresh deploy):
--    SELECT count(*) FROM v_lots_with_remaining;
--    -- Expected: 0  (no lots yet); no error = view created successfully
--
-- 2) View columns match expected shape:
--    SELECT column_name, data_type
--    FROM information_schema.columns
--    WHERE table_name = 'v_lots_with_remaining'
--    ORDER BY ordinal_position;
--    -- Expected columns: id, item_id, sku, item_name, unit, lot_number,
--    --   expiry_date, received_at, received_qty, current_qty, supplier,
--    --   note, status, days_until_expiry
--
-- 3) FEFO order verification (after inserting test lots with different expiry dates):
--    SELECT lot_number, expiry_date, days_until_expiry
--    FROM v_lots_with_remaining
--    WHERE item_id = '<test_item_uuid>'
--    ORDER BY expiry_date;
--    -- Expected: rows in ascending expiry_date order (soonest first)
--
-- 4) Expired/depleted/recalled lots excluded:
--    SELECT count(*) FROM v_lots_with_remaining
--    WHERE status != 'active' OR current_qty = 0;
--    -- Expected: 0
