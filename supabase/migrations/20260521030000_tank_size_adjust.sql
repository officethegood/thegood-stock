-- supabase/migrations/20260521030000_tank_size_adjust.sql
-- Phase 5.1 — Adjust the oxygen tank_size taxonomy.
--
-- Change (per owner, 2026-05-21):
--   • Remove '1Q'  — not a real cylinder size.
--   • Rename '4Q' → '4.5Q'.
--   Resulting set: 0.5Q / 1.5Q / 4.5Q / 6Q.
--
-- Background:
--   20260521000000_tank_size_q_ratings.sql seeded 0.5Q/1Q/1.5Q/4Q/6Q. This
--   migration corrects that set. tank_size is a plain text column on
--   oxygen_tanks (no enum, no CHECK), so only the lookup_lists rows change.
--
-- Existing data note:
--   oxygen_tanks is currently empty, so no tank references '1Q' or '4Q'. The
--   rename below changes the lookup `code`; there is no FK from
--   oxygen_tanks.tank_size to lookup_lists, so a tank holding an old code (if
--   any existed) would simply show that raw code until edited. None exist now.
--
-- Depends on:
--   20260520010000_lookup_lists.sql, 20260521000000_tank_size_q_ratings.sql
--
-- Idempotent:
--   DELETE WHERE code='1Q' — re-run safe (0 rows the 2nd time).
--   UPDATE ... WHERE code='4Q' — re-run safe (0 rows once renamed).
--   sort_order UPDATEs are deterministic.

BEGIN;

-- 1) Remove 1Q.
DELETE FROM lookup_lists
WHERE kind = 'tank_size' AND code = '1Q';

-- 2) Rename 4Q → 4.5Q (code is the stored value; name is the display label).
UPDATE lookup_lists
SET code = '4.5Q', name = '4.5Q'
WHERE kind = 'tank_size' AND code = '4Q';

-- 3) Re-number sort_order for the remaining 4 sizes (no gaps).
UPDATE lookup_lists SET sort_order = 1 WHERE kind = 'tank_size' AND code = '0.5Q';
UPDATE lookup_lists SET sort_order = 2 WHERE kind = 'tank_size' AND code = '1.5Q';
UPDATE lookup_lists SET sort_order = 3 WHERE kind = 'tank_size' AND code = '4.5Q';
UPDATE lookup_lists SET sort_order = 4 WHERE kind = 'tank_size' AND code = '6Q';

COMMIT;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) tank_size taxonomy is exactly the 4 sizes, in order:
--    SELECT code, name, sort_order, active
--    FROM lookup_lists
--    WHERE kind = 'tank_size'
--    ORDER BY sort_order;
--    Expected: 0.5Q / 1.5Q / 4.5Q / 6Q  (4 rows, all active = true)
--
-- B) Neither old code remains:
--    SELECT count(*) FROM lookup_lists
--    WHERE kind = 'tank_size' AND code IN ('1Q', '4Q');
--    Expected: 0
