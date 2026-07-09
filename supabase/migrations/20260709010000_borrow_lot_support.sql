-- supabase/migrations/20260709010000_borrow_lot_support.sql
-- Borrow/return support for lot-tracked items (AED pads, expiring equipment).
--
-- Problem: check_lot_status requires lot_id on 'borrow' for tracks_lots items,
-- but the borrow flow never carried one — FE blocked all lot-tracked items with
-- "เป็นของคุมล็อต/วันหมดอายุ ให้ใช้โหมด เบิก-จ่าย แทน". Issuing instead of
-- borrowing is wrong for equipment that comes back (paddle AED ขึ้นรถ).
--
-- Fix (4 pieces, this file is self-sufficient and idempotent):
--   1) stock_loans.lot_id — remember which lot went out on each loan.
--   2) create_loan_from_borrow() — copy NEW.lot_id onto the loan row.
--   3) validate_borrow_movement() — on 'return', backfill NEW.lot_id from the
--      open loan (same most-recent-loan lookup as close_loan_from_return) so
--      apply_movement_to_sil restores stock_lots.current_qty symmetrically.
--      Without this a return would restore location qty but NOT lot qty.
--   4) apply_movement_to_sil() — un-deplete: when an incoming movement brings a
--      'depleted' lot back above 0 (return of the last borrowed unit), restore
--      status to 'active' (or 'expired' when past expiry_date, so the 09:00
--      cron's classification is never raced backwards).
--
-- Unchanged semantics kept on purpose:
--   * check_lot_status still BLOCKS borrow FROM an expired/recalled lot.
--   * 'return' is NOT lot-blocked — an expired paddle must be returnable so it
--     can then be written off via adjustment_loss.
--   * fefo_override is still computed server-side (borrow already in its list).
--
-- Depends on: 20260519030300_borrow_return_triggers.sql,
--             20260522020000_check_lot_status_recall_writeoff.sql

-- ==========================================================================
-- 1) stock_loans.lot_id (idempotent)
-- ==========================================================================

ALTER TABLE stock_loans
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES stock_lots(id) ON DELETE RESTRICT;

COMMENT ON COLUMN stock_loans.lot_id IS
  'Lot the borrow movement drew from (tracks_lots items only; NULL otherwise). '
  'Used by validate_borrow_movement() to backfill lot_id on the return movement '
  'so the lot''s current_qty is restored on return.';

CREATE INDEX IF NOT EXISTS idx_loans_lot ON stock_loans(lot_id) WHERE lot_id IS NOT NULL;

-- ==========================================================================
-- 2) create_loan_from_borrow — carry lot_id onto the loan
--    (full replacement of 20260519030300 version; only change is lot_id)
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
    lot_id,
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
    NEW.lot_id,                        -- lot-tracked borrow (NULL for normal items)
    NEW.borrower_username,
    COALESCE(NEW.performed_at, now()),
    NEW.due_at,
    ABS(NEW.qty_delta),
    NEW.note,
    NULL,
    'active',
    NEW.performed_by
  );

  RETURN NEW;
END;
$create_loan$;

COMMENT ON FUNCTION create_loan_from_borrow() IS
  'Phase 3 AFTER INSERT on stock_movements (movement_type=borrow). '
  'SECURITY DEFINER bypasses stock_loans RLS (no client INSERT policy). '
  'Creates stock_loans row with status=active, including lot_id for '
  'tracks_lots items (20260709010000). photo_borrow_url starts NULL — '
  'FE PATCHes after Cloudinary upload (Q-Phase3-C). '
  'qty = ABS(qty_delta); due_at read from dedicated column (Q-Phase3-E).';

-- ==========================================================================
-- 3) validate_borrow_movement — backfill lot_id on return from the open loan
--    (full replacement of 20260519030300 version)
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
  'SECURITY DEFINER to read stock_loans past RLS for that backfill.';

-- ==========================================================================
-- 4) apply_movement_to_sil — un-deplete lot on incoming movement
--    (full replacement of 20260519010400 version; Phase 1 + Phase 2 logic
--     preserved verbatim, one block added at the end)
-- ==========================================================================

CREATE OR REPLACE FUNCTION apply_movement_to_sil()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $apply_movement_to_sil$
DECLARE
  v_new_qty     int;
  v_new_lot_qty int;
