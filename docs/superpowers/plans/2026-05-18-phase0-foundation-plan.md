# Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Thegood Stock foundation: new repo on GitHub Pages, new Supabase project with full schema and RLS, three Edge Functions for auth/sync/notify, admin + employee shells with Locations CRUD, Ambulances manual sync, Settings, and Sessions audit — wired end-to-end with GAS HR login and Telegram alerts.

**Architecture:** Static HTML/JS frontend hosted on GitHub Pages (`officethegood/thegood-stock`) talking to a new Supabase project (`thegood-stock`). Auth uses the existing Thegood HR GAS API; an Edge Function (`auth-bridge`) verifies credentials and issues a Supabase-signed JWT so RLS works natively. Ambulance data is pulled on demand from a Thegood Ambulance GAS endpoint via `sync-ambulances`. Telegram notifications go through the existing `thegood-ocr-proxy` Cloudflare Worker via `tg-notify`. Service Worker enables offline static caching only (no PWA install).

**Tech Stack:** Vanilla HTML/JS + Bootstrap 5 (no build), Supabase Postgres + Edge Functions (Deno TypeScript), Cloudinary (Phase 1+ uploads), Cloudflare Worker for Telegram fan-out, GitHub Pages for hosting.

**Testing approach (deviation from default TDD):** Spec decision Q16 chose manual checklist over unit tests for Phase 0. Each task ends with a concrete verification step (curl, SQL query, browser open, or T-numbered manual test from the spec) and a commit. Edge Function logic still gets a handful of Deno `assertEquals` sanity tests where pure (no side effects), but business workflows are verified via the T1–T23 checklist after deploy.

**Source of truth:** [`docs/superpowers/specs/2026-05-18-phase0-foundation-design.md`](../specs/2026-05-18-phase0-foundation-design.md)

---

## Reading order

This plan has 7 execution phases (A–G). Tasks within each phase are largely sequential. Phases C (Edge Functions) can begin once Phase B (Database) finishes; Phases D/E (Frontend) can begin in parallel once Phase C produces deployable endpoints, but the suggested order is A → B → C → D → E → F → G.

| Phase | Tasks | Focus |
|---|---|---|
| A | 1–4 | Project scaffold + tooling |
| B | 5–13 | Database migrations + push |
| C | 14–19 | Edge Functions + deploy |
| D | 20–28 | Shared frontend modules |
| E | 29–37 | Pages and admin tabs |
| F | 38–41 | Service Worker + Pages deploy |
| G | 42–46 | Manual test + docs |

---

# Phase A — Project Scaffold

## Task 1: Initialize repo skeleton and git

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\.gitignore`
- Create: `F:\@Coding\ระบบ\The Good Stock\README.md`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# OS / IDE
.DS_Store
Thumbs.db
.vscode/
.idea/

# Node (only used by Supabase CLI / tooling, no app deps)
node_modules/

# Supabase
.supabase/
supabase/.temp/
supabase/.branches/

# Local env / secrets
.env
.env.local
*.local.json

# Build artifacts (none expected — static site, but defensive)
dist/
build/
```

- [ ] **Step 2: Create `README.md`**

```markdown
# Thegood Stock

Mobile-first web app for managing medication, equipment, ALS bags, oxygen tanks, and linens at Thegood. Built on Supabase + GitHub Pages.

- **Status:** Phase 0 (Foundation) in progress
- **Spec:** `docs/superpowers/specs/2026-05-18-phase0-foundation-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-18-phase0-foundation-plan.md`
- **Live URL:** https://officethegood.github.io/thegood-stock/
- **Supabase project:** `thegood-stock` (ap-southeast-1)

## Quick start (developer)

1. Install Supabase CLI: https://supabase.com/docs/guides/cli
2. `supabase link --project-ref <ref>`
3. `supabase db push` to apply migrations
4. `supabase functions deploy <name>` for each function
5. Edit `shared/config.js` with the project URL + anon key
6. Push to `main` → GitHub Pages auto-deploys

See `docs/env-setup.md` and `docs/deploy.md`.
```

- [ ] **Step 3: Initialize git and make first commit**

```bash
cd "F:/@Coding/ระบบ/The Good Stock"
git init
git add .gitignore README.md
git commit -m "chore: initial repo scaffold"
```

Expected: `[main (root-commit) ...] chore: initial repo scaffold` with 2 files.

---

## Task 2: Create folder structure

**Files (directories only this task):**
- Create: `assets/icons/`, `shared/`, `js/`, `supabase/functions/`, `supabase/migrations/`, `sql/`, `tools/`, `docs/`

- [ ] **Step 1: Create directories**

```bash
cd "F:/@Coding/ระบบ/The Good Stock"
mkdir -p assets/icons shared js supabase/functions supabase/migrations sql tools docs
```

- [ ] **Step 2: Add `.gitkeep` to empty dirs that should exist**

```bash
touch assets/icons/.gitkeep tools/.gitkeep
```

- [ ] **Step 3: Verify and commit**

```bash
git add .
git commit -m "chore: create folder skeleton"
```

Expected: empty dirs tracked via `.gitkeep`.

---

## Task 3: Install Supabase CLI and link new project

