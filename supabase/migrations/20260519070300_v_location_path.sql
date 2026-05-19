-- supabase/migrations/20260519070300_v_location_path.sql
-- Phase 0.7 — Location Hierarchy Refactor
-- Decisions: G1/G4 (hierarchy breadcrumb for FE), spec §4.4
-- Depends on: 20260519070000_location_type_extend.sql (new enum values)
--             20260519070200_location_parent_rules.sql (hierarchy enforced)
--
-- Assumptions:
--   Postgres 15. Max realistic depth = 5 (room→storage→shelf→bin→[item]).
--   depth cap = 6 as safety guard against accidental cycles.
--   GRANT SELECT to 'authenticated' only — matches RLS pattern from 20260518000600_rls_policies.sql.

CREATE OR REPLACE VIEW v_location_path AS
WITH RECURSIVE chain AS (
  -- Anchor: all root nodes (no parent)
  SELECT
    id,
    name,
    type,
    parent_id,
    ambulance_id,
    active,
    ARRAY[name]::text[]         AS path_names,
    ARRAY[type::text]::text[]   AS path_types,
    1                           AS depth
  FROM locations
  WHERE parent_id IS NULL

  UNION ALL

  -- Recursive step: join children to their parent chain
  SELECT
    l.id,
    l.name,
    l.type,
    l.parent_id,
    l.ambulance_id,
    l.active,
    c.path_names || l.name,
    c.path_types || l.type::text,
    c.depth + 1
  FROM locations l
  JOIN chain c ON l.parent_id = c.id
  WHERE c.depth < 6  -- safety cap; max realistic depth = 5
)
SELECT
  id,
  name,
  type,
  parent_id,
  active,
  path_names,
  path_types,
  array_to_string(path_names, ' › ') AS path_display,
  depth
FROM chain;

COMMENT ON VIEW v_location_path IS
  'Phase 0.7. Recursive CTE view that returns the full ancestor path for every location. '
  'path_display example: "ห้องยา › ตู้ A › ชั้น 3 › ตะกร้าฟ้า". '
  'depth=1 means root node (room or ambulance). Max depth capped at 6 to guard against cycles.';

GRANT SELECT ON v_location_path TO authenticated;

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- A) View exists:
--    SELECT viewname FROM pg_views WHERE viewname = 'v_location_path';
--    Expected: v_location_path
--
-- B) Returns rows with expected columns:
--    SELECT id, name, path_display, depth FROM v_location_path LIMIT 5;
--    Expected: rows where depth=1 have path_display = name (single node),
--              child rows show "Parent › Child" breadcrumb
--
-- C) Grant in effect (run as authenticated role):
--    SET ROLE authenticated;
--    SELECT count(*) FROM v_location_path;
--    RESET ROLE;
--    Expected: no permission error
