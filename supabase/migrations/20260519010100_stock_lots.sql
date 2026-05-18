-- supabase/migrations/20260519010100_stock_lots.sql
-- Phase 2 — stock_lots master table.
--
-- Decisions-locked:
--   derived #1  — full column list including recalled audit columns
--   Q-Phase2-1  — UNIQUE(item_id, lot_number); lot numbers unique per item, NOT global
--   Q-Phase2-2  — recalled_reason / recalled_by / recalled_at explicit audit columns
--                 (Note: decisions-locked doc is binding over spec §5.1 DDL — see plan C-3)
--
-- Depends on: stock_lot_status enum (20260519010000), stock_items table (Phase 1),
--             app_username() helper (Phase 0 init), set_updated_at() helper (Phase 0 init).
--
-- Assumed extensions: pgcrypto (gen_random_uuid).
-- Secret names used: none (no pg_net calls in this file).

CREATE TABLE IF NOT EXISTS stock_lots (
  id              uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid              NOT NULL
                                      REFERENCES stock_items(id) ON DELETE RESTRICT,
  lot_number      text              NOT NULL,
  expiry_date     date              NOT NULL,
  received_at     timestamptz       NOT NULL DEFAULT now(),
  received_qty    int               NOT NULL CHECK (received_qty > 0),
  current_qty     int               NOT NULL DEFAULT 0 CHECK (current_qty >= 0),
  supplier        text,
  note            text,
  status          stock_lot_status  NOT NULL DEFAULT 'active',

  -- Recall audit columns — decisions-locked derived #1 (binding over spec §5.1)
  recalled_reason text,
  recalled_by     text,
  recalled_at     timestamptz,

  -- Standard audit
  created_at      timestamptz       NOT NULL DEFAULT now(),
  updated_at      timestamptz       NOT NULL DEFAULT now(),
  created_by      text              NOT NULL DEFAULT app_username(),
  updated_by      text,

  -- Q-Phase2-1: lot_number unique within the same item.
  -- Vendors may reuse the same lot string across different SKUs — that is allowed.
  CONSTRAINT uq_lot_per_item UNIQUE (item_id, lot_number)
);

COMMENT ON TABLE stock_lots IS
  'Phase 2. One row per received medication batch. current_qty kept in sync by apply_movement_to_sil (extended) and apply_movement_to_lot_qty triggers. status auto-set to expired by daily cron (Q-Phase2-3).';

COMMENT ON COLUMN stock_lots.lot_number    IS 'Manufacturer lot / batch number. Unique within the same item (uq_lot_per_item). Vendors may reuse across different items.';
COMMENT ON COLUMN stock_lots.expiry_date   IS 'Manufacture expiry date (date only). Auto-expired by cron when expiry_date < CURRENT_DATE (Q-Phase2-3).';
COMMENT ON COLUMN stock_lots.received_qty  IS 'Qty received at intake. Immutable after INSERT. current_qty tracks running balance.';
COMMENT ON COLUMN stock_lots.current_qty   IS 'Running balance: received_qty minus all issued/adjusted movements referencing this lot. Kept in sync by trigger.';
COMMENT ON COLUMN stock_lots.status        IS 'active=in use; depleted=trigger sets when current_qty=0; expired=cron sets daily; recalled=Admin sets (Q-Phase2-2).';
COMMENT ON COLUMN stock_lots.recalled_reason IS 'Free-text reason required when Admin sets status=recalled. Audit trail (decisions derived #1).';
COMMENT ON COLUMN stock_lots.recalled_by   IS 'app_username() of Admin who performed the recall action.';
COMMENT ON COLUMN stock_lots.recalled_at   IS 'Timestamp of recall action execution.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary join: most queries filter by item_id
CREATE INDEX IF NOT EXISTS idx_sl_item ON stock_lots(item_id);

-- Partial index for the daily cron auto-expire pass (only scans active lots)
CREATE INDEX IF NOT EXISTS idx_sl_expiry_active
  ON stock_lots(expiry_date)
  WHERE status = 'active';

-- Status filter for Admin lot list and FEFO view
CREATE INDEX IF NOT EXISTS idx_sl_status ON stock_lots(status);

-- ---------------------------------------------------------------------------
-- Auto-update updated_at (reuses Phase 0 set_updated_at() helper)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_stock_lots_updated_at ON stock_lots;
CREATE TRIGGER trg_stock_lots_updated_at
  BEFORE UPDATE ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Table columns (expect 19):
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_name = 'stock_lots'
--    ORDER BY ordinal_position;
--    -- Expected: 19 columns including recalled_reason, recalled_by, recalled_at.
--
-- 2) Constraints:
--    SELECT conname, contype FROM pg_constraint
--    WHERE conrelid = 'stock_lots'::regclass
--    ORDER BY conname;
--    -- Expected rows (contype):
--    --   stock_lots_current_qty_check    c
--    --   stock_lots_item_id_fkey         f
--    --   stock_lots_pkey                 p
--    --   stock_lots_received_qty_check   c
--    --   uq_lot_per_item                 u
--
-- 3) Indexes:
--    SELECT indexname FROM pg_indexes WHERE tablename = 'stock_lots' ORDER BY indexname;
--    -- Expected: idx_sl_expiry_active, idx_sl_item, idx_sl_status,
--    --           stock_lots_pkey, uq_lot_per_item
--
-- 4) updated_at trigger present:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'stock_lots'::regclass AND NOT tgisinternal;
--    -- Expected: trg_stock_lots_updated_at
