-- supabase/migrations/20260518010200_stock_item_locations.sql
-- Phase 1 — Per-(item, location) qty. Spec §5.3, Q-Phase1-D, Q-Phase1-N.
--
-- Multi-Location model = Option A: this junction table holds the qty source of truth
-- for the Item Finder hot path. The stock_movements ledger (next migration) is the
-- audit trail, kept in sync via the qty-apply trigger.
--
-- qty is int and CHECK (qty >= 0); the trigger also raises when a movement would drive
-- a row negative — belt-and-braces. UNIQUE(item_id, location_id) is what makes the
-- trigger's ON CONFLICT clause work for upsert semantics.

CREATE TABLE IF NOT EXISTS stock_item_locations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id       uuid NOT NULL REFERENCES locations(id)   ON DELETE RESTRICT,
  qty               int  NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_movement_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, location_id)
);

COMMENT ON TABLE  stock_item_locations                    IS 'Phase 1 qty source-of-truth per (item, location). Maintained by trigger on stock_movements.';
COMMENT ON COLUMN stock_item_locations.item_id            IS 'FK -> stock_items. ON DELETE RESTRICT to preserve ledger integrity.';
COMMENT ON COLUMN stock_item_locations.location_id        IS 'FK -> locations. ON DELETE RESTRICT to preserve ledger integrity.';
COMMENT ON COLUMN stock_item_locations.qty                IS 'Non-negative integer count. Updated only by trigger apply_movement_to_sil(); CHECK prevents direct negative writes.';
COMMENT ON COLUMN stock_item_locations.last_movement_at   IS 'Snapshot of stock_movements.performed_at for the most recent change on this row.';

-- Indexes for Item Finder and per-location reads
CREATE INDEX IF NOT EXISTS idx_sil_item
  ON stock_item_locations(item_id);
CREATE INDEX IF NOT EXISTS idx_sil_location
  ON stock_item_locations(location_id);
-- Partial index: Item Finder typically wants "where is this SKU currently held?" → qty>0
CREATE INDEX IF NOT EXISTS idx_sil_nonzero
  ON stock_item_locations(item_id) WHERE qty > 0;

DROP TRIGGER IF EXISTS trg_sil_updated_at ON stock_item_locations;
CREATE TRIGGER trg_sil_updated_at BEFORE UPDATE ON stock_item_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- View used by Admin Items list (spec §7.1.1): total qty across all locations per item.
-- SECURITY INVOKER (the default for views) so RLS on base tables still applies to
-- the caller. CREATE OR REPLACE so re-applying the migration is safe.
CREATE OR REPLACE VIEW v_stock_items_with_total AS
SELECT si.*,
       COALESCE(SUM(sil.qty), 0)::int AS total_qty
FROM stock_items si
LEFT JOIN stock_item_locations sil ON sil.item_id = si.id
GROUP BY si.id;

COMMENT ON VIEW v_stock_items_with_total IS 'Phase 1 admin list helper. Aggregates per-location qty into total_qty per item. SECURITY INVOKER.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Table + UNIQUE constraint:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='stock_item_locations'::regclass AND contype IN ('u','c');
--    -- expected to include the (item_id, location_id) UNIQUE and qty >= 0 CHECK
--
-- 2) Indexes:
--    SELECT indexname FROM pg_indexes WHERE tablename='stock_item_locations' ORDER BY indexname;
--    -- expected: idx_sil_item, idx_sil_location, idx_sil_nonzero
--
-- 3) Empty table baseline:
--    SELECT count(*) FROM stock_item_locations; -- expected 0
--    SELECT count(*) FROM v_stock_items_with_total; -- expected 0 (or = stock_items rowcount once items exist)
--
-- 4) CHECK constraint blocks negative qty:
--    INSERT INTO stock_item_locations(item_id, location_id, qty)
--    SELECT '00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000', -1;
--    -- expected: ERROR new row for relation "stock_item_locations" violates check constraint
