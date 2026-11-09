-- 20261109020000_delete_location_keeps_history.sql
-- Deleting a location never deletes stock history again (review 2026-11-08, #5).
--
-- Before (20260524000000): when a location held no stock it was deleted together with every
-- stock_movements / oxygen_movements row at it. The ledger is the only truth for stock:
--   * a transfer is two rows; deleting the side at this location leaves its twin elsewhere,
--     so stock_lots.current_qty no longer equals the lot's ledger (audit check 2 fires, and
--     nothing can repair it because the evidence is gone);
--   * a return referencing a borrow here (source_movement_id) made the delete fail with a raw
--     23503 FK error.
-- Now: a location with ANY movement history cannot be deleted; switch it off instead
-- (แก้ไข → เอาเครื่องหมาย "ใช้งาน" ออก). A location with no history at all (created by mistake)
-- can still be deleted, together with its qty-0 rows.
--
-- Body starts from the LATEST version (20260524000000). Idempotent. Ends with go/no-go SELECT.

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
  v_history   int;
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
  SELECT count(*) INTO v_children FROM locations WHERE parent_id = p_location_id;
  IF v_children > 0 THEN
    RAISE EXCEPTION 'ลบไม่ได้ — มี location ลูกอยู่ % รายการ (ลบลูกก่อน)', v_children;
  END IF;

  -- 4. Block — real stock (qty > 0).
  SELECT count(*) INTO v_sil_real
  FROM stock_item_locations WHERE location_id = p_location_id AND qty > 0;
  IF v_sil_real > 0 THEN
    RAISE EXCEPTION 'ลบไม่ได้ — มีของเก็บอยู่ % รายการสินค้า (ย้ายของออกก่อน)', v_sil_real;
  END IF;

  -- 5. Block — oxygen tanks currently here.
  SELECT count(*) INTO v_tanks FROM oxygen_tanks WHERE current_location_id = p_location_id;
  IF v_tanks > 0 THEN
    RAISE EXCEPTION 'ลบไม่ได้ — มีถังออกซิเจนอยู่ % ถัง (ย้ายถังออกก่อน)', v_tanks;
  END IF;

  -- 6. Block — any loan references this location.
  SELECT count(*) INTO v_loans FROM stock_loans WHERE location_id_from = p_location_id;
  IF v_loans > 0 THEN
    RAISE EXCEPTION 'ลบไม่ได้ — มีรายการยืม % รายการอ้างอิง (ใช้ "ปิดใช้งาน" แทน)', v_loans;
  END IF;

  -- 7. NEW — Block — any stock or oxygen history. The ledger is never deleted.
  SELECT (SELECT count(*) FROM stock_movements WHERE location_id = p_location_id)
       + (SELECT count(*) FROM oxygen_movements
           WHERE from_location_id = p_location_id OR to_location_id = p_location_id)
    INTO v_history;
  IF v_history > 0 THEN
    RAISE EXCEPTION 'ลบไม่ได้ — ตำแหน่งนี้มีประวัติการเคลื่อนไหว % รายการ (ใช้ "ปิดใช้งาน" แทน: แก้ไข → เอาเครื่องหมาย "ใช้งาน" ออก)', v_history;
  END IF;

  -- 8. No history: remove qty-0 rows and the location itself.
  DELETE FROM stock_item_locations WHERE location_id = p_location_id;
  DELETE FROM locations            WHERE id = p_location_id;
END;
$rpc_delete_location$;

COMMENT ON FUNCTION rpc_delete_location(uuid) IS
  'Admin-only delete for a location that was never used: blocks on children, stock, tanks, '
  'loans, and (20261109020000) ANY stock/oxygen movement history — such locations are '
  'deactivated instead, so the ledger is never deleted.';

GRANT EXECUTE ON FUNCTION rpc_delete_location(uuid) TO authenticated;

-- Go/no-go: keeps_history = true, deletes_movements = false.
SELECT proname,
       prosecdef AS security_definer,
       position('ประวัติการเคลื่อนไหว' IN prosrc) > 0           AS keeps_history,
       position('DELETE FROM stock_movements' IN prosrc) > 0 AS deletes_movements
FROM pg_proc WHERE proname = 'rpc_delete_location';
