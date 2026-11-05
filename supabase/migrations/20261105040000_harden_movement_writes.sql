-- supabase/migrations/20261105040000_harden_movement_writes.sql
-- Close the remaining trust gaps in client writes to stock_movements, in the DB.
--
-- Background: the browser inserts stock_movements directly. Every write already passes
-- through BEFORE INSERT triggers, so the rules belong there: any path, including a
-- crafted request or a stale cached page, gets the same checks. Moving every write
-- behind RPCs would add risk (staff phones run cached code) without closing more than this.
--
-- 1) trg_sm_stamp_actor — who and when come from the JWT, never from the client.
--    performed_by / performed_role / performed_at were client-settable, so the audit
--    trail could be forged or backdated. No JWT (SQL Editor, cron): keep the supplied
--    value, or 'system'.
--    Also fixes shared/laundry.js sending performed_by: null, which violated NOT NULL
--    and made every "ผ้าหาย" row fail on insert.
--
-- 2) trg_sm_return_qty — a return must bring back exactly what the open loan took out.
--    close_loan_from_return closes the loan regardless of qty_delta, and the qty is
--    applied to stock independently, so "return 100" against a loan of 1 added 99 units.
--    Deferred in 20260715031000; the FE always sends loan.qty, so normal use is unaffected.
--    Name sorts after trg_sm_borrow_validate, which resolves borrower_username first.
--
-- 3) settings — NOTIFY_SERVICE_ROLE_KEY no longer reachable from any browser, Admin
--    included. The key bypasses all RLS; no page uses it. Triggers and cron read it as
--    SECURITY DEFINER and are unaffected. set_write was FOR ALL, which also granted Admin
--    SELECT on secret rows, so it is split per command.
--    The key was readable from Admin browsers until now: rotate it if that is a concern.
--
-- Depends on: 20260715031000, 20260519005000. Idempotent.

-- ==========================================================================
-- 1) Actor stamp
-- ==========================================================================
CREATE OR REPLACE FUNCTION stamp_movement_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $stamp_movement_actor$
DECLARE
  v_user text := NULLIF(app_username(), '');
BEGIN
  IF v_user IS NOT NULL THEN
    NEW.performed_by   := v_user;
    NEW.performed_role := app_user_role();
    NEW.performed_at   := now();
  ELSE
    NEW.performed_by   := COALESCE(NULLIF(NEW.performed_by, ''), 'system');
    NEW.performed_role := COALESCE(NEW.performed_role, '');
    NEW.performed_at   := COALESCE(NEW.performed_at, now());
  END IF;
  RETURN NEW;
END;
$stamp_movement_actor$;

COMMENT ON FUNCTION stamp_movement_actor() IS
  'BEFORE INSERT on stock_movements. performed_by/role/at come from the JWT, not the '
  'client. Without a JWT keeps the supplied value or ''system''. 20261105040000.';

DROP TRIGGER IF EXISTS trg_sm_stamp_actor ON stock_movements;
CREATE TRIGGER trg_sm_stamp_actor
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stamp_movement_actor();

-- ==========================================================================
-- 2) Return qty must match the loan being closed
-- ==========================================================================
CREATE OR REPLACE FUNCTION guard_return_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guard_return_qty$
DECLARE
  v_loan_qty int;
BEGIN
  -- Same lookup as close_loan_from_return. No open loan: that trigger raises.
  SELECT qty INTO v_loan_qty
  FROM   stock_loans
  WHERE  item_id           = NEW.item_id
    AND  borrower_username = NEW.borrower_username
    AND  status IN ('active', 'overdue')
  ORDER  BY borrowed_at DESC
  LIMIT  1;

  IF FOUND AND NEW.qty_delta <> v_loan_qty THEN
    RAISE EXCEPTION 'จำนวนคืนต้องเท่ากับจำนวนที่ยืม (ยืม % คืน %)', v_loan_qty, NEW.qty_delta;
  END IF;
  RETURN NEW;
END;
$guard_return_qty$;

COMMENT ON FUNCTION guard_return_qty() IS
  'BEFORE INSERT on stock_movements (return). qty_delta must equal the open loan qty. '
  '20261105040000.';

DROP TRIGGER IF EXISTS trg_sm_return_qty ON stock_movements;
CREATE TRIGGER trg_sm_return_qty
  BEFORE INSERT ON stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type = 'return')
  EXECUTE FUNCTION guard_return_qty();

-- ==========================================================================
-- 3) settings: secret rows invisible to every browser role
-- ==========================================================================
DROP POLICY IF EXISTS set_read   ON settings;
DROP POLICY IF EXISTS set_write  ON settings;
DROP POLICY IF EXISTS set_insert ON settings;
DROP POLICY IF EXISTS set_update ON settings;
DROP POLICY IF EXISTS set_delete ON settings;

CREATE POLICY set_read ON settings
  FOR SELECT TO authenticated
  USING (is_secret = false);
CREATE POLICY set_insert ON settings
  FOR INSERT TO authenticated
  WITH CHECK (app_user_role() = 'Admin' AND is_secret = false);
CREATE POLICY set_update ON settings
  FOR UPDATE TO authenticated
  USING (app_user_role() = 'Admin' AND is_secret = false)
  WITH CHECK (app_user_role() = 'Admin' AND is_secret = false);
CREATE POLICY set_delete ON settings
  FOR DELETE TO authenticated
  USING (app_user_role() = 'Admin' AND is_secret = false);

-- Verification (last statement, so the SQL Editor shows it). Expect 3 triggers/policies:
SELECT 'trigger' AS kind, tgname AS name FROM pg_trigger
WHERE  tgrelid = 'stock_movements'::regclass AND tgname IN ('trg_sm_stamp_actor','trg_sm_return_qty')
UNION ALL
SELECT 'policy', policyname FROM pg_policies WHERE tablename = 'settings'
ORDER  BY 1, 2;
