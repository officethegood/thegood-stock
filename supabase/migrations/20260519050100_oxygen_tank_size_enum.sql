-- supabase/migrations/20260519050100_oxygen_tank_size_enum.sql
-- Phase 5 — tank_size design record.
--
-- DECISION (Q-Phase5-1, Q-Phase5-I):
--   tank_size is implemented as a text column CHECK on oxygen_tanks:
--     CHECK (tank_size IN ('small','medium','large'))
--   NOT as a Postgres CREATE TYPE enum.
--   Rationale: text+CHECK allows ALTER TABLE to add sizes (e.g., 'extra_large')
--   at Phase 5.1 without enum DDL migration complexity.
--
-- This migration file is intentionally a no-op SQL statement.
-- The actual CHECK constraint is defined in 20260519050200_oxygen_tanks.sql.
-- DO NOT create CREATE TYPE oxygen_tank_size here.

SELECT 1 AS phase5_tank_size_design_decision_recorded;
-- ^ no-op: valid SQL, no schema change.

-- Verification:
-- SELECT count(*) FROM pg_type WHERE typname = 'oxygen_tank_size';
-- Expected: 0
