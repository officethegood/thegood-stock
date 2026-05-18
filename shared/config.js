// shared/config.js
// Thegood Stock — Configuration
// NOTE: SUPABASE_URL and SUPABASE_ANON_KEY are filled after Supabase project creation.

window.APP_VERSION      = '0.1.0';
window.APP_VERSION_DATE = '2026-05-18';

const CONFIG = {
  // ===== Required (bootstrap) =====
  SUPABASE_URL:     'https://REPLACE_WITH_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY:'REPLACE_WITH_ANON_KEY',
  BASE_URL:         '/thegood-stock',
  GAS_AUTH_API_URL: 'https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec',

  // ===== External services (re-used from Thegood) =====
  NOTIFY_PROXY_URL:         'https://thegood-ocr-proxy.officethegood.workers.dev',
  CLOUDINARY_CLOUD_NAME:    'ddummbyql',
  CLOUDINARY_UPLOAD_PRESET: 'pt-medical',
  CLOUDINARY_FOLDER_PREFIX: 'thegood-stock/',

  // ===== Endpoints (derived) =====
  EDGE_AUTH_BRIDGE:     '/functions/v1/auth-bridge',
  EDGE_SYNC_AMBU:       '/functions/v1/sync-ambulances',
  EDGE_TG_NOTIFY:       '/functions/v1/tg-notify',
};

window.CONFIG = CONFIG;
