-- supabase/migrations/20260519060300_linen_counts.sql
-- Phase 6 — Linens & Laundry: linen_counts table + audit view.
--
-- Decisions-locked (docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md):
--   Derived #3 — New table linen_counts: periodic count snapshots per (cabinet, linen item).
--   Inserting a row does NOT change stock_item_locations.qty.
--   Snapshot is compared against current qty to detect discrepancies.
--
-- Also creates:
--   v_linen_audit   — most recent count per (location, item) vs current qty,
--                     with discrepancy flag using settings-based threshold.
--   trg_linen_count_validate — validates cabinet type + LINEN category on INSERT.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE for function/view.
-- Depends on: locations (Phase 0), stock_items (Phase 1), stock_item_locations (Phase 1),
--             stock_categories (Phase 1), settings (Phase 0),
--             app_username() / app_user_role() (Phase 0),
--             linen_subcategory enum (20260519060100), LINEN seed (20260519060000).

-- ==========================================================================
-- 1) linen_counts table
-- ==========================================================================

CREATE TABLE IF NOT EXISTS linen_counts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  item_id     uuid        NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  counted_qty int         NOT NULL CHECK (counted_qty >= 0),
  counted_at  timestamptz NOT NULL DEFAULT now(),
  counted_by  text        NOT NULL DEFAULT app_username(),
  photo_url   text,                  -- Cloudinary URL; NULL when staff skips photo (advisory on count)
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_lc_location    ON linen_counts(location_id);
CREATE INDEX IF NOT EXISTS idx_lc_item        ON linen_counts(item_id);
CREATE INDEX IF NOT EXISTS idx_lc_counted_at  ON linen_counts(counted_at DESC);
-- Compound: "most recent per (location, item)" — used by v_linen_audit and audit cron
CREATE INDEX IF NOT EXISTS idx_lc_loc_item_at ON linen_counts(location_id, item_id, counted_at DESC);

COMMENT ON TABLE linen_counts IS
  'Phase 6: periodic count snapshots for LINEN items at cabinet locations. '
  'INSERT-only (immutable). Discrepancy is surfaced by v_linen_audit + daily cron — '
  'not by the count insert itself. Inserting does NOT update stock_item_locations.qty.';

COMMENT ON COLUMN linen_counts.photo_url IS
  'Cloudinary URL. Advisory on periodic counts (may be NULL if staff skips). '
  'Required on ส่งซัก/รับคืน movements (enforced by frontend, not this table — '
  'those are stock_movements rows, not linen_counts rows).';

-- ==========================================================================
-- 2) Cabinet-type + LINEN-category validation trigger
-- ==========================================================================

CREATE OR REPLACE FUNCTION validate_linen_count_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_type location_type;
BEGIN
  -- Check: location must be type='cabinet'
  SELECT type INTO v_type FROM locations WHERE id = NEW.location_id;
  IF v_type IS DISTINCT FROM 'cabinet' THEN
    RAISE EXCEPTION 'linen_counts สามารถบันทึกได้เฉพาะตู้ (cabinet) เท่านั้น — location_id % ไม่ใช่ cabinet', NEW.location_id;
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

-- Drop + recreate trigger (idempotent)
DROP TRIGGER IF EXISTS trg_linen_count_validate ON linen_counts;
CREATE TRIGGER trg_linen_count_validate
  BEFORE INSERT ON linen_counts
  FOR EACH ROW EXECUTE FUNCTION validate_linen_count_location();

-- ==========================================================================
-- 3) v_linen_audit view
--    Most recent count per (cabinet, linen item) vs current stock_item_locations.qty.
--    Threshold from settings: LINEN_DISCREPANCY_PCT (default 5) + LINEN_DISCREPANCY_MIN (default 2)
--    Formula: abs_delta > GREATEST(CEIL(qty * pct/100), min_pieces)
--
-- NOTE: Settings keys used here are named LINEN_DISCREPANCY_PCT / LINEN_DISCREPANCY_MIN
--       matching the spec task brief naming. The cron settings use LINEN_AUDIT_THRESHOLD_PCT /
--       LINEN_AUDIT_MIN_PIECES (seeded in 20260519060500). The view reads both naming conventions
--       via COALESCE chain to tolerate either key name in the settings table.
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
  WHERE l.type   = 'cabinet'
    AND l.active = true
    AND si.active = true
)
SELECT * FROM combined;

COMMENT ON VIEW v_linen_audit IS
  'Phase 6: linen audit view. Shows most recent count per (cabinet, linen item) vs '
  'current stock_item_locations.qty. is_discrepancy=true when abs_delta exceeds '
  'GREATEST(CEIL(qty * threshold_pct/100), min_pieces). '
  'threshold_pct and min_pieces read from settings table with COALESCE defaults (5, 2).';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Table columns:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='linen_counts'
--    ORDER BY ordinal_position;
--    Expected: 9 columns (id, location_id, item_id, counted_qty, counted_at, counted_by, photo_url, note, created_at)
--
-- 2) View queryable:
--    SELECT count(*) FROM v_linen_audit;
--    Expected: >= 0 rows (0 if no LINEN items assigned to cabinets yet)
--
-- 3) Trigger registered:
--    SELECT trigger_name, event_manipulation, event_object_table
--    FROM information_schema.triggers
--    WHERE trigger_name = 'trg_linen_count_validate';
--    Expected: 1 row
--
-- 4) Cabinet-type validation (run in transaction, ROLLBACK after):
--    BEGIN;
--    INSERT INTO linen_counts(location_id, item_id, counted_qty)
--    SELECT l.id, (SELECT id FROM stock_items WHERE sku='LINEN-SHEET-001'),  5
--    FROM locations l WHERE l.type != 'cabinet' LIMIT 1;
--    -- Expected: ERROR 'linen_counts สามารถบันทึกได้เฉพาะตู้ (cabinet) เท่านั้น'
--    ROLLBACK;
