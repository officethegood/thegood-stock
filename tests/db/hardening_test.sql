-- Actor stamp, return qty, secret settings, all-or-nothing RPCs, bag badge order.
-- Runs after audit_test.sql and reuses its helpers. Every block rolls back.
\set ON_ERROR_STOP on

CREATE FUNCTION t_q(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN v;
END $$;

CREATE PROCEDURE t_raises(p_label text, p_sql text, p_want text) LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%' || p_want || '%' THEN
      RAISE NOTICE 'PASS  %', p_label;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  % — wrong error: %', p_label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % — did not raise', p_label;
END $$;

INSERT INTO stock_items(id, sku, name, tracks_lots) VALUES
  ('00000000-0000-0000-0000-000000000002','LIN','Linen',false),
  ('00000000-0000-0000-0000-000000000003','GLU','Glucose',true);
INSERT INTO locations(id, code, name, type) VALUES
  ('00000000-0000-0000-0000-0000000000d1','WASH','Laundry shop','room'),
  ('00000000-0000-0000-0000-0000000000d2','CLEAN','Clean box','room'),
  ('00000000-0000-0000-0000-0000000000d3','CLR','To clear','room');

-- ---- Actor comes from the JWT ----
BEGIN;
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id, performed_by, performed_at, performed_role)
SELECT '00000000-0000-0000-0000-000000000001', l.id, 'receive', 1, sl.id, 'someone-else', '2020-01-01', 'Admin'
FROM locations l, stock_lots sl WHERE l.code = 'BOX1' AND sl.lot_number = 'B-later';
DO $$
DECLARE r stock_movements;
BEGIN
  SELECT * INTO r FROM stock_movements ORDER BY performed_at DESC, id LIMIT 1;
  IF r.performed_by <> 'test' OR r.performed_at < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'FAIL  actor: forged values kept (% %)', r.performed_by, r.performed_at;
  END IF;
  RAISE NOTICE 'PASS  actor: forged performed_by/performed_at are replaced';
END $$;
ROLLBACK;

BEGIN;
SET LOCAL test.username = 'none';
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id, performed_by)
SELECT '00000000-0000-0000-0000-000000000001', l.id, 'receive', 1, sl.id, 'admin'
FROM locations l, stock_lots sl WHERE l.code = 'BOX1' AND sl.lot_number = 'B-later';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_movements WHERE performed_by = 'admin') THEN
    RAISE EXCEPTION 'FAIL  actor: SQL Editor value lost';
  END IF;
  RAISE NOTICE 'PASS  actor: no JWT keeps the supplied value';
END $$;
ROLLBACK;

-- The laundry page used to send performed_by: null, which failed NOT NULL.
BEGIN;
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, performed_by)
VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d1','receive',1,NULL);
DO $$ BEGIN RAISE NOTICE 'PASS  actor: explicit NULL performed_by no longer fails'; END $$;
ROLLBACK;

-- ---- Return qty must equal the loan ----
BEGIN;
SELECT t_move('borrow','BOX3','B-later',-2);
CALL t_raises('return: more than borrowed is rejected',
  $$SELECT t_move('return','BOX3','B-later',99)$$, 'จำนวนคืนต้องเท่ากับจำนวนที่ยืม');
CALL t_raises('return: less than borrowed is rejected',
  $$SELECT t_move('return','BOX3','B-later',1)$$, 'จำนวนคืนต้องเท่ากับจำนวนที่ยืม');
SELECT t_move('return','BOX3','B-later',2);
CALL t_eq('return: exact qty closes the loan', t_q($q$SELECT count(*) FROM stock_loans WHERE status IN ('active','overdue')$q$), 0);
ROLLBACK;

