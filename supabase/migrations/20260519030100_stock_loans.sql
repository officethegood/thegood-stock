-- supabase/migrations/20260519030100_stock_loans.sql
-- Phase 3 — stock_loan_status enum + stock_loans table.
--
-- Decisions-locked:
--   Derived #3   — new table stock_loans per spec §5 with status enum active|returned|overdue|cancelled
--   Q-Phase3-D   — borrower_username NOT NULL (set by trigger from movement)
--   Q-Phase3-E   — due_at stored as explicit column on stock_loans (NOT encoded in note)
--   Spec §8.3    — movement_id_borrow / movement_id_return FK DEFERRABLE INITIALLY DEFERRED
--                  (allows loan + movement in same transaction)
--
-- Idempotent:
--   CREATE TYPE: wrapped in DO block with existence check
--   CREATE TABLE: IF NOT EXISTS
--   CREATE INDEX: IF NOT EXISTS
--   CREATE TRIGGER: DROP TRIGGER IF EXISTS before CREATE
--
-- Depends on:
--   stock_movements (Phase 1)
--   stock_items     (Phase 1)
--   locations       (Phase 0)
--   set_updated_at() function (Phase 0/1)

-- ==========================================================================
-- 1) stock_loan_status enum (idempotent)
-- ==========================================================================

DO $create_enum$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'stock_loan_status'
      AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    CREATE TYPE stock_loan_status AS ENUM ('active', 'returned', 'overdue', 'cancelled');
  END IF;
END
$create_enum$;

COMMENT ON TYPE stock_loan_status IS
  'Phase 3 — lifecycle states for stock_loans. '
  'active: borrowed, not yet returned, not yet overdue. '
  'returned: loan closed by return movement. '
  'overdue: due_at < now() and still not returned (set by cron run_overdue_alert). '
  'cancelled: voided by Admin without a physical return movement.';

-- ==========================================================================
-- 2) stock_loans table (idempotent)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS stock_loans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Movement links
  -- DEFERRABLE INITIALLY DEFERRED: allow INSERT stock_movements + INSERT stock_loans
  -- in the same transaction (trigger approach: trigger runs in the same txn as the movement INSERT,
  -- so FK check is deferred until COMMIT — no constraint violation mid-transaction).
  movement_id_borrow    uuid NOT NULL REFERENCES stock_movements(id)
                            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  movement_id_return    uuid          REFERENCES stock_movements(id)
                            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,

  -- Item + location snapshot (denormalized; source of truth is the borrow movement)
  item_id               uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id_from      uuid NOT NULL REFERENCES locations(id)   ON DELETE RESTRICT,

  -- Borrower identity
  borrower_username     text NOT NULL,

  -- Timestamps
  borrowed_at           timestamptz NOT NULL DEFAULT now(),
  due_at                timestamptz NOT NULL,
  returned_at           timestamptz,

  -- Photo proof (advisory — upload failure must not block movement)
  -- Phase 3 client uploads to Cloudinary and PATCHes stock_loans with the resulting URL.
  -- Folder pattern: thegood-stock/borrow/{client_ref_id}/borrow.* or return.*
  photo_borrow_url      text,
  photo_return_url      text,

  -- Quantity borrowed
  qty                   int NOT NULL DEFAULT 1 CHECK (qty > 0),

  -- State machine
  status                stock_loan_status NOT NULL DEFAULT 'active',

  -- Free-text
  notes                 text,

  -- Audit
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  created_by            text DEFAULT app_username(),
  updated_by            text,

  -- Consistency constraints
  CONSTRAINT chk_loan_return_consistency
    CHECK (
      (status = 'returned' AND returned_at IS NOT NULL)
      OR status IN ('active', 'overdue', 'cancelled')
    ),
  CONSTRAINT chk_loan_due_after_borrow
    CHECK (due_at > borrowed_at)
);

COMMENT ON TABLE stock_loans IS
  'Phase 3 — loan lifecycle tracking. One row per borrow event. '
  'Created by trigger trg_sm_create_loan on stock_movements INSERT (movement_type=borrow). '
  'Closed by trigger trg_sm_close_loan on stock_movements INSERT (movement_type=return). '
  'Status set to overdue by pg_cron run_overdue_alert() at 09:00 + 17:00 BKK.';

-- ==========================================================================
-- 3) Indexes (IF NOT EXISTS)
-- ==========================================================================

CREATE INDEX IF NOT EXISTS idx_loans_item
  ON stock_loans(item_id);

CREATE INDEX IF NOT EXISTS idx_loans_borrower
  ON stock_loans(borrower_username);

CREATE INDEX IF NOT EXISTS idx_loans_status
  ON stock_loans(status)
  WHERE status IN ('active', 'overdue');

CREATE INDEX IF NOT EXISTS idx_loans_due
  ON stock_loans(due_at)
  WHERE status IN ('active', 'overdue');

CREATE INDEX IF NOT EXISTS idx_loans_mvborrow
  ON stock_loans(movement_id_borrow);

-- ==========================================================================
-- 4) set_updated_at trigger (idempotent)
-- ==========================================================================

DROP TRIGGER IF EXISTS trg_loans_updated_at ON stock_loans;
CREATE TRIGGER trg_loans_updated_at
  BEFORE UPDATE ON stock_loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Table + columns exist:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='stock_loans'
--    ORDER BY ordinal_position;
--    -- Expected: 22+ rows including id, movement_id_borrow, status, photo_borrow_url, etc.
--
-- 2) Enum values:
--    SELECT enumlabel FROM pg_enum
--    JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
--    WHERE pg_type.typname = 'stock_loan_status'
--    ORDER BY enumsortorder;
--    -- Expected: active, cancelled, overdue, returned
--
-- 3) DEFERRABLE FK exists:
--    SELECT conname, condeferrable, condeferred
--    FROM pg_constraint
--    WHERE conrelid = 'stock_loans'::regclass
--      AND conname LIKE 'stock_loans_movement_id%';
--    -- Expected: 2 rows, condeferrable=true, condeferred=true
--
-- 4) Indexes present:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'stock_loans'
--    ORDER BY indexname;
--    -- Expected: idx_loans_borrower, idx_loans_due, idx_loans_item,
--    --           idx_loans_mvborrow, idx_loans_status, stock_loans_pkey
--
-- 5) Idempotency: run migration twice → no error (all CREATE IF NOT EXISTS; DO blocks guard).