BEGIN
  -- ────────────────────────────────────────────────────────────────────────
  -- Phase 1 behaviour (UNCHANGED): upsert stock_item_locations + qty_after
  -- ────────────────────────────────────────────────────────────────────────

  INSERT INTO stock_item_locations(item_id, location_id, qty, last_movement_at)
  VALUES (NEW.item_id, NEW.location_id, GREATEST(0, NEW.qty_delta), NEW.performed_at)
  ON CONFLICT (item_id, location_id) DO UPDATE
    SET qty              = stock_item_locations.qty + NEW.qty_delta,
        last_movement_at = NEW.performed_at
  RETURNING qty INTO v_new_qty;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION
      'movement would drive qty negative for item % at location %',
      NEW.item_id, NEW.location_id;
  END IF;

  IF v_new_qty = 0 AND NEW.qty_delta < 0 THEN
    DELETE FROM stock_item_locations
      WHERE item_id    = NEW.item_id
        AND location_id = NEW.location_id
        AND qty = 0;
    RAISE EXCEPTION
      'movement would drive qty negative for item % at location % (no existing stock)',
      NEW.item_id, NEW.location_id;
  END IF;

  UPDATE stock_movements SET qty_after = v_new_qty WHERE id = NEW.id;

  -- ────────────────────────────────────────────────────────────────────────
  -- Phase 2 behaviour (UNCHANGED): update stock_lots.current_qty when lot_id set
  -- ────────────────────────────────────────────────────────────────────────

  IF NEW.lot_id IS NOT NULL THEN
    UPDATE stock_lots
      SET current_qty = current_qty + NEW.qty_delta,
          updated_by  = NEW.performed_by,
          updated_at  = now()
    WHERE id = NEW.lot_id
    RETURNING current_qty INTO v_new_lot_qty;

    IF v_new_lot_qty < 0 THEN
      RAISE EXCEPTION
        'movement would drive lot current_qty negative for lot % (item %, movement %)',
        NEW.lot_id, NEW.item_id, NEW.id;
    END IF;

    -- Auto-deplete: when an outgoing movement empties the lot, mark it depleted.
    IF v_new_lot_qty = 0 AND NEW.qty_delta < 0 THEN
      UPDATE stock_lots
        SET status     = 'depleted',
            updated_at = now()
      WHERE id = NEW.lot_id
        AND status = 'active';
    END IF;

    -- 20260709010000 un-deplete: an incoming movement (return of a borrowed
    -- lot unit, adjustment_gain) that brings a depleted lot back above zero
    -- restores its status — 'active' normally, or 'expired' when the lot
    -- passed its expiry_date while at zero (never resurrect expired stock as
    -- usable; check_lot_status also guards by expiry_date on the way out).
    IF v_new_lot_qty > 0 AND NEW.qty_delta > 0 THEN
      UPDATE stock_lots
        SET status     = CASE WHEN expiry_date < CURRENT_DATE
                              THEN 'expired'::stock_lot_status
                              ELSE 'active'::stock_lot_status
                         END,
            updated_at = now()
      WHERE id = NEW.lot_id
        AND status = 'depleted';
    END IF;
  END IF;

  RETURN NEW;
END;
$apply_movement_to_sil$;

COMMENT ON FUNCTION apply_movement_to_sil() IS
  'Phase 1 AFTER INSERT (Phase 2 override + 20260709010000). '
  'Phase 1: upserts stock_item_locations qty and writes qty_after snapshot. '
  'Phase 2: when lot_id IS NOT NULL, updates stock_lots.current_qty and '
  'auto-depletes at 0. 20260709010000: un-depletes (→active, or →expired when '
  'past expiry) when an incoming movement lifts a depleted lot above 0 — '
  'needed for returns of borrowed lot-tracked equipment. '
  'SECURITY DEFINER to bypass stock_item_locations and stock_lots RLS.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- 1) Column exists:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='stock_loans' AND column_name='lot_id';
--    -- Expected: 1 row
--
-- 2) Borrow a lot-tracked item WITH lot_id succeeds and creates a loan
--    carrying that lot (run in a rolled-back txn with real ids):
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, due_at)
--      VALUES ('<tracks_lots item>', '<location with stock>', 'borrow', -1,
--              '<active lot>', now() + interval '3 days');
--      SELECT lot_id, status FROM stock_loans
--      ORDER BY created_at DESC LIMIT 1;   -- Expected: lot_id set, active
--    ROLLBACK;
--
-- 3) Return restores the lot qty (same txn, after the borrow above):
--    BEGIN;
--      -- borrow as in (2), then:
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
--      VALUES ('<same item>', '<same location>', 'return', 1);
--      SELECT current_qty, status FROM stock_lots WHERE id = '<active lot>';
--      -- Expected: current_qty back to the pre-borrow value; status active
--    ROLLBACK;
--
-- 4) Borrow WITHOUT lot_id on a tracks_lots item is still rejected by
--    check_lot_status: 'lot_id is required for medication item …'
--
-- 5) Borrow FROM an expired lot is still rejected:
--    'ล็อตหมดอายุหรือถูกเรียกคืน'
