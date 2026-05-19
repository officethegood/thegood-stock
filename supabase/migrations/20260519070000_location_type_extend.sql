-- supabase/migrations/20260519070000_location_type_extend.sql
-- Phase 0.7 — Location Hierarchy Refactor
-- Decisions: D1 (storage alias for cabinet+rack), D2 (bin level), D3 (zone in bag)
-- Depends on: 20260518000100_locations.sql (enum location_type exists)
--
-- Assumptions:
--   Postgres 15, no extra extensions needed.
--   ALTER TYPE ... ADD VALUE IF NOT EXISTS is metadata-only — no table rewrite, safe on live data.
--   'cabinet' is NOT dropped (D7: kept as dead enum value for backward compat).

ALTER TYPE location_type ADD VALUE IF NOT EXISTS 'storage';  -- ตู้ + rack รวม (D1)
ALTER TYPE location_type ADD VALUE IF NOT EXISTS 'bin';      -- ตะกร้า ใน shelf (D2)
ALTER TYPE location_type ADD VALUE IF NOT EXISTS 'zone';     -- โซนใน bag (D3)

COMMENT ON TYPE location_type IS
  'Phase 0 values: room, cabinet, shelf, ambulance, bag. '
  'Phase 0.7 additions: storage (replaces cabinet per D1), bin (child of shelf per D2), zone (child of bag per D3). '
  '''cabinet'' retained as deprecated dead value (D7) — FE hides it from dropdowns.';

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = 'location_type'::regtype
-- ORDER BY enumsortorder;
-- Expected: room, cabinet, shelf, ambulance, bag, storage, bin, zone  (8 rows, order may vary)
