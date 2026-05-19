-- supabase/migrations/20260519070100_location_storage_style.sql
-- Phase 0.7 — Location Hierarchy Refactor
-- Decisions: D1 (storage visual hint via storage_style text column)
-- Depends on: 20260519070000_location_type_extend.sql (type='storage' exists)
--
-- Assumptions:
--   Postgres 15. No NOT NULL — legacy cabinet rows need storage_style=NULL until
--   20260519070600_migrate_cabinet_to_storage.sql fills it in.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS storage_style text;

COMMENT ON COLUMN locations.storage_style IS
  'Phase 0.7. Visual hint สำหรับ type=storage เท่านั้น. '
  'ค่าที่ FE ใช้: closed (ตู้ปิด/ลิ้นชัก), open (ชั้นเปิด), mesh (ตะแกรง), drawer (ลิ้นชัก). '
  'NULL ถ้า type≠storage. ไม่บังคับ NOT NULL เพื่อให้ migration legacy data ทำได้';

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'locations' AND column_name = 'storage_style';
-- Expected: storage_style | text | YES
