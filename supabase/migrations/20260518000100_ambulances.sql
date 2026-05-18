-- supabase/migrations/20260518000100_ambulances.sql

CREATE TABLE ambulances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gas_id           text UNIQUE,
  plate            text NOT NULL,
  callsign         text,
  active           boolean DEFAULT true,
  raw              jsonb,
  last_synced_at   timestamptz DEFAULT now(),
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
CREATE INDEX idx_ambulances_plate ON ambulances(plate);
CREATE TRIGGER trg_ambulances_updated_at BEFORE UPDATE ON ambulances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
