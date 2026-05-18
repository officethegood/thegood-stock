-- supabase/migrations/20260519010000_stock_lot_status_enum.sql
-- Phase 2 — stock_lot_status enum.
-- Decisions-locked derived #2.
-- Idempotent: DO block guards CREATE TYPE so re-runs are safe.
--
-- Assumed extensions: pgcrypto (Phase 0), pg_net (Phase 1 present).
-- Assumed Postgres version: 15 (Supabase default as of 2026).

DO $phase2_enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stock_lot_status') THEN
    CREATE TYPE stock_lot_status AS ENUM (
      'active',    -- lot in use; current_qty > 0; expiry_date >= today
      'depleted',  -- current_qty = 0; used up via normal issue movements
      'expired',   -- expiry_date < today; set automatically by daily cron at 09:00 Bangkok
      'recalled'   -- manually flagged by Admin; blocked from all issue-class movements
    );
  END IF;
END
$phase2_enum$;

COMMENT ON TYPE stock_lot_status IS
  'Phase 2. active=in use; depleted=used up; expired=past expiry_date (auto by cron 09:00 BKK Q-Phase2-3); recalled=manually quarantined by Admin (Q-Phase2-2).';

-- ============================================================
-- Verification SQL
-- ============================================================
-- Paste into Dashboard SQL Editor to confirm:
--
--   SELECT enumlabel, enumsortorder
--   FROM pg_enum
--   WHERE enumtypid = 'stock_lot_status'::regtype
--   ORDER BY enumsortorder;
--   -- Expected: 4 rows — active(1), depleted(2), expired(3), recalled(4)
