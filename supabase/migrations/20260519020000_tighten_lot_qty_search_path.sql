-- Migration: 20260519020000_tighten_lot_qty_search_path.sql
-- Purpose: Remove pg_temp from apply_movement_to_lot_qty SECURITY DEFINER function
--          to shrink its blast radius (Audit S-4 MED finding).
-- Idempotent: CREATE OR REPLACE is always safe.
-- Ref: docs/superpowers/audits/2026-05-19-phase2-security.md §S-4
--
-- IMPORTANT: Function body below is carried verbatim from the live production version
-- (migration 20260519010400_stock_lot_triggers.sql, function 3).
-- The ONLY change from the live version is:
--   SET search_path = public, pg_temp   →   SET search_path = public
-- All logic inside BEGIN..END is unchanged.

CREATE OR REPLACE FUNCTION apply_movement_to_lot_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public          -- removed pg_temp (was: public, pg_temp) — Audit S-4 fix
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
  'SECURITY DEFINER to bypass stock_lots RLS. '
  'search_path restricted to public only (no pg_temp). See audit S-4.';

-- ============================================================
-- Verification SQL (run after deploy)
-- ============================================================
-- Confirm search_path no longer includes pg_temp:
--   SELECT p.proname, p.prosecdef, p.proconfig
--   FROM   pg_proc p
--   WHERE  p.proname = 'apply_movement_to_lot_qty';
--   -- Expected: proconfig = '{search_path=public}'  (NOT '{search_path=public,pg_temp}')
--
-- Confirm function still exists and has SECURITY DEFINER:
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'apply_movement_to_lot_qty';
--   -- Expected: 1 row, prosecdef = true
