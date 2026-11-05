-- Regression tests: a lot can only leave a location that holds it.
-- Reported case 2026-11-05: Miracid, box 3 holds lot B; the move form preselected lot A.
\set ON_ERROR_STOP on

INSERT INTO stock_items(id, sku, name) VALUES ('00000000-0000-0000-0000-000000000001','MIR','Miracid');
INSERT INTO locations(id, code) VALUES
  ('00000000-0000-0000-0000-00000000000a','STOCK'),
  ('00000000-0000-0000-0000-00000000000b','BOX1'),
  ('00000000-0000-0000-0000-00000000000c','BOX3');
INSERT INTO stock_lots(id, item_id, lot_number, expiry_date) VALUES
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','A-soonest', CURRENT_DATE + 100),
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000001','B-later',   CURRENT_DATE + 500);

CREATE FUNCTION t_move(p_type stock_movement_type, p_loc text, p_lot text, p_delta int) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id, due_at)
  SELECT '00000000-0000-0000-0000-000000000001', l.id, p_type, p_delta, sl.id,
         CASE WHEN p_type = 'borrow' THEN now() + interval '1 day' END
  FROM locations l, stock_lots sl WHERE l.code = p_loc AND sl.lot_number = p_lot;
$$;
CREATE FUNCTION t_transfer(p_lot text, p_from text, p_to text, p_qty int) RETURNS void
LANGUAGE sql AS $$
  SELECT transfer_stock('00000000-0000-0000-0000-000000000001', sl.id, f.id, t.id, p_qty,
                        false, false, 'test', gen_random_uuid())
  FROM stock_lots sl, locations f, locations t
  WHERE sl.lot_number = p_lot AND f.code = p_from AND t.code = p_to;
$$;
CREATE FUNCTION t_here(p_loc text, p_lot text) RETURNS bigint LANGUAGE sql AS $$
  SELECT COALESCE(SUM(sm.qty_delta), 0) FROM stock_movements sm
  JOIN locations l ON l.id = sm.location_id JOIN stock_lots sl ON sl.id = sm.lot_id
  WHERE l.code = p_loc AND sl.lot_number = p_lot;
$$;
-- Expect the statement to be rejected with the guard's message.
CREATE PROCEDURE t_rejected(p_label text, p_sql text) LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%ไม่พอในตำแหน่งนี้%' THEN
      RAISE NOTICE 'PASS  %', p_label;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  % — wrong error: %', p_label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % — was NOT rejected', p_label;
END $$;
CREATE PROCEDURE t_eq(p_label text, p_got bigint, p_want bigint) LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL  % — got % want %', p_label, p_got, p_want;
  END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;

SELECT t_move('receive','STOCK','A-soonest',30);
SELECT t_move('receive','BOX3','B-later',21);

-- ---- The test must be able to catch the bug: without the guard it reproduces. ----
BEGIN;
DROP TRIGGER trg_sm_lot_at_location ON stock_movements;
SELECT t_transfer('A-soonest','BOX3','BOX1',15);
CALL t_eq('bug reproduced without guard: lot A at BOX3 goes -15', t_here('BOX3','A-soonest'), -15);
CALL t_eq('bug reproduced without guard: lot A appears at BOX1', t_here('BOX1','A-soonest'), 15);
ROLLBACK;

-- ---- Wrong lot is rejected on every outgoing path ----
CALL t_rejected('transfer: lot not at source (the reported bug)', $$SELECT t_transfer('A-soonest','BOX3','BOX1',15)$$);
CALL t_rejected('issue: lot not at location',           $$SELECT t_move('issue','BOX3','A-soonest',-1)$$);
CALL t_rejected('borrow: lot not at location',          $$SELECT t_move('borrow','BOX3','A-soonest',-1)$$);
CALL t_rejected('adjustment_loss: lot not at location', $$SELECT t_move('adjustment_loss','BOX3','A-soonest',-1)$$);
-- Location has enough in total (21 B + 5 A = 26) but lot B alone does not.
BEGIN;
SELECT t_move('receive','BOX3','A-soonest',5);
CALL t_rejected('transfer: location has enough, this lot does not', $$SELECT t_transfer('B-later','BOX3','BOX1',22)$$);
ROLLBACK;
CALL t_eq('rejected attempts left no trace at BOX1', t_here('BOX1','A-soonest'), 0);

-- ---- Correct moves still work, and the lot travels with the stock ----
SELECT t_transfer('B-later','BOX3','BOX1',15);
CALL t_eq('transfer OK: lot B left at BOX3',  t_here('BOX3','B-later'), 6);
CALL t_eq('transfer OK: lot B arrived BOX1',  t_here('BOX1','B-later'), 15);
SELECT t_transfer('B-later','BOX1','BOX3',15);
CALL t_eq('move back: lot B at BOX3 restored', t_here('BOX3','B-later'), 21);
CALL t_eq('move back: BOX1 empty',             t_here('BOX1','B-later'), 0);

SELECT t_move('issue','BOX3','B-later',-1);
CALL t_eq('issue OK from a lot that is here', t_here('BOX3','B-later'), 20);
SELECT t_move('borrow','STOCK','A-soonest',-2);
SELECT t_move('return','STOCK','A-soonest',2);
SELECT t_move('adjustment_gain','BOX1','A-soonest',1);
SELECT t_move('adjustment_loss','BOX1','A-soonest',-1);
CALL t_eq('take the last unit: exact balance allowed', t_here('BOX1','A-soonest'), 0);
CALL t_rejected('one more than the last unit', $$SELECT t_move('issue','BOX1','A-soonest',-1)$$);

-- ---- Recall (admin) still removes everything the ledger shows ----
SELECT rpc_recall_lot((SELECT id FROM stock_lots WHERE lot_number = 'A-soonest'), 'test');
CALL t_eq('recall: lot A gone from STOCK', t_here('STOCK','A-soonest'), 0);

-- ---- System invariants (the same thing production audits should hold to) ----
DO $$
DECLARE v bigint;
BEGIN
  SELECT count(*) INTO v FROM (SELECT 1 FROM stock_movements WHERE lot_id IS NOT NULL
    GROUP BY location_id, lot_id HAVING SUM(qty_delta) < 0) x;
  CALL t_eq('invariant: no negative (location, lot)', v, 0);

  SELECT count(*) INTO v FROM stock_item_locations sil WHERE sil.qty <> (
    SELECT COALESCE(SUM(qty_delta), 0) FROM stock_movements sm
    WHERE sm.item_id = sil.item_id AND sm.location_id = sil.location_id);
  CALL t_eq('invariant: location qty = ledger', v, 0);

  SELECT count(*) INTO v FROM stock_lots sl WHERE sl.status <> 'recalled' AND sl.current_qty <> (
    SELECT COALESCE(SUM(qty_delta), 0) FROM stock_movements sm WHERE sm.lot_id = sl.id);
  CALL t_eq('invariant: lot qty = ledger (non-recalled)', v, 0);
END $$;

\echo ALL PASSED
