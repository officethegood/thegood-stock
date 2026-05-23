-- supabase/migrations/20260524000000_rpc_delete_location.sql
-- Phase 0.7 follow-up — Admin RPC to delete a location AND its history.
--
-- Why:
--   A plain client DELETE on locations fails (23503 FK violation) the moment
--   anything references it — including append-only audit movements that the
--   client has no DELETE policy for. The FE could only show the user what
--   was blocking; it could not let them follow through. This RPC closes that
--   gap with a guarded hard-delete (mirrors the inventory item hard-delete
--   pattern, task #34, and rpc_delete_oxygen_tank).
--
-- Guard:
--   The function RAISES with a specific Thai message when any of these are
--   present — the user must clear them first (or deactivate the location):
--     • child locations
--     • stock_item_locations with qty > 0 (real stock — move it out)
--     • oxygen_tanks currently here (move the tanks)
--     • any stock_loans referencing this location (any status) — moving the
--       loan history is out of scope; the location must be kept (deactivate)
--   When none of those block, it purges in one transaction:
--     • oxygen_movements (from_location_id OR to_location_id)
--     • stock_movements (location_id)
--     • stock_item_locations (the qty=0 zombie rows)
--     • the locations row itself
--   Audit trail for that location is intentionally destroyed; the FE shows the
--   movement-count in the confirm so the user knows what they are giving up.
--
-- Scope note:
--   transfer movements come in pairs (transfer_out + transfer_in). Deleting
--   one side here leaves an orphaned twin elsewhere — accepted as the cost of
--   the audit-destructive delete. Use deactivate to keep the audit intact.
--
-- Depends on: Phase 0 app_user_role(), locations / stock_movements /
--   stock_item_locations / oxygen_tanks / oxygen_movements / stock_loans.
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION rpc_delete_location(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_delete_location$
DECLARE
  v_code      text;
  v_children  int;
  v_sil_real  int;
  v_tanks     int;
  v_loans     int;
BEGIN
  -- 1. Admin only.
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบสถานที่ได้';
  END IF;

  -- 2. Lock + fetch the location.
  SELECT code INTO v_code FROM locations WHERE id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบสถานที่ที่ต้องการลบ';
  END IF;

  -- 3. Block — child locations.
  SELECT count(*) INTO v_children
  FROM locations WHERE parent_id = p_location_id;
  IF v_children > 0 THEN
    RAISE EXCEPTION
      'ลบไม่ได้ — มี location ลูกอยู่ % รายการ (ลบลูกก่อน)', v_children;
  END IF;

  -- 4. Block — real stock (qty > 0). The user must move it out first.
  SELECT count(*) INTO v_sil_real
  FROM stock_item_locations
  WHERE location_id = p_location_id AND qty > 0;
  IF v_sil_real > 0 THEN
    RAISE EXCEPTION
      'ลบไม่ได้ — มีของเก็บอยู่ % รายการสินค้า (ย้ายของออกก่อน)', v_sil_real;
  END IF;

  -- 5. Block — oxygen tanks currently here.
  SELECT count(*) INTO v_tanks
  FROM oxygen_tanks WHERE current_location_id = p_location_id;
  IF v_tanks > 0 THEN
    RAISE EXCEPTION
      'ลบไม่ได้ — มีถังออกซิเจนอยู่ % ถัง (ย้ายถังออกก่อน)', v_tanks;
  END IF;

  -- 6. Block — any loan references this location (active history is sensitive;
  --    keep the location alive — use deactivate). Includes returned loans.
  SELECT count(*) INTO v_loans
  FROM stock_loans WHERE location_id_from = p_location_id;
  IF v_loans > 0 THEN
    RAISE EXCEPTION
      'ลบไม่ได้ — มีรายการยืม % รายการอ้างอิง (ใช้ "ปิดใช้งาน" แทน)', v_loans;
  END IF;

  -- 7. Safe to purge — history + zombie rows + the location itself.
  DELETE FROM oxygen_movements
    WHERE from_location_id = p_location_id
       OR to_location_id   = p_location_id;
  DELETE FROM stock_movements      WHERE location_id = p_location_id;
  DELETE FROM stock_item_locations WHERE location_id = p_location_id;
  DELETE FROM locations            WHERE id = p_location_id;
END;
$rpc_delete_location$;

COMMENT ON FUNCTION rpc_delete_location(uuid) IS
  'Phase 0.7 follow-up. Admin-only guarded hard-delete for locations. Blocks '
  'when the location has children, real stock (qty>0), oxygen tanks, or any '
  'loans referencing it. Otherwise purges its movements + sil zombies + the '
  'location row in one transaction. Audit-destructive — caller confirms with '
  'the movement-count first.';

GRANT EXECUTE ON FUNCTION rpc_delete_location(uuid) TO authenticated;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function exists, SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='rpc_delete_location';
--    Expected: 1 row, prosecdef = true.
--
-- B) End-to-end: from the locations admin page, delete a leaf location that
--    has only history. The "ลบ ... จะลบประวัติ N รายการ ..." confirm appears,
--    then the location disappears. If a location has real stock or tanks,
--    the RPC raises a specific Thai message.
