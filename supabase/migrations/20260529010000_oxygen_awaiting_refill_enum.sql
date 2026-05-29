-- supabase/migrations/20260529010000_oxygen_awaiting_refill_enum.sql
-- Add the 6th oxygen_tank_status value: 'awaiting_refill'.
--
-- Pipeline becomes:
--   on_board (บนรถ) → awaiting_refill (ลงมากองรอที่ฐาน)
--     → refilling (ส่งร้าน กำลังเติม) → ready (เสร็จ)
--
-- 'refilling' now means "at the vendor, being refilled" only.
-- 'awaiting_refill' means "off the truck, waiting at base to be batch-sent".
--
-- POSTGRES RULE: a new enum value CANNOT be used in the same transaction that
-- adds it. This migration ONLY adds the value. The backfill + function updates
-- that USE the value live in the companion migration
-- 20260529010100_oxygen_awaiting_refill_logic.sql, which must run AFTER this
-- one has committed.
--
-- Inserted BEFORE 'refilling' so dashboard sort order reads:
--   ready · on_board · awaiting_refill · refilling · maintenance · retired
--
-- Idempotent: ADD VALUE IF NOT EXISTS.

ALTER TYPE oxygen_tank_status ADD VALUE IF NOT EXISTS 'awaiting_refill' BEFORE 'refilling';

COMMENT ON TYPE oxygen_tank_status IS
  'Phase post-5.1. ready=in storage; on_board=deployed on vehicle; '
  'awaiting_refill=off the truck, staged at base waiting to be batch-sent; '
  'refilling=at the vendor being refilled; maintenance=pulled for service; '
  'retired=terminal, no further transitions permitted.';

-- Verification:
-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = 'oxygen_tank_status'::regtype ORDER BY enumsortorder;
-- Expected 6 rows: ready, on_board, awaiting_refill, refilling, maintenance, retired
