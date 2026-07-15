# Thegood Stock

Mobile-first web app for managing medication (lots + expiry), equipment borrow/return, ALS bags, oxygen tanks, and linens at Thegood. Built on Supabase + GitHub Pages. Thai-language UI, used daily by the ambulance teams (TG1–TG6).

- **Status:** all phases (0–6) live in production since May 2026, actively maintained
- **System overview (current state):** `docs/system-overview.md` ← start here
- **User flows (Thai):** `docs/flow-issue-borrow.md`
- **Phase specs/designs/plans:** `docs/superpowers/`
- **Live URL:** https://officethegood.github.io/thegood-stock/
- **Supabase project:** `thegood-stock` (ap-southeast-1) — Dashboard-only, no CLI

## Quick start (developer)

1. All Supabase work goes through the web Dashboard (no CLI install for this project).
2. Apply migrations: copy each file from `supabase/migrations/` into Dashboard → SQL Editor → Run (in timestamp order; every file is idempotent and ends with verification SQL).
3. Deploy Edge Functions: Dashboard → Edge Functions → New → paste `supabase/functions/<name>/index.ts` ("Verify JWT with legacy secret" must be OFF).
4. Edit `shared/config.js` with the project URL + anon key.
5. Push to `main` → GitHub Pages auto-deploys. **Bump `CACHE_VERSION` in `sw.js` whenever frontend files change.**
6. Stock consistency health check (read-only, run anytime): `sql/audit-stock-consistency.sql`.

See `docs/env-setup.md` and `docs/deploy.md`.
