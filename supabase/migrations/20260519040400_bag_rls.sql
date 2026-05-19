-- supabase/migrations/20260519040400_bag_rls.sql
-- Phase 4 — ALS_KIT stock category seed.
--
-- Spec refs:
--   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §5.5
--   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §9 (T150)
--
-- Inserts 'ALS_KIT' into stock_categories with sort_order=25.
-- ON CONFLICT DO NOTHING makes this idempotent (safe to re-run).
--
-- Admin can then assign category='ALS_KIT' to stock_items that are bag sub-items,
-- making it easy to filter the item picker in the template editor.

INSERT INTO stock_categories(code, name, sort_order)
VALUES ('ALS_KIT', 'อุปกรณ์ถุงยา / ชุดปฐมพยาบาล', 25)
ON CONFLICT (code) DO NOTHING;

-- ==========================================================================
-- Verification SQL
-- ==========================================================================
-- SELECT code, name, sort_order FROM stock_categories WHERE code='ALS_KIT';
-- Expected: 1 row — ('ALS_KIT', 'อุปกรณ์ถุงยา / ชุดปฐมพยาบาล', 25)
