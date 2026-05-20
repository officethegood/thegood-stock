-- supabase/migrations/20260520000000_linen_subcategory_pillowcase.sql
-- Phase 6 follow-up — add 'pillowcase' (ปลอกหมอน) to the linen_subcategory enum.
--
-- Reason: the initial Phase 6 enum (20260519060100) shipped 5 values
-- (sheet / blanket / towel / gown / wipe). Real-world linen includes
-- pillowcases, which staff were trying to record by renaming the
-- LINEN-WIPE-001 sample item — leaving its sub-category mismatched.
-- Adding the value lets the admin item form classify pillowcases correctly.
--
-- Thai display label (kept in sync in shared/linens.js SUBCATEGORY_LABELS):
--   pillowcase -> ปลอกหมอน
--
-- Idempotent: ADD VALUE IF NOT EXISTS.
-- Note: ALTER TYPE ... ADD VALUE cannot run inside an explicit transaction
-- block in some PG versions — apply this file on its own (the Supabase
-- Dashboard SQL editor runs it as a single autocommit statement).

ALTER TYPE linen_subcategory ADD VALUE IF NOT EXISTS 'pillowcase';

COMMENT ON TYPE linen_subcategory IS
  'Phase 6 enum for linen sub-categories. '
  'Values: sheet (ผ้าปูที่นอน), blanket (ผ้าห่ม), towel (ผ้าขนหนู), '
  'gown (เสื้อกาวน์), wipe (ผ้าเช็ดเครื่องมือ), pillowcase (ปลอกหมอน). '
  'Adding a new value requires a migration (ALTER TYPE ... ADD VALUE).';

-- ============================================================
-- Verification SQL
-- ============================================================
-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = 'linen_subcategory'::regtype
-- ORDER BY enumsortorder;
-- Expected: 6 rows — sheet, blanket, towel, gown, wipe, pillowcase
