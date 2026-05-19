-- supabase/migrations/20260519070600_migrate_cabinet_to_storage.sql
-- Phase 0.7 — Data Migration
-- Decisions: D1 (cabinet → storage rename), D7 (cabinet enum value kept as deprecated), spec §6
-- Depends on: 20260519070000_location_type_extend.sql (type='storage' exists)
--             20260519070100_location_storage_style.sql (storage_style column exists)
--             20260519070200_location_parent_rules.sql (trigger — must fire AFTER this data fix,
--               so this migration runs LAST in the set; parent rules are valid for storage too)
--
-- Assumptions:
--   Postgres 15.
--   All existing cabinet rows have parent in ('room','ambulance') — validates automatically
--     because trigger chk_location_parent_rules treats storage same as cabinet.
--   storage_style='closed' is the conservative default for legacy cabinets (D1: closed cabinet).
--   Rollback: UPDATE locations SET type='cabinet' WHERE type='storage' AND storage_style='closed'
--   (lossy — any storage that was already open/mesh before this migration is indistinguishable,
--    but Phase 0 had no open/mesh rows.)

DO $migrate$
DECLARE
  v_cab_count int;
BEGIN
  SELECT count(*) INTO v_cab_count
  FROM locations
  WHERE type = 'cabinet';

  RAISE NOTICE 'Phase 0.7 data migration: found % cabinet row(s) to convert to storage', v_cab_count;

  UPDATE locations
  SET    type          = 'storage',
         storage_style = COALESCE(storage_style, 'closed')
  WHERE  type = 'cabinet';

  RAISE NOTICE 'Phase 0.7 data migration complete: % row(s) updated', v_cab_count;
END
$migrate$;

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- A) No cabinet rows remain:
--    SELECT count(*) FROM locations WHERE type = 'cabinet';
--    Expected: 0
--
-- B) Migrated rows have storage_style='closed':
--    SELECT id, name, type, storage_style
--    FROM locations
--    WHERE type = 'storage' AND storage_style = 'closed'
--    ORDER BY name;
--    Expected: all former cabinet rows appear here
--
-- C) No storage rows missing storage_style (should all be 'closed' from migration):
--    SELECT count(*) FROM locations WHERE type = 'storage' AND storage_style IS NULL;
--    Expected: 0  (unless admin added a storage row without storage_style before this migration)
