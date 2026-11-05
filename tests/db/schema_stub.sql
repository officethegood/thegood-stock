-- Minimal schema for testing the REAL stock triggers/RPCs on a throwaway Postgres.
-- Tables here are stubs. The function bodies under test are loaded from
-- supabase/migrations/ by run.sh, so a test failure means the real code failed.
CREATE ROLE authenticated NOLOGIN;

CREATE FUNCTION app_user_role() RETURNS text LANGUAGE sql AS $$ SELECT 'Admin'::text $$;
CREATE FUNCTION app_username()  RETURNS text LANGUAGE sql AS $$ SELECT 'test'::text $$;

CREATE TYPE stock_movement_type AS ENUM
  ('receive','issue','adjustment_gain','adjustment_loss','borrow','return','transfer_out','transfer_in');
CREATE TYPE stock_lot_status AS ENUM ('active','expired','depleted','recalled');

CREATE TABLE locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text, type text);
CREATE TABLE stock_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text, name text,
  unit text, tracks_lots boolean NOT NULL DEFAULT true);
CREATE TABLE stock_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES stock_items(id),
  lot_number text, expiry_date date, current_qty int NOT NULL DEFAULT 0 CHECK (current_qty >= 0),
  status stock_lot_status NOT NULL DEFAULT 'active', recalled_reason text, recalled_by text,
  recalled_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz, updated_by text);
CREATE TABLE stock_item_locations (
  item_id uuid, location_id uuid, qty int NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_movement_at timestamptz, PRIMARY KEY (item_id, location_id));
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_ref_id uuid UNIQUE DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL, location_id uuid NOT NULL, movement_type stock_movement_type NOT NULL,
  qty_delta int NOT NULL, qty_after int, lot_id uuid REFERENCES stock_lots(id), reason text, note text,
  performed_by text NOT NULL DEFAULT app_username(), performed_at timestamptz NOT NULL DEFAULT now(),
  fefo_override boolean NOT NULL DEFAULT false, scanned boolean NOT NULL DEFAULT false,
  expired_ack boolean NOT NULL DEFAULT false, source_movement_id uuid);
