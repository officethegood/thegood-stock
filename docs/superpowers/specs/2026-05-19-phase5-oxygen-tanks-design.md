# Phase 5 — Oxygen Tanks Lifecycle Design

**Project:** Thegood Stock Management System
**Phase:** 5 (Oxygen Tanks Lifecycle + Refill Batch Alerts)
**Date:** 2026-05-19
**Author:** Business/System Analyst
**Status:** DRAFT — pending PM review. Six open questions in §11 need PM decisions before plan write-up.
**Predecessor:** `docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md` (Phase 2 locked)
**Source PDF:** `ระบบจัดการสต๊อกและอุปกรณ์การแพทย์.pdf` §5 (Oxygen Tanks)

---

## 1. Purpose & Scope

### 1.1 Why Phase 5 is structurally distinct

Phases 1–4 use the `stock_items` + `stock_item_locations` + `stock_movements` family where a **SKU** is the identity and **quantity** is the tracked unit. You receive 100 gauze pads; you issue 5; you now have 95. No individual piece has an identity.

Oxygen tanks are fundamentally different: every physical cylinder has a **manufacturer serial number engraved on it**. The organisation needs to know where *this specific tank* is, whether it has been refilled, and when it is next due for hydrostatic inspection. The concept of "30 tanks at ROOM-A" is meaningless for compliance — what matters is that tank `OXY-0042` is `on_board` TG4 and is due for inspection in 90 days.

For this reason:
- **`oxygen_tanks` is a separate, standalone table.** It is NOT a child, extension, or variant of `stock_items`.
- `oxygen_movements` (the state-change ledger) is similarly standalone, analogous to `stock_movements` in purpose but tracking **status transitions**, not quantity changes.
- The existing `stock_items` / `stock_item_locations` / `stock_movements` tables are **not modified** in Phase 5.

This architectural decision was explicitly deferred in Phase 1 (spec §10, row "Phase 5 oxygen: separate `oxygen_tanks` table — not a child of `stock_items`; decision Q-Phase1-D").

### 1.2 In scope (Phase 5)

- New table `oxygen_tanks` — per-serial lifecycle tracking
- New ledger `oxygen_movements` — immutable state-transition audit trail
- State machine implemented as a `BEFORE INSERT` trigger on `oxygen_movements` (mirrors Phase 2 `check_lot_status` pattern)
- Refill-batch threshold alert: when the count of `status='refilling'` tanks reaches `OXYGEN_REFILL_THRESHOLD` (already seeded in `settings` table in Phase 0), post a Telegram alert with grouped tank list; deduped via `notification_log` (same Phase 0 plumbing)
- `pg_net` trigger on `oxygen_movements` (AFTER INSERT, `to_status='refilling'`) — reads URL/key from `settings` table (Phase 1 deviation pattern, Project.md §8 gotcha 9)
- New admin tab section "ถังออกซิเจน" — list all tanks, filter by status, drill to history
- Staff flow: scan/type tank serial → see current status → log a transition
- Dashboard panel "สถานะถังออกซิเจน" — count per status, badge on refill-batch threshold
- RLS: Admin full write, Staff INSERT-only on `oxygen_movements` with allowed transition set, both can SELECT
- Acceptance tests T101–T120

### 1.3 Out of scope (defer — see §10 for full list)

- Per-tank pressure history trend (Phase 5.1)
- Hydrostatic test cron alerts (Phase 5.1)
- Vendor refill SLA / turnaround tracking
- Integration with ambulance check-in system (Phase 6+)
- Acquisition cost / asset value tracking (TBD — see §11 Q5)
- Bulk tank import from spreadsheet

---

## 2. Architecture

