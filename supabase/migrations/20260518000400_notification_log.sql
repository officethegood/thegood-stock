-- supabase/migrations/20260518000400_notification_log.sql

CREATE TABLE notification_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       text NOT NULL,
  entity_type      text,
  entity_id        text,
  dedupe_key       text NOT NULL,
  channel          text NOT NULL DEFAULT 'telegram',
  message          text,
  payload          jsonb,
  sent_at          timestamptz DEFAULT now(),
  success          boolean DEFAULT true,
  error            text
);
CREATE INDEX idx_notif_dedupe ON notification_log(dedupe_key, sent_at);
CREATE INDEX idx_notif_event  ON notification_log(event_type, sent_at);
