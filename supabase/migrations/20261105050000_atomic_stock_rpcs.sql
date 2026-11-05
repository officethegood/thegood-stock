-- supabase/migrations/20261105050000_atomic_stock_rpcs.sql
-- Multi-step writes that could stop halfway now run in one transaction.
--
-- Each of these was several separate requests from the browser. A dropped connection
-- or one failing row left half the work saved, with no way to tell what happened:
--   rpc_receive_new_lot    lot row + receive movement. A failure left an empty lot, and
--                          retrying then hit "ล็อตนี้มีอยู่แล้ว".
--   rpc_create_oxygen_tank tank row + first movement. A failure left a tank with no history
--                          (which is what happened to every new tank, see below).
--   rpc_clear_location     one loss per item. Lot-tracked items always failed (no lot_id
--                          sent), so a "clear" left the location partly full.
--   rpc_laundry_batch      ส่งซัก/รับคืน rows. A failure left some linen counted as moved.
--
-- All-or-nothing: any failing row rolls back the whole call, and the Thai message from
-- the trigger reaches the page. All triggers still fire for every row.
-- Roles match what the same writes already allowed.
-- Depends on: 20261105010000 (guard), transfer_stock, oxygen state-machine triggers.
-- Idempotent: CREATE OR REPLACE FUNCTION.

-- ==========================================================================
-- Restore the initial-placement fix lost in a migration copy.
-- 20260521040000 let a new tank's first movement (NULL → ready) through, but
-- 20260529010100 rebuilt the function from the older body and 20260715021000 copied
-- that. Since then "เพิ่มถัง O2" fails on the movement after the tank row is already
-- saved. Body: VERBATIM 20260715021000 + the COALESCE from 20260521040000.
-- ==========================================================================
CREATE OR REPLACE FUNCTION enforce_oxygen_state_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $enforce_oxygen_state_machine$
DECLARE
  v_current_status oxygen_tank_status;
  v_serial         text;
  v_role           text;