**Prereq:** Supabase CLI installed (`scoop install supabase` on Windows, or download from https://github.com/supabase/cli/releases).

- [ ] **Step 1: Verify CLI**

```bash
supabase --version
```

Expected: version 1.x or 2.x.

- [ ] **Step 2: Create the Supabase project in dashboard**

Manual step:
1. Open https://supabase.com/dashboard
2. Org `officethegood` → New project
3. Name: `thegood-stock`
4. Region: `Southeast Asia (Singapore)` = `ap-southeast-1`
5. Database password: save in password manager
6. Wait for project to provision (~1 min)
7. Note the **Project ref** (URL-safe slug) and **anon key** from Settings → API

- [ ] **Step 3: Initialize Supabase config locally**

```bash
cd "F:/@Coding/ระบบ/The Good Stock"
supabase init
```

This creates `supabase/config.toml`. Open it and confirm `[functions.<name>]` blocks will live there later.

- [ ] **Step 4: Link to remote**

```bash
supabase link --project-ref <PROJECT_REF>
```

You'll be prompted for the DB password.

- [ ] **Step 5: Commit init artifacts**

```bash
git add supabase/config.toml
git commit -m "chore: supabase init and link"
```

---

## Task 4: Set Edge Function secrets

- [ ] **Step 1: Set GAS HR URL**

```bash
supabase secrets set GAS_HR_URL="https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec"
```

- [ ] **Step 2: Set JWT TTLs**

```bash
supabase secrets set JWT_ACCESS_TTL_SECONDS=28800
supabase secrets set JWT_REFRESH_TTL_SECONDS=2592000
```

- [ ] **Step 3: Set notify proxy URL**

```bash
supabase secrets set NOTIFY_PROXY_URL="https://thegood-ocr-proxy.officethegood.workers.dev"
```

- [ ] **Step 4: Verify**

```bash
supabase secrets list
```

Expected: lists `GAS_HR_URL`, `JWT_ACCESS_TTL_SECONDS`, `JWT_REFRESH_TTL_SECONDS`, `NOTIFY_PROXY_URL`. (Built-in `SUPABASE_*` secrets are also visible.)

No commit — secrets are remote-only.

---

# Phase B — Database Migrations

All migration files go under `supabase/migrations/` with the timestamp prefix shown.

## Task 5: Migration 1 — extensions and helpers

**Files:**
- Create: `supabase/migrations/20260518000000_init.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260518000000_init.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION app_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'user_role', '')
$$;

CREATE OR REPLACE FUNCTION app_username() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'username', '')
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260518000000_init.sql
git commit -m "feat(db): extensions and JWT/timestamp helpers"
```

---

## Task 6: Migration 2 — ambulances

**Files:**
- Create: `supabase/migrations/20260518000100_ambulances.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260518000100_ambulances.sql

CREATE TABLE ambulances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gas_id           text UNIQUE,
  plate            text NOT NULL,
  callsign         text,
  active           boolean DEFAULT true,
  raw              jsonb,
  last_synced_at   timestamptz DEFAULT now(),
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
CREATE INDEX idx_ambulances_plate ON ambulances(plate);
CREATE TRIGGER trg_ambulances_updated_at BEFORE UPDATE ON ambulances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260518000100_ambulances.sql
git commit -m "feat(db): ambulances table"
```

---

## Task 7: Migration 3 — locations

**Files:**
- Create: `supabase/migrations/20260518000200_locations.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260518000200_locations.sql

CREATE TYPE location_type AS ENUM ('room', 'cabinet', 'shelf', 'ambulance', 'bag');

CREATE TABLE locations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text UNIQUE NOT NULL,
  name             text NOT NULL,
  type             location_type NOT NULL,
  parent_id        uuid REFERENCES locations(id) ON DELETE RESTRICT,
  ambulance_id     uuid REFERENCES ambulances(id),
  qr_payload       text,
  active           boolean DEFAULT true,
  note             text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),

  CONSTRAINT chk_ambulance_link CHECK (
    (type = 'ambulance' AND ambulance_id IS NOT NULL) OR
    (type <> 'ambulance' AND ambulance_id IS NULL)
  )
);
CREATE INDEX idx_locations_parent ON locations(parent_id);
CREATE INDEX idx_locations_type   ON locations(type);
CREATE TRIGGER trg_locations_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260518000200_locations.sql
git commit -m "feat(db): locations table with multi-level hierarchy"
```

---

## Task 8: Migration 4 — settings + seed

**Files:**
- Create: `supabase/migrations/20260518000300_settings.sql`

- [ ] **Step 1: Write migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260518000300_settings.sql
git commit -m "feat(db): settings table with seed values"
```

---

## Task 9: Migration 5 — notification_log

**Files:**
- Create: `supabase/migrations/20260518000400_notification_log.sql`

- [ ] **Step 1: Write migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260518000400_notification_log.sql
git commit -m "feat(db): notification_log with dedupe and audit columns"
```

---

## Task 10: Migration 6 — user_sessions

**Files:**
- Create: `supabase/migrations/20260518000500_user_sessions.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260518000500_user_sessions.sql

CREATE TABLE user_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL,
  name                text,
  role                text NOT NULL,
  jwt_jti             text UNIQUE NOT NULL,
  refresh_token       text UNIQUE NOT NULL,
  issued_at           timestamptz DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  refresh_expires_at  timestamptz NOT NULL,
  revoked             boolean DEFAULT false,
  last_seen_at        timestamptz,
  ip                  inet,
  user_agent          text
);
CREATE INDEX idx_sessions_username ON user_sessions(username);
CREATE INDEX idx_sessions_refresh  ON user_sessions(refresh_token);
CREATE INDEX idx_sessions_expires  ON user_sessions(refresh_expires_at);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260518000500_user_sessions.sql
git commit -m "feat(db): user_sessions table for JWT/refresh tracking"
```

---

## Task 11: Migration 7 — RLS policies

**Files:**
- Create: `supabase/migrations/20260518000600_rls_policies.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260518000600_rls_policies.sql

ALTER TABLE locations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambulances        ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions     ENABLE ROW LEVEL SECURITY;

-- locations
CREATE POLICY loc_read  ON locations FOR SELECT TO authenticated USING (true);
CREATE POLICY loc_write ON locations FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- ambulances
CREATE POLICY amb_read  ON ambulances FOR SELECT TO authenticated USING (true);
CREATE POLICY amb_write ON ambulances FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- settings
CREATE POLICY set_read  ON settings FOR SELECT TO authenticated USING (true);
CREATE POLICY set_write ON settings FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- notification_log
CREATE POLICY nlog_read ON notification_log FOR SELECT TO authenticated USING (true);

-- user_sessions
CREATE POLICY sess_select ON user_sessions FOR SELECT TO authenticated
  USING (username = app_username() OR app_user_role() = 'Admin');
CREATE POLICY sess_revoke ON user_sessions FOR UPDATE TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260518000600_rls_policies.sql
git commit -m "feat(db): RLS policies for all tables"
```

---

## Task 12: Push migrations to remote

- [ ] **Step 1: Push**

```bash
cd "F:/@Coding/ระบบ/The Good Stock"
supabase db push
```

Expected: each migration applies in order, no errors. Final line: `Finished supabase db push.`

- [ ] **Step 2: Verify in dashboard**

Manual: open Supabase dashboard → `thegood-stock` → Table Editor. Should see `ambulances`, `locations`, `settings`, `notification_log`, `user_sessions`.

- [ ] **Step 3: Verify seed**

In dashboard SQL editor:

```sql
SELECT key, value FROM settings ORDER BY key;
```

Expected: 7 rows including `NOTIFY_TELEGRAM_ENABLED=false`, `EXPIRY_ALERT_DAYS=30,60,90`, etc.

---

## Task 13: Take a baseline DB snapshot

Per spec Q17, snapshot before adding more state.

- [ ] **Step 1: Dump**

```bash
mkdir -p tools/snapshots
supabase db dump --schema public > tools/snapshots/baseline-phase0.sql
```

- [ ] **Step 2: Commit snapshot**

```bash
git add tools/snapshots/baseline-phase0.sql
git commit -m "chore(db): baseline snapshot after Phase 0 migrations"
```

---

# Phase C — Edge Functions

## Task 14: auth-bridge Edge Function

**Files:**
- Create: `supabase/functions/auth-bridge/index.ts`
- Create: `supabase/functions/auth-bridge/deno.json`

- [ ] **Step 1: Write `deno.json`**

```json
{
  "imports": {
    "std/": "https://deno.land/std@0.224.0/",
    "djwt": "https://deno.land/x/djwt@v3.0.2/mod.ts",
    "supabase": "https://esm.sh/@supabase/supabase-js@2.45.0"
  }
}
```

- [ ] **Step 2: Write `index.ts`**

```typescript
// supabase/functions/auth-bridge/index.ts
//
// POST { action: 'login' | 'refresh' | 'logout' | 'verify', ... }

import { create, verify, getNumericDate } from 'djwt';
import { createClient } from 'supabase';

const JWT_SECRET           = Deno.env.get('SUPABASE_JWT_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GAS_HR_URL           = Deno.env.get('GAS_HR_URL')!;
const ACCESS_TTL           = Number(Deno.env.get('JWT_ACCESS_TTL_SECONDS')  ?? 28800);
const REFRESH_TTL          = Number(Deno.env.get('JWT_REFRESH_TTL_SECONDS') ?? 2592000);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// HS256 key import
async function getJwtKey(): Promise<CryptoKey> {
  const enc = new TextEncoder().encode(JWT_SECRET);
  return await crypto.subtle.importKey(
    'raw', enc, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function uuid(): string {
  return crypto.randomUUID();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

async function signAccessToken(opts: {
  username: string; name: string; user_role: string; jti: string;
}): Promise<{ token: string; exp: number }> {
  const key = await getJwtKey();
  const exp = getNumericDate(ACCESS_TTL);
  const iat = getNumericDate(0);
  const token = await create(
    { alg: 'HS256', typ: 'JWT' },
    {
      iss: 'thegood-stock',
      aud: 'authenticated',
      sub: opts.username,
      role: 'authenticated',
      user_role: opts.user_role,
      name: opts.name,
      username: opts.username,
      jti: opts.jti,
      iat,
      exp,
    },
    key
  );
  return { token, exp };
}

async function handleLogin(req: Request, body: any): Promise<Response> {
  const { username, password } = body;
  if (!username || !password) return json({ error: 'missing_fields' }, 400);

  // Call GAS HR
  let gasResp: any;
  try {
    const r = await fetch(GAS_HR_URL, {
      method:  'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body:    JSON.stringify({ username, password }),
      redirect: 'follow',
    });
    if (!r.ok) return json({ error: 'gas_unreachable', upstream_status: r.status }, 502);
    gasResp = await r.json();
  } catch (e) {
    return json({ error: 'gas_unreachable', detail: String(e) }, 502);
  }

  if (gasResp?.status !== 'success') {
    // Distinguish wrong pwd vs inactive
    const msg = String(gasResp?.message ?? '');
    if (msg.includes('สิทธิ์'))   return json({ error: 'account_inactive' }, 403);
    return json({ error: 'invalid_credentials' }, 401);
  }

  const name      = gasResp.name ?? username;
  const user_role = gasResp.role ?? 'Employee';
  const jti       = uuid();

  const { token, exp } = await signAccessToken({ username, name, user_role, jti });
  const refreshToken  = uuid();
  const refreshExp    = new Date(Date.now() + REFRESH_TTL * 1000).toISOString();
  const accessExp     = new Date(exp * 1000).toISOString();

  const ip   = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const ua   = req.headers.get('user-agent') || null;

  const { error } = await sb.from('user_sessions').insert({
    username, name, role: user_role,
    jwt_jti: jti,
    refresh_token: refreshToken,
    expires_at: accessExp,
    refresh_expires_at: refreshExp,
    ip, user_agent: ua,
    last_seen_at: new Date().toISOString(),
  });
  if (error) return json({ error: 'session_persist_failed', detail: error.message }, 500);

  return json({
    access_token:  token,
    refresh_token: refreshToken,
    name,
    user_role,
    username,
    expires_at:    accessExp,
  });
}

async function handleRefresh(_req: Request, body: any): Promise<Response> {
  const { refresh_token } = body;
  if (!refresh_token) return json({ error: 'missing_fields' }, 400);

  const { data: row } = await sb
    .from('user_sessions')
    .select('*')
    .eq('refresh_token', refresh_token)
    .eq('revoked', false)
    .gt('refresh_expires_at', new Date().toISOString())
    .maybeSingle();

  if (!row) return json({ error: 'invalid_refresh' }, 401);

  const jti = uuid();
  const { token, exp } = await signAccessToken({
    username: row.username, name: row.name, user_role: row.role, jti,
  });
  const newRefresh   = uuid();
  const refreshExp   = new Date(Date.now() + REFRESH_TTL * 1000).toISOString();
  const accessExp    = new Date(exp * 1000).toISOString();

  await sb.from('user_sessions').update({
    jwt_jti: jti,
    refresh_token: newRefresh,
    expires_at: accessExp,
    refresh_expires_at: refreshExp,
    last_seen_at: new Date().toISOString(),
  }).eq('id', row.id);

  return json({
    access_token:  token,
    refresh_token: newRefresh,
    expires_at:    accessExp,
  });
}

async function handleLogout(_req: Request, body: any): Promise<Response> {
  const { refresh_token } = body;
  if (!refresh_token) return json({ ok: true });   // silent ok
  await sb.from('user_sessions').update({ revoked: true }).eq('refresh_token', refresh_token);
  return json({ ok: true });
}

async function handleVerify(_req: Request, body: any): Promise<Response> {
  const { access_token } = body;
  if (!access_token) return json({ valid: false, reason: 'missing_token' }, 401);
  try {
    const key = await getJwtKey();
    const payload: any = await verify(access_token, key);
    // Check session not revoked
    const { data: sess } = await sb
      .from('user_sessions')
      .select('revoked')
      .eq('jwt_jti', payload.jti)
      .maybeSingle();
    if (!sess || sess.revoked) return json({ valid: false, reason: 'revoked' }, 401);

    return json({
      valid:     true,
      username:  payload.username,
      user_role: payload.user_role,
      name:      payload.name,
      jti:       payload.jti,
    });
  } catch (e) {
    return json({ valid: false, reason: 'invalid_signature_or_expired' }, 401);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  switch (body?.action) {
    case 'login':   return await handleLogin(req, body);
    case 'refresh': return await handleRefresh(req, body);
    case 'logout':  return await handleLogout(req, body);
    case 'verify':  return await handleVerify(req, body);
    default:        return json({ error: 'unknown_action' }, 400);
  }
});
```

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy auth-bridge
```

Expected: `Deployed Function auth-bridge to ...`

- [ ] **Step 4: Smoke test — missing fields**

Replace `<PROJECT_REF>` and `<ANON_KEY>` below:

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/auth-bridge" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: `HTTP/2 400` body `{"error":"unknown_action"}`.

- [ ] **Step 5: Smoke test — invalid login**

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/auth-bridge" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"action":"login","username":"nobody","password":"wrong"}'
```

Expected: `HTTP/2 401` body `{"error":"invalid_credentials"}`.

- [ ] **Step 6: Smoke test — valid login (use a real HR account)**

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/auth-bridge" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"action":"login","username":"<real_user>","password":"<real_pwd>"}'
```

Expected: `HTTP/2 200` body with `access_token`, `refresh_token`, `name`, `user_role`. Save `access_token` for the next smoke tests.

- [ ] **Step 7: Verify session row exists**

In Supabase SQL editor:

```sql
SELECT username, role, expires_at, refresh_expires_at, revoked
FROM user_sessions
ORDER BY issued_at DESC LIMIT 1;
```

Expected: row matches the user just logged in.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/auth-bridge
git commit -m "feat(fn): auth-bridge with login/refresh/logout/verify"
```

---

## Task 15: sync-ambulances Edge Function

**Files:**
- Create: `supabase/functions/sync-ambulances/index.ts`
- Create: `supabase/functions/sync-ambulances/deno.json`

- [ ] **Step 1: Write `deno.json`**

```json
{
  "imports": {
    "djwt": "https://deno.land/x/djwt@v3.0.2/mod.ts",
    "supabase": "https://esm.sh/@supabase/supabase-js@2.45.0"
  }
}
```

- [ ] **Step 2: Write `index.ts`**

```typescript
// supabase/functions/sync-ambulances/index.ts
// POST (no body). Admin JWT required.

import { verify } from 'djwt';
import { createClient } from 'supabase';

const JWT_SECRET       = Deno.env.get('SUPABASE_JWT_SECRET')!;
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

async function requireAdminJWT(req: Request): Promise<{ ok: true; payload: any } | { ok: false; resp: Response }> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, resp: json({ error: 'unauthorized' }, 401) };
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const payload: any = await verify(token, key);
    if (payload.user_role !== 'Admin') {
      return { ok: false, resp: json({ error: 'forbidden_not_admin' }, 403) };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, resp: json({ error: 'unauthorized' }, 401) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  const auth = await requireAdminJWT(req);
  if (!auth.ok) return auth.resp;

  const t0 = Date.now();

  // Read AMBULANCE_GAS_URL from settings
  const { data: setting } = await sb.from('settings').select('value').eq('key', 'AMBULANCE_GAS_URL').maybeSingle();
  const url = setting?.value;
  if (!url) return json({ error: 'ambulance_gas_url_not_set' }, 400);

  // Fetch ambulance list
  let list: any[];
  try {
    const r = await fetch(`${url}?action=listAmbulances`, { method: 'GET', redirect: 'follow' });
    if (!r.ok) return json({ error: 'gas_unreachable', upstream_status: r.status }, 502);
    const data = await r.json();
    if (!Array.isArray(data)) return json({ error: 'parse_error', detail: 'expected array' }, 502);
    list = data;
  } catch (e) {
    return json({ error: 'gas_unreachable', detail: String(e) }, 502);
  }

  // Safety: do not mass-deactivate on empty response
  if (list.length === 0) return json({ error: 'empty_response' }, 500);

  // Normalize rows
  const rows = list.map((it) => ({
    gas_id:         String(it.id ?? it.ambulance_id ?? it.gas_id ?? ''),
    plate:          String(it.plate ?? it.license ?? it.tabian ?? '').trim(),
    callsign:       it.callsign ?? it.call_sign ?? null,
    active:         true,
    raw:            it,
    last_synced_at: new Date().toISOString(),
  })).filter((r) => r.gas_id && r.plate);

  if (rows.length === 0) return json({ error: 'no_valid_rows', detail: 'every row missing gas_id or plate' }, 500);

  const incomingIds = rows.map((r) => r.gas_id);

  // Upsert
  const { error: upErr, count: upCount } = await sb
    .from('ambulances')
    .upsert(rows, { onConflict: 'gas_id', count: 'exact' });
  if (upErr) return json({ error: 'upsert_failed', detail: upErr.message }, 500);

  // Deactivate missing
  const { error: deErr, count: deCount } = await sb
    .from('ambulances')
    .update({ active: false, last_synced_at: new Date().toISOString() })
    .not('gas_id', 'in', `(${incomingIds.map((id) => `"${id}"`).join(',')})`)
    .eq('active', true);

  const duration_ms = Date.now() - t0;
  return json({
    ok: true,
    fetched:        list.length,
    upserted:       upCount ?? rows.length,
    deactivated:    deCount ?? 0,
    duration_ms,
    last_synced_at: new Date().toISOString(),
  });
});
```

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy sync-ambulances
```

- [ ] **Step 4: Smoke test — no JWT**

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/sync-ambulances" \
  -H "Authorization: Bearer <ANON_KEY>"
```

Expected: `HTTP/2 401` `{"error":"unauthorized"}`.

- [ ] **Step 5: Smoke test — Admin JWT but URL not set**

Set AMBULANCE_GAS_URL=empty in `settings` first, then call with an Admin access_token saved from Task 14 Step 6:

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/sync-ambulances" \
  -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>"
```

Expected: `HTTP/2 400` `{"error":"ambulance_gas_url_not_set"}`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/sync-ambulances
git commit -m "feat(fn): sync-ambulances admin-only manual sync"
```

The full happy-path smoke test runs after the GAS owner adds `doGet` (Task 17 docs hand-off + Task 44 manual test T16).

---

## Task 16: tg-notify Edge Function

**Files:**
- Create: `supabase/functions/tg-notify/index.ts`
- Create: `supabase/functions/tg-notify/deno.json`

- [ ] **Step 1: Write `deno.json`**

```json
{
  "imports": {
    "djwt": "https://deno.land/x/djwt@v3.0.2/mod.ts",
    "supabase": "https://esm.sh/@supabase/supabase-js@2.45.0"
  }
}
```

- [ ] **Step 2: Write `index.ts`**

```typescript
// supabase/functions/tg-notify/index.ts
// POST { event_type, entity_type?, entity_id?, dedupe_key, message, payload? }
// Auth: Admin JWT OR (service_role + X-Internal: true)

import { verify } from 'djwt';
import { createClient } from 'supabase';

const JWT_SECRET       = Deno.env.get('SUPABASE_JWT_SECRET')!;
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const NOTIFY_PROXY     = Deno.env.get('NOTIFY_PROXY_URL')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-internal',
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

async function isAuthorized(req: Request): Promise<boolean> {
  const internal = req.headers.get('x-internal') === 'true';
  const auth     = req.headers.get('authorization') || '';
  const token    = auth.replace(/^Bearer\s+/i, '');

  if (internal && token === SERVICE_ROLE_KEY) return true;

  // Else require Admin JWT
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const payload: any = await verify(token, key);
    return payload.user_role === 'Admin';
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  if (!(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const { event_type, entity_type, entity_id, dedupe_key, message, payload } = body;
  if (!event_type || !dedupe_key || !message) return json({ error: 'missing_fields' }, 400);

  // Check enabled
  const { data: enabledRow } = await sb.from('settings').select('value').eq('key', 'NOTIFY_TELEGRAM_ENABLED').maybeSingle();
  if (enabledRow?.value !== 'true') return json({ ok: true, sent: false, reason: 'disabled' });

  // Dedupe window
  const { data: windowRow } = await sb.from('settings').select('value').eq('key', 'LOW_STOCK_DEDUPE_HOURS').maybeSingle();
  const hours = Number(windowRow?.value ?? 24);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const { data: existing } = await sb
    .from('notification_log')
    .select('id')
    .eq('dedupe_key', dedupe_key)
    .gt('sent_at', since)
    .limit(1);

  if (existing && existing.length > 0) return json({ ok: true, sent: false, dedupe_hit: true });

  // Send via Cloudflare Worker
  let success = true; let errMsg: string | null = null;
  try {
    const r = await fetch(`${NOTIFY_PROXY}/notify/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        case_id:    entity_id ?? dedupe_key,
        alert_type: event_type,
        message,
        deep_link:  '',
      }),
    });
    if (!r.ok) { success = false; errMsg = `worker_${r.status}`; }
  } catch (e) {
    success = false; errMsg = String(e);
  }

  // Log
  const { data: logRow } = await sb.from('notification_log').insert({
    event_type, entity_type, entity_id, dedupe_key,
    channel: 'telegram', message, payload,
    success, error: errMsg,
  }).select('id').single();

  return json({ ok: true, sent: success, dedupe_hit: false, log_id: logRow?.id, error: errMsg });
});
```

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy tg-notify
```

