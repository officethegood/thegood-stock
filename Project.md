# Thegood Stock — Project Status & Handoff to PM

> ⚠ **เอกสารนี้คือ snapshot ตอนส่งมอบ Phase 0 (2026-05-18)** — เก็บไว้เป็นประวัติ/บริบทการตัดสินใจ
> **สถานะปัจจุบันของระบบ (ทุก phase ขึ้น production แล้ว) ดูที่ [`docs/system-overview.md`](docs/system-overview.md)**
> ตารางสถานะ §2 ด้านล่างถูกอัปเดตแล้ว ส่วนอื่นคงไว้ตามต้นฉบับ

**Last updated:** 2026-07-15 (status refresh — เนื้อหาหลักคือ snapshot 2026-05-18)
**Phase:** ทุก phase (0–6 + งานต่อเนื่อง) — **LIVE บน production**
**Live URL:** https://officethegood.github.io/thegood-stock/login.html
**Login (test):** `admin / thegood`

---

## 1. Project goal

Mobile-first web app for **Thegood (ทีโฮกู๊ด)** to manage:
- Medication & medical supplies (stock + lots + expiry)
- Equipment borrow/return with photo proof
- ALS bags & medical kits with granular expiry
- Linens & laundry (count-based, photo-verified)
- Oxygen tanks (per-tank lifecycle: ready / on-board / refilling)

Single source of truth: scan QR/Barcode on mobile → record on Supabase → admin dashboard live + Telegram alerts.

**Important:** Thegood is a *different* organization from Supwilai. Their `pt-medical-system` (V1, on `officethegood/pt-medical-system` GitHub) and Supabase project are separate from Supwilai's. The Stock app is a brand-new app in its own repo and its own Supabase project — no shared infrastructure.

---

## 2. Scope (PDF, page-by-page)

Source: `~/Downloads/ระบบจัดการสต๊อกและอุปกรณ์การแพทย์.pdf` (provided by user 2026-05-18)

10 modules total, decomposed into 7 build phases:

| Phase | Module | Status |
|---|---|---|
| 0 | **Foundation** — auth + DB + locations + ambulances + settings + notification plumbing + admin shell | **LIVE** (18 พ.ค.) |
| 1 | General Inventory + Storage scanning + Low-stock alert | **LIVE** (พ.ค. 2026) |
| 2 | Medication lots + Expiry tracking + Expiry alerts (30/60/90d) | **LIVE** (พ.ค. 2026) — Q-D1 ผ่อนแล้ว 12 ก.ค.: เบิกล็อตหมดอายุได้เมื่อยืนยัน+เหตุผล |
| 3 | Equipment Borrow/Return with photo proof + Overdue alerts | **LIVE** (พ.ค. 2026) + จุดประสงค์การยืม (ก.ค.) |
| 4 | ALS Bags / Medical Kits with restock + granular expiry | **LIVE** (พ.ค. 2026) + กระเป๋าขึ้นรถ/คืน, ของจริงในกระเป๋า (ก.ค.) |
| 5 | Oxygen Tanks lifecycle + Refill batch alerts | **LIVE** (พ.ค. 2026) + สถานะที่ 6 `awaiting_refill` (29 พ.ค.) |
| 6 | Linens & Laundry (cabinet QR, count-based, photo) | **LIVE** (พ.ค. 2026) |
| 0.5 / 0.7 | QR print · Location hierarchy + Transfer | **LIVE** (19–20 พ.ค.) |

**สถานะละเอียด + สถาปัตยกรรมปัจจุบัน:** `docs/system-overview.md` · flow ผู้ใช้: `docs/flow-issue-borrow.md`

---

## 3. Tech stack & architecture

