-- supabase/migrations/20260519060200_stock_items_subcategory.sql
-- Phase 6 — Linens & Laundry: add linen_subcategory column to stock_items.
--
-- Decisions-locked (docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md):
--   Derived #2 — ALTER TABLE stock_items ADD COLUMN linen_subcategory linen_subcategory (nullable)
--   Only set when category=LINEN; non-LINEN items stay NULL.
--   Constraint enforces: LINEN items MUST have subcategory; non-LINEN must NOT.
--
-- Seeded linen items: 5 standard types (one per subcategory).
-- Admin will add real per-cabinet items; these are examples only.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DO $$ for constraint + ON CONFLICT DO NOTHING for seeds.
-- Depends on: stock_items table (Phase 1), stock_categories (Phase 1),
--             linen_subcategory enum (20260519060100), LINEN category seed (20260519060000).

-- ==========================================================================
-- 1) Add column (nullable)
-- ==========================================================================

ALTER TABLE stock_items
  ADD COLUMN IF NOT EXISTS linen_subcategory linen_subcategory;

-- ==========================================================================
-- 2) Constraint: LINEN items must have subcategory; non-LINEN must not
-- ==========================================================================

-- NOTE (deploy fix 2026-05-19): Postgres rejects subquery in CHECK constraint
-- (ERROR 0A000). Replaced with BEFORE INSERT/UPDATE trigger that does the same
-- validation. Live DB has the trigger-based version below; the original CHECK
-- attempt is preserved in commit history but never reached production.

CREATE OR REPLACE FUNCTION validate_linen_subcategory()
RETURNS trigger
LANGUAGE plpgsql
AS $vs$
DECLARE
  v_linen_cat_id uuid;
BEGIN
  SELECT id INTO v_linen_cat_id FROM stock_categories WHERE code = 'LINEN';
  IF NEW.category_id = v_linen_cat_id AND NEW.linen_subcategory IS NULL THEN
    RAISE EXCEPTION 'สินค้าหมวด LINEN ต้องระบุ linen_subcategory';
  END IF;
  IF NEW.category_id IS DISTINCT FROM v_linen_cat_id AND NEW.linen_subcategory IS NOT NULL THEN
    RAISE EXCEPTION 'linen_subcategory ใช้ได้เฉพาะหมวด LINEN';
  END IF;
  RETURN NEW;
END;
$vs$;

DROP TRIGGER IF EXISTS trg_validate_linen_subcategory ON stock_items;
CREATE TRIGGER trg_validate_linen_subcategory
  BEFORE INSERT OR UPDATE ON stock_items
  FOR EACH ROW EXECUTE FUNCTION validate_linen_subcategory();

-- ==========================================================================
-- 3) Seed 5 example linen items (one per subcategory)
--    Admin replaces/adds per their actual inventory.
--    unit = ผืน for all except gown (ตัว).
-- ==========================================================================

DO $$
DECLARE
  v_linen_cat_id uuid;
BEGIN
  SELECT id INTO v_linen_cat_id FROM stock_categories WHERE code = 'LINEN';

  IF v_linen_cat_id IS NULL THEN
    RAISE EXCEPTION 'LINEN category not found — run 20260519060000_linen_category.sql first';
  END IF;

  INSERT INTO stock_items(sku, name, category_id, unit, reorder_threshold, linen_subcategory, note)
  VALUES
    ('LINEN-SHEET-001',   'ผ้าปูที่นอน',        v_linen_cat_id, 'ผืน', 0, 'sheet',   'ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-BLANKET-001', 'ผ้าห่ม',             v_linen_cat_id, 'ผืน', 0, 'blanket', 'ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-TOWEL-001',   'ผ้าขนหนู',           v_linen_cat_id, 'ผืน', 0, 'towel',   'ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-GOWN-001',    'เสื้อกาวน์',         v_linen_cat_id, 'ตัว', 0, 'gown',    'ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-WIPE-001',    'ผ้าเช็ดเครื่องมือ', v_linen_cat_id, 'ผืน', 0, 'wipe',    'ตัวอย่าง — ปรับแก้ตามจริง')
  ON CONFLICT (sku) DO NOTHING;
END;
$$;

COMMENT ON COLUMN stock_items.linen_subcategory IS
  'Phase 6: sub-category for LINEN items only. '
  'Constraint chk_linen_subcategory enforces: LINEN items must have this set; '
  'non-LINEN items must have NULL. Values from linen_subcategory enum.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Column exists:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_name='stock_items' AND column_name='linen_subcategory';
--    Expected: 1 row, is_nullable=YES
--
-- 2) Seed items present:
--    SELECT sku, name, linen_subcategory
--    FROM stock_items
--    WHERE category_id = (SELECT id FROM stock_categories WHERE code='LINEN')
--    ORDER BY sku;
--    Expected: 5 rows (LINEN-SHEET-001, LINEN-BLANKET-001, LINEN-TOWEL-001, LINEN-GOWN-001, LINEN-WIPE-001)
--
-- 3) Constraint test (run in transaction, then ROLLBACK):
--    BEGIN;
--    INSERT INTO stock_items(sku, name, category_id, unit, reorder_threshold)
--    VALUES ('TEST-LINEN-NO-SUB', 'test', (SELECT id FROM stock_categories WHERE code='LINEN'), 'ผืน', 0);
--    -- Expected: ERROR chk_linen_subcategory
--    ROLLBACK;
