# Thegood Stock

Mobile-first web app for managing medication, equipment, ALS bags, oxygen tanks, and linens at Thegood. Built on Supabase + GitHub Pages.

- **Status:** Phase 0 (Foundation) in progress
- **Spec:** `docs/superpowers/specs/2026-05-18-phase0-foundation-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-18-phase0-foundation-plan.md`
- **Live URL:** https://officethegood.github.io/thegood-stock/
- **Supabase project:** `thegood-stock` (ap-southeast-1)

## Quick start (developer)

1. All Supabase work goes through the web Dashboard (no CLI install for this project).
2. Apply migrations: copy each file from `supabase/migrations/` into Dashboard → SQL Editor → Run.
3. Deploy Edge Functions: Dashboard → Edge Functions → New → paste `supabase/functions/<name>/index.ts`.
4. Edit `shared/config.js` with the project URL + anon key.
5. Push to `main` → GitHub Pages auto-deploys.

See `docs/env-setup.md` and `docs/deploy.md`.
