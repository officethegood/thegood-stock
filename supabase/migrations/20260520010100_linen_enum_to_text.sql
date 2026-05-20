-- supabase/migrations/20260520010100_linen_enum_to_text.sql
-- Phase 0.7 D14 — Convert stock_items.linen_subcategory from enum → text,
--                  drop oxygen_tanks tank_size CHECK constraint.
--
-- Background:
--   linen_subcategory was declared as the Postgres ENUM type `linen_subcategory`
--   (created in 20260519060100). Two views depend on the column; they must be
--   dropped and recreated. The ENUM type itself is left orphaned (harmless) to
--   avoid accidental DROP failures on Supabase shared infrastructure.
--
--   oxygen_tanks.tank_size had CHECK (tank_size IN ('small','medium','large')).
--   That constraint is dropped; values are now validated against lookup_lists
--   at the application layer (same pattern as storage_style was already using).
--
-- Depends on:
--   20260518010100_stock_items.sql         (stock_items table)
--   20260519060100_linen_subcategory_enum  (defines the enum type)
--   20260519060200_stock_items_subcategory (adds the enum column + trigger)
--   20260519060300_linen_counts.sql        (linen_counts table)
--   20260519090000_laundry_role.sql        (defines v_linen_state_summary — source of truth)
--   20260519100000_fix_linen_cabinet_to_storage.sql (defines v_linen_audit — source of truth)
--   20260519050200_oxygen_tanks.sql        (defines oxygen_tanks_tank_size_check)
--   20260520010000_lookup_lists.sql        (must run first — seeds the lookup values)
--
-- Assumptions:
--   Postgres 15 (Supabase default).
--   `validate_linen_subcategory()` trigger body contains NO ::linen_subcategory cast
--   (verified: it only compares category_id and checks NULL) — no trigger rewrite needed.
--   The linen_subcategory ENUM type is kept (not dropped) — orphaning is safe.
--
-- Idempotent:
--   DROP VIEW IF EXISTS — safe on re-run.
--   ALTER COLUMN TYPE with USING — safe if column already text (Postgres will no-op
--   the cast; column definition check handled by IF NOT EXISTS guard below is not
--   available on ALTER COLUMN, but the USING cast text::text is a no-op, so re-running
--   after the first apply produces no error in practice).
--   DROP CONSTRAINT IF EXISTS — safe on re-run.

-- ==========================================================================
-- PART A: Convert stock_items.linen_subcategory  enum → text
-- ==========================================================================

-- Step 1: Drop the two views that reference the column
--   Source of v_linen_audit:        20260519100000_fix_linen_cabinet_to_storage.sql
--   Source of v_linen_state_summary: 20260519090000_laundry_role.sql

DROP VIEW IF EXISTS v_linen_audit;
DROP VIEW IF EXISTS v_linen_state_summary;

-- Step 2: Alter the column type from linen_subcategory enum to text
--   USING clause casts enum value to its text label (the code string, e.g. 'sheet').
--   This preserves all existing data: enum 'sheet' → text 'sheet'.

ALTER TABLE stock_items
  ALTER COLUMN linen_subcategory TYPE text USING linen_subcategory::text;

-- Update column comment to reflect new type.
COMMENT ON COLUMN stock_items.linen_subcategory IS
  'Phase 6/D14: sub-category for LINEN items only (text, was enum). '
  'Values are codes from lookup_lists WHERE kind=''linen_subcategory'' AND active=true. '
  'Constraint: LINEN items must have this set; non-LINEN items must have NULL '
  '(enforced by trg_validate_linen_subcategory trigger).';

-- Step 3: Recreate v_linen_audit
--   Body copied EXACTLY from 20260519100000_fix_linen_cabinet_to_storage.sql.
--   No changes to logic; the column is still named linen_subcategory and the
--   view reads it as text (was already read as text in the SELECT list — no cast used).

CREATE OR REPLACE VIEW v_linen_audit AS
WITH latest_counts AS (
  SELECT DISTINCT ON (location_id, item_id)
    location_id,
    item_id,
    counted_qty,
    counted_at,
    counted_by,
    photo_url
  FROM linen_counts
  ORDER BY location_id, item_id, counted_at DESC
),
audit_settings AS (
  SELECT
    COALESCE(
      (SELECT value::numeric FROM settings WHERE key = 'LINEN_DISCREPANCY_PCT'),
      (SELECT value::numeric FROM settings WHERE key = 'LINEN_AUDIT_THRESHOLD_PCT'),
      5
    ) AS threshold_pct,
    COALESCE(
      (SELECT value::int FROM settings WHERE key = 'LINEN_DISCREPANCY_MIN'),
      (SELECT value::int FROM settings WHERE key = 'LINEN_AUDIT_MIN_PIECES'),
      2
    ) AS min_pieces
  FROM (SELECT 1) _
),
combined AS (
  SELECT
    l.id          AS location_id,
    l.code        AS location_code,
    l.name        AS location_name,
    si.id         AS item_id,
    si.sku,
    si.name       AS item_name,
    si.linen_subcategory,
    sil.qty       AS current_qty,
    lc.counted_qty,
    lc.counted_at,
    lc.counted_by,
    lc.photo_url,
    (sil.qty - COALESCE(lc.counted_qty, sil.qty))       AS delta,
    ABS(sil.qty - COALESCE(lc.counted_qty, sil.qty))    AS abs_delta,
    s.threshold_pct,
    s.min_pieces,
    CASE
      WHEN lc.counted_at IS NULL THEN false  -- no count yet; do not flag (T165)
      WHEN ABS(sil.qty - lc.counted_qty) >
           GREATEST(
             CEIL(sil.qty * s.threshold_pct / 100.0),
             s.min_pieces
           )
      THEN true
      ELSE false
    END AS is_discrepancy
  FROM locations l
  JOIN stock_item_locations sil ON sil.location_id = l.id
  JOIN stock_items si           ON si.id = sil.item_id
  JOIN stock_categories sc      ON sc.id = si.category_id AND sc.code = 'LINEN'
  LEFT JOIN latest_counts lc    ON lc.location_id = l.id AND lc.item_id = si.id
  CROSS JOIN audit_settings s
  WHERE l.type   IN ('storage','cabinet')
    AND l.active = true
    AND si.active = true
)
SELECT * FROM combined;

