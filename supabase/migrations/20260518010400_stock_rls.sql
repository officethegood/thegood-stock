-- supabase/migrations/20260518010400_stock_rls.sql
-- Phase 1 — Row-level security for the stock_* family. Spec §5.6, §8, Q-Phase1-G.
--
-- Role matrix (per PDF §1 + Q-Phase1-G):
--
--   stock_categories       SELECT: authenticated;          ALL writes: Admin only
--   stock_items            SELECT: authenticated;          ALL writes: Admin only
--   stock_item_locations   SELECT: authenticated;          NO client writes — trigger-only
--                          (trigger runs SECURITY DEFINER and bypasses RLS)
--   stock_movements        SELECT: authenticated
--                          INSERT: Admin → any movement_type
--                          INSERT: Staff (Employee) → 'issue' OR 'adjustment_loss' only
--                          UPDATE/DELETE: none — movements are immutable; corrections
--                                          must be posted as reverse movements
--
-- PM Q1 (2026-05-18): Transfer modal DEFERRED to Phase 2 — no Transfer-specific
-- policies live here. The transfer_out / transfer_in enum values exist but are
-- writable only by Admin (because they fall under the generic admin INSERT policy);
-- Staff cannot post them. That's intentional and matches the deferral.

ALTER TABLE stock_categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_item_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements      ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- stock_categories
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS scat_read  ON stock_categories;
DROP POLICY IF EXISTS scat_write ON stock_categories;

CREATE POLICY scat_read  ON stock_categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY scat_write ON stock_categories
  FOR ALL TO authenticated
  USING      (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- ---------------------------------------------------------------------------
-- stock_items
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS si_read  ON stock_items;
DROP POLICY IF EXISTS si_write ON stock_items;

CREATE POLICY si_read  ON stock_items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY si_write ON stock_items
  FOR ALL TO authenticated
  USING      (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- ---------------------------------------------------------------------------
-- stock_item_locations — SELECT only for clients; writes via trigger
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sil_read ON stock_item_locations;

CREATE POLICY sil_read ON stock_item_locations
  FOR SELECT TO authenticated USING (true);

-- Intentionally NO INSERT/UPDATE/DELETE policies for `authenticated`.
-- The qty-apply trigger (apply_movement_to_sil) is declared SECURITY DEFINER and
-- runs as the trigger owner (postgres / table owner), which bypasses RLS. Direct
-- client writes to stock_item_locations therefore return 403.

-- ---------------------------------------------------------------------------
-- stock_movements — split INSERT by role + movement_type per Q-Phase1-G
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sm_read         ON stock_movements;
DROP POLICY IF EXISTS sm_insert_admin ON stock_movements;
DROP POLICY IF EXISTS sm_insert_staff ON stock_movements;

CREATE POLICY sm_read ON stock_movements
  FOR SELECT TO authenticated USING (true);

-- Admin: any movement_type (receive / issue / adjustment_gain / adjustment_loss /
-- transfer_* reserved / borrow / return reserved).
CREATE POLICY sm_insert_admin ON stock_movements
  FOR INSERT TO authenticated
  WITH CHECK (app_user_role() = 'Admin');

-- Staff (Employee): issue + adjustment_loss only (Q-Phase1-G).
-- Phase 3 will extend this set to allow 'borrow' and 'return' for staff.
-- PM Q1 (2026-05-18): transfer_* intentionally NOT in this set — Transfer is
-- deferred to Phase 2.
CREATE POLICY sm_insert_staff ON stock_movements
  FOR INSERT TO authenticated
  WITH CHECK (
        app_user_role() IN ('Admin','Employee')
    AND movement_type   IN ('issue','adjustment_loss')
  );

-- No UPDATE / DELETE policies — movements are immutable. Corrections post a
-- reverse movement that the apply trigger nets out against qty.

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) RLS enabled on all four tables:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('stock_categories','stock_items','stock_item_locations','stock_movements');
--    -- expected: relrowsecurity = true for each
--
-- 2) Policies present per matrix above:
--    SELECT tablename, policyname, cmd FROM pg_policies
--    WHERE tablename IN ('stock_categories','stock_items','stock_item_locations','stock_movements')
--    ORDER BY tablename, policyname;
--    -- expected rows:
--    --   stock_categories     | scat_read         | SELECT
--    --   stock_categories     | scat_write        | ALL
--    --   stock_items          | si_read           | SELECT
--    --   stock_items          | si_write          | ALL
--    --   stock_item_locations | sil_read          | SELECT
--    --   stock_movements      | sm_insert_admin   | INSERT
--    --   stock_movements      | sm_insert_staff   | INSERT
--    --   stock_movements      | sm_read           | SELECT
--
-- 3) Smoke (with a STAFF JWT — see plan Task A5 Step 3):
--    POST /rest/v1/stock_movements with movement_type='receive' → 403 (never 201)
--    POST same with movement_type='issue' → 201 (or 400 on FK, never 403)
--
-- 4) No UPDATE/DELETE policy on stock_movements:
--    SELECT count(*) FROM pg_policies
--    WHERE tablename='stock_movements' AND cmd IN ('UPDATE','DELETE');
--    -- expected: 0