-- ---- Secret settings are invisible to every browser role ----
BEGIN;
UPDATE settings SET value = 'secret', is_secret = true WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
INSERT INTO settings(key, value) VALUES ('PLAIN','x');
SET LOCAL ROLE authenticated;
SET LOCAL test.role = 'Admin';
DO $$
DECLARE v bigint;
BEGIN
  SELECT count(*) INTO v FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  CALL t_eq('settings: Admin cannot read the service key', v, 0);
  SELECT count(*) INTO v FROM settings WHERE key = 'PLAIN';
  CALL t_eq('settings: Admin still reads normal keys', v, 1);
  UPDATE settings SET value = 'hacked' WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  UPDATE settings SET value = 'y' WHERE key = 'PLAIN';
  GET DIAGNOSTICS v = ROW_COUNT;
  CALL t_eq('settings: Admin still edits normal keys', v, 1);
END $$;
RESET ROLE;
CALL t_eq('settings: service key unchanged', t_q($q$SELECT count(*) FROM settings WHERE key='NOTIFY_SERVICE_ROLE_KEY' AND value='secret'$q$), 1);
ROLLBACK;

-- ---- rpc_receive_new_lot: lot and movement together ----
BEGIN;
SELECT rpc_receive_new_lot('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d3',
  'N1', CURRENT_DATE + 100, 5, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000aaaa');
CALL t_eq('receive new lot: stock arrives', t_here('CLR','N1'), 5);
CALL t_raises('receive new lot: duplicate lot number is reported',
  $$SELECT rpc_receive_new_lot('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d3','N1',CURRENT_DATE+100,5,NULL,NULL,NULL,gen_random_uuid())$$,
  'uq_lot_per_item');
CALL t_raises('receive new lot: retry with same ref is rejected',
  $$SELECT rpc_receive_new_lot('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d3','N2',CURRENT_DATE+100,5,NULL,NULL,NULL,'00000000-0000-0000-0000-00000000aaaa')$$,
  'client_ref_id');
CALL t_eq('receive new lot: a failed call leaves no empty lot', t_q($q$SELECT count(*) FROM stock_lots WHERE lot_number='N2'$q$), 0);
ROLLBACK;

-- ---- rpc_clear_location: lot-tracked + plain, all-or-nothing ----
BEGIN;
INSERT INTO stock_lots(id, item_id, lot_number, expiry_date) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000003','SOON',CURRENT_DATE+10),
  ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000003','LATE',CURRENT_DATE+90);
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id) VALUES
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d3','receive',3,'00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d3','receive',4,'00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d3','receive',6,NULL);
SELECT rpc_clear_location('00000000-0000-0000-0000-0000000000d3','test');
CALL t_eq('clear location: everything is 0', t_q($q$SELECT COALESCE(SUM(qty),0) FROM stock_item_locations WHERE location_id='00000000-0000-0000-0000-0000000000d3'$q$), 0);
CALL t_eq('clear location: lot-tracked item cleared lot by lot', t_here('CLR','SOON') + t_here('CLR','LATE'), 0);
ROLLBACK;

BEGIN;
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta) VALUES
  ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d3','receive',6),
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000d3','transfer_in',2);
CALL t_raises('clear location: stock with no lot stops it',
  $$SELECT rpc_clear_location('00000000-0000-0000-0000-0000000000d3','test')$$, 'ไม่ผูกล็อต');
CALL t_eq('clear location: a failed call removes nothing', t_q($q$SELECT SUM(qty) FROM stock_item_locations WHERE location_id='00000000-0000-0000-0000-0000000000d3'$q$), 8);
ROLLBACK;

-- ---- rpc_laundry_batch: all rows or none ----
BEGIN;
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta) VALUES
  ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000d1','receive',5);
