-- The daily audit stays silent when clean and reports each kind of drift.
-- Runs after lot_location_test.sql, whose final state must be clean.
\set ON_ERROR_STOP on

INSERT INTO settings VALUES
  ('NOTIFY_SUPABASE_URL','https://x.test'), ('NOTIFY_SERVICE_ROLE_KEY','k'), ('NOTIFY_TELEGRAM_ENABLED','true');

CREATE PROCEDURE t_audit(p_label text, p_check int, p_want_msg text) LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  DELETE FROM http_log;
  PERFORM run_stock_audit_alert();
  SELECT body->>'message' INTO v_msg FROM http_log;
  IF NOT EXISTS (SELECT 1 FROM v_stock_audit_issues WHERE check_no = p_check) THEN
    RAISE EXCEPTION 'FAIL  % — check % found nothing', p_label, p_check;
  END IF;
  IF v_msg IS NULL OR v_msg NOT LIKE '%' || p_want_msg || '%' THEN
    RAISE EXCEPTION 'FAIL  % — message: %', p_label, v_msg;
  END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;

DO $$
DECLARE v bigint;
BEGIN
  PERFORM run_stock_audit_alert();
  SELECT count(*) INTO v FROM http_log;
  CALL t_eq('audit: clean data sends nothing', v, 0);
  SELECT count(*) INTO v FROM v_stock_audit_issues;
  CALL t_eq('audit: clean data has 0 issues', v, 0);
END $$;

-- The bug from the 2026-11-05 report, forced past the guard.
BEGIN;
DROP TRIGGER trg_sm_lot_at_location ON stock_movements;
SELECT t_move('receive','BOX1','B-later',5);
INSERT INTO stock_lots(item_id, lot_number, expiry_date)
  VALUES ('00000000-0000-0000-0000-000000000001','C-other', CURRENT_DATE + 300);
SELECT t_move('receive','STOCK','C-other',5);
SELECT t_transfer('C-other','BOX1','STOCK',3);
CALL t_audit('audit: reports a negative lot at a location', 1, 'ล็อตติดลบในตำแหน่ง');
ROLLBACK;

BEGIN;
UPDATE stock_lots SET current_qty = current_qty + 1 WHERE lot_number = 'B-later';
CALL t_audit('audit: reports lot qty that disagrees with the ledger', 2, 'ยอดล็อตไม่ตรงประวัติ');
ROLLBACK;

BEGIN;
UPDATE stock_item_locations SET qty = qty + 1
WHERE location_id = '00000000-0000-0000-0000-00000000000c';
CALL t_audit('audit: reports location qty that disagrees with the ledger', 3, 'ยอดตำแหน่งไม่ตรงประวัติ');
ROLLBACK;

BEGIN;
-- Lot-less stock on a lot-tracked item (e.g. a legacy return).
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000c','return',2);
CALL t_audit('audit: reports location qty that disagrees with its lots', 4, 'ยอดตำแหน่งไม่ตรงผลรวมล็อต');
ROLLBACK;

BEGIN;
UPDATE settings SET value = 'false' WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
UPDATE stock_lots SET current_qty = current_qty + 1 WHERE lot_number = 'B-later';
DELETE FROM http_log;
SELECT run_stock_audit_alert();
DO $$
DECLARE v bigint;
BEGIN
  SELECT count(*) INTO v FROM http_log;
  CALL t_eq('audit: respects NOTIFY_TELEGRAM_ENABLED=false', v, 0);
END $$;
ROLLBACK;

\echo AUDIT PASSED
