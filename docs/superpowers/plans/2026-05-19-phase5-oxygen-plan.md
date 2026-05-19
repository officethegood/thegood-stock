# Phase 5 — Oxygen Tanks Lifecycle + Refill Batch Alerts — Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** READY TO EXECUTE — All PM decisions locked 2026-05-19.
**Prerequisite:** Phase 2 tag `phase2-medication` must exist. T45–T70 must pass. Phase 3 dependency noted inline.
**Decisions source of truth:** `docs/superpowers/specs/2026-05-19-phase5-decisions-locked.md`
**Full spec:** `docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md`
**Full UX design:** `docs/superpowers/designs/2026-05-19-phase5-oxygen-ui-design.md`

---

## Pre-implementation findings (dissent log)

Cross-check of decisions-locked doc, spec, and UX design. Findings for developer awareness before Task A1 starts.

### F1. Error string in spec §5.4 vs decisions-locked §Q-derived #5

The decisions-locked doc (derived constraint #5) states the FE grep target error string as:

`'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'`

The spec §5.4 trigger DDL raises a more specific error:

`'การเปลี่ยนสถานะถัง % → % ไม่ได้รับอนุญาต'`

**Resolution:** The decisions-locked doc is binding. The BEFORE INSERT trigger MUST raise the exact string `'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'` as the canonical FE-greppable message. The spec's more verbose version is superseded. Task A6 implements the decisions-locked string. The retired-tank and from_status-mismatch errors from the spec are retained as-is (they are not contradicted by the decisions-locked doc). **Developer: grep the FE for `การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง` (exact) to wire error handling.**

### F2. Spec repo layout vs task list file naming

The spec §4 names `shared/oxygen-client.js` and `js/oxygen-history.js` as distinct files. The task list in the PM brief consolidates these as `shared/oxygen.js` and `js/oxygen.js`. This plan follows the **PM brief task list** (B1 = `shared/oxygen.js`, B2 = `js/oxygen.js` containing both tank list and history). The `oxygen-client.js` / `oxygen-history.js` naming in the spec is superseded. No functional difference — naming only.

### F3. `tank_size` implementation: CHECK constraint, not ENUM type

The spec §5.2 documents `tank_size` as a text column with `CHECK (tank_size IN ('small','medium','large'))` — not a `CREATE TYPE`. The decisions-locked doc (Q-Phase5-1) confirms three sizes. **A separate enum migration file is therefore NOT needed for `tank_size`.** The PM brief task list names A2 as `20260519050100_oxygen_tank_size_enum.sql`. This plan implements A2 as a migration that adds no separate enum type; instead it documents the CHECK constraint inline with the `oxygen_tanks` table migration (A3). The file is created as specified to preserve the migration numbering sequence, but its content is a no-op comment block that explains the design decision. Developer: do not create a `CREATE TYPE oxygen_tank_size` — use the CHECK constraint on the table column.

### F4. NO pg_cron job in Phase 5

Phase 5 refill alerting is **event-driven** (AFTER INSERT trigger on `oxygen_movements`), not scheduled. There is NO new `pg_cron` job in Phase 5. This is explicitly different from Phase 2 (daily expiry cron) and Phase 3 (if it adds inspection crons). Developer: do not attempt to schedule any cron job in Phase 5 migrations.

### F5. Photo-capture Phase 3 dependency

`shared/photo-capture.js` is referenced in B4 (`js/staff-oxygen.js`). This file **does not exist yet** — it is defined by Phase 3 (Borrow/Return), which may not be implemented before Phase 5. See cross-phase dependency handling in the Phase 3 dependency section below and in Tasks B3/B4.

### F6. Migration timestamp gap at `20260519010400`

Reviewing existing migrations: `20260519010400_stock_lot_triggers.sql` exists (Phase 2). Phase 3 and Phase 4 timestamps (`20260519030000`–`20260519040999`) are unoccupied. Phase 5 migrations use `20260519050000`–`20260519050600` per the spec. This is consistent and causes no collision.

---

## Phase 3 cross-phase dependency: `shared/photo-capture.js`

Phase 5 staff scan flow (`js/staff-oxygen.js`) and the transition modal (`js/oxygen.js`) reuse `shared/photo-capture.js` — the Cloudinary photo capture component defined by Phase 3.

**Ordering rules:**

1. **Preferred deploy sequence: Phase 3 first, then Phase 5.** Phase 3's `shared/photo-capture.js` is the canonical implementation. Phase 5 FE tasks B3/B4 must not be started until Phase 3 is merged and its `shared/photo-capture.js` is available.

2. **If Phase 5 starts before Phase 3 is complete:** Write a minimal stub at `shared/photo-capture.js` with the following interface only:

   ```js
   // shared/photo-capture.js — STUB (Phase 3 not yet integrated)
   // Replace with full Phase 3 implementation before Phase 5 production deploy.
   export async function capturePhoto({ folder }) {
     // Returns null until Phase 3 integrates the real Cloudinary upload.
     console.warn('photo-capture: stub — Phase 3 not yet integrated');
     return null;
   }
   ```

   Mark all Phase 5 tasks that use `capturePhoto()` with `[STUB — unify with Phase 3]` in code comments. On Phase 3 merge, replace the stub with Phase 3's version and remove the stub warning.

3. **sw.js CACHE_VERSION sequence:**
   - If Phase 3 lands before Phase 5: Phase 3 bumps to `v0.4.0`, Phase 5 bumps to `v0.5.0`.
   - If Phase 5 lands before Phase 3: Phase 5 bumps to `v0.4.0`, Phase 3 will bump to `v0.5.0` on integration.
   - The plan's Task B9 states: bump CACHE_VERSION by one minor version above whatever Phase 3 set. If Phase 3 has not yet deployed, set to `v0.4.0`.

---

## Goal

Add per-serial oxygen tank lifecycle tracking to Thegood Stock. Each physical cylinder is tracked from first placement through on_board/refilling/maintenance/retired states via an immutable movement ledger. When the count of tanks in `refilling` state reaches `OXYGEN_REFILL_THRESHOLD` (default 5, configurable in `settings`), a Telegram alert fires automatically via the existing `tg-notify` Edge Function — no new Edge Function required.

## Architecture summary

Phase 5 is purely additive. Zero changes to Phase 0–4 tables. New: `oxygen_tanks` table (standalone — NOT a child of `stock_items`), `oxygen_movements` ledger (INSERT-only), two trigger functions (state machine + refill alert), five migration files, one JS module in `shared/`, three JS files in `js/`, one new HTML page, and a dashboard panel extension.

## Tech stack

Unchanged from prior phases. Supabase Dashboard-only deployment (no CLI). Migrations: paste into SQL Editor. Frontend: vanilla JS, no build step, pushed to GitHub Pages.

## Testing approach

Manual checklist pattern T101–T125 (25 tests). Each task ends with a concrete verification step: SQL probe or browser action. Trigger-level invariants get SQL smoke tests in Task C1.

## Source of truth

`docs/superpowers/specs/2026-05-19-phase5-decisions-locked.md` — all decisions binding. Acceptance tests T101–T125 are defined in Task C1 of this plan and written to `docs/test-checklist.md`.

---

## Pre-flight checklist (must pass before Task A1 starts)

- [ ] **PF-1** `git tag | grep phase2-medication` returns a tag. Phase 2 is stable and tagged.
- [ ] **PF-2** All Phase 2 acceptance tests T45–T70 are marked pass in `docs/test-checklist.md`.
- [ ] **PF-3** Confirm Phase 2 migration timestamps `20260519010000`–`20260519010800` are all present in `supabase/migrations/` and deployed. Verify in SQL Editor:
  ```sql
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('stock_lots','oxygen_tanks');
  -- Expected: stock_lots (1 row). oxygen_tanks must NOT exist yet.
  ```
- [ ] **PF-4** Confirm Phase 5 migration timestamp range is free:
  ```sql
  -- In the repo filesystem (not SQL Editor):
  -- ls supabase/migrations/ | grep "202605190500"
  -- Expected: no output (all 20260519050xxx timestamps unoccupied).
  ```
- [ ] **PF-5** Confirm `pg_net` extension is present (required for refill alert trigger):
  ```sql
  SELECT extname FROM pg_extension WHERE extname = 'pg_net';
  -- Expected: 1 row
  ```
- [ ] **PF-6** Confirm `settings` table has `NOTIFY_SUPABASE_URL`, `NOTIFY_SERVICE_ROLE_KEY`, and `OXYGEN_REFILL_THRESHOLD`:
  ```sql
  SELECT key, length(value) AS val_len
  FROM settings
  WHERE key IN (
    'NOTIFY_SUPABASE_URL',
    'NOTIFY_SERVICE_ROLE_KEY',
    'NOTIFY_TELEGRAM_ENABLED',
    'NOTIFY_TELEGRAM_CHAT_ID',
    'OXYGEN_REFILL_THRESHOLD'
  )
  ORDER BY key;
  -- Expected: at minimum NOTIFY_SUPABASE_URL and NOTIFY_SERVICE_ROLE_KEY (2 rows).
  -- OXYGEN_REFILL_THRESHOLD may not exist yet — Task A1 seeds it if missing.
  ```
- [ ] **PF-7** Confirm Phase 0 helper functions exist:
  ```sql
  SELECT proname FROM pg_proc
  WHERE proname IN ('app_username', 'app_user_role', 'set_updated_at')
    AND pronamespace = 'public'::regnamespace;
  -- Expected: 3 rows
  ```
- [ ] **PF-8** Confirm `notification_log` table exists (Phase 0 — used by refill alert dedupe):
  ```sql
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'notification_log';
  -- Expected: 1 row
  ```
- [ ] **PF-9** Confirm `locations` table exists and has at least one row (oxygen_tanks FK requires it):
  ```sql
  SELECT count(*) FROM locations;
  -- Expected: >= 1
  ```
- [ ] **PF-10** Confirm `shared/photo-capture.js` exists OR acknowledge Phase 3 stub requirement:
  - If file exists: note Phase 3 is ahead. Phase 5 CACHE_VERSION = v0.5.0.
  - If file does not exist: create the stub per "Phase 3 cross-phase dependency" section above before starting Task B3. Phase 5 CACHE_VERSION = v0.4.0.

---

## Reading order

This plan has 4 execution phases (A–D). Within a phase tasks are sequential. Phase A (DB) must fully complete before Phase B (frontend). Phase C (tests) runs after all A+B tasks pass per-task verification. Phase D (docs/tag) closes the phase.

| Phase | Tasks | Focus |
|---|---|---|
| A | A1–A7 | DB migrations: enums, tables, triggers, RLS, realtime |
| B | B1–B9 | Frontend: shared helpers, admin tab, staff page, dashboard, SW bump |
| C | C1 | Acceptance tests T101–T125 written + executed |
| D | D1 | docs/test-checklist.md update + git tag |

Effort estimate: Phase A 4–5 h, B 12–16 h, C 3–4 h, D 0.5 h → **~20–26 h** focused.

---

# Phase A — Database migrations

All migration files go under `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\` with the `20260519050x00` timestamp prefix.

**Deploy method (Dashboard-only):** Open Supabase Dashboard → SQL Editor → New Query. Paste migration SQL. Click Run. After success, commit the file to the repo.

**IMPORTANT — NO pg_cron in Phase 5.** Phase 5 alerting is event-driven (trigger-based), not scheduled. Do not attempt to create any `pg_cron` job in these migrations. This is explicitly different from Phase 2.

---

## Task A1: Migration — `oxygen_tank_status` enum

**Decisions ref:** Derived constraint #2 (5-value enum: ready/on_board/refilling/maintenance/retired).

**File:** `supabase/migrations/20260519050000_oxygen_tank_status_enum.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519050000_oxygen_tank_status_enum.sql
-- Phase 5 — oxygen_tank_status enum.
-- Decisions-locked: derived #2 (5 values).
-- Idempotent: DO block guards CREATE TYPE.
-- NO pg_cron — Phase 5 alerting is event-driven (trigger-based).

DO $phase5_status_enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oxygen_tank_status') THEN
    CREATE TYPE oxygen_tank_status AS ENUM (
      'ready',        -- in storage, full, ready to deploy
      'on_board',     -- loaded on an ambulance, in use
      'refilling',    -- returned empty, sent to refill vendor
      'maintenance',  -- pulled for maintenance (hydrostatic test, repair, etc.)
      'retired'       -- permanently decommissioned (terminal state — no further transitions)
    );
  END IF;
END
$phase5_status_enum$;

COMMENT ON TYPE oxygen_tank_status IS
  'Phase 5. ready=in storage; on_board=deployed on vehicle; refilling=with vendor; '
  'maintenance=pulled for service; retired=terminal, no further transitions permitted. '
  'Decisions-locked Q-Phase5-1 confirmed 5 values.';
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
SELECT enumlabel
FROM pg_enum
WHERE enumtypid = 'oxygen_tank_status'::regtype
ORDER BY enumsortorder;
-- Expected: 5 rows: ready, on_board, refilling, maintenance, retired
```

- [ ] **Step 4: Commit**

```
git add supabase/migrations/20260519050000_oxygen_tank_status_enum.sql
git commit -m "feat(db): oxygen_tank_status enum (Phase 5)"
```

**Rollback if this task fails:**
```sql
DROP TYPE IF EXISTS oxygen_tank_status;
```

---

## Task A2: Migration — `tank_size` design decision (no separate enum type)

**Decisions ref:** Q-Phase5-1 (3 sizes: small/medium/large). Q-Phase5-I: implemented as text CHECK, not CREATE TYPE, for extensibility.

**File:** `supabase/migrations/20260519050100_oxygen_tank_size_enum.sql`

**Note to developer:** Despite the filename, this migration does NOT create a Postgres enum type for `tank_size`. Per spec §5.2 and decisions Q-Phase5-I, `tank_size` is a text column with a CHECK constraint on `oxygen_tanks`. This allows adding new sizes via `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ...` without the DDL migration complexity of modifying a Postgres enum. The file is created to preserve the migration numbering sequence and to document the decision.

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519050100_oxygen_tank_size_enum.sql
-- Phase 5 — tank_size design record.
--
-- DECISION (Q-Phase5-1, Q-Phase5-I):
--   tank_size is implemented as a text column CHECK on oxygen_tanks:
--     CHECK (tank_size IN ('small','medium','large'))
--   NOT as a Postgres CREATE TYPE enum.
--   Rationale: text+CHECK allows ALTER TABLE to add sizes (e.g., 'extra_large')
--   at Phase 5.1 without enum DDL migration complexity.
--
-- This migration file is intentionally a no-op SQL statement.
-- The actual CHECK constraint is defined in 20260519050200_oxygen_tanks.sql.
-- DO NOT create CREATE TYPE oxygen_tank_size here.

SELECT 1 AS phase5_tank_size_design_decision_recorded;
-- ^ no-op: valid SQL, no schema change.
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify** (trivial — no schema artifact)

```sql
-- Confirm no enum type named oxygen_tank_size was created:
SELECT count(*) FROM pg_type WHERE typname = 'oxygen_tank_size';
-- Expected: 0
```

- [ ] **Step 4: Commit**

```
git add supabase/migrations/20260519050100_oxygen_tank_size_enum.sql
git commit -m "feat(db): tank_size design decision record (Phase 5 — text CHECK, not enum)"
```

---

## Task A3: Migration — `oxygen_tanks` table

**Decisions ref:** Derived constraint #1 (columns). Q-Phase5-5 (NO purchase_price or acquired_at). Q-Phase5-1 (tank_size text CHECK).

**File:** `supabase/migrations/20260519050200_oxygen_tanks.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519050200_oxygen_tanks.sql
-- Phase 5 — oxygen_tanks master table.
-- Decisions-locked: derived #1 (schema), Q-Phase5-5 (no purchase_price/acquired_at).
-- NOT a child of stock_items — separate standalone table.
-- tank_size: text CHECK (not enum) per Q-Phase5-I.
-- status: updated ONLY by apply_oxygen_movement() SECURITY DEFINER trigger.
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS oxygen_tanks (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  serial               text         UNIQUE NOT NULL,
    -- Manufacturer serial number engraved on the cylinder.
    -- Staff scan or type this value. Globally unique.
  tank_size            text         NOT NULL
    CHECK (tank_size IN ('small', 'medium', 'large')),
    -- Q-Phase5-1: 3 sizes confirmed. Q-Phase5-I: text CHECK (not enum) for extensibility.
    -- To add 'extra_large' at Phase 5.1: ALTER TABLE oxygen_tanks
    --   DROP CONSTRAINT oxygen_tanks_tank_size_check,
    --   ADD CONSTRAINT oxygen_tanks_tank_size_check CHECK (tank_size IN (...,'extra_large'));
  current_location_id  uuid         REFERENCES locations(id) ON DELETE RESTRICT,
    -- FK to Phase 0 locations table. NULL permitted only transiently during initial INSERT.
    -- NOT NULL enforced by application; DB allows NULL to permit atomic creation before
    -- the first oxygen_movements transition row sets the location.
  status               oxygen_tank_status NOT NULL DEFAULT 'ready',
    -- Authoritative current status. Updated ONLY by apply_oxygen_movement() AFTER INSERT
    -- trigger on oxygen_movements. Never updated directly by application code.
  last_refill_at       timestamptz,
    -- Set by apply_oxygen_movement() trigger when to_status='ready' AND from_status='refilling'.
  last_refill_by       text,
    -- Free text: name of staff or vendor who completed the refill.
  last_pressure_psi    int CHECK (last_pressure_psi IS NULL OR last_pressure_psi > 0),
    -- Optional: most recent PSI reading. No history kept here (Phase 5.1).
  next_inspection_due  date,
    -- Hydrostatic inspection compliance date. Alert cron deferred to Phase 5.1.
  notes                text,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  created_by           text         NOT NULL DEFAULT app_username(),
  updated_by           text         NOT NULL DEFAULT app_username()
  -- Q-Phase5-5: purchase_price and acquired_at are NOT in Phase 5.
  -- Deferred to Phase 5.1 (finance/insurance module).
);

COMMENT ON TABLE oxygen_tanks IS
  'Phase 5. One row per physical oxygen cylinder. Identity = serial number engraved on the '
  'cylinder. Status maintained by state-machine trigger on oxygen_movements. '
  'NOT a child of stock_items — per-piece serial identity model is architecturally '
  'distinct from SKU+qty model (Phase 1 spec §10, Q-Phase1-D).';

COMMENT ON COLUMN oxygen_tanks.serial IS
  'Manufacturer serial number. Unique globally. Staff scan/type to look up the tank.';
COMMENT ON COLUMN oxygen_tanks.status IS
  'Updated ONLY by apply_oxygen_movement() SECURITY DEFINER trigger. '
  'Direct UPDATE blocked by RLS false policy on UPDATE.';
COMMENT ON COLUMN oxygen_tanks.last_refill_at IS
  'Auto-set when a refilling→ready transition is recorded. Tracks most recent refill completion.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oxygen_tanks_status   ON oxygen_tanks (status);
CREATE INDEX IF NOT EXISTS idx_oxygen_tanks_location ON oxygen_tanks (current_location_id);
CREATE INDEX IF NOT EXISTS idx_oxygen_tanks_serial   ON oxygen_tanks (serial text_pattern_ops);
  -- text_pattern_ops supports LIKE 'OXY-%' prefix searches in admin filter.

-- Auto-update updated_at on any row change (reuses Phase 0 set_updated_at() helper).
DROP TRIGGER IF EXISTS trg_oxygen_tanks_updated_at ON oxygen_tanks;
CREATE TRIGGER trg_oxygen_tanks_updated_at
  BEFORE UPDATE ON oxygen_tanks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
-- 3a) Columns
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'oxygen_tanks'
ORDER BY ordinal_position;
-- Expected: 15 columns. status default = 'ready'. serial NOT NULL. No purchase_price. No acquired_at.

