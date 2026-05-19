-- supabase/migrations/20260519050600_oxygen_realtime.sql
-- Phase 5 — Add oxygen_tanks to supabase_realtime publication.
-- oxygen_movements is intentionally excluded (INSERT-only ledger; detail loaded on demand).
-- Pattern mirrors Phase 2 20260519010600_stock_lots_realtime.sql.
-- Idempotent: DO block checks pg_publication_tables before ALTER.

DO $phase5_realtime$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'oxygen_tanks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE oxygen_tanks;
  END IF;
END
$phase5_realtime$;

COMMENT ON TABLE oxygen_tanks IS
  'Phase 5. One row per physical oxygen cylinder. Added to supabase_realtime. '
  'Status maintained by state-machine trigger on oxygen_movements. '
  'NOT a child of stock_items.';

-- Verification:
-- SELECT tablename
-- FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime'
--   AND tablename = 'oxygen_tanks';
-- Expected: 1 row (oxygen_tanks)
--
-- SELECT tablename
-- FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime'
--   AND tablename = 'oxygen_movements';
-- Expected: 0 rows (oxygen_movements intentionally excluded)
