-- supabase/migrations/20260518000500_user_sessions.sql

CREATE TABLE user_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL,
  name                text,
  role                text NOT NULL,
  jwt_jti             text UNIQUE NOT NULL,
  refresh_token       text UNIQUE NOT NULL,
  issued_at           timestamptz DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  refresh_expires_at  timestamptz NOT NULL,
  revoked             boolean DEFAULT false,
  last_seen_at        timestamptz,
  ip                  inet,
  user_agent          text
);
CREATE INDEX idx_sessions_username ON user_sessions(username);
CREATE INDEX idx_sessions_refresh  ON user_sessions(refresh_token);
CREATE INDEX idx_sessions_expires  ON user_sessions(refresh_expires_at);
