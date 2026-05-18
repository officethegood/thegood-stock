-- supabase/migrations/20260519010600_stock_lots_realtime.sql
-- Phase 2 — Add stock_lots to the Supabase Realtime publication.
--
-- Rationale: Admin lot list must update live when:
--   • Daily cron auto-expires a lot (status: active → expired)
--   • Another Admin session performs a recall (status: active → recalled)
--   • A movement depletes a lot (status: active → depleted)
-- Pattern mirrors Phase 1 (stock_items, stock_item_locations).
--
-- Depends on: stock_lots table (20260519010100).
-- Idempotent: ALTER PUBLICATION ADD TABLE is a no-op if already present
-- in Postgres 16+. On older versions it will error if already added;
-- the DO guard below handles both.

DO $phase2_rt$
BEGIN
  -- Check whether stock_lots is already in the publication before adding.
  -- Avoids ERROR on re-run (Postgres raises if table already in publication).
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname   = 'supabase_realtime'
      AND tablename = 'stock_lots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE stock_lots;
  END IF;
END
$phase2_rt$;

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) stock_lots is in the publication:
--    SELECT tablename FROM pg_publication_tables
--    WHERE pubname   = 'supabase_realtime'
--      AND tablename = 'stock_lots';
--    -- Expected: 1 row
--
-- 2) Dashboard confirm (manual):
--    Navigate to Supabase Dashboard → Database → Replication → supabase_realtime
--    Confirm 'stock_lots' appears in the enabled tables list.