-- 3b) Constraints
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'oxygen_tanks'::regclass
ORDER BY conname;
-- Expected includes: oxygen_tanks_pkey (p), oxygen_tanks_serial_key (u),
--   oxygen_tanks_tank_size_check (c), fk to locations (f), last_pressure_psi check (c).

-- 3c) Indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'oxygen_tanks' ORDER BY indexname;
-- Expected: idx_oxygen_tanks_location, idx_oxygen_tanks_serial,
--   idx_oxygen_tanks_status, oxygen_tanks_pkey, oxygen_tanks_serial_key.

-- 3d) Trigger
SELECT trigger_name FROM information_schema.triggers WHERE event_object_table = 'oxygen_tanks';
-- Expected: trg_oxygen_tanks_updated_at
```

- [ ] **Step 4: Commit**

```
git add supabase/migrations/20260519050200_oxygen_tanks.sql
git commit -m "feat(db): oxygen_tanks table + constraints + indexes (Phase 5)"
```

**Rollback if this task fails:**
```sql
DROP TABLE IF EXISTS oxygen_tanks CASCADE;
```

---

## Task A4: Migration — `oxygen_movements` ledger table

**Decisions ref:** Derived constraint #4 (ledger schema). Q-Phase5-G (INSERT-only, no UPDATE/DELETE).

**File:** `supabase/migrations/20260519050300_oxygen_movements.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519050300_oxygen_movements.sql
-- Phase 5 — oxygen_movements immutable audit ledger.
-- Decisions-locked: derived #4, Q-Phase5-G (INSERT-only — no UPDATE/DELETE RLS).
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS oxygen_movements (
  id               uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  tank_id          uuid               NOT NULL REFERENCES oxygen_tanks(id) ON DELETE RESTRICT,
  from_status      oxygen_tank_status,
    -- NULL only for the first movement (initial placement: NULL → ready).
  to_status        oxygen_tank_status NOT NULL,
  from_location_id uuid               REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_id   uuid               REFERENCES locations(id) ON DELETE RESTRICT,
    -- from_ and to_location may be the same (e.g., maintenance at same site).
  performed_by     text               NOT NULL DEFAULT app_username(),
  performed_at     timestamptz        NOT NULL DEFAULT now(),
  note             text,
    -- Q-Phase5-3: maintenance reason stored here as free text. No sub-reason enum.
  photo_url        text,
    -- Optional Cloudinary URL. Folder: thegood-stock/oxygen/{serial}/
    -- Q-Phase5-4: optional on all transitions. photo_url nullable.
    -- Reuses shared/photo-capture.js from Phase 3 (see cross-phase dependency note).
  created_at       timestamptz        NOT NULL DEFAULT now()
  -- No updated_at: append-only. No UPDATE or DELETE permitted on this table.
);