BEGIN
  SELECT status, serial
  INTO v_current_status, v_serial
  FROM oxygen_tanks
  WHERE id = NEW.tank_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'oxygen_tanks row not found for tank_id %', NEW.tank_id;
  END IF;

  v_role := app_user_role();  -- Phase 0 helper: 'Admin' or 'Employee'

  IF v_current_status = 'retired' THEN
    RAISE EXCEPTION 'ถังหมายเลข % ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้', v_serial;
  END IF;

  IF COALESCE(NEW.from_status, 'ready') IS DISTINCT FROM v_current_status THEN
    RAISE EXCEPTION 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)',
      v_current_status::text, COALESCE(NEW.from_status::text, 'NULL');
  END IF;

  IF NOT (
    -- Initial placement (NULL → ready, Admin only)
    (NEW.from_status IS NULL          AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- ready → on_board (Admin or Staff): ขึ้นรถ
    (NEW.from_status = 'ready'        AND NEW.to_status = 'on_board') OR
    -- on_board → ready (Admin or Staff): คืนถัง — ambulance returned, tank unused
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'ready') OR
    -- on_board → awaiting_refill (Admin or Staff): ลงรอเติม — off truck, staged at base
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'awaiting_refill') OR
    -- on_board → refilling (Admin or Staff): ส่งเติม — sent straight from truck
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'refilling') OR
    -- awaiting_refill → refilling (Admin or Staff): ส่งร้าน — batch sent to vendor
    (NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'refilling') OR
    -- awaiting_refill → ready (Admin only): ยกเลิกรอเติม — tank still has gas, correction
    (NEW.from_status = 'awaiting_refill' AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- refilling → ready (Admin only): เติมเสร็จ
    (NEW.from_status = 'refilling'    AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → maintenance (Admin only)
    (NEW.to_status = 'maintenance'    AND v_role = 'Admin') OR
    -- maintenance → ready (Admin only)
    (NEW.from_status = 'maintenance'  AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → retired (Admin only, terminal)
    (NEW.to_status = 'retired'        AND v_role = 'Admin')
  ) THEN
    -- FE grep target string (decisions-locked derived #5, verbatim):
    RAISE EXCEPTION 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง';
  END IF;

  RETURN NEW;
END;
$enforce_oxygen_state_machine$;

-- ==========================================================================
-- Receive into a NEW lot (Admin)
-- ==========================================================================
CREATE OR REPLACE FUNCTION rpc_receive_new_lot(
  p_item_id       uuid,
  p_location_id   uuid,
  p_lot_number    text,
  p_expiry_date   date,
  p_qty           int,
  p_supplier      text,
  p_lot_note      text,
  p_note          text,
  p_client_ref_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_receive_new_lot$
DECLARE
  v_lot_id uuid;
  v_mv     stock_movements;
BEGIN
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty, supplier, note)
  VALUES (p_item_id, p_lot_number, p_expiry_date, p_qty, 0, p_supplier, p_lot_note)
  RETURNING id INTO v_lot_id;

  INSERT INTO stock_movements (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, note)
  VALUES (p_client_ref_id, p_item_id, p_location_id, 'receive', p_qty, v_lot_id, p_note)
  RETURNING * INTO v_mv;

  RETURN jsonb_build_object('lot_id', v_lot_id, 'movement', to_jsonb(v_mv));
END;
$rpc_receive_new_lot$;

-- ==========================================================================
-- Add an oxygen tank + its first movement (Admin)
-- ==========================================================================
CREATE OR REPLACE FUNCTION rpc_create_oxygen_tank(
  p_serial              text,
  p_tank_size           text,
  p_location_id         uuid,
  p_next_inspection_due date,
  p_last_pressure_psi   int,
  p_notes               text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_create_oxygen_tank$
DECLARE
  v_id uuid;
BEGIN
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  INSERT INTO oxygen_tanks (serial, tank_size, current_location_id, next_inspection_due, last_pressure_psi, notes)
  VALUES (p_serial, p_tank_size, p_location_id, p_next_inspection_due, p_last_pressure_psi, p_notes)
  RETURNING id INTO v_id;

  INSERT INTO oxygen_movements (tank_id, from_status, to_status, to_location_id, note)
  VALUES (v_id, NULL, 'ready', p_location_id, 'เพิ่มถังใหม่เข้าระบบ');

  RETURN v_id;
END;
$rpc_create_oxygen_tank$;

-- ==========================================================================
-- Empty a location (Admin). Lot-tracked items are taken lot by lot, soonest expiry first.
-- ==========================================================================
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

-- ==========================================================================
-- Laundry batch: ส่งซัก / รับคืน (Admin + Employee, same as the single writes)
-- p_ops: [{ "op":"transfer", "item_id", "from", "to", "qty", "note" },
--         { "op":"loss",     "item_id", "from",       "qty", "note" }]
-- p_client_ref makes a retried submit fail with 23505 instead of applying twice.
-- ==========================================================================
CREATE OR REPLACE FUNCTION rpc_laundry_batch(
  p_client_ref uuid,
  p_ops        jsonb
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_laundry_batch$
DECLARE
  v_op  jsonb;
  v_i   int := 0;
  v_ref uuid;
  v_qty int;
BEGIN
  IF app_user_role() NOT IN ('Admin', 'Employee') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  FOR v_op IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    v_i   := v_i + 1;
    v_ref := md5(p_client_ref::text || ':' || v_i)::uuid;
    v_qty := (v_op->>'qty')::int;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'จำนวนไม่ถูกต้อง';
    END IF;

    IF v_op->>'op' = 'transfer' THEN
      PERFORM transfer_stock(
        (v_op->>'item_id')::uuid, NULL, (v_op->>'from')::uuid, (v_op->>'to')::uuid,
        v_qty, false, false, v_op->>'note', v_ref
      );
    ELSIF v_op->>'op' = 'loss' THEN
      INSERT INTO stock_movements (client_ref_id, item_id, location_id, movement_type, qty_delta, reason, note)
      VALUES (v_ref, (v_op->>'item_id')::uuid, (v_op->>'from')::uuid, 'adjustment_loss', -v_qty, 'laundry lost', v_op->>'note');
    ELSE
      RAISE EXCEPTION 'ไม่รู้จักรายการ %', v_op->>'op';
    END IF;
  END LOOP;

  RETURN v_i;
END;
$rpc_laundry_batch$;

REVOKE ALL ON FUNCTION rpc_receive_new_lot(uuid, uuid, text, date, int, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_create_oxygen_tank(text, text, uuid, date, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_clear_location(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_laundry_batch(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_receive_new_lot(uuid, uuid, text, date, int, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_create_oxygen_tank(text, text, uuid, date, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_clear_location(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_laundry_batch(uuid, jsonb) TO authenticated;

-- Verification (last statement, so the SQL Editor shows it). Expect 4 functions.
-- Any 'tank without history' rows were left behind by the old add-tank failure.
SELECT 'function' AS kind, proname AS name FROM pg_proc
WHERE  proname IN ('rpc_receive_new_lot','rpc_create_oxygen_tank','rpc_clear_location','rpc_laundry_batch')
UNION ALL
SELECT 'tank without history', t.serial FROM oxygen_tanks t
WHERE  NOT EXISTS (SELECT 1 FROM oxygen_movements m WHERE m.tank_id = t.id)
ORDER  BY 1, 2;