- [ ] **Step 4: Smoke test — no auth**

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/tg-notify" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"manual","dedupe_key":"x","message":"y"}'
```

Expected: `HTTP/2 401`.

- [ ] **Step 5: Smoke test — Admin JWT, Telegram disabled**

Settings has `NOTIFY_TELEGRAM_ENABLED=false` by seed.

```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/tg-notify" \
  -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"manual","dedupe_key":"test-1","message":"hi"}'
```

Expected: `HTTP/2 200` `{"ok":true,"sent":false,"reason":"disabled"}`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/tg-notify
git commit -m "feat(fn): tg-notify with dedupe and Worker proxy"
```

---

## Task 17: Document GAS Ambulance `doGet` snippet

**Files:**
- Create: `docs/gas-ambulance-doget-snippet.md`

- [ ] **Step 1: Write doc**

```markdown
# Ambulance GAS — Add JSON list endpoint

The Stock app's `sync-ambulances` Edge Function expects the Ambulance GAS web app at

```
https://script.google.com/macros/s/AKfycbwefEV0CebLwA-BUKfg1hwwMcpu_0AS33YIFV3P3qU6AZilKZy9FbHZs51xu5vu1mFH/exec
```

to respond to `GET ?action=listAmbulances` with a JSON array of ambulance rows.

## Snippet to add

Open the Ambulance GAS project, add or extend `doGet(e)` in `Code.gs`:

```javascript
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'listAmbulances') {
    // Replace with the actual spreadsheet id and sheet name used by the Ambulance system
    const SHEET_ID   = 'PASTE_AMBULANCE_SPREADSHEET_ID_HERE';
    const SHEET_NAME = 'PASTE_AMBULANCE_SHEET_NAME_HERE';

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const rows  = sheet.getDataRange().getValues();
    const headers = rows[0];
    const data = rows.slice(1).map(function(r) {
      const obj = {};
      headers.forEach(function(h, i) { obj[h] = r[i]; });
      return obj;
    });

    return ContentService
             .createTextOutput(JSON.stringify(data))
             .setMimeType(ContentService.MimeType.JSON);
  }

  // Fallback to existing dashboard HTML output
  return HtmlService.createHtmlOutputFromFile('Index');
}
```

## Required fields in each row

The Stock `sync-ambulances` function looks for these keys (case-sensitive — match your headers):

- `id` or `ambulance_id` or `gas_id` — unique per ambulance
- `plate` or `license` or `tabian` — ทะเบียนรถ
- `callsign` or `call_sign` — optional

Other fields are stored verbatim in `ambulances.raw` jsonb.

## Deploy

After saving, **Manage Deployments → Edit → New version → Deploy**. The URL must stay the same (`/exec`).

## Verify

```bash
curl -L 'https://script.google.com/macros/s/AKfycbwefEV0CebLwA-BUKfg1hwwMcpu_0AS33YIFV3P3qU6AZilKZy9FbHZs51xu5vu1mFH/exec?action=listAmbulances'
```

Expected: `[{...}, {...}]` — JSON array, not HTML.

Once verified, paste the same URL into Stock's Settings → AMBULANCE_GAS_URL.
```

- [ ] **Step 2: Commit**

```bash
git add docs/gas-ambulance-doget-snippet.md
git commit -m "docs: GAS doGet snippet for ambulance list endpoint"
```

The owner of the Ambulance GAS applies this manually; no automated step.

---

## Task 18: Verify Cloudflare Worker `/notify/send` contract

This is a discovery task — confirm the worker's payload shape before T19 manual test.

- [ ] **Step 1: Call worker health**

```bash
curl -i 'https://thegood-ocr-proxy.officethegood.workers.dev/notify/health'
```

Expected: `{ok:true, hasTelegram:true, ...}` (per `shared/notify.js` reference in V.5).

- [ ] **Step 2: Test send with a known chat_id**

Get the Stock-dedicated Telegram chat_id from the owner. Then:

```bash
curl -i -X POST 'https://thegood-ocr-proxy.officethegood.workers.dev/notify/send' \
  -H 'Content-Type: application/json' \
  -d '{"case_id":"test","alert_type":"manual","message":"smoke test from Stock setup","deep_link":""}'
```

Expected: `HTTP/2 200` and the message arrives in the configured Telegram chat.

If the worker requires chat_id in the request body (and not just in worker env), update `tg-notify/index.ts` to read `NOTIFY_TELEGRAM_CHAT_ID` from settings and include it in the POST. Commit any change.

- [ ] **Step 3 (only if change made): Commit**

```bash
git add supabase/functions/tg-notify/index.ts
git commit -m "fix(fn): include chat_id in Worker payload"
supabase functions deploy tg-notify
```

If no change needed, no commit.

---

## Task 19: Bootstrap Cron and Realtime configuration placeholders

These are Phase 1+ activations; we add config rows now so later migrations don't have to backfill.

- [ ] **Step 1: Verify pg_net is on**

In Supabase SQL editor:

```sql
SELECT extname FROM pg_extension WHERE extname IN ('pg_net', 'pgcrypto');
```

Expected: 2 rows. If `pg_net` is missing, run `CREATE EXTENSION pg_net;`.

- [ ] **Step 2: Confirm Realtime is enabled (project level)**

Dashboard → Database → Replication → make sure the `supabase_realtime` publication exists. Phase 0 adds no tables to it; Phase 1+ migrations will `ALTER PUBLICATION supabase_realtime ADD TABLE ...`.

- [ ] **Step 3: No commit needed.**

---

# Phase D — Shared Frontend Modules

These files are **standalone in the Stock repo** — do NOT network-import from the pt-medical V.5 repo. Spec section 4 calls this out: copy + adapt.

## Task 20: shared/styles.css

**Files:**
- Create: `shared/styles.css`

- [ ] **Step 1: Copy base from V.5**

Source: `F:/@Coding/ระบบ/The Good System V.5/shared/styles.css`. Copy the whole file to `F:/@Coding/ระบบ/The Good Stock/shared/styles.css`.

```bash
cp "F:/@Coding/ระบบ/The Good System V.5/shared/styles.css" "F:/@Coding/ระบบ/The Good Stock/shared/styles.css"
```

- [ ] **Step 2: Override accent to teal**

Append to the bottom of `shared/styles.css`:

```css
/* =============================================
   Thegood Stock — Teal accent override
   ============================================= */
:root {
  --stock-accent:        #0d9488;   /* teal-600 */
  --stock-accent-dark:   #0f766e;   /* teal-700 */
  --stock-accent-light:  #14b8a6;   /* teal-500 */
  --stock-accent-subtle: #ccfbf1;   /* teal-100 */
}

.btn-stock-primary {
  background-color: var(--stock-accent);
  border-color:     var(--stock-accent);
  color: #fff;
}
.btn-stock-primary:hover,
.btn-stock-primary:focus {
  background-color: var(--stock-accent-dark);
  border-color:     var(--stock-accent-dark);
  color: #fff;
}
.nav-link.active.stock-tab {
  background-color: var(--stock-accent-subtle) !important;
  color: var(--stock-accent-dark) !important;
  font-weight: 600;
}
.text-stock-accent { color: var(--stock-accent) !important; }
.border-stock-accent { border-color: var(--stock-accent) !important; }

/* Hide module-toggle (V.5 had multi-system nav; Stock is standalone) */
.system-toggle { display: none !important; }
```

- [ ] **Step 3: Commit**

```bash
git add shared/styles.css
git commit -m "feat(ui): copy V.5 styles + teal Stock accent"
```

---

## Task 21: shared/config.js

**Files:**
- Create: `shared/config.js`

- [ ] **Step 1: Write file**

Replace `<PROJECT_REF>` and `<ANON_KEY>` with values from the new `thegood-stock` Supabase project.

```javascript
// shared/config.js
// Thegood Stock — Configuration

window.APP_VERSION      = '0.1.0';
window.APP_VERSION_DATE = '2026-05-18';

const CONFIG = {
  // ===== Required (bootstrap) =====
  SUPABASE_URL:     'https://<PROJECT_REF>.supabase.co',
  SUPABASE_ANON_KEY:'<ANON_KEY>',
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
```

- [ ] **Step 2: Commit**

```bash
git add shared/config.js
git commit -m "feat(ui): config with new Supabase project + Stock endpoints"
```

---

## Task 22: shared/supabase-client.js

**Files:**
- Create: `shared/supabase-client.js`

- [ ] **Step 1: Write file**

```javascript
// shared/supabase-client.js
// Requires: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//           and shared/config.js loaded first.

(function() {
  let _sbClient = null;
  let _currentToken = null;

  function createOrUpdate(accessToken) {
    if (accessToken === _currentToken && _sbClient) return _sbClient;
    _currentToken = accessToken || null;

    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

    _sbClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      global: { headers },
      auth:   { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });

    return _sbClient;
  }

  function getSupabaseClient() {
    if (!_sbClient) createOrUpdate(_currentToken);
    return _sbClient;
  }

  window.createOrUpdateSupabaseClient = createOrUpdate;
  window.getSupabaseClient             = getSupabaseClient;
})();
```

- [ ] **Step 2: Commit**

```bash
git add shared/supabase-client.js
git commit -m "feat(ui): supabase client factory with JWT header injection"
```

---

## Task 23: shared/auth.js

**Files:**
- Create: `shared/auth.js`

- [ ] **Step 1: Write file**

