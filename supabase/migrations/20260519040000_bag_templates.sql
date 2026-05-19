-- supabase/migrations/20260519040000_bag_templates.sql
-- Phase 4 — bag_templates + bag_template_items tables.
--
-- Spec refs:
--   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §5.1
--   docs/superpowers/specs/2026-05-19-phase4-decisions-locked.md Q-Phase4-A (no seed rows)
--
-- Design principles enforced here:
--   - Bags ARE locations (Phase 0 type='bag' enum). This file defines the TEMPLATE concept,
--     not individual bags. Individual bags are rows in `locations` (see 20260519040200).
--   - Templates start empty; Admin creates them via UI (Q-Phase4-A).
--   - bag_template_items.target_qty is advisory (not an enforced DB constraint on movements).
--   - ON DELETE CASCADE on bag_template_items so deleting a template cleans up its items.
--   - ON DELETE RESTRICT on bag_template_items.item_id to protect stock_items rows.
--
-- Idempotent: IF NOT EXISTS guards + dollar-quoted DO blocks.

-- ==========================================================================
-- SECTION 1: bag_templates
-- ==========================================================================

CREATE TABLE IF NOT EXISTS bag_templates (
  id          uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text     UNIQUE NOT NULL,       -- e.g. 'TPL-ALS-ADULT', 'TPL-TRAUMA-01'
  name        text     NOT NULL,              -- human name; Thai OK
  category    text     NOT NULL DEFAULT 'ALS', -- free text tag: ALS, Trauma, Pediatric
  description text,
  active      boolean  NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text     NOT NULL DEFAULT app_username(),
  updated_by  text
);

COMMENT ON TABLE bag_templates IS
  'Phase 4. Defines the expected contents of a bag type. One template can be shared by many '
  'bag-locations (locations.type=''bag''). Admin creates via UI — no seed rows in migration '
  '(Q-Phase4-A: clinical data evolves, SQL seeds become stale).';

COMMENT ON COLUMN bag_templates.code IS
  'Unique short code for this template. e.g. TPL-ALS-ADULT. Printed on admin UI; '
  'not on physical bag (physical bag uses locations.code, e.g. BAG-ALS-001).';

COMMENT ON COLUMN bag_templates.active IS
  'Soft-delete flag. Inactive templates cannot be assigned to new bags but existing '
  'assignments are preserved.';

DO $trg_bag_templates$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_bag_templates_updated_at'
  ) THEN
    CREATE TRIGGER trg_bag_templates_updated_at
      BEFORE UPDATE ON bag_templates
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$trg_bag_templates$;

-- ==========================================================================
-- SECTION 2: bag_template_items
-- ==========================================================================

CREATE TABLE IF NOT EXISTS bag_template_items (
  id               uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_template_id  uuid     NOT NULL REFERENCES bag_templates(id) ON DELETE CASCADE,
  item_id          uuid     NOT NULL REFERENCES stock_items(id)   ON DELETE RESTRICT,
  target_qty       int      NOT NULL CHECK (target_qty > 0),
  mandatory        boolean  NOT NULL DEFAULT true,
  sort_order       int      NOT NULL DEFAULT 0,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bag_template_id, item_id)    -- one row per (template, item) pair
);

COMMENT ON TABLE bag_template_items IS
  'Phase 4. Expected sub-items per template. target_qty is advisory — the system flags '
  'deficits but does not block stock_movements. ON DELETE CASCADE from bag_templates.';

COMMENT ON COLUMN bag_template_items.mandatory IS
  'If true, a shortfall makes v_bag_status.alert_level = ''low_stock''. '
  'If false, shortfall is informational only.';

COMMENT ON COLUMN bag_template_items.sort_order IS
  'Display order within the template; Admin-editable via drag-and-drop in UI. '
  'Within same sort_order, alphabetical by item name.';

CREATE INDEX IF NOT EXISTS idx_bti_template ON bag_template_items(bag_template_id);
CREATE INDEX IF NOT EXISTS idx_bti_item     ON bag_template_items(item_id);

-- ==========================================================================
-- Verification SQL (run in Supabase SQL Editor after applying)
-- ==========================================================================
-- 1) Tables created:
--    SELECT tablename FROM pg_tables
--    WHERE schemaname='public' AND tablename IN ('bag_templates','bag_template_items');
--    -- Expected: 2 rows
--
-- 2) UNIQUE constraints:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='bag_templates'::regclass AND contype='u';
--    -- Expected: bag_templates_code_key
--
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='bag_template_items'::regclass AND contype='u';
--    -- Expected: bag_template_items_bag_template_id_item_id_key
--
-- 3) ON DELETE CASCADE on bag_template_items:
--    SELECT confdeltype FROM pg_constraint
--    WHERE conname='bag_template_items_bag_template_id_fkey';
--    -- Expected: 'c' (CASCADE)
--
-- 4) Updated_at trigger:
--    SELECT tgname FROM pg_trigger WHERE tgrelid='bag_templates'::regclass;
--    -- Expected: trg_bag_templates_updated_at
--
-- 5) app_username() default:
--    SELECT column_default FROM information_schema.columns
--    WHERE table_name='bag_templates' AND column_name='created_by';
--    -- Expected: contains app_username()