Phase 5 is purely additive. No Phase 0–4 surface changes.

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (mobile-first)                                             │
│  GitHub Pages: officethegood.github.io/thegood-stock                │
│                                                                     │
│  Admin (admin.html, NEW section "ถังออกซิเจน" in nav)              │
│   ├─ Tank list (filter by status)    ──── Realtime: oxygen_tanks   │
│   ├─ Tank detail + history modal     ──── Realtime: oxygen_tanks   │
│   ├─ Add / Edit tank form                                           │
│   └─ Dashboard panel "สถานะถังออกซิเจน"                           │
│                                                                     │
│  Staff (staff-scan.html extended OR new staff-oxygen.html — TBD)  │
│   └─ Scan serial → view status → log transition                    │
└───────────────────────────┬────────────────────────────────────────┘
                            │
             ┌──────────────┴──────────────┐
             │ Supabase REST/RPC + Realtime │
             └──────────────┬──────────────┘
                            │
             ┌──────────────┴──────────────────────────┐
             │ Postgres (thegood-stock)                 │
             │  ── Phase 0–4 tables (UNCHANGED)         │
             │  ── Phase 5 NEW tables:                  │
             │     oxygen_tanks                         │
             │     oxygen_movements                     │
             │  ── Phase 5 NEW triggers:                │
             │     trg_oxygen_state_machine (BEFORE INS │
             │       on oxygen_movements)               │
             │     trg_oxygen_refill_alert (AFTER INS   │
             │       on oxygen_movements where          │
             │       to_status='refilling')             │
             └──────────────────────────────────────────┘
                            │
             ┌──────────────┴──────────────┐
             │ Edge Functions (Phase 0 / no │
             │ new function in Phase 5)     │
             │  ├─ auth-bridge    [Phase 0] │
             │  ├─ sync-ambulances[Phase 0] │
             │  └─ tg-notify  [Phase 0;     │
             │     event_type='oxygen_      │
             │     refill_batch' caller]    │
             └──────────────────────────────┘
                            │
             ┌──────────────┴──────────────┐
             │ Cloudflare Worker            │
             │ thegood-ocr-proxy            │
             │ (unchanged)                  │
             └──────────────────────────────┘
```

### Key Phase 5 principles

| Principle | How it shows up |
|---|---|
| **Separate identity model** | `oxygen_tanks` never references `stock_items`. Each row is one physical cylinder. |
| **State machine in DB** | The `BEFORE INSERT` trigger on `oxygen_movements` is the authoritative gatekeeper; UI enforces the same rules but the DB is the last line. |
| **Movements ledger immutable** | `oxygen_movements` rows are INSERT-only (no UPDATE, no DELETE). Status history is reconstructed by reading the ledger in order. |
| **Trigger reads settings** | Same deviation as Phase 1 (Project.md §8 gotcha 9): pg_net POST uses `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from `settings` table; WARN-and-skip if empty. |
| **No new Edge Function** | `tg-notify` Edge Function (Phase 0) is reused with a new `event_type='oxygen_refill_batch'`. |
| **Cloudinary folder** | If photo proof is enabled (see §11 Q4), folder prefix is `thegood-stock/oxygen/{tank_serial}/`. Phase 3 Borrow/Return is being specced in parallel and uses `thegood-stock/borrow/{item_sku}/`; no collision. |

---

## 3. Sync Strategy (extends Phase 0 table, rows 28–32)

Rows 1–27 from prior phases are unchanged.

| # | Data | Type | Mechanism | Cadence | Phase |
|---|---|---|---|---|---|
| 1–11 | (Phase 0–4 rows — unchanged) | — | — | — | 0–4 |
| 28 | **Tank status board** | **Realtime** | Postgres replication → WS on `oxygen_tanks` | live | **5** |
| 29 | **Oxygen movements** | **Request-Response** | Supabase REST INSERT → `oxygen_movements` → trigger updates `oxygen_tanks.status` | per transition | **5** |
| 30 | **Refill-batch alert** | **Autosync (trigger + dedupe)** | AFTER INSERT on `oxygen_movements` with `to_status='refilling'` → trigger counts `status='refilling'` rows → if count >= `OXYGEN_REFILL_THRESHOLD` → `pg_net` POST to `tg-notify` with `dedupe_key='oxygen_refill:<date>'` | event-driven | **5** |
| 31 | **Tank history drill-down** | **Request-Response** | Supabase REST SELECT on `oxygen_movements` filtered by `tank_id`, ordered by `performed_at DESC` | per open | **5** |
| 32 | **Tank serial scan lookup** | **Request-Response** | Supabase REST SELECT on `oxygen_tanks` with `.eq('serial', scanned_value)` | per scan | **5** |

**Realtime topics enabled in Phase 5:**
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE oxygen_tanks;
-- oxygen_movements NOT in realtime (noisy ledger; detail loaded on demand).
```

---

## 4. Repository Structure (new files only)

Phase 0–4 layout is unchanged. Phase 5 adds:

```
thegood-stock/
│
├── js/
│   ├── oxygen.js                                          (NEW — admin "ถังออกซิเจน" tab: list, filter, add/edit form)
│   ├── oxygen-history.js                                  (NEW — tank detail + movement history modal)
│   └── admin-shell.js                                     (EDIT — register "ถังออกซิเจน" nav item; no other change)
│
├── shared/
│   ├── oxygen-client.js                                   (NEW — REST helpers: listTanks, getBySerial, logTransition)
│   └── (unchanged Phase 0–4 modules)
│
├── staff-oxygen.html                                      (NEW — mobile staff scan-and-transition flow)
│                                                          (ASSUMPTION: separate page vs extending staff-scan.html
│                                                           — see §11 Q6)
├── js/
│   └── staff-oxygen.js                                    (NEW — staff serial scan flow)
│
├── supabase/
│   └── migrations/
│       ├── 20260519050000_oxygen_tank_status_enum.sql     (NEW — enum type)
│       ├── 20260519050100_oxygen_tanks.sql                (NEW — main table)
│       ├── 20260519050200_oxygen_movements.sql            (NEW — ledger table)
│       ├── 20260519050300_oxygen_triggers.sql             (NEW — state machine + refill alert triggers)
│       ├── 20260519050400_oxygen_rls.sql                  (NEW — admin/staff RLS policies)
│       └── 20260519050500_oxygen_realtime.sql             (NEW — publication ALTER)
│
├── sw.js                                                  (EDIT — add new HTML/JS; bump CACHE_VERSION)
│
└── docs/
    ├── superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md    (this file)
    └── superpowers/plans/2026-05-19-phase5-oxygen-tanks-plan.md      (NEXT step — not yet written)
```

**Migration timestamp rationale:** Phase 5 migrations use prefix `20260519050000` to avoid collision with Phase 2 (`20260519010000`), Phase 1.1 (`20260519020000`), and any Phase 3/4 migrations that use `20260519030000`/`20260519040000`.

---

## 5. Data Model

### 5.1 Enum `oxygen_tank_status` (`20260519050000_oxygen_tank_status_enum.sql`)

```sql
CREATE TYPE oxygen_tank_status AS ENUM (
  'ready',        -- in storage, full, ready to deploy
  'on_board',     -- loaded on an ambulance, in use
  'refilling',    -- returned empty, sent to refill vendor
  'maintenance',  -- pulled for maintenance (hydrostatic test, repair, etc.)
  'retired'       -- permanently taken out of service (terminal state)
);
```

**Note:** `maintenance` is currently a single state. Whether it should carry a sub-reason (e.g. `maintenance:hydro_test` vs `maintenance:repair`) is an open question — see §11 Q3.

### 5.2 Table `oxygen_tanks` (`20260519050100_oxygen_tanks.sql`)

```sql
CREATE TABLE oxygen_tanks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial               text UNIQUE NOT NULL,
    -- Manufacturer serial number engraved on the cylinder. The only globally-unique
    -- physical identifier. Staff scans or types this value.
  tank_size            text NOT NULL CHECK (tank_size IN ('small','medium','large')),
    -- ASSUMPTION: 3-size enum per common pre-hospital practice.
    -- See §11 Q1 — PM must confirm or extend.
    -- Implemented as CHECK on text (not a CREATE TYPE) to allow easy extension
    -- via ALTER TABLE ... CHECK (tank_size IN (...)) without enum DDL migration.
  current_location_id  uuid REFERENCES locations(id) ON DELETE RESTRICT,
    -- Where the tank is physically right now. NULL only during initial INSERT before
    -- location is assigned. NOT NULL enforced by application; DB allows NULL only to
    -- permit atomic creation before the first oxygen_movements transition row.
    -- ASSUMPTION: location must already exist in the `locations` table (Phase 0).
  status               oxygen_tank_status NOT NULL DEFAULT 'ready',
    -- Authoritative current status. Updated ONLY by the update_oxygen_tank_from_movement
    -- trigger function (AFTER INSERT on oxygen_movements). Never updated directly by
    -- application code — doing so would bypass the state machine and leave no audit row.
  last_refill_at       timestamptz,
  last_refill_by       text,
    -- Free-text: name of staff or vendor who completed the refill.
  last_pressure_psi    int CHECK (last_pressure_psi IS NULL OR last_pressure_psi > 0),
    -- Optional: most recent pressure reading in PSI. No history kept here (Phase 5.1).
  next_inspection_due  date,
    -- Date the tank must be inspected next (hydrostatic test compliance).
    -- Hydrostatic test cron alerts deferred to Phase 5.1.
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           text NOT NULL DEFAULT app_username(),
  updated_by           text NOT NULL DEFAULT app_username()
);

-- Auto-update updated_at on any row change
CREATE TRIGGER trg_oxygen_tanks_updated_at
  BEFORE UPDATE ON oxygen_tanks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  -- set_updated_at() is the Phase 0 helper already deployed.

COMMENT ON TABLE oxygen_tanks IS
  'One row per physical oxygen cylinder. Identity is the serial number engraved on the '
  'cylinder. Status is maintained by the state-machine trigger on oxygen_movements. '
  'NOT a child of stock_items — see Phase 5 spec §1.1.';
