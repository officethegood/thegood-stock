-- supabase/migrations/20260522040000_rpc_recall_lot.sql
-- Phase 2 structural fix — recall a lot AND remove its stock.
--
-- Bug:
--   The FE recallLot() helper only did UPDATE stock_lots SET status='recalled'.
--   It posted no movement and reduced no quantity, so a recalled lot's units
--   stayed counted in stock_item_locations and in every total — a recalled
--   medication batch still showed as on-hand stock.
--
-- Fix:
--   This RPC performs the recall as one atomic transaction:
--     1. For each location holding the lot, post an adjustment_loss movement
--        that removes the lot's on-hand quantity there. These run while the lot
--        is still 'active'/'expired'; check_lot_status (20260522020000) permits
--        adjustment_loss on any lot. apply_movement_to_sil drops the location
--        total; apply_movement_to_lot_qty drops current_qty to 0.
--     2. Flip status to 'recalled' and write the audit columns.
--   Order matters: movements first, status flip last.
--
-- The recalled lot row is kept (status='recalled', current_qty 0) as the audit
-- record. The movement ledger shows exactly what was pulled and why.
--
-- Depends on:
--   20260522020000 (adjustment_loss allowed on a recalled/expired lot)
--   20260522030000 (apply_movement_to_lot_qty maintains current_qty)
--   Phase 0: app_user_role(), app_username().
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION rpc_recall_lot(
  p_lot_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_recall_lot$
DECLARE
  v_lot stock_lots;
  v_loc record;
BEGIN
  -- 1. Admin only.
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'เฉพาะผู้ดูแลระบบเท่านั้นที่เรียกคืนล็อตได้';
  END IF;

  -- 2. Reason is required.
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'ต้องระบุเหตุผลการเรียกคืน';
  END IF;

  -- 3. Lock + fetch the lot.
  SELECT * INTO v_lot FROM stock_lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบล็อตที่ต้องการเรียกคืน';
  END IF;
  IF v_lot.status = 'recalled' THEN
    RAISE EXCEPTION 'ล็อตนี้ถูกเรียกคืนไปแล้ว';
  END IF;

  -- 4. Remove the lot's on-hand stock at every location it occupies — BEFORE
  --    flipping status (movements post while the lot is still adjustable).
  --    Per-(location) on-hand of this lot = SUM(qty_delta) over its movements.
  FOR v_loc IN
    SELECT location_id, SUM(qty_delta) AS qty
    FROM stock_movements
    WHERE lot_id = p_lot_id
    GROUP BY location_id
    HAVING SUM(qty_delta) > 0
  LOOP
    INSERT INTO stock_movements
      (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note)
    VALUES
      (gen_random_uuid(), v_lot.item_id, v_loc.location_id, 'adjustment_loss',
       -v_loc.qty, p_lot_id, 'เรียกคืนล็อต', p_reason);
  END LOOP;

  -- 5. Flip status to recalled + audit columns.
  UPDATE stock_lots
    SET status          = 'recalled',
        recalled_reason = p_reason,
        recalled_by     = app_username(),
        recalled_at     = now(),
        updated_at      = now(),
        updated_by      = app_username()
  WHERE id = p_lot_id;
END;
$rpc_recall_lot$;

COMMENT ON FUNCTION rpc_recall_lot(uuid, text) IS
  'Phase 2. Admin-only. Recalls a lot AND removes its stock: posts an '
  'adjustment_loss movement per location to zero the lot out, then sets '
  'status=recalled with audit columns. SECURITY DEFINER. Movements post '
  'before the status flip so check_lot_status permits them.';

GRANT EXECUTE ON FUNCTION rpc_recall_lot(uuid, text) TO authenticated;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function exists and is SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='rpc_recall_lot';
--    Expected: 1 row, prosecdef = true
--
-- B) End-to-end (after applying): recall a test lot via the ล็อตยา page —
--    the lot's คงเหลือ must drop to 0, the item total must drop by the
--    recalled qty, and the movement log must show the adjustment_loss rows.
