-- supabase/migrations/20260519010400_stock_lot_triggers.sql
-- Phase 2 — Trigger functions on stock_movements for lot lifecycle management.
--
-- Decisions-locked:
--   Q-Phase2-4  — BEFORE INSERT trigger blocks expired/recalled lots with EXACT message
--   derived #4  — use trigger (not CHECK constraint) for tracks_lots enforcement
--   derived #5  — apply_movement_to_sil MUST be extended to update stock_lots.current_qty
--   derived #6  — check_lot_status trigger implementation
--
-- This file contains THREE trigger functions:
--
--   1) check_lot_status() — BEFORE INSERT on stock_movements
--      (a) Enforces lot_id required for tracks_lots items on all movements.
--      (b) Blocks issue of expired/recalled lots. MUST raise exactly:
--          'ล็อตหมดอายุหรือถูกเรียกคืน'   ← FE staff-scan.js greps this string (toast M-65)
--
--   2) apply_movement_to_sil() — CREATE OR REPLACE (SUPERSEDES Phase 1 version)
--      Extended from Phase 1 (20260518010500_stock_triggers.sql) to ALSO update
--      stock_lots.current_qty when lot_id IS NOT NULL. Phase 1 behaviour is
--      fully preserved; the lot-qty update is purely additive.
--      SECURITY DEFINER (same as Phase 1) to bypass stock_item_locations RLS
--      and now also stock_lots RLS.
--
--   3) apply_movement_to_lot_qty() — AFTER INSERT on stock_movements
--      Dedicated lot-qty reconciliation trigger; handles negative-qty guard and
--      auto-depletion. SECURITY DEFINER.
--      NOTE: apply_movement_to_sil (above) also updates lot qty; this trigger
--      acts as belt-and-braces and handles the status auto-depletion logic.
--      Duplicate qty_delta application is avoided because apply_movement_to_sil
--      handles the location qty upsert AND lot qty, while this trigger ONLY
--      updates lot qty + status. Deploy operator must ensure only ONE of the two
--      performs the stock_lots.current_qty UPDATE. See design note below.
--
-- DESIGN NOTE — single-source lot qty update:
--   apply_movement_to_sil (function 2) now performs the lot current_qty UPDATE.
--   apply_movement_to_lot_qty (function 3) is therefore scoped to:
--     • Guard against negative lot qty (belt-and-braces after sil UPDATE)
--     • Auto-deplete status when current_qty reaches 0
--   It does NOT re-apply qty_delta (sil already did it). It reads current_qty
--   via RETURNING from sil context via a SELECT after the fact.
--   This avoids double-decrement while keeping concerns separated.
--
-- Trigger firing order on stock_movements INSERT:
--   BEFORE: trg_check_lot_status  (c < e < s — fires before trg_sm_sign, enforce_movement_sign)
--   BEFORE: trg_sm_sign           (enforce_movement_sign — Phase 1, unchanged)
--   AFTER:  trg_sm_apply          (apply_movement_to_sil — this file REPLACES Phase 1 version)
--   AFTER:  trg_lot_qty_apply     (apply_movement_to_lot_qty — new Phase 2)
--   AFTER:  trg_sm_lowstock       (check_low_stock — Phase 1, unchanged)
--
-- Assumed extensions: none beyond Phase 0/1 baseline.
-- Secret names used: none (no pg_net calls in this file).

