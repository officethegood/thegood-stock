-- supabase/migrations/20260715032000_restrict_staff_laundry_gain.sql
-- Security hardening — clamp the Staff laundry_in gain path to LINEN items only.
--
-- Problem:
--   The Staff INSERT policy sm_insert_staff (20260519060600_sm_insert_staff_linen.sql)
--   permits movement_type='adjustment_gain' when reason='laundry_in', checking ONLY
--   the FREE-TEXT reason column. A crafted REST insert (not the FE) can therefore add
--   ANY item — meds, tools, oxygen — in ANY quantity at ANY location simply by tagging
--   reason='laundry_in'. RLS on its own cannot express "and the item is a linen".
--
-- Fix (this file — does NOT touch the RLS policy; the policy stays as the broad
--   compatibility surface so the current FE keeps working unchanged):
--   Add a NEW BEFORE INSERT trigger on stock_movements that fires ONLY for
--   movement_type='adjustment_gain' AND reason='laundry_in', and — when the caller
--   is not an Admin (app_user_role() <> 'Admin', read from the JWT, NOT the
--   client-supplied performed_role) — rejects the row unless the item's category
--   code is 'LINEN'. Admin adjustment_gain stays fully unrestricted.
--
-- Deliberately OUT OF SCOPE this round (do NOT add here):
--   * laundry_role='clean' destination check — legacy linens.js may receive into a
--     general destination; tightening that would break the current FE.
--
-- Trigger ordering: a plain BEFORE INSERT is sufficient. The row is only applied by
--   the AFTER-INSERT trigger trg_sm_apply (apply_movement_to_sil); any BEFORE trigger
--   that RAISEs aborts the statement before that. No ordering dependency exists with
--   the other BEFORE triggers (trg_check_lot_status / trg_sm_sign / trg_sm_borrow_validate)
--   because this guard neither reads nor writes the columns they touch.
--
-- SECURITY DEFINER: the category lookup joins stock_items → stock_categories and must
--   read the TRUE category regardless of the caller's RLS visibility (a row hidden by
--   RLS must not be able to masquerade as non-LINEN or slip through). Definer read
--   mirrors validate_borrow_movement()'s own SECURITY DEFINER stock_loans read.
--
-- New Thai error string (this guard only fires on a crafted attack, never on the
--   current FE which only does laundry_in on real linen items):
--   'พนักงานรับผ้าเข้าได้เฉพาะรายการหมวดผ้า (LINEN) เท่านั้น'
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS / CREATE TRIGGER.
-- Apply order: any time after 20260519060600 (Staff laundry_in policy) and after the
--   LINEN category seed (20260519060000). Independent of 20260715031000.
-- Assumptions: Postgres (Supabase), extensions pgcrypto/pg_net already installed;
--   helper app_user_role() from 20260518000000_init.sql; stock_items.category_id FK to
--   stock_categories(id) with code 'LINEN' seeded.

-- ==========================================================================
-- 1) BEFORE INSERT — enforce_staff_laundry_gain_linen (SECURITY DEFINER)
--    Fires (via WHEN) only for adjustment_gain + reason='laundry_in'.
--    Non-Admin: item category MUST be 'LINEN' or the row is rejected.
-- ==========================================================================

CREATE OR REPLACE FUNCTION enforce_staff_laundry_gain_linen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $enforce_laundry_gain$
DECLARE
  v_cat_code text;
BEGIN
  -- Admin adjustment_gain is unrestricted (proxy corrections, opening balances).
  -- Trust the JWT role, NOT NEW.performed_role (client-supplied, spoofable).
  IF app_user_role() = 'Admin' THEN
    RETURN NEW;
  END IF;

  -- Resolve the item's category code past RLS (SECURITY DEFINER). LEFT JOIN so an
  -- item with no category yields NULL — which is DISTINCT FROM 'LINEN' → rejected.
  SELECT c.code
    INTO v_cat_code
  FROM stock_items i
  LEFT JOIN stock_categories c ON c.id = i.category_id
  WHERE i.id = NEW.item_id;

  -- Only positively-confirmed LINEN items pass. NULL (no item / no category /
  -- non-linen) all reject via IS DISTINCT FROM.
  IF v_cat_code IS DISTINCT FROM 'LINEN' THEN
    RAISE EXCEPTION 'พนักงานรับผ้าเข้าได้เฉพาะรายการหมวดผ้า (LINEN) เท่านั้น';
  END IF;

  RETURN NEW;
