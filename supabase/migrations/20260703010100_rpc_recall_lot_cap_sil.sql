-- supabase/migrations/20260703010100_rpc_recall_lot_cap_sil.sql
-- Bug fix — recalling a lot failed with
--   'new row for relation "stock_item_locations" violates check constraint
--    "stock_item_locations_qty_check"'
--
-- Bug:
--   rpc_recall_lot computes each location's lot balance from the lot-scoped
--   movement ledger (SUM(qty_delta) WHERE lot_id = X) and posts an
--   adjustment_loss for that amount. But stock_item_locations.qty at that
--   location can be LOWER than the lot-ledger figure when past movements took
--   lot-tracked stock out WITHOUT a lot_id (legacy moves/adjustments made
--   before the lot_id-required trigger, or manual set-absolute corrections).
--   The loss then drives sil.qty below 0 → qty_check rejects → the whole
--   recall rolls back and the admin cannot recall the lot at all
--   (live case: Strip DTX lot 24040718, 39 SET).
--
-- Fix:
--   Cap each location's write-off at what the location actually has
--   (LEAST(lot_ledger_qty, sil.qty), sil row locked FOR UPDATE). Any residual
--   the ledger attributes to the lot but the locations no longer hold is
--   reported back to the caller as `unaccounted` (jsonb return) and the lot's
--   current_qty is zeroed on the status flip — the lot is terminally recalled
--   either way, and the FE surfaces the discrepancy so the admin can hand-count
--   instead of the recall silently failing.
--
-- Return type changes void → jsonb, so the old function must be dropped first
-- (CREATE OR REPLACE cannot change return type).
--
-- Depends on: 20260522040000_rpc_recall_lot.sql (replaces it),
--             20260522020000 (adjustment_loss allowed on any-status lot),
--             20260522030000 (apply_movement_to_lot_qty).
-- Idempotent: DROP IF EXISTS + CREATE.

DROP FUNCTION IF EXISTS rpc_recall_lot(uuid, text);

CREATE FUNCTION rpc_recall_lot(
  p_lot_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_recall_lot$
DECLARE
  v_lot         stock_lots;
  v_loc         record;
  v_sil_qty     int;
  v_take        int;
  v_removed     int := 0;
  v_unaccounted int := 0;
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

  -- 4. Remove the lot's on-hand stock at every location the lot ledger says it
  --    occupies — capped at what the location ACTUALLY holds (sil.qty), so a
  --    ledger/SIL discrepancy can no longer abort the recall.
  FOR v_loc IN
    SELECT location_id, SUM(qty_delta) AS qty
    FROM stock_movements
    WHERE lot_id = p_lot_id
    GROUP BY location_id
    HAVING SUM(qty_delta) > 0
  LOOP
    SELECT qty INTO v_sil_qty
    FROM stock_item_locations
    WHERE item_id = v_lot.item_id AND location_id = v_loc.location_id
    FOR UPDATE;

    v_take := LEAST(v_loc.qty, GREATEST(COALESCE(v_sil_qty, 0), 0));

    IF v_take > 0 THEN
      INSERT INTO stock_movements
        (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note)
      VALUES
        (gen_random_uuid(), v_lot.item_id, v_loc.location_id, 'adjustment_loss',
         -v_take, p_lot_id, 'เรียกคืนล็อต', p_reason);
      v_removed := v_removed + v_take;
    END IF;

    v_unaccounted := v_unaccounted + (v_loc.qty - v_take);
  END LOOP;

  -- 5. Flip status to recalled + audit columns. current_qty is forced to 0:
  --    when v_unaccounted > 0 the ledger-maintained balance would stay above 0
  --    even though the recall is terminal — the discrepancy is reported to the
  --    caller instead of living on as phantom stock.
  UPDATE stock_lots
    SET status          = 'recalled',
        current_qty     = 0,
        recalled_reason = p_reason,
        recalled_by     = app_username(),
        recalled_at     = now(),
        updated_at      = now(),
        updated_by      = app_username()
  WHERE id = p_lot_id;

  RETURN jsonb_build_object(
    'removed',     v_removed,
    'unaccounted', v_unaccounted
  );
END;
$rpc_recall_lot$;

COMMENT ON FUNCTION rpc_recall_lot(uuid, text) IS
  'Phase 2 (v2 20260703010100). Admin-only. Recalls a lot AND removes its '
  'stock: posts an adjustment_loss per location capped at the location''s '
  'actual sil.qty (a lot-ledger/SIL discrepancy no longer aborts the recall), '
  'then sets status=recalled, current_qty=0, audit columns. Returns jsonb '
  '{removed, unaccounted} — unaccounted > 0 means the ledger attributed more '
  'units to the lot than the locations held (legacy lot-less outflows); the FE '
  'shows a hand-count warning.';

REVOKE ALL ON FUNCTION rpc_recall_lot(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_recall_lot(uuid, text) TO authenticated;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function exists, SECURITY DEFINER, returns jsonb:
--    SELECT proname, prosecdef, pg_get_function_result(oid)
--    FROM pg_proc WHERE proname='rpc_recall_lot';
--    Expected: rpc_recall_lot | true | jsonb
--
-- B) Live fix check: recall the previously-failing lot (Strip DTX 24040718)
--    from the ล็อตยา page — it must now succeed. If a warning about
--    unaccounted units appears, that is the surfaced ledger/SIL discrepancy
--    (hand-count that item). The lot row must show status=recalled,
--    current_qty=0, and sil.qty must never go negative:
--    SELECT count(*) FROM stock_item_locations WHERE qty < 0;   -- expect 0