-- ==========================================================================
-- 1) BEFORE INSERT — check_lot_status
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

  -- Null guard: unknown item_id — let the FK on stock_movements handle it downstream.
  IF v_tracks_lots IS NULL THEN
    RETURN NEW;
  END IF;

  -- Short-circuit: non-lot-tracking items skip all lot checks.
  IF v_tracks_lots = false THEN
    RETURN NEW;
  END IF;

  -- For tracks_lots items, lot_id is mandatory on ALL movement types.
  -- Outgoing movements (issue-class):
  IF NEW.movement_type IN ('issue', 'adjustment_loss', 'borrow', 'transfer_out')
     AND NEW.lot_id IS NULL
  THEN
    RAISE EXCEPTION
      'lot_id is required for medication item % (tracks_lots=true) on movement_type=%',
      NEW.item_id, NEW.movement_type;
  END IF;

  -- Inbound movements (receive):
  IF NEW.movement_type = 'receive' AND NEW.lot_id IS NULL THEN
    RAISE EXCEPTION
      'lot_id is required for medication item % (tracks_lots=true) on movement_type=receive',
      NEW.item_id;
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
  '(a) Enforces lot_id required when item.tracks_lots=true. '
  '(b) Raises EXCEPTION ''ล็อตหมดอายุหรือถูกเรียกคืน'' when issuing from an expired or recalled lot OR a lot whose expiry_date < CURRENT_DATE (S-3 mitigation closes 00:00-09:00 BKK race window). '
  '(c) Computes fefo_override server-side on issue-class movements (S-5 mitigation — ignores client value). '
  'FE staff-scan.js greps the exact Thai string to display toast M-65.';

DROP TRIGGER IF EXISTS trg_check_lot_status ON stock_movements;
CREATE TRIGGER trg_check_lot_status
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_lot_status();

