-- supabase/migrations/20260519030300_borrow_return_triggers.sql
-- Phase 3 — Trigger functions for borrow/return stock_loans lifecycle.
--
-- Trigger firing order on stock_movements INSERT (Phase 1 + Phase 2 + Phase 3):
--   BEFORE: trg_check_lot_status   (Phase 2 — c < e sorts before enforce_movement_sign)
--   BEFORE: trg_sm_sign            (Phase 1 — enforce_movement_sign)
--   BEFORE: trg_sm_borrow_validate (Phase 3 — NEW: validate borrow fields)
--   AFTER:  trg_sm_apply           (Phase 1+2 — apply_movement_to_sil; fires before Phase 3 triggers)
--   AFTER:  trg_lot_qty_apply      (Phase 2 — belt-and-braces lot qty guard)
--   AFTER:  trg_sm_lowstock        (Phase 1 — check_low_stock)
--   AFTER:  trg_sm_create_loan     (Phase 3 — NEW: create stock_loans on borrow)
--   AFTER:  trg_sm_close_loan      (Phase 3 — NEW: close stock_loans on return)
--
-- Error strings (FE greppable — EXACT, do NOT change wording):
--   'ต้องระบุกำหนดคืน'        — BEFORE INSERT: borrow without due_at
--   'ของยืมเลยกำหนด'          — BEFORE INSERT: due_at in the past (guard; unlikely path)
--   'ไม่พบรายการยืมที่เปิดอยู่'  — AFTER INSERT return: no active loan found for borrower+item
--
-- Settings reads: NONE in this file (no pg_net calls here).
-- SECURITY DEFINER: on create_loan_from_borrow and close_loan_from_return
--   to bypass stock_loans RLS (no client INSERT policy on stock_loans).

-- ==========================================================================
-- 1) BEFORE INSERT — validate_borrow_movement
--    Fires for ALL movement types; acts only on 'borrow'.
--    (a) Enforces due_at NOT NULL on borrow.
--    (b) Guards against borrow with due_at in the past.
--    (c) Sets borrower_username = COALESCE(NEW.borrower_username, app_username()).
-- ==========================================================================

CREATE OR REPLACE FUNCTION validate_borrow_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $validate_borrow$
BEGIN
  -- Short-circuit for non-borrow / non-return movements.
  IF NEW.movement_type NOT IN ('borrow', 'return') THEN
    RETURN NEW;
  END IF;

  -- Set borrower_username to caller's username if not explicitly provided.
  -- Q-Phase3-D: Admin proxy-borrow passes explicit borrower_username; Staff path omits it.
  IF NEW.borrower_username IS NULL THEN
    NEW.borrower_username := app_username();
  END IF;

  -- Borrow-specific validation only.
  IF NEW.movement_type = 'borrow' THEN

    -- Q-Phase3-E: due_at required on borrow movements.
    -- EXACT error string — FE shared/loans.js mapTriggerErrorToToast greps this.
    IF NEW.due_at IS NULL THEN
      RAISE EXCEPTION 'ต้องระบุกำหนดคืน';
    END IF;

    -- Guard: due_at in the past. Advisory string — FE greps 'ของยืมเลยกำหนด'.
    -- Unlikely in normal flow (UI enforces min=tomorrow) but DB must be consistent.
    IF NEW.due_at <= now() THEN
      RAISE EXCEPTION 'ของยืมเลยกำหนด';
    END IF;

  END IF;

  RETURN NEW;
END;
$validate_borrow$;

COMMENT ON FUNCTION validate_borrow_movement() IS
  'Phase 3 BEFORE INSERT on stock_movements. '
  'Enforces due_at NOT NULL on borrow (raises ''ต้องระบุกำหนดคืน''). '
  'Guards against past due_at (raises ''ของยืมเลยกำหนด''). '
  'Sets borrower_username = app_username() when not supplied (Q-Phase3-D staff path). '
  'FE shared/loans.js greps both Thai error strings for toast mapping.';

DROP TRIGGER IF EXISTS trg_sm_borrow_validate ON stock_movements;
CREATE TRIGGER trg_sm_borrow_validate
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION validate_borrow_movement();

-- ==========================================================================
-- 2) AFTER INSERT — create_loan_from_borrow (SECURITY DEFINER)
--    Fires when movement_type = 'borrow'.
--    Creates a stock_loans row with status='active'.
--    photo_borrow_url starts NULL — FE PATCHes after Cloudinary upload (Q-Phase3-C).
-- ==========================================================================

CREATE OR REPLACE FUNCTION create_loan_from_borrow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $create_loan$
BEGIN
  IF NEW.movement_type <> 'borrow' THEN
    RETURN NEW;
  END IF;

  INSERT INTO stock_loans (
    movement_id_borrow,
    item_id,
    location_id_from,
    borrower_username,
    borrowed_at,
    due_at,
    qty,
    notes,
    photo_borrow_url,
    status,
    created_by
  ) VALUES (
    NEW.id,
    NEW.item_id,
    NEW.location_id,
    -- borrower_username was set by BEFORE INSERT trigger; use it from NEW.
    NEW.borrower_username,
    COALESCE(NEW.performed_at, now()),
    NEW.due_at,                        -- Q-Phase3-E: read dedicated column (not note field)
    ABS(NEW.qty_delta),                -- borrow qty_delta is negative; store absolute value
    NEW.note,                          -- general notes verbatim from movement
    NULL,                              -- photo_borrow_url: FE PATCHes after upload (Q-Phase3-C)
    'active',
    NEW.performed_by
  );

  RETURN NEW;
