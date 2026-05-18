-- supabase/migrations/20260518010000_stock_categories.sql
-- Phase 1 — Optional category lookup. Spec §5.1, Q-Phase1-E.
--
-- 4-category seed + optional FK. Implemented as a table (not enum) so Phase 2+
-- (MEDICATION, ALS_KIT, ...) can extend without an enum-altering migration.

CREATE TABLE IF NOT EXISTS stock_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  stock_categories          IS 'Phase 1 lookup of top-level item categories. Q-Phase1-E.';
COMMENT ON COLUMN stock_categories.code     IS 'Stable machine code, e.g. GENERAL/SUPPLY/TOOL/CONSUME. Used by UI filters and future seeds.';
COMMENT ON COLUMN stock_categories.name     IS 'Thai display name shown in admin UI.';
COMMENT ON COLUMN stock_categories.active   IS 'Soft delete flag. Inactive rows hidden from pickers but kept for historical FK integrity.';
COMMENT ON COLUMN stock_categories.sort_order IS 'Manual display ordering in admin pickers.';

-- Seed the 4 baseline categories. Idempotent via ON CONFLICT on UNIQUE(code).
INSERT INTO stock_categories(code, name, sort_order) VALUES
  ('GENERAL', 'ทั่วไป',          10),
  ('SUPPLY',  'วัสดุสิ้นเปลือง',  20),
  ('TOOL',    'อุปกรณ์ใช้ซ้ำ',    30),
  ('CONSUME', 'ของใช้แล้วทิ้ง',    40)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- Verification SQL (run in Supabase SQL editor after applying)
-- ============================================================
-- 1) Table exists with expected columns:
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name='stock_categories' ORDER BY ordinal_position;
--
-- 2) Seed rows present and ordered:
--    SELECT code, name, sort_order FROM stock_categories ORDER BY sort_order;
--    -- expected: GENERAL, SUPPLY, TOOL, CONSUME
--
-- 3) UNIQUE(code) enforced:
--    INSERT INTO stock_categories(code, name) VALUES ('GENERAL','dup');
--    -- expected: ERROR duplicate key on stock_categories_code_key
