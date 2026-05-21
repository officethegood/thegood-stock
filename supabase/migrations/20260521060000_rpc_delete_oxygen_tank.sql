-- supabase/migrations/20260521060000_rpc_delete_oxygen_tank.sql
-- Phase 5.1 — Admin RPC to permanently delete an oxygen tank that was never
-- used operationally (the "added by mistake" case).
--
-- Why an RPC is required:
--   A tank cannot be removed with a plain client-side DELETE:
--     * Every tank carries one initial-placement movement row, and
--       oxygen_movements.tank_id is a foreign key with ON DELETE RESTRICT.
--     * oxygen_movements has NO DELETE RLS policy — it is append-only, so the
--       authenticated role cannot delete the movement row itself.
--   This SECURITY DEFINER function deletes the movement row(s) and the tank in
--   one transaction, past those restrictions.
--
-- Guard — only never-used tanks may be deleted:
--   The single initial-placement movement has from_status = NULL. Any real
--   transition (ready->on_board, ->refilling, ->maintenance, ->retired) writes
--   a movement with a NON-NULL from_status. A tank with any such movement
--   carries operational audit history and must be RETIRED, not deleted. As a
--   defensive cross-check the tank's status must also still be 'ready'.
--
-- Mirrors the guarded hard-delete pattern used for stock_items (Phase: D34) and
-- the rpc_update_oxygen_tank Admin-RPC pattern (20260521010000).
--
-- Depends on:
--   20260519050200_oxygen_tanks.sql      (oxygen_tanks table)
--   20260519050300_oxygen_movements.sql  (oxygen_movements, FK ON DELETE RESTRICT)
--   Phase 0: app_user_role() helper.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION rpc_delete_oxygen_tank(
  p_tank_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_delete_oxygen_tank$
DECLARE
  v_serial   text;
  v_status   oxygen_tank_status;
  v_op_moves int;
BEGIN
  -- 1. Admin only.
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบถังได้';
  END IF;

  -- 2. Fetch + lock the tank row so a concurrent movement insert cannot slip
  --    in between this guard check and the delete below.
  SELECT serial, status
  INTO v_serial, v_status
  FROM oxygen_tanks
  WHERE id = p_tank_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบถังที่ต้องการลบ';
  END IF;

  -- 3. Guard: block any tank that has been used operationally. The initial
  --    placement movement has from_status = NULL; every real transition has a
  --    non-NULL from_status. If one exists, the tank has audit history.
  SELECT count(*)
  INTO v_op_moves
  FROM oxygen_movements
  WHERE tank_id = p_tank_id
    AND from_status IS NOT NULL;

  IF v_op_moves > 0 THEN
    RAISE EXCEPTION
      'ลบถัง % ไม่ได้ เพราะถังเคยถูกใช้งานแล้ว — กรุณาใช้การปลดระวางแทน', v_serial;
  END IF;

  -- 4. Defensive cross-check: a tank with no operational movement should still
  --    be at the table-default 'ready' status. Anything else means corrupt
  --    data — fail safe rather than delete.
  IF v_status <> 'ready' THEN
    RAISE EXCEPTION
      'ลบถัง % ไม่ได้ เพราะสถานะถังไม่ใช่ "พร้อมใช้"', v_serial;
  END IF;

  -- 5. Delete children first (FK is ON DELETE RESTRICT), then the tank —
  --    both within this function's transaction.
  DELETE FROM oxygen_movements WHERE tank_id = p_tank_id;
  DELETE FROM oxygen_tanks     WHERE id = p_tank_id;
END;
$rpc_delete_oxygen_tank$;

COMMENT ON FUNCTION rpc_delete_oxygen_tank(uuid) IS
  'Phase 5.1. Admin-only permanent delete for an oxygen tank that was never '
  'used operationally (only the initial placement movement, status still '
  'ready). Deletes the tank''s oxygen_movements rows then the tank in one '
  'transaction. SECURITY DEFINER — needed because oxygen_movements is '
  'append-only (no DELETE policy) and its FK to oxygen_tanks is ON DELETE '
  'RESTRICT. Tanks with operational history must be retired, not deleted.';

GRANT EXECUTE ON FUNCTION rpc_delete_oxygen_tank(uuid) TO authenticated;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function exists and is SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname = 'rpc_delete_oxygen_tank';
--    Expected: 1 row, prosecdef = true.
--
-- B) Guard rejects a used tank (pick any tank with operational history):
--    SELECT rpc_delete_oxygen_tank('<used-tank-uuid>');
--    Expected: ERROR 'ลบถัง ... ไม่ได้ เพราะถังเคยถูกใช้งานแล้ว ...'
--
-- C) End-to-end: add a throwaway test tank through the admin UI, then use the
--    new "ลบถัง" button in the แก้ไขข้อมูลถัง modal. Expected: success toast,
--    the tank disappears from the list, and SELECT count(*) FROM oxygen_tanks
--    drops by one.
