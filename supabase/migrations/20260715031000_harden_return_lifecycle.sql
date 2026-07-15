-- supabase/migrations/20260715031000_harden_return_lifecycle.sql
-- Security hardening — the borrow/return lifecycle against spoofed returns.
--
-- Problem:
--   A Staff caller can POST a 'return' stock_movements row directly (REST, not the FE)
--   with:
--     (a) an arbitrary borrower_username — validate_borrow_movement only DEFAULTED it
--         when NULL, so a supplied value was trusted. Employee A could close Employee
--         B's loan by passing B's username.
--     (b) concurrency — close_loan_from_return picked the most-recent matching loan
--         with a plain SELECT (no row lock) and an unconditional UPDATE by id, so two
--         returns racing on the same loan both "succeeded", double-restoring stock.
--
-- Fix (DB-only, transparent to the CURRENT FE — no FE change ships this round):
--   1) validate_borrow_movement() — copied VERBATIM from its LATEST body
--      (20260709010000_borrow_lot_support.sql). ONLY delta: on movement_type='return',
--      when app_user_role() <> 'Admin' (JWT role, NOT performed_role), FORCE
--      NEW.borrower_username := app_username(), ignoring any client-supplied value.
--      Admin may still pass an explicit borrower_username (proxy return). This runs
--      BEFORE the existing lot_id backfill block, so the backfill and the downstream
--      loan lookup both use the forced (caller's own) username. The lot_id backfill
--      logic is kept intact.
--   2) close_loan_from_return() — copied VERBATIM from its LATEST body
--      (20260519030300_borrow_return_triggers.sql — still the only definition). ONLY
--      deltas: SELECT the target loan FOR UPDATE (same most-recent active/overdue
--      lookup); UPDATE ... WHERE id = v_loan_id AND status IN ('active','overdue') and
--      verify exactly one row changed (GET DIAGNOSTICS ROW_COUNT; if 0, RAISE the
--      SAME existing Thai string 'ไม่พบรายการยืมที่เปิดอยู่' so the FE toast is
--      unchanged). Under READ COMMITTED, a second concurrent return blocks on the
--      row lock, then re-reads the row now status='returned', no longer matches the
--      active/overdue filter → NOT FOUND → the Thai exception → whole txn rolls back.
--
-- Deferred (NOT changed here): fully validating qty_delta == loan.qty. The loan's own
--   qty is authoritative and the return movement's qty_delta is applied to stock by
--   apply_movement_to_lot_qty()/apply_movement_to_sil() INDEPENDENTLY of this function.
--   The current FE always sends qty_delta = loan.qty, so no drift today; enforcing the
--   equality server-side is deferred to the Phase-3 rpc_return_loan RPC.
--
-- Current-FE compatibility (shared/loans.js createReturn):
--   * Employee return omits borrower_username → forced to app_username() (identical to
--     today's NULL-default result).
--   * Admin return passes borrower_username → preserved (proxy return).
--   * qty already equals loan.qty.
--   → no FE change required.
--
-- Idempotent: CREATE OR REPLACE FUNCTION (triggers unchanged, not re-created).
-- Apply order: AFTER 20260709010000 (latest validate_borrow_movement body) and AFTER
--   20260519030300 (close_loan_from_return + its triggers). CREATE OR REPLACE only
--   swaps the function bodies; the existing trg_sm_borrow_validate (BEFORE) and
--   trg_sm_close_loan (AFTER) triggers keep pointing at them. Independent of 20260715032000.
-- Assumptions: Postgres (Supabase); helpers app_user_role()/app_username() from
--   20260518000000_init.sql; stock_loans + stock_loan_status enum + stock_loans.lot_id
--   (20260709010000) already present.

-- ==========================================================================
-- 1) validate_borrow_movement — LATEST body (20260709010000) + force
--    borrower_username to the caller on non-Admin return.
-- ==========================================================================

