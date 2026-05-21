-- supabase/migrations/20260521000000_tank_size_q_ratings.sql
-- Phase 0.7 — Replace oxygen tank_size taxonomy with the real cylinder
--             Q-ratings from the customer document Layout-Stock-2026-O2.
--
-- Background:
--   20260520010000_lookup_lists.sql seeded kind='tank_size' with the three
--   placeholder sizes small / medium / large. The customer's actual oxygen
--   cylinders are rated 0.5Q / 1Q / 1.5Q / 4Q / 6Q. This migration swaps the
--   placeholder taxonomy for the real one.
--
--   tank_size is a plain text column on oxygen_tanks (no enum, no CHECK —
--   the CHECK was dropped in 20260520010100_linen_enum_to_text.sql), so no
--   table DDL is needed; only the lookup_lists rows change.
--
-- Depends on:
--   20260520010000_lookup_lists.sql  (creates lookup_lists, seeds tank_size)
--
-- Existing data note:
--   oxygen_tanks rows seeded as test data may still carry tank_size values of
--   'small'/'medium'/'large'. Those are NOT remapped here — there is no
--   meaningful 1:1 mapping to Q-ratings, and the tank list is test data the
--   owner is replacing with real cylinders. A tank still holding an old code
--   simply shows that raw code in its size badge until it is edited/recreated.
--
-- Idempotent:
--   DELETE ... WHERE code IN (...) — re-run safe (0 rows the 2nd time).
--   INSERT ... ON CONFLICT (kind, code) DO NOTHING — re-run safe.

BEGIN;

-- 1) Remove the three placeholder sizes.
DELETE FROM lookup_lists
WHERE kind = 'tank_size'
  AND code IN ('small', 'medium', 'large');

-- 2) Seed the real cylinder Q-ratings.
--    code == name: the Q-rating is already the human-readable label.
INSERT INTO lookup_lists (kind, code, name, sort_order) VALUES
  ('tank_size', '0.5Q', '0.5Q', 1),
  ('tank_size', '1Q',   '1Q',   2),
  ('tank_size', '1.5Q', '1.5Q', 3),
  ('tank_size', '4Q',   '4Q',   4),
  ('tank_size', '6Q',   '6Q',   5)
ON CONFLICT (kind, code) DO NOTHING;

COMMIT;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
--
-- A) tank_size taxonomy is exactly the 5 Q-ratings, in order:
--    SELECT code, name, sort_order, active
--    FROM lookup_lists
--    WHERE kind = 'tank_size'
--    ORDER BY sort_order;
--    Expected: 0.5Q / 1Q / 1.5Q / 4Q / 6Q  (5 rows, all active=true)
--
-- B) No placeholder sizes remain:
--    SELECT count(*) FROM lookup_lists
--    WHERE kind = 'tank_size' AND code IN ('small','medium','large');
--    Expected: 0
--
-- C) How many existing tanks still reference an old placeholder code
--    (informational — these are test tanks to be replaced with real data):
--    SELECT tank_size, count(*) FROM oxygen_tanks
--    GROUP BY tank_size ORDER BY tank_size;
