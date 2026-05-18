# Phase 2 Security Audit — Medication Lots + Expiry Tracking

**Date:** 2026-05-19
**Auditor:** Security Engineer (autonomous)
**Status:** FINAL — for PM review before any Phase 2 implementation starts
**Scope:** Pre-implementation audit of locked decisions, spec, design, and plan for Phase 2 (Medication Lots + Expiry Tracking + 30/60/90-Day Alerts). No code has been written yet.

---

## Audit Scope Statement

**Files reviewed:**
- `docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md`
- `docs/superpowers/specs/2026-05-18-phase2-medication-design.md`
- `docs/superpowers/designs/2026-05-18-phase2-ui-design.md`
- `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md`
- `supabase/migrations/20260518000000_init.sql` (app_user_role, app_username functions)
- `supabase/migrations/20260518000300_settings.sql` (settings table DDL)
- `supabase/migrations/20260518000600_rls_policies.sql` (Phase 0 RLS)
- `supabase/migrations/20260518010400_stock_rls.sql` (Phase 1 RLS)
- `supabase/migrations/20260518010500_stock_triggers.sql` (Phase 1 triggers pattern)
- `supabase/migrations/20260518010700_notify_settings.sql` (NOTIFY key seeder)
- `Project.md` (§8 gotchas, §4.3 tables list)

**Assumed attacker capabilities (explicit, per project rule 5):**
- **Anon attacker:** unauthenticated browser, has the publishable (anon) key from `shared/config.js` (GitHub Pages — publicly readable)
- **Employee attacker:** valid authenticated JWT with `user_role='Employee'`, targeting data or bypassing lot-safety controls
- **Compromised Admin:** valid authenticated JWT with `user_role='Admin'`, attempting privilege escalation or data exfiltration
- **Network position:** external (internet), no DB-level access; all attacks go through PostgREST or Edge Functions

**Data sensitivity:**
- `stock_lots`: lot numbers, expiry dates, supplier names — operational PHI-adjacent (enables patient harm if bypass succeeds)
- `settings`: contains `NOTIFY_SERVICE_ROLE_KEY` — a Supabase service_role JWT that can bypass all RLS

**Limits of this review:**
- No SQL execution was performed; all analysis is static
- The Edge Function code for the A8 fallback path was reviewed as written in the plan; the deployed functions (`tg-notify`, `auth-bridge`) were not re-read in this audit session
- Cloudflare Worker code was not reviewed (not in scope; no file exists yet)
- Phase 1 acceptance tests T24–T44 are assumed to have passed (pre-flight for Phase 2)

---

## Findings

---

### S-1

**Severity:** HIGH

**Where:** `supabase/migrations/20260518000600_rls_policies.sql` (Phase 0 RLS, `settings` table) + `supabase/migrations/20260518010700_notify_settings.sql`

**Issue:** The `settings` table is readable by all authenticated users via policy `set_read FOR SELECT TO authenticated USING (true)`. The Phase 1 migration `20260518010700_notify_settings.sql` seeds a row `NOTIFY_SERVICE_ROLE_KEY` into that table. When the deploy operator populates this row with the real service_role key (required for `check_low_stock` and `run_expiry_alert` to call `tg-notify`), any authenticated user — including an Employee with a valid JWT — can execute `SELECT value FROM settings WHERE key='NOTIFY_SERVICE_ROLE_KEY'` and retrieve it verbatim. The service_role key bypasses every RLS policy on every table in the project.

**Exploit / Failure scenario:**
1. Attacker logs in as any Employee (or compromises any employee credential).
2. Issues `GET /rest/v1/settings?key=eq.NOTIFY_SERVICE_ROLE_KEY&select=value` with their JWT.
3. Receives the service_role key in the JSON response body.
4. Uses the service_role key to read the full `user_sessions` table (all tokens), write arbitrary `stock_movements` rows (bypassing all lot safety triggers — service_role is not subject to RLS, but triggers still fire — however they can DELETE rows too since DELETE policies are absent and service_role bypasses RLS), exfiltrate all data, or revoke all sessions.

**Mitigation (surgical — two-step):**

