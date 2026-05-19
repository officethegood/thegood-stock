-- supabase/migrations/20260519060600_sm_insert_staff_linen.sql
-- Phase 6 — Linens & Laundry: DROP + CREATE sm_insert_staff to add laundry_in.
--
-- Decisions-locked (docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md):
--   Q6-F — Staff RBAC for รับคืน: Staff allowed for adjustment_gain with reason='laundry_in' ONLY.
--           NOT all adjustment_gain — only the specific combination (adjustment_gain AND reason='laundry_in').
--
-- Phase 1 sm_insert_staff allowed:   issue, adjustment_loss
-- Phase 3 sm_insert_staff extended:  issue, adjustment_loss, borrow, return
-- Phase 6 sm_insert_staff extends:   issue, adjustment_loss, borrow, return
--                                  + (adjustment_gain AND reason='laundry_in')
--
-- WHY the reason check matters:
--   Staff must NOT be allowed to INSERT arbitrary adjustment_gain (that would let them
--   inflate stock for any item). The RLS predicate restricts the gain path to ONLY the
--   laundry-return use-case. The reason column is free-text so the predicate is:
--     (movement_type = 'adjustment_gain' AND NEW.reason = 'laundry_in')
--
-- The Admin policy sm_insert_admin (Phase 1) already allows all movement types and is unchanged.
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE POLICY.
-- Depends on: stock_movements table + sm_insert_staff policy (Phase 1 + Phase 3 chain).

-- ==========================================================================
-- 1) Drop Phase 1/3 Staff INSERT policy
-- ==========================================================================

DROP POLICY IF EXISTS sm_insert_staff ON stock_movements;

-- ==========================================================================
-- 2) Recreate with Phase 6 laundry_in extension
--    Phase 1: issue, adjustment_loss
--    Phase 3: + borrow, return
--    Phase 6: + (adjustment_gain AND reason='laundry_in')
-- ==========================================================================

CREATE POLICY sm_insert_staff ON stock_movements
  FOR INSERT
  TO authenticated
  WITH CHECK (
    app_user_role() IN ('Admin', 'Employee')
    AND (
      movement_type IN ('issue', 'adjustment_loss', 'borrow', 'return')
      OR (movement_type = 'adjustment_gain' AND reason = 'laundry_in')
    )
  );

COMMENT ON POLICY sm_insert_staff ON stock_movements IS
  'Phase 6 extension (DROP+CREATE from Phase 3). '
  'Phase 1 base: issue, adjustment_loss. '
  'Phase 3 addition: borrow, return. '
  'Phase 6 addition: adjustment_gain WITH reason=''laundry_in'' ONLY. '
  '  — Staff may confirm laundry returns (รับคืน) during night shifts without Admin present. '
  '  — Restricted to reason=laundry_in: Staff cannot perform arbitrary stock gain. '
  '  — Q6-F decision locked 2026-05-19: mandatory photo provides audit trail. '
  'Admin policy sm_insert_admin (Phase 1) already allows all types and is unchanged.';

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) Policy present:
--    SELECT policyname, cmd, with_check
--    FROM pg_policies
--    WHERE tablename = 'stock_movements' AND policyname LIKE 'sm_insert%'
--    ORDER BY policyname;
--    Expected: sm_insert_admin (all types) + sm_insert_staff (restricted set)
--
-- 2) Policy contains laundry_in condition:
--    SELECT with_check
--    FROM pg_policies
--    WHERE tablename = 'stock_movements' AND policyname = 'sm_insert_staff';
--    Expected: WITH CHECK contains 'laundry_in' in the predicate
--
-- 3) Idempotency — run twice → no error on second run.
--
-- 4) Functional test (run as Employee JWT):
--    -- Allowed: รับคืน with reason=laundry_in
--    const { error } = await supabase.from('stock_movements').insert({
--      item_id: '<linen-item-uuid>',
--      location_id: '<cabinet-uuid>',
--      movement_type: 'adjustment_gain',
--      reason: 'laundry_in',
--      qty_delta: 3,
--      client_ref_id: crypto.randomUUID()
--    });
--    Expected: 201 (not 403)
--
--    -- Blocked: adjustment_gain without reason=laundry_in
--    const { error } = await supabase.from('stock_movements').insert({
--      item_id: '<uuid>',
--      location_id: '<uuid>',
--      movement_type: 'adjustment_gain',
--      qty_delta: 5,
--      client_ref_id: crypto.randomUUID()
--    });
--    Expected: 403 — reason is NULL/not laundry_in, RLS blocks it for Employee