```
┌─────────────────────────────────────────────────────┐
│ Browser (Mobile-first, web-only — NO PWA install)   │
│ GitHub Pages: officethegood.github.io/thegood-stock │
│                                                     │
│ Bootstrap 5 + Sarabun + teal accent (#0d9488)       │
│ Vanilla JS, no build step                           │
└───────────────────┬─────────────────────────────────┘
                    │
        ┌───────────┴─────────────┐
        │ Supabase REST/RPC + JWT │
        └───────────┬─────────────┘
                    │
       ┌────────────┴──────────────┐
       │ Supabase `thegood-stock`  │
       │ (ap-southeast-1)          │
       │  Postgres + 5 tables + RLS│
       │  3 Edge Functions (Deno)  │
       └────────────┬──────────────┘
                    │
       ┌────────────┴──────────────┐
       ▼                            ▼
 ┌──────────┐         ┌─────────────────────────┐
 │ GAS HR   │         │ Cloudflare Worker:      │
 │ /exec    │         │ thegood-ocr-proxy       │
 │ (auth)   │         │ /notify/send → Telegram │
 └──────────┘         └─────────────────────────┘
       │
       │ (and Ambulance GAS for vehicle list — patched 2026-05-18)
       ▼
 ┌──────────────┐
 │ Ambulance    │
 │ Dashboard GAS│
 │ /exec        │
 │   ?action=   │
 │   listAmbu.. │
 └──────────────┘
```

### Key design decisions

| Decision | Value | Why |
|---|---|---|
| Auth | **B' Hybrid**: GAS HR verifies password → Edge `auth-bridge` issues HS256 JWT | Reuse existing HR identity, no duplicate user table |
| JWT crypto | **HS256 via Supabase Legacy JWT Secret** (env var `APP_JWT_HS_SECRET`) | New Supabase defaults to ECC P-256 but the project's legacy HS256 secret is still in PostgREST verify chain. Stored as custom secret because Supabase rejects `SUPABASE_*` prefixed custom names |
| Edge runtime | **Supabase Edge Functions (Deno + TypeScript)** | Co-located with DB; supports `pg_net` etc. for Phase 1+ triggers |
| Frontend | **Static HTML + ES module-free JS** | No build step; deploy = `git push`; mobile-friendly |
| Hosting | **GitHub Pages** off `main / (root)` | Free, fast, no infra to manage |
| DB | **Supabase Postgres** with RLS per-role (Admin / Employee) | Native security; PostgREST exposes all tables as REST |
| Realtime | **Supabase Realtime** (Phase 1+ only) | Stock/borrow changes need live update across devices |
| Telegram | **Reuse `thegood-ocr-proxy` Cloudflare Worker** (Phase 1+ only) | Same Worker used by HR/PT-Medical; Stock just sends its own chat_id |
| Photo | **Cloudinary** (Phase 1+ only) | Same account as HR (`ddummbyql`), folder prefix `thegood-stock/` |
| Service Worker | Cache-first static, network-first API | Offline static; **no install prompt** (user said web-only) |

### Why dashboard-only Supabase

User explicitly chose to **not install** Supabase CLI ("กลัวชนกับ repo ของ supwilai"). All Supabase work is done via web Dashboard:
- Migrations: paste SQL into SQL Editor → Run
- Edge Functions: paste TS into Functions editor → Deploy
- Secrets: Project Settings → Edge Functions → Secrets
- The Edge Function setting **"Verify JWT with legacy secret" must be OFF** on all 3 functions (because we use new-format publishable keys, not legacy JWT anon keys).

---

## 4. Resource catalog