END;
$create_loan$;

COMMENT ON FUNCTION create_loan_from_borrow() IS
  'Phase 3 AFTER INSERT on stock_movements (movement_type=borrow). '
  'SECURITY DEFINER bypasses stock_loans RLS (no client INSERT policy). '
  'Creates stock_loans row with status=active. '
  'photo_borrow_url starts NULL — FE PATCHes after Cloudinary upload (Q-Phase3-C advisory). '
  'qty = ABS(qty_delta) since borrow movements have negative qty_delta. '
  'due_at read from dedicated column (Q-Phase3-E — not encoded in note).';

DROP TRIGGER IF EXISTS trg_sm_create_loan ON stock_movements;
CREATE TRIGGER trg_sm_create_loan
  AFTER INSERT ON stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type = 'borrow')
  EXECUTE FUNCTION create_loan_from_borrow();

-- ==========================================================================
-- 3) AFTER INSERT — close_loan_from_return (SECURITY DEFINER)
--    Fires when movement_type = 'return'.
--    Finds the most recent active/overdue loan for (item_id, borrower_username).
--    Updates status='returned', returned_at, movement_id_return.
--    photo_return_url starts NULL — FE PATCHes after upload (Q-Phase3-C).
-- ==========================================================================

CREATE OR REPLACE FUNCTION close_loan_from_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $close_loan$
DECLARE
  v_loan_id     uuid;
  v_loan_status stock_loan_status;
BEGIN
  IF NEW.movement_type <> 'return' THEN
    RETURN NEW;
  END IF;

  -- Find most recent active/overdue loan for this item+borrower.
  -- borrower_username was set by BEFORE INSERT trigger to COALESCE(supplied, app_username()).
  SELECT id, status
  INTO v_loan_id, v_loan_status
  FROM stock_loans
  WHERE item_id          = NEW.item_id
    AND borrower_username = NEW.borrower_username
    AND status IN ('active', 'overdue')
  ORDER BY borrowed_at DESC
  LIMIT 1;

  -- EXACT error string — FE shared/loans.js greps 'ไม่พบรายการยืมที่เปิดอยู่'
  IF NOT FOUND THEN
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
  WHERE id = v_loan_id;

  RETURN NEW;
END;
$close_loan$;

COMMENT ON FUNCTION close_loan_from_return() IS
  'Phase 3 AFTER INSERT on stock_movements (movement_type=return). '
  'SECURITY DEFINER bypasses stock_loans RLS (UPDATE admin policy would block Employee). '
  'Finds most recent active/overdue loan for (item_id, borrower_username). '
  'Raises ''ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %'' when no open loan found. '
  'Sets status=returned, returned_at, movement_id_return. '
  'photo_return_url stays NULL — FE PATCHes after advisory photo upload (Q-Phase3-C).';

DROP TRIGGER IF EXISTS trg_sm_close_loan ON stock_movements;
CREATE TRIGGER trg_sm_close_loan
  AFTER INSERT ON stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type = 'return')
  EXECUTE FUNCTION close_loan_from_return();

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) All three triggers on stock_movements:
--    SELECT tgname,
--           CASE tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
--           tgenabled
--    FROM pg_trigger
--    WHERE tgrelid = 'stock_movements'::regclass
--      AND tgname IN ('trg_sm_borrow_validate','trg_sm_create_loan','trg_sm_close_loan')
--      AND NOT tgisinternal
--    ORDER BY tgname;
--    -- Expected: 3 rows
--    --   trg_sm_borrow_validate  BEFORE  O
--    --   trg_sm_close_loan       AFTER   O
--    --   trg_sm_create_loan      AFTER   O
--
-- 2) SECURITY DEFINER on create/close:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('create_loan_from_borrow','close_loan_from_return','validate_borrow_movement')
--    ORDER BY proname;
--    -- Expected:
--    --   close_loan_from_return    | true
--    --   create_loan_from_borrow   | true
--    --   validate_borrow_movement  | false
--
-- 3) Exact error string guard (paste into SQL Editor with a real item_id + location_id):
--    INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
--    VALUES ('<any item uuid>', '<any location uuid>', 'borrow', -1);
--    -- Expected: ERROR due_at IS NULL → 'ต้องระบุกำหนดคืน'
--
--    INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, due_at)
--    VALUES ('<any item uuid>', '<any location uuid>', 'borrow', -1, now() - INTERVAL '1 day');
--    -- Expected: ERROR due_at in past → 'ของยืมเลยกำหนด'
--
-- 4) Idempotency: run twice → CREATE OR REPLACE + DROP TRIGGER IF EXISTS → no error.
