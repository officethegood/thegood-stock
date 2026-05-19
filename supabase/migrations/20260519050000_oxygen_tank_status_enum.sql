-- supabase/migrations/20260519050000_oxygen_tank_status_enum.sql
-- Phase 5 — oxygen_tank_status enum.
-- Decisions-locked: derived #2 (5 values).
-- Idempotent: DO block guards CREATE TYPE.
-- NO pg_cron — Phase 5 alerting is event-driven (trigger-based).

DO $phase5_status_enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oxygen_tank_status') THEN
    CREATE TYPE oxygen_tank_status AS ENUM (
      'ready',        -- in storage, full, ready to deploy
      'on_board',     -- loaded on an ambulance, in use
      'refilling',    -- returned empty, sent to refill vendor
      'maintenance',  -- pulled for maintenance (hydrostatic test, repair, etc.)
      'retired'       -- permanently decommissioned (terminal state — no further transitions)
    );
  END IF;
END
$phase5_status_enum$;

COMMENT ON TYPE oxygen_tank_status IS
  'Phase 5. ready=in storage; on_board=deployed on vehicle; refilling=with vendor; '
  'maintenance=pulled for service; retired=terminal, no further transitions permitted. '
  'Decisions-locked Q-Phase5-1 confirmed 5 values.';

-- Verification:
-- SELECT enumlabel
-- FROM pg_enum
-- WHERE enumtypid = 'oxygen_tank_status'::regtype
-- ORDER BY enumsortorder;
-- Expected: 5 rows: ready, on_board, refilling, maintenance, retired
