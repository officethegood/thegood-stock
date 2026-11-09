-- Fixes from the 2026-11-08 review. Runs after hardening_test.sql and reuses its helpers
-- (t_eq, t_q, t_raises). Uses its own item so earlier tests (recalls etc.) don't interfere.
-- Every block rolls back.
\set ON_ERROR_STOP on

INSERT INTO stock_items(id, sku, name, tracks_lots) VALUES ('00000000-0000-0000-0000-0000000000e1','RET','Return test',true);
INSERT INTO locations(id, code) VALUES ('00000000-0000-0000-0000-0000000000e2','RSTOCK'),('00000000-0000-0000-0000-0000000000e3','RBOX');
INSERT INTO stock_lots(item_id, lot_number, expiry_date) VALUES
  ('00000000-0000-0000-0000-0000000000e1','R-A',CURRENT_DATE+200),
  ('00000000-0000-0000-0000-0000000000e1','R-B',CURRENT_DATE+300);
CREATE FUNCTION r_move(p_type stock_movement_type, p_loc text, p_lot text, p_delta int) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id, due_at)
  SELECT '00000000-0000-0000-0000-0000000000e1', l.id, p_type, p_delta, sl.id,
         CASE WHEN p_type = 'borrow' THEN now() + interval '1 day' END
  FROM locations l, stock_lots sl
  WHERE l.code = p_loc AND sl.lot_number = p_lot AND sl.item_id = '00000000-0000-0000-0000-0000000000e1';
$$;
CREATE FUNCTION r_here(p_loc text, p_lot text) RETURNS bigint LANGUAGE sql AS $$
  SELECT COALESCE(SUM(sm.qty_delta), 0) FROM stock_movements sm
  JOIN locations l ON l.id = sm.location_id JOIN stock_lots sl ON sl.id = sm.lot_id
  WHERE l.code = p_loc AND sl.lot_number = p_lot;
$$;
SELECT r_move('receive','RSTOCK','R-A',10);
SELECT r_move('receive','RBOX','R-B',10);

-- ---- #3 A return closes the loan the user picked ----
-- Two open loans of the same item by the same person: A (older, lot R-A, 1) then B (lot R-B, 2).
CREATE FUNCTION t_borrow_id(p_loc text, p_lot text) RETURNS uuid LANGUAGE sql AS $$
  SELECT sm.id FROM stock_movements sm
  JOIN locations l ON l.id = sm.location_id JOIN stock_lots sl ON sl.id = sm.lot_id
  WHERE sm.movement_type = 'borrow' AND l.code = p_loc AND sl.lot_number = p_lot
  ORDER BY sm.performed_at DESC, sm.id DESC LIMIT 1;
$$;
CREATE FUNCTION t_return(p_loc text, p_qty int, p_source uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, source_movement_id)
  SELECT '00000000-0000-0000-0000-0000000000e1', l.id, 'return', p_qty, p_source
  FROM locations l WHERE l.code = p_loc;
$$;
CREATE FUNCTION t_loan_status(p_source uuid) RETURNS text LANGUAGE sql AS $$
  SELECT status::text FROM stock_loans WHERE movement_id_borrow = p_source;
$$;

BEGIN;
SELECT r_move('borrow','RSTOCK','R-A',-1);
UPDATE stock_loans SET borrowed_at = borrowed_at - interval '1 hour'  -- A is the older loan
 WHERE movement_id_borrow = t_borrow_id('RSTOCK','R-A');
SELECT r_move('borrow','RBOX','R-B',-2);
DO $$
DECLARE
  a uuid := t_borrow_id('RSTOCK','R-A');
  b uuid := t_borrow_id('RBOX','R-B');
  a_stock_before bigint := r_here('RSTOCK','R-A');
  b_box3_before  bigint := r_here('RBOX','R-B');
BEGIN
  PERFORM t_return('RSTOCK', 1, a);
  IF t_loan_status(a) <> 'returned' OR t_loan_status(b) NOT IN ('active','overdue') THEN
    RAISE EXCEPTION 'FAIL  return: older loan picked → A=% B=%', t_loan_status(a), t_loan_status(b);
  END IF;
  RAISE NOTICE 'PASS  return: picking the older loan closes that loan, not the newest';
  IF r_here('RSTOCK','R-A') <> a_stock_before + 1 OR r_here('RBOX','R-B') <> b_box3_before THEN
    RAISE EXCEPTION 'FAIL  return: lot credited wrong (A here %→%, B here %→%)',
      a_stock_before, r_here('RSTOCK','R-A'), b_box3_before, r_here('RBOX','R-B');
  END IF;
  RAISE NOTICE 'PASS  return: the picked loan''s lot comes back';
END $$;
ROLLBACK;

BEGIN;
SELECT r_move('borrow','RSTOCK','R-A',-1);
UPDATE stock_loans SET borrowed_at = borrowed_at - interval '1 hour'  -- A is the older loan
 WHERE movement_id_borrow = t_borrow_id('RSTOCK','R-A');
