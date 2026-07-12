-- supabase/migrations/20260712020000_expired_issue_ack.sql
-- Feature — เบิกของหมดอายุได้เมื่อยืนยันรับทราบ (expired issue with explicit ack).
--
-- Request (Chittawan 2026-07-12): "อยากให้ยืดหยุ่นพวกของ Exp ให้สามารถเบิกได้"
-- — expired stock is needed for non-patient use (training/CPR practice, sending
-- for disposal), but Q-D1 (Phase 2) hard-blocked every outgoing movement from
-- an expired lot, so expired stock could only leave via adjustment_loss.
--
-- Policy relaxation (PM Pex 2026-07-12) — narrow on purpose:
--   * 'issue' from an EXPIRED lot is allowed ONLY when the movement carries
--     expired_ack = true — the FE sets it after the user passes a red warning
--     modal and types a reason (reason lands in note, so the ledger shows who
--     took expired stock and why).
--   * 'recalled' lots stay ABSOLUTELY blocked on every outgoing movement.
--   * 'borrow' and 'transfer_out' from expired lots stay blocked — expired
--     stock must not be loaned onward or moved between locations as if usable;
--     take it out via เบิก (ack) or ตัดของเสีย.
--   * adjustment_loss stays allowed on expired/recalled lots (write-off path,
--     unchanged since 20260522020000).
--
-- LESSON APPLIED (see 20260712010000): this file's check_lot_status() is a
-- verbatim copy of the CURRENT latest version (20260522020000) with ONLY the
-- expired/recalled block changed. Do not rebuild trigger bodies from older
-- migrations.
--
-- Depends on: 20260522020000_check_lot_status_recall_writeoff.sql
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION.

-- ==========================================================================
-- 1) stock_movements.expired_ack
-- ==========================================================================

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS expired_ack boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN stock_movements.expired_ack IS
  'true = client explicitly acknowledged issuing from an EXPIRED lot (red '
  'warning modal + typed reason; reason is prefixed into note). Only honored '
  'by check_lot_status() for movement_type=issue. 20260712020000.';

-- ==========================================================================
-- 2) check_lot_status — expired issue allowed with ack; recalled still blocked
--    (verbatim from 20260522020000 except the expired/recalled block)
-- ==========================================================================

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

  -- Q-Phase2-4 (relaxed 20260712020000): block bad lots on outgoing movements.
  --   recalled  → blocked on issue / borrow / transfer_out, no exceptions.
  --   expired   → borrow / transfer_out blocked; issue allowed ONLY with
  --               NEW.expired_ack = true (FE red-modal + reason path).
  -- adjustment_loss is deliberately NOT in this list (write-off allowed).
  -- CRITICAL: exception message MUST stay exactly 'ล็อตหมดอายุหรือถูกเรียกคืน'
  -- — FE greps this exact string for the Thai toast.
  IF NEW.lot_id IS NOT NULL
     AND NEW.movement_type IN ('issue', 'borrow', 'transfer_out')
  THEN
    -- S-3 mitigation: also check expiry_date to close the 00:00-09:00 BKK race
    -- window where status is still 'active' on the expiry day before the cron.
    SELECT status, expiry_date
      INTO v_lot_status, v_lot_expiry
    FROM stock_lots
    WHERE id = NEW.lot_id;

    IF v_lot_status = 'recalled' THEN
      RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
    END IF;

    IF v_lot_status = 'expired' OR v_lot_expiry < CURRENT_DATE THEN
      IF NOT (NEW.movement_type = 'issue' AND NEW.expired_ack IS TRUE) THEN
        RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
      END IF;
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
  '(b) Blocks recalled lots on issue/borrow/transfer_out unconditionally; '
  'blocks expired lots on borrow/transfer_out; allows issue from an expired '
  'lot ONLY when expired_ack=true (20260712020000 — training/disposal use). '
  'adjustment_loss is never blocked (write-off). Exact Thai string '
  '''ล็อตหมดอายุหรือถูกเรียกคืน'' unchanged for FE toast mapping. '
  '(c) Computes fefo_override server-side on issue-class movements.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Column exists:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='stock_movements' AND column_name='expired_ack';
--    -- Expected: 1 row
--
-- B) issue from an expired lot WITHOUT ack is still blocked (rolled-back):
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id, client_ref_id)
--      SELECT sl.item_id,
--             (SELECT location_id FROM stock_movements WHERE lot_id = sl.id LIMIT 1),
--             'issue', -1, sl.id, gen_random_uuid()
--      FROM stock_lots sl WHERE sl.status='expired' AND sl.current_qty > 0 LIMIT 1;
--      -- Expected: ERROR 'ล็อตหมดอายุหรือถูกเรียกคืน'
--    ROLLBACK;
--
-- C) issue from an expired lot WITH ack succeeds (rolled-back):
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id, expired_ack, note, client_ref_id)
--      SELECT sl.item_id,
--             (SELECT location_id FROM stock_movements WHERE lot_id = sl.id LIMIT 1),
--             'issue', -1, sl.id, true, 'ทดสอบเบิกของหมดอายุ', gen_random_uuid()
--      FROM stock_lots sl WHERE sl.status='expired' AND sl.current_qty > 0 LIMIT 1;
--      -- Expected: 1 row inserted, no error.
--    ROLLBACK;
--
-- D) borrow / transfer_out from an expired lot still blocked even with ack:
--    (same pattern with movement_type='borrow', due_at=now()+interval '1 day',
--     expired_ack=true → expect ERROR 'ล็อตหมดอายุหรือถูกเรียกคืน')
--
-- E) recalled lot: issue with expired_ack=true → still ERROR.
