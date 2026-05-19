-- supabase/migrations/20260519050200_oxygen_tanks.sql
-- Phase 5 — oxygen_tanks master table.
-- Decisions-locked: derived #1 (schema), Q-Phase5-5 (no purchase_price/acquired_at).
-- NOT a child of stock_items — separate standalone table.
-- tank_size: text CHECK (not enum) per Q-Phase5-I.
-- status: updated ONLY by apply_oxygen_movement() SECURITY DEFINER trigger.
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS oxygen_tanks (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  serial               text         UNIQUE NOT NULL,
    -- Manufacturer serial number engraved on the cylinder.
    -- Staff scan or type this value. Globally unique.
  tank_size            text         NOT NULL
    CHECK (tank_size IN ('small', 'medium', 'large')),
    -- Q-Phase5-1: 3 sizes confirmed. Q-Phase5-I: text CHECK (not enum) for extensibility.
    -- To add 'extra_large' at Phase 5.1: ALTER TABLE oxygen_tanks
    --   DROP CONSTRAINT oxygen_tanks_tank_size_check,
    --   ADD CONSTRAINT oxygen_tanks_tank_size_check CHECK (tank_size IN (...,'extra_large'));
  current_location_id  uuid         REFERENCES locations(id) ON DELETE RESTRICT,
    -- FK to Phase 0 locations table. NULL permitted only transiently during initial INSERT.
    -- NOT NULL enforced by application; DB allows NULL to permit atomic creation before
    -- the first oxygen_movements transition row sets the location.
  status               oxygen_tank_status NOT NULL DEFAULT 'ready',
    -- Authoritative current status. Updated ONLY by apply_oxygen_movement() AFTER INSERT
    -- trigger on oxygen_movements. Never updated directly by application code.
  last_refill_at       timestamptz,
    -- Set by apply_oxygen_movement() trigger when to_status='ready' AND from_status='refilling'.
  last_refill_by       text,
    -- Free text: name of staff or vendor who completed the refill.
  last_pressure_psi    int CHECK (last_pressure_psi IS NULL OR last_pressure_psi > 0),
    -- Optional: most recent PSI reading. No history kept here (Phase 5.1).
  next_inspection_due  date,
    -- Hydrostatic inspection compliance date. Alert cron deferred to Phase 5.1.
  notes                text,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  created_by           text         NOT NULL DEFAULT app_username(),
  updated_by           text         NOT NULL DEFAULT app_username()
  -- Q-Phase5-5: purchase_price and acquired_at are NOT in Phase 5.
  -- Deferred to Phase 5.1 (finance/insurance module).
);

COMMENT ON TABLE oxygen_tanks IS
  'Phase 5. One row per physical oxygen cylinder. Identity = serial number engraved on the '
  'cylinder. Status maintained by state-machine trigger on oxygen_movements. '
  'NOT a child of stock_items — per-piece serial identity model is architecturally '
  'distinct from SKU+qty model (Phase 1 spec §10, Q-Phase1-D).';

COMMENT ON COLUMN oxygen_tanks.serial IS
  'Manufacturer serial number. Unique globally. Staff scan/type to look up the tank.';
COMMENT ON COLUMN oxygen_tanks.status IS
  'Updated ONLY by apply_oxygen_movement() SECURITY DEFINER trigger. '
  'Direct UPDATE blocked by RLS false policy on UPDATE.';
COMMENT ON COLUMN oxygen_tanks.last_refill_at IS
  'Auto-set when a refilling→ready transition is recorded. Tracks most recent refill completion.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oxygen_tanks_status   ON oxygen_tanks (status);
CREATE INDEX IF NOT EXISTS idx_oxygen_tanks_location ON oxygen_tanks (current_location_id);
CREATE INDEX IF NOT EXISTS idx_oxygen_tanks_serial   ON oxygen_tanks (serial text_pattern_ops);
  -- text_pattern_ops supports LIKE 'OXY-%' prefix searches in admin filter.

-- Auto-update updated_at on any row change (reuses Phase 0 set_updated_at() helper).
DROP TRIGGER IF EXISTS trg_oxygen_tanks_updated_at ON oxygen_tanks;
CREATE TRIGGER trg_oxygen_tanks_updated_at
  BEFORE UPDATE ON oxygen_tanks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed OXYGEN_REFILL_THRESHOLD default if not already present (Q-Phase5-2: default=5).
INSERT INTO settings (key, value)
VALUES ('OXYGEN_REFILL_THRESHOLD', '5')
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN settings.key IS
  'Phase 0+1+2+5 KV. Phase 5 added OXYGEN_REFILL_THRESHOLD (default 5 tanks).';

-- Verification:
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'oxygen_tanks'
-- ORDER BY ordinal_position;
-- Expected: 15 columns. status default='ready'. serial NOT NULL. No purchase_price. No acquired_at.
