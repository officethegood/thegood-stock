-- supabase/migrations/20260519010200_stock_movements_extend.sql
-- Phase 2 — Extend stock_movements: real FK + fefo_override column.
--
-- Decisions-locked:
--   derived #3  — FK lot_id → stock_lots(id) DEFERRABLE INITIALLY DEFERRED
--                 (allows lot CREATE + movement INSERT in same transaction during receive)
--   derived #11 — fefo_override boolean NOT NULL DEFAULT false for compliance audit
--
-- All Phase 1 rows have lot_id IS NULL; FK addition is safe and non-blocking.
-- Idempotent: DO blocks guard both ALTER TABLE statements.
--
-- Depends on: stock_lots table (20260519010100).
-- Secret names used: none.

-- ---------------------------------------------------------------------------
-- 1) Add fefo_override column
-- ---------------------------------------------------------------------------
DO $phase2_fefo$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'stock_movements'
      AND column_name = 'fefo_override'
  ) THEN
    ALTER TABLE stock_movements
      ADD COLUMN fefo_override boolean NOT NULL DEFAULT false;
  END IF;
END
$phase2_fefo$;

COMMENT ON COLUMN stock_movements.fefo_override IS
  'Phase 2. TRUE when staff deliberately selected a non-FEFO lot and confirmed '
  'the warning modal (Q-D2). Compliance audit: SELECT count(*) FROM stock_movements WHERE fefo_override=true.';

-- ---------------------------------------------------------------------------
-- 2) Add FK lot_id → stock_lots(id)  DEFERRABLE INITIALLY DEFERRED
--
-- DEFERRABLE INITIALLY DEFERRED is critical for the receive flow:
-- the frontend inserts stock_lots + stock_movements in a single transaction.
-- The FK is not checked until COMMIT, so ordering within the transaction
-- does not matter.
-- ---------------------------------------------------------------------------
DO $phase2_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname    = 'fk_movements_lot'
      AND conrelid   = 'stock_movements'::regclass
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT fk_movements_lot
        FOREIGN KEY (lot_id)
        REFERENCES stock_lots(id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$phase2_fk$;

COMMENT ON COLUMN stock_movements.lot_id IS
  'Phase 2: FK → stock_lots(id) DEFERRABLE INITIALLY DEFERRED (derived #3). '
  'Required (enforced by check_lot_status BEFORE trigger) when item.tracks_lots=true '
  'AND movement_type IN (issue, adjustment_loss, borrow, transfer_out, receive). '
  'Nullable for Phase 1 general items that do not track lots.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) FK present with DEFERRABLE INITIALLY DEFERRED:
--    SELECT conname, condeferrable, condeferred
--    FROM pg_constraint
--    WHERE conrelid = 'stock_movements'::regclass
--      AND conname  = 'fk_movements_lot';
--    -- Expected: 1 row, condeferrable=true, condeferred=true
--
-- 2) fefo_override column present with correct default:
--    SELECT column_name, column_default, is_nullable
--    FROM information_schema.columns
--    WHERE table_name  = 'stock_movements'
--      AND column_name = 'fefo_override';
--    -- Expected: 1 row, column_default='false', is_nullable='NO'
--
-- 3) Phase 1 rows unaffected (all lot_id still NULL):
--    SELECT count(*) FROM stock_movements WHERE lot_id IS NOT NULL;
--    -- Expected: 0