CREATE OR REPLACE FUNCTION validate_borrow_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $validate_borrow$
DECLARE
  v_loan_lot_id uuid;
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

  -- 20260715 harden: a non-Admin caller may not return on behalf of anyone else.
  -- FORCE borrower_username to the JWT caller (ignore any client-supplied value)
  -- BEFORE the lot_id backfill below, so the backfill and close_loan_from_return
  -- both scope to the caller's own open loan. Admin keeps its explicit value
  -- (proxy return). Trust app_user_role() (JWT), NOT NEW.performed_role.
  IF NEW.movement_type = 'return' AND app_user_role() <> 'Admin' THEN
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
    IF NEW.due_at <= now() THEN
      RAISE EXCEPTION 'ของยืมเลยกำหนด';
    END IF;

  END IF;

  -- 20260709010000: on return, backfill lot_id from the open loan so
  -- apply_movement_to_sil restores stock_lots.current_qty. The lookup MUST
  -- match close_loan_from_return (most recent active/overdue loan for
  -- item+borrower) so the movement's lot matches the loan being closed.
  -- SECURITY DEFINER (new on this function) is required for this read:
  -- stock_loans has no broad SELECT policy for Staff.
  IF NEW.movement_type = 'return' AND NEW.lot_id IS NULL THEN
    SELECT lot_id
      INTO v_loan_lot_id
    FROM stock_loans
    WHERE item_id           = NEW.item_id
      AND borrower_username = NEW.borrower_username
      AND status IN ('active', 'overdue')
    ORDER BY borrowed_at DESC
    LIMIT 1;

    -- No-loan case: leave NULL; close_loan_from_return raises
    -- 'ไม่พบรายการยืมที่เปิดอยู่' after and rolls the whole txn back.
    IF v_loan_lot_id IS NOT NULL THEN
      NEW.lot_id := v_loan_lot_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$validate_borrow$;

COMMENT ON FUNCTION validate_borrow_movement() IS
  'Phase 3 BEFORE INSERT on stock_movements. '
  'Enforces due_at NOT NULL on borrow (raises ''ต้องระบุกำหนดคืน''). '
  'Guards against past due_at (raises ''ของยืมเลยกำหนด''). '
  'Sets borrower_username = app_username() when not supplied (Q-Phase3-D). '
  '20260709010000: on return, backfills lot_id from the most recent open loan '
  '(same lookup as close_loan_from_return) so lot qty is restored on return. '
  '20260715: on non-Admin return, FORCES borrower_username = app_username() '
  '(ignores client value) so Staff cannot close another user''s loan; Admin keeps '
  'its explicit value for proxy returns. '
  'SECURITY DEFINER to read stock_loans past RLS for that backfill.';

-- ==========================================================================
-- 2) close_loan_from_return — LATEST body (20260519030300) + row lock and
--    conditional single-row close.
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
  v_rowcount    integer;
