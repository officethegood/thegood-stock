-- supabase/migrations/20261015010000_fix_bag_return_null_home.sql
-- Fix — "คืนกระเป๋า" (rpc_return_bag) throws "ไม่พบประวัติการนำกระเป๋าขึ้นรถ"
-- for a bag whose home is top-level (parent_id = NULL), leaving it STUCK on a
-- vehicle with no way back from the UI.
--
-- Bug (report Chittawan 2026-10-14/15; confirmed on prod — BAG-ALS-001 "ALS Bag 1"
-- and BAG-DUG-001 "Bag TG 3" both on a vehicle with recorded_home = NULL):
--   A bag stored at the top of the hierarchy has parent_id = NULL. rpc_deploy_bag
--   records from_parent_id = <that NULL> as the bag's "home". On return,
--   rpc_return_bag does:
--       SELECT from_parent_id INTO v_home_id FROM bag_moves ... LIMIT 1;
--       IF v_home_id IS NULL THEN RAISE 'ไม่พบประวัติการนำกระเป๋าขึ้นรถ ...';
--   v_home_id IS NULL is TRUE in TWO different situations:
--       (a) no deploy row exists at all            → genuinely no history
--       (b) a deploy row exists, home = NULL        → home IS top-level (valid!)
--   Case (b) is wrongly rejected, so a top-level bag can never be returned.
--   The staff checklist only offers "คืนกระเป๋า" once the bag is on a vehicle,
--   so the bag is a dead end (can't return, can't re-deploy).
--
-- Fix:
--   Body is a VERBATIM copy of rpc_return_bag from 20260705010000_bag_deploy_return.sql
--   with ONE documented change: distinguish (a) from (b) using FOUND instead of
--   "v_home_id IS NULL". NULL from_parent_id is now a valid return target (the bag
--   goes back to top-level, which the parent-type validator already allows —
--   20260715020000 line 38: parent_id IS NULL → RETURN NEW). The "already home"
--   check becomes NULL-safe (IS NOT DISTINCT FROM). Nothing else changes.
--
--   This also UNSTICKS the two bags above: after apply, pressing "คืนกระเป๋า"
--   returns each bag to its top-level home (parent_id → NULL) and logs a
--   bag_moves 'return' row. No separate data fix needed.
--
-- LESSON APPLIED: verbatim copy of the current latest body + only the documented delta.
--
-- Depends on: 20260705010000_bag_deploy_return.sql (body copied from here),
--             20260715020000 (bag may be top-level / under room/storage/cabinet/ambulance).
-- Idempotent: CREATE OR REPLACE FUNCTION. Trigger/grants unchanged (bind by name).

CREATE OR REPLACE FUNCTION rpc_return_bag(
  p_bag_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_return_bag$
DECLARE
  v_bag        locations;
  v_home_id    uuid;
  v_has_deploy boolean;
  v_home_name  text;
BEGIN
  IF app_user_role() NOT IN ('Admin', 'Employee') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  SELECT * INTO v_bag FROM locations WHERE id = p_bag_id FOR UPDATE;
  IF NOT FOUND OR v_bag.type <> 'bag' THEN
    RAISE EXCEPTION 'ไม่พบกระเป๋า';
  END IF;

  -- Most recent deploy row. from_parent_id MAY be NULL — that means the bag's
  -- home is top-level (no parent), which is a VALID return target, not "no
  -- history". Use FOUND (set by SELECT INTO) to tell the two apart.
  SELECT from_parent_id INTO v_home_id
  FROM bag_moves
  WHERE bag_location_id = p_bag_id AND action = 'deploy'
  ORDER BY moved_at DESC
  LIMIT 1;
  v_has_deploy := FOUND;

  IF NOT v_has_deploy THEN
    RAISE EXCEPTION 'ไม่พบประวัติการนำกระเป๋าขึ้นรถ — แจ้ง Admin ให้ย้ายในหน้าสถานที่';
  END IF;

  -- Already at home? NULL-safe compare (top-level home = parent_id NULL).
  IF v_bag.parent_id IS NOT DISTINCT FROM v_home_id THEN
    RAISE EXCEPTION 'กระเป๋าอยู่ที่เก็บเดิมอยู่แล้ว';
  END IF;

  IF v_home_id IS NOT NULL THEN
    SELECT name INTO v_home_name FROM locations WHERE id = v_home_id;
  END IF;

  UPDATE locations SET parent_id = v_home_id WHERE id = p_bag_id;   -- NULL = back to top-level

  INSERT INTO bag_moves (bag_location_id, action, from_parent_id, to_parent_id)
  VALUES (p_bag_id, 'return', v_bag.parent_id, v_home_id);

  RETURN jsonb_build_object(
    'ok', true,
    'bag_code',  v_bag.code,
    'home_name', COALESCE(v_home_name, 'ที่เก็บหลัก (บนสุด)')
  );
END;
$rpc_return_bag$;

COMMENT ON FUNCTION rpc_return_bag(uuid) IS
  'คืนกระเป๋า: re-parents the bag back to the from_parent_id recorded by its most '
  'recent bag_moves deploy row. 20261015010000: a recorded home of NULL (top-level) '
  'is a VALID target — only a total absence of a deploy row raises "ไม่พบประวัติ...". '
  'Admin + Employee. SECURITY DEFINER.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function present, SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'rpc_return_bag';
--    Expected: 1 row, prosecdef = true
--
-- B) The two stuck bags can now be returned (rolled back trial). Each should
--    return ok=true and move parent_id → NULL (top-level home):
--    BEGIN;
--      SELECT rpc_return_bag((SELECT id FROM locations WHERE code='BAG-ALS-001'));
--      SELECT code, parent_id FROM locations WHERE code='BAG-ALS-001';  -- parent_id NULL
--    ROLLBACK;
--    -- (repeat with BAG-DUG-001)
--
-- C) Genuine "no deploy row" still raises (rolled back): pick a bag that has
--    NEVER been deployed, or temporarily hide its rows — expect the Thai
--    'ไม่พบประวัติการนำกระเป๋าขึ้นรถ ...' exception.
--
-- D) PRODUCTION: to actually unstick the two bags, run each WITHOUT the rollback
--    (as Admin, in a staff/admin context so app_user_role()='Admin'):
--      SELECT rpc_return_bag((SELECT id FROM locations WHERE code='BAG-ALS-001'));
--      SELECT rpc_return_bag((SELECT id FROM locations WHERE code='BAG-DUG-001'));
--    Or simply press "คืนกระเป๋าเข้าที่เก็บเดิม" in the app for each bag.
