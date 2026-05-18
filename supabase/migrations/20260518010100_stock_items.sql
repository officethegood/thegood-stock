-- supabase/migrations/20260518010100_stock_items.sql
-- Phase 1 — Items master table. Spec §5.2, Q-Phase1-A, Q-Phase1-N.
--
-- Item identity = SKU + qty (no per-piece serial in Phase 1, Q-Phase1-A).
-- qty/threshold type is int for Phase 1 (Q-Phase1-N); Phase 2 may revisit to numeric
-- when medication ml/mg dosing arrives.
--
-- Phase hooks (intentionally nullable / default-false):
--   tracks_lots   -- Phase 2 (medication lots + expiry)
--   tracks_serial -- Phase 5 (oxygen tanks; separate table actually, hook reserved)
--   image_url     -- Phase 3 wires Cloudinary UI (Q3 PM 2026-05-18: NOT a photo proof column)

CREATE TABLE IF NOT EXISTS stock_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                 text UNIQUE NOT NULL,
  barcode             text UNIQUE,
  name                text NOT NULL,
  name_en             text,
  category_id         uuid REFERENCES stock_categories(id),
  unit                text NOT NULL DEFAULT 'ชิ้น',
  reorder_threshold   int  NOT NULL DEFAULT 0,
  tracks_lots         boolean NOT NULL DEFAULT false,
  tracks_serial       boolean NOT NULL DEFAULT false,
  image_url           text,
  note                text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text DEFAULT app_username(),
  updated_by          text
);

COMMENT ON TABLE  stock_items                     IS 'Phase 1 master record for general inventory items. One row per SKU.';
COMMENT ON COLUMN stock_items.sku                 IS 'Stable internal SKU; uppercased convention (e.g. SUP-GAUZE-001). UNIQUE.';
COMMENT ON COLUMN stock_items.barcode             IS 'Optional printed barcode/EAN; nullable because not every item has one. UNIQUE when present.';
COMMENT ON COLUMN stock_items.name_en             IS 'Optional English name. Useful for third-party barcode lookup vendors.';
COMMENT ON COLUMN stock_items.category_id         IS 'Optional FK to stock_categories. Nullable to keep intake friction low (Q-Phase1-E).';
COMMENT ON COLUMN stock_items.unit                IS 'Display unit: ชิ้น / กล่อง / ขวด / ... Default ชิ้น.';
COMMENT ON COLUMN stock_items.reorder_threshold   IS 'Total qty (across all locations) at-or-below which a low-stock alert fires. 0 disables alerting.';
COMMENT ON COLUMN stock_items.tracks_lots         IS 'Phase 2 hook. When true, future lot rows attach to movements. Phase 1 keeps it false.';
COMMENT ON COLUMN stock_items.tracks_serial       IS 'Phase 5 hook. Reserved; Phase 5 oxygen tanks live in a separate table not this one.';
COMMENT ON COLUMN stock_items.image_url           IS 'Phase 3 wires Cloudinary for item photos. Phase 1 column exists, no UI.';
COMMENT ON COLUMN stock_items.active              IS 'Soft-delete. Inactive items hidden from pickers but kept for ledger FK integrity.';

-- Indexes for the Item Finder hot path (search by name / barcode / category)
CREATE INDEX IF NOT EXISTS idx_stock_items_name
  ON stock_items USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_stock_items_barcode
  ON stock_items(barcode);
CREATE INDEX IF NOT EXISTS idx_stock_items_category
  ON stock_items(category_id);

-- updated_at maintenance via shared helper from 20260518000000_init.sql
DROP TRIGGER IF EXISTS trg_stock_items_updated_at ON stock_items;
CREATE TRIGGER trg_stock_items_updated_at BEFORE UPDATE ON stock_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Table & key columns present:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='stock_items' ORDER BY ordinal_position;
--
-- 2) Indexes created (3 expected on this table beyond PK / UNIQUE auto-indexes):
--    SELECT indexname FROM pg_indexes WHERE tablename='stock_items' ORDER BY indexname;
--    -- expected to include: idx_stock_items_barcode, idx_stock_items_category, idx_stock_items_name
--
-- 3) updated_at trigger wired:
--    SELECT tgname FROM pg_trigger WHERE tgrelid='stock_items'::regclass AND NOT tgisinternal;
--    -- expected: trg_stock_items_updated_at
--
-- 4) UNIQUE(sku) enforced:
--    INSERT INTO stock_items(sku,name) VALUES ('X','a'),('X','b');
--    -- expected: ERROR duplicate key on stock_items_sku_key (then ROLLBACK)
