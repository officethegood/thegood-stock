-- supabase/migrations/20260519070500_rpc_transfer_stock.sql
-- Phase 0.7 — Transfer System RPC
-- Decisions: D4 (2-row transfer_out/transfer_in pattern), D5 (scanned flag),
--            G5 (scan or manual to leaf), G6 (audit trail), spec §5.1
-- Depends on: 20260518010300_stock_movements.sql (table, enum transfer_out/transfer_in)
--             20260519070400_stock_movements_scanned.sql (scanned column)
--             20260518010400_stock_item_locations.sql (sil table + apply_movement_to_sil trigger)
--
-- Assumptions:
--   Postgres 15. Extensions: pgcrypto (gen_random_uuid via pg_catalog — already in init migration).
--   Secret names: not used here (no Vault calls).
--   SECURITY DEFINER + SET search_path = 'public' per S-4 baseline.
--   apply_movement_to_sil() trigger fires AFTER INSERT on stock_movements and handles
--   stock_item_locations qty updates — this RPC must NOT upsert sil directly.
--   client_ref_id UNIQUE on stock_movements provides idempotency: retried call returns
--   a 23505 unique-violation which the API layer maps to HTTP 409.
--   p_lot_id is nullable (items that do not track lots).

CREATE OR REPLACE FUNCTION transfer_stock(
  p_item_id        uuid,
  p_lot_id         uuid,
  p_source_loc_id  uuid,
  p_dest_loc_id    uuid,
  p_qty            int,
  p_source_scanned boolean,
  p_dest_scanned   boolean,
  p_note           text,
  p_client_ref_id  uuid           -- idempotency key; maps to client_ref_id of transfer_out row
)
RETURNS uuid                       -- returns transfer_out.id as the transfer handle
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $func$
DECLARE
  v_out_id  uuid;
  v_current int;
BEGIN
  -- Validate: source <> destination
  IF p_source_loc_id = p_dest_loc_id THEN
    RAISE EXCEPTION 'ตำแหน่งต้นทางและปลายทางต้องไม่เหมือนกัน';
  END IF;

  -- Validate: positive quantity
  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'จำนวนที่ย้ายต้องมากกว่า 0';
  END IF;

  -- Lock source sil row and read current qty
  -- FOR UPDATE prevents concurrent transfers from double-spending the same stock
  SELECT qty INTO v_current
  FROM stock_item_locations
  WHERE item_id = p_item_id AND location_id = p_source_loc_id
  FOR UPDATE;

  -- Validate: sufficient stock at source
  IF v_current IS NULL OR v_current < p_qty THEN
    RAISE EXCEPTION 'ของไม่พอ (มี % ต้องการ %)', COALESCE(v_current, 0), p_qty;
  END IF;

  -- Insert transfer_out row (negative delta)
  -- apply_movement_to_sil() trigger will decrement sil.qty at source automatically
  INSERT INTO stock_movements
    (client_ref_id, item_id, location_id, movement_type, qty_delta,
     lot_id, note, scanned)
  VALUES
    (p_client_ref_id, p_item_id, p_source_loc_id, 'transfer_out', -p_qty,
     p_lot_id, p_note, p_source_scanned)
  RETURNING id INTO v_out_id;

  -- Insert transfer_in row (positive delta), linked to out via source_movement_id
  -- apply_movement_to_sil() trigger will upsert sil.qty at destination automatically
  INSERT INTO stock_movements
    (item_id, location_id, movement_type, qty_delta,
     lot_id, note, scanned, source_movement_id)
  VALUES
    (p_item_id, p_dest_loc_id, 'transfer_in', p_qty,
     p_lot_id, p_note, p_dest_scanned, v_out_id);

  RETURN v_out_id;
END;
$func$;

COMMENT ON FUNCTION transfer_stock(uuid, uuid, uuid, uuid, int, boolean, boolean, text, uuid) IS
  'Phase 0.7. Atomically moves p_qty units of p_item_id from p_source_loc_id to p_dest_loc_id. '
  'Inserts 2 stock_movements rows (transfer_out + transfer_in) linked by source_movement_id. '
  'sil qty updated by apply_movement_to_sil() trigger — do not call this RPC and also update sil. '
  'p_client_ref_id is the idempotency key (maps to client_ref_id of the transfer_out row). '
  'Returns transfer_out.id. SECURITY DEFINER, accessible to authenticated only.';

-- Lock down access: authenticated only, no PUBLIC
REVOKE ALL ON FUNCTION transfer_stock(uuid, uuid, uuid, uuid, int, boolean, boolean, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transfer_stock(uuid, uuid, uuid, uuid, int, boolean, boolean, text, uuid) TO authenticated;

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor)
-- ============================================================
-- A) Function exists with correct signature:
--    SELECT proname, prosecdef, proconfig
--    FROM pg_proc
--    WHERE proname = 'transfer_stock';
--    Expected: transfer_stock | true | {search_path=public}
--
-- B) GRANT visible:
--    SELECT grantee, privilege_type
--    FROM information_schema.routine_privileges
--    WHERE routine_name = 'transfer_stock';
--    Expected: authenticated | EXECUTE  (public should NOT appear)
--
-- C) Smoke test (safe — runs in implicit txn, use real UUIDs from your DB):
--    -- SELECT transfer_stock(
--    --   '<item_id>', NULL,
--    --   '<source_loc_id>', '<dest_loc_id>',
--    --   1, true, false,
--    --   'smoke test', gen_random_uuid()
--    -- );
--    -- Expected: returns a UUID (the transfer_out movement id)
--    -- Check: SELECT * FROM stock_movements ORDER BY performed_at DESC LIMIT 2;
--    --        Two rows: transfer_out (qty_delta=-1) and transfer_in (qty_delta=+1),
--    --        transfer_in.source_movement_id = transfer_out.id