Step 1: Restrict `settings` SELECT to Admin only for sensitive keys. The cleanest fix is a column-level split: create a boolean `is_secret boolean NOT NULL DEFAULT false` column and change the SELECT policy to `USING (is_secret = false OR app_user_role() = 'Admin')`. Then mark `NOTIFY_SERVICE_ROLE_KEY` as `is_secret = true`. Employee queries can still read non-secret settings (needed for `EXPIRY_ALERT_DAYS`, `NOTIFY_TELEGRAM_ENABLED`, etc.).

Exact DDL change to add to Phase 2 migration or a standalone hotfix migration:
```sql
-- Add is_secret column to settings
ALTER TABLE settings ADD COLUMN IF NOT EXISTS is_secret boolean NOT NULL DEFAULT false;

-- Mark the sensitive key
UPDATE settings SET is_secret = true
WHERE key IN ('NOTIFY_SERVICE_ROLE_KEY');

-- Replace the blanket SELECT policy
DROP POLICY IF EXISTS set_read ON settings;
CREATE POLICY set_read ON settings
  FOR SELECT TO authenticated
  USING (is_secret = false OR app_user_role() = 'Admin');
```

Step 2 (defence-in-depth): Move the service_role key out of the settings table entirely in a future phase. The correct long-term home is Supabase Edge Function secrets (already used for `APP_JWT_HS_SECRET`). The triggers that need this key (`check_low_stock`, `run_expiry_alert`) could call a new thin Edge Function that holds the key as an env secret, rather than reading it from the DB. This is a Phase 3 architecture concern; for Phase 2, Step 1 is the mandatory minimum.

**Recommend:** BLOCK DEPLOY of Phase 2 until Step 1 migration is written and deployed. This finding pre-exists Phase 2 (it is a Phase 1 live vulnerability) but Phase 2 doubles the exposure surface by adding a second SECURITY DEFINER function (`run_expiry_alert`) that also reads the key. PM must issue a hotfix migration before Phase 2 migrations run.

---

### S-2

**Severity:** HIGH

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §5.1 (RLS) + `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md` Task A4

**Issue:** `app_user_role()` is defined as `SELECT coalesce(auth.jwt() ->> 'user_role', '')`. When the JWT is absent or has no `user_role` claim, the function returns the empty string `''` (not NULL). The `sl_insert` policy is `WITH CHECK (app_user_role() = 'Admin')`. An empty string does not equal `'Admin'`, so the policy correctly rejects the request. However, the `sl_update` policy has **both** a `USING` and `WITH CHECK` clause both requiring `'Admin'`. If the JWT carries a tampered `user_role` claim (Employees cannot forge the signature, but if the HS256 secret were compromised this would be critical) the policy would pass. The more immediate concern is: `app_user_role()` returns `''` not `NULL` — this means no "null role" bypass exists at the RLS level for unauthenticated (anon) callers because the `TO authenticated` role grant means the anon role never hits these policies. This sub-finding is **Info**-level.

The actual HIGH-severity issue here is that the `stock_lots` **SELECT** policy is `USING (true)` — every authenticated user, including Employee role, can read every row of `stock_lots` including `recalled_reason`, `recalled_by`, `recalled_at`. These columns may contain sensitive supplier names, pharmacist names, or regulatory recall codes. While lot status is operationally necessary for staff (lot picker), the full recall audit columns are administrative.

**Exploit / Failure scenario:**
An Employee wants to understand why a batch was recalled (e.g., to determine whether a patient was affected or to probe a supplier relationship). They issue `GET /rest/v1/stock_lots?select=recalled_reason,recalled_by,recalled_at` and receive the full history.

**Mitigation:**
Two options; recommend Option A:

Option A (surgical): Grant Employee SELECT only on the columns needed for lot picker (`id`, `item_id`, `lot_number`, `expiry_date`, `current_qty`, `status`, `supplier`) and restrict recall audit columns to Admin. In PostgREST/Supabase this is done with column-level privileges:
```sql
REVOKE SELECT ON stock_lots FROM authenticated;
GRANT SELECT (id, item_id, lot_number, expiry_date, received_at,
              received_qty, current_qty, supplier, note, status,
              created_at, updated_at)
  ON stock_lots TO authenticated;
GRANT SELECT ON stock_lots TO authenticated; -- full, for Admin only via RLS
```
However Supabase PostgREST does not support column-level grants with RLS in a practical way for this version; the recommended approach is an **Admin-only view** for recall audit columns.

