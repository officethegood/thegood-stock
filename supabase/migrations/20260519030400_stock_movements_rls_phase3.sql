-- supabase/migrations/20260519030400_stock_movements_rls_phase3.sql
-- Phase 3 — Extend stock_movements Staff INSERT policy to allow borrow + return.
--
-- Decisions-locked:
--   Derived #4  — DROP + recreate sm_insert_staff adding borrow + return to allowed set
--
-- Phase 1 sm_insert_staff allowed only: issue, adjustment_loss
-- Phase 3 extends it to: issue, adjustment_loss, borrow, return
--
-- The Admin policy (sm_insert_admin) already covers all movement types; this
-- policy is the Staff-only extension.
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE POLICY.

-- ==========================================================================
-- 1) Drop Phase 1/2 Staff INSERT policy
-- ==========================================================================

DROP POLICY IF EXISTS sm_insert_staff ON stock_movements;

-- ==========================================================================
-- 2) Recreate with borrow + return added
-- ==========================================================================

CREATE POLICY sm_insert_staff ON stock_movements
  FOR INSERT
  TO authenticated
  WITH CHECK (
    app_user_role() IN ('Admin', 'Employee')
    AND movement_type IN ('issue', 'adjustment_loss', 'borrow', 'return')
  );

COMMENT ON POLICY sm_insert_staff ON stock_movements IS
  'Phase 3 extension (DROP+CREATE from Phase 1 original). '
  'Allows Admin and Employee to INSERT stock_movements with movement_type in '
  '(issue, adjustment_loss, borrow, return). '
  'borrow and return were reserved in Phase 1 enum; Phase 3 activates them here. '
  'Admin policy sm_insert_admin (Phase 1) already allows all types and is unchanged.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Both staff and admin insert policies present:
--    SELECT policyname, cmd, with_check
--    FROM pg_policies
--    WHERE tablename = 'stock_movements' AND policyname LIKE 'sm_insert%'
--    ORDER BY policyname;
--    -- Expected: sm_insert_admin (any type) + sm_insert_staff (issue/adjustment_loss/borrow/return)
--
-- 2) Policy contains borrow + return:
--    SELECT with_check
--    FROM pg_policies
--    WHERE tablename = 'stock_movements' AND policyname = 'sm_insert_staff';
--    -- Expected: WITH CHECK contains 'borrow' and 'return' in the movement_type list
--
-- 3) Idempotency: run twice → DROP IF EXISTS + CREATE → no error on second run.
--
-- 4) Functional test (run as Employee JWT in DevTools console):
--    const { error } = await supabase.from('stock_movements').insert({
--      item_id: '<uuid>',
--      location_id: '<uuid>',
--      movement_type: 'borrow',
--      qty_delta: -1,
--      due_at: new Date(Date.now() + 86400000 * 3).toISOString()
--    });
--    -- Expected: 201 (not 403) — policy allows borrow for Employee
