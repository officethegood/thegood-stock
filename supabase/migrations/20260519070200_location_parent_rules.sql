-- supabase/migrations/20260519070200_location_parent_rules.sql
-- Phase 0.7 — Location Hierarchy Refactor
-- Decisions: D1–D3 (parent-type matrix), spec §4.3
-- Depends on: 20260519070000_location_type_extend.sql (storage/bin/zone enum values exist)
--
-- Assumptions:
--   Postgres 15, pg_cron/pgcrypto not required here.
--   SECURITY DEFINER + SET search_path = 'public' per S-4 security baseline.
--   'room' and 'ambulance' are root types (parent_id IS NULL).
--   'bag' parent is optional (may float or live in room/storage/cabinet).
--   Pre-migration audit recommended before applying trigger:
--     SELECT id, type, parent_id FROM locations WHERE parent_id IS NOT NULL
--     AND (
--       (type IN ('storage','cabinet') AND (SELECT type FROM locations p WHERE p.id=parent_id) NOT IN ('room','ambulance'))
--       OR (type='shelf' AND (SELECT type FROM locations p WHERE p.id=parent_id) NOT IN ('storage','cabinet'))
--       OR (type='bin'   AND (SELECT type FROM locations p WHERE p.id=parent_id) <> 'shelf')
--       OR (type='zone'  AND (SELECT type FROM locations p WHERE p.id=parent_id) <> 'bag')
--     );

-- 1. CHECK constraint — enforces top-level parent_id presence rules
--    (deeper parent-type rules are in the trigger below)
DO $idempotent$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'locations'::regclass AND conname = 'chk_location_parent_rules'
  ) THEN
    ALTER TABLE locations
      ADD CONSTRAINT chk_location_parent_rules CHECK (
        (type = 'room'      AND parent_id IS NULL) OR
        (type = 'storage'   AND parent_id IS NOT NULL) OR   -- parent validated by trigger
        (type = 'cabinet'   AND parent_id IS NOT NULL) OR   -- legacy alias
        (type = 'shelf'     AND parent_id IS NOT NULL) OR
        (type = 'bin'       AND parent_id IS NOT NULL) OR
        (type = 'ambulance' AND parent_id IS NULL) OR
        (type = 'bag'       AND TRUE) OR                    -- bag parent OPTIONAL
        (type = 'zone'      AND parent_id IS NOT NULL)
      );
  END IF;
END
$idempotent$;

-- 2. Trigger function — validates parent-type matrix (beyond what CHECK can express)
CREATE OR REPLACE FUNCTION validate_location_parent_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $func$
DECLARE
  parent_type location_type;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;

  SELECT type INTO parent_type FROM locations WHERE id = NEW.parent_id;

  IF (NEW.type = 'storage'  AND parent_type NOT IN ('room', 'ambulance')) OR
     (NEW.type = 'cabinet'  AND parent_type NOT IN ('room', 'ambulance')) OR
     (NEW.type = 'shelf'    AND parent_type NOT IN ('storage', 'cabinet')) OR
     (NEW.type = 'bin'      AND parent_type <> 'shelf') OR
     (NEW.type = 'bag'      AND parent_type NOT IN ('room', 'storage', 'cabinet')) OR
     (NEW.type = 'zone'     AND parent_type <> 'bag')
  THEN
    RAISE EXCEPTION 'ตำแหน่ง type=% ไม่สามารถอยู่ภายใต้ type=% ได้', NEW.type, parent_type;
  END IF;

  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION validate_location_parent_type() IS
  'Phase 0.7. Enforces parent-type matrix for locations hierarchy. '
  'Fires BEFORE INSERT OR UPDATE OF parent_id, type. SECURITY DEFINER.';

-- 3. Trigger
DROP TRIGGER IF EXISTS trg_locations_parent_type ON locations;

CREATE TRIGGER trg_locations_parent_type
  BEFORE INSERT OR UPDATE OF parent_id, type ON locations
  FOR EACH ROW EXECUTE FUNCTION validate_location_parent_type();

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- A) Constraint exists:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='locations'::regclass AND conname='chk_location_parent_rules';
--    Expected: chk_location_parent_rules
--
-- B) Trigger exists:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid='locations'::regclass AND tgname='trg_locations_parent_type';
--    Expected: trg_locations_parent_type
--
-- C) Trigger blocks illegal parent (safe to run in BEGIN/ROLLBACK):
--    BEGIN;
--    INSERT INTO locations(code, name, type, parent_id)
--      -- first insert a shelf to get its id, then try a bin with parent=room:
--      -- this test assumes a room row exists; adapt ids as needed
--    SELECT 'WILL FAIL' FROM locations LIMIT 0; -- placeholder
--    ROLLBACK;