Option B (acceptable for Phase 2): Document that `recalled_reason`, `recalled_by`, `recalled_at` are readable by all authenticated users, accept this as a business risk (Thegood staff are all employees of the same org), and add a comment to the RLS migration acknowledging the exposure.

**Recommend:** Accept risk for Phase 2 (Option B) given the org context (all staff = Thegood employees). Escalate to Phase 3 as a formal finding. Add policy comment documenting the accepted exposure.

---

### S-3

**Severity:** HIGH

**Where:** `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md` Task A5 — `check_lot_status` trigger

**Issue:** The `check_lot_status` BEFORE INSERT trigger performs a SELECT on `stock_lots` to read the lot's current status. This SELECT happens at the moment the trigger fires — after the client has sent the INSERT. There exists a TOCTOU (Time-of-Check Time-of-Use) race window: an attacker who can control two concurrent database sessions can (a) in session 1, UPDATE a lot from `active` to `expired` via the cron function, and simultaneously (b) in session 2, INSERT a movement referencing that lot **during the cron UPDATE transaction** before it commits. In Postgres default READ COMMITTED isolation, the trigger's SELECT in session 2 sees the pre-commit state from session 1's UPDATE and reads `status='active'`, allowing the movement. The cron then commits, setting the lot to `expired` — but the movement is already committed.

