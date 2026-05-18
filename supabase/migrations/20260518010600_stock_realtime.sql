-- supabase/migrations/20260518010600_stock_realtime.sql
-- Phase 1 — Realtime publication. Spec §3, §5.7, Q-Phase1-K.
--
-- Q-Phase1-K: ONLY stock_items and stock_item_locations are added to realtime.
-- stock_movements is EXCLUDED to limit noise (one row per scan adds up fast and
-- the admin UI re-aggregates from stock_item_locations anyway).
--
-- ALTER PUBLICATION ADD TABLE fails if the table is already a member, so we
-- wrap each ALTER in a DO block that checks pg_publication_tables first to keep
-- the migration idempotent on re-runs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'stock_items'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_items';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'stock_item_locations'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_item_locations';
  END IF;
END $$;

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Both tables in publication; stock_movements is NOT:
--    SELECT schemaname, tablename FROM pg_publication_tables
--    WHERE pubname = 'supabase_realtime' AND tablename LIKE 'stock_%'
--    ORDER BY tablename;
--    -- expected: stock_item_locations, stock_items   (and NOT stock_movements)
--
-- 2) Total count of stock_* in realtime is exactly 2:
--    SELECT count(*) FROM pg_publication_tables
--    WHERE pubname='supabase_realtime' AND tablename LIKE 'stock_%';
--    -- expected: 2
--
-- 3) Browser smoke (after FE wired): open admin Inventory tab in two browsers,
--    post any stock_movements row from one → the other reflects new qty within
--    ~1s. (T40 in spec.)
