-- 20261109010000_return_targets_selected_loan.sql
-- A return closes the loan the user picked, not the newest one (review 2026-11-08, #3).
--
-- Before: validate_borrow_movement (lot backfill), guard_return_qty and close_loan_from_return
-- all took "the newest open loan of this item for this borrower". With two open loans of the
-- same item, returning the older one closed the newer one, credited the newer loan's lot, and
-- the qty check compared against the wrong loan.
--
-- Now: a return may carry source_movement_id = the loan's movement_id_borrow (the column was
-- designed as this hook, 20260518010300). All three functions resolve the loan through ONE
-- helper, return_target_loan(), so they can never disagree:
--   * source given  → exactly that loan (same item, same borrower, still open) or nothing;
--                     its lot is FORCED onto the movement.
--   * source absent → the old rule (newest open loan). Staff phones still running a cached
--                     page keep working.
-- Error strings are unchanged (FE greps them).
--
-- Bodies start from the LATEST versions: validate_borrow_movement + close_loan_from_return
-- 20260715031000, guard_return_qty 20261105040000. Triggers are not touched.
-- Idempotent. Ends with a go/no-go SELECT.

-- ==========================================================================
-- 0) The one lookup
-- ==========================================================================
CREATE OR REPLACE FUNCTION return_target_loan(p_item_id uuid, p_borrower text, p_source uuid)
RETURNS stock_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $return_target_loan$
DECLARE
  r stock_loans;
BEGIN
  IF p_source IS NOT NULL THEN
    SELECT * INTO r
    FROM   stock_loans
    WHERE  movement_id_borrow = p_source
      AND  item_id            = p_item_id
      AND  borrower_username  = p_borrower
      AND  status IN ('active', 'overdue')
    FOR UPDATE;
  ELSE
    SELECT * INTO r
    FROM   stock_loans
    WHERE  item_id           = p_item_id
      AND  borrower_username = p_borrower
      AND  status IN ('active', 'overdue')
    ORDER  BY borrowed_at DESC
    LIMIT  1
    FOR UPDATE;
  END IF;
  RETURN r;   -- all-NULL row when nothing matches
END;
$return_target_loan$;

COMMENT ON FUNCTION return_target_loan(uuid, text, uuid) IS
  'The open loan a return closes: by source_movement_id (= movement_id_borrow) when given, '
  'else the newest open loan of item+borrower. Row-locked. 20261109010000.';

REVOKE ALL ON FUNCTION return_target_loan(uuid, text, uuid) FROM PUBLIC;

-- ==========================================================================
-- 1) validate_borrow_movement — 20260715031000 body; lot taken from return_target_loan
-- ==========================================================================
CREATE OR REPLACE FUNCTION validate_borrow_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $validate_borrow$
DECLARE
  v_loan stock_loans;
BEGIN
  IF NEW.movement_type NOT IN ('borrow', 'return') THEN
    RETURN NEW;
  END IF;

  IF NEW.borrower_username IS NULL THEN
    NEW.borrower_username := app_username();
  END IF;

  -- A non-Admin caller may not return on behalf of anyone else (20260715).
  IF NEW.movement_type = 'return' AND app_user_role() <> 'Admin' THEN
    NEW.borrower_username := app_username();
  END IF;

  IF NEW.movement_type = 'borrow' THEN
    -- EXACT strings — FE shared/loans.js mapTriggerErrorToToast greps these.
    IF NEW.due_at IS NULL THEN
      RAISE EXCEPTION 'ต้องระบุกำหนดคืน';
    END IF;
    IF NEW.due_at <= now() THEN
      RAISE EXCEPTION 'ของยืมเลยกำหนด';
    END IF;
  END IF;

  IF NEW.movement_type = 'return' THEN
    v_loan := return_target_loan(NEW.item_id, NEW.borrower_username, NEW.source_movement_id);
    IF v_loan.id IS NOT NULL THEN
      IF NEW.source_movement_id IS NOT NULL THEN
        -- The picked loan decides the lot; a client-sent lot cannot override it.
        NEW.lot_id := v_loan.lot_id;
      ELSIF NEW.lot_id IS NULL THEN
        NEW.lot_id := v_loan.lot_id;           -- old rule (20260709010000)
      END IF;
    END IF;
    -- No loan: leave as is; close_loan_from_return raises and rolls back.
  END IF;

  RETURN NEW;
END;
$validate_borrow$;

-- ==========================================================================
-- 2) guard_return_qty — 20261105040000 body; same lookup
-- ==========================================================================
CREATE OR REPLACE FUNCTION guard_return_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guard_return_qty$
DECLARE
  v_loan stock_loans;
BEGIN
  v_loan := return_target_loan(NEW.item_id, NEW.borrower_username, NEW.source_movement_id);
  IF v_loan.id IS NOT NULL AND NEW.qty_delta <> v_loan.qty THEN
    RAISE EXCEPTION 'จำนวนคืนต้องเท่ากับจำนวนที่ยืม (ยืม % คืน %)', v_loan.qty, NEW.qty_delta;
  END IF;
  RETURN NEW;
END;
$guard_return_qty$;

-- ==========================================================================
-- 3) close_loan_from_return — 20260715031000 body; same lookup
-- ==========================================================================
CREATE OR REPLACE FUNCTION close_loan_from_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $close_loan$
DECLARE
  v_loan     stock_loans;
  v_rowcount integer;
BEGIN
  IF NEW.movement_type <> 'return' THEN
    RETURN NEW;
  END IF;

  v_loan := return_target_loan(NEW.item_id, NEW.borrower_username, NEW.source_movement_id);

  -- EXACT error string — FE shared/loans.js greps 'ไม่พบรายการยืมที่เปิดอยู่'
  IF v_loan.id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %',
      NEW.borrower_username, NEW.item_id;
  END IF;

  UPDATE stock_loans
  SET
    movement_id_return = NEW.id,
    returned_at        = COALESCE(NEW.performed_at, now()),
    photo_return_url   = NULL,        -- FE PATCHes after Cloudinary upload (Q-Phase3-C)
    status             = 'returned',
    updated_by         = NEW.performed_by
  WHERE id = v_loan.id
    AND status IN ('active', 'overdue');

  GET DIAGNOSTICS v_rowcount = ROW_COUNT;
  IF v_rowcount = 0 THEN
    RAISE EXCEPTION 'ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %',
      NEW.borrower_username, NEW.item_id;
  END IF;

  RETURN NEW;
END;
$close_loan$;

COMMENT ON FUNCTION close_loan_from_return() IS
  'AFTER INSERT on stock_movements (return). Closes return_target_loan(): the loan picked '
  'via source_movement_id, else the newest open loan of item+borrower. 20261109010000.';

-- Go/no-go: 4 rows, every column true.
SELECT p.proname,
       p.prosecdef AS security_definer,
       (p.proname = 'return_target_loan'
        OR position('return_target_loan' IN p.prosrc) > 0) AS uses_helper
FROM   pg_proc p
WHERE  p.proname IN ('validate_borrow_movement', 'guard_return_qty',
                     'close_loan_from_return', 'return_target_loan')
ORDER  BY p.proname;
