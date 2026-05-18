# Deploy — Thegood Stock

This project intentionally avoids the Supabase CLI. All Supabase changes go through the web Dashboard.

## Bootstrap (one-time)

1. Create Supabase project `thegood-stock` (ap-southeast-1) in dashboard.
2. Project Settings → Edge Functions → Secrets: add the 4 secrets listed in `env-setup.md`.
3. SQL Editor → run each file from `supabase/migrations/` in filename order (timestamps). After each, verify "Success. No rows returned" or similar.
4. Database → Replication → confirm `supabase_realtime` publication exists (no tables added yet — Phase 1+ work).
5. Edge Functions → New function → name `auth-bridge` → paste contents of `supabase/functions/auth-bridge/index.ts` → Save → Deploy. Repeat for `sync-ambulances` and `tg-notify`.
6. Update `shared/config.js` with the project URL and anon key.
7. Push the repo to GitHub: `gh repo create officethegood/thegood-stock --public --source=. --remote=origin --push` (or web UI + `git remote add ... && git push -u origin main`).
8. GitHub → Settings → Pages → Source: Deploy from a branch, Branch: `main` / `(root)` → Save.
9. Wait ~1 min then open `https://officethegood.github.io/thegood-stock/login.html`.
10. Login as Admin → Settings tab → set Ambulance GAS URL + Telegram chat_id → Save → Test send.

## Ongoing

| Change | Action |
|---|---|
| Frontend HTML/JS/CSS | `git push origin main` → GitHub Pages auto-deploys (~30s) |
| Migration | Dashboard → SQL Editor → paste new migration file → Run |
| Edge Function update | Dashboard → Edge Functions → open function → paste new index.ts → Save → Deploy |
| Settings | admin.html → Settings tab (no deploy needed) |

## Before every prod migration

1. Dashboard → Database → Backups → take a manual backup (or use Supabase's daily backups)
2. Copy the new migration SQL into the SQL Editor
3. Run; verify result; commit the migration file to git

## Rollback

| Layer | Rollback |
|---|---|
| Frontend | `git revert HEAD && git push` (~30s) |
| Migration | Write and apply a NEW "down" migration SQL — do not edit historical files |
| Edge Function | Check out previous git rev for the function, paste into Dashboard, redeploy |
| Cache (stale SW) | Bump `CACHE_VERSION` in `sw.js`, push |

## Logging

Built-in:
- Dashboard → Edge Functions → `<name>` → Logs
- Browser DevTools console (frontend errors)

No external log shipping in Phase 0 (per spec Q18 = A).