```

### 5.3 Table `oxygen_movements` (`20260519050200_oxygen_movements.sql`)

```sql
CREATE TABLE oxygen_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tank_id          uuid NOT NULL REFERENCES oxygen_tanks(id) ON DELETE RESTRICT,
  from_status      oxygen_tank_status,
    -- NULL only for the first movement (initial creation / first placement).
  to_status        oxygen_tank_status NOT NULL,
  from_location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_id   uuid REFERENCES locations(id) ON DELETE RESTRICT,
    -- from_ and to_ location may be the same (e.g. maintenance at same location).
  performed_by     text NOT NULL DEFAULT app_username(),
  performed_at     timestamptz NOT NULL DEFAULT now(),
  note             text,
  photo_url        text,
    -- Optional Cloudinary URL. Folder prefix: thegood-stock/oxygen/{serial}/
    -- See §11 Q4 re: required vs optional.
    -- Phase 3 Borrow/Return uses thegood-stock/borrow/ — no conflict.
  created_at       timestamptz NOT NULL DEFAULT now()
  -- No updated_at: this table is append-only. No UPDATE or DELETE permitted.
);

CREATE INDEX idx_oxygen_movements_tank_id ON oxygen_movements (tank_id, performed_at DESC);
CREATE INDEX idx_oxygen_movements_to_status ON oxygen_movements (to_status, performed_at DESC);

COMMENT ON TABLE oxygen_movements IS
  'Immutable audit ledger of every oxygen tank state transition. '
  'INSERT-only — no UPDATE or DELETE. The BEFORE INSERT trigger enforces '
  'the state machine; the AFTER INSERT trigger fires the refill-batch alert.';
```

### 5.4 State Machine (`20260519050300_oxygen_triggers.sql`)

#### Allowed transitions

| From | To | Who | Condition |
|---|---|---|---|
| `ready` | `on_board` | Admin or Staff | Tank dispatched with ambulance |
| `on_board` | `ready` | Admin or Staff | Ambulance returned, tank not used |
| `on_board` | `refilling` | Admin or Staff | Tank emptied during run |
| `refilling` | `ready` | Admin only | Refill batch completed |
| `any` | `maintenance` | Admin only | Pulled for maintenance |
| `maintenance` | `ready` | Admin only | Maintenance complete |
| `any` | `retired` | Admin only | Terminal — no further transitions permitted |
| NULL | `ready` | Admin only | First placement (initial movement, `from_status IS NULL`) |

Any transition not in this list raises an exception. `retired` is terminal: no transition FROM `retired` is permitted.

#### DDL

```sql
-- ── Part A: State machine BEFORE INSERT ─────────────────────────────

CREATE OR REPLACE FUNCTION enforce_oxygen_state_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_current_status oxygen_tank_status;
  v_role           text;
