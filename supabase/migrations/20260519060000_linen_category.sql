-- supabase/migrations/20260519060000_linen_category.sql
-- Phase 6 — Linens & Laundry: LINEN category seed.
--
-- Decisions-locked (docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md):
--   Derived #1 — INSERT INTO stock_categories('LINEN','ผ้า',60) ON CONFLICT DO NOTHING
--
-- sort_order=60 places LINEN above MEDICATION (50) in display order.
--   GENERAL=10, SUPPLY=20, TOOL=30, CONSUME=40, MEDICATION=50, LINEN=60
--
-- Idempotent: ON CONFLICT (code) DO NOTHING.
-- Depends on: stock_categories table (Phase 1).

INSERT INTO stock_categories(code, name, sort_order)
VALUES ('LINEN', 'ผ้า', 60)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- Verification SQL
-- ============================================================
-- SELECT code, name, sort_order
-- FROM stock_categories
-- ORDER BY sort_order;
-- Expected: 6 rows including ('LINEN', 'ผ้า', 60)
--
-- SELECT code FROM stock_categories WHERE code='LINEN';
-- Expected: 1 row
