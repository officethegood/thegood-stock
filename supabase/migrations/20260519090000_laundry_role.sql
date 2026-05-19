-- supabase/migrations/20260519090000_laundry_role.sql
-- Phase 0.7 add-on D11 — Laundry location roles + linen state summary view.
--
-- Assumptions:
--   Postgres 15 (Supabase default).
--   Extensions in use: pgcrypto (gen_random_uuid), pg_cron, pg_net — no new extensions needed here.
--   Secret names: APP_JWT_HS_SECRET (not used in this migration).
--   Depends on:
--     locations table           (20260518000200_locations.sql)
--     stock_items table         (20260518010100_stock_items.sql)
--     stock_item_locations table(20260518010200_stock_item_locations.sql)
--     stock_categories table    (20260518010000_stock_categories.sql)
--     LINEN category seed       (20260519060000_linen_category.sql)
--
-- NOTE on is_linen column:
--   The task spec references `stock_items.is_linen`, but that column does NOT exist in
--   any migration as of 2026-05-19. The codebase identifies linen SKUs via
--   category_id = (SELECT id FROM stock_categories WHERE code = 'LINEN').
--   v_linen_state_summary uses that join instead. This is equivalent and correct.
--   If is_linen is added in a future migration, the view can be updated then.
--
-- Idempotent:
--   ADD COLUMN IF NOT EXISTS — safe to replay.
--   DO $$ block wraps constraint creation in pg_constraint check.
--   CREATE INDEX IF NOT EXISTS — safe to replay.
--   CREATE OR REPLACE VIEW — safe to replay.

-- ==========================================================================
-- 1. ADD COLUMN
-- ==========================================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS laundry_role text;

-- ==========================================================================
-- 2. CHECK CONSTRAINT (idempotent via DO block)
-- ==========================================================================

DO $laundry_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_laundry_role'
      AND conrelid = 'locations'::regclass
  ) THEN
    ALTER TABLE locations
      ADD CONSTRAINT chk_laundry_role
        CHECK (laundry_role IS NULL
            OR laundry_role IN ('clean', 'vehicle', 'dirty', 'external'));
  END IF;
END;
$laundry_constraint$;

-- ==========================================================================
-- 3. PARTIAL INDEX
-- ==========================================================================

CREATE INDEX IF NOT EXISTS idx_locations_laundry_role
  ON locations(laundry_role)
  WHERE laundry_role IS NOT NULL;

-- ==========================================================================
-- 4. COLUMN COMMENT
-- ==========================================================================

COMMENT ON COLUMN locations.laundry_role IS
  'Phase 0.7 D11 — Laundry role for this location. '
  '''clean''    = คลังผ้าสะอาด (พร้อมใช้); '
  '''vehicle''  = ตู้ผ้าในรถ (ในรถ); '
  '''dirty''    = ถังผ้าเปื้อน (รอซัก); '
  '''external'' = ส่งซักภายนอก (กำลังซัก). '
  'NULL = ตำแหน่งทั่วไป ไม่ใช่จุด laundry. '
  'Used by Phase 0.8 dashboard linen pivot widget (v_linen_state_summary).';

-- ==========================================================================
-- 5. VIEW: v_linen_state_summary
--
-- Aggregates qty per linen SKU per laundry_role for the dashboard pivot widget.
-- Linen SKUs are identified by category_id = LINEN (not is_linen — that column
-- does not exist; see header note).
-- No SECURITY DEFINER — view runs as the calling authenticated user (RLS applies
-- on underlying tables via existing policies).
-- ==========================================================================

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
-- Verification SQL (run after applying — paste in Dashboard SQL Editor)
-- ==========================================================================
--
-- 1) Column added:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_name = 'locations' AND column_name = 'laundry_role';
--    Expected: 1 row, data_type='text', is_nullable=YES
--
-- 2) Constraint exists:
--    SELECT conname FROM pg_constraint
--    WHERE conname = 'chk_laundry_role' AND conrelid = 'locations'::regclass;
--    Expected: 1 row
--
-- 3) Index exists:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'locations' AND indexname = 'idx_locations_laundry_role';
--    Expected: 1 row
--
-- 4) View exists + has GRANT:
--    SELECT table_name FROM information_schema.views
--    WHERE table_name = 'v_linen_state_summary';
--    Expected: 1 row
--
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'v_linen_state_summary' AND grantee = 'authenticated';
--    Expected: 1 row with privilege_type = 'SELECT'
--
-- 5) Smoke query:
--    SELECT * FROM v_linen_state_summary LIMIT 5;
--    Expected: 0–5 rows (0 until laundry_role assigned to locations and linen items exist)
