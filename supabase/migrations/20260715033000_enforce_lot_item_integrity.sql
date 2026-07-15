-- supabase/migrations/20260715033000_enforce_lot_item_integrity.sql
-- Integrity — a movement/loan's lot_id must belong to the SAME item as the row.
--
-- Problem: lot_id on stock_movements (fk_movements_lot, 20260519010200) and on
-- stock_loans (20260709010000) is only FK-checked to EXIST in stock_lots(id).
-- Neither checks that stock_lots.item_id equals the row's own item_id. So a
-- write that passes item A's id with item B's lot_id is accepted by the FK, and
-- apply_movement_to_lot_qty then moves the WRONG lot's current_qty — silently
-- corrupting balances across two different items at once.
--
-- Fix (this file — constraints only; the trigger-side guard lives in FILE 2):
--   1) UNIQUE (id, item_id) on stock_lots — redundant against the PK on id, but
--      a composite FK's referenced columns must carry a unique/PK constraint,
--      so this is the required target for the composite FKs below.
--   2) Composite FK stock_movements (lot_id, item_id) → stock_lots (id, item_id),
--      DEFERRABLE INITIALLY DEFERRED (mirrors fk_movements_lot so the same-txn
--      receive flow — lot INSERT + movement INSERT — still commits) and NOT VALID
--      (historic mismatches, if any, do not block the migration; every NEW write
--      is enforced immediately). The simple fk_movements_lot stays in place.
--   3) Composite FK stock_loans (lot_id, item_id) → stock_lots (id, item_id),
--      NOT VALID (mirrors the existing non-deferrable stock_loans.lot_id FK).
--      MATCH SIMPLE (the default) means a row with lot_id IS NULL — every
--      non-lot-tracked loan — skips the check entirely, so this only bites
--      lot-carrying loans, exactly "where lot_id is not null".
--
-- The matching trigger change (check_lot_status lot lookups gain
-- AND item_id = NEW.item_id, plus a clear Thai rejection) is in FILE 2:
--   20260715034000_check_lot_status_item_match_and_expired_reason.sql
-- so that migration remains the SINGLE owner of check_lot_status().
--
-- APPLY ORDER: apply THIS file (20260715033000) FIRST, then FILE 2
--   (20260715034000). The two are independent — neither hard-depends on the
--   other — but this is the intended sequence and matches the timestamps.
--   This file is safe to apply before FILE 2.
--
-- Assumptions: PostgreSQL 15 (Supabase), pgcrypto present (not used here).
-- Secret names used: none.
-- Idempotent: every object guarded by a pg_constraint existence check.

-- ==========================================================================
-- 1) stock_lots UNIQUE (id, item_id) — FK target (redundant vs PK on id)
-- ==========================================================================
DO $uq_lot_id_item$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'uq_stock_lots_id_item'
      AND conrelid = 'stock_lots'::regclass
  ) THEN
    ALTER TABLE stock_lots
      ADD CONSTRAINT uq_stock_lots_id_item UNIQUE (id, item_id);
  END IF;
END
$uq_lot_id_item$;

COMMENT ON CONSTRAINT uq_stock_lots_id_item ON stock_lots IS
  'Redundant-but-required unique (id is already PK): serves as the referenced '
  'target for the composite (lot_id, item_id) FKs on stock_movements and '
  'stock_loans, which enforce that a lot belongs to the referencing row''s item '
  '(20260715033000).';

