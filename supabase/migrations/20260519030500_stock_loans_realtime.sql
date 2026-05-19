-- supabase/migrations/20260519030500_stock_loans_realtime.sql
-- Phase 3 — Enable Realtime on stock_loans.
--
-- Decisions-locked:
--   Derived #6 — ADD TO supabase_realtime publication
--
-- Follows Phase 2 pattern (20260519010600_stock_lots_realtime.sql).
-- Idempotent: IF NOT EXISTS clause on publication membership.
--
-- After this migration, js/loans.js subscribes to:
--   supabase.channel('realtime:loans:phase3')
--     .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_loans' }, cb)
--     .subscribe()
-- js/dashboard.js also uses this subscription for the borrow panel counter updates.

DO $loans_realtime$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname    = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'stock_loans'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE stock_loans;
  END IF;
END
$loans_realtime$;

-- ============================================================
-- Verification SQL
-- ============================================================
-- SELECT pubname, schemaname, tablename
-- FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'stock_loans';
-- Expected: 1 row — supabase_realtime / public / stock_loans
--
-- Idempotency: run twice → DO block checks existence → no error on second run.