BEGIN
  IF NEW.movement_type <> 'return' THEN
    RETURN NEW;
  END IF;

  -- Find most recent active/overdue loan for this item+borrower.
  -- borrower_username was set by BEFORE INSERT trigger (forced to the caller for
  -- non-Admin returns; explicit for Admin). FOR UPDATE locks the chosen loan so a
  -- concurrent return of the same loan serializes: the loser re-reads it as
  -- status='returned', it no longer matches the filter, and NOT FOUND below raises.
  SELECT id, status
  INTO v_loan_id, v_loan_status
  FROM stock_loans
  WHERE item_id          = NEW.item_id
    AND borrower_username = NEW.borrower_username
    AND status IN ('active', 'overdue')
  ORDER BY borrowed_at DESC
  LIMIT 1
  FOR UPDATE;

  -- EXACT error string — FE shared/loans.js greps 'ไม่พบรายการยืมที่เปิดอยู่'
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %',
      NEW.borrower_username, NEW.item_id;
  END IF;

  -- Conditional close: only flip a loan that is still open. GET DIAGNOSTICS then
  -- verifies exactly one row changed; 0 means the loan was closed out from under us
  -- (concurrent return) — raise the SAME Thai string so the FE toast is unchanged.
  -- NOTE: qty math is intentionally NOT touched here — the loan's own qty is
  -- authoritative and the return movement's qty_delta is applied to stock by
  -- apply_movement_to_sil / apply_movement_to_lot_qty independently. Enforcing
  -- qty_delta == loan.qty server-side is deferred to the Phase-3 rpc_return_loan
  -- (the current FE always sends loan.qty).
  UPDATE stock_loans
  SET
    movement_id_return = NEW.id,
    returned_at        = COALESCE(NEW.performed_at, now()),
    photo_return_url   = NULL,        -- FE PATCHes after Cloudinary upload (Q-Phase3-C)
    status             = 'returned',
    updated_by         = NEW.performed_by
  WHERE id = v_loan_id
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
  'Phase 3 AFTER INSERT on stock_movements (movement_type=return). '
  'SECURITY DEFINER bypasses stock_loans RLS (UPDATE admin policy would block Employee). '
  'Finds most recent active/overdue loan for (item_id, borrower_username) FOR UPDATE. '
  'Raises ''ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %'' when no open loan found. '
  'Sets status=returned, returned_at, movement_id_return. '
  '20260715: FOR UPDATE row lock + conditional UPDATE ... WHERE status IN (active,overdue) '
  'with a GET DIAGNOSTICS ROW_COUNT=0 guard so concurrent double-returns fail with the '
  'same Thai string instead of double-closing. '
  'photo_return_url stays NULL — FE PATCHes after advisory photo upload (Q-Phase3-C).';

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ============================================================
-- 1) Both functions still SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('validate_borrow_movement','close_loan_from_return')
--    ORDER BY proname;
--    -- Expected: both | true
--
-- 2) Triggers unchanged and still bound (this file only replaced bodies):
--    SELECT tgname,
--           CASE tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing
--    FROM pg_trigger
--    WHERE tgrelid = 'stock_movements'::regclass
--      AND tgname IN ('trg_sm_borrow_validate','trg_sm_close_loan')
--      AND NOT tgisinternal
--    ORDER BY tgname;
--    -- Expected: trg_sm_borrow_validate BEFORE ; trg_sm_close_loan AFTER
--
-- 3) Normal Employee return of their OWN loan succeeds (rolled-back, real ids;
--    run under an Employee JWT so app_username() = the borrower):
--    BEGIN;
--      -- borrow first (or reuse an existing open loan for this Employee):
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta,
--                                  due_at, client_ref_id)
--      VALUES ('<item>', '<location with stock>', 'borrow', -1,
--              now() + interval '3 days', gen_random_uuid());
--      -- return it (borrower_username omitted → forced to app_username()):
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta,
--                                  client_ref_id)
--      VALUES ('<same item>', '<same location>', 'return', 1, gen_random_uuid());
--      SELECT status FROM stock_loans ORDER BY borrowed_at DESC LIMIT 1;  -- returned
--    ROLLBACK;
--
-- 4) Spoofed borrower is overridden (Employee A tries to close Employee B's loan by
--    passing B's username): with A's JWT, borrower_username is forced to A, so the
--    lookup scopes to A's (nonexistent) open loan for that item → REJECTED:
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta,
--                                  borrower_username, client_ref_id)
--      VALUES ('<B''s borrowed item>', '<location>', 'return', 1,
--              '<employeeB username>', gen_random_uuid());
--      -- Expected: ERROR 'ไม่พบรายการยืมที่เปิดอยู่ ...' (borrower forced to A ≠ B).
--    ROLLBACK;
--
-- 5) Concurrent double-return — one wins, one gets the Thai string. Two psql
--    sessions, same open loan (both Employee JWTs for that borrower):
--      -- session 1:  BEGIN; INSERT ... 'return' ...;   -- holds the FOR UPDATE lock
--      -- session 2:  BEGIN; INSERT ... 'return' ...;   -- blocks on the lock
--      -- session 1:  COMMIT;                            -- loan now 'returned'
--      -- session 2:  unblocks → NOT FOUND (row no longer active) →
--      --             ERROR 'ไม่พบรายการยืมที่เปิดอยู่ ...' ; ROLLBACK.
--
-- 6) Admin proxy return still honours an explicit borrower_username (Admin JWT):
--    the WHERE lookup uses the passed username; the force block is skipped for Admin.
--
-- 7) Idempotency: run this whole file twice → CREATE OR REPLACE → no error.
