-- supabase/migrations/20260519070400_stock_movements_scanned.sql
-- Phase 0.7 — Transfer Audit
-- Decisions: D5 (scanned flag per movement row), D4/G6 (audit trail), spec §4.5
-- Depends on: 20260518010300_stock_movements.sql (table exists)
--
-- Assumptions:
--   Postgres 15. Adding NOT NULL DEFAULT false is a metadata-only operation on
--   Postgres 11+ (no table rewrite). All pre-existing rows will read scanned=false,
--   which is the correct interpretation: "manual selection" (spec §6).
--   scanned flag is set by client (transfer modal or scan flow); RLS does not restrict it.

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS scanned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN stock_movements.scanned IS
  'Phase 0.7. TRUE = location_id ได้มาจาก QR scan. FALSE = manual dropdown selection. '
  'ใช้สำหรับ audit: SELECT count(*) FROM stock_movements WHERE scanned=false จะบอก '
  'จำนวน movement ที่ admin/staff พิมพ์เลือก (ความน่าเชื่อถือต่ำกว่า scan). '
  'Pre-existing rows default to false per spec §6 (conservative: treat old moves as manual).';

-- Partial index — makes audit query "unscanned movements over time" fast
CREATE INDEX IF NOT EXISTS idx_sm_scanned_false
  ON stock_movements(performed_at)
  WHERE scanned = false;

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- A) Column exists with correct default:
--    SELECT column_name, data_type, is_nullable, column_default
--    FROM information_schema.columns
--    WHERE table_name='stock_movements' AND column_name='scanned';
--    Expected: scanned | boolean | NO | false
--
-- B) Partial index exists:
--    SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename='stock_movements' AND indexname='idx_sm_scanned_false';
--    Expected: idx_sm_scanned_false | ... WHERE (scanned = false)
--
-- C) Audit query works:
--    SELECT count(*) FROM stock_movements WHERE scanned = false;
--    Expected: count = total existing rows (all pre-Phase-0.7 rows are false)
