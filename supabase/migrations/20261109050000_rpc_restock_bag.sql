-- 20261109050000_rpc_restock_bag.sql
-- Bag restock moves stock out of the store instead of creating it (review 2026-11-08, #1).
--
-- Before: the restock wizard (js/bags.js) inserted one 'receive' per line into the bag.
-- When the units physically came from the store room — the usual case — the store kept
-- showing them too, so the system had them twice. The ledger and the caches still agreed
-- with each other, so the daily audit could not see it. Each line was a separate insert with
-- a fresh client_ref, so a retry after a partial failure could add the same line again.
--
-- Now one call saves the whole restock, all-or-nothing. Each line says where it came from:
--   "from": <location uuid>  → transfer_stock from that location into the bag (the store
--                              goes down by the same qty; lot must be at that location —
--                              guard_lot_at_location enforces it)
--   "from": null             → 'receive' into the bag: stock that never went through the
--                              store (Chittawan 2026-11-09: some oral drugs go straight
--                              into the drug box)
-- p_client_ref is one UUID per wizard session; line i uses md5(ref||':'||i), so pressing
-- confirm twice fails with 23505 instead of saving twice (FE treats 23505 as "already saved").
--
-- Depends on transfer_stock (20260519070500), guard_lot_at_location (20261105010000),
-- check_low_stock skipping transfer_out (20261109040000 — apply that first).
-- Idempotent. Ends with go/no-go SELECT.

CREATE OR REPLACE FUNCTION rpc_restock_bag(
  p_bag_id     uuid,
  p_client_ref uuid,
  p_note       text,
  p_lines      jsonb   -- [{ "item_id", "qty", "lot_id"|null, "from"|null }]
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_restock_bag$
DECLARE
  v_line  jsonb;
  v_i     int := 0;
  v_qty   int;
  v_item  uuid;
  v_lot   uuid;
  v_from  uuid;
  v_ref   uuid;
BEGIN
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = p_bag_id AND type = 'bag') THEN
    RAISE EXCEPTION 'ไม่พบกระเป๋า';
  END IF;

  IF p_client_ref IS NULL THEN
    RAISE EXCEPTION 'ต้องมีรหัสอ้างอิงการเติมของ';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'ไม่มีรายการที่จะเติม';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_i    := v_i + 1;
    v_item := (v_line->>'item_id')::uuid;
    v_qty  := (v_line->>'qty')::int;
    v_lot  := NULLIF(v_line->>'lot_id', '')::uuid;
    v_from := NULLIF(v_line->>'from', '')::uuid;
    v_ref  := md5(p_client_ref::text || ':' || v_i)::uuid;

    IF v_item IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'รายการที่ % ไม่ถูกต้อง (ต้องมีสินค้าและจำนวนมากกว่า 0)', v_i;
    END IF;

    IF v_from IS NOT NULL THEN
      IF v_from = p_bag_id
         OR EXISTS (SELECT 1 FROM locations WHERE id = v_from AND parent_id = p_bag_id) THEN
        RAISE EXCEPTION 'รายการที่ %: ต้นทางต้องไม่ใช่กระเป๋าใบนี้', v_i;
      END IF;
      PERFORM transfer_stock(v_item, v_lot, v_from, p_bag_id, v_qty, false, false,
                             p_note, v_ref);
    ELSE
      INSERT INTO stock_movements
        (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note)
      VALUES
        (v_ref, v_item, p_bag_id, 'receive', v_qty, v_lot, 'bag_restock', p_note);
    END IF;
  END LOOP;

  RETURN v_i;
END;
$rpc_restock_bag$;

COMMENT ON FUNCTION rpc_restock_bag(uuid, uuid, text, jsonb) IS
  'Admin. Restocks a bag in one transaction: lines with "from" are transfers from that '
  'location (store goes down), lines without are receives into the bag. Line refs derive '
  'from p_client_ref so a repeated submit fails with 23505. 20261109050000.';

REVOKE ALL ON FUNCTION rpc_restock_bag(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_restock_bag(uuid, uuid, text, jsonb) TO authenticated;

-- Go/no-go: 1 row, security_definer = true.
SELECT proname, prosecdef AS security_definer
FROM pg_proc WHERE proname = 'rpc_restock_bag';
