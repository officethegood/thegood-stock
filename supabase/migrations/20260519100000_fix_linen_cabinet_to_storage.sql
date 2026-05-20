-- supabase/migrations/20260519100000_fix_linen_cabinet_to_storage.sql
-- Phase 0.7 hotfix: linen system regression after cabinet→storage type rename.
--
-- What regressed:
--   20260519070600_migrate_cabinet_to_storage.sql ran
--   UPDATE locations SET type='storage' WHERE type='cabinet',
--   leaving no rows with type='cabinet'.
--
-- Why this breaks Phase 6:
--   1) v_linen_audit had WHERE l.type = 'cabinet' → always 0 rows → admin
--      "ผ้า" filter showed "ยังไม่มีสินค้าหมวดผ้าในระบบ" even when linen exists.
--   2) validate_linen_count_location() raised EXCEPTION for any INSERT into
--      linen_counts because no location has type='cabinet' anymore.
--
-- Fix: accept BOTH 'storage' and 'cabinet' in both objects so the system
-- remains forward-compatible with any legacy 'cabinet' rows that might exist.
-- ==========================================================================

-- ==========================================================================
-- 1) Recreate validation trigger function
--    Change: type check from  v_type IS DISTINCT FROM 'cabinet'
--            to               v_type NOT IN ('storage','cabinet')
--    Change: Thai error message reflects new accepted types.
--    Everything else (LINEN-category check, SECURITY INVOKER) is identical.
-- ==========================================================================

CREATE OR REPLACE FUNCTION validate_linen_count_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_type location_type;
BEGIN
  -- Check: location must be type='storage' (or legacy 'cabinet')
  SELECT type INTO v_type FROM locations WHERE id = NEW.location_id;
  IF v_type NOT IN ('storage','cabinet') THEN
    RAISE EXCEPTION 'linen_counts สามารถบันทึกได้เฉพาะตู้/ชั้นเก็บของ (storage) เท่านั้น — location_id % ไม่ใช่ storage', NEW.location_id;
  END IF;

  -- Check: item must be in LINEN category
  IF NOT EXISTS (
    SELECT 1
    FROM stock_items si
    JOIN stock_categories sc ON sc.id = si.category_id
    WHERE si.id = NEW.item_id AND sc.code = 'LINEN'
  ) THEN
    RAISE EXCEPTION 'linen_counts รองรับเฉพาะสินค้าหมวด LINEN — item_id % ไม่ใช่ LINEN', NEW.item_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger binding: CREATE OR REPLACE FUNCTION above rebinds automatically.
-- Explicit DROP/CREATE kept here (matching original idempotent pattern) so
-- a fresh install also works correctly.
DROP TRIGGER IF EXISTS trg_linen_count_validate ON linen_counts;
CREATE TRIGGER trg_linen_count_validate
  BEFORE INSERT ON linen_counts
  FOR EACH ROW EXECUTE FUNCTION validate_linen_count_location();

-- ==========================================================================
-- 2) Recreate v_linen_audit
--    Change: WHERE l.type = 'cabinet'
--            to    WHERE l.type IN ('storage','cabinet')
--    Everything else (CTEs, columns, discrepancy formula, COMMENT) identical.
-- ==========================================================================

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

-- Original migration did not GRANT SELECT on this view; no GRANT added here.

-- ==========================================================================
-- Verification SQL (paste each block separately in Dashboard SQL Editor)
-- ==========================================================================
--
-- A) View returns rows when linen items exist at storage locations:
--    SELECT count(*) FROM v_linen_audit;
--    Expected: >= 0 (will be > 0 if LINEN items are assigned to storage locations)
--
-- B) Confirm function body now contains 'storage':
--    SELECT prosrc FROM pg_proc WHERE proname = 'validate_linen_count_location';
--    Expected: text contains "NOT IN ('storage','cabinet')"
--
-- C) Trigger still registered:
--    SELECT trigger_name, event_manipulation, event_object_table
--    FROM information_schema.triggers
--    WHERE trigger_name = 'trg_linen_count_validate';
--    Expected: 1 row, event_object_table = 'linen_counts'
--
-- D) Type guard still rejects non-storage/non-cabinet (run in transaction):
--    BEGIN;
--    INSERT INTO linen_counts(location_id, item_id, counted_qty)
--    SELECT l.id, (SELECT id FROM stock_items WHERE sku='LINEN-SHEET-001'), 5
--    FROM locations l WHERE l.type NOT IN ('storage','cabinet') LIMIT 1;
--    -- Expected: ERROR 'linen_counts สามารถบันทึกได้เฉพาะตู้/ชั้นเก็บของ (storage) เท่านั้น'
--    ROLLBACK;