COMMENT ON TABLE oxygen_movements IS
  'Phase 5. Immutable audit ledger of every oxygen tank state transition. '
  'INSERT-only — no UPDATE, no DELETE (RLS enforces; no UPDATE/DELETE policies exist). '
  'BEFORE INSERT trigger enforces state machine. AFTER INSERT trigger fires refill alert.';

COMMENT ON COLUMN oxygen_movements.from_status IS
  'NULL only for the first movement (initial placement: NULL → ready). '
  'Must match oxygen_tanks.status at time of INSERT (enforced by BEFORE INSERT trigger).';
COMMENT ON COLUMN oxygen_movements.note IS
  'Q-Phase5-3: maintenance reason captured here as free text. Phase 5.1 may add structured sub-reasons.';
COMMENT ON COLUMN oxygen_movements.photo_url IS
  'Q-Phase5-4: optional on all transitions. Cloudinary URL. '
  'Folder prefix: thegood-stock/oxygen/{tank_serial}/. Reuses Phase 3 photo-capture.js component.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oxygen_movements_tank_id
  ON oxygen_movements (tank_id, performed_at DESC);
  -- Primary drill-down: history for one tank ordered newest-first.

CREATE INDEX IF NOT EXISTS idx_oxygen_movements_to_status
  ON oxygen_movements (to_status, performed_at DESC);
  -- Refill alert trigger counts via oxygen_tanks.status (not this index), but
  -- this index supports admin reporting queries (e.g., all recent refilling events).
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
-- 3a) Columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'oxygen_movements'
ORDER BY ordinal_position;
-- Expected: 11 columns. No updated_at. photo_url nullable.

-- 3b) FKs
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'oxygen_movements'::regclass
ORDER BY conname;
-- Expected: oxygen_movements_pkey (p), oxygen_movements_tank_id_fkey (f),
--   FK to from_location_id, FK to to_location_id.

-- 3c) Indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'oxygen_movements' ORDER BY indexname;
-- Expected: idx_oxygen_movements_tank_id, idx_oxygen_movements_to_status, oxygen_movements_pkey.
```

- [ ] **Step 4: Commit**

```
git add supabase/migrations/20260519050300_oxygen_movements.sql
git commit -m "feat(db): oxygen_movements ledger table (Phase 5)"
```

**Rollback if this task fails:**
```sql
DROP TABLE IF EXISTS oxygen_movements CASCADE;
```

---

## Task A5: Migration — RLS policies

**Decisions ref:** Derived constraint #7 (read-all authenticated; Admin write on oxygen_tanks; Staff INSERT on oxygen_movements). Spec §8.

**File:** `supabase/migrations/20260519050400_oxygen_rls.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519050400_oxygen_rls.sql
-- Phase 5 — RLS policies for oxygen_tanks and oxygen_movements.
-- Pattern mirrors Phase 1 stock_rls policies (20260519000600 equivalent).
-- Helper functions app_user_role() and app_username() from Phase 0.
--
-- KEY DESIGN: oxygen_tanks UPDATE is blocked by RLS (WITH CHECK = false).
-- Only the apply_oxygen_movement() SECURITY DEFINER trigger may UPDATE oxygen_tanks.
-- This enforces that every status change goes through the movement ledger.
--
-- oxygen_movements has no UPDATE or DELETE policies — append-only by omission.

-- ── Enable RLS ─────────────────────────────────────────────────────────────

ALTER TABLE oxygen_tanks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE oxygen_movements ENABLE ROW LEVEL SECURITY;

-- ── oxygen_tanks policies ───────────────────────────────────────────────────

-- SELECT: all authenticated users
DROP POLICY IF EXISTS oxygen_tanks_select_all ON oxygen_tanks;
CREATE POLICY oxygen_tanks_select_all
  ON oxygen_tanks FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: Admin only (add new tank)
DROP POLICY IF EXISTS oxygen_tanks_insert_admin ON oxygen_tanks;
CREATE POLICY oxygen_tanks_insert_admin
  ON oxygen_tanks FOR INSERT
  TO authenticated
  WITH CHECK (app_user_role() = 'Admin');

-- UPDATE: blocked for all direct callers (only SECURITY DEFINER trigger may update)
DROP POLICY IF EXISTS oxygen_tanks_update_trigger_only ON oxygen_tanks;
CREATE POLICY oxygen_tanks_update_trigger_only
  ON oxygen_tanks FOR UPDATE
  TO authenticated
  USING (false);
  -- USING(false) = no row passes the filter for direct UPDATE.
  -- apply_oxygen_movement() runs SECURITY DEFINER and bypasses RLS.

-- DELETE: Admin only (rare — retire a row physically, not the normal retire-status flow)
DROP POLICY IF EXISTS oxygen_tanks_delete_admin ON oxygen_tanks;
CREATE POLICY oxygen_tanks_delete_admin
  ON oxygen_tanks FOR DELETE
  TO authenticated
  USING (app_user_role() = 'Admin');

-- ── oxygen_movements policies ───────────────────────────────────────────────

-- SELECT: all authenticated users
DROP POLICY IF EXISTS oxygen_movements_select_all ON oxygen_movements;
CREATE POLICY oxygen_movements_select_all
  ON oxygen_movements FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: Admin can log any transition.
--         Employee (Staff) can log to_status IN ('ready','on_board','refilling') only.
--         State machine trigger provides the final check regardless.
--         This RLS is a first-pass guard (prevents Staff from even attempting
--         maintenance/retired transitions — reduces noise in trigger logs).
DROP POLICY IF EXISTS oxygen_movements_insert_staff ON oxygen_movements;
CREATE POLICY oxygen_movements_insert_staff
  ON oxygen_movements FOR INSERT
  TO authenticated
  WITH CHECK (
    app_user_role() = 'Admin'
    OR (
      app_user_role() = 'Employee'
      AND to_status IN ('ready', 'on_board', 'refilling')
    )
  );

-- No UPDATE policy — UPDATE is implicitly blocked for authenticated role.
-- No DELETE policy — DELETE is implicitly blocked for authenticated role.
-- oxygen_movements is append-only enforced by absence of UPDATE/DELETE policies.
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
-- RLS enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename IN ('oxygen_tanks', 'oxygen_movements')
  AND schemaname = 'public';
-- Expected: both rows have rowsecurity = true.

