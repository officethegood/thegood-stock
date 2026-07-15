-- supabase/migrations/20260715020000_fix_bag_ambulance_parent.sql
-- Fix — "เอากระเป๋าขึ้นรถ" (rpc_deploy_bag) throws because the parent-type
-- validator rejects a bag parented under an ambulance.
--
-- Bug:
--   validate_location_parent_type() (latest & only version: 20260519070200_
--   location_parent_rules.sql) enforces that a type='bag' may only sit under
--   room / storage / cabinet:
--     (NEW.type = 'bag' AND parent_type NOT IN ('room','storage','cabinet'))
--   But rpc_deploy_bag (20260705010000) re-parents the bag UNDER an ambulance:
--     UPDATE locations SET parent_id = <ambulance> WHERE id = <bag>;
--   That UPDATE fires trg_locations_parent_type → validate_location_parent_type()
--   with parent_type='ambulance' → RAISE EXCEPTION. Every bag deploy fails.
--
-- Fix:
--   CREATE OR REPLACE validate_location_parent_type() copying the 20260519070200
--   body VERBATIM, changing ONLY the bag rule to also allow parent_type
--   'ambulance' (bag parent allowed in room/storage/cabinet/ambulance).
--   Nothing else changes — the CHECK constraint chk_location_parent_rules
--   (bag parent OPTIONAL) and the trigger binding are untouched. The Thai
--   exception string is byte-identical.
--
-- LESSON APPLIED (see 20260712010000 / 20260712020000): body is a verbatim copy
--   of the CURRENT latest definition with ONLY the documented delta.
--
-- Depends on: 20260519070200_location_parent_rules.sql, 20260705010000_bag_deploy_return.sql
-- Idempotent: CREATE OR REPLACE FUNCTION. Trigger not recreated (binds by name).

CREATE OR REPLACE FUNCTION validate_location_parent_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $func$
DECLARE
  parent_type location_type;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;

  SELECT type INTO parent_type FROM locations WHERE id = NEW.parent_id;

  IF (NEW.type = 'storage'  AND parent_type NOT IN ('room', 'ambulance')) OR
     (NEW.type = 'cabinet'  AND parent_type NOT IN ('room', 'ambulance')) OR
     (NEW.type = 'shelf'    AND parent_type NOT IN ('storage', 'cabinet')) OR
     (NEW.type = 'bin'      AND parent_type <> 'shelf') OR
     (NEW.type = 'bag'      AND parent_type NOT IN ('room', 'storage', 'cabinet', 'ambulance')) OR
     (NEW.type = 'zone'     AND parent_type <> 'bag')
  THEN
    RAISE EXCEPTION 'ตำแหน่ง type=% ไม่สามารถอยู่ภายใต้ type=% ได้', NEW.type, parent_type;
  END IF;

  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION validate_location_parent_type() IS
  'Phase 0.7. Enforces parent-type matrix for locations hierarchy. '
  'Fires BEFORE INSERT OR UPDATE OF parent_id, type. SECURITY DEFINER. '
  '20260715020000: bag parent may also be an ambulance (rpc_deploy_bag re-parents '
  'a bag under an ambulance — "เอากระเป๋าขึ้นรถ").';

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- A) Function exists & SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'validate_location_parent_type';
--    Expected: 1 row, prosecdef = true
--
-- B) End-to-end round-trip against a real bag + ambulance, rolled back
--    (operator-run — uncomment and fill in / rely on the auto-pick below).
--    Before this fix step (2) raised 'ตำแหน่ง type=bag ไม่สามารถอยู่ภายใต้ type=ambulance ได้'.
--    After it, both RPCs succeed and the bag returns to its home parent.
--
--    BEGIN;
--      -- pick any active bag and any active ambulance:
--      WITH b AS (SELECT id FROM locations WHERE type='bag'       AND active LIMIT 1),
--           a AS (SELECT id FROM locations WHERE type='ambulance' AND active LIMIT 1)
--      SELECT rpc_deploy_bag((SELECT id FROM b), (SELECT id FROM a));   -- was: EXCEPTION; now: {"ok":true,...}
--      -- confirm the bag now sits under the ambulance:
--      -- SELECT id, type, parent_id FROM locations WHERE id = (SELECT id FROM b);
--      WITH b AS (SELECT id FROM locations WHERE type='bag' AND active LIMIT 1)
--      SELECT rpc_return_bag((SELECT id FROM b));                       -- {"ok":true,...} — back to home
--    ROLLBACK;
--
-- C) Regression guard — an illegal parent is still rejected (rolled back):
--    BEGIN;
--      -- a bin may only sit under a shelf; putting it under a room must still fail:
--      WITH r AS (SELECT id FROM locations WHERE type='room' LIMIT 1)
--      INSERT INTO locations(code, name, type, parent_id)
--      VALUES ('AUDIT-BIN-FAIL', 'x', 'bin', (SELECT id FROM r));
--      -- Expected: ERROR 'ตำแหน่ง type=bin ไม่สามารถอยู่ภายใต้ type=room ได้'
--    ROLLBACK;