BEGIN
  -- 1. Fetch the tank's current status and caller role
  SELECT status INTO v_current_status
  FROM oxygen_tanks WHERE id = NEW.tank_id;

  v_role := app_user_role();  -- Phase 0 helper

  -- 2. Check for retired terminal state
  IF v_current_status = 'retired' THEN
    RAISE EXCEPTION 'ถังหมายเลข % ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้',
      (SELECT serial FROM oxygen_tanks WHERE id = NEW.tank_id);
  END IF;

  -- 3. Validate from_status matches current (unless initial placement)
  IF NEW.from_status IS DISTINCT FROM v_current_status THEN
    RAISE EXCEPTION 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)',
      v_current_status, NEW.from_status;
  END IF;

  -- 4. State machine transition table
  IF NOT (
    -- Initial placement
    (NEW.from_status IS NULL    AND NEW.to_status = 'ready') OR
    -- ready → on_board (staff or admin)
    (NEW.from_status = 'ready'      AND NEW.to_status = 'on_board') OR
    -- on_board → ready (staff or admin)
    (NEW.from_status = 'on_board'   AND NEW.to_status = 'ready') OR
    -- on_board → refilling (staff or admin)
    (NEW.from_status = 'on_board'   AND NEW.to_status = 'refilling') OR
    -- refilling → ready (admin only)
    (NEW.from_status = 'refilling'  AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → maintenance (admin only)
    (NEW.to_status = 'maintenance'  AND v_role = 'Admin') OR
    -- maintenance → ready (admin only)
    (NEW.from_status = 'maintenance' AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → retired (admin only, terminal)
    (NEW.to_status = 'retired'      AND v_role = 'Admin')
  ) THEN
    RAISE EXCEPTION 'การเปลี่ยนสถานะถัง % → % ไม่ได้รับอนุญาต',
      COALESCE(NEW.from_status::text, 'NULL'), NEW.to_status::text;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_oxygen_state_machine
  BEFORE INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_oxygen_state_machine();


-- ── Part B: Apply transition to oxygen_tanks AFTER INSERT ────────────

CREATE OR REPLACE FUNCTION apply_oxygen_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE oxygen_tanks SET
    status              = NEW.to_status,
    current_location_id = COALESCE(NEW.to_location_id, current_location_id),
    last_refill_at      = CASE WHEN NEW.to_status = 'ready'
                               AND NEW.from_status = 'refilling'
                               THEN NEW.performed_at
                               ELSE last_refill_at END,
    last_refill_by      = CASE WHEN NEW.to_status = 'ready'
                               AND NEW.from_status = 'refilling'
                               THEN NEW.performed_by
                               ELSE last_refill_by END,
    updated_at          = now(),
    updated_by          = NEW.performed_by
  WHERE id = NEW.tank_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_oxygen_apply_movement
  AFTER INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION apply_oxygen_movement();


-- ── Part C: Refill-batch alert AFTER INSERT ──────────────────────────

CREATE OR REPLACE FUNCTION check_oxygen_refill_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_refilling_count   int;
  v_threshold         int;
  v_supabase_url      text;
  v_service_role_key  text;
  v_enabled           boolean;
  v_chat_id           text;
  v_dedupe_key        text;
  v_already_sent      int;
  v_tank_list         text;
  v_payload           json;
  v_req_id            bigint;
BEGIN
  -- Only fire when a tank enters 'refilling' status
  IF NEW.to_status <> 'refilling' THEN
    RETURN NEW;
  END IF;

  -- 1. Read settings (Phase 1 deviation — no SET app.* permitted)
  SELECT value INTO v_supabase_url
    FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_service_role_key
    FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT (value = 'true') INTO v_enabled
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
  SELECT value INTO v_chat_id
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
  SELECT value::int INTO v_threshold
    FROM settings WHERE key = 'OXYGEN_REFILL_THRESHOLD';

  -- 2. Guard: skip if not configured
  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE WARNING 'check_oxygen_refill_batch: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — ข้ามการส่งแจ้งเตือน';
    RETURN NEW;
  END IF;

  IF v_enabled IS NOT TRUE THEN
    RETURN NEW;  -- Telegram disabled globally — silent skip
  END IF;

  -- 3. Count tanks currently in 'refilling' state
  SELECT count(*) INTO v_refilling_count
  FROM oxygen_tanks WHERE status = 'refilling';

  IF v_refilling_count < COALESCE(v_threshold, 5) THEN
    RETURN NEW;  -- Below threshold — no alert yet
  END IF;

  -- 4. Dedupe: one alert per calendar day
  v_dedupe_key := 'oxygen_refill:' || to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

  SELECT count(*) INTO v_already_sent
  FROM notification_log
  WHERE dedupe_key = v_dedupe_key
    AND success = true;

  IF v_already_sent > 0 THEN
    RETURN NEW;  -- Already sent today
  END IF;

  -- 5. Build grouped tank list for Telegram message
  SELECT string_agg(
    serial || ' (' || tank_size || ')',
    E'\n' ORDER BY serial
  ) INTO v_tank_list
  FROM oxygen_tanks WHERE status = 'refilling';

  v_payload := json_build_object(
    'event_type', 'oxygen_refill_batch',
    'dedupe_key', v_dedupe_key,
    'message', format(
      '[Stock] ถังออกซิเจนรอเติม %s ถัง (ถึงเกณฑ์ %s ถัง)%s%s',
      v_refilling_count,
      COALESCE(v_threshold, 5),
      E'\n',
      v_tank_list
    ),
    'chat_id', v_chat_id
  );

  -- 6. POST via pg_net to tg-notify Edge Function
  SELECT net.http_post(
    url     := v_supabase_url || '/functions/v1/tg-notify',
    headers := json_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_role_key,
      'X-Internal',    'true'
    )::jsonb,
    body    := v_payload::text
  ) INTO v_req_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_oxygen_refill_alert
  AFTER INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION check_oxygen_refill_batch();
```

**Error strings (exact Thai — implementers must not paraphrase):**

| Condition | Exact string |
|---|---|
| Tank is retired | `ถังหมายเลข {serial} ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้` |
| `from_status` mismatch | `สถานะปัจจุบันของถัง ({current}) ไม่ตรงกับ from_status ({supplied})` |
| Transition not allowed | `การเปลี่ยนสถานะถัง {from} → {to} ไม่ได้รับอนุญาต` |
| Settings not configured | `check_oxygen_refill_batch: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — ข้ามการส่งแจ้งเตือน` (RAISE WARNING, not EXCEPTION) |

---

## 6. Edge Functions

**No new Edge Function is required in Phase 5.**

The existing `tg-notify` function (Phase 0) already accepts any `event_type` string. Phase 5 uses `event_type='oxygen_refill_batch'`. The trigger composes the Thai message body and passes it as `message` in the payload — `tg-notify` sends it verbatim to the configured Telegram chat.

Assumption: `tg-notify` is not changed. If PM later wants per-module alert routing (different chat IDs for oxygen vs medication), that requires a `tg-notify` update — flag at Phase 5.1.

---

## 7. UI Specification

### 7.1 Admin — "ถังออกซิเจน" tab

Placement: new nav item in `admin.html`, after "Inventory" (Phase 1 tab), lazy-loaded via `js/admin-shell.js` pattern. Tab slug: `oxygen`.

**7.1.1 Tank list view (default)**

- Table / card list: columns `serial`, `tank_size` badge, `status` badge (colour-coded), `current_location`, `last_refill_at` (date only), `next_inspection_due` (date + ⚠ if within 30 days — visual flag only; alert cron in Phase 5.1)
- Filter bar: dropdown `สถานะ` (all / ready / on_board / refilling / maintenance / retired), text search by serial
- Status badge colours (using Phase 0 teal `#0d9488` family):
  - `ready` — teal/green (safe)
  - `on_board` — blue (deployed)
  - `refilling` — amber (awaiting)
  - `maintenance` — orange (attention)
  - `retired` — grey (inactive)
- "+ เพิ่มถัง" button (Admin only) — opens add-tank modal
- Row click → opens detail/history modal (`js/oxygen-history.js`)

**7.1.2 Add / Edit tank modal (Admin only)**

Fields: `serial` (text, required), `tank_size` (select: small/medium/large), `current_location_id` (location picker — same component as Phase 1 receive modal), `next_inspection_due` (date picker, optional), `notes` (textarea, optional).

On save (new tank): INSERT `oxygen_tanks` row, then INSERT `oxygen_movements` row with `from_status=NULL`, `to_status='ready'`, `to_location_id=current_location_id`. Both INSERTs in sequence (not a transaction from browser — the trigger on `oxygen_movements` updates `oxygen_tanks.status`; if the tank INSERT succeeded but movement INSERT fails the state machine will catch it on retry).

Assumption: initial creation always starts at `ready`. If PM needs a tank created in `maintenance` state (e.g., new tank pending initial inspection), the operator can add as `ready` then immediately log a transition to `maintenance`.

**7.1.3 Log transition modal (Admin)**

Accessible from: tank detail view, "เปลี่ยนสถานะ" button.

Fields: `to_status` (select — only allowed transitions for current status shown), `to_location_id` (location picker, shown when location changes), `note` (textarea), `photo_url` (Cloudinary upload widget — optional unless PM mandates — see §11 Q4).

**7.1.4 Tank detail / history modal**

- Tank header: serial, current status badge, size, location, last refill, next inspection
- Movement history table: `performed_at`, `from_status` → `to_status`, `performed_by`, `note`, photo thumbnail (if any) — most recent first
- Realtime: `oxygen_tanks` channel subscription refreshes the header on status change

### 7.2 Staff — "staff-oxygen.html" (or extension — see §11 Q6)

**Mobile-first scan flow:**

1. **Scan step**: camera scan (BarcodeDetector / html5-qrcode fallback, same `shared/scanner.js` as Phase 1) OR "พิมพ์แทน" manual serial entry
2. **Tank status step**: display tank card (serial, current status badge, size, location). If tank not found → inline error "ไม่พบถังหมายเลขนี้ในระบบ"
3. **Transition step**: select `to_status` from allowed transitions for the tank's current status (drop-down or tap-card UX — simplified for mobile). Staff cannot select `maintenance` or `retired` (those are Admin-only, hidden from this dropdown).
4. **Location step** (conditional): if the transition changes location (e.g., on_board → ambulance location), show location picker or QR scan for the destination location
5. **Note step**: optional free-text note field
6. **Photo step** (conditional on PM decision §11 Q4): camera capture → Cloudinary upload → `photo_url` populated
7. **Confirm and submit**: POST `oxygen_movements` row → success overlay with tank new status

Error handling:
- State machine exception `การเปลี่ยนสถานะถัง ... ไม่ได้รับอนุญาต` → toast "การเปลี่ยนสถานะนี้ไม่อนุญาต"
- Retired exception → toast "ถังนี้ถูกปลดระวางแล้ว ไม่สามารถใช้งานได้"

### 7.3 Dashboard panel "สถานะถังออกซิเจน"

Location: `js/dashboard.js` — new panel row after existing Phase 1 inventory KPIs.

Contents:
- Count badges per status: ready / on_board / refilling / maintenance / retired
- Alert badge: if `count(status='refilling') >= OXYGEN_REFILL_THRESHOLD` → amber banner "ถังรอเติม {n} ถัง — ถึงเกณฑ์แจ้งเตือน"
- "ดูทั้งหมด →" link → opens "ถังออกซิเจน" admin tab

Implementation: aggregate query `SELECT status, count(*) FROM oxygen_tanks GROUP BY status` on tab load; Realtime subscription on `oxygen_tanks` refreshes counts live.

---

## 8. Row-Level Security (RLS)

Pattern mirrors Phase 1 `stock_rls` policies. All RLS enabled; same helper functions `app_user_role()` and `app_username()` from Phase 0.

**`oxygen_tanks`**

| Policy | Role | Operation | Using / With Check |
|---|---|---|---|
| `oxygen_tanks_select_all` | authenticated | SELECT | `true` |
| `oxygen_tanks_insert_admin` | authenticated | INSERT | `app_user_role() = 'Admin'` |
| `oxygen_tanks_update_trigger_only` | authenticated | UPDATE | `false` — only the SECURITY DEFINER trigger function may UPDATE |
| `oxygen_tanks_delete_admin` | authenticated | DELETE | `app_user_role() = 'Admin'` |

Note: The UPDATE policy blocks direct application UPDATE calls. Only the `apply_oxygen_movement()` trigger function (SECURITY DEFINER) updates `oxygen_tanks.status`. This enforces that status changes always go through the movement ledger.

**`oxygen_movements`**

| Policy | Role | Operation | Using / With Check |
|---|---|---|---|
| `oxygen_movements_select_all` | authenticated | SELECT | `true` |
| `oxygen_movements_insert_staff` | authenticated | INSERT | `app_user_role() IN ('Admin','Employee')` AND `NEW.to_status NOT IN ('maintenance','retired','refilling_complete')` OR `app_user_role() = 'Admin'` |
| `oxygen_movements_no_update` | — | UPDATE | No policy — UPDATE blocked entirely |
| `oxygen_movements_no_delete` | — | DELETE | No policy — DELETE blocked entirely |

Simplified expression for INSERT policy:

```sql
-- Staff can log: ready↔on_board, on_board→refilling only
-- Admin can log: all transitions
WITH CHECK (
  app_user_role() = 'Admin'
  OR (
    app_user_role() = 'Employee'
    AND NEW.to_status IN ('ready','on_board','refilling')
  )
)
```

The state machine trigger provides the final check regardless; RLS is a first-pass guard.

---

## 9. Acceptance Tests T101–T120

Pre-flight: Phase 1 + Phase 2 migrations deployed, tag `phase2-medication` exists, Phase 5 migrations `20260519050000`–`20260519050500` deployed in Supabase SQL Editor.

Test data note: All test tanks use deterministic serials (`OXY-T101` etc.). Run cleanup SQL at end of test day.

---

### Data model verification

- [ ] **T101**: `oxygen_tanks` table exists with correct schema — all 16 columns present, `status` defaults to `'ready'`
  - DB probe:
    ```sql
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'oxygen_tanks'
    ORDER BY ordinal_position;
    -- Expected: 16 columns. status default = 'ready'. serial NOT NULL + UNIQUE.
    ```

- [ ] **T102**: `oxygen_movements` table exists — INSERT-only enforced (no UPDATE/DELETE RLS policies)
  - DB probe:
    ```sql
    SELECT policyname, cmd FROM pg_policies
    WHERE tablename = 'oxygen_movements';
    -- Expected: INSERT and SELECT policies only. No UPDATE or DELETE policies.
    ```

- [ ] **T103**: `oxygen_tank_status` enum has exactly 5 values
  - DB probe:
    ```sql
    SELECT enumlabel FROM pg_enum
    WHERE enumtypid = 'oxygen_tank_status'::regtype
    ORDER BY enumsortorder;
    -- Expected: ready, on_board, refilling, maintenance, retired
    ```

---

### Admin: Add tank

- [ ] **T104**: Admin creates new tank — `oxygen_tanks` row + initial `oxygen_movements` row (NULL → ready)
  - Steps:
    1. Log in as Admin. Admin → "ถังออกซิเจน" tab → "+ เพิ่มถัง".
    2. Fill: serial = `OXY-T104`, size = `medium`, location = `ROOM-A`, next_inspection_due = 90 days from today. Click "บันทึก".
    3. Confirm success toast "เพิ่มถังแล้ว".
    4. Run DB probe.
  - Expected:
    - `oxygen_tanks` row: `serial='OXY-T104'`, `status='ready'`, `current_location_id` = ROOM-A uuid, `tank_size='medium'`.
    - `oxygen_movements` row: `from_status IS NULL`, `to_status='ready'`, `tank_id` = new tank uuid.
  - DB probe:
    ```sql
    SELECT serial, status, tank_size FROM oxygen_tanks WHERE serial = 'OXY-T104';
    -- Expected: OXY-T104 / ready / medium

    SELECT from_status, to_status FROM oxygen_movements
    WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-T104')
    ORDER BY performed_at ASC LIMIT 1;
    -- Expected: NULL / ready
    ```

- [ ] **T105**: Duplicate serial rejected — second INSERT with same serial returns error
  - Steps: Attempt to add another tank with serial `OXY-T104`.
  - Expected: inline error "หมายเลขถังนี้มีอยู่แล้ว". No second `oxygen_tanks` row.
  - DB probe: `SELECT count(*) FROM oxygen_tanks WHERE serial = 'OXY-T104';` — Expected: 1

---

### State machine — allowed transitions

- [ ] **T106**: Admin logs `ready → on_board` — `oxygen_tanks.status` updates, movement row inserted
  - Steps: Admin → tank `OXY-T104` detail → "เปลี่ยนสถานะ" → `on_board`, location = ambulance location (e.g., `AMB-TG4`), note = "T106". Submit.
  - Expected: status badge on list changes to `on_board`. One new `oxygen_movements` row.
  - DB probe:
    ```sql
    SELECT status, current_location_id FROM oxygen_tanks WHERE serial = 'OXY-T104';
    -- Expected: on_board / AMB-TG4 location uuid

    SELECT from_status, to_status, note FROM oxygen_movements
    WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-T104')
    ORDER BY performed_at DESC LIMIT 1;
    -- Expected: ready / on_board / T106
    ```

- [ ] **T107**: `on_board → refilling` transition succeeds
  - Steps: Repeat for OXY-T104 (now `on_board`). Log transition to `refilling`.
  - Expected: status = `refilling`. New movement row.
  - DB probe: `SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T104';` — Expected: refilling

- [ ] **T108**: `refilling → ready` by Admin succeeds — `last_refill_at` and `last_refill_by` updated
  - Steps: Admin logs `refilling → ready` for OXY-T104.
  - Expected: `status='ready'`, `last_refill_at IS NOT NULL`, `last_refill_by = admin_username`.
  - DB probe:
    ```sql
    SELECT status, last_refill_at IS NOT NULL AS has_refill_ts, last_refill_by
    FROM oxygen_tanks WHERE serial = 'OXY-T104';
    -- Expected: ready / true / <admin username>
    ```

---

### State machine — blocked transitions

- [ ] **T109**: Invalid transition (`ready → refilling`) blocked with exact Thai error string
  - Steps: DevTools Console (Admin JWT):
    ```javascript
    const { error } = await supabase.from('oxygen_movements').insert({
      tank_id: '<OXY-T104 uuid>',
      from_status: 'ready',
      to_status: 'refilling',
      performed_by: 'test'
    });
    console.log(error?.message);
    ```
  - Expected: `error.message` contains `การเปลี่ยนสถานะถัง ready → refilling ไม่ได้รับอนุญาต`. HTTP 400.
  - DB probe: `SELECT count(*) FROM oxygen_movements WHERE to_status='refilling' AND from_status='ready';` — Expected: 0

- [ ] **T110**: Retired tank — any transition blocked with Thai error string
  - Steps:
    1. SQL Editor: `UPDATE oxygen_tanks SET status = 'retired' WHERE serial = 'OXY-T104';` (bypass RLS for test via SQL Editor service role).
    2. Attempt any INSERT into `oxygen_movements` for OXY-T104.
  - Expected: `error.message` contains `ถังหมายเลข OXY-T104 ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้`.
  - DB probe: status unchanged at `retired`. Zero new movement rows.

- [ ] **T111**: `from_status` mismatch blocked — trigger detects incorrect `from_status` supplied
  - Steps: Tank OXY-T104 is `ready`. Insert `oxygen_movements` with `from_status='on_board'`, `to_status='refilling'`.
  - Expected: error contains `สถานะปัจจุบันของถัง (ready) ไม่ตรงกับ from_status (on_board)`.

---

### Admin-only transitions

- [ ] **T112**: Staff cannot log `refilling → ready` — RLS blocks the INSERT
  - Steps: Log in as Employee (`Pt1`). DevTools Console (Employee JWT):
    ```javascript
    const { error } = await supabase.from('oxygen_movements').insert({
      tank_id: '<refilling tank uuid>',
      from_status: 'refilling',
      to_status: 'ready',
      performed_by: 'Pt1'
    });
    console.log(error?.code);
    ```
  - Expected: `error.code = '42501'`. No row inserted.

- [ ] **T113**: Staff cannot log transition to `maintenance` — RLS blocks
  - Steps: Same as T112 but `to_status = 'maintenance'`.
  - Expected: `error.code = '42501'`.

---

### Refill-batch alert

- [ ] **T114**: Refill-batch Telegram alert fires when refilling count reaches threshold
  - Pre-conditions: `OXYGEN_REFILL_THRESHOLD = 5` (Phase 0 seed). `NOTIFY_TELEGRAM_ENABLED = true`, `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` set.
  - Steps:
    1. Create 5 tanks (`OXY-BATCH-01` to `OXY-BATCH-05`) via SQL, set all to `status='ready'`.
    2. For each, INSERT an `oxygen_movements` row transitioning `on_board → refilling` (first PUT each to `on_board` via SQL, then transition via movements). Alternatively, use SQL Editor batch insert for speed.
    3. On the 5th tank's insert, observe `notification_log`.
  - Expected:
    - `notification_log` row: `event_type='oxygen_refill_batch'`, `dedupe_key='oxygen_refill:<today>'`, `success=true`.
    - Telegram message received listing 5 tank serials with sizes.
  - DB probe:
    ```sql
    SELECT event_type, dedupe_key, success
    FROM notification_log
    WHERE dedupe_key = 'oxygen_refill:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
    -- Expected: 1 row, success=true
    ```

- [ ] **T115**: Refill-batch dedupe — 6th tank entering refilling same day does NOT send second alert
  - Steps: After T114, add a 6th tank and transition to refilling.
  - Expected: `notification_log` count for today's `oxygen_refill` dedupe_key remains 1. No second Telegram message.
  - DB probe:
    ```sql
    SELECT count(*) FROM notification_log
    WHERE dedupe_key = 'oxygen_refill:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
    -- Expected: 1
    ```

- [ ] **T116**: Below threshold — 4 refilling tanks do NOT trigger alert
  - Steps: Ensure only 4 tanks are in `refilling` state. Move one `refilling → ready` if needed.
  - Expected: No new row in `notification_log` after the 4th tank's movement. Telegram silent.
  - DB probe: `SELECT count(*) FROM oxygen_tanks WHERE status = 'refilling';` — Expected: 4

---

### Dashboard panel

- [ ] **T117**: Dashboard "สถานะถังออกซิเจน" panel shows correct per-status counts
  - Steps: Admin → Dashboard tab. Observe oxygen panel.
  - Expected: Counts for each status match DB.
  - DB probe:
    ```sql
    SELECT status, count(*) FROM oxygen_tanks GROUP BY status ORDER BY status;
    -- Compare each row against Dashboard panel counts.
    ```

- [ ] **T118**: Dashboard alert badge appears when refilling count >= threshold
  - Steps: Ensure `count(status='refilling') >= OXYGEN_REFILL_THRESHOLD`. Reload Dashboard.
  - Expected: amber banner "ถังรอเติม {n} ถัง — ถึงเกณฑ์แจ้งเตือน" visible.

---

### Staff scan flow

- [ ] **T119**: Staff scans tank serial — sees current status and can log `ready → on_board`
  - Steps: Log in as Employee. Open `staff-oxygen.html`. Type/scan serial `OXY-T104` (status: `ready`). Select `on_board`. Pick ambulance location. Submit.
  - Expected: Success overlay. `oxygen_tanks.status = 'on_board'`. New movement row with `performed_by = Pt1`.

- [ ] **T120**: Staff scans unknown serial — inline error displayed, no crash
  - Steps: Staff scan flow. Enter serial `OXY-DOESNT-EXIST`.
  - Expected: Inline error "ไม่พบถังหมายเลขนี้ในระบบ". No 500 error. No row created.

---

## 10. Out of Scope

The following items were explicitly excluded from Phase 5. If any item below surfaces during implementation as a blocker or a strong dependency, escalate to PM before proceeding.

| Item | Rationale | Deferred to |
|---|---|---|
| Oxygen tanks are NOT stock_items children | Architectural decision locked in Phase 1 spec §10 Q-Phase1-D. Serial-per-piece identity model is incompatible with SKU+qty model. | N/A — permanent separation |
| Per-tank pressure history trend (chart) | `last_pressure_psi` captures latest reading only. Multi-reading time series requires a `oxygen_pressure_log` table and chart UI. | Phase 5.1 |
| Hydrostatic inspection cron alert | `next_inspection_due` column is stored; alert cron (similar to Phase 2 expiry cron) deferred. | Phase 5.1 |
| Vendor refill SLA tracking | Vendor entity and SLA contract not in scope. | Phase 5.1+ |
| Integration with ambulance check-in (GAS) | When an ambulance departs, auto-marking its tanks as `on_board` requires event data from the Ambulance GAS. Out of scope for Phase 5. | Phase 6+ |
| Acquisition cost / asset value | No cost column in current schema. See §11 Q5. | TBD by PM |
| Bulk import from spreadsheet | Admin adds tanks one-by-one via form in Phase 5. | Phase 5.1 |
| Multiple Telegram chat routing (per module) | Reuses the single `NOTIFY_TELEGRAM_CHAT_ID` from Phase 0, same as all prior phases. | Phase 5.1+ |
| Per-tank barcode / QR label printing | UI reads existing serial; no label generation. | Phase 5.1 |
| Maintenance sub-reason tracking | `maintenance` is a single state. See §11 Q3. | Phase 5.1 (if PM upgrades) |

---

## 11. Open Questions

The following questions require PM decision before the plan can be written. For each, options A/B/C are listed with a recommendation.

---

**Q1 — Tank size enum: 3 sizes or more granular?**

Current spec uses `CHECK (tank_size IN ('small','medium','large'))`.

- **Option A (recommended):** Keep 3 sizes — `small` / `medium` / `large`. Covers the vast majority of pre-hospital practice. Implemented as a text CHECK (not a Postgres enum) so additional sizes can be added via `ALTER TABLE` without a full enum migration.
- **Option B:** Add a 4th size `extra_large` for non-standard cylinders Thegood may acquire.
- **Option C:** Use a free-text field with no constraint. Flexible but loses filter-by-size utility and risks inconsistent data entry.

**Recommendation:** Option A. If Thegood's vendor supplies a non-standard size, add it at Phase 5.1.

**PM decision needed: confirm `small/medium/large` is sufficient, or specify additional sizes.**

---

**Q2 — Refill threshold default: 5 (Phase 0 seed) or different?**

`OXYGEN_REFILL_THRESHOLD = 5` was seeded in Phase 0 based on a placeholder estimate. The spec does not have a confirmed number from the PDF.

- **Option A (recommended):** Keep `5` as the default. Admin can change it in Settings UI (the `settings` table is already editable via Admin → Settings tab).
- **Option B:** Change the default seed to a different number (PM must specify).
- **Option C:** Remove the threshold concept and let Admin configure it as the first step of Phase 5 deployment, with no pre-seeded value.

**Recommendation:** Option A (keep 5, editable). PM must confirm or override the default.

---

**Q3 — Maintenance status: single state or sub-reason?**

Current spec: `maintenance` is one enum value. The state machine transitions `any → maintenance` and `maintenance → ready`.

- **Option A (recommended for Phase 5):** Keep `maintenance` as a single state. Record the reason in `oxygen_movements.note` (free text). No schema change needed. Sub-types can be added at Phase 5.1.
- **Option B:** Add a `maintenance_reason` column to `oxygen_movements` with a CHECK constraint (`hydro_test / repair / annual_service / other`). Adds structure but complicates the staff UI and requires a migration.
- **Option C:** Split into two enum values: `maintenance_hydro` and `maintenance_repair`. Cleaner for reporting but increases enum complexity and UI logic.

**Recommendation:** Option A for Phase 5. Capture reason in `note`. Phase 5.1 can formalise sub-types if compliance reporting requires it.

---

**Q4 — Photo proof for status transitions: optional or required?**

The `oxygen_movements.photo_url` column is defined. Cloudinary folder: `thegood-stock/oxygen/{tank_serial}/`.

- **Option A (recommended):** Optional — `photo_url` is nullable; staff may attach a photo but are not required to. Zero friction for quick status updates.
- **Option B:** Required for specific transitions only — e.g., required when logging `on_board → refilling` (photo of empty tank) as proof of condition. This matches the borrow/return photo pattern in Phase 3 (being specced in parallel).
- **Option C:** Required for all transitions — highest compliance, highest friction. Risk: staff may photograph random objects to bypass the requirement.

**Recommendation:** Option A for Phase 5. If PM wants Option B, specify which exact transitions require a photo. Coordinate with Phase 3 BA to align the Cloudinary upload UX component — the `shared/cloudinary.js` helper is already in Phase 0, and Phase 3 will be defining the photo-in-modal pattern first.

---

**Q5 — Acquisition cost / asset value: in scope for Phase 5 or defer?**

Oxygen tanks are capital assets. A `purchase_price` column and `acquired_at` date would allow asset register reporting.

- **Option A (recommended):** Defer. Phase 5 is lifecycle management (where is the tank, what is its status). Asset value tracking is a finance module concern, not an operational concern.
- **Option B:** Add `purchase_price numeric(10,2)` and `acquired_at date` to `oxygen_tanks` now (two nullable columns, no UI in Phase 5). Low cost to add schema hook, defers UI.
- **Option C:** Full asset register module in Phase 5. Significant scope expansion; not in the PDF §5 original requirement.

**Recommendation:** Option A. Flag to PM: if Thegood's finance team needs an asset register, that is a separate module. Do not silently enlarge Phase 5.

---

**Q6 — Staff oxygen flow: new page `staff-oxygen.html` or extend `staff-scan.html`?**

Phase 1 added `staff-scan.html` for inventory issue. Phase 5 needs a staff serial-scan-and-transition flow.

- **Option A (recommended):** New dedicated page `staff-oxygen.html`. Cleaner URL, independent navigation, avoids coupling the scan flows. Staff bookmark the specific page they use.
- **Option B:** Extend `staff-scan.html` with a top-level mode toggle ("Inventory scan / Oxygen scan"). Fewer pages but increased complexity in `staff-scan.js`.
- **Option C:** Embed within `admin.html` staff view. Not recommended — staff-oxygen is a mobile-first field action; admin.html is desktop-oriented.

**Recommendation:** Option A. Consistent with Phase 0–4 pattern of separate pages per role+function.

---

## 12. Decisions Log

| ID | Question | Decision | Source |
|---|---|---|---|
| Q-Phase5-A | Separate table vs `stock_items` child | `oxygen_tanks` is a standalone table. Not a child of `stock_items`. Per-piece serial identity model is architecturally incompatible with SKU+qty model. | Phase 1 spec §10, Q-Phase1-D; confirmed in Phase 5 spec §1.1 |
| Q-Phase5-B | State machine implementation | `BEFORE INSERT` trigger on `oxygen_movements` (mirrors Phase 2 `check_lot_status` pattern). Not a CHECK constraint (cannot call `app_user_role()` in CHECK). | BA recommendation — consistent with Phase 2 pattern |
| Q-Phase5-C | Status update mechanism | `oxygen_tanks.status` updated ONLY by SECURITY DEFINER `apply_oxygen_movement()` AFTER INSERT trigger. Direct UPDATE blocked by RLS `false` policy. | BA recommendation — audit trail completeness |
| Q-Phase5-D | Trigger reads settings | Trigger reads `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from `settings` table — does NOT use `current_setting('app.*')`. Matches Phase 1 deviation (Project.md §8 gotcha 9; `ALTER DATABASE SET app.*` denied on Free/Nano plan). | Project.md §8 gotcha 9; Phase 1 pattern |
| Q-Phase5-E | No new Edge Function | `tg-notify` (Phase 0) reused with `event_type='oxygen_refill_batch'`. Trigger composes the Thai message body. | BA recommendation — reuse principle |
| Q-Phase5-F | Dedupe key format | `'oxygen_refill:YYYY-MM-DD'` — one alert per calendar day. Uses `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')` for BKK timezone consistency (matches Phase 2 cron timezone). | BA recommendation — mirrors Phase 1 low-stock dedupe pattern |
| Q-Phase5-G | `oxygen_movements` append-only | No UPDATE or DELETE RLS policies on `oxygen_movements`. History is immutable. | BA recommendation — audit compliance |
| Q-Phase5-H | Cloudinary folder prefix | `thegood-stock/oxygen/{tank_serial}/` — distinct from Phase 3 Borrow/Return (`thegood-stock/borrow/`) and Phase 6 Laundry. Phase 3 BA coordinating in parallel. | BA decision — cross-phase coordination |
| Q-Phase5-I | `tank_size` as text CHECK not enum | CHECK constraint on text column (not `CREATE TYPE`) — allows extension via ALTER TABLE without full enum DDL migration. | BA recommendation — Phase 5.1 extensibility |
| Q-Phase5-J | `retired` terminal state | Once a tank reaches `retired`, NO further `oxygen_movements` INSERT is permitted. The state machine trigger raises an exception. Retired tanks remain visible in the list (greyed) for historical reference. | BA recommendation — decommission tracking |
| Q-Phase5-K | Phase 3 coordination | Phase 3 Borrow/Return (being specced in parallel) will establish the Cloudinary photo-in-modal UX pattern first. Phase 5 photo upload UI should reuse whatever component Phase 3 specifies. BA flag to PM: sequence Phase 3 FE before Phase 5 FE if photo is required (Option B of Q4). | Cross-phase dependency |

---

## 13. Coverage Check

| Requirement from PDF §5 | Covered? | Where |
|---|---|---|
| Per-tank serial tracking | Yes | `oxygen_tanks.serial` UNIQUE NOT NULL |
| Tank size classification | Yes | `tank_size` CHECK ('small','medium','large') — Q1 open |
| Current location tracking | Yes | `oxygen_tanks.current_location_id` FK → `locations` |
| Lifecycle status: ready / on_board / refilling | Yes | `oxygen_tank_status` enum + state machine |
| Maintenance status | Yes | `maintenance` enum value; sub-reason in §11 Q3 |
| Retired status | Yes | `retired` terminal enum value |
| Refill date tracking | Yes | `last_refill_at` + `last_refill_by` updated by trigger |
| Inspection compliance date | Yes | `next_inspection_due` column (alert cron in Phase 5.1) |
| Refill-batch alert | Yes | `trg_oxygen_refill_alert` + `OXYGEN_REFILL_THRESHOLD` from settings |
| Movement audit trail | Yes | `oxygen_movements` ledger, append-only |
| Admin tank management UI | Yes | §7.1 |
| Staff scan-and-transition flow | Yes | §7.2 |
| Dashboard status summary | Yes | §7.3 |
| RLS admin/staff split | Yes | §8 |
| Photo proof (optional) | Partial | Column present; required vs optional is §11 Q4 |

**Out-of-scope items from PDF §5 confirmed not covered:**
- Pressure history chart — Phase 5.1
- Vendor SLA — Phase 5.1+
- Integration with ambulance dispatch — Phase 6+

---

## 14. Effort Estimate

Estimates are for a single developer using the Dashboard-only Supabase workflow (no CLI). Assumes Phase 1/2 patterns are already familiar.

| Area | Tasks | Estimated hours |
|---|---|---|
| DB migrations (5 files) | Enums, tables, triggers, RLS, realtime | 4–5 h |
| Trigger function (state machine + alert) | Write, test in SQL Editor, verify error strings | 3–4 h |
| Admin UI (`js/oxygen.js` + `js/oxygen-history.js`) | List, filter, modal, transition form | 6–8 h |
| Staff page (`staff-oxygen.html` + `js/staff-oxygen.js`) | Scan flow, 5-step wizard | 4–5 h |
| `shared/oxygen-client.js` | REST helpers | 1–2 h |
| Dashboard panel integration | 2 h |
| `admin-shell.js` + `sw.js` edits | 1 h |
| Acceptance testing (T101–T120) | 20 tests | 3–4 h |
| **Total** | | **24–31 h** |

---

## 15. Next Step

**Hand-off to:** `backend-developer` (DB migrations + trigger functions) and `ui-ux-designer` (admin tab layout + staff scan wizard wireframes).

**Before implementation begins**, PM must answer the six open questions in §11:
1. Confirm `small/medium/large` sizes or specify additions
2. Confirm `OXYGEN_REFILL_THRESHOLD = 5` default
3. Maintenance state: single vs sub-reason
4. Photo proof: optional or required (and for which transitions)
5. Acquisition cost / value: defer or add schema hook now
6. Staff flow: new `staff-oxygen.html` or extend `staff-scan.html`

**Backend developer must read:**
- This spec (§5 DDL, §8 RLS, §11 Q-Phase5-D trigger pattern)
- `docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md` — for `check_lot_status` BEFORE INSERT trigger pattern to mirror
- Project.md §8 gotcha 9 — trigger reads from `settings` table

**UI/UX designer must read:**
- This spec §7 (UI spec)
- Phase 0 spec §7 for Bootstrap 5 / Sarabun / teal `#0d9488` conventions
- Phase 3 Borrow/Return spec (when available) — coordinate photo upload UX pattern (Q-Phase5-K)

**Sequence note:** If PM selects Q4 Option B (photo required for specific transitions), Phase 3 FE must be implemented first to establish the Cloudinary modal component. Phase 5 FE can proceed in parallel if Q4 = Option A (optional).

---

**Status: DRAFT — pending PM review**
