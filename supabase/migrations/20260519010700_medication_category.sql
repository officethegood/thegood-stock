-- supabase/migrations/20260519010700_medication_category.sql
-- Phase 2 — Seed MEDICATION category.
--
-- Decisions-locked derived #9:
--   INSERT INTO stock_categories(code, name, sort_order) VALUES ('MEDICATION','ยา',50)
--   ON CONFLICT (code) DO NOTHING
--
-- sort_order=50 places MEDICATION above Phase 1 seeds:
--   GENERAL=10, SUPPLY=20, TOOL=30, CONSUME=40
--
-- Idempotent: ON CONFLICT (code) DO NOTHING.
-- Depends on: stock_categories table (Phase 1 20260519000000_stock_categories.sql).

INSERT INTO stock_categories(code, name, sort_order)
VALUES ('MEDICATION', 'ยา', 50)
ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE stock_categories IS
  'Phase 1 category lookup. Phase 2 adds MEDICATION (sort_order=50) for lot-tracked medication items.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) MEDICATION row present:
--    SELECT code, name, sort_order
--    FROM stock_categories
--    ORDER BY sort_order;
--    -- Expected: 5 rows including ('MEDICATION', 'ยา', 50) as the last row.
--
-- 2) ON CONFLICT idempotency — re-running this migration should not error:
--    INSERT INTO stock_categories(code, name, sort_order)
--    VALUES ('MEDICATION', 'ยา', 50)
--    ON CONFLICT (code) DO NOTHING;
--    -- Expected: INSERT 0 0 (no rows inserted on second run)
