-- supabase/migrations/20260519060100_linen_subcategory_enum.sql
-- Phase 6 — Linens & Laundry: linen_subcategory enum type.
--
-- Decisions-locked (docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md):
--   Q6-D — Sub-category = enum column, 5 initial values:
--           sheet / blanket / towel / gown / wipe
--
-- Thai display labels (UX §7.1, spec §5.1):
--   sheet   → ผ้าปูที่นอน
--   blanket → ผ้าห่ม
--   towel   → ผ้าขนหนู
--   gown    → เสื้อกาวน์
--   wipe    → ผ้าเช็ดเครื่องมือ
--
-- Idempotent: DO $$ DECLARE / IF NOT EXISTS guard.
-- Depends on: (no prior migration dependency)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'linen_subcategory') THEN
    CREATE TYPE linen_subcategory AS ENUM (
      'sheet',    -- ผ้าปูที่นอน
      'blanket',  -- ผ้าห่ม
      'towel',    -- ผ้าขนหนู
      'gown',     -- เสื้อกาวน์
      'wipe'      -- ผ้าเช็ดเครื่องมือ
    );
  END IF;
END;
$$;

COMMENT ON TYPE linen_subcategory IS
  'Phase 6 enum for linen sub-categories. '
  'Values: sheet (ผ้าปูที่นอน), blanket (ผ้าห่ม), towel (ผ้าขนหนู), '
  'gown (เสื้อกาวน์), wipe (ผ้าเช็ดเครื่องมือ). '
  'Adding a new value requires a migration (ALTER TYPE ... ADD VALUE).';

-- ============================================================
-- Verification SQL
-- ============================================================
-- SELECT typname, enumlabel
-- FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
-- WHERE typname = 'linen_subcategory'
-- ORDER BY e.enumsortorder;
-- Expected: 5 rows: sheet, blanket, towel, gown, wipe