SELECT r_move('borrow','RBOX','R-B',-2);
CALL t_raises('return: qty is checked against the picked loan',
  $$SELECT t_return('RSTOCK', 2, t_borrow_id('RSTOCK','R-A'))$$, 'จำนวนคืนต้องเท่ากับจำนวนที่ยืม');
-- A cached page sends no source: old rule, newest loan (B) closes.
SELECT t_return('RBOX', 2, NULL);
CALL t_eq('return: no source still closes the newest loan (cached pages keep working)',
  t_q($q$SELECT count(*) FROM stock_loans WHERE movement_id_borrow = t_borrow_id('RBOX','R-B') AND status = 'returned'$q$), 1);
-- A client-sent lot cannot override the picked loan's lot.
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, source_movement_id, lot_id)
SELECT '00000000-0000-0000-0000-0000000000e1', l.id, 'return', 1, t_borrow_id('RSTOCK','R-A'), sl.id
FROM locations l, stock_lots sl WHERE l.code = 'RSTOCK' AND sl.lot_number = 'R-B' AND sl.item_id = '00000000-0000-0000-0000-0000000000e1';
CALL t_eq('return: picked loan decides the lot, not the client',
  t_q($q$SELECT count(*) FROM stock_movements sm JOIN stock_lots sl ON sl.id = sm.lot_id
         WHERE sm.movement_type = 'return' AND sm.source_movement_id IS NOT NULL AND sl.lot_number = 'R-A'$q$), 1);
ROLLBACK;

BEGIN;
SELECT r_move('borrow','RSTOCK','R-A',-1);
SET LOCAL test.role = 'Employee';
SET LOCAL test.username = 'someone-else';
CALL t_raises('return: another person''s loan cannot be closed by picking it',
  $$SELECT t_return('RSTOCK', 1, t_borrow_id('RSTOCK','R-A'))$$, 'ไม่พบรายการยืมที่เปิดอยู่');
ROLLBACK;

-- ---- #5 Deleting a location never deletes stock history ----
INSERT INTO locations(id, code) VALUES ('00000000-0000-0000-0000-0000000000e4','RUSED'),('00000000-0000-0000-0000-0000000000e5','RNEW');
BEGIN;
SELECT r_move('receive','RUSED','R-A',1);
SELECT r_move('adjustment_loss','RUSED','R-A',-1);
CALL t_raises('delete location: one with history is refused',
  $$SELECT rpc_delete_location('00000000-0000-0000-0000-0000000000e4')$$, 'ใช้ "ปิดใช้งาน" แทน');
CALL t_eq('delete location: its history is still there',
  t_q($q$SELECT count(*) FROM stock_movements WHERE location_id = '00000000-0000-0000-0000-0000000000e4'$q$), 2);
SELECT rpc_delete_location('00000000-0000-0000-0000-0000000000e5');
CALL t_eq('delete location: a never-used one is deleted',
  t_q($q$SELECT count(*) FROM locations WHERE id = '00000000-0000-0000-0000-0000000000e5'$q$), 0);
ROLLBACK;

-- ---- #10 Clearing a location refuses to leave lot balances behind ----
INSERT INTO locations(id, code) VALUES ('00000000-0000-0000-0000-0000000000e6','RDRIFT');
BEGIN;
SELECT r_move('receive','RDRIFT','R-B',3);
-- Old drift the guard now prevents: lot R-A taken out of a place that never had it.
ALTER TABLE stock_movements DISABLE TRIGGER trg_sm_lot_at_location;
SELECT r_move('adjustment_loss','RDRIFT','R-A',-1);
ALTER TABLE stock_movements ENABLE TRIGGER trg_sm_lot_at_location;
CALL t_raises('clear location: lot drift left behind is refused',
  $$SELECT rpc_clear_location('00000000-0000-0000-0000-0000000000e6', 'test')$$, 'ยอดล็อตไม่ตรงกับยอดตำแหน่ง');
CALL t_eq('clear location: refused clear changed nothing', r_here('RDRIFT','R-B'), 3);
ROLLBACK;

BEGIN;
SELECT r_move('receive','RDRIFT','R-B',3);
SELECT rpc_clear_location('00000000-0000-0000-0000-0000000000e6', 'test');
CALL t_eq('clear location: clean location still clears', r_here('RDRIFT','R-B'), 0);
ROLLBACK;

-- ---- #1 Bag restock moves stock out of the store instead of creating it ----
INSERT INTO locations(id, code, type) VALUES ('00000000-0000-0000-0000-0000000000e7','RBAG','bag');
INSERT INTO locations(id, code, type, parent_id) VALUES ('00000000-0000-0000-0000-0000000000e8','RZONE','zone','00000000-0000-0000-0000-0000000000e7');
CREATE FUNCTION r_restock(p_ref uuid, p_lines jsonb) RETURNS int LANGUAGE sql AS $$
  SELECT rpc_restock_bag('00000000-0000-0000-0000-0000000000e7', p_ref, 'test restock', p_lines);