-- ==========================================================================
-- 2) AFTER INSERT — apply_movement_to_sil() OVERRIDE
--    SUPERSEDES Phase 1 version in 20260518010500_stock_triggers.sql
--    Phase 1 logic is fully preserved; Phase 2 addition: update stock_lots.current_qty
--    when lot_id IS NOT NULL (decisions-locked derived #5).
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

  -- Belt-and-braces negative guard (Phase 1 logic, unchanged):
  IF v_new_qty < 0 THEN
    RAISE EXCEPTION
      'movement would drive qty negative for item % at location %',
      NEW.item_id, NEW.location_id;
  END IF;

  -- Phase 1: phantom-row cleanup when no prior stock existed and delta was negative
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
  -- Phase 2 addition: update stock_lots.current_qty when lot_id is set
  -- (decisions-locked derived #5)
  -- SECURITY DEFINER means we bypass stock_lots RLS (Admin-only UPDATE policy)
  -- which is correct: trigger runs under postgres role, not the calling user.
  -- ────────────────────────────────────────────────────────────────────────

  IF NEW.lot_id IS NOT NULL THEN
    UPDATE stock_lots
      SET current_qty = current_qty + NEW.qty_delta,
          updated_by  = NEW.performed_by,
          updated_at  = now()
    WHERE id = NEW.lot_id
    RETURNING current_qty INTO v_new_lot_qty;

    -- Guard: negative lot qty is not allowed.
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
  END IF;

  RETURN NEW;
END;
$apply_movement_to_sil$;

COMMENT ON FUNCTION apply_movement_to_sil() IS
  'Phase 1 AFTER INSERT (Phase 2 override). '
  'Phase 1: upserts stock_item_locations qty and writes qty_after snapshot. '
  'Phase 2 addition: when lot_id IS NOT NULL, also updates stock_lots.current_qty '
  'and auto-depletes lot status when current_qty reaches 0 (decisions derived #5). '
  'SECURITY DEFINER to bypass both stock_item_locations and stock_lots RLS.';

-- trg_sm_apply already exists from Phase 1; CREATE OR REPLACE FUNCTION above
-- is sufficient. The trigger binding is unchanged (still AFTER INSERT, FOR EACH ROW).
-- Re-declare defensively to ensure it points to the updated function.
DROP TRIGGER IF EXISTS trg_sm_apply ON stock_movements;
CREATE TRIGGER trg_sm_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_sil();

-- ==========================================================================
-- 3) AFTER INSERT — apply_movement_to_lot_qty (belt-and-braces + status guard)
--    Runs AFTER apply_movement_to_sil. Does NOT re-apply qty_delta.
--    Responsibilities: negative-qty assertion re-check + auto-deplete status.
--    Skips when lot_id IS NULL (non-lot items).
-- ==========================================================================

CREATE OR REPLACE FUNCTION apply_movement_to_lot_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $apply_lot_qty$
DECLARE
  v_current_lot_qty  int;
BEGIN
  -- Only act when a lot is referenced.
  IF NEW.lot_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Read current_qty AFTER apply_movement_to_sil has already applied qty_delta.
  SELECT current_qty
    INTO v_current_lot_qty
  FROM stock_lots
  WHERE id = NEW.lot_id;

  -- Belt-and-braces: if somehow current_qty went negative, raise.
  -- (apply_movement_to_sil guards this already; this is a final safety net.)
  IF v_current_lot_qty < 0 THEN
    RAISE EXCEPTION
      'apply_movement_to_lot_qty: lot current_qty is negative for lot % (item %, movement %). '
      'apply_movement_to_sil should have caught this first.',
      NEW.lot_id, NEW.item_id, NEW.id;
  END IF;

  -- Auto-deplete status if lot reached zero via an outgoing movement.
  -- apply_movement_to_sil already does this; this trigger is belt-and-braces
  -- for any code path that might bypass the sil trigger (e.g., future direct
  -- UPDATE to stock_lots.current_qty by a migration). No-op if already depleted.
  IF v_current_lot_qty = 0 AND NEW.qty_delta < 0 THEN
    UPDATE stock_lots
      SET status     = 'depleted',
          updated_at = now()
    WHERE id     = NEW.lot_id
      AND status = 'active';  -- idempotent: only updates if still active
  END IF;

  RETURN NEW;
END;
$apply_lot_qty$;

COMMENT ON FUNCTION apply_movement_to_lot_qty() IS
  'Phase 2 AFTER INSERT on stock_movements. Belt-and-braces lot-qty guard. '
  'Reads current_qty after apply_movement_to_sil has applied qty_delta. '
  'Raises if negative; auto-depletes status when current_qty=0 on outgoing movement. '
  'SECURITY DEFINER to bypass stock_lots RLS.';

DROP TRIGGER IF EXISTS trg_lot_qty_apply ON stock_movements;
CREATE TRIGGER trg_lot_qty_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_lot_qty();

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) All triggers on stock_movements (BEFORE + AFTER, Phase 1 + Phase 2):
--    SELECT tgname, tgenabled,
--           CASE tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing
--    FROM pg_trigger
--    WHERE tgrelid = 'stock_movements'::regclass AND NOT tgisinternal
--    ORDER BY tgname;
--    -- Expected (Phase 1 + Phase 2):
--    --   trg_check_lot_status   BEFORE
--    --   trg_lot_qty_apply      AFTER
--    --   trg_sm_apply           AFTER
--    --   trg_sm_lowstock        AFTER
--    --   trg_sm_sign            BEFORE
--
-- 2) Security settings for all trigger functions:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN (
--      'check_lot_status',
--      'apply_movement_to_sil',
--      'apply_movement_to_lot_qty'
--    )
--    ORDER BY proname;
--    -- Expected:
--    --   apply_movement_to_lot_qty  | true   (SECURITY DEFINER)
--    --   apply_movement_to_sil      | true   (SECURITY DEFINER)
--    --   check_lot_status           | false  (no elevated privilege needed)
--
-- 3) Exact exception string (critical for FE toast M-65):
--    -- If a lot with status='expired' exists (lot_id = <uuid>):
--    -- INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id)
--    -- VALUES (<tracks_lots_item>, <location>, 'issue', -1, <expired_lot_id>);
--    -- Expected: ERROR:  ล็อตหมดอายุหรือถูกเรียกคืน
--
-- 4) apply_movement_to_sil override is active (not Phase 1 version):
--    SELECT pg_get_functiondef('apply_movement_to_sil'::regproc);
--    -- Expected: function body contains 'Phase 2 addition' comment and
--    --           UPDATE stock_lots SET current_qty clause.
--
-- 5) Trigger firing-order sanity (alphabetical BEFORE: check_ before enforce_):
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'stock_movements'::regclass
--      AND NOT tgisinternal
--      AND tgtype & 2 = 2    -- BEFORE triggers
--    ORDER BY tgname;
--    -- Expected: trg_check_lot_status, trg_sm_sign
--    -- 'c' < 's' confirms check_lot_status fires first — R-3 risk mitigated
