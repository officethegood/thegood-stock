-- supabase/migrations/20260519050400_oxygen_rls.sql
-- Phase 5 — RLS policies for oxygen_tanks and oxygen_movements.
-- Pattern mirrors Phase 1 stock_rls policies (20260519000600 equivalent).
-- Helper functions app_user_role() and app_username() from Phase 0.
--
-- KEY DESIGN: oxygen_tanks UPDATE is blocked by RLS (USING = false).
-- Only the apply_oxygen_movement() SECURITY DEFINER trigger may UPDATE oxygen_tanks.
-- This enforces that every status change goes through the movement ledger.
--
-- oxygen_movements has no UPDATE or DELETE policies — append-only by omission.

-- ── Enable RLS ─────────────────────────────────────────────────────────────

ALTER TABLE oxygen_tanks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE oxygen_movements ENABLE ROW LEVEL SECURITY;

-- ── oxygen_tanks policies ───────────────────────────────────────────────────

-- SELECT: all authenticated users
DROP POLICY IF EXISTS oxygen_tanks_select_all ON oxygen_tanks;
CREATE POLICY oxygen_tanks_select_all
  ON oxygen_tanks FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: Admin only (add new tank)
DROP POLICY IF EXISTS oxygen_tanks_insert_admin ON oxygen_tanks;
CREATE POLICY oxygen_tanks_insert_admin
  ON oxygen_tanks FOR INSERT
  TO authenticated
  WITH CHECK (app_user_role() = 'Admin');

-- UPDATE: blocked for all direct callers (only SECURITY DEFINER trigger may update)
DROP POLICY IF EXISTS oxygen_tanks_update_trigger_only ON oxygen_tanks;
CREATE POLICY oxygen_tanks_update_trigger_only
  ON oxygen_tanks FOR UPDATE
  TO authenticated
  USING (false);
  -- USING(false) = no row passes the filter for direct UPDATE.
  -- apply_oxygen_movement() runs SECURITY DEFINER and bypasses RLS.

-- DELETE: Admin only (rare — retire a row physically, not the normal retire-status flow)
DROP POLICY IF EXISTS oxygen_tanks_delete_admin ON oxygen_tanks;
CREATE POLICY oxygen_tanks_delete_admin
  ON oxygen_tanks FOR DELETE
  TO authenticated
  USING (app_user_role() = 'Admin');

-- ── oxygen_movements policies ───────────────────────────────────────────────

-- SELECT: all authenticated users
DROP POLICY IF EXISTS oxygen_movements_select_all ON oxygen_movements;
CREATE POLICY oxygen_movements_select_all
  ON oxygen_movements FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: Admin can log any transition.
--         Employee (Staff) can log to_status IN ('ready','on_board','refilling') only.
--         State machine trigger provides the final check regardless.
--         This RLS is a first-pass guard (prevents Staff from even attempting
--         maintenance/retired transitions — reduces noise in trigger logs).
DROP POLICY IF EXISTS oxygen_movements_insert_staff ON oxygen_movements;
CREATE POLICY oxygen_movements_insert_staff
  ON oxygen_movements FOR INSERT
  TO authenticated
  WITH CHECK (
    app_user_role() = 'Admin'
    OR (
      app_user_role() = 'Employee'
      AND to_status IN ('ready', 'on_board', 'refilling')
    )
  );

-- No UPDATE policy — UPDATE is implicitly blocked for authenticated role.
-- No DELETE policy — DELETE is implicitly blocked for authenticated role.
-- oxygen_movements is append-only enforced by absence of UPDATE/DELETE policies.

-- Verification:
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE tablename IN ('oxygen_tanks', 'oxygen_movements')
--   AND schemaname = 'public';
-- Expected: both rows have rowsecurity = true.
--
-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE tablename IN ('oxygen_tanks', 'oxygen_movements')
-- ORDER BY tablename, policyname;
-- Expected for oxygen_tanks: SELECT (select_all), INSERT (insert_admin),
--   UPDATE (update_trigger_only), DELETE (delete_admin).
-- Expected for oxygen_movements: SELECT (select_all), INSERT (insert_staff).
-- No UPDATE or DELETE policies for oxygen_movements.