-- Policies
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('oxygen_tanks', 'oxygen_movements')
ORDER BY tablename, policyname;
-- Expected for oxygen_tanks: SELECT (select_all), INSERT (insert_admin),
--   UPDATE (update_trigger_only), DELETE (delete_admin).
-- Expected for oxygen_movements: SELECT (select_all), INSERT (insert_staff).
-- No UPDATE or DELETE policies for oxygen_movements.
```

- [ ] **Step 4: Commit**

```
git add supabase/migrations/20260519050400_oxygen_rls.sql
git commit -m "feat(db): oxygen_tanks + oxygen_movements RLS policies (Phase 5)"
```

---

## Task A6: Migration — trigger functions (state machine + movement apply + refill alert)

**Decisions ref:** Derived constraints #5 (state machine, error string), #6 (refill alert, dedupe), #4 (AFTER INSERT updates oxygen_tanks). Q-Phase5-D (trigger reads settings table — NOT current_setting). Q-Phase5-J (retired terminal state).

**File:** `supabase/migrations/20260519050500_oxygen_triggers.sql`

**Critical implementation notes:**
1. The canonical FE-greppable error string for the state machine is (decisions-locked derived #5, verbatim):
   `'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'`
   This MUST appear in the RAISE EXCEPTION for the invalid-transition case.
2. Trigger reads `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from `settings` table. MUST NOT use `current_setting('app.*')` — Project.md §8 gotcha 9: `ALTER DATABASE SET app.*` is blocked on Supabase Free/Nano plan.
3. All three trigger functions are SECURITY DEFINER (required to read settings and update oxygen_tanks past RLS).
4. NO pg_cron job is created here. Refill alerting is event-driven.

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519050500_oxygen_triggers.sql
-- Phase 5 — Three trigger functions on oxygen_movements.
--
-- Function A: enforce_oxygen_state_machine() — BEFORE INSERT
--   Validates state-machine transitions. FE grep string:
--   'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง' (decisions-locked derived #5, verbatim).
--
-- Function B: apply_oxygen_movement() — AFTER INSERT
--   Updates oxygen_tanks.status, current_location_id, last_refill_at/by.
--
-- Function C: check_oxygen_refill_batch() — AFTER INSERT WHERE to_status='refilling'
--   Counts refilling tanks vs OXYGEN_REFILL_THRESHOLD.
--   If >= threshold and not yet alerted today: pg_net POST to tg-notify.
--   Dedupe key: 'oxygen_refill_batch:YYYY-MM-DD' (Bangkok timezone).
--   Reads NOTIFY_* from settings table — NOT current_setting('app.*').
--   Project.md §8 gotcha 9.
--
-- NO pg_cron job — Phase 5 alerting is event-driven (trigger-based).
-- Pattern mirrors Phase 2 stock_lot_triggers.sql BEFORE INSERT state machine
-- (check_lot_status) and Phase 0/1 tg-notify trigger pattern.
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION A: State machine — BEFORE INSERT on oxygen_movements
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION enforce_oxygen_state_machine()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $enforce_oxygen_state_machine$
DECLARE
  v_current_status oxygen_tank_status;
  v_serial         text;
  v_role           text;
BEGIN
  -- 1. Fetch the tank's current authoritative status and serial.
  SELECT status, serial
  INTO v_current_status, v_serial
  FROM oxygen_tanks
  WHERE id = NEW.tank_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'oxygen_tanks row not found for tank_id %', NEW.tank_id;
  END IF;

  v_role := app_user_role();  -- Phase 0 helper: returns 'Admin' or 'Employee'

  -- 2. Terminal state check: retired tanks block ALL further transitions.
  IF v_current_status = 'retired' THEN
    RAISE EXCEPTION 'ถังหมายเลข % ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้', v_serial;
  END IF;

  -- 3. Validate from_status matches current (unless initial placement where from_status IS NULL).
  IF NEW.from_status IS DISTINCT FROM v_current_status THEN
    RAISE EXCEPTION 'สถานะปัจจุบันของถัง (%) ไม่ตรงกับ from_status (%)',
      v_current_status::text, COALESCE(NEW.from_status::text, 'NULL');
  END IF;

  -- 4. State machine transition table.
  --    Decisions-locked derived #5. FE grep string for the blocked case:
  --    'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'
  IF NOT (
    -- Initial placement (NULL → ready, Admin only)
    (NEW.from_status IS NULL          AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- ready → on_board (Admin or Staff)
    (NEW.from_status = 'ready'        AND NEW.to_status = 'on_board') OR
    -- on_board → ready (Admin or Staff: ambulance returned, tank unused)
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'ready') OR
    -- on_board → refilling (Admin or Staff: tank emptied during run)
    (NEW.from_status = 'on_board'     AND NEW.to_status = 'refilling') OR
    -- refilling → ready (Admin only: refill batch completed)
    (NEW.from_status = 'refilling'    AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → maintenance (Admin only: pulled for service)
    (NEW.to_status = 'maintenance'    AND v_role = 'Admin') OR
    -- maintenance → ready (Admin only: maintenance complete)
    (NEW.from_status = 'maintenance'  AND NEW.to_status = 'ready'
      AND v_role = 'Admin') OR
    -- any → retired (Admin only: terminal — no return from retired)
    (NEW.to_status = 'retired'        AND v_role = 'Admin')
  ) THEN
    -- FE grep target string (decisions-locked derived #5, verbatim):
    RAISE EXCEPTION 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง';
  END IF;

  RETURN NEW;
END;
$enforce_oxygen_state_machine$;

COMMENT ON FUNCTION enforce_oxygen_state_machine() IS
  'Phase 5. BEFORE INSERT on oxygen_movements. Validates state-machine transitions. '
  'FE grep string for blocked transitions: ''การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'' '
  '(decisions-locked derived #5, verbatim). '
  'SECURITY DEFINER — reads oxygen_tanks and app_user_role() past RLS.';

DROP TRIGGER IF EXISTS trg_oxygen_state_machine ON oxygen_movements;
CREATE TRIGGER trg_oxygen_state_machine
  BEFORE INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_oxygen_state_machine();


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION B: Apply movement to oxygen_tanks — AFTER INSERT on oxygen_movements
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_oxygen_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $apply_oxygen_movement$
BEGIN
  UPDATE oxygen_tanks SET
    status              = NEW.to_status,
    current_location_id = COALESCE(NEW.to_location_id, current_location_id),
      -- Keep existing location if to_location_id not supplied (e.g., maintenance in-place).
    last_refill_at      = CASE
                            WHEN NEW.to_status = 'ready'
                             AND NEW.from_status = 'refilling'
                            THEN NEW.performed_at
                            ELSE last_refill_at
                          END,
    last_refill_by      = CASE
                            WHEN NEW.to_status = 'ready'
                             AND NEW.from_status = 'refilling'
                            THEN NEW.performed_by
                            ELSE last_refill_by
                          END,
    updated_at          = now(),
    updated_by          = NEW.performed_by
  WHERE id = NEW.tank_id;

  RETURN NEW;
END;
$apply_oxygen_movement$;

COMMENT ON FUNCTION apply_oxygen_movement() IS
  'Phase 5. AFTER INSERT on oxygen_movements. Updates oxygen_tanks.status, '
  'current_location_id, last_refill_at/by. SECURITY DEFINER bypasses RLS UPDATE block. '
  'last_refill_at/by set only when to_status=ready AND from_status=refilling.';

DROP TRIGGER IF EXISTS trg_oxygen_apply_movement ON oxygen_movements;
CREATE TRIGGER trg_oxygen_apply_movement
  AFTER INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION apply_oxygen_movement();


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION C: Refill-batch alert — AFTER INSERT on oxygen_movements
-- Only fires when to_status = 'refilling'.
-- Reads settings table (NOT current_setting — Project.md §8 gotcha 9).
-- Dedupe key: 'oxygen_refill_batch:YYYY-MM-DD' (Bangkok timezone).
-- Posts to tg-notify Edge Function via pg_net.
-- NO pg_cron — event-driven.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_oxygen_refill_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $check_oxygen_refill_batch$
DECLARE
  v_refilling_count  int;
  v_threshold        int;
  v_supabase_url     text;
  v_service_role_key text;
  v_enabled          boolean;
  v_chat_id          text;
  v_dedupe_key       text;
  v_already_sent     int;
  v_tank_list        text;
  v_payload          jsonb;
BEGIN
  -- Guard: only fire when a tank enters 'refilling' status.
  IF NEW.to_status <> 'refilling' THEN
    RETURN NEW;
  END IF;

  -- 1. Read settings from settings table.
  --    MUST use settings table — NOT current_setting('app.*').
  --    Project.md §8 gotcha 9: ALTER DATABASE for app.* blocked on Supabase Free/Nano.
  SELECT value INTO v_supabase_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_service_role_key FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT (value = 'true') INTO v_enabled
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
  SELECT value INTO v_chat_id
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
  SELECT value::int INTO v_threshold
    FROM settings WHERE key = 'OXYGEN_REFILL_THRESHOLD';

  -- 2. Guard: skip if notify credentials not configured.
  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE WARNING
      'check_oxygen_refill_batch: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY '
      'ยังไม่ได้ตั้งค่า — ข้ามการส่งแจ้งเตือน';
    RETURN NEW;
  END IF;

  -- 3. Guard: skip if Telegram globally disabled.
  IF v_enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- 4. Count tanks currently in 'refilling' state.
  SELECT count(*) INTO v_refilling_count
  FROM oxygen_tanks WHERE status = 'refilling';

  -- 5. Below threshold — no alert.
  IF v_refilling_count < COALESCE(v_threshold, 5) THEN
    RETURN NEW;
  END IF;

  -- 6. Dedupe: one alert per calendar day (Bangkok timezone).
  --    Key format: 'oxygen_refill_batch:YYYY-MM-DD'
  --    Mirrors Phase 1 'low_stock:<sku>:<date>' pattern.
  v_dedupe_key := 'oxygen_refill_batch:' ||
    to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

  SELECT count(*) INTO v_already_sent
  FROM notification_log
  WHERE dedupe_key = v_dedupe_key
    AND success = true;

  IF v_already_sent > 0 THEN
    RETURN NEW;  -- Already alerted today — silent skip.
  END IF;

  -- 7. Build grouped tank list for Telegram message body.
  SELECT string_agg(
    serial || ' (' || tank_size || ')',
    E'\n' ORDER BY serial
  ) INTO v_tank_list
  FROM oxygen_tanks WHERE status = 'refilling';

  v_payload := jsonb_build_object(
    'event_type', 'oxygen_refill_batch',
    'dedupe_key', v_dedupe_key,
    'message',    format(
      '[Stock] ถังออกซิเจนรอเติม %s ถัง (ถึงเกณฑ์ %s ถัง)%s%s',
      v_refilling_count,
      COALESCE(v_threshold, 5),
      E'\n',
      COALESCE(v_tank_list, '(ไม่พบรายการ)')
    ),
    'chat_id',    v_chat_id
  );

  -- 8. POST via pg_net to the existing tg-notify Edge Function (Phase 0).
  --    No new Edge Function required — reuses tg-notify with event_type='oxygen_refill_batch'.
  PERFORM net.http_post(
    url     := v_supabase_url || '/functions/v1/tg-notify',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_role_key,
      'apikey',        v_service_role_key,
      'X-Internal',    'true'
    ),
    body    := v_payload::text
  );

  RETURN NEW;
END;
$check_oxygen_refill_batch$;

COMMENT ON FUNCTION check_oxygen_refill_batch() IS
  'Phase 5. AFTER INSERT on oxygen_movements WHERE to_status=refilling. '
  'Counts refilling tanks vs OXYGEN_REFILL_THRESHOLD from settings table. '
  'If >= threshold and no alert today: pg_net POST to tg-notify (Phase 0) '
  'with event_type=oxygen_refill_batch. '
  'Dedupe key: oxygen_refill_batch:YYYY-MM-DD (Bangkok TZ). '
  'Reads NOTIFY_* from settings table — NOT current_setting (Project.md §8 gotcha 9). '
  'NO pg_cron — event-driven only.';

DROP TRIGGER IF EXISTS trg_oxygen_refill_alert ON oxygen_movements;
CREATE TRIGGER trg_oxygen_refill_alert
  AFTER INSERT ON oxygen_movements
  FOR EACH ROW EXECUTE FUNCTION check_oxygen_refill_batch();
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
-- 3a) Functions exist and are SECURITY DEFINER
SELECT proname, prosecdef
FROM pg_proc
WHERE proname IN (
  'enforce_oxygen_state_machine',
  'apply_oxygen_movement',
  'check_oxygen_refill_batch'
)
AND pronamespace = 'public'::regnamespace;
-- Expected: 3 rows, all prosecdef = true.

-- 3b) Triggers exist
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_table = 'oxygen_movements'
ORDER BY trigger_name;
-- Expected:
--   trg_oxygen_refill_alert   — INSERT — AFTER
--   trg_oxygen_apply_movement — INSERT — AFTER
--   trg_oxygen_state_machine  — INSERT — BEFORE

