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

Add these manually in the Supabase dashboard:

| Key | Value |
|---|---|
| `GAS_HR_URL` | `https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec` |
| `JWT_ACCESS_TTL_SECONDS` | `28800` |
| `JWT_REFRESH_TTL_SECONDS` | `2592000` |
| `NOTIFY_PROXY_URL` | `https://thegood-ocr-proxy.officethegood.workers.dev` |

Built-in (auto-provided by Supabase, do not set manually):
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`

## Frontend config (one file)

Edit `shared/config.js`:
- `SUPABASE_URL` — replace `REPLACE_WITH_PROJECT_REF` with the project URL from Settings → API
- `SUPABASE_ANON_KEY` — replace `REPLACE_WITH_ANON_KEY` with the public anon key

## In-app settings (after first admin login)

Open `admin.html` → Settings tab:
- `AMBULANCE_GAS_URL` — paste the Ambulance GAS `/exec` URL (must support `?action=listAmbulances` — see `docs/gas-ambulance-doget-snippet.md`)
- `NOTIFY_TELEGRAM_CHAT_ID` — chat_id for Stock alerts
- `NOTIFY_TELEGRAM_ENABLED` — turn on after confirming Test button works
