-- supabase/migrations/20260518000300_settings.sql

CREATE TABLE settings (
  key              text PRIMARY KEY,
  value            text,
  description      text,
  updated_at       timestamptz DEFAULT now(),
  updated_by       text
);

INSERT INTO settings(key, value, description) VALUES
  ('NOTIFY_TELEGRAM_ENABLED',     'false',     'เปิด/ปิดการแจ้งเตือน Telegram'),
  ('NOTIFY_TELEGRAM_CHAT_ID',     '',          'Chat ID สำหรับส่งแจ้งเตือน Stock'),
  ('NOTIFY_CRON_HOUR',            '6',         'เวลา (HH) ที่ cron ส่งสรุปประจำวัน'),
  ('LOW_STOCK_DEDUPE_HOURS',      '24',        'ระยะเวลา dedupe alert ซ้ำ (ชั่วโมง)'),
  ('EXPIRY_ALERT_DAYS',           '30,60,90',  'แจ้งเตือนล่วงหน้ากี่วัน (คั่นด้วย ,)'),
  ('OXYGEN_REFILL_THRESHOLD',     '5',         'จำนวนถังสถานะ "รอเติม" ที่จะ trigger alert'),
  ('AMBULANCE_GAS_URL',           '',          'GAS endpoint สำหรับ sync ambulances');