```javascript
// shared/auth.js
// User metadata helpers + login form glue.
// Requires: config.js, supabase-client.js, auth-jwt.js

(function () {
  // ===== localStorage keys =====
  const K_META    = 'pt_user_meta';
  const K_ACCESS  = 'stock_access_token';
  const K_REFRESH = 'stock_refresh_token';
  const K_EXP     = 'stock_token_exp';

  // ===== Session helpers =====
  function getUserMeta() {
    try { return JSON.parse(localStorage.getItem(K_META) || 'null'); }
    catch { return null; }
  }
  function setUserMeta(meta)   { localStorage.setItem(K_META, JSON.stringify(meta)); }
  function clearAllAuth()      {
    localStorage.removeItem(K_META);
    localStorage.removeItem(K_ACCESS);
    localStorage.removeItem(K_REFRESH);
    localStorage.removeItem(K_EXP);
  }

  function isLoggedIn()        { return !!localStorage.getItem(K_ACCESS); }
  function getUserRole()       { return getUserMeta()?.role     || 'Employee'; }
  function getUserName()       { return getUserMeta()?.name     || 'Unknown'; }
  function getUserUsername()   { return getUserMeta()?.username || ''; }

  // ===== Login form glue =====
  async function handleLogin(e) {
    if (e && e.preventDefault) e.preventDefault();

    const userEl = document.getElementById('login-user');
    const passEl = document.getElementById('login-pass');
    const errEl  = document.getElementById('login-error');
    const btn    = document.getElementById('btn-login');

    const username = (userEl?.value || '').trim();
    const password = passEl?.value || '';

    if (!username || !password) {
      if (errEl) { errEl.textContent = 'กรุณากรอก Username และ Password'; errEl.classList.remove('d-none'); }
      return;
    }
    if (errEl) { errEl.classList.add('d-none'); errEl.textContent = ''; }
    if (btn)   { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังเข้าสู่ระบบ...'; }

    try {
      const url = CONFIG.SUPABASE_URL + CONFIG.EDGE_AUTH_BRIDGE;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action: 'login', username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        const msg = data?.error === 'invalid_credentials' ? 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง'
                  : data?.error === 'account_inactive'    ? 'ท่านไม่มีสิทธิ์เข้าถึงข้อมูลเหล่านี้ได้'
                  : data?.error === 'gas_unreachable'     ? 'ระบบ HR ตอบสนองช้า กรุณาลองใหม่'
                  : 'เข้าสู่ระบบไม่สำเร็จ';
        throw new Error(msg);
      }

      // Store
      setUserMeta({ name: data.name, role: data.user_role, username: data.username });
      localStorage.setItem(K_ACCESS,  data.access_token);
      localStorage.setItem(K_REFRESH, data.refresh_token);
      localStorage.setItem(K_EXP,     data.expires_at);

      // Initialize client with new token
      window.createOrUpdateSupabaseClient(data.access_token);

      // Schedule refresh
      if (window.scheduleTokenRefresh) window.scheduleTokenRefresh();

      // Redirect
      window.location.replace('./index.html');
    } catch (err) {
      if (errEl) { errEl.textContent = err.message || 'เข้าสู่ระบบไม่สำเร็จ'; errEl.classList.remove('d-none'); }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = 'เข้าสู่ระบบ (Login)'; }
    }
  }

  async function handleLogout() {
    const refresh = localStorage.getItem(K_REFRESH);
    try {
      await fetch(CONFIG.SUPABASE_URL + CONFIG.EDGE_AUTH_BRIDGE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action: 'logout', refresh_token: refresh }),
      });
    } catch { /* silent */ }
    clearAllAuth();
    window.location.replace('./login.html');
  }

  // Redirect to /403 on role mismatch. Returns true if OK to proceed.
  function requireRole(role) {
    if (getUserRole() !== role) {
      window.location.replace('./403.html');
      return false;
    }
    return true;
  }

  // Public API
  window.getUserMeta     = getUserMeta;
  window.isLoggedIn      = isLoggedIn;
  window.getUserRole     = getUserRole;
  window.getUserName     = getUserName;
  window.getUserUsername = getUserUsername;
  window.handleLogin     = handleLogin;
  window.handleLogout    = handleLogout;
  window.requireRole     = requireRole;
  window.__authKeys      = { K_META, K_ACCESS, K_REFRESH, K_EXP };
})();
```

- [ ] **Step 2: Commit**

```bash
git add shared/auth.js
git commit -m "feat(ui): auth.js — login/logout glue + meta helpers"
```

---

## Task 24: shared/auth-jwt.js

**Files:**
- Create: `shared/auth-jwt.js`

- [ ] **Step 1: Write file**

```javascript
// shared/auth-jwt.js
// JWT lifecycle: refresh timer, ensureLoggedIn boot.
// Requires: config.js, supabase-client.js, auth.js

(function () {
  const { K_ACCESS, K_REFRESH, K_EXP } = window.__authKeys;
  let _refreshTimer = null;

  function getAccessToken()  { return localStorage.getItem(K_ACCESS);  }
  function getRefreshToken() { return localStorage.getItem(K_REFRESH); }
  function getExpiresAt()    { return localStorage.getItem(K_EXP);     }

  function msUntilExpiry() {
    const exp = getExpiresAt();
    if (!exp) return -1;
    return new Date(exp).getTime() - Date.now();
  }
  function isExpired() { return msUntilExpiry() <= 0; }

  async function refreshAccessToken() {
    const refresh = getRefreshToken();
    if (!refresh) return false;
    try {
      const url = CONFIG.SUPABASE_URL + CONFIG.EDGE_AUTH_BRIDGE;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action: 'refresh', refresh_token: refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      localStorage.setItem(K_ACCESS,  data.access_token);
      localStorage.setItem(K_REFRESH, data.refresh_token);
      localStorage.setItem(K_EXP,     data.expires_at);
      window.createOrUpdateSupabaseClient(data.access_token);
      scheduleTokenRefresh();
      return true;
    } catch { return false; }
  }

  function scheduleTokenRefresh() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    const ms = msUntilExpiry();
    const fireIn = Math.max(15_000, ms - 5 * 60 * 1000); // 5 min before exp, min 15s
    _refreshTimer = setTimeout(refreshAccessToken, fireIn);
  }

  async function ensureLoggedIn() {
    if (!getAccessToken()) { window.location.replace('./login.html'); return false; }
    if (isExpired()) {
      const ok = await refreshAccessToken();
      if (!ok) { window.location.replace('./login.html'); return false; }
    } else {
      // Re-init client with stored token
      window.createOrUpdateSupabaseClient(getAccessToken());
      scheduleTokenRefresh();
    }
    return true;
  }

  // Public API
  window.getAccessToken       = getAccessToken;
  window.getRefreshToken      = getRefreshToken;
  window.isAccessTokenExpired = isExpired;
  window.refreshAccessToken   = refreshAccessToken;
  window.scheduleTokenRefresh = scheduleTokenRefresh;
  window.ensureLoggedIn       = ensureLoggedIn;
})();
```

- [ ] **Step 2: Commit**

```bash
git add shared/auth-jwt.js
git commit -m "feat(ui): JWT refresh timer and ensureLoggedIn bootstrap"
```

---

## Task 25: shared/ui.js

**Files:**
- Create: `shared/ui.js`

- [ ] **Step 1: Write file**

```javascript
// shared/ui.js
// Toast + modal helpers (Bootstrap 5).

(function () {
  function ensureToastContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.className = 'toast-container position-fixed top-0 end-0 p-3';
      c.style.zIndex = '11000';
      document.body.appendChild(c);
    }
    return c;
  }

  function showToast(type, message, opts) {
    const c = ensureToastContainer();
    const id = 'toast-' + Math.random().toString(36).slice(2, 9);
    const cls = type === 'success' ? 'text-bg-success'
              : type === 'error'   ? 'text-bg-danger'
              : type === 'warning' ? 'text-bg-warning'
              : 'text-bg-info';
    const html = `
      <div id="${id}" class="toast ${cls}" role="alert" aria-live="assertive">
        <div class="d-flex">
          <div class="toast-body">${escapeHtml(message)}</div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
      </div>`;
    c.insertAdjacentHTML('beforeend', html);
    const el = document.getElementById(id);
    const t  = new bootstrap.Toast(el, { delay: opts?.delay ?? 4000 });
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      const id = 'confirm-' + Math.random().toString(36).slice(2, 9);
      const html = `
        <div class="modal fade" id="${id}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-body py-4 text-center">
                <p class="mb-3">${escapeHtml(message)}</p>
                <button class="btn btn-secondary me-2" data-act="no">ยกเลิก</button>
                <button class="btn btn-danger" data-act="yes">ยืนยัน</button>
              </div>
            </div>
          </div>
        </div>`;
      document.body.insertAdjacentHTML('beforeend', html);
      const el = document.getElementById(id);
      const m  = new bootstrap.Modal(el);
      el.querySelector('[data-act="yes"]').onclick = () => { resolve(true);  m.hide(); };
      el.querySelector('[data-act="no"]').onclick  = () => { resolve(false); m.hide(); };
      el.addEventListener('hidden.bs.modal', () => el.remove());
      m.show();
    });
  }

  window.showToast    = showToast;
  window.showConfirm  = showConfirm;
  window.escapeHtml   = escapeHtml;
})();
```

- [ ] **Step 2: Commit**

```bash
git add shared/ui.js
git commit -m "feat(ui): toast + confirm modal helpers"
```

---

## Task 26: shared/settings.js

**Files:**
- Create: `shared/settings.js`

- [ ] **Step 1: Write file**

```javascript
// shared/settings.js
// Read settings table once, cache to a local map, expose getters.

(function () {
  let _cache = null;

  async function loadSettings() {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('settings').select('key,value');
    if (error) throw error;
    _cache = {};
    for (const row of data) _cache[row.key] = row.value;
    return _cache;
  }

  function settingsGet(key) {
    return _cache ? _cache[key] : null;
  }
  function settingsBool(key) {
    const v = settingsGet(key);
    return v === 'true' || v === '1';
  }

  async function settingsSet(updates) {
    const sb = getSupabaseClient();
    const rows = Object.entries(updates).map(([key, value]) => ({
      key, value: String(value ?? ''),
      updated_at: new Date().toISOString(),
      updated_by: getUserUsername(),
    }));
    const { error } = await sb.from('settings').upsert(rows);
    if (error) throw error;
    Object.assign(_cache, updates);
  }

  window.loadSettings = loadSettings;
  window.settingsGet  = settingsGet;
  window.settingsBool = settingsBool;
  window.settingsSet  = settingsSet;
})();
```

- [ ] **Step 2: Commit**

```bash
git add shared/settings.js
git commit -m "feat(ui): settings cache + getters/setter"
```

---

## Task 27: shared/notify.js

**Files:**
- Create: `shared/notify.js`

- [ ] **Step 1: Write file**

```javascript
// shared/notify.js
// Call tg-notify Edge function. Used by admin Test button and Phase 1+ workflows.

(function () {
  async function notifyTrigger(opts) {
    try {
      const url = CONFIG.SUPABASE_URL + CONFIG.EDGE_TG_NOTIFY;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getAccessToken()}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(opts),
      });
      const data = await res.json();
      return data;
    } catch (e) {
      console.warn('[notify] error:', e);
      return { ok: false, error: String(e) };
    }
  }

  function notifyManualTest(message) {
    return notifyTrigger({
      event_type: 'manual',
      dedupe_key: 'manual:' + Math.random().toString(36).slice(2),
      message,
    });
  }

  window.notifyTrigger    = notifyTrigger;
  window.notifyManualTest = notifyManualTest;
})();
```

- [ ] **Step 2: Commit**

```bash
git add shared/notify.js
git commit -m "feat(ui): notify wrapper around tg-notify edge fn"
```

---

## Task 28: shared/cloudinary.js and shared/realtime.js (skeleton)

**Files:**
- Create: `shared/cloudinary.js`
- Create: `shared/realtime.js`

- [ ] **Step 1: Write `cloudinary.js`** (Phase 1+ uses, kept as part of shared/ for consistency)

```javascript
// shared/cloudinary.js
// Phase 0: not used yet. Phase 1+ uploads photos for borrow-return and laundry.

(function () {
  async function uploadToCloudinary(file, subfolder) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CONFIG.CLOUDINARY_UPLOAD_PRESET);
    fd.append('folder', CONFIG.CLOUDINARY_FOLDER_PREFIX + (subfolder || ''));

    const url = `https://api.cloudinary.com/v1_1/${CONFIG.CLOUDINARY_CLOUD_NAME}/image/upload`;
    const res = await fetch(url, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.secure_url;
  }

  window.uploadToCloudinary = uploadToCloudinary;
})();
```

- [ ] **Step 2: Write `realtime.js` skeleton**

```javascript
// shared/realtime.js
// Phase 1+: live subscriptions for stock_items, borrows, oxygen_tanks.