-- 3c) Smoke test: insert a valid initial placement (NULL → ready).
--     Requires a test tank to exist first. Use SQL Editor service role.
--     Insert oxygen_tanks row manually:
INSERT INTO oxygen_tanks (serial, tank_size, current_location_id)
SELECT 'OXY-SMOKE-TEST', 'medium', id FROM locations LIMIT 1;
--     Then insert the initial movement:
INSERT INTO oxygen_movements (tank_id, from_status, to_status, performed_by)
SELECT id, NULL, 'ready', 'smoke_test' FROM oxygen_tanks WHERE serial = 'OXY-SMOKE-TEST';
--     Expected: no exception. oxygen_tanks.status = 'ready'.
SELECT serial, status FROM oxygen_tanks WHERE serial = 'OXY-SMOKE-TEST';
-- Expected: OXY-SMOKE-TEST / ready

-- 3d) Smoke test: invalid transition blocked with exact error string.
INSERT INTO oxygen_movements (tank_id, from_status, to_status, performed_by)
SELECT id, 'ready', 'refilling', 'smoke_test' FROM oxygen_tanks WHERE serial = 'OXY-SMOKE-TEST';
-- Expected: RAISE EXCEPTION containing 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'

-- 3e) Cleanup smoke test rows.
DELETE FROM oxygen_movements
  WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-SMOKE-TEST');
DELETE FROM oxygen_tanks WHERE serial = 'OXY-SMOKE-TEST';
```

- [ ] **Step 4: Confirm error string verbatim.** Search the committed file for the exact Thai string:

```
grep 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง' supabase/migrations/20260519050500_oxygen_triggers.sql
```
Expected: 1 match inside the RAISE EXCEPTION clause of `enforce_oxygen_state_machine()`.

- [ ] **Step 5: Commit**

```
git add supabase/migrations/20260519050500_oxygen_triggers.sql
git commit -m "feat(db): oxygen state-machine + movement apply + refill alert triggers (Phase 5)"
```

**Rollback if this task fails:**
```sql
DROP TRIGGER IF EXISTS trg_oxygen_state_machine  ON oxygen_movements;
DROP TRIGGER IF EXISTS trg_oxygen_apply_movement ON oxygen_movements;
DROP TRIGGER IF EXISTS trg_oxygen_refill_alert   ON oxygen_movements;
DROP FUNCTION IF EXISTS enforce_oxygen_state_machine();
DROP FUNCTION IF EXISTS apply_oxygen_movement();
DROP FUNCTION IF EXISTS check_oxygen_refill_batch();
```

---

## Task A7: Migration — Realtime publication

**Decisions ref:** Derived constraint #8 (oxygen_tanks in supabase_realtime). Spec §3.

**File:** `supabase/migrations/20260519050600_oxygen_realtime.sql`

**Note:** `oxygen_movements` is NOT added to Realtime — the ledger is high-frequency insert noise; history is loaded on-demand via REST SELECT. Only `oxygen_tanks` (the live status board) gets Realtime.

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519050600_oxygen_realtime.sql
-- Phase 5 — Add oxygen_tanks to supabase_realtime publication.
-- oxygen_movements is intentionally excluded (INSERT-only ledger; detail loaded on demand).
-- Pattern mirrors Phase 2 20260519010600_stock_lots_realtime.sql.
-- Idempotent: DO block checks pg_publication_tables before ALTER.

DO $phase5_realtime$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'oxygen_tanks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE oxygen_tanks;
  END IF;
END
$phase5_realtime$;

COMMENT ON TABLE oxygen_tanks IS
  'Phase 5. One row per physical oxygen cylinder. Added to supabase_realtime. '
  'Status maintained by state-machine trigger on oxygen_movements. '
  'NOT a child of stock_items.';
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename = 'oxygen_tanks';
-- Expected: 1 row (oxygen_tanks)

-- oxygen_movements must NOT be in realtime:
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename = 'oxygen_movements';
-- Expected: 0 rows
```

- [ ] **Step 4: Commit**

```
git add supabase/migrations/20260519050600_oxygen_realtime.sql
git commit -m "feat(db): oxygen_tanks added to supabase_realtime publication (Phase 5)"
```

---

# Phase B — Frontend

**Pre-condition:** All Phase A migrations deployed and verified. PF-10 photo-capture.js decision made (Phase 3 or stub).

**Stack reminder:** Vanilla JS, no build step, ES modules via `<script type="module">`. Phase 0 Supabase client from `shared/supabase-client.js`. Auth helpers from `shared/auth.js`. Realtime from `shared/realtime.js`. Cloudinary helper from `shared/cloudinary.js`.

---

## Task B1: New file — `shared/oxygen.js`

**Purpose:** REST helpers for oxygen_tanks and oxygen_movements, plus client-side state-machine validation (mirrors server validation for UX feedback before the INSERT round-trip).

**File:** `shared/oxygen.js`

- [ ] **Step 1: Write the file.** The module must export:

  - `listTanks({ status, search })` — SELECT from `oxygen_tanks` with optional status filter and serial ILIKE search. Ordered by serial ASC.
  - `getTankBySerial(serial)` — SELECT one row from `oxygen_tanks` WHERE serial = supplied value. Returns null if not found.
  - `getTankHistory(tankId)` — SELECT from `oxygen_movements` WHERE tank_id = tankId ORDER BY performed_at DESC. Joins location names if needed.
  - `logTransition({ tankId, fromStatus, toStatus, toLocationId, note, photoUrl })` — INSERT into `oxygen_movements`. Returns the insert result.
  - `getTankStatusCounts()` — SELECT status, count(*) FROM oxygen_tanks GROUP BY status. Returns a map `{ ready: n, on_board: n, ... }`.
  - `ALLOWED_TRANSITIONS` — constant object mapping from-status to allowed to-status values (mirrors server state machine for client-side UX filtering):
    ```js
    export const ALLOWED_TRANSITIONS = {
      null:        ['ready'],           // initial placement (Admin only)
      ready:       ['on_board'],
      on_board:    ['ready', 'refilling'],
      refilling:   ['ready'],           // Admin only — enforced server-side
      maintenance: ['ready'],           // Admin only
      // retired: [] — no transitions from retired
    };
    ```
  - `ADMIN_ONLY_TRANSITIONS` — set of `to_status` values that require Admin role: `new Set(['refilling_to_ready', 'maintenance', 'retired'])`. Use this in UI to hide or grey out options when role = 'Employee'.
  - `STATUS_LABELS` — Thai display labels for each status value:
    ```js
    export const STATUS_LABELS = {
      ready:       'พร้อมใช้',
      on_board:    'ประจำรถ',
      refilling:   'รอเติม',
      maintenance: 'ซ่อมบำรุง',
      retired:     'ปลดระวาง',
    };
    ```
  - `STATUS_BADGE_CLASS` — Bootstrap badge CSS classes per status:
    ```js
    export const STATUS_BADGE_CLASS = {
      ready:       'badge bg-success',
      on_board:    'badge bg-primary',
      refilling:   'badge bg-warning text-dark',
      maintenance: 'badge bg-orange text-white',   // custom CSS var from Phase 0
      retired:     'badge bg-secondary',
    };
    ```
  - Error handling: when a logTransition INSERT fails with `error.message` containing `'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'`, surface a localised Thai message `'การเปลี่ยนสถานะนี้ไม่อนุญาต'` to the caller via a thrown Error.

