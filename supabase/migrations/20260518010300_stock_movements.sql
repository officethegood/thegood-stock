-- supabase/migrations/20260518010300_stock_movements.sql
-- Phase 1 — Ledger / audit trail. Spec §5.4, Q-Phase1-J, Q-Phase1-L.
--
-- The ledger is append-only (no UPDATE/DELETE RLS policies; corrections are reverse
-- movements). qty source of truth lives in stock_item_locations and is kept in sync
-- by trigger apply_movement_to_sil() — defined in the triggers migration.
--
-- Q-Phase1-L: enum includes Phase 3+ reserved values (borrow/return/transfer_in/out)
-- so future phases don't require ALTER TYPE migrations. (PM Q1 2026-05-18: transfer_*
-- values are RESERVED only — no Transfer-specific policies / triggers / columns in
-- Phase 1. PM Q3 2026-05-18: no photo/attachment column; Phase 3 adds proper
-- Cloudinary photo proof for borrow/return.)
--
-- Q-Phase1-J: client_ref_id UUID UNIQUE provides scan-replay idempotency.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stock_movement_type') THEN
    CREATE TYPE stock_movement_type AS ENUM (
      'receive',           -- Admin: incoming stock (รับเข้า)
      'issue',             -- Admin or Staff: outgoing stock (เบิก-จ่าย)
      'adjustment_gain',   -- Admin: stock-take found extra
      'adjustment_loss',   -- Admin or Staff: damage / loss / miscount
      'transfer_out',      -- RESERVED Phase 2+ (PM Q1 2026-05-18: deferred); kept for future ALTER-free wiring
      'transfer_in',       -- RESERVED Phase 2+
      'borrow',            -- RESERVED Phase 3 (equipment borrow)
      'return'             -- RESERVED Phase 3 (equipment return)
    );
  END IF;
END $$;

COMMENT ON TYPE stock_movement_type IS 'Phase 1 movement-type enum. Includes Phase 2+/3+ reserved values per Q-Phase1-L so future phases avoid ALTER TYPE migrations.';

CREATE TABLE IF NOT EXISTS stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref_id       uuid UNIQUE,
  item_id             uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id         uuid NOT NULL REFERENCES locations(id)   ON DELETE RESTRICT,
  movement_type       stock_movement_type NOT NULL,
  qty_delta           int  NOT NULL CHECK (qty_delta <> 0),
  qty_after           int,
  reason              text,
  note                text,
  lot_id              uuid,
  source_movement_id  uuid REFERENCES stock_movements(id),
  performed_by        text NOT NULL DEFAULT app_username(),
  performed_role      text NOT NULL DEFAULT app_user_role(),
  performed_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  stock_movements                     IS 'Phase 1 append-only ledger of qty changes. RLS allows INSERT only; no UPDATE/DELETE policies (immutable).';
COMMENT ON COLUMN stock_movements.client_ref_id       IS 'Q-Phase1-J: client-generated UUID for scan-replay idempotency. UNIQUE; a retried insert returns 409 which clients treat as "already posted".';
COMMENT ON COLUMN stock_movements.movement_type       IS 'See stock_movement_type. Sign of qty_delta is enforced by trigger enforce_movement_sign().';
COMMENT ON COLUMN stock_movements.qty_delta           IS 'Signed integer; positive for receive/gain/return/transfer_in, negative for issue/loss/borrow/transfer_out. CHECK (<> 0).';
COMMENT ON COLUMN stock_movements.qty_after           IS 'Snapshot of stock_item_locations.qty after this movement is applied. Filled by trigger apply_movement_to_sil().';
COMMENT ON COLUMN stock_movements.reason              IS 'Optional free-text reason (e.g. "broken", "expired", "patient encounter").';
COMMENT ON COLUMN stock_movements.lot_id              IS 'Phase 2 hook. Nullable; future FK to stock_lots(id) added by Phase 2 migration.';
COMMENT ON COLUMN stock_movements.source_movement_id  IS 'Phase 3+ hook: links a return to the originating borrow, or paired transfer rows. Self-referential FK.';
COMMENT ON COLUMN stock_movements.performed_by        IS 'Username taken from JWT at insert time (app_username() default). Audit field.';
COMMENT ON COLUMN stock_movements.performed_role      IS 'Role at insert time. Captures whether an Admin or Employee did the move.';

-- Indexes for "movements for this item over time" and "movements at this location"
CREATE INDEX IF NOT EXISTS idx_sm_item      ON stock_movements(item_id, performed_at);
CREATE INDEX IF NOT EXISTS idx_sm_location  ON stock_movements(location_id, performed_at);
CREATE INDEX IF NOT EXISTS idx_sm_performed ON stock_movements(performed_at);

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Enum labels in declared order (8 rows expected):
--    SELECT enumlabel FROM pg_enum WHERE enumtypid='stock_movement_type'::regtype
--    ORDER BY enumsortorder;
--
-- 2) Table + UNIQUE(client_ref_id) + CHECK(qty_delta<>0):
--    SELECT conname, contype FROM pg_constraint
--    WHERE conrelid='stock_movements'::regclass ORDER BY conname;
--
-- 3) Indexes:
--    SELECT indexname FROM pg_indexes WHERE tablename='stock_movements' ORDER BY indexname;
--    -- expected: idx_sm_item, idx_sm_location, idx_sm_performed (+ PK + client_ref_id unique idx)
--
-- 4) qty_delta=0 rejected:
--    INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
--    VALUES ('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','issue',0);
--    -- expected: ERROR violates check constraint stock_movements_qty_delta_check
