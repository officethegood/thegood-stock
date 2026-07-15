-- supabase/migrations/20260715034000_check_lot_status_item_match_and_expired_reason.sql
-- Trigger guard — lot must match the movement's item; expired issue must carry a reason.
--
-- This file is the SINGLE owner of check_lot_status(). Its body is a VERBATIM
-- copy of the current latest version (20260712020000_expired_issue_ack.sql) with
-- exactly TWO deltas — every other line, every Thai string, the lot_id-required
-- logic, the recalled/expired block, the expired_ack allowance and the
-- server-side fefo_override computation are byte-for-byte unchanged:
--
--   Delta 1 (lot/item match): the status/expiry lookup now matches on
--     (id = NEW.lot_id AND item_id = NEW.item_id). A lot that belongs to a
--     DIFFERENT item is therefore not found, and is rejected with a NEW Thai
--     exception 'ล็อตนี้ไม่ตรงกับสินค้า' (distinct from the expiry string —
--     the expiry string 'ล็อตหมดอายุหรือถูกเรียกคืน' is NOT reused). This is
--     the trigger-side twin of the composite FK added in FILE 1
--     (20260715033000); the trigger gives a clean Thai toast before the
--     deferred FK would otherwise fail at COMMIT.
--
--   Delta 2 (expired reason): an issue with expired_ack=true MUST carry a
--     non-blank note (the reason). Otherwise RAISE 'ต้องระบุเหตุผลเมื่อเบิกของหมดอายุ'.
--     The FE already sends note = "เบิกของหมดอายุ — <reason>", so legitimate
--     flows are unaffected; this only blocks a crafted ack without a reason.
--
-- ALSO (belt-and-braces, independent of the trigger path): a table-level CHECK
-- on stock_movements — (expired_ack = false OR note is non-blank) — so a direct
-- INSERT that somehow bypasses the trigger still cannot record an expired-ack
-- issue with no reason. Added NOT VALID so historic rows never block apply.
--
-- APPLY ORDER: apply FILE 1 (20260715033000_enforce_lot_item_integrity.sql)
--   FIRST, then THIS file (20260715034000). The two are independent — this
--   function does not depend on FILE 1's constraints and vice-versa — but this
--   is the intended sequence and matches the timestamps.
--
-- Depends on: 20260712020000_expired_issue_ack.sql (body copied from here),
--             stock_movements.expired_ack column (same file).
-- Assumptions: PostgreSQL 15 (Supabase). Secret names used: none.
-- Idempotent: CREATE OR REPLACE FUNCTION + guarded ADD CONSTRAINT.

-- ==========================================================================
-- 1) check_lot_status — verbatim from 20260712020000 + Delta 1 + Delta 2
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
    -- Delta 1 (20260715034000): match on item_id too, so a lot belonging to a
    -- different item is treated as not-found and rejected below.
    SELECT status, expiry_date
      INTO v_lot_status, v_lot_expiry
    FROM stock_lots
    WHERE id = NEW.lot_id
      AND item_id = NEW.item_id;

    -- Delta 1 (20260715034000): no matching (id, item_id) lot — either the lot
    -- does not exist or it belongs to a DIFFERENT item. status is NOT NULL, so
    -- a NULL here reliably means "not found for this item". Reject with a clear
    -- Thai message distinct from the expiry string (FE maps it separately).
    IF v_lot_status IS NULL THEN
      RAISE EXCEPTION 'ล็อตนี้ไม่ตรงกับสินค้า';
    END IF;

    IF v_lot_status = 'recalled' THEN
      RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
    END IF;

    IF v_lot_status = 'expired' OR v_lot_expiry < CURRENT_DATE THEN
      IF NOT (NEW.movement_type = 'issue' AND NEW.expired_ack IS TRUE) THEN
        RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
      END IF;
    END IF;
  END IF;

  -- Delta 2 (20260715034000): an expired-ack issue MUST carry a reason (note).
  -- FE sends note = 'เบิกของหมดอายุ — <reason>', so legit flows pass; a crafted
  -- ack with a blank note is rejected here (belt-and-braces CHECK below too).
  IF NEW.movement_type = 'issue'
     AND NEW.expired_ack IS TRUE
     AND btrim(coalesce(NEW.note, '')) = ''
  THEN
    RAISE EXCEPTION 'ต้องระบุเหตุผลเมื่อเบิกของหมดอายุ';
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
  '(b) 20260715034000: on issue/borrow/transfer_out the lot lookup matches '
  '(id, item_id); a lot of a different item is rejected with '
  '''ล็อตนี้ไม่ตรงกับสินค้า'' (twin of composite FK fk_movements_lot_item). '
  '(c) Blocks recalled lots on issue/borrow/transfer_out unconditionally; '
  'blocks expired lots on borrow/transfer_out; allows issue from an expired '
  'lot ONLY when expired_ack=true (20260712020000 — training/disposal use). '
  '20260715034000: an expired_ack issue must carry a reason in note else '
  '''ต้องระบุเหตุผลเมื่อเบิกของหมดอายุ''. adjustment_loss is never blocked '
  '(write-off). Exact Thai string ''ล็อตหมดอายุหรือถูกเรียกคืน'' unchanged for '
  'FE toast mapping. (d) Computes fefo_override server-side on issue-class '
  'movements.';