- [ ] **Step 2: Verify module loads without error.** Open admin.html in browser (after B6 is done), open DevTools, import the module and call `listTanks({})`. Expected: returns an array (may be empty if no tanks yet).

- [ ] **Step 3: Commit**

```
git add shared/oxygen.js
git commit -m "feat(shared): oxygen.js REST helpers + client-state-machine + status labels (Phase 5)"
```

---

## Task B2: New file — `js/oxygen.js` (admin "ถังออกซิเจน" tab)

**Purpose:** Admin tab: tank list with filter bar, add-tank modal, tank detail/history drawer, log-transition modal.

**File:** `js/oxygen.js`

**UX source:** `docs/superpowers/designs/2026-05-19-phase5-oxygen-ui-design.md` §3.1–§3.4.

- [ ] **Step 1: Write the file.** Required sections:

  **Tank list view (default)**
  - Renders a table/card list with columns: serial, tank_size badge, status badge (colour from `STATUS_BADGE_CLASS`), current_location name, last_refill_at (date only, `—` if null), next_inspection_due (date + warning indicator if within 30 days).
  - Filter bar: status dropdown (All / values from STATUS_LABELS) + serial text search input.
  - "+ เพิ่มถัง" button visible to Admin only (check role from `shared/auth.js`).
  - Retired rows styled with `.text-muted` and grey badge. Retained in list (not hidden).
  - Realtime: subscribes to `oxygen_tanks` channel. On INSERT/UPDATE, re-renders affected row in the table (update-in-place preferred over full reload).

  **Add-tank modal (Admin only)**
  - Fields: serial (text, required), tank_size (select: small=เล็ก / medium=กลาง / large=ใหญ่), current_location_id (location picker, same pattern as Phase 1 receive modal), next_inspection_due (date input, optional), notes (textarea, optional).
  - On save: INSERT `oxygen_tanks` then INSERT `oxygen_movements` (from_status=null, to_status='ready', to_location_id=current_location_id, performed_by=current user). Both sequential — not a single transaction from browser.
  - On serial unique constraint error: show inline error "หมายเลขถังนี้มีอยู่แล้ว".
  - On success: toast "เพิ่มถังแล้ว", close modal, refresh list.

  **Tank detail / history drawer**
  - Triggered by row click.
  - Header: serial, status badge, size, current location, last_refill_at, next_inspection_due.
  - Movement history table: performed_at (date-time), from_status → to_status (Thai labels), performed_by, note (truncated to 50 chars with expand), photo thumbnail (if photo_url present — open in new tab on click).
  - "เปลี่ยนสถานะ" button (Admin) → opens log-transition modal.
  - Realtime: same `oxygen_tanks` channel subscription refreshes the drawer header on status change.

  **Log-transition modal (Admin)**
  - to_status select: only shows allowed transitions for current status (use `ALLOWED_TRANSITIONS` from `shared/oxygen.js`). Admin sees all; `ADMIN_ONLY_TRANSITIONS` items are included because this modal is Admin-only.
  - to_location_id picker: shown when transition changes location (on_board, ready after refilling, maintenance at different site).
  - note textarea (optional; labelled "เหตุผล / บันทึก").
  - Photo upload widget (optional — Q-Phase5-4): integrates `shared/photo-capture.js` (Phase 3 or stub). If stub, show "ยังไม่รองรับการอัปโหลดรูป (Phase 3 pending)" placeholder.
    - Cloudinary folder: `thegood-stock/oxygen/{tank.serial}/`
  - retire warning: if to_status = 'retired', show a confirmation banner "การปลดระวางเป็นการถาวร ไม่สามารถเปลี่ยนแปลงได้" before submit.
  - On submit: call `logTransition()` from `shared/oxygen.js`. On success: toast "เปลี่ยนสถานะแล้ว", close modal, refresh list and drawer.
  - On `'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'` error: toast "การเปลี่ยนสถานะนี้ไม่อนุญาต".

- [ ] **Step 2: Verify in browser.** Admin → "ถังออกซิเจน" tab loads without console error. List renders (empty is fine). "+ เพิ่มถัง" opens modal.

- [ ] **Step 3: Commit**

```
git add js/oxygen.js
git commit -m "feat(admin): oxygen tab — tank list, add-tank modal, detail drawer, transition modal (Phase 5)"
```

---

## Task B3: New file — `staff-oxygen.html`

**Purpose:** Dedicated staff mobile scan-and-transition page. Mirrors `staff-scan.html` shell.

**File:** `staff-oxygen.html`

**UX source:** `docs/superpowers/designs/2026-05-19-phase5-oxygen-ui-design.md` §3.5.

**Phase 3 dependency check:** Before writing this file, confirm `shared/photo-capture.js` exists (Phase 3) or is stubbed (per Phase 3 dependency section above).

- [ ] **Step 1: Write the file.** Structure mirrors `staff-scan.html`:
  - Same `<head>` (Bootstrap 5, Sarabun, Phase 0 CSS variables, `sw.js` registration).
  - Page title: "สแกนถังออกซิเจน — Thegood Stock".
  - Nav: Phase 0 navbar with back-link to `staff-home.html`.
  - Main: single `<div id="oxygen-scan-app">` — JS-controlled 7-step wizard.
  - Footer: same Phase 0 pattern.
  - `<script type="module" src="js/staff-oxygen.js"></script>` at end of body.

- [ ] **Step 2: Verify page loads in mobile browser.** Navigate to `staff-oxygen.html`. Confirm no 404, navbar visible, scan step renders.

- [ ] **Step 3: Commit**

```
git add staff-oxygen.html
git commit -m "feat(staff): staff-oxygen.html shell page (Phase 5)"
```

---

## Task B4: New file — `js/staff-oxygen.js`

**Purpose:** Staff 7-step oxygen scan wizard. Step sequence per UX §3.5 and spec §7.2.

**File:** `js/staff-oxygen.js`

- [ ] **Step 1: Write the file.** Implement the 7-step wizard state machine:

  **Step 1 — Scan**: Camera scan via `shared/scanner.js` (same scanner used in Phase 1 `staff-scan.js` — reuse the component). "พิมพ์แทน" fallback: text input field for manual serial entry. On serial captured: proceed to Step 2.

  **Step 2 — Tank status card**: Call `getTankBySerial(serial)` from `shared/oxygen.js`. If not found: inline error "ไม่พบถังหมายเลขนี้ในระบบ" (no crash, no transition). If found: show tank card (serial, current status badge, size, location). "ดำเนินการ" button → Step 3.

  **Step 3 — Transition select**: Show allowed `to_status` options for the tank's current status, filtered to Staff-accessible values only (exclude `maintenance`, `retired`, and `refilling → ready` which are Admin-only). Use tap cards (≥60 px height — UX §1.3 gloved hands). On select → Step 4 if location needed, else Step 5.

  **Step 4 — Location select (conditional)**: Show only when transition implies a location change (e.g., `ready → on_board`). Location picker (same component as Phase 1). On pick → Step 5.

  **Step 5 — Note (optional)**: Free-text textarea "บันทึก / เหตุผล (ไม่บังคับ)". "ถัดไป" button → Step 6.

  **Step 6 — Photo (optional)**: Calls `capturePhoto({ folder: 'thegood-stock/oxygen/' + tank.serial + '/' })` from `shared/photo-capture.js`. If stub: shows placeholder. If real: shows camera capture UI. Photo URL stored in state. "ถัดไป" / "ข้าม" button → Step 7.

  **Step 7 — Confirm and submit**: Summary card (tank serial, transition arrow, note, photo thumbnail if any). "ยืนยัน" button → calls `logTransition()` from `shared/oxygen.js`. On success: success overlay with new status badge. "สแกนถังถัดไป" resets wizard to Step 1.

  **Error handling:**
  - `'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'` in error → toast "การเปลี่ยนสถานะนี้ไม่อนุญาต กรุณาลองใหม่".
  - Retired tank error → toast "ถังนี้ถูกปลดระวางแล้ว ไม่สามารถใช้งานได้".
  - Network error → toast "ไม่สามารถเชื่อมต่อ กรุณาลองใหม่".

  **Phase 3 stub note:** Mark `capturePhoto` calls with `// [STUB — unify with Phase 3 photo-capture.js]` if running on the stub. Remove this comment when Phase 3 merges.

- [ ] **Step 2: Verify in mobile browser.** Log in as Employee. Open `staff-oxygen.html`. Complete a scan-and-transition for an existing `ready` tank → `on_board`. Confirm success overlay and DB row created.

- [ ] **Step 3: Commit**

```
git add js/staff-oxygen.js
git commit -m "feat(staff): staff-oxygen.js 7-step scan wizard (Phase 5)"
```

---

## Task B5: Extend `js/dashboard.js` — "สถานะถังออกซิเจน" panel

**Purpose:** Add the oxygen status summary panel to the dashboard.

**File:** `js/dashboard.js` (EDIT — existing file)

- [ ] **Step 1: Read the current `js/dashboard.js`** to identify where to insert the new panel (after Phase 1 inventory KPIs).

- [ ] **Step 2: Add the oxygen panel.** The panel must:
  - Call `getTankStatusCounts()` from `shared/oxygen.js` on dashboard load.
  - Render count badges for each status: ready / on_board / refilling / maintenance / retired, using `STATUS_LABELS` for Thai labels.
  - If `count('refilling') >= OXYGEN_REFILL_THRESHOLD` (read threshold from `shared/settings.js` helper or hardcode 5 as default if not yet loaded): show amber banner "ถังรอเติม {n} ถัง — ถึงเกณฑ์แจ้งเตือน".
  - "ดูทั้งหมด →" link navigates to admin.html?tab=oxygen (or dispatches the admin-shell tab event if same-page SPA).
  - Realtime: subscribe to `oxygen_tanks` channel on dashboard. On INSERT/UPDATE: re-call `getTankStatusCounts()` and re-render the panel.