-- ==========================================================================
-- 2) stock_movements composite FK (lot_id, item_id) → stock_lots (id, item_id)
--    DEFERRABLE INITIALLY DEFERRED (mirror fk_movements_lot) + NOT VALID.
-- ==========================================================================
DO $fk_mv_lot_item$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'fk_movements_lot_item'
      AND conrelid = 'stock_movements'::regclass
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT fk_movements_lot_item
        FOREIGN KEY (lot_id, item_id)
        REFERENCES stock_lots (id, item_id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID;
  END IF;
END
$fk_mv_lot_item$;

COMMENT ON CONSTRAINT fk_movements_lot_item ON stock_movements IS
  'Composite FK: the movement''s lot_id must belong to the SAME item_id '
  '(20260715033000). DEFERRABLE INITIALLY DEFERRED mirrors fk_movements_lot so '
  'the same-transaction receive flow (lot INSERT + movement INSERT) still '
  'commits. NOT VALID: historic mismatches do not block apply; new writes are '
  'enforced. MATCH SIMPLE skips the check when lot_id IS NULL (non-lot items). '
  'The simple fk_movements_lot stays in place for the lot-existence guarantee.';

-- ==========================================================================
-- 3) stock_loans composite FK (lot_id, item_id) → stock_lots (id, item_id)
--    NOT VALID (mirror the existing non-deferrable stock_loans.lot_id FK).
-- ==========================================================================
DO $fk_loan_lot_item$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'fk_loans_lot_item'
      AND conrelid = 'stock_loans'::regclass
  ) THEN
    ALTER TABLE stock_loans
      ADD CONSTRAINT fk_loans_lot_item
        FOREIGN KEY (lot_id, item_id)
        REFERENCES stock_lots (id, item_id)
        ON DELETE RESTRICT
        NOT VALID;
  END IF;
END
$fk_loan_lot_item$;

COMMENT ON CONSTRAINT fk_loans_lot_item ON stock_loans IS
  'Composite FK: a loan''s lot_id must belong to the SAME item_id '
  '(20260715033000). NOT VALID so historic rows do not block apply. MATCH '
  'SIMPLE skips the check when lot_id IS NULL, so this only enforces loans that '
  'actually carry a lot (lot-tracked equipment).';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor AFTER applying)
-- ==========================================================================
-- A) The three new constraints exist:
--    SELECT conname, contype, convalidated
--    FROM pg_constraint
--    WHERE conname IN ('uq_stock_lots_id_item',
--                      'fk_movements_lot_item',
--                      'fk_loans_lot_item')
--    ORDER BY conname;
--    -- Expected 3 rows:
--    --   fk_loans_lot_item        f   convalidated=false (NOT VALID)
--    --   fk_movements_lot_item    f   convalidated=false (NOT VALID)
--    --   uq_stock_lots_id_item    u   convalidated=true
--
-- B) The composite movements FK is DEFERRABLE INITIALLY DEFERRED (so receive
--    is not broken):
--    SELECT conname, condeferrable, condeferred
--    FROM pg_constraint WHERE conname = 'fk_movements_lot_item';
--    -- Expected: condeferrable=true, condeferred=true
--
-- C) A NEW movement with a MISMATCHED lot (lot belongs to a different item) is
--    rejected by the composite FK (rolled back). Pick any two DIFFERENT items
--    where the second one owns a lot:
--    BEGIN;
--      WITH other_lot AS (
--        SELECT sl.id AS lot_id, sl.item_id AS lot_item_id
--        FROM stock_lots sl LIMIT 1
--      ),
--      wrong_item AS (
--        SELECT si.id AS item_id
--        FROM stock_items si, other_lot
--        WHERE si.id <> other_lot.lot_item_id
--        LIMIT 1
--      )
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, client_ref_id)
--      SELECT wrong_item.item_id,
--             (SELECT id FROM locations LIMIT 1),
--             'adjustment_gain', 1, other_lot.lot_id, gen_random_uuid()
--      FROM other_lot, wrong_item;
--      -- Expected: ERROR — insert or update on table "stock_movements"
--      --           violates foreign key constraint "fk_movements_lot_item"
--    ROLLBACK;
--
-- D) A matching (lot belongs to the row's item) receive still commits — proves
--    the DEFERRABLE mirror did not break the same-txn receive path:
--    BEGIN;
--      -- create a lot + its receive movement for the SAME item in one txn
--      WITH it AS (SELECT id AS item_id FROM stock_items WHERE tracks_lots LIMIT 1),
--           newlot AS (
--             INSERT INTO stock_lots(item_id, lot_number, expiry_date, received_qty)
--             SELECT item_id, 'VERIF-'||gen_random_uuid()::text,
--                    CURRENT_DATE + 365, 1 FROM it
--             RETURNING id, item_id
--           )
--      INSERT INTO stock_movements(item_id, location_id, movement_type,
--                                  qty_delta, lot_id, client_ref_id)
--      SELECT newlot.item_id, (SELECT id FROM locations LIMIT 1),
--             'receive', 1, newlot.id, gen_random_uuid()
--      FROM newlot;
--      -- Expected: succeeds (composite FK satisfied, deferred to COMMIT)
--    ROLLBACK;
