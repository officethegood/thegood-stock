-- supabase/migrations/20260519040200_locations_bag_template_link.sql
-- Phase 4 — ALTER TABLE locations ADD COLUMN bag_template_id.
--
-- Spec refs:
--   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §5.2
--   docs/superpowers/specs/2026-05-19-phase4-decisions-locked.md (derived #1)
--
-- Design principle:
--   Bags ARE locations (Phase 0 type='bag' enum already exists in locations table).
--   This column links a bag-location to its expected composition template.
--   Column is nullable: bags can exist without a template (alert_level = 'no_template').
--   Only meaningful when locations.type = 'bag', but the FK is not type-restricted at DB
--   level — logic is enforced in application layer / v_bag_status view.
--
-- Pre-condition: bag_templates table must exist (20260519040000 applied first).
--
-- Idempotent: DO block guards the ALTER with information_schema check.

DO $add_bag_template_id$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'locations'
      AND column_name  = 'bag_template_id'
  ) THEN
    ALTER TABLE locations
      ADD COLUMN bag_template_id uuid REFERENCES bag_templates(id) ON DELETE SET NULL;
  END IF;
END
$add_bag_template_id$;

COMMENT ON COLUMN locations.bag_template_id IS
  'Phase 4. FK to bag_templates. Non-null only for locations.type=''bag''. '
  'Admin assigns template when creating or editing a bag-location. '
  'ON DELETE SET NULL: deleting a template does not delete the bag-location, '
  'it just clears the template link (bag becomes no_template status).';

CREATE INDEX IF NOT EXISTS idx_locations_bag_template ON locations(bag_template_id)
  WHERE bag_template_id IS NOT NULL;

-- ==========================================================================
-- Verification SQL
-- ==========================================================================
-- 1) Column exists on locations:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='locations' AND column_name='bag_template_id';
--    -- Expected: 1 row, data_type='uuid', is_nullable='YES'
--
-- 2) FK exists with correct name:
--    SELECT conname, confdeltype FROM pg_constraint
--    WHERE conrelid='locations'::regclass AND contype='f'
--    AND conname LIKE '%bag_template_id%';
--    -- Expected: 1 row; confdeltype='a' (SET NULL)
--
-- 3) Existing bag-locations safely have NULL bag_template_id:
--    SELECT count(*) FROM locations WHERE type='bag' AND bag_template_id IS NULL;
--    -- Expected: count of existing bag-locations (no data loss — all NULL, safe)
--
-- 4) Partial index created:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename='locations' AND indexname='idx_locations_bag_template';
--    -- Expected: 1 row