$$;
CREATE FUNCTION r_total() RETURNS bigint LANGUAGE sql AS $$
  SELECT COALESCE(SUM(qty), 0) FROM stock_item_locations WHERE item_id = '00000000-0000-0000-0000-0000000000e1';
$$;
CREATE FUNCTION r_line(p_lot text, p_qty int, p_from uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('item_id','00000000-0000-0000-0000-0000000000e1','qty',p_qty,
    'lot_id',(SELECT id FROM stock_lots WHERE lot_number = p_lot AND item_id = '00000000-0000-0000-0000-0000000000e1'),
    'from',p_from);
$$;

BEGIN;
DO $$
DECLARE total_before bigint := r_total();
BEGIN
  PERFORM r_restock('11111111-1111-1111-1111-111111111111',
    jsonb_build_array(r_line('R-A', 3, '00000000-0000-0000-0000-0000000000e2')));
  IF r_here('RSTOCK','R-A') <> 7 OR r_here('RBAG','R-A') <> 3 OR r_total() <> total_before THEN
    RAISE EXCEPTION 'FAIL  restock from store: store %, bag %, total % (was %)',
      r_here('RSTOCK','R-A'), r_here('RBAG','R-A'), r_total(), total_before;
  END IF;
  RAISE NOTICE 'PASS  restock from store: store down, bag up, total unchanged';
  PERFORM r_restock('22222222-2222-2222-2222-222222222222',
    jsonb_build_array(r_line('R-B', 2, NULL)));
  IF r_here('RBAG','R-B') <> 2 OR r_total() <> total_before + 2 THEN
    RAISE EXCEPTION 'FAIL  restock new stock: bag %, total %', r_here('RBAG','R-B'), r_total();
  END IF;
  RAISE NOTICE 'PASS  restock of new stock: received straight into the bag';
END $$;
CALL t_raises('restock: the same submit twice is refused',
  $$SELECT r_restock('11111111-1111-1111-1111-111111111111', jsonb_build_array(r_line('R-A', 3, '00000000-0000-0000-0000-0000000000e2')))$$,
  'duplicate key');
CALL t_eq('restock: refused repeat changed nothing', r_here('RBAG','R-A'), 3);
ROLLBACK;

BEGIN;
CALL t_raises('restock: a bad line fails the whole restock',
  $$SELECT r_restock('33333333-3333-3333-3333-333333333333',
      jsonb_build_array(r_line('R-A', 1, '00000000-0000-0000-0000-0000000000e2'), r_line('R-A', 0, NULL)))$$,
  'รายการที่ 2');
CALL t_eq('restock: nothing saved after a failed line', r_here('RBAG','R-A'), 0);
CALL t_raises('restock: a lot that is not at the source is refused',
  $$SELECT r_restock('44444444-4444-4444-4444-444444444444', jsonb_build_array(r_line('R-B', 1, '00000000-0000-0000-0000-0000000000e2')))$$,
  'ไม่พอ');
CALL t_raises('restock: the bag''s own zone cannot be the source',
  $$SELECT r_restock('55555555-5555-5555-5555-555555555555', jsonb_build_array(r_line('R-A', 1, '00000000-0000-0000-0000-0000000000e8')))$$,
  'ต้นทางต้องไม่ใช่กระเป๋าใบนี้');
SET LOCAL test.role = 'Employee';
CALL t_raises('restock: staff cannot call it',
  $$SELECT r_restock('66666666-6666-6666-6666-666666666666', jsonb_build_array(r_line('R-A', 1, '00000000-0000-0000-0000-0000000000e2')))$$,
  'ไม่มีสิทธิ์');
ROLLBACK;

-- ---- #13 Moving stock does not fire a false low-stock alert ----
BEGIN;
-- Production binds this trigger in 20260518010500, which the stub schema does not load.
CREATE TRIGGER trg_sm_lowstock AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_low_stock();
INSERT INTO settings(key, value) VALUES ('NOTIFY_SUPABASE_URL','http://x'), ('NOTIFY_SERVICE_ROLE_KEY','k')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
UPDATE stock_items SET reorder_threshold = 15 WHERE id = '00000000-0000-0000-0000-0000000000e1';
DELETE FROM http_log;
SELECT transfer_stock('00000000-0000-0000-0000-0000000000e1',
  (SELECT id FROM stock_lots WHERE lot_number = 'R-A' AND item_id = '00000000-0000-0000-0000-0000000000e1'),
  '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3', 6, false, false, 't', gen_random_uuid());
CALL t_eq('low stock: a transfer sends no alert',
  t_q($q$SELECT count(*) FROM http_log WHERE body->>'event_type' = 'low_stock'$q$), 0);
SELECT r_move('issue','RBOX','R-B',-6);
CALL t_eq('low stock: a real issue below the threshold still alerts',
  t_q($q$SELECT count(*) FROM http_log WHERE body->>'event_type' = 'low_stock'$q$), 1);
ROLLBACK;