More practically (and more likely): the race exists between 00:00 and 09:00 Bangkok time (the nightly cron window) where a lot whose `expiry_date = today` still has `status='active'` (because the cron hasn't run yet at 09:00). The trigger as spec'd checks `status` only, not `expiry_date`. The decisions-locked doc (Q-Phase2-4) says the trigger "look up `stock_lots.status`; if status in (expired, recalled) RAISE EXCEPTION" — it does NOT say to also check `expiry_date < CURRENT_DATE`. This means between 00:00 and 09:00 on expiry day, the lot is technically expired by calendar but its DB status is still `active`, and the trigger PASSES it through.

The plan's trigger DDL (Task A5) faithfully implements the decisions-locked doc: it checks `v_lot_status IN ('expired', 'recalled')` and does NOT independently check `expiry_date < CURRENT_DATE`.

**Exploit / Failure scenario:**
At 01:00 Bangkok time (after midnight on the lot's expiry date), a staff member or an attacker with Employee credentials issues a movement referencing a lot with `expiry_date = today`. The trigger checks `status='active'` (because the 09:00 cron has not yet run) and allows the issue. The medication is now issued on its expiry day, within the 9-hour window.

**Mitigation (surgical — add one condition to the trigger):**

In `check_lot_status()`, after looking up `v_lot_status`, add an independent check of `expiry_date`:

```sql
-- After fetching v_lot_status, also check expiry_date directly.
DECLARE
  v_tracks_lots boolean;
  v_lot_status  stock_lot_status;
  v_lot_expiry  date;  -- ADD THIS

-- In the lot_id IS NOT NULL block, change to:
SELECT status, expiry_date
  INTO v_lot_status, v_lot_expiry      -- ADD expiry_date
FROM stock_lots
WHERE id = NEW.lot_id;

IF v_lot_status IN ('expired', 'recalled')
   OR v_lot_expiry < CURRENT_DATE      -- ADD THIS CONDITION
THEN
  RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
END IF;
```

This change closes the 9-hour window entirely without any cron dependency. The cron still runs to auto-update status (for the lot list UI), but the trigger is now the authoritative safety check independent of cron timing.

**Note on TOCTOU with concurrent sessions:** The concurrent-session TOCTOU is mitigated in practice by Postgres FK constraint on `lot_id` (which takes a shared lock) and by the fact that the `apply_movement_to_lot_qty` AFTER trigger fires in the same transaction and would catch any qty anomalies. However, the `expiry_date < CURRENT_DATE` check eliminates the most realistic attack vector (the 9-hour window) at no cost.

**Recommend:** BLOCK DEPLOY — add the `expiry_date < CURRENT_DATE` check to the trigger before implementing. Requires a one-line change to the decisions-locked doc (Q-Phase2-4) to note the trigger also checks `expiry_date` directly, and a corresponding change to Task A5 DDL.

---

### S-4

**Severity:** HIGH

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §5.4 + `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md` Task A5

**Issue:** The `apply_movement_to_lot_qty` trigger is declared `SECURITY DEFINER`. Its `SET search_path = public, pg_temp` is present (correct — prevents search_path hijacking). However, the function has **no GRANT restriction**. In Supabase, SECURITY DEFINER functions are owned by the migration-applier role (`postgres` or `supabase_admin`). Any `authenticated` user can call trigger functions indirectly by triggering the trigger (via INSERT on `stock_movements`). This is by design. The concern is whether the function can be called **directly** as an RPC.

Trigger functions (those that `RETURN trigger`) **cannot** be called directly via PostgREST's `/rpc/` endpoint — PostgREST only exposes functions with a non-trigger return type. So direct RPC call of `apply_movement_to_lot_qty()` or `check_lot_status()` is blocked at the PostgREST layer. This is correct.

However, the **blast radius** of `apply_movement_to_lot_qty` (SECURITY DEFINER, table-owner privileges) currently has access to: the entire `public` schema (all tables) because `SET search_path = public, pg_temp` without explicit `REVOKE` leaves the function able to query any table in `public`. The function only needs: `stock_lots` (to UPDATE `current_qty`). It incidentally has read/write access to every other table in `public` (including `settings`, `user_sessions`, `stock_movements`, etc.) through the SECURITY DEFINER context.

**Exploit / Failure scenario:**
If a future developer modifies this function body and introduces a SQL injection via `NEW.lot_id` (which is a uuid — low risk in practice) or adds logic that reads `settings`, there is no structural barrier. The principle of least privilege is violated: the function holds more privilege than its job requires.

**Mitigation:**
The correct long-term mitigation is to create a dedicated limited-privilege role for trigger functions. For Phase 2 at this scale, the practical mitigation is:

1. Document explicitly in the migration comment that `apply_movement_to_lot_qty` only reads/writes `stock_lots` and that future editors must not add access to other tables.
2. Add a verification SQL comment in the migration that asserts the function body has no references outside `stock_lots`.

Structural fix (deferred, Phase 3): create a `trigger_executor` role with `GRANT UPDATE (current_qty, status, updated_at, updated_by) ON stock_lots TO trigger_executor` and change `SECURITY DEFINER` to `SET ROLE trigger_executor` (Postgres 16+ SET ROLE in functions).

**Recommend:** ACCEPT RISK for Phase 2 with documentation. Add migration comment. Structural fix deferred to Phase 3 as a formal finding.

---

### S-5

**Severity:** MEDIUM

**Where:** `docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md` derived #11 + `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md` Task A3

**Issue:** The `fefo_override` column on `stock_movements` is set by the client when staff confirms the FEFO-override modal. The `sm_insert_staff` RLS policy allows Employee-role INSERT on `stock_movements` for `movement_type IN ('issue','adjustment_loss')`. There is **no check on the value of `fefo_override`** in any policy or trigger. An Employee (or attacker with Employee JWT) can POST `fefo_override=true` on any movement — including the first lot in FEFO order — without any modal confirmation having occurred, making the audit column unreliable.

**Exploit / Failure scenario:**
Compliance officer queries `SELECT count(*) FROM stock_movements WHERE fefo_override=true` to assess how often staff override FEFO. An attacker or a developer testing via DevTools posts `fefo_override=true` on routine FEFO-compliant movements, inflating the override count. Conversely, a staff member who genuinely overrides FEFO can POST `fefo_override=false` to hide the override. The column is client-controlled with no server-side validation.

**Mitigation:**
The correct enforcement is a DB trigger that computes whether the chosen `lot_id` is the FEFO lot (minimum `expiry_date` among `status='active'` lots for the item) and sets `fefo_override` server-side, overriding any client-supplied value. This trigger would be a BEFORE INSERT on `stock_movements`:

```sql
-- Pseudocode — in check_lot_status() or a separate trigger:
IF NEW.lot_id IS NOT NULL
   AND NEW.movement_type IN ('issue', 'adjustment_loss', 'borrow', 'transfer_out')
THEN
  SELECT id INTO v_fefo_lot_id
  FROM stock_lots
  WHERE item_id = NEW.item_id
    AND status = 'active'
    AND current_qty > 0
  ORDER BY expiry_date ASC NULLS LAST
  LIMIT 1;

  -- Overwrite client-supplied value with server-computed truth.
  NEW.fefo_override := (v_fefo_lot_id IS DISTINCT FROM NEW.lot_id);
END IF;
```

This can be added to the existing `check_lot_status()` BEFORE INSERT trigger (which already fetches the lot and item) with minimal overhead.

**Recommend:** FIX IN PLAN before implementation. Add the server-side `fefo_override` computation to `check_lot_status()`. This is a one-function change in Task A5 DDL. Without this, the audit column is worthless for compliance purposes.

---

### S-6

**Severity:** MEDIUM

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §5.5 (cron) + `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md` Task A8

**Issue:** The `run_expiry_alert()` cron function payload (sent to `tg-notify` via `pg_net`) includes the following fields per the spec and plan DDL:

```json
{
  "lot_id": "<uuid>",
  "lot_number": "<string>",
  "item_name": "<string>",
  "sku": "<string>",
  "expiry_date": "<date>",
  "current_qty": <int>,
  "unit": "<string>",
  "days_left": <int>
}
```

Under Thailand PDPA (Personal Data Protection Act BE 2562), operational medical supply data is not itself "personal data" unless it can identify a natural person. `lot_id`, `lot_number`, `item_name`, `sku`, `expiry_date`, `current_qty`, and `unit` do **not** identify a patient or employee. There is no patient ID, encounter ID, employee name, or biometric in this payload. The payload is non-PII / non-PHI under PDPA.

However, there is a secondary concern: the `run_expiry_alert()` function sends this payload to the Cloudflare Worker (`thegood-ocr-proxy`), which then posts to Telegram. Telegram messages are persistent and searchable within the group. If the Telegram group contains non-Thegood members (e.g., a shared notification channel), medication supply details (item names, quantities, expiry dates) could leak operational intelligence about Thegood's stock levels to competitors or suppliers.

**Mitigation:**
Confirm in deployment documentation that `NOTIFY_TELEGRAM_CHAT_ID` is set to a Thegood-only private group. No code change required.

**Recommend:** ACCEPT RISK — document the Telegram group access control requirement in `docs/env-setup.md` (add a line: "NOTIFY_TELEGRAM_CHAT_ID must be a private Thegood-only group; do not use a public channel"). No PHI/PII issue found.

---

### S-7

**Severity:** MEDIUM

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §5.1 (RLS, no DELETE policy) + spec §5.4 (auto-depletion trigger)

**Issue:** The spec and plan correctly state there is no DELETE policy on `stock_lots` (default deny). However, the `apply_movement_to_lot_qty` AFTER INSERT trigger, which runs as SECURITY DEFINER (table-owner privileges), **can** UPDATE `stock_lots.status` to `'depleted'`. There is no barrier preventing the SECURITY DEFINER context from also deleting rows (Postgres SECURITY DEFINER with table-owner gives full table access). The trigger function body itself only does UPDATE — but there is no structural constraint (e.g., a trigger `BEFORE DELETE ON stock_lots RAISE EXCEPTION`) that would block a future accidental DELETE in the SECURITY DEFINER context.

More concretely: `recalled` lots are blocked from deletion by the missing DELETE RLS policy — but the `run_expiry_alert()` cron function (also SECURITY DEFINER) could in theory be modified to delete lots rather than update them. There is no "immutability" trigger on `stock_lots` comparable to the no-DELETE policy on `stock_movements`.

**Exploit / Failure scenario:**
A developer future-modifying `run_expiry_alert()` accidentally writes `DELETE FROM stock_lots WHERE expiry_date < CURRENT_DATE` instead of `UPDATE SET status='expired'`. Because the function is SECURITY DEFINER, the DELETE succeeds. All expired lot audit records are destroyed, covering up any traceability for issued medications.

**Mitigation:**
Add a `BEFORE DELETE ON stock_lots` trigger that always raises an exception:

```sql
CREATE OR REPLACE FUNCTION prevent_lot_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_lots rows are immutable; use status=recalled or depleted instead of DELETE';
END;
$$;

CREATE TRIGGER trg_no_delete_lots
  BEFORE DELETE ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION prevent_lot_delete();
```

This mirrors the no-UPDATE/DELETE policy pattern on `stock_movements` but as a trigger (because SECURITY DEFINER functions bypass RLS). The trigger fires even in SECURITY DEFINER context.

**Recommend:** FIX IN PLAN — add `prevent_lot_delete` trigger to Task A2 (stock_lots table migration) or as a separate step in Task A4 (RLS migration). Small addition, closes a structural gap.

---

### S-8

**Severity:** MEDIUM

**Where:** `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md` Task A8 (CF Worker fallback path, Step CF-3)

**Issue:** The Cloudflare Worker fallback path for the `expiry-alert-daily` Edge Function hardcodes the Supabase project ref in the POST URL:
```
POST https://xtjsjrfixngfdkaahton.supabase.co/functions/v1/expiry-alert-daily
```
The project ref `xtjsjrfixngfdkaahton` is already public (in `shared/config.js` committed to the GitHub Pages repo — it is the Supabase project URL). This is not a new exposure. However, the CF Worker call also requires `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` and `apikey: <SUPABASE_SERVICE_ROLE_KEY>`. The plan instructs storing this in a Cloudflare Worker secret (Step CF-3: "Store `SUPABASE_SERVICE_ROLE_KEY` as a Cloudflare Worker secret (not in code)") — which is correct.

The residual risk is: the CF Worker also handles Telegram notification proxying for the HR System (`thegood-ocr-proxy`). Adding a cron trigger that carries the Stock project's service_role key to the same Worker expands the blast radius of a compromised Worker. If the Worker's secrets are leaked, both the Stock service_role key and (potentially) Telegram tokens are exposed.

**Mitigation:**
Deploy a separate Cloudflare Worker (`thegood-stock-cron`) for the Stock cron trigger rather than adding to the shared `thegood-ocr-proxy` Worker. The service_role key is then isolated to the Stock-only Worker. This is a deployment topology choice with no code change to the Edge Function.

**Recommend:** ACCEPT RISK for Phase 2 if PM prefers operational simplicity (single Worker). If the CF fallback path is used, document the isolation concern in `docs/env-setup.md` and flag it for Phase 3.

---

### S-9

**Severity:** MEDIUM

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §11 Q-Phase2-2 (Recall workflow) + `docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md` Q-Phase2-2

**Issue:** The recall workflow is a soft flag (`status='recalled'`). When a lot is recalled, existing movements issued before the recall are NOT retroactively flagged. The spec acknowledges this: "existing movements are not reversed." This is correct from an audit-trail perspective (movements are immutable). However, there is no mechanism in Phase 2 to:
1. Identify which patients/staff issued from a recalled lot (for recall notification or adverse event tracking).
2. Know the total quantity issued from a lot before recall (important for risk assessment).

The current data model supports the query `SELECT * FROM stock_movements WHERE lot_id = '<recalled_lot_id>' AND movement_type='issue'` — but only if someone runs it manually. There is no automated alert when a lot is recalled about how much was issued.

**Mitigation:**
Two mitigations (both are plan-level, not schema changes):

1. Add to the Admin recall confirm UI: a computed summary of "ล็อตนี้เคยเบิกไปแล้ว X หน่วย" (total issued from this lot) so the Admin can assess risk at recall time.
2. Document in `docs/test-checklist.md` (as a new compliance test) the SQL query for post-recall tracing:
   ```sql
   SELECT sm.performed_at, sm.performed_by, ABS(sm.qty_delta) AS qty_issued,
          sm.location_id
   FROM stock_movements sm
   WHERE sm.lot_id = '<recalled_lot_id>'
     AND sm.movement_type IN ('issue','adjustment_loss','borrow')
   ORDER BY sm.performed_at;
   ```

**Recommend:** FIX IN PLAN — add the issued-quantity summary to the recall modal (B-series task) and the SQL query to the test checklist (D-series task). No schema change needed; the data already exists.

---

### S-10

**Severity:** LOW

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §5.3 — `v_lots_with_remaining` view

**Issue:** The view `v_lots_with_remaining` is a plain SQL view with no security barrier (`SECURITY INVOKER`, the default). This means the view is executed with the caller's security context and their RLS policies apply. This is correct behaviour — the view reads `stock_lots` and `stock_items`, both of which have `FOR SELECT TO authenticated USING (true)` policies, so all authenticated users can see the view. There is no additional exposure. However, if either underlying table's SELECT policy is ever tightened (e.g., implementing the column-level restriction suggested in S-2), the view may break silently for some callers because views do not automatically inherit column grants.

**Mitigation:**
Add a comment to the view migration noting it is `SECURITY INVOKER` and that RLS on the underlying tables applies. When S-2 mitigation is implemented (column-level restrictions), re-test this view explicitly.

**Recommend:** ACCEPT RISK / INFO — no action needed in Phase 2. Document.

---

### S-11

**Severity:** LOW

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §5.1 RLS — `sl_update` policy

**Issue:** The `sl_update` policy is:
```sql
USING  (app_user_role() = 'Admin')
WITH CHECK (app_user_role() = 'Admin')
```
This allows an Admin to UPDATE any column of any `stock_lots` row, including changing `status` from `'recalled'` back to `'active'`, clearing `recalled_reason`, `recalled_by`, `recalled_at`, and even changing `received_qty` or `lot_number`. There is no audit trail for these Admin updates (unlike `stock_movements` which is immutable). An Admin could recall a lot, administer medication, then clear the recall status and recalled_reason — erasing the recall event.

**Mitigation:**
Add a `BEFORE UPDATE ON stock_lots` trigger that:
1. Prevents modification of `received_qty`, `lot_number`, and `item_id` once set (these are the audit-critical columns).
2. If changing from `recalled` back to `active`, requires `recalled_reason` and `recalled_at` to be preserved (not nulled out) — the reactivation is allowed but the recall record must remain.

```sql
-- Pseudocode:
IF OLD.lot_number IS DISTINCT FROM NEW.lot_number
   OR OLD.item_id IS DISTINCT FROM NEW.item_id
   OR OLD.received_qty IS DISTINCT FROM NEW.received_qty THEN
  RAISE EXCEPTION 'lot_number, item_id, and received_qty are immutable after creation';
END IF;
```

**Recommend:** FIX IN PLAN — add this immutability trigger to Task A2 (stock_lots table migration) or Task A4 (RLS). Critical audit field protection.

---

### S-12

**Severity:** LOW

**Where:** `docs/superpowers/plans/2026-05-19-phase2-medication-plan.md` Pre-implementation findings F7 (migration timestamp collision)

**Issue:** The plan author identified migration timestamp collision between Phase 1 (`20260519000000–20260519000700`) and the decisions-locked doc Phase 2 assignments. The plan resolves this by using `20260519010000–20260519010900`. This is a safe resolution, but if the Phase 2 migrations are applied before verifying PF-3 (Phase 1 migrations exist), there is a risk of ordering failure (Phase 2 table `stock_lots` references `stock_items` which requires Phase 1 to have run). This is a deployment risk, not a security risk per se — but if applied out of order, the FK constraints will fail and the migration will partially execute.

**Mitigation:**
The pre-flight checks PF-1 through PF-8 in the plan adequately guard this. Document in `docs/deploy.md` that Phase 2 migrations must only run after confirming PF-3.

**Recommend:** ACCEPT RISK — no code change. Document in deploy checklist.

---

### S-13

**Severity:** INFO

**Where:** `supabase/migrations/20260518000000_init.sql` — `app_user_role()` + `app_username()`

**Issue:** Both helper functions use `coalesce(auth.jwt() ->> '<claim>', '')`. If the JWT is absent (anon role), both return `''`. The RLS policies use `TO authenticated` at the policy role level, which means the anon role never reaches these policies. This is correct and safe — the anon role cannot authenticate to PostgREST without a JWT anyway. Confirmed: no `NULL`-role bypass exists.

**Recommend:** INFO — no action needed. Architecture is sound for the anon case.

---

### S-14

**Severity:** INFO

**Where:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` §5.4 — `apply_movement_to_lot_qty` negative qty guard timing

**Issue:** The AFTER INSERT trigger `apply_movement_to_lot_qty` checks for negative `current_qty` AFTER the UPDATE:
```sql
UPDATE stock_lots SET current_qty = current_qty + NEW.qty_delta ...
RETURNING current_qty INTO v_new_lot_qty;
IF v_new_lot_qty < 0 THEN RAISE EXCEPTION ...
```
The UPDATE runs first, then the check. If `qty_delta` is very negative (e.g., `-99999`), the UPDATE will attempt to set `current_qty` to a large negative number. The `CHECK (current_qty >= 0)` constraint on `stock_lots` will fire BEFORE the trigger's `IF v_new_lot_qty < 0` check, causing a constraint violation exception rather than the trigger's custom exception. The functional outcome (movement rejected) is correct, but the error message surfaced to the client will be Postgres's check constraint message rather than the trigger's informative message. This is a UX issue rather than a security issue.

**Recommend:** INFO — no security risk. Consider restructuring the trigger to read `current_qty` first and subtract, raising the custom exception before attempting the UPDATE, to get a cleaner error message. Low priority.

---

## Executive Summary

| ID | Severity | One-line description |
|----|----------|----------------------|
| S-1 | HIGH | `settings` table readable by all authenticated users — employees can retrieve `NOTIFY_SERVICE_ROLE_KEY` |
| S-2 | HIGH | `stock_lots` SELECT exposes recall audit columns to Employee role; accepted with documentation |
| S-3 | HIGH | `check_lot_status` trigger checks DB `status` only — 9-hour window where `expiry_date < today` lots are still issuable before cron runs |
| S-4 | HIGH | `apply_movement_to_lot_qty` SECURITY DEFINER has full `public` schema access; blast radius exceeds minimum needed |
| S-5 | MEDIUM | `fefo_override` is client-controlled with no server-side validation — audit column is unreliable |
| S-6 | MEDIUM | Telegram expiry payload is non-PII; secondary risk: Telegram group access control |
| S-7 | MEDIUM | No immutability trigger on `stock_lots` — SECURITY DEFINER context can DELETE rows, destroying audit trail |
| S-8 | MEDIUM | CF Worker fallback shares service_role key with HR notification proxy — blast-radius expansion |
| S-9 | MEDIUM | No automated tracing of issued quantity when a lot is recalled |
| S-10 | LOW | `v_lots_with_remaining` view may silently break if underlying table column grants are later tightened |
| S-11 | LOW | `sl_update` policy allows Admin to modify immutable audit columns (`received_qty`, `lot_number`) with no guard |
| S-12 | LOW | Migration timestamp collision risk if Phase 2 is applied without verifying Phase 1 completion |
| S-13 | INFO | `app_user_role()` returns `''` not NULL for missing JWT — no anon bypass; architecture confirmed sound |
| S-14 | INFO | Negative qty exception message will show constraint text rather than trigger custom message |

| Findings | Critical | High | Medium | Low | Info | Total |
|----------|----------|------|--------|-----|------|-------|
| Count    | 0        | 4    | 5      | 3   | 2    | **14** |

---

## Required Actions Before Any Phase 2 Code Lands

Listed in priority order:

1. **S-1 (HIGH) — settings RLS hotfix:** Add `is_secret` column to `settings`, restrict SELECT on `is_secret=true` rows to Admin only. This must be a standalone hotfix migration deployed to production BEFORE Phase 2 migrations. Current live exposure: any Employee can retrieve the service_role key.

2. **S-3 (HIGH) — trigger expiry_date check:** Add `OR v_lot_expiry < CURRENT_DATE` to `check_lot_status()`. Update decisions-locked doc Q-Phase2-4 to reflect this addition. Update Task A5 DDL. Without this, medications can be issued on their expiry date for up to 9 hours.

3. **S-5 (MEDIUM) — server-computed fefo_override:** Add server-side FEFO computation to `check_lot_status()` that overwrites the client-supplied `fefo_override` value. Update Task A5 DDL.

4. **S-7 (MEDIUM) — prevent_lot_delete trigger:** Add a BEFORE DELETE trigger on `stock_lots` that always raises an exception. Add to Task A2 or A4 DDL.

5. **S-11 (LOW) — lot_number/received_qty immutability trigger:** Add a BEFORE UPDATE trigger on `stock_lots` guarding `lot_number`, `item_id`, `received_qty`. Add to Task A2 or A4 DDL.

6. **S-9 (MEDIUM) — recall tracing:** Add issued-qty summary to recall confirm modal (Task B) and SQL query to test checklist (Task D).

---

## Single Most Important Mitigation for PM Approval

**S-1 is the single most important finding.** A live vulnerability (pre-Phase 2) allows any authenticated Employee to retrieve the `NOTIFY_SERVICE_ROLE_KEY` from the `settings` table, which grants full RLS-bypass access to every table in the project. Phase 2 makes this worse by adding a second consumer of this key (`run_expiry_alert`). The recommended one-migration fix (add `is_secret boolean`, update SELECT policy, mark the key row) is small, surgical, and can be deployed in under 5 minutes via the SQL Editor. PM must approve and deploy this hotfix before any Phase 2 work begins.

---

*Audit completed 2026-05-19. Next review triggered by: Phase 2 implementation complete (Task C1 test pass), or any change to `settings` RLS, trigger DDL, or CF Worker fallback.*
