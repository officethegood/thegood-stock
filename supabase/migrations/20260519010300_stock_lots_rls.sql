-- supabase/migrations/20260519010300_stock_lots_rls.sql
-- Phase 2 — RLS policies for stock_lots.
--
-- Pattern: read-all authenticated (staff need lot picker in scan flow),
--          write Admin only (receive creates lots; Admin performs recalls).
-- Mirrors Phase 1 RLS pattern on stock_items.
-- No DELETE policy: lots are permanent audit records; lifecycle managed via
-- status changes (active → recalled / expired / depleted), never physical delete.
--
-- SECURITY DEFINER trigger functions (apply_movement_to_sil override,
-- apply_movement_to_lot_qty) bypass RLS when updating current_qty. This is
-- intentional — they run under the postgres role and need no policy exception.
--
-- Depends on: stock_lots table (20260519010100),
--             app_user_role() helper (Phase 0 init).

ALTER TABLE stock_lots ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- SELECT — all authenticated users
-- Staff need this for lot picker display in staff-scan.js
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sl_read ON stock_lots;
CREATE POLICY sl_read ON stock_lots
  FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- INSERT — Admin only (receive flow)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sl_insert ON stock_lots;
CREATE POLICY sl_insert ON stock_lots
  FOR INSERT
  TO authenticated
  WITH CHECK (app_user_role() = 'Admin');

-- ---------------------------------------------------------------------------
-- UPDATE — Admin only (recall, corrections)
-- Note: SECURITY DEFINER trigger functions bypass RLS and do NOT need this policy.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sl_update ON stock_lots;
CREATE POLICY sl_update ON stock_lots
  FOR UPDATE
  TO authenticated
  USING     (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- No DELETE policy → all DELETE attempts are rejected by default RLS deny rule.

-- ============================================================
-- Verification SQL
-- ============================================================
-- 1) RLS enabled:
--    SELECT relrowsecurity FROM pg_class WHERE relname = 'stock_lots';
--    -- Expected: true (t)
--
-- 2) Three policies present:
--    SELECT policyname, cmd, roles::text
--    FROM pg_policies
--    WHERE tablename = 'stock_lots'
--    ORDER BY policyname;
--    -- Expected: sl_insert (INSERT), sl_read (SELECT), sl_update (UPDATE)
--
-- 3) No DELETE policy (confirm locked out):
--    SELECT policyname FROM pg_policies
--    WHERE tablename = 'stock_lots' AND cmd = 'DELETE';
--    -- Expected: 0 rows