- [ ] **Step 3: Verify in browser.** Admin → Dashboard tab. Oxygen panel visible. Counts match SQL:
  ```sql
  SELECT status, count(*) FROM oxygen_tanks GROUP BY status ORDER BY status;
  ```

- [ ] **Step 4: Commit**

```
git add js/dashboard.js
git commit -m "feat(dashboard): oxygen status panel with counts + realtime + refill alert badge (Phase 5)"
```

---

## Task B6: Edit `admin.html` — register "ถังออกซิเจน" tab

**Purpose:** Add the new oxygen tab to the admin navigation bar.

**File:** `admin.html` (EDIT — existing file)

- [ ] **Step 1: Read the current `admin.html`** nav section to identify where to insert the new tab item.

- [ ] **Step 2: Add the nav item.** Tab slug: `oxygen`. Thai label: "ถังออกซิเจน". Insert after the "คลังสินค้า" (inventory/Phase 1) tab. Wrap to second row at 360px via existing `flex-wrap` CSS (Q-O1 decision — no new CSS required; existing Phase 0 nav wrapping handles it).

  The nav item must follow the same pattern as existing tabs (data attribute for lazy loading, active class management by admin-shell.js).

- [ ] **Step 3: Verify at 360px viewport.** In Chrome DevTools device emulator at 360px width: all tabs visible (wrapping to 2 rows). No horizontal scroll.

- [ ] **Step 4: Commit**

```
git add admin.html
git commit -m "feat(admin): register ถังออกซิเจน nav tab (Phase 5)"
```

---

## Task B7: Edit `js/admin-shell.js` — register oxygen tab

**Purpose:** Wire the oxygen tab slug to lazy-load `js/oxygen.js`.

**File:** `js/admin-shell.js` (EDIT — existing file)

- [ ] **Step 1: Read the current `js/admin-shell.js`** to identify the tab registration pattern.