### 4.1 GitHub
- **Repo:** [officethegood/thegood-stock](https://github.com/officethegood/thegood-stock)
- **Branch:** `main`
- **Pages URL:** https://officethegood.github.io/thegood-stock/login.html
- **Tags:**
  - `phase0-foundation` — initial Phase 0 deploy
  - `phase0.1-ambulance-sync` — after Ambulance GAS patch + CORS fix
- **Local clone:** `F:\@Coding\ระบบ\The Good Stock\`
- **Commits to date:** 42 on `main` (verified by PM 2026-05-18 via `git rev-list --count HEAD` at commit `0098daa`)

### 4.2 Supabase
- **Project name:** `thegood-stock`
- **Org:** `officethegood`
- **Region:** Southeast Asia (Singapore) — `ap-southeast-1`
- **Project ref:** `xtjsjrfixngfdkaahton`
- **Project URL:** `https://xtjsjrfixngfdkaahton.supabase.co`
- **Publishable key (anon, frontend):** `sb_publishable_Ftlp8-FOgBahQpwnqd-FIQ_80ia_WTb` (already in `shared/config.js`)
- **Plan:** Free / NANO
- **JWT signing key in use for our auth-bridge:** Legacy HS256 (stored as custom secret `APP_JWT_HS_SECRET`)

### 4.3 Tables (all in `public` schema, RLS enabled)

| Table | Purpose |
|---|---|
| `ambulances` | Synced from Ambulance GAS via manual button. Columns: `gas_id`, `plate`, `callsign`, `active`, `raw` jsonb, `last_synced_at` |
| `locations` | Multi-level hierarchy. `type` enum ปัจจุบัน: room/**storage**/shelf/**bin**/**zone**/ambulance/bag (`cabinet` deprecated — Phase 0.7 แทนด้วย storage+storage_style) + คอลัมน์เพิ่มภายหลัง: `bag_template_id`, `laundry_role`, `storage_style`. `parent_id` recursive, `ambulance_id` link, `code` unique, CHECK enforces ambulance↔ambulance_id |
| `settings` | Key-value: `NOTIFY_TELEGRAM_ENABLED`, `NOTIFY_TELEGRAM_CHAT_ID`, `NOTIFY_CRON_HOUR`, `LOW_STOCK_DEDUPE_HOURS`, `EXPIRY_ALERT_DAYS`, `OXYGEN_REFILL_THRESHOLD`, `AMBULANCE_GAS_URL` |
| `notification_log` | Audit + dedupe of Telegram sends. `dedupe_key`, `event_type`, `success`, `error` |
| `user_sessions` | Per-device JWT sessions. `jwt_jti` unique, `refresh_token` unique, `revoked` flag |

RLS pattern: `authenticated` role SELECT, `app_user_role() = 'Admin'` for write. `notification_log` insert via service_role only. `user_sessions` SELECT own or Admin, UPDATE Admin only.

### 4.4 Edge Functions (Deno TS, all CORS-allowed for browser)

| Function | Purpose | Auth |
|---|---|---|
| `auth-bridge` | `POST {action: login\|refresh\|logout\|verify}` — verifies via GAS HR, issues HS256 JWT signed with `APP_JWT_HS_SECRET` | Public for `login`, `refresh`, `logout`; access_token for `verify` |
| `sync-ambulances` | `POST` — Admin pulls Ambulance GAS data and upserts into `ambulances` table | Admin JWT |
| `tg-notify` | `POST {event_type, dedupe_key, message, ...}` — proxies to Cloudflare Worker after dedupe check | Admin JWT OR service_role + `X-Internal: true` |

All 3 deployed with "Verify JWT with legacy secret" toggle **OFF** (configured in Function Settings UI per function).

### 4.5 Edge Function secrets (5 custom + Supabase auto-provided)

Set via Dashboard → Project Settings → Edge Functions → Secrets:

| Key | Value | Notes |
|---|---|---|
| `APP_JWT_HS_SECRET` | 88-char legacy JWT secret | Revealed from Settings → JWT Keys → Legacy JWT Secret tab |
| `GAS_HR_URL` | `https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec` | HR auth verifier |
| `JWT_ACCESS_TTL_SECONDS` | `28800` | 8 hours |
| `JWT_REFRESH_TTL_SECONDS` | `2592000` | 30 days |
| `NOTIFY_PROXY_URL` | `https://thegood-ocr-proxy.officethegood.workers.dev` | Reuses HR notification proxy |

Auto-provided by Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (deprecated but still works), `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_JWKS`.

### 4.6 External services

- **HR GAS:** `https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec` (read-only consumer — already verified). Code lives in user's separate HR System V3 GAS project.
- **Ambulance GAS:** `https://script.google.com/macros/s/AKfycbwefEV0CebLwA-BUKfg1hwwMcpu_0AS33YIFV3P3qU6AZilKZy9FbHZs51xu5vu1mFH/exec`
  - **Patched 2026-05-18 (version 13)** — `doGet(e)` now dispatches on `e.parameter.action`:
    - `listAmbulances` → returns JSON array `[{id, plate, callsign}]` (deduped from `getAmbulanceData()` results, mapped by vehicle code TG1/TG2/TG4/TG6)
    - default → returns the existing HTML Dashboard (unchanged)
  - Project URL: `https://script.google.com/home/projects/1jRO4n_eX-eMZbq5NiWODXFE6-cvEtjBOwjT9OS1HFzPK016lyZZMb3DO/edit`
- **Cloudinary:** account `ddummbyql`, upload preset `pt-medical`, Stock-side folder prefix `thegood-stock/` (Phase 1+ uses for borrow/return photos and laundry).
- **Cloudflare Worker for Telegram:** `thegood-ocr-proxy.officethegood.workers.dev` — already deployed and shared with HR System. We just need to configure `NOTIFY_TELEGRAM_CHAT_ID` in `settings` table and turn `NOTIFY_TELEGRAM_ENABLED=true`.

---

## 5. What's been built (Phase 0 deliverables)

### 5.1 Frontend (24 code files: 5 HTML + 8 js/ + 10 shared/ + 1 sw.js — verified by PM 2026-05-18)
- `login.html` + `js/login.js` — Sarabun font, navy gradient background, teal accent button
- `index.html` — auth check + role-based redirect to admin.html or staff.html
- `admin.html` + `js/admin-shell.js` — top nav, 5 tabs with lazy init
- `staff.html` + `js/staff-home.js` — Employee landing with read-only browse
- `403.html` — no-access page with logout button
- Admin tabs:
  - `js/dashboard.js` — Phase 0 status panel (Auth/DB/Locations/Ambulances/Telegram)
  - `js/locations.js` — tree view, modal CRUD, Generate-code button (ROOM-A, CAB-A-1, SHELF-A1-T1, AMB-{plate}, BAG-ALS-001)
  - `js/ambulances.js` — table view + "Sync from GAS" button
  - `js/settings-ui.js` — settings form + "Test Telegram" button
  - `js/sessions-ui.js` — sessions audit + revoke button
- Shared (`shared/`):
  - `config.js` — Supabase URL + publishable key + endpoint paths
  - `auth.js` — localStorage session, handleLogin/handleLogout, requireRole
  - `auth-jwt.js` — JWT refresh timer (fires 5min before expiry)
  - `supabase-client.js` — client factory with auto JWT header injection
  - `ui.js` — toast, showConfirm modal, escapeHtml
  - `settings.js` — settings table cache + getter/setter
  - `notify.js` — wrapper around `tg-notify` Edge fn
  - `cloudinary.js` — upload helper (Phase 1+)
  - `realtime.js` — subscription helper skeleton (Phase 1+)
  - `styles.css` — copied from pt-medical V.5 + teal accent overrides
- `sw.js` — Service Worker (cache-first static, network-first for `*.supabase.co` and `*.workers.dev`)

### 5.2 Database (7 migrations)
- `20260518000000_init.sql` — extensions (pgcrypto, pg_net), helper functions (`app_user_role()`, `app_username()`, `set_updated_at()`)
- `20260518000100_ambulances.sql`
- `20260518000200_locations.sql` — includes `location_type` enum and CHECK constraint
- `20260518000300_settings.sql` — table + 7 seed rows
- `20260518000400_notification_log.sql`
- `20260518000500_user_sessions.sql`
- `20260518000600_rls_policies.sql` — 11 policies across 5 tables

### 5.3 Documentation (`docs/`)
- `superpowers/specs/2026-05-18-phase0-foundation-design.md` — full design spec (Q1–Q18 decisions log)
- `superpowers/plans/2026-05-18-phase0-foundation-plan.md` — 46-task implementation plan
- `gas-ambulance-doget-snippet.md` — snippet that was applied to Ambulance GAS
- `env-setup.md` — secrets + config setup
- `deploy.md` — Dashboard-based deploy procedure
- `test-checklist.md` — T1–T23 manual test checklist

### 5.4 Tools
- `tools/smoke-test.sh` — post-deploy health check (auth-bridge, GAS HR, Worker, settings count)
- `tools/snapshots/baseline-phase0.sql` — DB schema dump baseline

---

## 6. Verified end-to-end

| Test | Status | Details |
|---|---|---|
| T1 Login | ✅ | `admin/thegood` → admin.html as Admin (re-confirmed by PM Chrome MCP 2026-05-18) |
| T2 Wrong password | ✅ | PM Chrome MCP 2026-05-18: wrong pwd → exact text "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง" |
| T6 Logout | ✅ | PM Chrome MCP 2026-05-18: logout → login.html, F5 → still login.html (no auto-login) |
| T11 Locations CRUD | 🟡 | Claude Code created ROOM-A "ห้องคลังหลัก" via Generate. PM 2026-05-18 verified display + CRUD buttons; full nested-create not re-executed to avoid leaving test data |
| T16 Ambulance sync | ✅ | 4 ambulances upserted (TG1, TG2, TG4, TG6) from Ambulance Dashboard GAS (tag `phase0.1-ambulance-sync`) |
| T22 Sessions audit | ✅ | PM Chrome MCP 2026-05-18: Sessions tab shows current active + previous revoked admin sessions correctly |

Full test status: see `docs/test-checklist.md` — 5 fully verified, 3 partial/soft-pass, 4 blocked (need creds/data), 11 pending low-priority edge cases.

---

## 7. Pending (for PM to complete Phase 0 verification)

### 7.1 T19 Telegram alerts (5 min)
1. Get a Telegram chat_id for Stock alerts (create new chat or reuse a group)
2. Confirm `thegood-ocr-proxy.officethegood.workers.dev` Worker has the right Telegram bot token in its environment — talk to whoever maintains the Worker
3. In Stock Admin → Settings tab:
   - Enter the chat_id in `Chat ID`
   - Toggle `เปิดใช้งานการแจ้งเตือน` to ON
   - Click "บันทึกการตั้งค่า"
   - Click "ทดสอบส่ง Telegram"
4. Expected: toast "ส่งสำเร็จ ตรวจ Telegram chat" + message appears in the chat

### 7.2 T2/T6/T8 interactive (5 min)
- **T2** Wrong password: Logout → try `admin/wrong` → error "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง"
- **T6** Logout: ปุ่ม "ออก" → กลับมา `login.html` → ลอง refresh → ยังต้อง login ใหม่
- **T8** Employee role: Create a user in HR Sheet with role="Employee" → login → confirm redirect to `staff.html`; manually navigate to `/admin.html` → should redirect to `/403.html`

### 7.3 Link Ambulances to Locations (optional UX polish)
The Ambulances table has a `+ Location` action that currently shows a toast "ไปที่แท็บ Locations แล้วเลือก type=ambulance". To wire it directly: in `js/ambulances.js`, change that handler to open the Locations modal with `type=ambulance` and `ambulance_id` pre-selected. Small QoL fix.

---

## 8. Quirks / gotchas

1. **`shared/config.js` SUPABASE_ANON_KEY uses NEW-format publishable key** (`sb_publishable_*`), not legacy JWT anon. This is correct for new Supabase projects.

2. **Edge Functions: "Verify JWT with legacy secret" toggle must stay OFF.** It's on by default after deploy. If a function ever stops working with 401 errors before our code runs, check this setting first. With it ON, the runtime tries to validate the `Authorization` header as a legacy-secret-signed JWT before our code runs — but publishable keys aren't JWTs, so it rejects.

3. **CORS preflight: include `apikey` in `Access-Control-Allow-Headers`.** Frontend sends both `Authorization: Bearer <JWT>` AND `apikey: <publishable>`. If `apikey` isn't allowed, preflight fails silently and `fetch` throws "Failed to fetch". (Fixed in `sync-ambulances` + `tg-notify` on 2026-05-18.)

4. **Ambulance GAS returns deduped vehicle list, not raw rows.** The Dashboard's `getAmbulanceData()` returns nested `{vehicle, role, rows}` arrays. The patched `doGet listAmbulances` branch dedupes by `vehicle` and returns `[{id, plate, callsign}]` — currently 4 entries (TG1/TG2/TG4/TG6). If PM wants real plate numbers, the Ambulance Dashboard's source sheet would need to provide them and the dedupe function should be reworked.

5. **Default git branch was `master` on first commit.** Renamed to `main` before pushing (`git branch -M main`). Don't recreate the repo expecting master.

6. **CRLF warnings on Windows.** Git warns on every commit (Windows `core.autocrlf=true`). Cosmetic only — files are LF on Linux/macOS clones.

7. **The Phase 0 plan file references `supabase` CLI commands** in some tasks (originally written before user chose Dashboard-only path). When using the plan as reference, translate those to Dashboard actions per `docs/deploy.md`.

8. **`pt_user_meta` localStorage key is shared with pt-medical V.5.** This is intentional — preserves compatibility if user navigates between Thegood apps in the same browser. JWT keys (`stock_access_token` etc.) are Stock-specific.

9. **Phase 1 deployment deviation: `ALTER DATABASE postgres SET app.*` is not permitted via Supabase's `pg-meta` API or the dashboard SQL editor on Free/Nano plans** (ERROR 42501: `permission denied to set parameter "app.supabase_url"`). The original spec for the low-stock trigger expected `current_setting('app.supabase_url')` + `current_setting('app.service_role_key')`. Resolution: the trigger function (`check_low_stock` in `20260518010500_stock_triggers.sql`) now reads from the Phase 0 `settings` table — keys `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` — seeded by `20260518010700_notify_settings.sql`. The deploy operator (or future Admin → Settings UI) must populate the two values; trigger WARN-and-skips the pg_net call if they're empty. End-to-end DB→Edge path verified 2026-05-18: trigger fired, `tg-notify` returned `{ok:true,sent:false,reason:"disabled"}` (Telegram not enabled yet, but plumbing works).

---

## 9. How to continue (PM playbook)

### For Phase 1+ feature work
Follow the same pattern that produced Phase 0:

1. **Brainstorm** — use `superpowers:brainstorming` skill or equivalent. Confirm requirements, decisions, edge cases with end users (Thai/Thegood medical staff).
2. **Spec** — write to `docs/superpowers/specs/YYYY-MM-DD-<phase-name>-design.md` covering: architecture, schema, edge functions, UI, error handling, test checklist, decisions log.
3. **Plan** — write to `docs/superpowers/plans/YYYY-MM-DD-<phase-name>-plan.md` with bite-sized tasks, exact file paths, and code blocks ready to paste.
4. **Implement** — fresh subagent per task (or batch related tasks like in Phase 0); push small commits with `feat(<area>): ...` messages.
5. **Deploy** — Frontend `git push` (GitHub Pages ~30s). Migrations via SQL Editor. Edge Functions via Dashboard editor + remember to turn OFF "Verify JWT with legacy secret".
6. **Verify** — manual checklist per phase. Tag when stable: `phaseN-<short>`.

### For bug fixes / small changes
- Edit local file → commit → push (Pages auto-deploys frontend)
- For Edge Function: also paste the new code into Dashboard editor and "Deploy updates"
- For schema: write new migration file under `supabase/migrations/`, then paste into SQL Editor and Run

### For Telegram / Cron / Realtime (Phase 1+ activation)
- Cron: `pg_cron` extension via SQL Editor: `CREATE EXTENSION pg_cron; SELECT cron.schedule(...);`
- Realtime: per table: `ALTER PUBLICATION supabase_realtime ADD TABLE <name>;`
- Notify trigger pattern (from spec): trigger calls `tg-notify` via `pg_net` HTTP request with `X-Internal: true` + service_role key

### Key files to know
| File | Purpose |
|---|---|
| `shared/config.js` | Single source of truth for URLs and keys. Edit here when migrating projects. |
| `shared/auth.js` + `shared/auth-jwt.js` | Auth flow. Don't refactor without understanding the localStorage key contract `__authKeys`. |
| `supabase/migrations/` | Schema history. Append-only. New migrations need timestamp filename. |
| `supabase/functions/<name>/index.ts` | Edge Function source. Inline imports (no import_map dep) for Dashboard-portability. |
| `js/admin-shell.js` | Tab routing for admin. Add new tabs here. |
| `sw.js` STATIC_ASSETS array | Add new HTML/JS files here for offline cache. Bump `CACHE_VERSION` when changing. |

---

## 10. Decisions log (compact)

| ID | Question | Decision |
|---|---|---|
| Q1 | Service Worker enabled Phase 0? | Yes (cache-first static) |
| Q2 | PWA installable? | **No** — web-only per user request |
| Q3 | Locations CRUD in Phase 0? | Full CRUD |
| Q4 | Location code source | Manual OR Generate button |
| Q5 | Low-stock dedupe window | 24 hours |
| Q6 | user_sessions audit | Yes — keep |
| Q7 | JWT TTL | 8h access + 30d refresh |
| Q8 | Concurrent login | Allowed |
| Q9 | Edge function language | TypeScript on Deno |
| Q10 | Ambulance GAS endpoint | Add `doGet?action=listAmbulances` (done 2026-05-18 v13) |
| Q11 | Trigger transport | `pg_net` direct |
| Q12 | Rate limit | None in Phase 0 |
| Q13 | Color accent | Teal `#0d9488` |
| Q14 | staff.html in Phase 0 | Read-only browse view |
| Q15 | SW scope | Cache-first static + network-first API |
| Q16 | Testing approach | Manual checklist + smoke script |
| Q17 | Migration rollback | DB snapshot + new "down" migration |
| Q18 | Logging | Built-in Supabase Function Logs only |
| Auth-B1 | JWT signing for Edge Function | **HS256 with Supabase Legacy JWT Secret** stored as custom secret `APP_JWT_HS_SECRET` (user chose Option B then practical-B1 path) |
| Dashboard-only | CLI install | No CLI — all Supabase work via web Dashboard |

---

## 11. Memory files (Claude Code auto-loaded)

These are in the user's local Claude memory and load automatically in future sessions:
- `thegood-vs-supwilai.md` — Thegood (V1, officethegood) and Supwilai (V2) are separate codebases
- `feedback-dashboard-only-supabase.md` — Dashboard-only workflow for Stock
- `project-thegood-stock-phase0-live.md` — Phase 0 live state + Ambulance GAS patch + CORS fix notes

---

**[Historical] Ready for PM hand-off. Phase 0 is operational; Phases 1–6 are the open work.**
*(2026-07-15: ทุก phase ขึ้น production แล้ว — สถานะปัจจุบันดู `docs/system-overview.md`)*