-- ==========================================================================
-- 2) Belt-and-braces CHECK — expired_ack issue can never lack a note
--    NOT VALID: historic rows do not block apply; new writes are enforced.
-- ==========================================================================
DO $chk_ack_note$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'chk_expired_ack_needs_note'
      AND conrelid = 'stock_movements'::regclass
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT chk_expired_ack_needs_note
        CHECK (expired_ack = false OR btrim(coalesce(note, '')) <> '')
        NOT VALID;
  END IF;
END
$chk_ack_note$;

COMMENT ON CONSTRAINT chk_expired_ack_needs_note ON stock_movements IS
  'Belt-and-braces (20260715034000): a row with expired_ack=true must carry a '
  'non-blank note (the reason), even on a direct INSERT that bypasses '
  'check_lot_status(). NOT VALID so pre-existing rows do not block apply.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor AFTER applying)
-- ==========================================================================
-- A) Function updated + CHECK present:
--    SELECT proname FROM pg_proc WHERE proname = 'check_lot_status';         -- 1 row
--    SELECT conname, convalidated FROM pg_constraint
--    WHERE conname = 'chk_expired_ack_needs_note';                          -- convalidated=false
--
-- B) Expired issue WITH ack but EMPTY note is rejected (rolled back):
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, expired_ack, note, client_ref_id)
--      SELECT sl.item_id,
--             (SELECT location_id FROM stock_movements WHERE lot_id = sl.id LIMIT 1),
--             'issue', -1, sl.id, true, '', gen_random_uuid()
--      FROM stock_lots sl WHERE sl.status='expired' AND sl.current_qty > 0 LIMIT 1;
--      -- Expected: ERROR 'ต้องระบุเหตุผลเมื่อเบิกของหมดอายุ'
--    ROLLBACK;
--
-- C) Issue with a MISMATCHED lot (lot belongs to a different item) is rejected
--    by the trigger BEFORE the deferred FK (rolled back):
--    BEGIN;
--      WITH other_lot AS (
--        SELECT sl.id AS lot_id, sl.item_id AS lot_item_id
--        FROM stock_lots sl WHERE sl.status='active' AND sl.current_qty > 0 LIMIT 1
--      ),
--      wrong_item AS (
--        SELECT si.id AS item_id FROM stock_items si, other_lot
--        WHERE si.id <> other_lot.lot_item_id AND si.tracks_lots LIMIT 1
--      )
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, client_ref_id)
--      SELECT wrong_item.item_id, (SELECT id FROM locations LIMIT 1),
--             'issue', -1, other_lot.lot_id, gen_random_uuid()
--      FROM other_lot, wrong_item;
--      -- Expected: ERROR 'ล็อตนี้ไม่ตรงกับสินค้า'
--    ROLLBACK;
--
-- D) A NORMAL FEFO issue (matching lot, note carried) still succeeds
--    (rolled back). Pick the oldest active lot for an item and issue 1:
--    BEGIN;
--      WITH oldest AS (
--        SELECT sl.id AS lot_id, sl.item_id
--        FROM stock_lots sl
--        WHERE sl.status='active' AND sl.expiry_date >= CURRENT_DATE
--          AND sl.current_qty > 0
--        ORDER BY sl.expiry_date ASC, sl.created_at ASC LIMIT 1
--      )
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, note, client_ref_id)
--      SELECT oldest.item_id,
--             (SELECT location_id FROM stock_movements WHERE lot_id = oldest.lot_id LIMIT 1),
--             'issue', -1, oldest.lot_id, 'ทดสอบเบิกปกติ', gen_random_uuid()
--      FROM oldest;
--      -- Expected: 1 row inserted, fefo_override=false, no error.
--    ROLLBACK;
--
-- E) Expired issue WITH ack AND a reason still succeeds (regression guard for
--    20260712020000 — same as its test C, note non-blank):
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, expired_ack, note, client_ref_id)
--      SELECT sl.item_id,
--             (SELECT location_id FROM stock_movements WHERE lot_id = sl.id LIMIT 1),
--             'issue', -1, sl.id, true, 'เบิกของหมดอายุ — ฝึก CPR', gen_random_uuid()
--      FROM stock_lots sl WHERE sl.status='expired' AND sl.current_qty > 0 LIMIT 1;
--      -- Expected: 1 row inserted, no error.
--    ROLLBACK;
