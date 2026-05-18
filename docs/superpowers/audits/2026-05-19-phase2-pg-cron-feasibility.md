# Phase 2 Feasibility Audit: pg_cron vs Cloudflare Worker for Daily Expiry Cron

**Audit date:** 2026-05-19
**Auditor:** DevOps Engineer (Claude Code)
**Supabase project:** thegood-stock (`xtjsjrfixngfdkaahton`, ap-southeast-1, Free/Nano)
**Scope:** Task A8 — daily 09:00 BKK auto-expire + Telegram expiry alerts

---

## 1. Verdict

**USE pg_cron.** It is available on the Free/Nano plan, already satisfies all technical requirements of Task A8, and avoids the additional operational surface of a Cloudflare Worker cron trigger plus a new Edge Function.

---

## 2. Evidence

- **Supabase staff confirmation (GitHub Discussion #37405, 2024):** GaryAustin1 (Supabase collaborator) stated: _"Cron is only limited by the resources it uses CPU/Memory/Disk wise on any tier."_ No tier gate for pg_cron. Source: https://github.com/orgs/supabase/discussions/37405

- **Supabase Cron docs (fetched 2026-05-19):** Dashboard path is now Integrations → Cron (Postgres Module) OR Database → Extensions → pg_cron. Both paths enable the same extension. Source: https://supabase.com/docs/guides/cron and https://supabase.com/docs/guides/cron/install

- **pg_cron role:** Per GitHub Discussion #27763 (Supabase staff, 2024): pg_cron jobs run under the role specified in `cron.job.username`. `anon` and `authenticated` cannot execute cron. **Functions invoked by pg_cron must be `SECURITY DEFINER` to run as `postgres` role.** The `run_expiry_alert()` function in the Task A8 migration is already annotated `SECURITY DEFINER` in the plan. Source: https://github.com/orgs/supabase/discussions/27763

- **Phase 0 extensions already installed (migration `20260518000000_init.sql`):**
  - `pgcrypto` — enabled
  - `pg_net` — enabled
  - `pg_cron` — **NOT yet enabled** (not in any Phase 0 migration; must be enabled in A8)

- **`pg_cron` extension availability query (from plan PF-7):**
  ```sql
  SELECT extname FROM pg_available_extensions WHERE name='pg_cron';
  ```
  Expected: 1 row. This must be confirmed by the operator in Dashboard → SQL Editor before running the A8 migration. Based on all evidence above, 1 row is the expected result on this Free project.

- **Edge Function invocations (CF Worker fallback relevance):** Free plan includes 500,000 invocations/month. A daily cron via Edge Function would consume ~31 invocations/month — far below cap. The CF fallback is technically viable but adds a new Edge Function + Cloudflare Worker cron trigger, which increases operational complexity for no gain. Source: https://supabase.com/pricing (fetched 2026-05-19).

- **Edge Function timeout:** 150 seconds on all plans (confirmed GitHub Discussion #40074, 2025). The `run_expiry_alert()` function runs 2 SQL passes (UPDATE + SELECT) plus up to 3 `pg_net` HTTP calls per threshold bucket. At low lot volumes this will complete well within 150s. Flag applies only to CF Worker fallback path (if Edge Function is used); pg_cron path is pure SQL and has no 150s cap.

---

## 3. What the deploy operator needs to do

**Pre-flight (required before pasting the A8 migration):**

- [ ] In Dashboard → SQL Editor, run PF-7 check:
  ```sql
  SELECT extname FROM pg_available_extensions WHERE name='pg_cron';
  ```
  Expected: 1 row. If 0 rows, stop and fall back to CF Worker path (see plan Task A8 fallback).

- [ ] In Dashboard → SQL Editor, confirm `pg_net` is already enabled:
  ```sql
  SELECT extname FROM pg_extension WHERE extname='pg_net';
  ```
  Expected: 1 row (installed in Phase 0).

- [ ] Confirm `settings` table has `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` populated (Phase 1 gotcha 9 resolution). `run_expiry_alert()` reads from these and skips the `pg_net` call with a WARNING if they are empty.

**Migration deploy (A8 — pg_cron path):**

- [ ] Open Dashboard → SQL Editor.
- [ ] Take a manual backup: Dashboard → Database → Backups → "Create backup" (or note the latest auto-backup timestamp).
- [ ] Paste and run `supabase/migrations/20260519010700_expiry_cron.sql` (file from plan Task A8 Step 2). This migration:
  1. `CREATE EXTENSION IF NOT EXISTS pg_cron;`
  2. Creates `run_expiry_alert()` as `SECURITY DEFINER`.
  3. Seeds `EXPIRY_ALERT_DAYS` in `settings` table.
  4. Calls `cron.schedule('expiry_alert_daily', '0 2 * * *', ...)` (02:00 UTC = 09:00 Asia/Bangkok).
- [ ] Git commit the migration file:
  ```
  git add "supabase/migrations/20260519010700_expiry_cron.sql"
  git commit -m "feat(db): run_expiry_alert cron + EXPIRY_ALERT_DAYS seed (Phase 2)"
  git push
  ```

**No Cloudflare Worker changes needed on the pg_cron path.**

---

## 4. Test command

Run immediately after migration, then check again the following morning at 09:01 BKK (02:01 UTC):

```sql
-- 4a: Extension present
SELECT extname FROM pg_extension WHERE extname = 'pg_cron';

-- 4b: Job registered
SELECT jobname, schedule, command, active
FROM cron.job
WHERE jobname = 'expiry_alert_daily';
-- Expected: 1 row, schedule='0 2 * * *', active=true

-- 4c: Manual smoke fire (run once to verify plumbing; safe to run in off-hours)
SELECT run_expiry_alert();

-- 4d: Confirm audit row written (run after 4c)
SELECT event_type, dedupe_key, success, sent_at
FROM notification_log
WHERE event_type = 'expiry'
ORDER BY sent_at DESC
LIMIT 5;
-- Expected: rows appear even if success=false (Telegram disabled).
-- If success=false and error contains "disabled", plumbing is correct.

-- 4e: Next-morning confirmation (after 09:01 BKK)
SELECT jobid, runid, job_pid, database, username, command,
       status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='expiry_alert_daily')
ORDER BY start_time DESC
LIMIT 3;
-- Expected: at least 1 row with status='succeeded'
```

---

## 5. Rollback

If the cron fires incorrectly or must be disabled immediately:

```sql
-- Disable without dropping (preferred; re-enable with active=true)
UPDATE cron.job SET active = false WHERE jobname = 'expiry_alert_daily';

-- Full removal (irreversible for this job registration)
SELECT cron.unschedule('expiry_alert_daily');
DROP FUNCTION IF EXISTS run_expiry_alert();
```

Note: `DROP EXTENSION pg_cron` permanently deletes ALL jobs. Do not drop the extension; unschedule the job only.

---

## 6. Risk flags

| Flag | Severity | Notes |
|---|---|---|
| `pg_cron` not yet enabled | Medium | Not in Phase 0 migrations. Operator must run `CREATE EXTENSION IF NOT EXISTS pg_cron` (included in A8 migration). Confirm PF-7 first. |
| SECURITY DEFINER required | Medium | `run_expiry_alert()` must be `SECURITY DEFINER`. The A8 plan already specifies this. Verify it is not accidentally omitted when pasting. |
| `cron.job_run_details` table growth | Low | On Free/Nano with 1 job/day, ~365 rows/year — negligible. No maintenance action needed for years. |
| Free plan compute cold-start | Low | pg_cron runs inside Postgres (no cold start). The `pg_net` HTTP call to `tg-notify` Edge Function may have a cold start of ~100ms, well within `pg_net`'s async model (fire-and-forget). |
| Edge Function 150s timeout | Not applicable (pg_cron path) | Only relevant if CF Worker fallback is used. `run_expiry_alert()` is pure SQL + async `pg_net` and has no function timeout. |
| Free plan 500k Edge Function invocations | Not applicable (pg_cron path) | Cron fires zero Edge Function invocations directly. `tg-notify` is called via `pg_net` HTTP (counts as 1 invocation/day = ~31/month). Negligible. |
| `NOTIFY_SUPABASE_URL` / `NOTIFY_SERVICE_ROLE_KEY` empty | High | If not seeded, `run_expiry_alert()` WARNs and skips the Telegram alert. The auto-expire SQL UPDATE still runs. Operator must populate these two settings rows before relying on Telegram delivery. See Project.md §8 gotcha 9. |
| Supabase Free plan pauses after 1 week inactivity | Medium | Free projects pause after 7 days of inactivity. A paused project stops ALL cron jobs. PM should ensure the app has at least one real user interaction per week, or upgrade to Pro. Monitor via Dashboard → Project Settings → General (pause status). |

---

**Assumptions:** Region ap-southeast-1 (Singapore, UTC+8 offset = Bangkok UTC+7 so 02:00 UTC = 09:00 BKK). Traffic profile: low (medical team ~10 users). Downtime budget: none for cron (silent failure is acceptable for 1 day; auto-expire catches up on next fire). Rollback window: immediate (UPDATE cron.job SET active=false).
