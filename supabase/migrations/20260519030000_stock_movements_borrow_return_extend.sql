-- supabase/migrations/20260519030000_stock_movements_borrow_return_extend.sql
-- Phase 3 — Extend stock_movements with borrow/return columns.
--
-- Decisions-locked:
--   Q-Phase3-D  — borrower_username: nullable column; default app_username() via BEFORE INSERT trigger
--   Q-Phase3-E  — due_at: dedicated nullable column on stock_movements (NOT encoded in note)
--
-- Both columns are nullable so Phase 0/1/2 rows are unaffected.
-- Backfill NOT required — Phase 1 rows have lot_id=NULL and are issue/receive type.
--
-- Idempotent: all ALTER TABLE wrapped in DO $tag$ blocks with IF NOT EXISTS guard.

-- ==========================================================================
-- 1) ADD COLUMN due_at timestamptz (nullable)
-- ==========================================================================

DO $add_due_at$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'stock_movements'
      AND column_name  = 'due_at'
  ) THEN
    ALTER TABLE stock_movements ADD COLUMN due_at timestamptz;
    COMMENT ON COLUMN stock_movements.due_at IS
      'Phase 3: due date for borrow movements. NULL for all non-borrow movements. '
      'BEFORE INSERT trigger enforces NOT NULL when movement_type=''borrow''.';
  END IF;
END
$add_due_at$;

-- ==========================================================================
-- 2) ADD COLUMN borrower_username text (nullable)
-- ==========================================================================

DO $add_borrower_username$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'stock_movements'
      AND column_name  = 'borrower_username'
  ) THEN
    ALTER TABLE stock_movements ADD COLUMN borrower_username text;
    COMMENT ON COLUMN stock_movements.borrower_username IS
      'Phase 3: identity of the borrower. NULL for non-borrow/return movements. '
      'On borrow movements defaults to app_username() via BEFORE INSERT trigger '
      '(Q-Phase3-D). Admin can pass an explicit value to proxy-borrow on behalf of staff.';
  END IF;
END
$add_borrower_username$;

-- ============================================================
-- Verification SQL
-- ============================================================
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='stock_movements'
--   AND column_name IN ('due_at','borrower_username')
-- ORDER BY column_name;
-- Expected: 2 rows — both data_type=text/timestamp with time zone, is_nullable=YES
--
-- Idempotency check (run twice → no error):
-- Run this migration file twice in SQL Editor → second run finds columns exist → skips ALTER → no error.
