-- supabase/migrations/20260519050300_oxygen_movements.sql
-- Phase 5 — oxygen_movements immutable audit ledger.
-- Decisions-locked: derived #4, Q-Phase5-G (INSERT-only — no UPDATE/DELETE RLS).
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS oxygen_movements (
  id               uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  tank_id          uuid               NOT NULL REFERENCES oxygen_tanks(id) ON DELETE RESTRICT,
  from_status      oxygen_tank_status,
    -- NULL only for the first movement (initial placement: NULL → ready).
  to_status        oxygen_tank_status NOT NULL,
  from_location_id uuid               REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_id   uuid               REFERENCES locations(id) ON DELETE RESTRICT,
    -- from_ and to_location may be the same (e.g., maintenance at same site).
  performed_by     text               NOT NULL DEFAULT app_username(),
  performed_at     timestamptz        NOT NULL DEFAULT now(),
  note             text,
    -- Q-Phase5-3: maintenance reason stored here as free text. No sub-reason enum.
  photo_url        text,
    -- Optional Cloudinary URL. Folder: thegood-stock/oxygen/{serial}/
    -- Q-Phase5-4: optional on all transitions. photo_url nullable.
    -- Reuses shared/photo-capture.js from Phase 3 (see cross-phase dependency note).
  created_at       timestamptz        NOT NULL DEFAULT now()
  -- No updated_at: append-only. No UPDATE or DELETE permitted on this table.
);

COMMENT ON TABLE oxygen_movements IS
  'Phase 5. Immutable audit ledger of every oxygen tank state transition. '
  'INSERT-only — no UPDATE, no DELETE (RLS enforces; no UPDATE/DELETE policies exist). '
  'BEFORE INSERT trigger enforces state machine. AFTER INSERT trigger fires refill alert.';

COMMENT ON COLUMN oxygen_movements.from_status IS
  'NULL only for the first movement (initial placement: NULL → ready). '
  'Must match oxygen_tanks.status at time of INSERT (enforced by BEFORE INSERT trigger).';
COMMENT ON COLUMN oxygen_movements.note IS
  'Q-Phase5-3: maintenance reason captured here as free text. Phase 5.1 may add structured sub-reasons.';
COMMENT ON COLUMN oxygen_movements.photo_url IS
  'Q-Phase5-4: optional on all transitions. Cloudinary URL. '
  'Folder prefix: thegood-stock/oxygen/{tank_serial}/. Reuses Phase 3 photo-capture.js component.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oxygen_movements_tank_id
  ON oxygen_movements (tank_id, performed_at DESC);
  -- Primary drill-down: history for one tank ordered newest-first.

CREATE INDEX IF NOT EXISTS idx_oxygen_movements_to_status
  ON oxygen_movements (to_status, performed_at DESC);
  -- Refill alert trigger counts via oxygen_tanks.status (not this index), but
  -- this index supports admin reporting queries (e.g., all recent refilling events).

-- Verification:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'oxygen_movements'
-- ORDER BY ordinal_position;
-- Expected: 11 columns. No updated_at. photo_url nullable.