- [ ] **Step 2: Add oxygen tab registration.** Register slug `'oxygen'` → loads `js/oxygen.js` on first activation. Follow the exact pattern used for existing tabs (no change to any other tab's registration).

- [ ] **Step 3: Verify.** Admin → click "ถังออกซิเจน" tab. `js/oxygen.js` loads (Network DevTools shows the request). No console errors.

- [ ] **Step 4: Commit**

```
git add js/admin-shell.js
git commit -m "feat(admin): register oxygen tab in admin-shell lazy-load router (Phase 5)"
```

---

## Task B8: Edit `js/staff-home.js` — add oxygen scan link

**Purpose:** Staff home page must surface the new `staff-oxygen.html` page.

**File:** `js/staff-home.js` (EDIT — existing file)

- [ ] **Step 1: Read the current `js/staff-home.js`** to understand the link/button rendering pattern.

- [ ] **Step 2: Add the oxygen link.** Add a prominent button/card linking to `staff-oxygen.html`. Label: "สแกนถังออกซิเจน". Icon: optional (use a cylinder or circle icon consistent with Phase 0 icon set — no emoji). Place it alongside the existing `staff-scan.html` link (Q-Phase5-6 decision: separate pages, no mode toggle).

- [ ] **Step 3: Verify on mobile.** Log in as Employee. Staff home shows both "สแกนคลัง" (Phase 1) and "สแกนถังออกซิเจน" (Phase 5) buttons. Tapping the oxygen button navigates to `staff-oxygen.html`.

- [ ] **Step 4: Commit**

```
git add js/staff-home.js
git commit -m "feat(staff): add ถังออกซิเจน scan link on staff home (Phase 5)"
```

---

## Task B9: Edit `sw.js` — bump CACHE_VERSION + add Phase 5 assets

**Purpose:** Service worker must cache new Phase 5 files.

**File:** `sw.js` (EDIT — existing file)

**CACHE_VERSION deploy sequence (read before editing):**
- If `shared/photo-capture.js` already exists (Phase 3 deployed first): Phase 3 set CACHE_VERSION to `v0.4.0`. Phase 5 bumps to `v0.5.0`.
- If `shared/photo-capture.js` does NOT exist (Phase 5 deploys first): Phase 5 sets CACHE_VERSION to `v0.4.0`. Phase 3 will bump to `v0.5.0` when it integrates.
- **Developer must check** the current CACHE_VERSION in `sw.js` before editing and increment accordingly.

- [ ] **Step 1: Read the current `sw.js`** to find `CACHE_VERSION` and `STATIC_ASSETS` array.

- [ ] **Step 2: Bump CACHE_VERSION** by one minor version per the sequence above.

- [ ] **Step 3: Add Phase 5 assets to STATIC_ASSETS:**

  ```js
  'shared/oxygen.js',
  'js/oxygen.js',
  'js/staff-oxygen.js',
  'staff-oxygen.html',
  ```

- [ ] **Step 4: Verify.** In browser: open DevTools → Application → Service Workers → Update. Confirm new cache version installed. Navigate to `staff-oxygen.html` while offline — page loads from cache.

- [ ] **Step 5: Commit**

```
git add sw.js
git commit -m "feat(sw): bump CACHE_VERSION + add Phase 5 oxygen assets to STATIC_ASSETS"
```

---

# Phase C — Acceptance tests

## Task C1: Write and execute T101–T125

**Purpose:** Write 25 test rows to `docs/test-checklist.md` and execute each test.

**File:** `docs/test-checklist.md` (EDIT — append to existing test list)

- [ ] **Step 1: Append T101–T125 to `docs/test-checklist.md`.** Use the exact format of T1–T100 already in the file. Tests below are the canonical list.

### T101–T125 test definitions

Pre-flight: Phase 5 migrations `20260519050000`–`20260519050600` deployed. All Phase A tasks complete. At least one location exists (PF-9). All Phase B tasks complete.

Test data: All test tanks use deterministic serials (`OXY-T101` to `OXY-T125`). Run cleanup SQL at end of test session.

---

**Data model verification**

- [ ] **T101** `oxygen_tanks` table exists with correct schema — 15 columns, status default `'ready'`, serial UNIQUE NOT NULL, no purchase_price, no acquired_at.
  ```sql
  SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'oxygen_tanks' ORDER BY ordinal_position;
  -- Expected: 15 columns. status default='ready'. serial NOT NULL.
  -- MUST NOT contain purchase_price or acquired_at columns.
  ```

- [ ] **T102** `oxygen_movements` table exists — INSERT-only enforced (no UPDATE/DELETE RLS policies).
  ```sql
  SELECT policyname, cmd FROM pg_policies WHERE tablename = 'oxygen_movements';
  -- Expected: SELECT and INSERT policies only. Zero UPDATE or DELETE policies.
  ```

- [ ] **T103** `oxygen_tank_status` enum has exactly 5 values in correct order.
  ```sql
  SELECT enumlabel FROM pg_enum
  WHERE enumtypid = 'oxygen_tank_status'::regtype ORDER BY enumsortorder;
  -- Expected: ready, on_board, refilling, maintenance, retired (5 rows).
  ```

- [ ] **T104** `tank_size` CHECK constraint — INSERT with invalid size fails.
  ```sql
  INSERT INTO oxygen_tanks (serial, tank_size, current_location_id)
  SELECT 'OXY-T104-BADSIZE', 'huge', id FROM locations LIMIT 1;
  -- Expected: ERROR — violates check constraint oxygen_tanks_tank_size_check.
  -- No oxygen_tanks row created.
  ```

---

**Admin: Add tank**

- [ ] **T105** Admin creates new tank — `oxygen_tanks` row + initial `oxygen_movements` row (NULL → ready).
  - Steps: Log in as Admin. Admin → "ถังออกซิเจน" tab → "+ เพิ่มถัง". Fill: serial=`OXY-T105`, size=medium, location=any, next_inspection_due=90 days. Click "บันทึก".
  - Expected: toast "เพิ่มถังแล้ว". DB:
  ```sql
  SELECT serial, status, tank_size FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: OXY-T105 / ready / medium

  SELECT from_status, to_status FROM oxygen_movements
  WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-T105')
  ORDER BY performed_at ASC LIMIT 1;
  -- Expected: NULL / ready
  ```

- [ ] **T106** Duplicate serial rejected.
  - Steps: Attempt to add a second tank with serial `OXY-T105` (T105 must already exist).
  - Expected: inline error "หมายเลขถังนี้มีอยู่แล้ว". No second `oxygen_tanks` row.
  ```sql
  SELECT count(*) FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: 1
  ```

---

**State machine — allowed transitions**

- [ ] **T107** `ready → on_board` — status updates, movement row inserted, location updated.
  - Steps: Admin → tank `OXY-T105` → "เปลี่ยนสถานะ" → `on_board`, location = ambulance location, note="T107". Submit.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: on_board

  SELECT from_status, to_status, note FROM oxygen_movements
  WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-T105')
  ORDER BY performed_at DESC LIMIT 1;
  -- Expected: ready / on_board / T107
  ```

- [ ] **T108** `on_board → refilling` succeeds (Staff role).
  - Steps: Log in as Employee. `staff-oxygen.html` → scan `OXY-T105` (now on_board) → select `refilling`. Submit.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: refilling
  ```

- [ ] **T109** `refilling → ready` by Admin — `last_refill_at` and `last_refill_by` updated.
  - Steps: Admin → tank `OXY-T105` (refilling) → "เปลี่ยนสถานะ" → `ready`. Submit.
  ```sql
  SELECT status, last_refill_at IS NOT NULL AS has_refill_ts, last_refill_by
  FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: ready / true / <admin username>
  ```

- [ ] **T110** `any → maintenance` by Admin succeeds.
  - Steps: Admin → tank `OXY-T105` (ready) → "เปลี่ยนสถานะ" → `maintenance`, note="hydrostatic test". Submit.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: maintenance
  SELECT note FROM oxygen_movements
  WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-T105')
  ORDER BY performed_at DESC LIMIT 1;
  -- Expected: hydrostatic test
  ```

- [ ] **T111** `maintenance → ready` by Admin succeeds.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: ready (after admin logs maintenance→ready)
  ```

---

**State machine — blocked transitions**

- [ ] **T112** Invalid transition (`ready → refilling`) blocked with exact Thai error string.
  - Steps: DevTools Console (Admin JWT):
  ```js
  const { error } = await supabase.from('oxygen_movements').insert({
    tank_id: '<OXY-T105 uuid>',
    from_status: 'ready',
    to_status: 'refilling',
    performed_by: 'test'
  });
  console.log(error?.message);
  ```
  - Expected: `error.message` contains exactly `'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'`. HTTP 400.
  ```sql
  SELECT count(*) FROM oxygen_movements WHERE to_status='refilling' AND from_status='ready';
  -- Expected: 0
  ```

- [ ] **T113** Retired tank — any transition blocked.
  - Steps: SQL Editor (service role): `UPDATE oxygen_tanks SET status='retired' WHERE serial='OXY-T105';` Then attempt any INSERT into `oxygen_movements` for OXY-T105.
  - Expected: error contains `'ถังหมายเลข OXY-T105 ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้'`. Status stays `retired`.

- [ ] **T114** `from_status` mismatch blocked.
  - Steps: Tank OXY-T105 is `retired`. Insert movement with `from_status='ready'`, `to_status='on_board'`.
  - Expected: error contains `'สถานะปัจจุบันของถัง'` and `'ไม่ตรงกับ from_status'`.

---

**Admin-only transitions**

- [ ] **T115** Staff cannot log `refilling → ready` — RLS blocks INSERT.
  - Steps: Log in as Employee. DevTools Console:
  ```js
  const { error } = await supabase.from('oxygen_movements').insert({
    tank_id: '<refilling tank uuid>',
    from_status: 'refilling',
    to_status: 'ready',
    performed_by: 'pt1'
  });
  console.log(error?.code);
  ```
  - Expected: `error.code = '42501'`. No row inserted.

- [ ] **T116** Staff cannot log transition to `maintenance` — RLS blocks.
  - Expected: `error.code = '42501'`.

---

**Refill-batch alert**

- [ ] **T117** Alert fires when refilling count reaches threshold (5).
  - Pre-conditions: `OXYGEN_REFILL_THRESHOLD=5`, `NOTIFY_TELEGRAM_ENABLED=true`, URL + key set.
  - Steps: Create 5 tanks via SQL Editor, transition all to `refilling`. After 5th INSERT:
  ```sql
  SELECT event_type, dedupe_key, success
  FROM notification_log
  WHERE dedupe_key = 'oxygen_refill_batch:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
  -- Expected: 1 row, success=true
  ```
  - Expected also: Telegram message received listing 5 serials with sizes.

- [ ] **T118** Dedupe — 6th tank entering refilling same day does NOT send second alert.
  ```sql
  SELECT count(*) FROM notification_log
  WHERE dedupe_key = 'oxygen_refill_batch:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
  -- Expected: 1 (still 1 after 6th tank)
  ```

- [ ] **T119** Below threshold (4 tanks) — no alert fires.
  ```sql
  SELECT count(*) FROM oxygen_tanks WHERE status = 'refilling';
  -- Expected: 4. No new notification_log row for today.
  ```

---

**Realtime**

- [ ] **T120** `oxygen_tanks` Realtime subscription — status badge updates in admin tab without page reload.
  - Steps: Admin tab "ถังออกซิเจน" open. In SQL Editor (service role), directly `UPDATE oxygen_tanks SET status='on_board' WHERE serial='OXY-T105';`
  - Expected: Status badge in admin tab updates within ~2 seconds, no page reload.

---

**Dashboard panel**

- [ ] **T121** Dashboard "สถานะถังออกซิเจน" panel shows correct per-status counts.
  ```sql
  SELECT status, count(*) FROM oxygen_tanks GROUP BY status ORDER BY status;
  -- Compare each count against dashboard panel display.
  ```

- [ ] **T122** Dashboard alert badge appears when refilling count >= threshold.
  - Steps: Ensure `count(status='refilling') >= OXYGEN_REFILL_THRESHOLD`. Reload Dashboard.
  - Expected: amber banner "ถังรอเติม {n} ถัง — ถึงเกณฑ์แจ้งเตือน" visible.

---

**Staff scan flow**

- [ ] **T123** Staff scans tank serial — sees status card and logs `ready → on_board`.
  - Steps: Log in as Employee. `staff-oxygen.html`. Scan/type `OXY-T105` (status=ready). Select on_board. Pick location. Submit.
  - Expected: Success overlay. `oxygen_tanks.status = 'on_board'`. New movement row with `performed_by = <employee username>`.

- [ ] **T124** Staff scans unknown serial — inline error, no crash.
  - Steps: Enter serial `OXY-DOESNT-EXIST`.
  - Expected: Inline error "ไม่พบถังหมายเลขนี้ในระบบ". No 500 error. No row created.

---

**Service worker**

- [ ] **T125** CACHE_VERSION bumped — new SW version installs. `staff-oxygen.html` loads offline.
  - Steps: DevTools → Application → Service Workers → confirm new CACHE_VERSION active. Simulate offline. Navigate to `staff-oxygen.html`.
  - Expected: Page loads from cache. No network error.

---

- [ ] **Step 2: Execute T101–T125.** Mark each as pass or fail in `docs/test-checklist.md`. For any failure, fix the root cause in the relevant Phase A/B task before proceeding.

- [ ] **Step 3: Commit**

```
git add docs/test-checklist.md
git commit -m "test: add Phase 5 oxygen acceptance tests T101-T125 (Phase 5)"
```

---

# Phase D — Wrap-up

## Task D1: Git tag + Project.md update

- [ ] **Step 1: Confirm all of the following before tagging:**
  - All T101–T125 marked pass in `docs/test-checklist.md`.
  - All Phase A tasks committed (`20260519050000`–`20260519050600` migration files in repo).
  - All Phase B tasks committed (shared/oxygen.js, js/oxygen.js, staff-oxygen.html, js/staff-oxygen.js, js/dashboard.js edit, admin.html edit, js/admin-shell.js edit, js/staff-home.js edit, sw.js edit).
  - No console errors on Admin → "ถังออกซิเจน" tab, Dashboard panel, or `staff-oxygen.html`.

- [ ] **Step 2: Create git tag**

```
git tag phase5-oxygen
git push origin phase5-oxygen
```

- [ ] **Step 3: Update `docs/Project.md`** (EDIT — existing file). Add Phase 5 section summarising:
  - Tables added: `oxygen_tanks`, `oxygen_movements`
  - Enum added: `oxygen_tank_status`
  - Triggers: `enforce_oxygen_state_machine`, `apply_oxygen_movement`, `check_oxygen_refill_batch`
  - New pages: `staff-oxygen.html`
  - New JS: `shared/oxygen.js`, `js/oxygen.js`, `js/staff-oxygen.js`
  - Dashboard extension: oxygen status panel
  - Alert: `event_type='oxygen_refill_batch'` via `tg-notify` (no new Edge Function)
  - Tag: `phase5-oxygen`
  - Known pending: Phase 3 `shared/photo-capture.js` stub → real integration when Phase 3 merges.

- [ ] **Step 4: Commit**

```
git add docs/Project.md
git commit -m "docs: Phase 5 oxygen tanks summary in Project.md"
```

---

## Effort + risks

| Area | Tasks | Estimate |
|---|---|---|
| DB migrations (7 files) | A1–A7 | 2–3 h |
| Trigger functions (3 functions, smoke tests) | A6 | 3–4 h |
| Admin tab (list, add modal, detail, transition) | B2 | 6–8 h |
| Staff page (7-step wizard) | B3–B4 | 4–5 h |
| Shared REST helpers | B1 | 1–2 h |
| Dashboard panel | B5 | 1–2 h |
| Wiring (admin.html, admin-shell.js, staff-home.js, sw.js) | B6–B9 | 1–2 h |
| Acceptance testing T101–T125 | C1 | 3–4 h |
| Docs + tag | D1 | 0.5 h |
| **Total** | | **~22–31 h** |

**Risks:**

| Risk | Mitigation |
|---|---|
| `shared/photo-capture.js` not yet available (Phase 3 delayed) | Use stub per cross-phase dependency section. Mark with `[STUB]` comments. |
| `app_user_role()` returns unexpected value in trigger | Verify in PF-7. If helper is missing, deploy from Phase 0 source before A6. |
| `OXYGEN_REFILL_THRESHOLD` setting missing from settings table | PF-6 checks. If missing: `INSERT INTO settings(key,value) VALUES('OXYGEN_REFILL_THRESHOLD','5') ON CONFLICT(key) DO NOTHING;` |
| Nav overflow past 10 tabs | Q-O1 decision: flex-wrap to 2 rows. No action needed unless tabs exceed 10 total. |
| `pg_net` schema not in search_path for trigger | All SECURITY DEFINER functions set `search_path = public, net, pg_temp` — net schema included. |

---

## Out-of-scope reminders (do not implement)

The following items were excluded by PM decision. If any surfaces as a blocker, escalate before implementing:

- Per-tank pressure history chart (Phase 5.1)
- Hydrostatic inspection cron alert (Phase 5.1)
- `purchase_price` / `acquired_at` columns (Q-Phase5-5 deferred)
- Maintenance sub-reason enum (Q-Phase5-3 deferred)
- Multi-photo per transition (Phase 5.1)
- 5-minute retire undo window (Phase 5.1)
- Vendor refill SLA tracking (Phase 5.1+)
- Ambulance dispatch integration (Phase 6+)
- Bulk tank import from spreadsheet (Phase 5.1)

---

**Hand-off to:** `backend-developer` for Phase A, `frontend-developer` for Phase B. Phase C (tests) is a shared responsibility.

**Next phase:** Phase 3 (Borrow/Return) if not yet complete — required to replace the `shared/photo-capture.js` stub with the real Cloudinary photo-capture component.