CALL t_raises('laundry: a failing row raises',
  $$SELECT rpc_laundry_batch(gen_random_uuid(), '[
    {"op":"transfer","item_id":"00000000-0000-0000-0000-000000000002","from":"00000000-0000-0000-0000-0000000000d1","to":"00000000-0000-0000-0000-0000000000d2","qty":3,"note":"x"},
    {"op":"transfer","item_id":"00000000-0000-0000-0000-000000000002","from":"00000000-0000-0000-0000-0000000000d1","to":"00000000-0000-0000-0000-0000000000d2","qty":9,"note":"x"}]'::jsonb)$$, 'ของไม่พอ');
CALL t_eq('laundry: the first row was undone', t_q($q$SELECT qty FROM stock_item_locations WHERE location_id='00000000-0000-0000-0000-0000000000d1'$q$), 5);
SELECT rpc_laundry_batch('00000000-0000-0000-0000-00000000bbbb', '[
    {"op":"loss","item_id":"00000000-0000-0000-0000-000000000002","from":"00000000-0000-0000-0000-0000000000d1","qty":1,"note":"lost"},
    {"op":"transfer","item_id":"00000000-0000-0000-0000-000000000002","from":"00000000-0000-0000-0000-0000000000d1","to":"00000000-0000-0000-0000-0000000000d2","qty":4,"note":"back"}]'::jsonb);
CALL t_eq('laundry: return + loss both saved', t_q($q$SELECT qty FROM stock_item_locations WHERE location_id='00000000-0000-0000-0000-0000000000d2'$q$), 4);
CALL t_raises('laundry: a repeated submit is rejected',
  $$SELECT rpc_laundry_batch('00000000-0000-0000-0000-00000000bbbb', '[
    {"op":"loss","item_id":"00000000-0000-0000-0000-000000000002","from":"00000000-0000-0000-0000-0000000000d2","qty":1,"note":"lost"}]'::jsonb)$$, 'client_ref_id');
ROLLBACK;

-- ---- rpc_create_oxygen_tank: real state-machine triggers ----
BEGIN;
SELECT rpc_create_oxygen_tank('T-1','small','00000000-0000-0000-0000-0000000000d3',CURRENT_DATE+100,NULL,NULL);
CALL t_eq('oxygen: tank is ready', t_q($q$SELECT count(*) FROM oxygen_tanks WHERE serial='T-1' AND status='ready'$q$), 1);
CALL t_eq('oxygen: first movement exists', t_q($q$SELECT count(*) FROM oxygen_movements m JOIN oxygen_tanks t ON t.id=m.tank_id WHERE t.serial='T-1'$q$), 1);
CALL t_raises('oxygen: duplicate serial is rejected',
  $$SELECT rpc_create_oxygen_tank('T-1','small','00000000-0000-0000-0000-0000000000d3',CURRENT_DATE+100,NULL,NULL)$$, 'oxygen_tanks');
ROLLBACK;

-- ---- Bag badge: expiry outranks "no template" ----
BEGIN;
INSERT INTO locations(id, code, name, type) VALUES
  ('00000000-0000-0000-0000-0000000000e1','BAG-X','Expired no template','bag'),
  ('00000000-0000-0000-0000-0000000000e2','BAG-S','Expiring no template','bag'),
  ('00000000-0000-0000-0000-0000000000e3','BAG-O','Fine no template','bag');
INSERT INTO stock_lots(id, item_id, lot_number, expiry_date) VALUES
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-000000000003','OLD', CURRENT_DATE-400),
  ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-000000000003','NEAR',CURRENT_DATE+10),
  ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-000000000003','FAR', CURRENT_DATE+900);
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id) VALUES
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000e1','receive',1,'00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000e2','receive',1,'00000000-0000-0000-0000-0000000000f2'),
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000e3','receive',1,'00000000-0000-0000-0000-0000000000f3');
CALL t_eq('bag badge: expired stock wins over no template', t_q($q$SELECT count(*) FROM v_bag_status WHERE bag_code='BAG-X' AND alert_level='expired'$q$), 1);
CALL t_eq('bag badge: expiring stock wins over no template', t_q($q$SELECT count(*) FROM v_bag_status WHERE bag_code='BAG-S' AND alert_level='expiring'$q$), 1);
CALL t_eq('bag badge: nothing expiring stays no template', t_q($q$SELECT count(*) FROM v_bag_status WHERE bag_code='BAG-O' AND alert_level='no_template'$q$), 1);
ROLLBACK;

\echo HARDENING PASSED
