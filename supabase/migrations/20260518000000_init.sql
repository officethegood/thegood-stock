-- supabase/migrations/20260518000000_init.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION app_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'user_role', '')
$$;

CREATE OR REPLACE FUNCTION app_username() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'username', '')
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
