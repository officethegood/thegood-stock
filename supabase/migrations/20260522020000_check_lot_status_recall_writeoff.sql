-- supabase/migrations/20260522020000_check_lot_status_recall_writeoff.sql
-- Phase 2 structural fix — check_lot_status(): two corrections.
--
-- SUPERSEDES 20260522010000_lot_required_on_adjustment_gain.sql. This file is a
-- complete CREATE OR REPLACE of check_lot_status() and is self-sufficient —
-- applying this alone yields the final correct function. (Applying 010000 first
-- is harmless; this file then overwrites it.)
--
-- Correction 1 (carried from 20260522010000):
--   lot_id is required for tracks_lots items on adjustment_gain too — without
--   it the ปรับยอด-up path created stock tied to no lot.
--
-- Correction 2 (new):
--   The expired/recalled-lot block previously rejected ALL outgoing movements
--   — issue, adjustment_loss, borrow, transfer_out. That made it IMPOSSIBLE to
--   remove the stock of a recalled or expired lot: a recall write-off, or an
--   ของหาย/ชำรุด on bad stock, is an adjustment_loss, and it was blocked. So a
--   recalled lot's units were stuck in inventory forever.
--   Fix: the block now covers only issue / borrow / transfer_out — movements
--   that hand bad stock to a patient, a vehicle, or another location. Those
--   must stay blocked. adjustment_loss only ever REMOVES stock from the system
--   (write-off, recall, damage) and is therefore always safe — and necessary —
--   on a bad lot.
--   The exact Thai string 'ล็อตหมดอายุหรือถูกเรียกคืน' is unchanged (FE
--   staff-scan.js greps it for toast M-65) and still raised for issue.
--
-- Carried forward VERBATIM from 20260519010400 / 20260522010000: the
-- lot_id-required block and the server-side fefo_override computation.
--
-- Depends on: 20260519010400_stock_lot_triggers.sql
-- Scope: only affects tracks_lots stock_items. Non-lot items short-circuit.
-- Idempotent: CREATE OR REPLACE FUNCTION. Trigger not recreated (binds by name).

CREATE OR REPLACE FUNCTION check_lot_status()
RETURNS trigger
LANGUAGE plpgsql
AS $check_lot_status$
DECLARE
  v_tracks_lots  boolean;
  v_lot_status   stock_lot_status;
  v_lot_expiry   date;
BEGIN
  -- Resolve whether the item tracks lots.
  SELECT tracks_lots
    INTO v_tracks_lots
  FROM stock_items
  WHERE id = NEW.item_id;

  -- Null guard: unknown item_id — let the FK on stock_movements handle it.
  IF v_tracks_lots IS NULL THEN
    RETURN NEW;
  END IF;

  -- Short-circuit: non-lot-tracking items skip all lot checks.
  IF v_tracks_lots = false THEN
    RETURN NEW;
  END IF;

  -- For tracks_lots items, lot_id is mandatory on every stock-changing
  -- movement: issue-class, receive, AND both adjustment directions.
  -- (transfer_in is intentionally excluded — handled by rpc_transfer_stock.)
  IF NEW.lot_id IS NULL
     AND NEW.movement_type IN ('issue', 'adjustment_loss', 'adjustment_gain',
                               'borrow', 'transfer_out', 'receive')
  THEN
    RAISE EXCEPTION
      'lot_id is required for medication item % (tracks_lots=true) on movement_type=%',
      NEW.item_id, NEW.movement_type;
  END IF;

  -- Q-Phase2-4: Block expired or recalled lots — but ONLY for movements that
  -- hand the stock onward (issue / borrow / transfer_out). adjustment_loss is
  -- deliberately NOT blocked: removing a bad lot's stock (recall write-off,
  -- damage, disposal) is legitimate and necessary (Correction 2).
  -- CRITICAL: exception message MUST stay exactly 'ล็อตหมดอายุหรือถูกเรียกคืน'
  -- — FE staff-scan.js greps this exact string to map to toast M-65.
  IF NEW.lot_id IS NOT NULL
     AND NEW.movement_type IN ('issue', 'borrow', 'transfer_out')
  THEN
    -- S-3 mitigation: also check expiry_date to close the 00:00-09:00 BKK race
    -- window where status is still 'active' on the expiry day before the cron.
    SELECT status, expiry_date
      INTO v_lot_status, v_lot_expiry
    FROM stock_lots
    WHERE id = NEW.lot_id;

    IF v_lot_status IN ('expired', 'recalled') OR v_lot_expiry < CURRENT_DATE THEN
      RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
    END IF;
  END IF;

  -- S-5 mitigation: compute fefo_override SERVER-SIDE on issue-class movements.
  -- Client-supplied value is ignored — a movement is fefo_override=true ONLY
  -- when the chosen lot is NOT the oldest active+non-expired lot for the item.
  IF NEW.lot_id IS NOT NULL
     AND NEW.movement_type IN ('issue', 'adjustment_loss', 'borrow', 'transfer_out')
  THEN
    NEW.fefo_override := (
      NEW.lot_id <> (
        SELECT id FROM stock_lots
        WHERE item_id = NEW.item_id
          AND status = 'active'
          AND expiry_date >= CURRENT_DATE
          AND current_qty > 0
        ORDER BY expiry_date ASC, created_at ASC
        LIMIT 1
      )
    );
    IF NEW.fefo_override IS NULL THEN
      NEW.fefo_override := false;
    END IF;
  END IF;

  RETURN NEW;
END;
$check_lot_status$;

COMMENT ON FUNCTION check_lot_status() IS
  'Phase 2 BEFORE INSERT on stock_movements. '
  '(a) Enforces lot_id required when item.tracks_lots=true — on issue, '
  'adjustment_loss, adjustment_gain, borrow, transfer_out and receive. '
  '(b) Raises ''ล็อตหมดอายุหรือถูกเรียกคืน'' when issue/borrow/transfer_out '
  'targets an expired or recalled lot. adjustment_loss is NOT blocked so a '
  'recalled/expired lot can be written off (structural fix 20260522020000). '
  '(c) Computes fefo_override server-side on issue-class movements. '
  'FE staff-scan.js greps the exact Thai string for toast M-65.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) adjustment_loss on a recalled lot is now ALLOWED (no error):
--    -- (run inside a rolled-back transaction against a recalled lot)
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id)
--      SELECT item_id, '<location_with_that_lot>', 'adjustment_loss', -1, id
--      FROM stock_lots WHERE status = 'recalled' LIMIT 1;
--      -- Expected: 1 row inserted, NO 'ล็อตหมดอายุหรือถูกเรียกคืน' error.
--    ROLLBACK;
--
-- B) issue from a recalled lot is still BLOCKED:
--    INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id)
--    SELECT item_id, '<location>', 'issue', -1, id
--    FROM stock_lots WHERE status = 'recalled' LIMIT 1;
--    -- Expected: ERROR 'ล็อตหมดอายุหรือถูกเรียกคืน'
