-- supabase/migrations/20260518000200_locations.sql

CREATE TYPE location_type AS ENUM ('room', 'cabinet', 'shelf', 'ambulance', 'bag');

CREATE TABLE locations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text UNIQUE NOT NULL,
  name             text NOT NULL,
  type             location_type NOT NULL,
  parent_id        uuid REFERENCES locations(id) ON DELETE RESTRICT,
  ambulance_id     uuid REFERENCES ambulances(id),
  qr_payload       text,
  active           boolean DEFAULT true,
  note             text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),

  CONSTRAINT chk_ambulance_link CHECK (
    (type = 'ambulance' AND ambulance_id IS NOT NULL) OR
    (type <> 'ambulance' AND ambulance_id IS NULL)
  )
);
CREATE INDEX idx_locations_parent ON locations(parent_id);
CREATE INDEX idx_locations_type   ON locations(type);
CREATE TRIGGER trg_locations_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