END;
$enforce_laundry_gain$;

COMMENT ON FUNCTION enforce_staff_laundry_gain_linen() IS
  '20260715 security hardening BEFORE INSERT on stock_movements. '
  'Fires (WHEN) only for adjustment_gain + reason=laundry_in. '
  'For non-Admin callers (app_user_role() <> Admin, from JWT — NOT performed_role) '
  'rejects the row unless the item category code = LINEN, raising '
  '''พนักงานรับผ้าเข้าได้เฉพาะรายการหมวดผ้า (LINEN) เท่านั้น''. '
  'Admin adjustment_gain stays unrestricted. Closes the RLS gap where the free-text '
  'reason=laundry_in alone let Staff gain arbitrary items (sm_insert_staff, 20260519060600). '
  'SECURITY DEFINER to read the true category past RLS.';

DROP TRIGGER IF EXISTS trg_sm_laundry_gain_linen ON stock_movements;
CREATE TRIGGER trg_sm_laundry_gain_linen
  BEFORE INSERT ON stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type = 'adjustment_gain' AND NEW.reason = 'laundry_in')
  EXECUTE FUNCTION enforce_staff_laundry_gain_linen();

-- ============================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ============================================================
-- 1) Trigger present, BEFORE, with the laundry_in WHEN guard:
--    SELECT tgname,
--           CASE tgtype & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
--           pg_get_triggerdef(oid) AS def
--    FROM pg_trigger
--    WHERE tgrelid = 'stock_movements'::regclass
--      AND tgname = 'trg_sm_laundry_gain_linen'
--      AND NOT tgisinternal;
--    -- Expected: 1 row, BEFORE, def contains "adjustment_gain" AND "laundry_in".
--
-- 2) Function is SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname='enforce_staff_laundry_gain_linen';
--    -- Expected: enforce_staff_laundry_gain_linen | true
--
-- 3) Behaviour (run each INSERT in a rolled-back txn with real ids):
--    -- Pick a non-LINEN item (e.g. a medication) and a LINEN item:
--    --   SELECT i.id, c.code FROM stock_items i
--    --   LEFT JOIN stock_categories c ON c.id=i.category_id
--    --   WHERE c.code IN ('LINEN','MEDICATION') ORDER BY c.code;
--
--    -- 3a) Employee JWT, laundry_in on a NON-LINEN item → REJECTED:
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type, reason,
--                                  qty_delta, client_ref_id)
--      VALUES ('<non-linen item>', '<location>', 'adjustment_gain', 'laundry_in',
--              99, gen_random_uuid());
--      -- Expected: ERROR 'พนักงานรับผ้าเข้าได้เฉพาะรายการหมวดผ้า (LINEN) เท่านั้น'
--    ROLLBACK;
--
--    -- 3b) Employee JWT, laundry_in on a LINEN item → ALLOWED (subject to the
--    --     usual sm_insert_staff RLS + sign/qty triggers):
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type, reason,
--                                  qty_delta, client_ref_id)
--      VALUES ('<linen item>', '<location>', 'adjustment_gain', 'laundry_in',
--              3, gen_random_uuid());
--      -- Expected: succeeds (no exception from this trigger).
--    ROLLBACK;
--
--    -- 3c) Admin JWT, adjustment_gain on ANY item (with or without laundry_in) → ALLOWED:
--    BEGIN;
--      INSERT INTO stock_movements(item_id, location_id, movement_type, reason,
--                                  qty_delta, client_ref_id)
--      VALUES ('<non-linen item>', '<location>', 'adjustment_gain', 'laundry_in',
--              5, gen_random_uuid());
--      -- Expected: succeeds (Admin short-circuit; this trigger raises nothing).
--    ROLLBACK;
--
-- 4) Idempotency: run this whole file twice → CREATE OR REPLACE + DROP TRIGGER IF
--    EXISTS → no error on the second run.
