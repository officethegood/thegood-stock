-- Minimal schema for testing the REAL stock triggers/RPCs on a throwaway Postgres.
-- Tables here are stubs. The function bodies under test are loaded from
-- supabase/migrations/ by run.sh, so a test failure means the real code failed.
CREATE ROLE authenticated NOLOGIN;
CREATE PUBLICATION supabase_realtime;

-- JWT stand-ins: a test can act with no JWT via SET LOCAL test.username = 'none'.
-- (A custom setting reverts to '' after SET LOCAL, so '' must mean the default.)
CREATE FUNCTION app_user_role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('test.role', true), ''), 'Admin') $$;
CREATE FUNCTION app_username() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT CASE current_setting('test.username', true) WHEN 'none' THEN ''
              ELSE coalesce(nullif(current_setting('test.username', true), ''), 'test') END $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE settings (key text PRIMARY KEY, value text, is_secret boolean NOT NULL DEFAULT false);
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON settings TO authenticated;

-- pg_net / pg_cron stand-ins: record what would have been sent or scheduled.
CREATE TABLE http_log (body jsonb);
CREATE SCHEMA net;
CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb) RETURNS bigint
LANGUAGE sql AS $$ INSERT INTO public.http_log VALUES (body); SELECT 1::bigint $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobname text PRIMARY KEY, schedule text, command text);
CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint
LANGUAGE sql AS $$ INSERT INTO cron.job VALUES (n, s, c); SELECT 1::bigint $$;
CREATE FUNCTION cron.unschedule(n text) RETURNS boolean
LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = n; SELECT true $$;

CREATE TYPE stock_movement_type AS ENUM
  ('receive','issue','adjustment_gain','adjustment_loss','borrow','return','transfer_out','transfer_in');
CREATE TYPE stock_lot_status AS ENUM ('active','expired','depleted','recalled');

CREATE TABLE bag_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE NOT NULL,
  name text NOT NULL, category text NOT NULL DEFAULT 'ALS', description text, active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  created_by text DEFAULT app_username(), updated_by text);
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text, type text,
  parent_id uuid REFERENCES locations(id), active boolean NOT NULL DEFAULT true,
  bag_template_id uuid REFERENCES bag_templates(id));
CREATE TABLE stock_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text, name text,
  unit text, tracks_lots boolean NOT NULL DEFAULT true);
CREATE TABLE bag_template_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_template_id uuid NOT NULL REFERENCES bag_templates(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES stock_items(id), target_qty int NOT NULL CHECK (target_qty > 0),
  mandatory boolean NOT NULL DEFAULT true, sort_order int NOT NULL DEFAULT 0, note text,
  UNIQUE (bag_template_id, item_id));
CREATE TABLE stock_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES stock_items(id),
  lot_number text NOT NULL, expiry_date date NOT NULL, received_qty int,
  current_qty int NOT NULL DEFAULT 0 CHECK (current_qty >= 0), supplier text, note text,
  status stock_lot_status NOT NULL DEFAULT 'active', recalled_reason text, recalled_by text,
  recalled_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz,
  created_by text DEFAULT app_username(), updated_by text,
  CONSTRAINT uq_lot_per_item UNIQUE (item_id, lot_number));
CREATE TABLE stock_item_locations (
  item_id uuid, location_id uuid, qty int NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_movement_at timestamptz, PRIMARY KEY (item_id, location_id));
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_ref_id uuid UNIQUE DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES stock_items(id), location_id uuid NOT NULL REFERENCES locations(id),
  movement_type stock_movement_type NOT NULL,
  qty_delta int NOT NULL, qty_after int, lot_id uuid REFERENCES stock_lots(id), reason text, note text,
  performed_by text NOT NULL DEFAULT app_username(), performed_role text NOT NULL DEFAULT app_user_role(),
  performed_at timestamptz NOT NULL DEFAULT now(),
  fefo_override boolean NOT NULL DEFAULT false, scanned boolean NOT NULL DEFAULT false,
  expired_ack boolean NOT NULL DEFAULT false, source_movement_id uuid,
  due_at timestamptz, borrower_username text);
