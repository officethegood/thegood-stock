-- supabase/migrations/20260520010000_lookup_lists.sql
-- Phase 0.7 D14 — Generic user-managed taxonomy lookup table.
--
-- Replaces three hardcoded taxonomies with a single admin-editable table:
--   kind='linen_subcategory' — was a Postgres ENUM
--   kind='tank_size'         — was text CHECK constraint on oxygen_tanks
--   kind='storage_style'     — was FE-enforced only (no DB constraint existed)
--
-- Assumptions:
--   Postgres 15 (Supabase default).
--   Extensions: pgcrypto (gen_random_uuid) — already enabled in 20260518000000_init.sql.
--   set_updated_at() trigger helper — already created in 20260518000000_init.sql.
--   app_user_role() helper — already created in 20260518000000_init.sql.
--   Secret names: none used in this migration.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING for seeds,
--             CREATE INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS / CREATE TRIGGER.

-- ==========================================================================
-- 1. CREATE TABLE
-- ==========================================================================

CREATE TABLE IF NOT EXISTS lookup_lists (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL,
    -- Discriminator: 'linen_subcategory' | 'storage_style' | 'tank_size'
    -- (and any future taxonomy the admin defines without a migration).
  code        text        NOT NULL,
    -- Machine value stored in the referencing column (e.g. 'sheet', 'small').
    -- Application and DB columns store this value; `name` is display-only.
  name        text        NOT NULL,
    -- Thai display label shown in the UI (e.g. 'ผ้าปูที่นอน').
  sort_order  int         NOT NULL DEFAULT 0,
    -- Controls display order within a kind. Lower = first.
  active      boolean     NOT NULL DEFAULT true,
    -- Soft-delete: set active=false to hide a value without breaking historical rows
    -- that already reference the code.
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, code)
    -- Ensures each (kind, code) pair appears at most once.
    -- ON CONFLICT (kind, code) used in seed inserts below.
);

COMMENT ON TABLE lookup_lists IS
  'Phase 0.7 D14 — Generic user-managed taxonomy table. '
  'Each row is one selectable value for a named kind (linen_subcategory, storage_style, tank_size). '
  'Admin can add/edit/delete rows via the UI without a developer migration. '
  'Referencing columns store the `code` value (text); `name` is the Thai display label. '
  'Set active=false to retire a value without breaking historical data.';

COMMENT ON COLUMN lookup_lists.kind        IS 'Taxonomy discriminator, e.g. ''linen_subcategory'', ''storage_style'', ''tank_size''.';
COMMENT ON COLUMN lookup_lists.code        IS 'Machine value stored in referencing columns. Immutable after first use.';
COMMENT ON COLUMN lookup_lists.name        IS 'Thai display label shown in UI dropdowns and reports.';
COMMENT ON COLUMN lookup_lists.sort_order  IS 'Ascending display order within a kind. Default 0.';
COMMENT ON COLUMN lookup_lists.active      IS 'false = soft-deleted. Existing rows referencing this code are preserved.';

-- ==========================================================================
-- 2. INDEX
-- ==========================================================================

CREATE INDEX IF NOT EXISTS idx_lookup_lists_kind_active_sort
  ON lookup_lists (kind, active, sort_order);
  -- Supports the canonical FE query:
  --   SELECT * FROM lookup_lists WHERE kind = $1 AND active = true ORDER BY sort_order

-- ==========================================================================
-- 3. updated_at TRIGGER
-- ==========================================================================

DROP TRIGGER IF EXISTS trg_lookup_lists_updated_at ON lookup_lists;
CREATE TRIGGER trg_lookup_lists_updated_at
  BEFORE UPDATE ON lookup_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==========================================================================
-- 4. SEED current values
--    ON CONFLICT DO NOTHING — idempotent on re-run.
-- ==========================================================================

-- kind = 'linen_subcategory' (6 values — matches Phase 6 enum including pillowcase)
INSERT INTO lookup_lists (kind, code, name, sort_order) VALUES
  ('linen_subcategory', 'sheet',      'ผ้าปูที่นอน',       1),
  ('linen_subcategory', 'blanket',    'ผ้าห่ม',            2),
  ('linen_subcategory', 'towel',      'ผ้าขนหนู',          3),
  ('linen_subcategory', 'gown',       'เสื้อกาวน์',        4),
  ('linen_subcategory', 'wipe',       'ผ้าเช็ดเครื่องมือ', 5),
  ('linen_subcategory', 'pillowcase', 'ปลอกหมอน',          6)
ON CONFLICT (kind, code) DO NOTHING;

-- kind = 'storage_style' (4 values — previously FE-enforced only)
INSERT INTO lookup_lists (kind, code, name, sort_order) VALUES
  ('storage_style', 'closed', 'ตู้ปิด/ลิ้นชัก',      1),
  ('storage_style', 'open',   'ชั้นเปิด',             2),
  ('storage_style', 'mesh',   'ตะแกรง',               3),
  ('storage_style', 'drawer', 'ลิ้นชักหลายชั้น',      4)
ON CONFLICT (kind, code) DO NOTHING;

-- kind = 'tank_size' (3 values — previously text CHECK on oxygen_tanks)
INSERT INTO lookup_lists (kind, code, name, sort_order) VALUES
  ('tank_size', 'small',  'เล็ก',  1),
  ('tank_size', 'medium', 'กลาง',  2),
  ('tank_size', 'large',  'ใหญ่',  3)
ON CONFLICT (kind, code) DO NOTHING;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
--
-- A) Table and column structure:
--    SELECT column_name, data_type, is_nullable, column_default
--    FROM information_schema.columns
--    WHERE table_name = 'lookup_lists'
--    ORDER BY ordinal_position;
--    Expected: 8 columns (id, kind, code, name, sort_order, active, created_at, updated_at)
--
-- B) Seed counts:
--    SELECT kind, count(*) FROM lookup_lists GROUP BY kind ORDER BY kind;
--    Expected:
--      linen_subcategory | 6
--      storage_style     | 4
--      tank_size         | 3
--
-- C) Index exists:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'lookup_lists' AND indexname = 'idx_lookup_lists_kind_active_sort';
--    Expected: 1 row
--
-- D) Trigger exists:
--    SELECT trigger_name FROM information_schema.triggers
--    WHERE trigger_name = 'trg_lookup_lists_updated_at';
--    Expected: 1 row
--
-- E) UNIQUE constraint blocks duplicate (kind, code):
--    BEGIN;
--    INSERT INTO lookup_lists (kind, code, name) VALUES ('linen_subcategory', 'sheet', 'ทดสอบ');
--    -- Expected: ERROR duplicate key value violates unique constraint
--    ROLLBACK;
