-- supabase/migrations/20260522010000_lot_required_on_adjustment_gain.sql
-- Phase 2 hotfix — close the lot-enforcement gap on adjustment_gain.
--
-- Bug:
--   check_lot_status() (20260519010400) enforces "lot_id required for
--   tracks_lots items" on issue / adjustment_loss / borrow / transfer_out /
--   receive — but NOT on adjustment_gain. Its own comment says lot_id is
--   "mandatory on ALL movement types"; adjustment_gain was missed.
--   Effect: the ปรับยอด-up path posts an adjustment_gain with no lot, so a
--   lot-tracked medication can accumulate stock that belongs to no lot. That
--   unlotted stock then cannot be issued or adjusted DOWN (those movements
--   require a lot) — a dead end.
--
-- Fix:
--   Require lot_id for tracks_lots items on adjustment_gain as well. The two
--   separate IF blocks (issue-class, receive) are merged into one list that
--   now also contains 'adjustment_gain'.
--
-- Scope note:
--   'transfer_in' is intentionally NOT added here. Transfers are posted by the
--   rpc_transfer_stock RPC, which manages lot_id itself; adding transfer_in to
--   this guard without auditing that RPC could break transfers. Out of scope
--   for this hotfix.
--
-- Carried forward VERBATIM from 20260519010400: the expired/recalled-lot block
-- and the server-side fefo_override computation. ONLY the lot_id-required block
-- changes.
--
-- Depends on: 20260519010400_stock_lot_triggers.sql
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

  -- Null guard: unknown item_id — let the FK on stock_movements handle it downstream.
  IF v_tracks_lots IS NULL THEN
    RETURN NEW;
  END IF;

  -- Short-circuit: non-lot-tracking items skip all lot checks.
  IF v_tracks_lots = false THEN
    RETURN NEW;
  END IF;

  -- For tracks_lots items, lot_id is mandatory on every stock-changing
  -- movement: issue-class, receive, AND both adjustment directions.
  -- adjustment_gain was added in hotfix 20260522010000 — without it the
  -- ปรับยอด-up path could create stock with no lot that could never be
  -- issued or adjusted down. (transfer_in is intentionally excluded — see
  -- the file header scope note.)
  IF NEW.lot_id IS NULL
     AND NEW.movement_type IN ('issue', 'adjustment_loss', 'adjustment_gain',
                               'borrow', 'transfer_out', 'receive')
  THEN
    RAISE EXCEPTION
      'lot_id is required for medication item % (tracks_lots=true) on movement_type=%',
      NEW.item_id, NEW.movement_type;
  END IF;

  -- Q-Phase2-4: Block expired or recalled lots for all issue-class movements.
  -- CRITICAL: exception message MUST be exactly 'ล็อตหมดอายุหรือถูกเรียกคืน'
  -- frontend staff-scan.js greps this exact string to map to toast M-65.
  IF NEW.lot_id IS NOT NULL
     AND NEW.movement_type IN ('issue', 'adjustment_loss', 'borrow', 'transfer_out')
  THEN
    -- S-3 mitigation (security-engineer audit 2026-05-19): also check expiry_date
    -- to close the 00:00-09:00 BKK race window where status is still 'active' on
    -- the expiry day before the daily cron flips it.
    SELECT status, expiry_date
      INTO v_lot_status, v_lot_expiry
    FROM stock_lots
    WHERE id = NEW.lot_id;

    IF v_lot_status IN ('expired', 'recalled') OR v_lot_expiry < CURRENT_DATE THEN
      RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
    END IF;
  END IF;

  -- S-5 mitigation (security-engineer audit 2026-05-19): compute fefo_override
  -- SERVER-SIDE on issue-class movements. Client-supplied value is ignored —
  -- a movement is fefo_override=true ONLY when the chosen lot is NOT the
  -- oldest active+non-expired lot for the same item.
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
    -- If there is no FEFO candidate (NULL from the subquery), the IS DISTINCT FROM
    -- semantics via <> returns NULL → cast to false: any lot is FEFO when none others exist.
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
  'adjustment_loss, adjustment_gain, borrow, transfer_out and receive '
  '(adjustment_gain added in hotfix 20260522010000). '
  '(b) Raises EXCEPTION ''ล็อตหมดอายุหรือถูกเรียกคืน'' when issuing from an expired or recalled lot OR a lot whose expiry_date < CURRENT_DATE (S-3 mitigation closes 00:00-09:00 BKK race window). '
  '(c) Computes fefo_override server-side on issue-class movements (S-5 mitigation — ignores client value). '
  'FE staff-scan.js greps the exact Thai string to display toast M-65.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) adjustment_gain on a tracks_lots item with no lot_id is now rejected:
--    INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
--    VALUES (<tracks_lots_item>, <location>, 'adjustment_gain', 5);
--    Expected: ERROR 'lot_id is required for medication item ... '
--              'on movement_type=adjustment_gain'
--
-- B) Non-lot items are unaffected (still no lot required):
--    a receive/adjustment on a tracks_lots=false item must still succeed.