(function () {
  // Returns an unsubscribe fn.
  function subscribeTable(table, onChange) {
    const sb = getSupabaseClient();
    const ch = sb.channel(`tbl:${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, onChange)
      .subscribe();
    return () => sb.removeChannel(ch);
  }
  window.subscribeTable = subscribeTable;
})();
```

- [ ] **Step 3: Commit**

```bash
git add shared/cloudinary.js shared/realtime.js
git commit -m "feat(ui): cloudinary helper + realtime subscription skeleton"
```

---

# Phase E — Pages

Pattern for every page that requires auth: load shared scripts in this order, then in `DOMContentLoaded` call `await ensureLoggedIn()` then `onAppReady()`.

## Task 29: login.html + js/login.js

**Files:**
- Create: `login.html`
- Create: `js/login.js`

- [ ] **Step 1: Write `js/login.js`**

```javascript
// js/login.js

(async function () {
  // If already logged in with valid (or refreshable) token, skip form
  if (window.isLoggedIn && window.isLoggedIn()) {
    const ok = await window.refreshAccessToken().catch(() => false);
    if (ok || (window.getAccessToken() && !window.isAccessTokenExpired())) {
      window.location.replace('./index.html');
      return;
    }
  }

  document.getElementById('login-form').addEventListener('submit', window.handleLogin);
})();
```

- [ ] **Step 2: Write `login.html`**

```html
<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>เข้าสู่ระบบ — Thegood Stock</title>

<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./shared/styles.css">
</head>
<body>

<div id="login-view">
  <div class="card shadow-lg p-4" style="min-width:320px; max-width:380px;">
    <div class="text-center mb-3">
      <h4 class="mb-0">🏥 Thegood Stock</h4>
      <small class="text-muted">ระบบจัดการสต๊อกอุปกรณ์การแพทย์</small>
    </div>
    <form id="login-form">
      <div class="mb-3">
        <label class="form-label">Username</label>
        <input type="text" id="login-user" class="form-control" autocomplete="username" required>
      </div>
      <div class="mb-3">
        <label class="form-label">Password</label>
        <input type="password" id="login-pass" class="form-control" autocomplete="current-password" required>
      </div>
      <div id="login-error" class="alert alert-danger d-none py-2 small"></div>
      <button id="btn-login" type="submit" class="btn btn-stock-primary w-100">เข้าสู่ระบบ (Login)</button>
    </form>
    <div class="text-center mt-3">
      <small class="text-muted" id="version-label">v0.1.0 · Phase 0 (Foundation)</small>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script src="./shared/config.js"></script>
<script src="./shared/supabase-client.js"></script>
<script src="./shared/auth.js"></script>
<script src="./shared/auth-jwt.js"></script>
<script src="./shared/ui.js"></script>
<script src="./js/login.js"></script>

</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git add login.html js/login.js
git commit -m "feat(ui): login page wired to auth-bridge"
```

---

## Task 30: index.html (role-aware redirect)

**Files:**
- Create: `index.html`

- [ ] **Step 1: Write file**

```html
<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>กำลังโหลด… — Thegood Stock</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="./shared/styles.css">
</head>
<body>

<div class="d-flex justify-content-center align-items-center" style="min-height:100vh;">
  <div class="spinner-border text-stock-accent" role="status"><span class="visually-hidden">Loading…</span></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="./shared/config.js"></script>
<script src="./shared/supabase-client.js"></script>
<script src="./shared/auth.js"></script>
<script src="./shared/auth-jwt.js"></script>
<script>
(async function () {
  const ok = await window.ensureLoggedIn();
  if (!ok) return;
  const role = window.getUserRole();
  if (role === 'Admin')         window.location.replace('./admin.html');
  else if (role === 'Employee') window.location.replace('./staff.html');
  else                          window.location.replace('./403.html');
})();
</script>

</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(ui): index.html role-aware redirect"
```

---

## Task 31: 403.html

**Files:**
- Create: `403.html`

- [ ] **Step 1: Write file**

```html
<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ไม่มีสิทธิ์เข้าถึง — Thegood Stock</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="./shared/styles.css">
</head>
<body>

<div class="d-flex flex-column justify-content-center align-items-center text-center" style="min-height:100vh;">
  <h1 class="display-4 mb-3">⛔</h1>
  <h3>ไม่มีสิทธิ์เข้าถึงหน้านี้</h3>
  <p class="text-muted">บัญชีของท่านไม่ได้รับสิทธิ์ดูข้อมูลส่วนนี้</p>
  <button class="btn btn-secondary mt-3" id="btn-back">ออกจากระบบ</button>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="./shared/config.js"></script>
<script src="./shared/supabase-client.js"></script>
<script src="./shared/auth.js"></script>
<script src="./shared/auth-jwt.js"></script>
<script>
document.getElementById('btn-back').onclick = () => window.handleLogout();
</script>

</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add 403.html
git commit -m "feat(ui): 403 no-access page"
```

---

## Task 32: admin.html shell + js/admin-shell.js

**Files:**
- Create: `admin.html`
- Create: `js/admin-shell.js`

- [ ] **Step 1: Write `js/admin-shell.js`**

```javascript
// js/admin-shell.js

(async function () {
  const ok = await window.ensureLoggedIn();
  if (!ok) return;
  if (!window.requireRole('Admin')) return;

  // Greeting
  document.getElementById('user-name').textContent = window.getUserName();

  // Load settings cache
  try { await window.loadSettings(); }
  catch (e) { console.error('settings load failed', e); }

  // Wire logout
  document.getElementById('btn-logout').onclick = () => window.handleLogout();

  // Wire tab switching
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Lazy tab init
  const inits = {
    dashboard:  () => window.initDashboardTab && window.initDashboardTab(),
    locations:  () => window.initLocationsTab && window.initLocationsTab(),
    ambulances: () => window.initAmbulancesTab && window.initAmbulancesTab(),
    settings:   () => window.initSettingsTab && window.initSettingsTab(),
    sessions:   () => window.initSessionsTab && window.initSessionsTab(),
  };
  const initialized = new Set();

  function activateTab(name) {
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('d-none'));
    document.getElementById('tab-' + name).classList.remove('d-none');
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (!initialized.has(name)) { inits[name]?.(); initialized.add(name); }
  }
  activateTab('dashboard');
})();
```

- [ ] **Step 2: Write `admin.html`**

```html
<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Thegood Stock</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./shared/styles.css">
</head>
<body>

<nav class="navbar bg-modern-primary navbar-dark px-3">
  <span class="navbar-brand mb-0">🏥 Thegood Stock <small class="text-white-50">— Admin</small></span>
  <div>
    <span class="text-white-50 me-2">👤 <span id="user-name">…</span></span>
    <button class="btn btn-sm btn-outline-light" id="btn-logout">ออก</button>
  </div>
</nav>

<div class="container-fluid mt-3">
  <ul class="nav nav-pills mb-3 flex-wrap gap-1">
    <li><button class="btn nav-link stock-tab" data-tab="dashboard"><i class="bi bi-speedometer2"></i> Dashboard</button></li>
    <li><button class="btn nav-link stock-tab" data-tab="locations"><i class="bi bi-geo-alt"></i> Locations</button></li>
    <li><button class="btn nav-link stock-tab" data-tab="ambulances"><i class="bi bi-truck"></i> Ambulances</button></li>
    <li><button class="btn nav-link stock-tab" data-tab="settings"><i class="bi bi-gear"></i> Settings</button></li>
    <li><button class="btn nav-link stock-tab" data-tab="sessions"><i class="bi bi-people"></i> Sessions</button></li>
  </ul>

  <div id="tab-dashboard"  class="tab-pane d-none"></div>
  <div id="tab-locations"  class="tab-pane d-none"></div>
  <div id="tab-ambulances" class="tab-pane d-none"></div>
  <div id="tab-settings"   class="tab-pane d-none"></div>
  <div id="tab-sessions"   class="tab-pane d-none"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script src="./shared/config.js"></script>
<script src="./shared/supabase-client.js"></script>
<script src="./shared/auth.js"></script>
<script src="./shared/auth-jwt.js"></script>
<script src="./shared/ui.js"></script>
<script src="./shared/settings.js"></script>
<script src="./shared/notify.js"></script>

<!-- Per-tab modules (loaded but inert until activated) -->
<script src="./js/dashboard.js"></script>
<script src="./js/locations.js"></script>
<script src="./js/ambulances.js"></script>
<script src="./js/settings-ui.js"></script>
<script src="./js/sessions-ui.js"></script>

<script src="./js/admin-shell.js"></script>

</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git add admin.html js/admin-shell.js
git commit -m "feat(ui): admin shell with tab nav + role guard"
```

---

## Task 33: Admin Tab — Dashboard placeholder

**Files:**
- Create: `js/dashboard.js`

- [ ] **Step 1: Write file**

```javascript
// js/dashboard.js

window.initDashboardTab = async function () {
  const root = document.getElementById('tab-dashboard');

  // Render skeleton
  root.innerHTML = `
    <div class="card border-stock-accent">
      <div class="card-body">
        <h5 class="card-title text-stock-accent">Phase 0 Foundation — สถานะระบบ</h5>
        <ul class="list-unstyled mb-3" id="dash-status">
          <li>กำลังตรวจสอบ…</li>
        </ul>
        <p class="text-muted small mb-0">📊 Dashboard สำหรับสต๊อก / แจ้งเตือนจะเปิดใช้งานใน Phase 1 ขึ้นไป</p>
      </div>
    </div>
  `;

  const sb = getSupabaseClient();
  const [locRes, ambRes, ambSyncRes, tgRes] = await Promise.all([
    sb.from('locations').select('id', { count: 'exact', head: true }),
    sb.from('ambulances').select('id', { count: 'exact', head: true }),
    sb.from('ambulances').select('last_synced_at').order('last_synced_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('settings').select('value').eq('key', 'NOTIFY_TELEGRAM_ENABLED').maybeSingle(),
  ]);

  const lastSync = ambSyncRes?.data?.last_synced_at;
  const tgOn     = tgRes?.data?.value === 'true';

  document.getElementById('dash-status').innerHTML = `
    <li>✓ Auth พร้อม</li>
    <li>✓ DB เชื่อมต่อ <code>thegood-stock</code></li>
    <li>${(locRes.count ?? 0) > 0 ? '✓' : '⚠'} Locations: <strong>${locRes.count ?? 0}</strong></li>
    <li>${(ambRes.count ?? 0) > 0 ? '✓' : '⚠'} Ambulances: <strong>${ambRes.count ?? 0}</strong> ${lastSync ? `(last sync: ${new Date(lastSync).toLocaleString('th-TH')})` : ''}</li>
    <li>${tgOn ? '✓' : '⚠'} Telegram: <strong>${tgOn ? 'เปิด' : 'ปิดอยู่'}</strong> — ตั้งค่าได้ที่แท็บ Settings</li>
  `;
};
```

- [ ] **Step 2: Commit**

```bash
git add js/dashboard.js
git commit -m "feat(ui): admin dashboard placeholder with status counts"
```

---

## Task 34: Admin Tab — Locations CRUD

**Files:**
- Create: `js/locations.js`

This is the largest single page module. Includes tree render, modal, and code generator.

- [ ] **Step 1: Write file**

```javascript
// js/locations.js

(function () {
  let _all = [];

  async function load() {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('locations')
      .select('id,code,name,type,parent_id,ambulance_id,qr_payload,active,note')
      .order('type').order('code');
    if (error) throw error;
    _all = data;
  }

  function byParent() {
    const map = new Map();
    for (const l of _all) {
      const k = l.parent_id || '__root__';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(l);
    }
    return map;
  }

  function iconForType(t) {
    return t === 'room'      ? '🏠'
         : t === 'cabinet'   ? '📦'
         : t === 'shelf'     ? '🪜'
         : t === 'ambulance' ? '🚑'
         : t === 'bag'       ? '🎒' : '•';
  }

  function renderTree() {
    const map = byParent();
    const root = document.getElementById('loc-tree');
    function renderList(parentKey, depth) {
      const items = map.get(parentKey) || [];
      return items.map((l) => {
        const children = renderList(l.id, depth + 1);
        const isInactive = !l.active;
        return `
          <div class="d-flex align-items-center py-1" style="padding-left:${depth * 24}px;">
            <span class="me-2">${iconForType(l.type)}</span>
            <code class="me-2 small">${escapeHtml(l.code)}</code>
            <span class="${isInactive ? 'text-muted text-decoration-line-through' : ''}">${escapeHtml(l.name)}</span>
            <span class="ms-auto">
              <button class="btn btn-sm btn-link" data-act="edit" data-id="${l.id}"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-link text-danger" data-act="del" data-id="${l.id}"><i class="bi bi-trash"></i></button>
            </span>
          </div>
          ${children}
        `;
      }).join('');
    }
    root.innerHTML = renderList('__root__', 0) || '<p class="text-muted">ยังไม่มี Location — กด "เพิ่มใหม่"</p>';

    root.querySelectorAll('[data-act]').forEach((btn) => {
      const id = btn.dataset.id;
      if (btn.dataset.act === 'edit') btn.onclick = () => openModal(id);
      if (btn.dataset.act === 'del')  btn.onclick = () => handleDelete(id);
    });
  }

  // ===== Code generator =====
  function sanitizePlate(p) { return String(p || '').replace(/[^\w-ก-๙]/g, '').toUpperCase(); }

  async function generateCode(type, parentId, ambulanceId) {
    const sb = getSupabaseClient();

    if (type === 'room') {
      const { data } = await sb.from('locations').select('code').eq('type', 'room');
      const taken = new Set((data || []).map((r) => r.code));
      for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(65 + i);
        if (!taken.has(`ROOM-${letter}`)) return `ROOM-${letter}`;
      }
      return `ROOM-${Date.now()}`;
    }

    if (type === 'cabinet' || type === 'shelf') {
      // suffix from parent code
      const parent = _all.find((x) => x.id === parentId);
      if (!parent) return '';
      const parentSuffix = parent.code.replace(/^(ROOM|CAB)-/, '');
      const prefix = type === 'cabinet' ? `CAB-${parentSuffix}-` : `SHELF-${parentSuffix}-T`;
      const { data } = await sb.from('locations').select('code').like('code', prefix + '%');
      const nums = (data || [])
        .map((r) => Number(r.code.slice(prefix.length)))
        .filter((n) => !isNaN(n));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return prefix + next;
    }

    if (type === 'ambulance') {
      const amb = ambulanceId ? await sb.from('ambulances').select('plate').eq('id', ambulanceId).maybeSingle() : null;
      if (amb?.data?.plate) return 'AMB-' + sanitizePlate(amb.data.plate);
      return 'AMB-' + Date.now();
    }

    if (type === 'bag') {
      const { data } = await sb.from('locations').select('code').like('code', 'BAG-ALS-%');
      const nums = (data || [])
        .map((r) => Number(r.code.slice('BAG-ALS-'.length)))
        .filter((n) => !isNaN(n));
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return 'BAG-ALS-' + String(next).padStart(3, '0');
    }

    return '';
  }

  // ===== Modal =====
  function openModal(id) {
    const isEdit = !!id;
    const row    = isEdit ? _all.find((x) => x.id === id) : null;

    const modalHtml = `
      <div class="modal fade" id="loc-modal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <form id="loc-form">
              <div class="modal-header">
                <h5 class="modal-title">${isEdit ? 'แก้ไข Location' : 'เพิ่ม Location'}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="mb-2"><label class="form-label">Type</label>
                  <select id="f-type" class="form-select" ${isEdit ? 'disabled' : ''} required>
                    <option value="room">🏠 Room</option>
                    <option value="cabinet">📦 Cabinet</option>
                    <option value="shelf">🪜 Shelf</option>
                    <option value="ambulance">🚑 Ambulance</option>
                    <option value="bag">🎒 Bag (ALS)</option>
                  </select>
                </div>
                <div class="mb-2" id="parent-row"><label class="form-label">Parent</label>
                  <select id="f-parent" class="form-select"><option value="">(ไม่มี)</option></select>
                </div>
                <div class="mb-2 d-none" id="ambulance-row"><label class="form-label">Ambulance</label>
                  <select id="f-ambulance" class="form-select"><option value="">(เลือก)</option></select>
                </div>
                <div class="mb-2"><label class="form-label">Code</label>
                  <div class="input-group">
                    <input id="f-code" class="form-control" required>
                    <button type="button" class="btn btn-outline-secondary" id="btn-gen-code"><i class="bi bi-shuffle"></i> Generate</button>
                  </div>
                </div>
                <div class="mb-2"><label class="form-label">ชื่อ</label>
                  <input id="f-name" class="form-control" required>
                </div>
                <div class="mb-2"><label class="form-label">QR payload</label>
                  <input id="f-qr" class="form-control" placeholder="(default = Code)">
                </div>
                <div class="mb-2"><label class="form-label">Note</label>
                  <textarea id="f-note" class="form-control" rows="2"></textarea>
                </div>
                <div class="form-check">
                  <input type="checkbox" class="form-check-input" id="f-active" checked>
                  <label class="form-check-label" for="f-active">Active</label>
                </div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
                <button type="submit" class="btn btn-stock-primary">บันทึก</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalEl = document.getElementById('loc-modal');
    const modal   = new bootstrap.Modal(modalEl);
    modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());

    // Populate parent options
    const fType   = document.getElementById('f-type');
    const fParent = document.getElementById('f-parent');
    const fAmbu   = document.getElementById('f-ambulance');

    function refreshParents() {
      const t = fType.value;
      const allowedParentTypes = t === 'cabinet' ? ['room']
                                : t === 'shelf'  ? ['cabinet']
                                : [];
      fParent.innerHTML = '<option value="">(ไม่มี)</option>' + _all
        .filter((l) => allowedParentTypes.includes(l.type))
        .map((l) => `<option value="${l.id}">${escapeHtml(l.code)} — ${escapeHtml(l.name)}</option>`)
        .join('');
      document.getElementById('parent-row').classList.toggle('d-none', allowedParentTypes.length === 0);
      document.getElementById('ambulance-row').classList.toggle('d-none', t !== 'ambulance');
    }

    async function refreshAmbulances() {
      const sb = getSupabaseClient();
      const { data } = await sb.from('ambulances').select('id,plate,callsign').eq('active', true).order('plate');
      fAmbu.innerHTML = '<option value="">(เลือก)</option>' +
        (data || []).map((a) => `<option value="${a.id}">${escapeHtml(a.plate)} ${a.callsign ? '— ' + escapeHtml(a.callsign) : ''}</option>`).join('');
    }

    fType.onchange = refreshParents;
    refreshParents();
    refreshAmbulances();

    // Generate button
    document.getElementById('btn-gen-code').onclick = async () => {
      const code = await generateCode(fType.value, fParent.value || null, fAmbu.value || null);
      document.getElementById('f-code').value = code;
    };

    // Prefill on edit
    if (isEdit && row) {
      fType.value = row.type;
      refreshParents();
      if (row.parent_id) fParent.value = row.parent_id;
      if (row.ambulance_id) { /* will populate after refreshAmbulances resolves */
        setTimeout(() => { fAmbu.value = row.ambulance_id; }, 200);
      }
      document.getElementById('f-code').value = row.code;
      document.getElementById('f-name').value = row.name;
      document.getElementById('f-qr').value   = row.qr_payload || '';
      document.getElementById('f-note').value = row.note || '';
      document.getElementById('f-active').checked = !!row.active;
    }

    document.getElementById('loc-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const payload = {
        type:        fType.value,
        parent_id:   fParent.value || null,
        ambulance_id:fType.value === 'ambulance' ? (fAmbu.value || null) : null,
        code:        document.getElementById('f-code').value.trim(),
        name:        document.getElementById('f-name').value.trim(),
        qr_payload:  document.getElementById('f-qr').value.trim() || document.getElementById('f-code').value.trim(),
        note:        document.getElementById('f-note').value.trim() || null,
        active:      document.getElementById('f-active').checked,
      };
      const sb = getSupabaseClient();
      const q = isEdit
        ? sb.from('locations').update(payload).eq('id', id)
        : sb.from('locations').insert(payload);
      const { error } = await q;
      if (error) {
        if (error.code === '23505') showToast('error', 'รหัสซ้ำ');
        else if (error.code === '23514') showToast('error', 'Ambulance type ต้องเลือก Ambulance');
        else showToast('error', error.message);
        return;
      }
      modal.hide();
      await load(); renderTree();
      showToast('success', isEdit ? 'อัปเดตแล้ว' : 'เพิ่มแล้ว');
    };

    modal.show();
  }

  async function handleDelete(id) {
    const ok = await showConfirm('ลบ Location นี้?');
    if (!ok) return;
    const sb = getSupabaseClient();
    const { error } = await sb.from('locations').delete().eq('id', id);
    if (error) {
      if (error.code === '23503') showToast('error', 'ไม่สามารถลบได้ เพราะมีรายการลูกอยู่');
      else showToast('error', error.message);
      return;
    }
    await load(); renderTree();
    showToast('success', 'ลบแล้ว');
  }

  window.initLocationsTab = async function () {
    const root = document.getElementById('tab-locations');
    root.innerHTML = `
      <div class="d-flex align-items-center mb-2">
        <h5 class="mb-0 me-auto"><i class="bi bi-geo-alt"></i> สถานที่จัดเก็บ</h5>
        <button class="btn btn-stock-primary" id="btn-loc-new"><i class="bi bi-plus"></i> เพิ่มใหม่</button>
      </div>
      <div class="card"><div class="card-body" id="loc-tree">กำลังโหลด…</div></div>
    `;
    document.getElementById('btn-loc-new').onclick = () => openModal(null);
    try { await load(); renderTree(); }
    catch (e) { showToast('error', e.message); }
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add js/locations.js
git commit -m "feat(ui): admin Locations tab — tree + CRUD + code generator"
```

---

## Task 35: Admin Tab — Ambulances

**Files:**
- Create: `js/ambulances.js`

- [ ] **Step 1: Write file**

```javascript
// js/ambulances.js

(function () {
  async function load() {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('ambulances')
      .select('id,gas_id,plate,callsign,active,last_synced_at')
      .order('plate');
    if (error) throw error;
    return data;
  }

  async function loadLocLinks() {
    const sb = getSupabaseClient();
    const { data } = await sb.from('locations')
      .select('id,code,ambulance_id')
      .eq('type', 'ambulance');
    const map = new Map();
    for (const l of data || []) map.set(l.ambulance_id, l);
    return map;
  }

  function fmtDate(s) { return s ? new Date(s).toLocaleString('th-TH') : '—'; }

  async function render() {
    const root = document.getElementById('tab-ambulances');
    const [list, linkMap] = await Promise.all([load(), loadLocLinks()]);

    const lastSync = list.reduce((acc, r) => {
      if (!r.last_synced_at) return acc;
      return acc && acc > r.last_synced_at ? acc : r.last_synced_at;
    }, null);

    root.innerHTML = `
      <div class="d-flex align-items-center mb-2">
        <h5 class="mb-0 me-auto"><i class="bi bi-truck"></i> รถพยาบาล</h5>
        <button class="btn btn-stock-primary" id="btn-sync-amb"><i class="bi bi-arrow-clockwise"></i> ซิงค์จาก GAS</button>
      </div>
      <p class="text-muted small">Last sync: ${fmtDate(lastSync)} — ${list.length} คัน</p>
      <div class="card"><div class="card-body p-0">
        <table class="table table-sm mb-0">
          <thead><tr><th>Plate</th><th>Callsign</th><th>Status</th><th>Location?</th><th></th></tr></thead>
          <tbody>
            ${list.map((a) => `
              <tr>
                <td><code>${escapeHtml(a.plate)}</code></td>
                <td>${escapeHtml(a.callsign || '—')}</td>
                <td>${a.active ? '<span class="text-success">✓ active</span>' : '<span class="text-muted">✗ inactive</span>'}</td>
                <td>${linkMap.get(a.id) ? `<code class="small">${escapeHtml(linkMap.get(a.id).code)}</code>` : '<span class="text-muted">—</span>'}</td>
                <td><button class="btn btn-sm btn-link" data-id="${a.id}">${linkMap.get(a.id) ? 'แก้ Location' : '+ Location'}</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div></div>
    `;

    document.getElementById('btn-sync-amb').onclick = doSync;
    root.querySelectorAll('button[data-id]').forEach((b) => {
      b.onclick = () => {
        // Open Locations tab modal pre-filled
        showToast('info', 'ไปที่แท็บ Locations แล้วเลือก type=ambulance');
      };
    });
  }

  async function doSync() {
    const btn = document.getElementById('btn-sync-amb');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังซิงค์...';
    try {
      const res = await fetch(CONFIG.SUPABASE_URL + CONFIG.EDGE_SYNC_AMBU, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAccessToken()}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('error', `ซิงค์ล้มเหลว: ${data.error}`);
      } else {
        showToast('success', `ซิงค์สำเร็จ: ${data.upserted} คัน, deactivated ${data.deactivated} (${data.duration_ms}ms)`);
        await render();
      }
    } catch (e) {
      showToast('error', e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> ซิงค์จาก GAS';
    }
  }

  window.initAmbulancesTab = async function () {
    try { await render(); }
    catch (e) { showToast('error', e.message); }
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add js/ambulances.js
git commit -m "feat(ui): admin Ambulances tab with manual sync button"
```

---

## Task 36: Admin Tab — Settings

**Files:**
- Create: `js/settings-ui.js`

- [ ] **Step 1: Write file**

```javascript
// js/settings-ui.js

(function () {
  function v(key, fallback) {
    const x = settingsGet(key);
    return x == null ? (fallback ?? '') : x;
  }

  window.initSettingsTab = function () {
    const root = document.getElementById('tab-settings');
    root.innerHTML = `
      <h5 class="mb-3"><i class="bi bi-gear"></i> การตั้งค่าระบบ</h5>

      <div class="card mb-3"><div class="card-body">
        <h6>การแจ้งเตือน Telegram</h6>
        <div class="form-check form-switch mb-2">
          <input class="form-check-input" type="checkbox" id="s-tg-enabled" ${v('NOTIFY_TELEGRAM_ENABLED') === 'true' ? 'checked' : ''}>
          <label class="form-check-label" for="s-tg-enabled">เปิดใช้งานการแจ้งเตือน</label>
        </div>
        <div class="row g-2 mb-2">
          <div class="col-md-6"><label class="form-label small">Chat ID</label>
            <input class="form-control" id="s-tg-chat" value="${escapeHtml(v('NOTIFY_TELEGRAM_CHAT_ID'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">เวลาสรุปประจำวัน (HH)</label>
            <input class="form-control" id="s-tg-hour" type="number" min="0" max="23" value="${escapeHtml(v('NOTIFY_CRON_HOUR'))}">
          </div>
        </div>
        <button class="btn btn-outline-stock-accent btn-sm" id="btn-test-tg">ทดสอบส่ง Telegram</button>
      </div></div>

      <div class="card mb-3"><div class="card-body">
        <h6>เกณฑ์การแจ้งเตือน</h6>
        <div class="row g-2">
          <div class="col-md-3"><label class="form-label small">Dedupe window (ชม.)</label>
            <input class="form-control" id="s-dedupe" type="number" value="${escapeHtml(v('LOW_STOCK_DEDUPE_HOURS'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">Expiry alert (วัน)</label>
            <input class="form-control" id="s-expiry" value="${escapeHtml(v('EXPIRY_ALERT_DAYS'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">Oxygen refill threshold</label>
            <input class="form-control" id="s-o2" type="number" value="${escapeHtml(v('OXYGEN_REFILL_THRESHOLD'))}">
          </div>
        </div>
      </div></div>

      <div class="card mb-3"><div class="card-body">
        <h6>ภายนอกระบบ</h6>
        <label class="form-label small">Ambulance GAS URL</label>
        <input class="form-control" id="s-amb-url" value="${escapeHtml(v('AMBULANCE_GAS_URL'))}">
      </div></div>

      <button class="btn btn-stock-primary" id="btn-save-settings">บันทึกการตั้งค่า</button>
    `;

    document.getElementById('btn-save-settings').onclick = async () => {
      try {
        await settingsSet({
          NOTIFY_TELEGRAM_ENABLED: document.getElementById('s-tg-enabled').checked ? 'true' : 'false',
          NOTIFY_TELEGRAM_CHAT_ID: document.getElementById('s-tg-chat').value.trim(),
          NOTIFY_CRON_HOUR:        document.getElementById('s-tg-hour').value.trim(),
          LOW_STOCK_DEDUPE_HOURS:  document.getElementById('s-dedupe').value.trim(),
          EXPIRY_ALERT_DAYS:       document.getElementById('s-expiry').value.trim(),
          OXYGEN_REFILL_THRESHOLD: document.getElementById('s-o2').value.trim(),
          AMBULANCE_GAS_URL:       document.getElementById('s-amb-url').value.trim(),
        });
        showToast('success', 'บันทึกการตั้งค่าแล้ว');
      } catch (e) { showToast('error', e.message); }
    };

    document.getElementById('btn-test-tg').onclick = async () => {
      const res = await notifyManualTest('ทดสอบส่งจาก Thegood Stock — ' + new Date().toLocaleString('th-TH'));
      if (res?.sent)              showToast('success', 'ส่งสำเร็จ ตรวจ Telegram chat');
      else if (res?.reason === 'disabled') showToast('warning', 'Telegram ปิดอยู่ — เปิดและบันทึกก่อน');
      else                        showToast('error', 'ส่งไม่สำเร็จ: ' + (res?.error || 'unknown'));
    };
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add js/settings-ui.js
git commit -m "feat(ui): admin Settings tab — forms + Telegram test"
```

---

## Task 37: Admin Tab — Sessions audit + staff.html

**Files:**
- Create: `js/sessions-ui.js`
- Create: `js/staff-home.js`
- Create: `staff.html`

- [ ] **Step 1: Write `js/sessions-ui.js`**

```javascript
// js/sessions-ui.js

(function () {
  function fmt(s) { return s ? new Date(s).toLocaleString('th-TH') : '—'; }

  async function render() {
    const root = document.getElementById('tab-sessions');
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('user_sessions')
      .select('id,username,name,role,ip,user_agent,issued_at,expires_at,refresh_expires_at,revoked,last_seen_at')
      .order('issued_at', { ascending: false }).limit(100);
    if (error) { showToast('error', error.message); return; }

    root.innerHTML = `
      <h5 class="mb-3"><i class="bi bi-people"></i> Sessions Audit (ล่าสุด 100)</h5>
      <div class="card"><div class="card-body p-0">
        <table class="table table-sm mb-0">
          <thead><tr><th>User</th><th>Role</th><th>IP</th><th>Issued</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${data.map((s) => `
              <tr class="${s.revoked ? 'text-muted' : ''}">
                <td>${escapeHtml(s.name || s.username)} <small class="text-muted">@${escapeHtml(s.username)}</small></td>
                <td>${escapeHtml(s.role)}</td>
                <td><code class="small">${escapeHtml(s.ip || '—')}</code></td>
                <td>${fmt(s.issued_at)}</td>
                <td>${fmt(s.last_seen_at)}</td>
                <td>${s.revoked ? 'revoked' : (new Date(s.refresh_expires_at) < new Date() ? 'expired' : 'active')}</td>
                <td>${!s.revoked ? `<button class="btn btn-sm btn-outline-danger" data-revoke="${s.id}">revoke</button>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div></div>
    `;
    root.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => {
        const ok = await showConfirm('ตัดสิทธิ์ session นี้?');
        if (!ok) return;
        const { error } = await sb.from('user_sessions').update({ revoked: true }).eq('id', b.dataset.revoke);
        if (error) showToast('error', error.message);
        else { showToast('success', 'revoked'); render(); }
      };
    });
  }

  window.initSessionsTab = render;
})();
```

- [ ] **Step 2: Write `js/staff-home.js`**

```javascript
// js/staff-home.js

(async function () {
  const ok = await window.ensureLoggedIn();
  if (!ok) return;
  // Employees only; if Admin lands here, link them to admin
  if (window.getUserRole() === 'Admin') {
    document.getElementById('staff-greeting').insertAdjacentHTML('beforeend',
      ' <a href="./admin.html" class="ms-2 small">(ไปหน้า Admin)</a>');
  }

  try { await window.loadSettings(); } catch {}

  document.getElementById('user-name').textContent = window.getUserName();
  document.getElementById('btn-logout').onclick    = () => window.handleLogout();

  document.getElementById('btn-view-loc').onclick = renderLocations;
  document.getElementById('btn-view-amb').onclick = renderAmbulances;
})();

async function renderLocations() {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('locations')
    .select('code,name,type,active,parent_id').order('type').order('code');
  const root = document.getElementById('staff-detail');
  if (error) { root.innerHTML = `<div class="alert alert-danger">${error.message}</div>`; return; }
  root.innerHTML = `
    <h6>สถานที่จัดเก็บ (อ่านอย่างเดียว)</h6>
    <table class="table table-sm">
      <thead><tr><th>Code</th><th>Type</th><th>ชื่อ</th><th>Active</th></tr></thead>
      <tbody>${data.map((l) => `<tr>
        <td><code>${escapeHtml(l.code)}</code></td>
        <td>${escapeHtml(l.type)}</td>
        <td>${escapeHtml(l.name)}</td>
        <td>${l.active ? '✓' : '✗'}</td>
      </tr>`).join('')}</tbody>
    </table>
  `;
}

async function renderAmbulances() {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('ambulances').select('plate,callsign,active').order('plate');
  const root = document.getElementById('staff-detail');
  if (error) { root.innerHTML = `<div class="alert alert-danger">${error.message}</div>`; return; }
  root.innerHTML = `
    <h6>รถพยาบาล (อ่านอย่างเดียว)</h6>
    <table class="table table-sm">
      <thead><tr><th>Plate</th><th>Callsign</th><th>Active</th></tr></thead>
      <tbody>${data.map((a) => `<tr>
        <td><code>${escapeHtml(a.plate)}</code></td>
        <td>${escapeHtml(a.callsign || '—')}</td>
        <td>${a.active ? '✓' : '✗'}</td>
      </tr>`).join('')}</tbody>
    </table>
  `;
}
```

- [ ] **Step 3: Write `staff.html`**

```html
<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thegood Stock</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./shared/styles.css">
</head>
<body>

<nav class="navbar bg-modern-primary navbar-dark px-3">
  <span class="navbar-brand mb-0">🏥 Thegood Stock</span>
  <div>
    <span class="text-white-50 me-2">👤 <span id="user-name">…</span></span>
    <button class="btn btn-sm btn-outline-light" id="btn-logout">ออก</button>
  </div>
</nav>

<div class="container mt-4">
  <h4 id="staff-greeting">สวัสดี <span id="user-name-2"></span></h4>
  <p class="text-muted">Role: Employee</p>

  <div class="card mb-3"><div class="card-body">
    <p class="mb-2"><strong>ระบบอยู่ระหว่างพัฒนา (Phase 0 Foundation)</strong></p>
    <p class="mb-3 text-muted small">ฟังก์ชันสแกน เบิก-จ่าย ยืม-คืน จะเปิดใน Phase 1 ขึ้นไป</p>
    <button class="btn btn-outline-stock-accent me-2" id="btn-view-loc"><i class="bi bi-geo-alt"></i> ดูสถานที่จัดเก็บ</button>
    <button class="btn btn-outline-stock-accent" id="btn-view-amb"><i class="bi bi-truck"></i> ดูรถพยาบาล</button>
  </div></div>

  <div id="staff-detail"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="./shared/config.js"></script>
<script src="./shared/supabase-client.js"></script>
<script src="./shared/auth.js"></script>
<script src="./shared/auth-jwt.js"></script>
<script src="./shared/ui.js"></script>
<script src="./shared/settings.js"></script>
<script src="./js/staff-home.js"></script>

</body>
</html>
```

- [ ] **Step 4: Commit**

```bash
git add js/sessions-ui.js js/staff-home.js staff.html
git commit -m "feat(ui): sessions audit tab + staff read-only landing"
```

---

# Phase F — Service Worker, Deploy, Smoke Tests

## Task 38: Service Worker (cache-first static)

**Files:**
- Create: `sw.js`

- [ ] **Step 1: Write `sw.js`**

```javascript
// sw.js — cache-first for static, network-first for API. No background sync in Phase 0.

const CACHE_VERSION = 'thegood-stock-v0.1.0';
const STATIC_ASSETS = [
  './',
  './login.html',
  './index.html',
  './admin.html',
  './staff.html',
  './403.html',
  './shared/styles.css',
  './shared/config.js',
  './shared/supabase-client.js',
  './shared/auth.js',
  './shared/auth-jwt.js',
  './shared/ui.js',
  './shared/settings.js',
  './shared/notify.js',
  './shared/cloudinary.js',
  './shared/realtime.js',
  './js/login.js',
  './js/admin-shell.js',
  './js/dashboard.js',
  './js/locations.js',
  './js/ambulances.js',
  './js/settings-ui.js',
  './js/sessions-ui.js',
  './js/staff-home.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isApi = url.hostname.endsWith('.supabase.co') ||
                url.hostname.endsWith('.workers.dev') ||
                url.pathname.startsWith('/functions/');
  if (isApi || e.request.method !== 'GET') {
    // Network-first: skip cache
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
```

- [ ] **Step 2: Register SW** — add to bottom of `<body>` in `login.html`, `index.html`, `admin.html`, `staff.html`, `403.html`:

```html
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e)));
}
</script>
```

- [ ] **Step 3: Commit**

```bash
git add sw.js login.html index.html admin.html staff.html 403.html
git commit -m "feat(pwa): service worker — cache-first static, no install prompt"
```

---

## Task 39: Create GitHub repo and push

- [ ] **Step 1: Create remote repo**

Manual via web or gh CLI:

```bash
# Option A: gh CLI
gh repo create officethegood/thegood-stock --public --source=. --remote=origin --push

# Option B: web UI then add remote
git remote add origin https://github.com/officethegood/thegood-stock.git
git branch -M main
git push -u origin main
```

- [ ] **Step 2: Enable GitHub Pages**

In repo Settings → Pages:
- Source: Deploy from a branch
- Branch: `main` / `(root)`
- Click Save

- [ ] **Step 3: Wait for first deploy + verify**

Wait ~1 min. Then:

```bash
curl -I https://officethegood.github.io/thegood-stock/login.html
```

Expected: `HTTP/2 200`. Open in browser and check the login screen renders with teal accent.

- [ ] **Step 4: Update README** with the live URL if different from spec.

```bash
git commit --allow-empty -m "chore: confirm pages deploy"
```

---

## Task 40: Smoke script

**Files:**
- Create: `tools/smoke-test.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
# tools/smoke-test.sh — basic post-deploy checks.
# Usage: PROJECT_REF=xxx ANON_KEY=xxx ./tools/smoke-test.sh

set -u

PROJECT_REF="${PROJECT_REF:-}"
ANON_KEY="${ANON_KEY:-}"
GAS_HR="${GAS_HR:-https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec}"
WORKER="${WORKER:-https://thegood-ocr-proxy.officethegood.workers.dev}"

if [ -z "$PROJECT_REF" ] || [ -z "$ANON_KEY" ]; then
  echo "Usage: PROJECT_REF=... ANON_KEY=... $0"
  exit 1
fi

echo "1. auth-bridge unknown action"
curl -sS -X POST "https://$PROJECT_REF.supabase.co/functions/v1/auth-bridge" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{}' | head -c 200; echo

echo "2. GAS HR shape"
curl -sS -X POST "$GAS_HR" -H "Content-Type: text/plain" \
  -d '{"username":"nobody","password":"x"}' | head -c 200; echo

echo "3. Worker health"
curl -sS "$WORKER/notify/health" | head -c 200; echo

echo "4. settings count"
curl -sS "https://$PROJECT_REF.supabase.co/rest/v1/settings?select=key" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  | python3 -c "import sys,json; print('rows:', len(json.load(sys.stdin)))"
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x tools/smoke-test.sh
git add tools/smoke-test.sh
git commit -m "tools: post-deploy smoke test script"
```

- [ ] **Step 3: Run**

```bash
PROJECT_REF=<ref> ANON_KEY=<anon> ./tools/smoke-test.sh
```

Expected: 4 outputs, all reasonable (settings row count ≥ 7).

---

## Task 41: Take post-deploy DB snapshot

- [ ] **Step 1: Dump**

```bash
supabase db dump --schema public > tools/snapshots/post-deploy-phase0.sql
```

- [ ] **Step 2: Commit**

```bash
git add tools/snapshots/post-deploy-phase0.sql
git commit -m "chore(db): snapshot after Phase 0 deploy"
```

---

# Phase G — Manual Test + Docs

## Task 42: Run T1–T23 manual checklist

**Files:**
- Create: `docs/test-checklist.md`

- [ ] **Step 1: Write checklist doc** (mirror of spec section 11; checkbox per row for tracking)

```markdown
# Phase 0 Foundation — Manual Test Checklist

Tick each row as you verify. Re-run after every material change.

## Auth
- [ ] T1: Login with correct creds → redirected by role
- [ ] T2: Wrong password → "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง"
- [ ] T3: Inactive user → "ไม่มีสิทธิ์เข้าถึง"
- [ ] T4: Reopen tab after login → no re-login prompt
- [ ] T5: Token refresh after 8h idle → still works
- [ ] T6: Logout → must log in again

## RBAC
- [ ] T7: Admin reaches admin.html
- [ ] T8: Employee at /admin.html → redirected to 403
- [ ] T9: Employee POST to locations via DevTools → 403
- [ ] T10: Tamper localStorage role → cannot insert (JWT unchanged)

## Locations
- [ ] T11: Create Room → Cabinet → Shelf
- [ ] T12: Generator: Cabinet under ROOM-A proposes `CAB-A-1`; manual override OK
- [ ] T13: Duplicate code → 409 / inline error
- [ ] T14: type=ambulance without ambulance_id → check constraint
- [ ] T15: Delete Room with children → "ไม่สามารถลบได้ เพราะมีรายการลูก"

## Ambulance sync
- [ ] T16: Set AMBULANCE_GAS_URL → click Sync → data populates
- [ ] T17: Bad URL → 502 toast
- [ ] T18: Remove 1 from GAS → re-sync → that row active=false

## Settings / Telegram
- [ ] T19: Set chat_id + enabled → Test → message in Telegram
- [ ] T20: Disable → Test → "Telegram ปิดอยู่"
- [ ] T21: Bad chat_id → notification_log row with success=false

## Sessions
- [ ] T22: Employee sees own session only
- [ ] T23: Admin revokes a session → user's refresh → forced logout
```

- [ ] **Step 2: Execute every row**

For each unchecked row, open the app, perform the action, observe, and tick the box.

- [ ] **Step 3: Commit the checklist with all boxes ticked**

```bash
git add docs/test-checklist.md
git commit -m "test: Phase 0 manual checklist all green"
```

If a test fails: open an issue, fix, redeploy, re-run only the affected rows.

---

## Task 43: docs/env-setup.md

**Files:**
- Create: `docs/env-setup.md`

- [ ] **Step 1: Write file**

```markdown
# Environment Setup — Thegood Stock

## Required accounts
- Supabase organization `officethegood` (Project `thegood-stock`, region ap-southeast-1)
- GitHub organization `officethegood` (Repo `thegood-stock`)
- Access to existing Thegood Cloudflare account (Worker `thegood-ocr-proxy`)
- Access to Thegood HR GAS script (for auth)
- Access to Thegood Ambulance GAS script (for ambulance list)

## Local tooling
- Node.js 18+ (for Supabase CLI)
- Supabase CLI: https://supabase.com/docs/guides/cli
- `gh` CLI (optional, for PRs)

## Supabase secrets (set once per project)

```bash
supabase link --project-ref <ref>
supabase secrets set GAS_HR_URL="https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec"
supabase secrets set JWT_ACCESS_TTL_SECONDS=28800
supabase secrets set JWT_REFRESH_TTL_SECONDS=2592000
supabase secrets set NOTIFY_PROXY_URL="https://thegood-ocr-proxy.officethegood.workers.dev"
```

Built-in (auto):
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`

## Frontend config (one file)

Edit `shared/config.js`:
- `SUPABASE_URL` — project URL
- `SUPABASE_ANON_KEY` — public anon key from Settings → API

## In-app settings (after first admin login)

Open admin.html → Settings tab:
- AMBULANCE_GAS_URL — paste the Ambulance GAS `/exec` URL (must support `?action=listAmbulances` — see `docs/gas-ambulance-doget-snippet.md`)
- NOTIFY_TELEGRAM_CHAT_ID — chat_id for Stock alerts
- NOTIFY_TELEGRAM_ENABLED — turn on after confirming Test button works
```

- [ ] **Step 2: Commit**

```bash
git add docs/env-setup.md
git commit -m "docs: env setup"
```

---

## Task 44: docs/deploy.md

**Files:**
- Create: `docs/deploy.md`

- [ ] **Step 1: Write file**

```markdown
# Deploy — Thegood Stock

## Bootstrap (one-time)

1. Create Supabase project `thegood-stock` (see env-setup.md)
2. `supabase link --project-ref <ref>`
3. Set Edge Function secrets
4. `supabase db push` — apply all migrations
5. `supabase functions deploy auth-bridge`
6. `supabase functions deploy sync-ambulances`
7. `supabase functions deploy tg-notify`
8. Update `shared/config.js` with project URL + anon key
9. `git push origin main` (or create repo via `gh repo create`)
10. Enable GitHub Pages: Settings → Pages → `main` / `(root)`
11. Open `https://officethegood.github.io/thegood-stock/login.html` and log in
12. In Settings tab, set Ambulance GAS URL + Telegram chat_id

## Ongoing

| Change | Command |
|---|---|
| Frontend HTML/JS/CSS | `git push` — GitHub Pages auto-deploys (~30s) |
| Migration | `supabase db push` |
| Edge Function | `supabase functions deploy <name>` |

## Before every prod migration push

```bash
supabase db dump --schema public > tools/snapshots/$(date +%Y%m%d-%H%M)-pre.sql
git add tools/snapshots/*.sql
git commit -m "chore(db): snapshot before <change>"
```

## Rollback

| Layer | Rollback action |
|---|---|
| Frontend | `git revert HEAD && git push` (~30s) |
| Migration | Write a NEW "down" migration; do not edit historical files |
| Edge Function | Check out previous git rev, `supabase functions deploy <name>` |
| Cache (stale SW) | Bump `CACHE_VERSION` in `sw.js`, redeploy |

## Logging

Built-in:
- Supabase Dashboard → Edge Functions → `<name>` → Logs
- Browser DevTools console (frontend errors)

No external log shipping in Phase 0 (Q18 = A).
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy.md
git commit -m "docs: deploy procedure"
```

---

## Task 45: Final integration verify

- [ ] **Step 1: Run full checklist `docs/test-checklist.md`**

Every row checked. Re-do anything that fails.

- [ ] **Step 2: Spec-side cleanup**

Update the spec's "Decisions Log" or "Open Questions" section if any item is now confirmed or invalidated. For example, if Cloudflare Worker turned out to need chat_id in body, document this and link to the relevant commit.

```bash
git add docs/superpowers/specs/2026-05-18-phase0-foundation-design.md
git commit -m "docs(spec): post-implementation reconciliation"
```

(Skip this step if no spec edits were needed.)

---

## Task 46: Hand-off

Phase 0 is done when:
- All boxes in `docs/test-checklist.md` are ticked.
- `tools/smoke-test.sh` passes cleanly.
- Production URL `https://officethegood.github.io/thegood-stock/login.html` accepts both Admin and Employee logins, redirects correctly, and the admin can perform full Locations CRUD + Ambulance sync + Telegram test.

Tag the release:

```bash
git tag -a phase0-foundation -m "Phase 0 — Foundation complete"
git push --tags
```

Next: brainstorm Phase 1 (General Inventory) per spec section 1 "Out of scope (deferred to later phases)".

---

# Self-Review

This is a checklist run after writing the plan. Findings are fixed inline above.

**Spec coverage:** Each spec section maps to at least one task.

| Spec section | Tasks |
|---|---|
| 1 Purpose & Scope | (informational — no code) |
| 2 Architecture | covered by Tasks 5–37 collectively |
| 3 Sync strategy | Phase 0 items 1–5 are implemented; items 6–12 stubs land in Phase 1+ |
| 4 Repo structure | Tasks 1–2 |
| 5 DB schema | Tasks 5–13 |
| 6 Auth flow | Tasks 14, 23–24, 29–32 |
| 7 Edge Functions | Tasks 14–18 |
| 8 Frontend pages | Tasks 29–37 |
| 9 Service Worker | Task 38 |
| 10 Error handling | Implemented within auth.js (Task 23), locations.js (Task 34), notify.js (Task 27) |
| 11 Test checklist | Tasks 42, 45 |
| 12 Deploy | Tasks 39, 44 |
| 13 External deps | Task 17 (GAS snippet), Task 18 (Worker verify) |
| 14 Open questions | Reconciliation in Task 45 |
| 15 Decisions log | All Q-decisions baked into specific tasks |

**Placeholder scan:** No `TBD`, `TODO`, `handle edge cases`, or "similar to above" tokens in the plan. Replace tokens that exist (`<PROJECT_REF>`, `<ANON_KEY>`, `<real_user>`, `<real_pwd>`, `<ADMIN_ACCESS_TOKEN>`) are placeholders by design — runtime values the engineer fills in from Supabase dashboard and a live login.

**Type consistency:** `getAccessToken`, `getRefreshToken`, `scheduleTokenRefresh`, `ensureLoggedIn`, `createOrUpdateSupabaseClient`, `requireRole`, `handleLogin`, `handleLogout`, `getUserName`, `getUserRole`, `getUserUsername` all defined in Tasks 22–24 and referenced consistently in Tasks 29–37. `loadSettings`, `settingsGet`, `settingsBool`, `settingsSet` defined in Task 26 and referenced in 33, 36. `notifyTrigger`, `notifyManualTest` defined in Task 27 and called in Task 36. No `clearFullLayers()` / `clearLayers()`-style drift.

**Phase 0 size:** Around 46 tasks. Each task is a small, independently committable unit. A two-day sprint at full focus completes Phase 0; a one-week sprint is realistic accounting for the Ambulance GAS owner's turnaround on Task 17 and Cloudflare Worker chat_id verification in Task 18.
