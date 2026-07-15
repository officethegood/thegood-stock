# Environment Setup — Thegood Stock

## Required accounts
- Supabase organization `officethegood` (Project `thegood-stock`, region ap-southeast-1)
- GitHub organization `officethegood` (Repo `thegood-stock`)
- Access to existing Thegood Cloudflare account (Worker `thegood-ocr-proxy`)
- Access to Thegood HR GAS script (for auth)
- Access to Thegood Ambulance GAS script (for ambulance list)

## Local tooling
- git (any recent version)
- curl + bash (for smoke tests)
- No Supabase CLI install — all Supabase work is via web Dashboard

## Supabase secrets (Dashboard → Project Settings → Edge Functions → Secrets)

Add these **5** manually in the Supabase dashboard (list aligned with Project.md §4.5, 2026-07-15):

| Key | Value |
|---|---|
| `APP_JWT_HS_SECRET` | Legacy JWT secret (Settings → JWT Keys → Legacy JWT Secret) — auth-bridge signs/verifies HS256 with this |
| `GAS_HR_URL` | `https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec` |
| `JWT_ACCESS_TTL_SECONDS` | `28800` |
| `JWT_REFRESH_TTL_SECONDS` | `2592000` |
| `NOTIFY_PROXY_URL` | `https://thegood-ocr-proxy.officethegood.workers.dev` |

Built-in (auto-provided by Supabase, do not set manually — names vary by dashboard era; the functions only read `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- (`SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_JWKS` — present but unused by our code)

Also required in the **`settings` table** (used by DB triggers/cron — not Edge secrets):
- `NOTIFY_SUPABASE_URL`, `NOTIFY_SERVICE_ROLE_KEY` (is_secret) — pg_net → tg-notify chain

## Frontend config (one file)

Edit `shared/config.js`:
- `SUPABASE_URL` — replace `REPLACE_WITH_PROJECT_REF` with the project URL from Settings → API
- `SUPABASE_ANON_KEY` — replace `REPLACE_WITH_ANON_KEY` with the public anon key

## In-app settings (after first admin login)

Open `admin.html` → Settings tab:
- `AMBULANCE_GAS_URL` — paste the Ambulance GAS `/exec` URL (must support `?action=listAmbulances` — see `docs/gas-ambulance-doget-snippet.md`)
- `NOTIFY_TELEGRAM_CHAT_ID` — chat_id for Stock alerts
- `NOTIFY_TELEGRAM_ENABLED` — turn on after confirming Test button works
