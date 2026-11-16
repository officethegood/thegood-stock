-- 20261116010000_return_any_picked_loan.sql
-- Anyone may return a loan they pick, whoever borrowed it (decision Pex 2026-11-16).
--
-- Equipment is often brought back by someone other than the borrower (report Chittawan
-- 2026-11-16: an infusion pump borrowed by TG6401). Since 20260715 a non-Admin return was
-- always booked to the caller, so nobody but the borrower or an Admin could return it.
--
-- Now, when the return names the picked loan (source_movement_id = its movement_id_borrow),
-- the loan's own borrower is used, for every role. Who actually brought it back is still
-- recorded: performed_by is stamped from the JWT (stamp_movement_actor, 20261105040000).
-- Without a picked loan (pages still running an old cached version) the old rule stays:
-- a non-Admin return is for the caller's own newest loan, so nobody closes a loan by guess.
-- The qty guard (= the picked loan's qty) and the lot taken from the loan are unchanged.
--
-- Body starts from the LATEST version (20261109010000). Triggers untouched.
-- Idempotent. Ends with a go/no-go SELECT.

CREATE OR REPLACE FUNCTION validate_borrow_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $validate_borrow$
DECLARE
  v_loan     stock_loans;
  v_borrower text;
BEGIN
  IF NEW.movement_type NOT IN ('borrow', 'return') THEN
    RETURN NEW;
  END IF;

  IF NEW.borrower_username IS NULL THEN
    NEW.borrower_username := app_username();
  END IF;

  IF NEW.movement_type = 'return' THEN
    IF NEW.source_movement_id IS NOT NULL THEN
      -- The picked loan decides whose loan this is (any role may return it).
      SELECT borrower_username INTO v_borrower
      FROM   stock_loans
      WHERE  movement_id_borrow = NEW.source_movement_id
        AND  item_id = NEW.item_id
        AND  status IN ('active', 'overdue');
      IF FOUND THEN
        NEW.borrower_username := v_borrower;
      END IF;
      -- Not found: close_loan_from_return raises 'ไม่พบรายการยืมที่เปิดอยู่'.
    ELSIF app_user_role() <> 'Admin' THEN
      -- No picked loan (old page): a non-Admin returns only their own (20260715).
      NEW.borrower_username := app_username();
    END IF;
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
  END IF;

  RETURN NEW;
END;
$validate_borrow$;

COMMENT ON FUNCTION validate_borrow_movement() IS
  'BEFORE INSERT on stock_movements (borrow/return). Borrow: due_at rules. Return: with a '
  'picked loan (source_movement_id) the loan''s borrower is used for any role; without one a '
  'non-Admin returns only their own newest loan. Lot comes from the loan. 20261116010000.';

-- Go/no-go: picked_loan_any_role = true, security_definer = true.
SELECT proname, prosecdef AS security_definer,
       position('any role may return it' IN prosrc) > 0 AS picked_loan_any_role
FROM pg_proc WHERE proname = 'validate_borrow_movement';
