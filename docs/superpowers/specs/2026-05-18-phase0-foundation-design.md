# Phase 0 — Foundation Design

**Project:** Thegood Stock Management System
**Phase:** 0 (Foundation)
**Date:** 2026-05-18
**Owner:** pex.elsa@gmail.com (officethegood)
**Status:** Design approved — pending plan write-up

---

## 1. Purpose & Scope

Phase 0 lays the infrastructure that every later phase (Inventory, Medication, Borrow/Return, ALS Bags, Oxygen, Linens) will depend on. It delivers no business workflow itself, but ships a usable shell with auth, master data, and notification plumbing wired end-to-end.

### In scope (Phase 0)
- New GitHub repo `officethegood/thegood-stock` hosted on GitHub Pages
- New Supabase project `thegood-stock` (region ap-southeast-1)
- Auth bridge between existing Thegood HR GAS API and Supabase JWT (B' Hybrid)
- Database schema for `ambulances`, `locations`, `settings`, `notification_log`, `user_sessions` with RLS
- Three Edge Functions: `auth-bridge`, `sync-ambulances`, `tg-notify`
- Admin UI: Dashboard placeholder, Locations CRUD, Ambulances list + manual sync, Settings, Sessions audit
- Employee UI: minimal landing with read-only locations/ambulances browse
- Service Worker with cache-first static + network-first API (no background sync yet)
- Telegram notification wiring through existing `thegood-ocr-proxy` Cloudflare Worker
- One required change in the existing Thegood Ambulance GAS web app: add `doGet(e)` with `?action=listAmbulances` returning JSON

### Out of scope (deferred to later phases)
- Phase 1: General Inventory + Storage scanning + Low-stock alert
- Phase 2: Medication lots, expiry tracking, expiry alert
- Phase 3: Equipment Borrow/Return with photo proof and overdue alert
- Phase 4: ALS Bags / Medical Kits with restock and granular expiry
- Phase 5: Oxygen tank lifecycle and refill batch alert
- Phase 6: Linens & Laundry cabinet-based count tracking
- Installable PWA / manifest.json (user explicitly chose web-only — Q2)
- Background sync queue (skeleton only — full impl in Phase 1)
- Unit tests / E2E tests (manual checklist instead — Q16)
- External log shipping (built-in Supabase Function Logs only — Q18)

---

## 2. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (Mobile-first web — no PWA install)                        │
│  GitHub Pages: officethegood.github.io/thegood-stock/               │
│                                                                     │
│  ┌──────────────────────────────────────────────────┐              │
│  │  REALTIME subscription (WebSocket) — Phase 1+    │              │
│  │  • stock_items, borrows, oxygen_tanks            │              │
│  └──────────────────────────────────────────────────┘              │
│                          ↑↓                                         │
└────────────────────────┼────────────────────────────────────────────┘
                         │
                 ┌───────┴────────────┐
                 │ Supabase REST/RPC  │  ← request-response (CRUD)
                 │   + Realtime WS    │  ← Phase 1+ live updates
                 │   + custom JWT     │  ← from auth-bridge
                 └───────┬────────────┘
                         │
        ┌────────────────┴──────────────────────────┐
        │ Postgres (thegood-stock project)           │
        │  ┌──────────────────────────────────────┐ │
        │  │ pg_cron (Phase 1+ daily expiry/etc.) │ │
        │  └──────────────────────────────────────┘ │
        │  ┌──────────────────────────────────────┐ │
        │  │ Triggers + pg_net (Phase 1+ alerts)  │ │
        │  └──────────────────────────────────────┘ │
        └────────────────────────────────────────────┘
                         ↑
                         │
        ┌────────────────┴──────────────────────┐
        │ Supabase Edge Functions (Deno TS)     │
        │  ├─ auth-bridge      [public]         │
        │  ├─ sync-ambulances  [admin JWT]      │
        │  └─ tg-notify        [internal/admin] │
        └────────┬──────────────────────────────┘
                 │
       ┌─────────┴──────────────┐
       ▼                        ▼
┌─────────────┐         ┌──────────────────────────────┐
│ GAS HR API  │         │ GAS Ambulance API            │
│ /exec POST  │         │ /exec GET?action=listAmbu... │
│ (verify pwd)│         │ (needs doGet added)          │
└─────────────┘         └──────────────────────────────┘

                 ┌──────────────────────────────────┐
                 │ Cloudflare Worker (existing):    │
                 │ thegood-ocr-proxy                │
                 │ /notify/send → Telegram Bot API  │
                 └──────────────────────────────────┘
```

### Key principles

| Principle | How it shows up |
|---|---|
| **No build step** | Static HTML/JS via `<script>` tags, deploy = `git push` |
| **Self-contained repo** | `shared/*.js` is copied + adapted from pt-medical V.5; no network import or git submodule |
| **Server work in Edge Functions** | Anything needing secrets, GAS calls, JWT signing, or trigger HTTP egress |
| **RLS enforces roles** | `user_role` claim in JWT; Postgres policies check `app_user_role()` |
| **Reuse external services** | Cloudflare Worker for Telegram, Cloudinary `ddummbyql` for photos (Phase 1+) |

---

## 3. Sync Strategy

Every data flow is classified explicitly to avoid silent overload of either polling or realtime channels.

| # | Data | Type | Mechanism | Cadence | Phase |
|---|---|---|---|---|---|
| 1 | Login | Request-Response | POST `auth-bridge?action=login` | per session | 0 |
| 2 | JWT refresh | Auto (client timer) | `auth-bridge?action=refresh` | exp-5min | 0 |
| 3 | Ambulance list | **Manual sync** | Admin button → `sync-ambulances` | on demand | 0 |
| 4 | Locations CRUD | Request-Response | Supabase direct | immediate | 0 |
| 5 | Settings | Request-Response | Supabase direct | immediate | 0 |
| 6 | Stock balance, borrows, oxygen status | **Realtime** | Postgres replication → WebSocket | live | 1+ |
| 7 | Dashboard counters | Realtime + materialized view | Supabase Realtime | live | 1+ |
| 8 | Expiry alert (30/60/90d) | **Autosync (cron)** | `pg_cron` daily @ NOTIFY_CRON_HOUR | 1×/day | 2+ |
| 9 | Low-stock alert | **Autosync (trigger + dedupe)** | AFTER UPDATE trigger → `pg_net` → `tg-notify` | on threshold + dedupe window | 1+ |
| 10 | Overdue borrow | **Autosync (cron)** | `pg_cron` 09:00 + 17:00 | 2×/day | 3+ |
| 11 | Oxygen refill batch | **Autosync (trigger + dedupe)** | trigger on tank count change | on threshold | 5+ |
| 12 | User list cache (optional) | Manual sync | Admin button | rare | deferred |

Phase 0 only ships items 1–5. Items 6–12 are designed for but not implemented; the schema includes a placeholder column where they need it (e.g., `notification_log.dedupe_key`).

---

## 4. Repository Structure

Target: `F:\@Coding\ระบบ\The Good Stock\` → `officethegood/thegood-stock` (main branch → GitHub Pages root)

```
thegood-stock/
├── README.md
├── .gitignore
├── sw.js                          (Service Worker — cache-first static + network-first API)
│
├── index.html                     (redirect by role)
├── login.html                     (login form)
├── admin.html                     (Admin shell with 5 tabs)
├── staff.html                     (Employee minimal landing)
├── 403.html                       (no-access page)
│
├── shared/
│   ├── config.js                  (SUPABASE_URL/KEY, GAS_HR_URL, Cloudinary, Notify)
│   ├── auth.js                    (handleLogin, handleLogout, getUserMeta)
│   ├── auth-jwt.js                (JWT refresh timer, supabase client factory)
│   ├── supabase-client.js         (createSupabaseClient with JWT header)
│   ├── cloudinary.js              (uploadToCloudinary — folder prefix 'thegood-stock/')
│   ├── notify.js                  (notifyTrigger via tg-notify edge fn)
│   ├── realtime.js                (Phase 1+ subscription helpers)
│   ├── ui.js                      (showToast, modal helpers)
│   ├── settings.js                (read settings table → CONFIG cache)
│   └── styles.css                 (Sarabun + navy gradient — copied from pt-medical V.5)
│
├── js/
│   ├── login.js
│   ├── admin-shell.js             (Nav, role guard, tab switching)
│   ├── locations.js               (CRUD + tree rendering + code generator)
│   ├── ambulances.js              (list + Sync button + link-to-location)
│   ├── settings-ui.js             (settings table form)
│   ├── sessions-ui.js             (user_sessions audit + revoke)
│   └── staff-home.js              (read-only locations/ambulances browse)
│
├── assets/
│   ├── logo.png
│   └── icons/
│       ├── icon-192.png
│       └── icon-512.png
│
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 20260518000000_init.sql                  (extensions, enums, helpers)
│   │   ├── 20260518000100_ambulances.sql
│   │   ├── 20260518000200_locations.sql
│   │   ├── 20260518000300_settings.sql              (table + seed)
│   │   ├── 20260518000400_notification_log.sql
│   │   ├── 20260518000500_user_sessions.sql
│   │   └── 20260518000600_rls_policies.sql
│   └── functions/
│       ├── auth-bridge/
│       │   ├── index.ts
│       │   └── deno.json
│       ├── sync-ambulances/
│       │   ├── index.ts
│       │   └── deno.json
│       └── tg-notify/
│           ├── index.ts
│           └── deno.json
│
├── sql/
│   └── seed-example-locations.sql                   (one-off, manually run)
│
├── docs/
│   ├── superpowers/specs/2026-05-18-phase0-foundation-design.md  (this file)
│   ├── env-setup.md
│   ├── deploy.md
│   ├── test-checklist.md
│   └── gas-ambulance-doget-snippet.md
│
└── tools/
    ├── set-secrets.sh                               (one-time Supabase secrets)
    └── smoke-test.sh                                (post-deploy checks)
```

---

## 5. Database Schema

All migrations live in `supabase/migrations/` with a `YYYYMMDDHHMMSS_<name>.sql` filename.

### 5.1 Extensions and helpers (`20260518000000_init.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;       -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_net;         -- for trigger HTTP egress (Phase 1+)
-- pg_cron will be enabled in Phase 1+ migration; not needed in Phase 0

-- JWT claim helpers
CREATE OR REPLACE FUNCTION app_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'user_role', '')
$$;

CREATE OR REPLACE FUNCTION app_username() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'username', '')
$$;

-- updated_at trigger helper
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
```

### 5.2 `ambulances` (`20260518000100_ambulances.sql`)

```sql
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

### 5.3 `locations` (`20260518000200_locations.sql`)

```sql
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

### 5.4 `settings` (`20260518000300_settings.sql`)

```sql
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

### 5.5 `notification_log` (`20260518000400_notification_log.sql`)

```sql
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

### 5.6 `user_sessions` (`20260518000500_user_sessions.sql`)

```sql
CREATE TABLE user_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL,
  name                text,
  role                text NOT NULL,
  jwt_jti             text UNIQUE NOT NULL,
  refresh_token       text UNIQUE NOT NULL,
  issued_at           timestamptz DEFAULT now(),
  expires_at          timestamptz NOT NULL,         -- access token exp
  refresh_expires_at  timestamptz NOT NULL,         -- refresh token exp
  revoked             boolean DEFAULT false,
  last_seen_at        timestamptz,
  ip                  inet,
  user_agent          text
);
CREATE INDEX idx_sessions_username     ON user_sessions(username);
CREATE INDEX idx_sessions_refresh      ON user_sessions(refresh_token);
CREATE INDEX idx_sessions_expires      ON user_sessions(refresh_expires_at);
```

### 5.7 RLS policies (`20260518000600_rls_policies.sql`)

```sql
ALTER TABLE locations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambulances        ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions     ENABLE ROW LEVEL SECURITY;

-- locations: all authenticated read; Admin write
CREATE POLICY loc_read  ON locations FOR SELECT TO authenticated USING (true);
CREATE POLICY loc_write ON locations FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- ambulances: same
CREATE POLICY amb_read  ON ambulances FOR SELECT TO authenticated USING (true);
CREATE POLICY amb_write ON ambulances FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- settings: all authenticated read; Admin write
CREATE POLICY set_read  ON settings FOR SELECT TO authenticated USING (true);
CREATE POLICY set_write ON settings FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- notification_log: all authenticated read; no client INSERT (service_role only)
CREATE POLICY nlog_read ON notification_log FOR SELECT TO authenticated USING (true);

-- user_sessions: see own; Admin sees all; revoke is Admin-only UPDATE
CREATE POLICY sess_select ON user_sessions FOR SELECT TO authenticated
  USING (username = app_username() OR app_user_role() = 'Admin');
CREATE POLICY sess_revoke ON user_sessions FOR UPDATE TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');
```

---

## 6. Auth Flow (B' Hybrid)

### 6.1 Login
1. `login.html` submits `{username, password}` to `POST /functions/v1/auth-bridge` with `{action: 'login'}`
2. Edge function POSTs to `GAS_HR_URL` (server-side, so no CORS)
3. GAS returns `{status, name, role}`
4. On success, edge function:
   a. signs JWT with `SUPABASE_JWT_SECRET` (HS256, exp +8h) with claims `{sub, role:'authenticated', user_role, name, username, jti, iat, exp, aud:'authenticated', iss:'thegood-stock'}`
   b. generates `refresh_token = crypto.randomUUID()`, exp +30d
   c. INSERTs into `user_sessions`
   d. returns `{access_token, refresh_token, name, user_role, username, expires_at}`
5. Frontend stores in localStorage:
   - `pt_user_meta` = `{name, role:user_role, username}` (compat with HR pattern)
   - `stock_access_token`, `stock_refresh_token`, `stock_token_exp`
6. Frontend redirects `/index.html` → role-based redirect to `admin.html` or `staff.html`

### 6.2 Refresh (client timer)
1. `shared/auth-jwt.js` schedules `setTimeout(refresh, exp - now - 5*60*1000)`
2. On fire, POST `auth-bridge` with `{action: 'refresh', refresh_token}`
3. Edge function:
   - SELECT `user_sessions WHERE refresh_token=? AND NOT revoked AND refresh_expires_at > now()`
   - if no row → 401
   - sign new JWT, generate new refresh_token (rotation), UPDATE row
4. Frontend re-runs `createSupabaseClient(new_access_token)` and schedules next refresh

### 6.3 Logout
1. POST `auth-bridge` with `{action: 'logout', refresh_token}`
2. Edge function UPDATEs `revoked=true`
3. Frontend clears localStorage, redirects `/login.html`

### 6.4 Concurrent sessions (Q8 = A)
Allowed. Each device/browser has its own `user_sessions` row; revoking one does not affect another.

### 6.5 JWT claim structure
```json
{
  "iss": "thegood-stock",
  "aud": "authenticated",
  "sub": "kavin.s",
  "role": "authenticated",
  "user_role": "Admin",
  "name": "นาย คาวิน",
  "username": "kavin.s",
  "jti": "9b1c…",
  "iat": 1747574400,
  "exp": 1747603200
}
```

### 6.6 Frontend public API
```js
await ensureLoggedIn();        // redirect /login.html if no token / refresh failed; resolves only when logged in
const sb = getSupabaseClient();
const role = getUserRole();    // 'Admin' | 'Employee'
const username = getUserUsername();
// requireRole redirects to /403.html on mismatch AND returns false, so callers can also short-circuit:
if (!requireRole('Admin')) return;
```

---

## 7. Edge Functions

### 7.1 `auth-bridge` (public)

Endpoint: `POST /functions/v1/auth-bridge`

| Action | Request | Response 200 | Errors |
|---|---|---|---|
| `login` | `{action,username,password}` | `{access_token,refresh_token,name,user_role,username,expires_at}` | 400 `missing_fields`, 401 `invalid_credentials`, 403 `account_inactive`, 502 `gas_unreachable` |
| `refresh` | `{action,refresh_token}` | `{access_token,refresh_token,expires_at}` | 401 `invalid_refresh` |
| `logout` | `{action,refresh_token}` | `{ok:true}` | — |
| `verify` | `{action,access_token}` | `{valid:true,username,user_role,name,jti}` | 401 `{valid:false,reason}` |

Env vars: `SUPABASE_JWT_SECRET` (auto), `SUPABASE_SERVICE_ROLE_KEY` (auto), `GAS_HR_URL`, `JWT_ACCESS_TTL_SECONDS=28800`, `JWT_REFRESH_TTL_SECONDS=2592000`.

### 7.2 `sync-ambulances` (Admin-only)

Endpoint: `POST /functions/v1/sync-ambulances`
Auth: `Authorization: Bearer <JWT>` with `user_role=Admin`.

Logic:
1. verify JWT (decode locally, check `user_role==='Admin'`)
2. SELECT `AMBULANCE_GAS_URL` FROM settings
3. fetch `<url>?action=listAmbulances`
4. expect JSON array `[{id, plate, callsign, ...}]`
5. **Safety check**: if the returned array is empty or fewer than 1 row, abort with 500 `empty_response` — do NOT mass-deactivate
6. UPSERT into `ambulances` keyed by `gas_id` (set `last_synced_at=now()`)
7. UPDATE `ambulances SET active=false WHERE gas_id NOT IN (...returned ids...)`
8. return `{ok:true, fetched, upserted, deactivated, duration_ms, last_synced_at}`

Errors: 401 unauthorized, 403 forbidden_not_admin, 500 `gas_unreachable`/`parse_error`.

### 7.3 `tg-notify` (internal/admin)

Endpoint: `POST /functions/v1/tg-notify`
Auth: either Admin JWT (manual test) OR service_role key + `X-Internal: true` header (from triggers/cron).

Body:
```json
{
  "event_type": "low_stock|expiry|overdue|oxygen_refill|manual",
  "entity_type": "stock_item|borrow|oxygen_tank|null",
  "entity_id":   "string",
  "dedupe_key":  "low_stock:sku-123:2026-05-18",
  "message":     "string",
  "payload":     {}
}
```

Logic:
1. If `NOTIFY_TELEGRAM_ENABLED=false` → return `{sent:false, reason:'disabled'}`
2. SELECT 1 FROM `notification_log WHERE dedupe_key=? AND sent_at > now() - interval 'LOW_STOCK_DEDUPE_HOURS hours'` — if hit, return `{sent:false, dedupe_hit:true}`
3. POST `NOTIFY_PROXY_URL/notify/send` (Cloudflare Worker) with `{case_id, alert_type, message, deep_link}`
4. INSERT into `notification_log` with `success` flag and any error message
5. return `{ok:true, sent:true|false, dedupe_hit, log_id}`

---

## 8. Frontend Pages

### 8.1 `login.html`
- Form: username, password
- Submit → `shared/auth.js` `handleLogin`
- Auto-redirect away if `stock_refresh_token` valid
- Styled with `shared/styles.css` login-view (blurred card on navy gradient)

### 8.2 `index.html`
- No UI; runs `ensureLoggedIn()` then redirects by `getUserRole()`
  - `Admin` → `admin.html`
  - `Employee` → `staff.html`
  - other → `403.html`

### 8.3 `admin.html` — 5 tabs

**Tab 1 — Dashboard (placeholder):**
Status panel listing readiness:
- Auth ✓ / DB connected ✓
- Locations count
- Ambulances count + last sync
- Telegram status (enabled/disabled)
- Note: "Stock + alert dashboard activates in Phase 1+"

**Tab 2 — Locations CRUD:**
- Tree view by parent_id, indented, with type icons (🏠 room, 📦 cabinet, 🪜 shelf, 🚑 ambulance, 🎒 bag)
- Filter: type, search by code/name, active toggle
- Modal for create/edit:
  - Type dropdown
  - Parent dropdown (filtered to allowable parents per type)
  - Code field with **Generate button** (Q4 = D):
    - room → next free letter `ROOM-{A,B,C…}`
    - cabinet → `CAB-{parent_suffix}-{n}` (`n` = max(child)+1)
    - shelf → `SHELF-{parent_suffix}-T{n}`
    - ambulance → `AMB-{plate_sanitized}` (only when ambulance_id selected)
    - bag → `BAG-ALS-{nnn}` (zero-padded next number)
  - Name field
  - QR payload (default = code, editable)
  - Note, Active
- Delete uses RESTRICT FK — show toast if children exist

**Tab 3 — Ambulances:**
- Table: Plate, Callsign, Status, "Has location?" column
- "Sync from GAS" button → calls `sync-ambulances`, shows result toast
- Click row → modal to create or link a `locations(type='ambulance', ambulance_id=...)` record

**Tab 4 — Settings:**
- Form bound to `settings` table
- Sections:
  - Telegram: enabled toggle, chat_id, cron hour, "Test send" button (calls `tg-notify` with `event_type=manual`)
  - Thresholds: dedupe hours, expiry days, oxygen refill threshold
  - External: AMBULANCE_GAS_URL
- "Save" button writes all changed rows in one batch

**Tab 5 — Sessions audit:**
- Table: User, Role, IP, User-Agent, Issued, Last seen, Revoke button
- Admin sees all rows; Employee would only see own (but Employee doesn't reach this tab)
- Revoke action UPDATEs `revoked=true`

### 8.4 `staff.html` (Q14 = A)
- Header with name + Logout
- Greeting + role badge
- Read-only browser:
  - "View locations" → renders the same tree as Tab 2 with CRUD hidden
  - "View ambulances" → list view, no Sync button
- Notice: "Scan / borrow workflow opens in Phase 1+"

### 8.5 `403.html`
Static message: "ไม่มีสิทธิ์เข้าถึงหน้านี้" + Logout link.

### 8.6 Color accent (Q13 = A)
Primary accent for buttons, links, active tab background: **Teal `#0d9488`** (Tailwind teal-600). Navy gradient header (`#1e3a5f → #0d6efd`) stays from `shared/styles.css`.

---

## 9. Service Worker (Q1 = A, Q15 = A)

`sw.js`:
- Install: precache `/login.html`, `/index.html`, `/admin.html`, `/staff.html`, `/403.html`, `/shared/styles.css`, `/shared/*.js`, `/assets/logo.png`
- Activate: clean old caches by version
- Fetch:
  - same-origin static: cache-first, fall back to network
  - Supabase REST/Functions/Realtime: network-first, no cache fallback
- No background sync in Phase 0 (skeleton only; Phase 1 wires the queue)
- No `manifest.json`, no install prompt — web-only per Q2

Versioning: bump `CACHE_VERSION` constant on every deploy that changes static files.

---

## 10. Error Handling

### Frontend
| Error | Behavior |
|---|---|
| Network offline | Toast "ไม่มีเครือข่าย — ลองใหม่อีกครั้ง"; SW serves cached static |
| JWT expired during request | Interceptor catches 401, calls refresh once, retries; if still 401 → redirect login |
| 403 RLS reject | Toast "ไม่มีสิทธิ์ทำรายการนี้" |
| 400 / 422 | Inline field error |
| 500 / 502 | Toast "ระบบขัดข้องชั่วคราว" + retry button; `console.error` with request_id |
| FK RESTRICT (delete with children) | Toast "ไม่สามารถลบได้ เพราะมีรายการลูก" |

### Edge Functions
Standard error shape: `{error: '<code>', details?: ...}`. Status codes: 400 bad request, 401 auth fail, 403 RBAC fail, 409 duplicate, 500 internal, 502 upstream (GAS).

### Database
- Unique violation → 409 from edge functions; UI inline error
- Trigger HTTP egress fail → row in `notification_log` with `success=false`; business txn still commits

---

## 11. Test Checklist (Q16 = A)

Manual checklist `docs/test-checklist.md`, run before declaring Phase 0 done.

**Auth (T1–T6):**
- T1: Login with correct creds → redirect by role
- T2: Wrong password → "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง"
- T3: Inactive user → "ไม่มีสิทธิ์เข้าถึง"
- T4: New tab after login → no re-login needed
- T5: Idle past 8h → refresh runs silently, still works
- T6: Logout → must re-login

**RBAC (T7–T10):**
- T7: Admin reaches admin.html
- T8: Employee at /admin.html → redirected to 403
- T9: Employee POST to locations via DevTools → RLS 403
- T10: Tamper localStorage role → still cannot insert (JWT unchanged)

**Locations (T11–T15):**
- T11: Create Room → Cabinet under Room → Shelf under Cabinet
- T12: Generator: Cabinet under ROOM-A proposes `CAB-A-1`; manual override OK
- T13: Duplicate code → 409 / inline error
- T14: type=ambulance without ambulance_id → DB check constraint blocks
- T15: Delete Room with children → RESTRICT → toast error

**Ambulance sync (T16–T18):**
- T16: Configure AMBULANCE_GAS_URL → click Sync → data populated
- T17: Bad URL → 502 toast
- T18: Remove 1 from GAS → re-sync → that row `active=false`

**Settings / Telegram (T19–T21):**
- T19: Set chat_id + enabled, click Test → message arrives in Telegram
- T20: Disable enabled → Test → "Telegram ปิดอยู่"
- T21: Bad chat_id → error returned, `notification_log` row with success=false

**Sessions audit (T22–T23):**
- T22: Employee sees own session only
- T23: Admin revokes a session → that user's next refresh → 401 → forced logout

**Smoke tests (`tools/smoke-test.sh`):**
1. `curl auth-bridge` with empty body → 400 `missing_fields`
2. `curl GAS_HR_URL` → response has `status` field
3. `curl <worker>/notify/health` → `{ok:true}`
4. `SELECT count(*) FROM settings` → ≥ 7

---

## 12. Deploy Procedure

### Bootstrap (one-time)
```bash
# Supabase project
supabase projects create thegood-stock --org-id <officethegood> --region ap-southeast-1
supabase link --project-ref <ref>

# Secrets
supabase secrets set GAS_HR_URL="https://script.google.com/macros/s/AKfycbx.../exec"
supabase secrets set JWT_ACCESS_TTL_SECONDS=28800
supabase secrets set JWT_REFRESH_TTL_SECONDS=2592000

# Migrations + extensions
supabase db push

# Functions
supabase functions deploy auth-bridge
supabase functions deploy sync-ambulances
supabase functions deploy tg-notify

# Repo
gh repo create officethegood/thegood-stock --public
git push -u origin main
# Settings → Pages → main branch / root
```

Take a `supabase db dump` snapshot before each production push (Q17 = B).

### Ongoing
- Frontend: `git push` → Pages deploys in ~30s
- Migrations: `supabase db push`
- Functions: `supabase functions deploy <name>`

### Rollback
- Frontend: `git revert HEAD && git push`
- Migrations: write a new "down" migration (do not edit historical files)
- Functions: redeploy previous git rev

### Logging (Q18 = A)
Built-in Supabase Function Logs only. `console.error` with a `request_id` for cross-reference.

---

## 13. External Dependency Changes Required

### 13.1 Add `doGet` to Thegood Ambulance GAS (Q10 = A)

The Ambulance web app at `https://script.google.com/macros/s/AKfycbwefEV0CebLwA-BUKfg1hwwMcpu_0AS33YIFV3P3qU6AZilKZy9FbHZs51xu5vu1mFH/exec` currently returns the dashboard HTML. We need a JSON endpoint.

A snippet to add (`docs/gas-ambulance-doget-snippet.md` will hold the exact code):

```js
function doGet(e) {
  const action = (e.parameter && e.parameter.action) || '';
  if (action === 'listAmbulances') {
    const sheet = SpreadsheetApp.openById('<ambulance-spreadsheet-id>')
                    .getSheetByName('<ambulance-sheet-name>');
    const rows = sheet.getDataRange().getValues();
    const headers = rows[0];
    const data = rows.slice(1).map(r => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = r[i]);
      return obj;
    });
    return ContentService.createTextOutput(JSON.stringify(data))
                         .setMimeType(ContentService.MimeType.JSON);
  }
  // existing dashboard render path
  return HtmlService.createHtmlOutputFromFile('Index');
}
```

The owner of the Ambulance GAS must apply this and redeploy. Stock spec assumes the response shape is a JSON array where each row has at least `id` (or `ambulance_id`), `plate`, `callsign`. Other fields are stored in `ambulances.raw`.

### 13.2 Cloudflare Worker `thegood-ocr-proxy`
No code change required. The existing `/notify/send` route is reused. We will add a new chat_id in Stock's settings table; the worker reads chat_id from request body so no worker secret change is needed (assuming the worker already accepts chat_id per request — verify in env-setup).

---

## 14. Open Questions / Risks

| Item | Risk | Mitigation |
|---|---|---|
| Ambulance GAS response shape | Unknown field names | Spec assumes `id`/`plate`/`callsign`; mismatch → confirm and adjust before plan write |
| Cloudflare Worker `/notify/send` payload contract | May need chat_id per request vs configured chat_id | Verify by curl during env-setup; adapt `tg-notify` accordingly |
| First HR role string variations | Only `Admin`/`Employee` per user, but Sheet may have casing variations | Edge function lowercases + maps; unknown roles → 403 `account_inactive`-ish error |
| GitHub Pages cache | New users may load stale `sw.js` for ~24h | Bump CACHE_VERSION on every deploy that changes static files |
| Supabase free tier limits | Edge function invocations 500k/mo | Phase 0 traffic is tiny; monitor before Phase 1 enables cron |

---

## 15. Decisions Log

| ID | Question | Decision |
|---|---|---|
| Phase split | 10 modules → how to decompose | Phase 0–6 ladder; Foundation first |
| Auth approach | GAS / Supabase JWT / HR-side token | **B' Hybrid**: GAS verify in Edge function, Supabase JWT to frontend |
| Ambulance list | API / Manual / Cron | Manual sync (admin button) |
| Repo location | Sub folder vs new repo | **New repo** `officethegood/thegood-stock` |
| Working dir | V.5 / cwd / worktree | cwd `F:\@Coding\ระบบ\The Good Stock\` |
| Supabase | new or reuse | **New** project `thegood-stock` |
| Style | Hospital theme variants | Match pt-medical V.5 `shared/styles.css` (Sarabun + navy gradient), teal accent |
| Roles | role string mapping | `Admin` and `Employee` direct from GAS |
| Q1 | Service Worker | Enabled from Phase 0 |
| Q2 | PWA install prompt | No — web-only |
| Q3 | Locations CRUD in Phase 0 | Full CRUD |
| Q4 | Location code | Manual OR Generate button |
| Q5 | Low-stock dedupe window | 24 hours |
| Q6 | user_sessions audit | Yes — keep |
| Q7 | JWT TTL | 8h access + 30d refresh |
| Q8 | Concurrent login | Allowed |
| Q9 | Edge function language | TypeScript on Deno |
| Q10 | Ambulance GAS endpoint | Add `doGet?action=listAmbulances` |
| Q11 | Trigger transport | `pg_net` direct |
| Q12 | Rate limit | None in Phase 0 |
| Q13 | Color accent | Teal `#0d9488` |
| Q14 | staff.html in Phase 0 | Read-only browse view |
| Q15 | SW scope | Cache-first static + network-first API |
| Q16 | Testing approach | Manual checklist + smoke script |
| Q17 | Migration rollback | DB snapshot + new "down" migration |
| Q18 | Logging | Built-in Supabase Function Logs |

---

## 16. Next Step

After this spec is approved by the user, hand off to `superpowers:writing-plans` to produce a step-by-step implementation plan from this design.
