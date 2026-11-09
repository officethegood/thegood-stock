-- 20261109030000_clear_location_refuses_drift.sql
-- "ล้างตำแหน่ง" no longer reports success while lot balances are still left behind
-- (review 2026-11-08, #10).
--
-- Before: for a lot-tracked item it wrote off the positive lots up to the location qty. If the
-- location already carried a negative lot (old drift, e.g. lot X = -1 and lot Y = +3 with qty 2)
-- it wrote off 2 of Y and said "done", leaving Y = +1 and X = -1 — a location that looks empty
-- but still holds lot balances, which then surface as phantom stock or audit alerts.
-- Now: after writing off an item, every lot of that item at this location must be at 0;
-- otherwise the whole clear rolls back with a Thai message pointing at the lot drift.
--
-- Body starts from the LATEST version (20261105050000). Idempotent. Ends with go/no-go SELECT.

CREATE OR REPLACE FUNCTION rpc_clear_location(
  p_location_id uuid,
  p_note        text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_clear_location$
DECLARE
  v_sil    record;
  v_lot    record;
  v_left   int;
  v_take   int;
  v_items  int := 0;
  v_total  int := 0;
  v_drift  text;
BEGIN
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  FOR v_sil IN
    SELECT s.item_id, s.qty, si.sku, si.tracks_lots
    FROM   stock_item_locations s
    JOIN   stock_items si ON si.id = s.item_id
    WHERE  s.location_id = p_location_id AND s.qty > 0
    FOR UPDATE OF s
  LOOP
    v_left := v_sil.qty;

    IF v_sil.tracks_lots THEN
      FOR v_lot IN
        SELECT sm.lot_id, SUM(sm.qty_delta)::int AS net
        FROM   stock_movements sm
        JOIN   stock_lots sl ON sl.id = sm.lot_id
        WHERE  sm.item_id = v_sil.item_id AND sm.location_id = p_location_id
        GROUP  BY sm.lot_id, sl.expiry_date
        HAVING SUM(sm.qty_delta) > 0
        ORDER  BY sl.expiry_date
      LOOP
        EXIT WHEN v_left = 0;
        v_take := LEAST(v_lot.net, v_left);
        INSERT INTO stock_movements (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note)
        VALUES (gen_random_uuid(), v_sil.item_id, p_location_id, 'adjustment_loss', -v_take, v_lot.lot_id, 'clear_location', p_note);
        v_left := v_left - v_take;
      END LOOP;

      IF v_left > 0 THEN
        RAISE EXCEPTION 'ล้างตำแหน่งไม่ได้: % มี % ชิ้นที่ไม่ผูกล็อต — ยังไม่ได้ลบอะไร', v_sil.sku, v_left;
      END IF;

      -- NEW: nothing of this item may be left on any lot here.
      SELECT string_agg(sl.lot_number || ' (' || x.net || ')', ', ' ORDER BY sl.lot_number)
        INTO v_drift
      FROM (
        SELECT sm.lot_id, SUM(sm.qty_delta) AS net
        FROM   stock_movements sm
        WHERE  sm.item_id = v_sil.item_id AND sm.location_id = p_location_id
          AND  sm.lot_id IS NOT NULL
        GROUP  BY sm.lot_id
        HAVING SUM(sm.qty_delta) <> 0
      ) x
      JOIN stock_lots sl ON sl.id = x.lot_id;

      IF v_drift IS NOT NULL THEN
        RAISE EXCEPTION 'ล้างตำแหน่งไม่ได้: % ยอดล็อตไม่ตรงกับยอดตำแหน่ง — ยังเหลือล็อต % — ยังไม่ได้ลบอะไร ต้องซ่อมยอดล็อตก่อน',
          v_sil.sku, v_drift;
      END IF;
    ELSE
      INSERT INTO stock_movements (client_ref_id, item_id, location_id, movement_type, qty_delta, reason, note)
      VALUES (gen_random_uuid(), v_sil.item_id, p_location_id, 'adjustment_loss', -v_left, 'clear_location', p_note);
    END IF;

    v_items := v_items + 1;
    v_total := v_total + v_sil.qty;
  END LOOP;

  RETURN jsonb_build_object('items', v_items, 'qty', v_total);
END;
$rpc_clear_location$;

REVOKE ALL ON FUNCTION rpc_clear_location(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_clear_location(uuid, text) TO authenticated;

-- Go/no-go: refuses_drift = true.
SELECT proname, prosecdef AS security_definer,
       position('ยอดล็อตไม่ตรงกับยอดตำแหน่ง' IN prosrc) > 0 AS refuses_drift
FROM pg_proc WHERE proname = 'rpc_clear_location';
