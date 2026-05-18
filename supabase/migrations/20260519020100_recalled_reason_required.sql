-- Migration: 20260519020100_recalled_reason_required.sql
-- Purpose:
--   1. Add partial CHECK ensuring recalled_reason is non-null and >= 5 chars when status='recalled'.
--   2. Add BEFORE UPDATE trigger preventing modification of immutable columns
--      (lot_number, item_id, received_qty) on stock_lots.
-- Idempotent: uses IF NOT EXISTS / DO blocks / CREATE OR REPLACE.
-- Ref: docs/superpowers/audits/2026-05-19-phase2-security.md §S-11, §S2-B

-- -------------------------------------------------------------------------
-- Step 1: Add the recalled_reason length check as NOT VALID
--         (NOT VALID means existing rows are not checked on ALTER — safe for
--          zero-row or any-row tables. Must VALIDATE separately in Step 2.)
-- -------------------------------------------------------------------------
DO $tag$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conrelid = 'stock_lots'::regclass
      AND  conname  = 'chk_recalled_reason_required'
  ) THEN
    ALTER TABLE stock_lots
      ADD CONSTRAINT chk_recalled_reason_required
      CHECK (
        status <> 'recalled'
        OR (recalled_reason IS NOT NULL AND length(recalled_reason) >= 5)
      )
      NOT VALID;
  END IF;
END
$tag$;

-- -------------------------------------------------------------------------
-- Step 2: Validate the constraint against existing rows.
--         If this fails, rows exist with status='recalled' and short/null reason.
--         Inspect: SELECT * FROM stock_lots WHERE status='recalled'
--                                             AND (recalled_reason IS NULL
--                                                  OR length(recalled_reason) < 5);
-- -------------------------------------------------------------------------
ALTER TABLE stock_lots
  VALIDATE CONSTRAINT chk_recalled_reason_required;

-- -------------------------------------------------------------------------
-- Step 3: Immutability trigger — prevent modification of audit-critical columns.
--         Pattern mirrors prevent_lot_delete() recommendation in audit S-7 (already
--         deployed in Phase 2 migration). See audit S-11.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_lot_immutable_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lot_number  IS DISTINCT FROM NEW.lot_number THEN
    RAISE EXCEPTION 'stock_lots.lot_number is immutable after creation';
  END IF;
  IF OLD.item_id     IS DISTINCT FROM NEW.item_id THEN
    RAISE EXCEPTION 'stock_lots.item_id is immutable after creation';
  END IF;
  IF OLD.received_qty IS DISTINCT FROM NEW.received_qty THEN
    RAISE EXCEPTION 'stock_lots.received_qty is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_no_update_lot_immutable ON stock_lots;
CREATE TRIGGER trg_no_update_lot_immutable
  BEFORE UPDATE ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION prevent_lot_immutable_update();

COMMENT ON FUNCTION prevent_lot_immutable_update() IS
  'Guards lot_number, item_id, received_qty from UPDATE after creation. See audit S-11.';
COMMENT ON CONSTRAINT chk_recalled_reason_required ON stock_lots IS
  'When status=recalled, recalled_reason must be non-null and at least 5 characters long. See audit S2-B.';

-- ============================================================
-- Verification SQL (run after deploy)
-- ============================================================
-- Confirm constraint exists and is validated:
--   SELECT conname, convalidated FROM pg_constraint
--   WHERE  conrelid = 'stock_lots'::regclass
--     AND  conname  = 'chk_recalled_reason_required';
--   -- Expected: 1 row, convalidated = true
--
-- Confirm trigger exists:
--   SELECT tgname, tgenabled FROM pg_trigger
--   WHERE  tgrelid = 'stock_lots'::regclass
--     AND  tgname  = 'trg_no_update_lot_immutable';
--   -- Expected: 1 row, tgenabled = 'O'
--
-- Confirm immutability (run in ROLLBACK transaction):
--   BEGIN;
--     UPDATE stock_lots SET lot_number = 'TAMPER-TEST'
--     WHERE  id = (SELECT id FROM stock_lots LIMIT 1);
--   ROLLBACK;
--   -- Expected: ERROR: stock_lots.lot_number is immutable after creation
--   -- (If stock_lots is empty, skip — constraint/trigger verified by existence check above)