COMMENT ON VIEW v_linen_audit IS
  'Phase 6: linen audit view. Shows most recent count per (cabinet, linen item) vs '
  'current stock_item_locations.qty. is_discrepancy=true when abs_delta exceeds '
  'GREATEST(CEIL(qty * threshold_pct/100), min_pieces). '
  'threshold_pct and min_pieces read from settings table with COALESCE defaults (5, 2).';

-- Note: 20260519100000 carried no GRANT on v_linen_audit — none added here either.

-- Step 4: Recreate v_linen_state_summary
--   Body copied EXACTLY from 20260519090000_laundry_role.sql.
--   No changes; the view does not reference linen_subcategory at all.

CREATE OR REPLACE VIEW v_linen_state_summary AS
SELECT
  si.id                                                                      AS item_id,
  si.sku,
  si.name,
  COALESCE(SUM(sil.qty) FILTER (WHERE l.laundry_role = 'clean'),    0)      AS qty_clean,
  COALESCE(SUM(sil.qty) FILTER (WHERE l.laundry_role = 'vehicle'),  0)      AS qty_vehicle,
  COALESCE(SUM(sil.qty) FILTER (WHERE l.laundry_role = 'dirty'),    0)      AS qty_dirty,
  COALESCE(SUM(sil.qty) FILTER (WHERE l.laundry_role = 'external'), 0)      AS qty_external,
  COALESCE(SUM(sil.qty), 0)                                                  AS qty_total
FROM   stock_items si
LEFT   JOIN stock_item_locations sil ON sil.item_id = si.id
LEFT   JOIN locations            l   ON l.id = sil.location_id
WHERE  si.active = true
  AND  si.category_id = (SELECT id FROM stock_categories WHERE code = 'LINEN')
GROUP  BY si.id, si.sku, si.name
ORDER  BY si.sku;

GRANT SELECT ON v_linen_state_summary TO authenticated;

-- ==========================================================================
-- PART B: Drop oxygen_tanks tank_size CHECK constraint
-- ==========================================================================
-- Constraint name confirmed in 20260519050200_oxygen_tanks.sql (auto-named by Postgres):
--   CHECK (tank_size IN ('small', 'medium', 'large'))
--   Auto-name: oxygen_tanks_tank_size_check

ALTER TABLE oxygen_tanks DROP CONSTRAINT IF EXISTS oxygen_tanks_tank_size_check;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
--
-- A) linen_subcategory column is now text (not enum):
--    SELECT column_name, data_type, udt_name
--    FROM information_schema.columns
--    WHERE table_name = 'stock_items' AND column_name = 'linen_subcategory';
--    Expected: data_type = 'text', udt_name = 'text'
--
-- B) Existing linen items still have their subcategory codes (not NULL, not garbage):
--    SELECT sku, linen_subcategory
--    FROM stock_items
--    WHERE category_id = (SELECT id FROM stock_categories WHERE code = 'LINEN')
--    ORDER BY sku;
--    Expected: 6 rows with codes sheet/blanket/towel/gown/wipe/pillowcase intact
--
-- C) v_linen_audit is queryable and returns rows if linen items exist:
--    SELECT count(*) FROM v_linen_audit;
--    Expected: >= 0 (no error)
--
-- D) v_linen_state_summary is queryable:
--    SELECT count(*) FROM v_linen_state_summary;
--    Expected: >= 0 (no error)
--
-- E) linen subcategory trigger still fires:
--    BEGIN;
--    INSERT INTO stock_items(sku, name, category_id, unit, reorder_threshold)
--    VALUES ('D14-TEST-NO-SUB', 'ทดสอบ',
--            (SELECT id FROM stock_categories WHERE code='LINEN'), 'ผืน', 0);
--    -- Expected: ERROR 'สินค้าหมวด LINEN ต้องระบุ linen_subcategory'
--    ROLLBACK;
--
-- F) tank_size CHECK constraint is gone:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid = 'oxygen_tanks'::regclass AND conname = 'oxygen_tanks_tank_size_check';
--    Expected: 0 rows
--
-- G) oxygen_tanks can now accept a value outside the old CHECK (test then rollback):
--    BEGIN;
--    -- Only tests the constraint is gone; FK/NOT NULL still enforced.
--    UPDATE oxygen_tanks SET tank_size = 'extra_large' WHERE false;
--    -- No error expected (statement affects 0 rows but parses cleanly).
--    ROLLBACK;
