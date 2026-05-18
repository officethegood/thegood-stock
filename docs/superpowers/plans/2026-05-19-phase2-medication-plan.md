# Phase 2 — Medication Lots + Expiry Tracking + 30/60/90-Day Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** READY TO EXECUTE — PM decisions locked 2026-05-19. Do not start until Phase 1 tag `phase1-inventory` exists and T24–T44 pass.
**Predecessor:** [`docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md`](2026-05-18-phase1-inventory-plan.md) (Phase 1)
**Decisions source of truth:** [`docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md`](../specs/2026-05-19-phase2-decisions-locked.md)
**Full spec:** [`docs/superpowers/specs/2026-05-18-phase2-medication-design.md`](../specs/2026-05-18-phase2-medication-design.md)
**Full UX design:** [`docs/superpowers/designs/2026-05-18-phase2-ui-design.md`](../designs/2026-05-18-phase2-ui-design.md)

---

## Pre-implementation findings (dissent log)

The plan author cross-checked the decisions-locked doc against the spec and UX design. Findings below are flagged for PM awareness **before** any task starts.

### F1. pg_cron availability on Free/Nano plan

The spec assumes `pg_cron` is enabled. On Supabase Free/Nano, `pg_cron` is available but must be explicitly enabled by the operator (it is NOT auto-enabled). Additionally, `pg_cron` schedules run under the `supabase_admin` role, not `postgres`, which means the cron function body must be `SECURITY DEFINER` to write to application tables. This plan marks the cron migration with an explicit check and provides a **Cloudflare Worker fallback path** inline (see Task A8).

### F2. `recalled_reason`, `recalled_by`, `recalled_at` columns

The decisions-locked doc (derived constraint #1) lists `recalled_reason text`, `recalled_by text`, `recalled_at timestamptz` as columns in `stock_lots`. The spec §5.1 does NOT include these three columns in the `CREATE TABLE` DDL — it uses the `note` column for recall reason (appended by UI per UX §5.3 recall flow). The plan follows the **decisions-locked doc** (it is the binding document) and adds all three explicit audit columns. The `note` column is retained for general use. **Escalated to PM:** This is a minor schema addition (three extra columns) not in the spec DDL but mandated by the decisions doc. If PM objects, the plan can remove them. Implementing per decisions-locked doc.

### F3. `stock_lot_status` enum name vs. spec `lot_status`

The decisions-locked doc (derived #2) names the enum `stock_lot_status`. The spec §5.1 uses `lot_status`. The plan uses `stock_lot_status` as the decisions doc is binding. No functional difference; name change only.

### F4. FEFO override audit column

Decisions-locked derived #11 requires `fefo_override boolean NOT NULL DEFAULT false` on `stock_movements`. This column does not appear in the Phase 1 `stock_movements` DDL. Task A3 adds it via ALTER TABLE. This is the correct Phase 2 additive approach.

### F5. Force-issue override (S-2.5) removed from scope

Decisions Q-D1 removes the UX §3.7 / S-2.5 force-issue override modal from Phase 2. The UX design doc (§3.1.5 and §5.1 state diagram) references this flow. **Implementers must NOT build S-2.5.** The lot detail expand should show the lot's detail card only; the `[บังคับเบิก-จ่าย]` button is out of scope.

### F6. `borrow` and `transfer_out` in check_lot_status trigger

The decisions-locked doc Q-Phase2-4 specifies the BEFORE INSERT trigger fires for `movement_type IN ('issue','adjustment_loss','borrow','transfer_out')`. The spec §5.4 / §11 Q-Phase2-4 pseudocode only mentions `issue` and `adjustment_loss`. The plan follows the **decisions-locked doc** which lists four movement types. No contradiction with patient-safety logic.

### F7. Spec migration timestamps use `20260520…`; decisions-locked uses `20260519…`

The spec §4 lists migration files under `20260520000000…` (written a day before decisions were locked). The decisions doc explicitly names `20260519000000_stock_lot_status_enum.sql` etc. The plan uses `20260519…` timestamps as specified in the decisions doc. These are the correct timestamps for the next-day-after-Phase1 pattern (Phase 1 used `20260519…`).

**Wait — Phase 1 also used `20260519…` timestamps** (confirmed in the Phase 1 plan, Task A1: `20260519000000_stock_categories.sql`). Phase 2 migrations therefore need a DIFFERENT timestamp to avoid collision. The decisions doc says `20260519000000_stock_lot_status_enum.sql` which would collide with Phase 1's `20260519000000_stock_categories.sql`. **This is a contradiction between the decisions doc and Phase 1 reality.**

**Escalated to PM (Contradiction C-1):** Phase 1 plan occupies timestamps `20260519000000` through `20260519000700`. The decisions-locked doc assigns Phase 2 migrations to `20260519000000` which collides. Recommendation: use `20260519010000` through `20260519010900` for Phase 2 (same date, higher sequence). Plan uses this resolution; PM may override.

---

## Goal

Extend the Phase 1 general inventory system with medication-specific lot tracking, expiry date enforcement, daily auto-expire + 30/60/90-day Telegram alerts, and Admin lot management UI. The patient-safety hard requirement is DB-level blocking of expired/recalled lots from any issue movement.

## Architecture summary

Phase 2 is purely additive. New table `stock_lots` + FK promotion on `stock_movements.lot_id` + two new triggers + one `pg_cron` job + one MEDICATION category seed + frontend extensions to `js/inventory.js`, `js/staff-scan.js`, `js/dashboard.js` + new files `js/inventory-lots.js` and `shared/lots.js`.

## Tech stack

Unchanged from Phase 1. Supabase Dashboard-only deployment (no CLI). Migrations: paste into SQL Editor. Frontend: vanilla JS, no build step, pushed to GitHub Pages.

## Testing approach

Manual checklist pattern (T45–T70) from spec §9. Each task ends with concrete verification: SQL count, REST curl, or Chrome-MCP screenshot expectation. Trigger-level invariants get SQL smoke tests in Task C1.

## Source of truth

`docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md` — locked decisions Q-Phase2-1 through Q-D5 + derived #1–#11 are binding. Acceptance tests T45–T70 live in spec §9.

---

## Pre-flight checklist (must pass before Task A1 starts)

- [ ] **PF-1** `git tag | grep phase1-inventory` returns a tag. Phase 1 is stable and tagged.
- [ ] **PF-2** All Phase 1 acceptance tests T24–T44 are marked pass in `docs/test-checklist.md`.
- [ ] **PF-3** Confirm Phase 1 migration timestamps in `supabase/migrations/`: `20260519000000` through `20260519000700` are present and deployed. Verify in SQL Editor:
  ```sql
  SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN
    ('stock_categories','stock_items','stock_item_locations','stock_movements');
  -- Expected: 4 rows
  ```
- [ ] **PF-4** Confirm `stock_movements` has column `lot_id uuid` with no FK yet:
  ```sql
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name='stock_movements' AND column_name='lot_id';
  -- Expected: 1 row, data_type=uuid
  SELECT conname FROM pg_constraint
  WHERE conrelid='stock_movements'::regclass AND conname='fk_movements_lot';
  -- Expected: 0 rows (not yet a FK)
  ```
- [ ] **PF-5** Confirm `pg_net` extension is present (required for cron-to-tg-notify calls):
  ```sql
  SELECT extname FROM pg_extension WHERE extname='pg_net';
  -- Expected: 1 row
  ```
- [ ] **PF-6** Confirm `settings` table has rows for `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY`:
  ```sql
  SELECT key, length(value) AS val_len FROM settings
  WHERE key IN ('NOTIFY_SUPABASE_URL','NOTIFY_SERVICE_ROLE_KEY','EXPIRY_ALERT_DAYS')
  ORDER BY key;
  -- Expected: at minimum NOTIFY_SUPABASE_URL and NOTIFY_SERVICE_ROLE_KEY (2 rows).
  -- EXPIRY_ALERT_DAYS may not exist yet (Task A8 seeds it).
  ```
- [ ] **PF-7** Check if `pg_cron` extension is available on the Supabase plan:
  ```sql
  SELECT extname FROM pg_available_extensions WHERE name='pg_cron';
  -- Expected: 1 row = available. If 0 rows, use the Cloudflare Worker fallback in Task A8.
  ```
- [ ] **PF-8** Confirm no migration file already uses the Phase 2 timestamp range `20260519010000–20260519010900`:
  ```bash
  ls "F:\@Coding\ระบบ\The Good Stock\supabase\migrations\" | grep "202605190[1-9]"
  ```
  Expected: no output (timestamps free).

---

## Reading order

This plan has 4 execution phases (A–D). Within a phase tasks are sequential. Phase A (DB) must fully complete before Phase B (frontend). Phase C (tests) runs after all A+B tasks pass per-task verification. Phase D (docs) closes the phase.

| Phase | Tasks | Focus |
|---|---|---|
| A | A1–A8 | DB migrations: enum, table, FK extension, RLS, triggers, realtime, category seed, cron |
| B | B1–B6 | Frontend: shared lots module, inventory extensions, staff-scan, dashboard, CSS, SW bump |
| C | C1 | Acceptance test plan T45–T70 |
| D | D1 | Smoke checklist update + Project.md + test-checklist.md additions |

Effort estimate: Phase A 0.5d, B 1.2d, C 0.3d, D 0.2d → **~2.2 days** focused. Risk-adjusted to **~3 days** (see §Effort + Risks below).

---

# Phase A — Database migrations

All migration files go under `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\` with the `20260519010x00` timestamp prefix.

**Deploy method (Dashboard-only):** Open Supabase Dashboard → SQL Editor → New Query. Paste migration SQL. Click Run. After success, commit the file to the repo.

---

## Task A1: Migration — `stock_lot_status` enum

**Decisions ref:** Derived #2.

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010000_stock_lot_status_enum.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519010000_stock_lot_status_enum.sql
-- Phase 2 — stock_lot_status enum. Decisions-locked derived #2.
-- Idempotent: uses DO block to guard CREATE TYPE.

DO $phase2_enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stock_lot_status') THEN
    CREATE TYPE stock_lot_status AS ENUM (
      'active',    -- lot in use, current_qty > 0, expiry_date >= today
      'depleted',  -- current_qty = 0 (used up normally via movements)
      'expired',   -- expiry_date < today; set automatically by daily cron
      'recalled'   -- manually flagged by Admin; blocked from all issue movements
    );
  END IF;
END
$phase2_enum$;

COMMENT ON TYPE stock_lot_status IS
  'Phase 2. active=in use; depleted=used up; expired=past expiry_date (auto by cron at 09:00 BKK); recalled=manually quarantined by Admin.';
```

- [ ] **Step 2: Paste into Supabase SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'stock_lot_status'::regtype
ORDER BY enumsortorder;
-- Expected: 4 rows: active, depleted, expired, recalled
```

- [ ] **Step 4: Commit**

```bash
git add "supabase/migrations/20260519010000_stock_lot_status_enum.sql"
git commit -m "feat(db): stock_lot_status enum (Phase 2)"
```

**Rollback if this task fails:**
```sql
DROP TYPE IF EXISTS stock_lot_status;
```

---

## Task A2: Migration — `stock_lots` table

**Decisions ref:** Derived #1 (all columns), Q-Phase2-1 (UNIQUE per item), Q-Phase2-2 (recalled audit columns).

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010100_stock_lots.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519010100_stock_lots.sql
-- Phase 2 — stock_lots master table.
-- Decisions-locked: derived #1 (schema), Q-Phase2-1 (UNIQUE per item).
-- recalled_reason / recalled_by / recalled_at: explicit audit columns per
-- decisions derived #1. Note column does NOT conflict (kept for general use).

CREATE TABLE IF NOT EXISTS stock_lots (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid          NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  lot_number      text          NOT NULL,
  expiry_date     date          NOT NULL,
  received_at     timestamptz   NOT NULL DEFAULT now(),
  received_qty    int           NOT NULL CHECK (received_qty > 0),
  current_qty     int           NOT NULL DEFAULT 0 CHECK (current_qty >= 0),
  supplier        text,
  note            text,
  status          stock_lot_status NOT NULL DEFAULT 'active',
  recalled_reason text,
  recalled_by     text,
  recalled_at     timestamptz,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  created_by      text          NOT NULL DEFAULT app_username(),
  updated_by      text,

  -- Q-Phase2-1: lot_number unique per item, NOT globally.
  CONSTRAINT uq_lot_per_item UNIQUE (item_id, lot_number)
);

COMMENT ON TABLE stock_lots IS
  'Phase 2. One row per received medication batch. current_qty kept in sync by apply_movement_to_lot_qty trigger. status auto-set to expired by daily cron.';
COMMENT ON COLUMN stock_lots.lot_number   IS 'Manufacturer lot number. Unique within the same item (uq_lot_per_item). Vendors may reuse same string across different items.';
COMMENT ON COLUMN stock_lots.expiry_date  IS 'Date only. Auto-expired by cron when expiry_date < CURRENT_DATE.';
COMMENT ON COLUMN stock_lots.current_qty  IS 'Running balance: received_qty minus all issued/adjusted movements referencing this lot.';
COMMENT ON COLUMN stock_lots.status       IS 'active=in use; depleted=trigger sets when current_qty hits 0; expired=cron sets; recalled=Admin sets.';
COMMENT ON COLUMN stock_lots.recalled_reason IS 'Required when Admin sets status=recalled. Audit trail.';
COMMENT ON COLUMN stock_lots.recalled_by     IS 'app_username() of Admin who performed recall.';
COMMENT ON COLUMN stock_lots.recalled_at     IS 'Timestamp when recall action was executed.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sl_item    ON stock_lots(item_id);
CREATE INDEX IF NOT EXISTS idx_sl_expiry  ON stock_lots(expiry_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sl_status  ON stock_lots(status);

-- Auto-update updated_at (reuses Phase 0 set_updated_at() helper)
DROP TRIGGER IF EXISTS trg_stock_lots_updated_at ON stock_lots;
CREATE TRIGGER trg_stock_lots_updated_at
  BEFORE UPDATE ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- [ ] **Step 2: Paste into SQL Editor → Run**

- [ ] **Step 3: Verify schema + constraints**

```sql
-- 3a) Table columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'stock_lots'
ORDER BY ordinal_position;
-- Expected: 19 columns including recalled_reason, recalled_by, recalled_at.

-- 3b) Constraints
SELECT conname, contype FROM pg_constraint
WHERE conrelid = 'stock_lots'::regclass
ORDER BY conname;
-- Expected:
--   stock_lots_current_qty_check    c
--   stock_lots_item_id_fkey         f
--   stock_lots_pkey                 p
--   stock_lots_received_qty_check   c
--   uq_lot_per_item                 u

-- 3c) Indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'stock_lots' ORDER BY indexname;
-- Expected: idx_sl_expiry, idx_sl_item, idx_sl_status, stock_lots_pkey, uq_lot_per_item
```

- [ ] **Step 4: Commit**

```bash
git add "supabase/migrations/20260519010100_stock_lots.sql"
git commit -m "feat(db): stock_lots table + constraints + indexes (Phase 2)"
```

**Rollback if this task fails:**
```sql
DROP TABLE IF EXISTS stock_lots;
```

---

## Task A3: Migration — extend `stock_movements` (FK + `fefo_override` column)

**Decisions ref:** Derived #3 (FK DEFERRABLE), derived #11 (`fefo_override` column).

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010200_stock_movements_extend.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519010200_stock_movements_extend.sql
-- Phase 2 — Add real FK from stock_movements.lot_id → stock_lots(id).
-- Add fefo_override boolean column for FEFO-deviation audit.
-- Decisions-locked: derived #3 (FK DEFERRABLE INITIALLY DEFERRED),
--                   derived #11 (fefo_override).
-- Phase 1 rows all have lot_id IS NULL — FK addition is safe.

-- 1) Add fefo_override column (idempotent guard)
DO $phase2_ext$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='stock_movements' AND column_name='fefo_override'
  ) THEN
    ALTER TABLE stock_movements
      ADD COLUMN fefo_override boolean NOT NULL DEFAULT false;
  END IF;
END
$phase2_ext$;

COMMENT ON COLUMN stock_movements.fefo_override IS
  'Phase 2. TRUE when staff deliberately selected a non-FEFO lot and confirmed the modal. Reportable for compliance via SELECT count(*) WHERE fefo_override=true.';

-- 2) Add FK lot_id → stock_lots(id) DEFERRABLE INITIALLY DEFERRED
--    DEFERRABLE allows: INSERT stock_lots + INSERT stock_movements in same
--    transaction during receive flow without ordering constraint at INSERT time.
DO $phase2_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_movements_lot'
      AND conrelid = 'stock_movements'::regclass
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT fk_movements_lot
        FOREIGN KEY (lot_id) REFERENCES stock_lots(id)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$phase2_fk$;

COMMENT ON COLUMN stock_movements.lot_id IS
  'Phase 2: FK → stock_lots(id) DEFERRABLE INITIALLY DEFERRED. Required (enforced by BEFORE trigger check_lot_status) when item.tracks_lots=true AND movement_type IN (issue,adjustment_loss,borrow,transfer_out). Nullable for Phase 1 general items.';
```

- [ ] **Step 2: Paste into SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
-- 3a) FK constraint present
SELECT conname, condeferrable, condeferred
FROM pg_constraint
WHERE conrelid='stock_movements'::regclass AND conname='fk_movements_lot';
-- Expected: 1 row, condeferrable=true, condeferred=true

-- 3b) fefo_override column present
SELECT column_name, column_default, is_nullable
FROM information_schema.columns
WHERE table_name='stock_movements' AND column_name='fefo_override';
-- Expected: 1 row, column_default='false', is_nullable=NO

-- 3c) Phase 1 rows unaffected (all lot_id still NULL)
SELECT count(*) FROM stock_movements WHERE lot_id IS NOT NULL;
-- Expected: 0
```

- [ ] **Step 4: Commit**

```bash
git add "supabase/migrations/20260519010200_stock_movements_extend.sql"
git commit -m "feat(db): add fk_movements_lot FK + fefo_override column to stock_movements (Phase 2)"
```

**Rollback if this task fails:**
```sql
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS fk_movements_lot;
ALTER TABLE stock_movements DROP COLUMN IF EXISTS fefo_override;
```

---

## Task A4: Migration — RLS policies for `stock_lots`

**Decisions ref:** Derived #1 (read-all authenticated, write-Admin pattern), spec §8.

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010300_stock_lots_rls.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519010300_stock_lots_rls.sql
-- Phase 2 — RLS for stock_lots. Pattern: read-all authenticated, write Admin.
-- Mirrors Phase 1 pattern on stock_items (Admin write only).
-- No DELETE policy: lots are audit records; use status change instead.
-- Trigger functions that UPDATE stock_lots use SECURITY DEFINER and bypass RLS.

ALTER TABLE stock_lots ENABLE ROW LEVEL SECURITY;

-- SELECT: all authenticated users (staff need this for lot picker in scan flow)
DROP POLICY IF EXISTS sl_read ON stock_lots;
CREATE POLICY sl_read ON stock_lots
  FOR SELECT TO authenticated
  USING (true);

-- INSERT: Admin only (receive flow creates lots)
DROP POLICY IF EXISTS sl_insert ON stock_lots;
CREATE POLICY sl_insert ON stock_lots
  FOR INSERT TO authenticated
  WITH CHECK (app_user_role() = 'Admin');

-- UPDATE: Admin only (recall, corrections)
-- Note: apply_movement_to_lot_qty trigger is SECURITY DEFINER and bypasses RLS.
DROP POLICY IF EXISTS sl_update ON stock_lots;
CREATE POLICY sl_update ON stock_lots
  FOR UPDATE TO authenticated
  USING  (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- No DELETE policy → DELETE will be rejected for all roles (default deny).
```

- [ ] **Step 2: Paste into SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
-- 3a) RLS enabled
SELECT relrowsecurity FROM pg_class WHERE relname='stock_lots';
-- Expected: true (t)

-- 3b) Policies exist
SELECT policyname, cmd, roles FROM pg_policies
WHERE tablename='stock_lots'
ORDER BY policyname;
-- Expected: sl_insert (INSERT), sl_read (SELECT), sl_update (UPDATE)
```

- [ ] **Step 4: Commit**

```bash
git add "supabase/migrations/20260519010300_stock_lots_rls.sql"
git commit -m "feat(db): stock_lots RLS policies read-all + Admin-write (Phase 2)"
```

**Rollback if this task fails:**
```sql
DROP POLICY IF EXISTS sl_read   ON stock_lots;
DROP POLICY IF EXISTS sl_insert ON stock_lots;
DROP POLICY IF EXISTS sl_update ON stock_lots;
ALTER TABLE stock_lots DISABLE ROW LEVEL SECURITY;
```

---

## Task A5: Migration — triggers on `stock_movements` (check_lot_status + apply_movement_to_lot_qty)

**Decisions ref:** Q-Phase2-4 (BEFORE INSERT expired/recalled block with exact exception message), derived #5 (apply_movement_to_sil extended to update stock_lots.current_qty), derived #6 (check_lot_status trigger).

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010400_stock_lot_triggers.sql`

**Critical constraint:** The RAISE EXCEPTION message MUST be exactly `'ล็อตหมดอายุหรือถูกเรียกคืน'` so the frontend can grep the error message string and map it to the Thai toast `M-65`.

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519010400_stock_lot_triggers.sql
-- Phase 2 — Two new trigger functions on stock_movements:
--
-- 1) check_lot_status (BEFORE INSERT)
--    a) Enforces lot_id required for tracks_lots items on outgoing movements.
--    b) Blocks issue of expired or recalled lots — MUST raise EXACTLY:
--       'ล็อตหมดอายุหรือถูกเรียกคืน'
--       (Frontend staff-scan.js greps this string to map to toast M-65.)
--    Decisions: Q-Phase2-4 Option A, derived #4 (trigger over CHECK), derived #6.
--
-- 2) apply_movement_to_lot_qty (AFTER INSERT, SECURITY DEFINER)
--    On movement INSERT where lot_id IS NOT NULL:
--    - Updates stock_lots.current_qty += qty_delta.
--    - Guards against negative result.
--    - Auto-depletes lot when current_qty reaches 0.
--    Decisions: derived #5.
--
-- The existing apply_movement_to_sil and check_low_stock triggers (Phase 1)
-- are NOT modified. They still run on all movements. The new check_lot_status
-- fires BEFORE them (triggers fire in alphabetical order within same timing).

-- ---------------------------------------------------------------------------
-- 1) BEFORE INSERT — check_lot_status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_lot_status()
RETURNS trigger
LANGUAGE plpgsql
AS $check_lot_status$
DECLARE
  v_tracks_lots boolean;
  v_lot_status  stock_lot_status;
BEGIN
  -- Only acts when item.tracks_lots = true.
  SELECT tracks_lots
    INTO v_tracks_lots
  FROM stock_items
  WHERE id = NEW.item_id;

  -- Null guard: item not found → let FK constraint on item_id handle it.
  IF v_tracks_lots IS NULL OR v_tracks_lots = false THEN
    RETURN NEW;
  END IF;

  -- Outgoing movements on a tracks_lots item MUST supply a lot_id.
  -- (receive also required per spec §5.4, but receive is inbound — guarded separately.)
  IF NEW.movement_type IN ('issue', 'adjustment_loss', 'borrow', 'transfer_out')
     AND NEW.lot_id IS NULL
  THEN
    RAISE EXCEPTION
      'lot_id is required for medication item % (tracks_lots=true) on movement_type=%',
      NEW.item_id, NEW.movement_type;
  END IF;

  -- Also enforce for receive (inbound) movements.
  IF NEW.movement_type = 'receive' AND NEW.lot_id IS NULL THEN
    RAISE EXCEPTION
      'lot_id is required for medication item % (tracks_lots=true) on movement_type=receive',
      NEW.item_id;
  END IF;

  -- Q-Phase2-4: if lot_id is set, block expired or recalled lots on issue movements.
  -- MUST use exact message string 'ล็อตหมดอายุหรือถูกเรียกคืน' — FE greps for it.
  IF NEW.lot_id IS NOT NULL
     AND NEW.movement_type IN ('issue', 'adjustment_loss', 'borrow', 'transfer_out')
  THEN
    SELECT status
      INTO v_lot_status
    FROM stock_lots
    WHERE id = NEW.lot_id;

    IF v_lot_status IN ('expired', 'recalled') THEN
      RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน';
    END IF;
  END IF;

  RETURN NEW;
END;
$check_lot_status$;

COMMENT ON FUNCTION check_lot_status() IS
  'Phase 2 BEFORE INSERT. (a) Enforces lot_id required for tracks_lots items. (b) Raises EXCEPTION ''ล็อตหมดอายุหรือถูกเรียกคืน'' when issuing from expired/recalled lot (Q-Phase2-4). FE greps this exact string.';

DROP TRIGGER IF EXISTS trg_check_lot_status ON stock_movements;
CREATE TRIGGER trg_check_lot_status
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_lot_status();

-- ---------------------------------------------------------------------------
-- 2) AFTER INSERT — apply_movement_to_lot_qty (SECURITY DEFINER to bypass RLS)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_movement_to_lot_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $apply_lot_qty$
DECLARE
  v_new_lot_qty int;
BEGIN
  -- Only act when a lot is referenced.
  IF NEW.lot_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Apply qty_delta to stock_lots.current_qty.
  UPDATE stock_lots
    SET current_qty = current_qty + NEW.qty_delta,
        updated_by  = NEW.performed_by,
        updated_at  = now()
  WHERE id = NEW.lot_id
  RETURNING current_qty INTO v_new_lot_qty;

  -- Guard: negative qty not allowed.
  IF v_new_lot_qty < 0 THEN
    RAISE EXCEPTION
      'movement would drive lot current_qty negative for lot % (item %, movement %)',
      NEW.lot_id, NEW.item_id, NEW.id;
  END IF;

  -- Auto-deplete when lot reaches zero after an outgoing movement.
  IF v_new_lot_qty = 0
     AND NEW.qty_delta < 0
  THEN
    UPDATE stock_lots
      SET status     = 'depleted',
          updated_at = now()
    WHERE id = NEW.lot_id AND status = 'active';
  END IF;

  RETURN NEW;
END;
$apply_lot_qty$;

COMMENT ON FUNCTION apply_movement_to_lot_qty() IS
  'Phase 2 AFTER INSERT. Applies qty_delta to stock_lots.current_qty; auto-depletes status when current_qty reaches 0. SECURITY DEFINER to bypass stock_lots RLS.';

DROP TRIGGER IF EXISTS trg_lot_qty_apply ON stock_movements;
CREATE TRIGGER trg_lot_qty_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_lot_qty();
```

- [ ] **Step 2: Paste into SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
-- 3a) Both triggers on stock_movements
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'stock_movements'::regclass AND NOT tgisinternal
ORDER BY tgname;
-- Expected: trg_check_lot_status, trg_lot_qty_apply (plus Phase 1 trg_sm_apply, trg_sm_lowstock, trg_sm_sign)

-- 3b) Security settings
SELECT proname, prosecdef FROM pg_proc
WHERE proname IN ('check_lot_status','apply_movement_to_lot_qty')
ORDER BY proname;
-- Expected:
--   apply_movement_to_lot_qty  | true   (SECURITY DEFINER)
--   check_lot_status           | false  (no elevated privilege needed)

-- 3c) Smoke test — lot_id missing for a (hypothetical) tracks_lots item
-- (Run only if a test item with tracks_lots=true exists from T46)
-- INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
-- SELECT id, (SELECT id FROM locations LIMIT 1), 'issue', -1
-- FROM stock_items WHERE tracks_lots=true LIMIT 1;
-- Expected: ERROR: lot_id is required for medication item ... on movement_type=issue

-- 3d) Exact exception string check (critical for FE toast mapping)
-- If a test lot with status='expired' exists:
-- INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta, lot_id)
-- VALUES (<tracks_lots_item_id>, <location_id>, 'issue', -1, <expired_lot_id>);
-- Expected: ERROR: ล็อตหมดอายุหรือถูกเรียกคืน
```

- [ ] **Step 4: Commit**

```bash
git add "supabase/migrations/20260519010400_stock_lot_triggers.sql"
git commit -m "feat(db): check_lot_status + apply_movement_to_lot_qty triggers (Phase 2)"
```

**Rollback if this task fails:**
```sql
DROP TRIGGER IF EXISTS trg_check_lot_status ON stock_movements;
DROP TRIGGER IF EXISTS trg_lot_qty_apply    ON stock_movements;
DROP FUNCTION IF EXISTS check_lot_status();
DROP FUNCTION IF EXISTS apply_movement_to_lot_qty();
```

---

## Task A6: Migration — add `stock_lots` to Realtime publication

**Decisions ref:** Derived #1 (stock_lots is a live-updated resource, Admin lot list must reflect real-time recall actions and cron auto-expire).

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010500_stock_lots_realtime.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519010500_stock_lots_realtime.sql
-- Phase 2 — Add stock_lots to the Supabase Realtime publication.
-- Allows Admin lot list to update live when cron auto-expires a lot
-- or when another Admin session performs a recall.
-- Pattern mirrors Phase 1 (stock_items, stock_item_locations).

ALTER PUBLICATION supabase_realtime ADD TABLE stock_lots;
```

- [ ] **Step 2: Paste into SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND tablename = 'stock_lots';
-- Expected: 1 row
```

- [ ] **Step 4: In Supabase Dashboard → Realtime → Inspect**

Navigate to https://supabase.com/dashboard/project/xtjsjrfixngfdkaahton/database/replication and confirm `stock_lots` appears in the publication table list.

- [ ] **Step 5: Commit**

```bash
git add "supabase/migrations/20260519010500_stock_lots_realtime.sql"
git commit -m "feat(db): add stock_lots to supabase_realtime publication (Phase 2)"
```

**Rollback if this task fails:**
```sql
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS stock_lots;
```

---

## Task A7: Migration — MEDICATION category seed

**Decisions ref:** Derived #9.

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010600_medication_category.sql`

- [ ] **Step 1: Write migration file**

```sql
-- supabase/migrations/20260519010600_medication_category.sql
-- Phase 2 — Seed MEDICATION category. Decisions-locked derived #9.
-- Uses sort_order=50 (above Phase 1 seeds: GENERAL=10, SUPPLY=20, TOOL=30, CONSUME=40).
-- ON CONFLICT DO NOTHING is idempotent.

INSERT INTO stock_categories(code, name, sort_order)
VALUES ('MEDICATION', 'ยา', 50)
ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE stock_categories IS
  'Phase 1 category lookup. Phase 2 adds MEDICATION (sort_order=50).';
```

- [ ] **Step 2: Paste into SQL Editor → Run**

- [ ] **Step 3: Verify**

```sql
SELECT code, name, sort_order FROM stock_categories ORDER BY sort_order;
-- Expected: 5 rows including MEDICATION / ยา / 50
```

- [ ] **Step 4: Commit**

```bash
git add "supabase/migrations/20260519010600_medication_category.sql"
git commit -m "feat(db): seed MEDICATION category (Phase 2)"
```

**Rollback if this task fails:**
```sql
DELETE FROM stock_categories WHERE code = 'MEDICATION';
```

---

## Task A8: Migration — daily expiry cron job + EXPIRY_ALERT_DAYS setting seed

**Decisions ref:** Derived #7 (pg_cron at 09:00 Bangkok = 02:00 UTC), derived #8 (read from settings), Q-Phase2-3 (always-on auto-expire).

**File:** `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519010700_expiry_cron.sql`

**IMPORTANT — pg_cron availability check:** Before running this migration, complete PF-7. If `pg_cron` is NOT available (returns 0 rows), skip to the **Cloudflare Worker fallback path** section below.

- [ ] **Step 1: Seed `EXPIRY_ALERT_DAYS` setting**

```sql
-- Part of 20260519010700 — seed EXPIRY_ALERT_DAYS setting first (idempotent)
INSERT INTO settings(key, value)
VALUES ('EXPIRY_ALERT_DAYS', '30,60,90')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE settings IS
  'Phase 0+1+2 KV. Phase 2 added EXPIRY_ALERT_DAYS (default 30,60,90).';
```

- [ ] **Step 2: Write migration file (pg_cron path)**

```sql
-- supabase/migrations/20260519010700_expiry_cron.sql
-- Phase 2 — Daily expiry alert + auto-expire cron job.
-- Decisions-locked: derived #7 (09:00 Bangkok = 02:00 UTC),
--                   derived #8 (read NOTIFY_* from settings table, NOT current_setting()),
--                   Q-Phase2-3 (always-on auto-expire).
--
-- Phase 1 deploy deviation re-applied: MUST read NOTIFY_SUPABASE_URL and
-- NOTIFY_SERVICE_ROLE_KEY from `settings` table. Project.md §8 gotcha 9.
--
-- FALLBACK NOTE: If pg_cron is unavailable on this plan, see inline fallback
-- section at bottom of this file — use a Cloudflare Worker scheduled trigger
-- calling a new `expiry-alert-daily` Edge Function instead.

-- Enable pg_cron (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cron function: run_expiry_alert()
-- Two-pass:
--   Pass A: Auto-expire lots (expiry_date < today, status='active')
--   Pass B: Per-bucket alert for [today, today+threshold) via tg-notify
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION run_expiry_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $run_expiry_alert$
DECLARE
  v_url         text;
  v_srk         text;
  v_days_raw    text;
  v_thresholds  int[];
  v_threshold   int;
  v_bucket_lots jsonb;
  v_msg         text;
  v_dedupe      text;
  v_today       date := CURRENT_DATE;
BEGIN
  -- Step 1: Read settings table (MUST use settings — not current_setting).
  -- Project.md §8 gotcha 9: ALTER DATABASE for app.* is not permitted on Free/Nano.
  SELECT value INTO v_url FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

  -- Step 2: Auto-expire stale lots FIRST (before alert query so alert never
  -- counts an already-expired lot as active).
  -- Q-Phase2-3: always-on. No Admin confirmation required.
  UPDATE stock_lots
    SET status     = 'expired',
        updated_at = now()
  WHERE expiry_date < v_today
    AND status = 'active';

  -- Step 3: Skip pg_net calls if notify not configured (WARN and return).
  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING 'run_expiry_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in settings; auto-expire ran but alert skipped.';
    RETURN;
  END IF;

  -- Step 4: Parse EXPIRY_ALERT_DAYS (e.g. '30,60,90' → ARRAY[30,60,90]).
  SELECT value INTO v_days_raw FROM settings WHERE key = 'EXPIRY_ALERT_DAYS';
  IF v_days_raw IS NULL OR v_days_raw = '' THEN
    v_days_raw := '30,60,90';
  END IF;

  SELECT ARRAY(
    SELECT trim(t)::int
    FROM unnest(string_to_array(v_days_raw, ',')) AS t
    WHERE trim(t) ~ '^[0-9]+$'
  ) INTO v_thresholds;

  -- Step 5: Per-bucket alert.
  FOREACH v_threshold IN ARRAY v_thresholds LOOP
    SELECT jsonb_agg(
      jsonb_build_object(
        'lot_id',      sl.id,
        'lot_number',  sl.lot_number,
        'item_name',   si.name,
        'sku',         si.sku,
        'expiry_date', sl.expiry_date,
        'current_qty', sl.current_qty,
        'unit',        si.unit,
        'days_left',   (sl.expiry_date - v_today)
      )
      ORDER BY sl.expiry_date ASC
    )
    INTO v_bucket_lots
    FROM stock_lots sl
    JOIN stock_items si ON si.id = sl.item_id
    WHERE sl.status = 'active'
      AND sl.expiry_date >= v_today
      AND sl.expiry_date <= (v_today + v_threshold)
      AND sl.current_qty > 0;

    -- Skip bucket if no qualifying lots.
    IF v_bucket_lots IS NULL OR jsonb_array_length(v_bucket_lots) = 0 THEN
      CONTINUE;
    END IF;

    v_msg := format(
      '⏳ แจ้งเตือนวันหมดอายุ (ภายใน %s วัน) — มี %s รายการ',
      v_threshold,
      jsonb_array_length(v_bucket_lots)
    );

    -- dedupe_key: per-bucket per-day (same pattern as Phase 1 low_stock:<sku>:<date>)
    v_dedupe := 'expiry:' || v_threshold || ':' ||
                to_char(v_today AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

    PERFORM net.http_post(
      url     := v_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'content-type',  'application/json',
        'apikey',        v_srk,
        'authorization', 'Bearer ' || v_srk,
        'X-Internal',    'true'
      ),
      body    := jsonb_build_object(
        'event_type',  'expiry',
        'entity_type', 'stock_lot',
        'entity_id',   null,
        'dedupe_key',  v_dedupe,
        'message',     v_msg,
        'payload',     jsonb_build_object(
          'bucket_days', v_threshold,
          'run_date',    v_today,
          'lots',        v_bucket_lots
        )
      )
    );
  END LOOP;
END;
$run_expiry_alert$;

COMMENT ON FUNCTION run_expiry_alert() IS
  'Phase 2 daily cron. Pass A: auto-expires lots with expiry_date < today. Pass B: posts one tg-notify alert per EXPIRY_ALERT_DAYS bucket. Reads NOTIFY_SUPABASE_URL/NOTIFY_SERVICE_ROLE_KEY from settings table (Project.md §8 gotcha 9).';

-- Schedule: 02:00 UTC = 09:00 Asia/Bangkok (UTC+7).
-- Unschedule any existing job with same name first (idempotent).
SELECT cron.unschedule('expiry_alert_daily') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'expiry_alert_daily'
);

SELECT cron.schedule(
  'expiry_alert_daily',
  '0 2 * * *',
  $cron_body$SELECT run_expiry_alert()$cron_body$
);
```

- [ ] **Step 3: Paste into SQL Editor → Run (pg_cron path)**

Note: Run the settings seed SQL first, then the extension + function + schedule SQL.

- [ ] **Step 4: Verify (pg_cron path)**

```sql
-- 4a) pg_cron extension present
SELECT extname FROM pg_extension WHERE extname='pg_cron';
-- Expected: 1 row

-- 4b) Cron job scheduled
SELECT jobname, schedule, command
FROM cron.job
WHERE jobname='expiry_alert_daily';
-- Expected: 1 row, schedule='0 2 * * *'

-- 4c) EXPIRY_ALERT_DAYS setting seeded
SELECT key, value FROM settings WHERE key='EXPIRY_ALERT_DAYS';
-- Expected: 1 row, value='30,60,90'

-- 4d) Smoke run (manual trigger to verify function body runs without error)
SELECT run_expiry_alert();
-- Expected: no exception. If NOTIFY settings are set, notification_log rows appear.
-- If NOTIFY settings are blank, WARNING in logs but no error.

-- 4e) After smoke run, check notification_log (if NOTIFY settings were populated)
SELECT dedupe_key, event_type, success, created_at
FROM notification_log
WHERE event_type='expiry'
ORDER BY created_at DESC
LIMIT 5;
```

- [ ] **Step 5: Commit**

```bash
git add "supabase/migrations/20260519010700_expiry_cron.sql"
git commit -m "feat(db): run_expiry_alert cron + EXPIRY_ALERT_DAYS seed (Phase 2)"
```

**Rollback if this task fails:**
```sql
SELECT cron.unschedule('expiry_alert_daily');
DROP FUNCTION IF EXISTS run_expiry_alert();
DELETE FROM settings WHERE key='EXPIRY_ALERT_DAYS';
```

---

### Task A8 — Cloudflare Worker fallback path (use ONLY if pg_cron is unavailable)

**When to use:** PF-7 returned 0 rows (pg_cron not available on plan). All other Phase 2 DB migrations (A1–A7) still deploy normally. Only the cron scheduling step is replaced.

**Fallback design:** Create a new Supabase Edge Function `expiry-alert-daily` that wraps the same logic as `run_expiry_alert()` and is triggered by a Cloudflare Worker cron trigger at 09:00 Bangkok.

**Step CF-1: Create Edge Function `expiry-alert-daily`**

In Supabase Dashboard → Edge Functions → New Function, name `expiry-alert-daily`, paste:

```typescript
// supabase/functions/expiry-alert-daily/index.ts
// Phase 2 fallback — called by Cloudflare Worker scheduled trigger when
// pg_cron is unavailable. Invokes run_expiry_alert() via RPC.
// Auth: service_role key (X-Internal: true pattern from Phase 1).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Only accept internal calls (service_role key in Authorization header).
  const authHeader = req.headers.get('Authorization') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const isInternal = req.headers.get('X-Internal') === 'true';

  if (!isInternal || !authHeader.includes(serviceRoleKey)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const client = createClient(supabaseUrl, serviceRoleKey);

  const { data, error } = await client.rpc('run_expiry_alert');

  if (error) {
    console.error('run_expiry_alert RPC error:', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

Note: `run_expiry_alert()` DB function (created in A8 without the `cron.schedule` call) still handles the actual auto-expire + alert logic. The Edge Function is only the HTTP trigger wrapper.

**Step CF-2: Deploy Edge Function and turn OFF "Verify JWT with legacy secret"**

In Function Settings → uncheck "Verify JWT with legacy secret" (same as Phase 0 pattern).

**Step CF-3: Add Cloudflare Worker cron trigger**

In the existing Cloudflare Worker `thegood-ocr-proxy`, add a cron trigger for `0 2 * * *` (02:00 UTC = 09:00 Bangkok) that calls:

```
POST https://xtjsjrfixngfdkaahton.supabase.co/functions/v1/expiry-alert-daily
Headers:
  Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
  apikey: <SUPABASE_SERVICE_ROLE_KEY>
  X-Internal: true
  Content-Type: application/json
Body: {}
```

Store `SUPABASE_SERVICE_ROLE_KEY` as a Cloudflare Worker secret (not in code).

**Step CF-4: Verify fallback**

```bash
curl -X POST "https://xtjsjrfixngfdkaahton.supabase.co/functions/v1/expiry-alert-daily" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "apikey: <SERVICE_ROLE_KEY>" \
  -H "X-Internal: true" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: {"ok":true,"data":null}
```

**Decision for PM:** The pg_cron path is preferred (same DB, no extra network hop, no new Edge Function). The fallback adds operational complexity (Cloudflare Worker cron + Edge Function). PM should check PF-7 before implementation and confirm which path to use. If in doubt, default to pg_cron path.

---

# Phase B — Frontend

All frontend files are in `F:\@Coding\ระบบ\The Good Stock\`.

---

## Task B1: New shared module `shared/lots.js`

**Spec ref:** §4, §7.2. **UX ref:** §4.3 (lot picker widget, fetchAvailableLots).
**Decisions ref:** Q-D4 (5 lots default + expand link), Q-D2 (FEFO override warning toast copy).

**File:** `F:\@Coding\ระบบ\The Good Stock\shared\lots.js`

- [ ] **Step 1: Write file**

```javascript
// shared/lots.js
// Phase 2 — Medication lot REST helpers + FEFO sort + lot picker renderer.
// Used by: js/inventory.js (receive form), js/inventory-lots.js (lot list),
//          js/staff-scan.js (lot picker step).

import { supabase } from './supabase-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all active lots for an item, ordered FEFO (soonest expiry first).
 * Uses v_lots_with_remaining view: status='active', current_qty > 0.
 * @param {string} itemId - UUID of the stock_item
 * @returns {Promise<{data: Array, error: object|null}>}
 */
export async function fetchAvailableLots(itemId) {
  return supabase
    .from('v_lots_with_remaining')
    .select('id, lot_number, expiry_date, current_qty, unit, supplier, days_until_expiry')
    .eq('item_id', itemId)
    .order('expiry_date', { ascending: true });
}

/**
 * Fetch all lots for an item (all statuses, for admin lot list).
 * @param {string} itemId - UUID
 * @returns {Promise<{data: Array, error: object|null}>}
 */
export async function fetchAllLots(itemId) {
  return supabase
    .from('stock_lots')
    .select('id, lot_number, expiry_date, received_qty, current_qty, supplier, note, status, recalled_reason, recalled_by, recalled_at, created_at, created_by')
    .eq('item_id', itemId)
    .order('expiry_date', { ascending: true });
}

/**
 * Create a new lot (Admin receive flow).
 * @param {object} lot - { item_id, lot_number, expiry_date, received_qty, supplier, note }
 * @returns {Promise<{data: object, error: object|null}>}
 */
export async function createLot(lot) {
  return supabase
    .from('stock_lots')
    .insert({
      item_id:      lot.item_id,
      lot_number:   lot.lot_number,
      expiry_date:  lot.expiry_date,
      received_qty: lot.received_qty,
      current_qty:  lot.received_qty,  // initial current_qty = received_qty
      supplier:     lot.supplier || null,
      note:         lot.note     || null,
    })
    .select('id, lot_number, expiry_date')
    .single();
}

/**
 * Mark a lot as recalled (Admin action).
 * @param {string} lotId - UUID
 * @param {string} reason - Required recall reason text
 * @param {string} recalledBy - Current admin username
 * @returns {Promise<{data: object, error: object|null}>}
 */
export async function recallLot(lotId, reason, recalledBy) {
  return supabase
    .from('stock_lots')
    .update({
      status:         'recalled',
      recalled_reason: reason,
      recalled_by:     recalledBy,
      recalled_at:     new Date().toISOString(),
    })
    .eq('id', lotId)
    .select('id, status, recalled_at')
    .single();
}

// ─────────────────────────────────────────────────────────────────────────────
// FEFO sort helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sort lots by expiry_date ASC (FEFO: First Expiry First Out).
 * Lots without expiry_date (null) sort last.
 * @param {Array} lots
 * @returns {Array}
 */
export function sortFEFO(lots) {
  return [...lots].sort((a, b) => {
    if (!a.expiry_date) return 1;
    if (!b.expiry_date) return -1;
    return new Date(a.expiry_date) - new Date(b.expiry_date);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute expiry badge metadata from a lot's expiry_date and status.
 * Returns { badgeClass, label, daysLeft }.
 * Decisions Q-D3: expired badge uses bg-stock-accent-subtle per decisions-locked.
 * UX §3.1.3: color tokens.
 * @param {object} lot - { status, expiry_date, days_until_expiry }
 * @returns {{ badgeClass: string, label: string, daysLeft: number|null }}
 */
export function getLotBadge(lot) {
  const days = lot.days_until_expiry !== undefined
    ? lot.days_until_expiry
    : (lot.expiry_date ? Math.floor((new Date(lot.expiry_date) - new Date()) / 86400000) : null);

  if (lot.status === 'recalled')  return { badgeClass: 'bg-purple-subtle text-purple',           label: 'ถูกเรียกคืน',   daysLeft: days };
  if (lot.status === 'depleted')  return { badgeClass: 'bg-secondary text-white',                label: 'ใช้หมดแล้ว',    daysLeft: days };
  if (lot.status === 'expired' || (days !== null && days <= 0))
                                   return { badgeClass: 'bg-danger text-white',                   label: 'หมดอายุแล้ว',   daysLeft: days };
  if (days !== null && days <= 30) return { badgeClass: 'bg-warning text-dark',                   label: 'ใกล้หมดอายุ',   daysLeft: days };
  if (days !== null && days <= 60) return { badgeClass: 'bg-warning text-dark opacity-75',        label: 'เฝ้าระวัง',      daysLeft: days };
  if (days !== null && days <= 90) return { badgeClass: 'bg-stock-accent-subtle text-stock-accent-dark', label: 'ใกล้ครบ 90 วัน', daysLeft: days };
  return { badgeClass: 'bg-success text-white', label: 'ปกติ', daysLeft: days };
}

/**
 * Format expiry date as Thai dd/mm/yyyy (Buddhist Era).
 * @param {string} dateStr - ISO date string e.g. '2027-05-01'
 * @returns {string} e.g. '01/05/2570'
 */
export function formatThaiDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear() + 543;
  return `${dd}/${mm}/${yyyy}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lot picker widget (staff scan step 2.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a lot picker for staff scan step 2.5.
 * Q-D4: show 5 lots by default; accordion link for "ดูทั้งหมด ({n} ล็อต)".
 * Q-D2: highlight FEFO lot (first in sorted list).
 *
 * @param {Array}    lots          - Sorted FEFO array of lot objects
 * @param {string}   selectedLotId - Pre-selected lot id (default: lots[0].id)
 * @param {Function} onSelect      - Callback(lot) when a lot is selected
 * @returns {HTMLElement}          - Container div ready to insert into DOM
 */
export function renderLotPicker(lots, selectedLotId, onSelect) {
  const DEFAULT_SHOW = 5;
  const container = document.createElement('div');
  container.className = 'lot-picker';

  if (lots.length === 0) {
    container.innerHTML = `
      <div class="text-center py-3">
        <p class="fw-semibold mb-1">ไม่มีล็อตยาที่พร้อมใช้งาน</p>
        <p class="text-muted small">ติดต่อผู้ดูแลระบบเพื่อรับเข้าล็อตใหม่</p>
      </div>`;
    return container;
  }

  const currentId = selectedLotId || lots[0].id;

  function buildCard(lot, isFefoDefault) {
    const badge = getLotBadge(lot);
    const card = document.createElement('div');
    card.className = `card mb-2 lot-picker-card ${lot.id === currentId ? 'border-primary' : ''}`;
    card.dataset.lotId = lot.id;
    card.innerHTML = `
      <div class="card-body py-2 px-3">
        <div class="d-flex justify-content-between align-items-start">
          <div>
            ${isFefoDefault ? '<span class="badge bg-primary-subtle text-primary me-1 small">FEFO default: เลือกอัตโนมัติ</span>' : ''}
            <span class="fw-semibold">${escapeHtml(lot.lot_number)}</span>
          </div>
          <span class="badge ${badge.badgeClass} ms-2 flex-shrink-0">${badge.label}</span>
        </div>
        <div class="text-muted small mt-1">
          หมดอายุ ${formatThaiDate(lot.expiry_date)}
          &nbsp;·&nbsp; คงเหลือ ${lot.current_qty} ${escapeHtml(lot.unit || 'ชิ้น')}
        </div>
      </div>`;
    card.addEventListener('click', () => onSelect(lot));
    return card;
  }

  const visibleLots = lots.slice(0, DEFAULT_SHOW);
  const hiddenLots  = lots.slice(DEFAULT_SHOW);

  visibleLots.forEach((lot, i) => container.appendChild(buildCard(lot, i === 0)));

  if (hiddenLots.length > 0) {
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'btn btn-link btn-sm text-muted px-0 mt-1';
    expandBtn.textContent = `ล็อตอื่น ▾  (${hiddenLots.length + DEFAULT_SHOW} ล็อตทั้งหมด)`;
    expandBtn.addEventListener('click', () => {
      hiddenLots.forEach(lot => container.insertBefore(buildCard(lot, false), expandBtn));
      expandBtn.remove();
    });
    container.appendChild(expandBtn);
  }

  return container;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility — reuse escapeHtml from shared/ui.js if available, else inline
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (typeof window !== 'undefined' && window.escapeHtml) return window.escapeHtml(str);
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 2: Verify file exists and has no syntax errors**

Open in browser DevTools console or run:
```javascript
// In browser DevTools on admin.html after adding to STATIC_ASSETS (Task B6):
const m = await import('./shared/lots.js');
console.log(typeof m.fetchAvailableLots, typeof m.renderLotPicker, typeof m.getLotBadge);
// Expected: function function function
```

- [ ] **Step 3: Commit**

```bash
git add "shared/lots.js"
git commit -m "feat(fe): shared/lots.js — lot REST helpers + FEFO sort + lot picker widget (Phase 2)"
```

---

## Task B2: Extend `js/inventory.js` — 4th sub-view "ล็อตยา" + `tracks_lots` toggle + lot fields in receive

**Spec ref:** §7.1, §7.1.3. **UX ref:** §3.1, §3.2, §3.3, §5.1. **Decisions ref:** Q-D5 (overflow-x auto + edge-fade), Q-D1 (no force-issue override).

**File:** `F:\@Coding\ระบบ\The Good Stock\js\inventory.js` (EDIT — Phase 1 file)

This is the largest frontend task. The implementer adds:
1. A 4th segment "ล็อตยา" to the segmented control, with `overflow-x: auto` and edge-fade (see B5 for CSS).
2. Lazy-load of `js/inventory-lots.js` when the ล็อตยา segment is clicked.
3. A `tracks_lots` boolean toggle in the item Add/Edit modal.
4. Conditional lot fields section in the Receive sub-view when selected item has `tracks_lots=true`.

Key implementation points (no magic):

- **Segment control:** Add a 4th `<li>` / `<button>` element with `data-subview="lots"` after the existing 3 segments. Wrap the segment container in a `div.inventory-tabs-scroll` with `overflow-x:auto` (Task B5 CSS).
- **ล็อตยา tab init:** In the tab-click handler, when `data-subview === 'lots'`, dynamically import `./inventory-lots.js` and call `initLotsView(container)`.
- **Item modal — tracks_lots toggle:** In `renderItemModal()`, add a form-switch row:
  ```html
  <div class="form-check form-switch mb-3">
    <input class="form-check-input" type="checkbox" id="itemTracksLots" name="tracks_lots">
    <label class="form-check-label" for="itemTracksLots">
      ติดตามล็อต / วันหมดอายุ
      <small class="d-block text-muted">ใช้สำหรับยาและเวชภัณฑ์ที่ต้องระบุล็อต</small>
    </label>
  </div>
  ```
  On enable when item already has stock: show toast warning M-53 (non-blocking).
  On disable when active lots exist: show inline error M-54 (blocking — prevent save).
- **Receive form — lot fields:** After item selection, check `item.tracks_lots`. If true, render a collapsible section using Bootstrap collapse:
  ```html
  <div id="lotDetailsSection" class="border rounded p-3 mb-3 bg-light">
    <p class="mb-2 fw-semibold">★ ยาชนิดนี้ต้องระบุข้อมูลล็อต</p>
    <!-- Tab toggle: ล็อตใหม่ / เพิ่มให้ล็อตเดิม -->
    <ul class="nav nav-tabs mb-3" id="lotTabToggle">
      <li class="nav-item"><button class="nav-link active" data-lot-tab="new">ล็อตใหม่</button></li>
      <li class="nav-item"><button class="nav-link" data-lot-tab="existing">เพิ่มให้ล็อตเดิม</button></li>
    </ul>
    <div id="lotTabNew">
      <input type="text" id="lotNumber" class="form-control mb-2" placeholder="หมายเลขล็อต *" required>
      <input type="date" id="lotExpiry" class="form-control mb-2" required>
      <input type="text" id="lotSupplier" class="form-control mb-2" placeholder="ผู้จัดจำหน่าย / Supplier (ไม่บังคับ)">
      <input type="text" id="lotNote" class="form-control" placeholder="หมายเหตุ (ไม่บังคับ)">
    </div>
    <div id="lotTabExisting" class="d-none">
      <select id="existingLotSelect" class="form-select mb-2">
        <option value="">ยังไม่มีล็อต — สร้างล็อตใหม่</option>
      </select>
    </div>
  </div>
  ```
- **Receive submit with lot:** When `tracks_lots=true`:
  1. Validate lot fields (lot_number required; expiry_date required + >= today).
  2. On "ล็อตใหม่" tab: `createLot()` from `shared/lots.js` → get `lotId`.
  3. On "เพิ่มให้ล็อตเดิม" tab: use existing `lotId` from dropdown.
  4. Then INSERT `stock_movements` with `lot_id = lotId`.
  5. On 409 from createLot (duplicate `uq_lot_per_item`): show inline error M-47.
  6. On success: show toast M-48.
- **Recall button on lot list** is handled by `inventory-lots.js` (Task is separated for clarity; this task only wires the 4th segment).

- [ ] **Step 1: Implement the above 4 additions in `js/inventory.js`**

- [ ] **Step 2: Verify — 4th segment renders**

Open `admin.html` in Chrome DevTools. Click Inventory tab → confirm 4 segments are visible. At 360px viewport: confirm `overflow-x: auto` allows horizontal scroll and edge-fade is visible (right edge fades). No label shortening.

- [ ] **Step 3: Verify — tracks_lots toggle in item modal**

Create a test item via the "+ เพิ่มสินค้า" button. Confirm `ติดตามล็อต / วันหมดอายุ` toggle is present. Toggle on. Save. Verify in SQL Editor:
```sql
SELECT tracks_lots FROM stock_items WHERE sku = '<test-sku>';
-- Expected: true
```

- [ ] **Step 4: Verify — lot fields in Receive form**

In Receive sub-view, select the test item with `tracks_lots=true`. Confirm lot section appears. Select a non-tracks_lots item. Confirm lot section is absent.

- [ ] **Step 5: Commit**

```bash
git add "js/inventory.js"
git commit -m "feat(fe): inventory.js — 4th segment ล็อตยา + tracks_lots toggle + lot receive fields (Phase 2)"
```

---

## Task B3: New file `js/inventory-lots.js` — lot list, recall action

**Spec ref:** §7.1.1, §7.1.2. **UX ref:** §3.1.1–§3.1.7, §4.3, §5.1, §5.3.
**Decisions ref:** Q-D1 (NO force-issue override), Q-D3 (badge colors per UX §3.1.3).

**File:** `F:\@Coding\ระบบ\The Good Stock\js\inventory-lots.js` (NEW)

Key implementation points:
- `initLotsView(container)` — entry point called from `inventory.js`. Renders filter bar + lot list table. Subscribes to Realtime channel `stock_lots` for live updates.
- **Filter bar:** Three controls: expiry-window dropdown (values: `all/overdue/30/60/90`), status dropdown, free-text item search (live-filters on `input` event).
- **Lot list source:** `SELECT stock_lots JOIN stock_items WHERE tracks_lots=true ORDER BY expiry_date ASC`. Use Supabase JS client `.from('stock_lots').select('*, stock_items!inner(sku, name, unit, tracks_lots)').eq('stock_items.tracks_lots', true)`.
- **Expiry badges:** Use `getLotBadge(lot)` from `shared/lots.js`.
- **Recall button:** Visible only for `status IN ('active', 'expired')`. Hidden for `depleted`, `recalled`.
- **Recall confirm modal:** Custom modal (NOT `showConfirm()` — recall needs a reason text field). Inline validation: reason required (M-85). On confirm: call `recallLot(lotId, reason, username)` from `shared/lots.js`. On success: update row badge + hide recall button + show toast M-88.
- **Lot detail expand:** Tap `[ดูรายละเอียด]` → inline accordion card with supplier, received_at, received_qty, created_by, note. NO force-issue button (Q-D1 removed from scope).
- **Empty states:** M-23/M-24/M-25 (no lots), M-26/M-27 (filtered empty).
- **Error state:** M-21/M-22 (load failure + retry button).
- **Realtime:** Subscribe `stock_lots:*` → re-render affected row on UPDATE event (status change from cron auto-expire or another Admin recall).

- [ ] **Step 1: Implement `js/inventory-lots.js`**

- [ ] **Step 2: Verify — lot list renders**

After T48 (lot created in acceptance tests), open Inventory → ล็อตยา. Confirm lot row displays with correct badge, correct qty, recall button visible.

- [ ] **Step 3: Verify — recall flow**

Click "เรียกคืน" on an active lot. Confirm modal opens. Enter reason "Unit test recall". Click "ยืนยัน เรียกคืน". Confirm:
1. Toast M-88 appears.
2. Row badge changes to purple "ถูกเรียกคืน".
3. Recall button disappears on that row.
4. SQL check:
```sql
SELECT status, recalled_reason, recalled_by, recalled_at
FROM stock_lots WHERE lot_number = '<test-lot-number>';
-- Expected: recalled, reason text populated, recalled_by = current admin, recalled_at populated
```

- [ ] **Step 4: Verify — empty state**

Filter to a window/status with no matching lots. Confirm M-26 + M-27 (ล้างตัวกรอง button) appears.

- [ ] **Step 5: Commit**

```bash
git add "js/inventory-lots.js"
git commit -m "feat(fe): inventory-lots.js — lot list + filter bar + recall modal + Realtime (Phase 2)"
```

---

## Task B4: Extend `js/staff-scan.js` — lot-picker step (step 2.5)

**Spec ref:** §7.2. **UX ref:** §3.4, §5.2.
**Decisions ref:** Q-D2 (FEFO override warning modal), Q-D4 (5 lots default + accordion), Q-Phase2-4 (handle `ล็อตหมดอายุหรือถูกเรียกคืน` DB trigger error → return to LOT-PICK).

**File:** `F:\@Coding\ระบบ\The Good Stock\js\staff-scan.js` (EDIT — Phase 1 file)

Key implementation points:
- **New states in the scan state machine:** `LOT-LOADING`, `LOT-EMPTY`, `LOT-PICK` — inserted between `LOC` and `QTY` states.
- **State `LOT-LOADING`:** Triggered after successful location scan when `scannedItem.tracks_lots === true` AND `movementType` is one of `issue`, `adjustment_loss`. Display spinner + text M-60. Call `fetchAvailableLots(itemId)`. On error: show M-61 + [ลองอีกครั้ง] M-62. On success: transition.
- **State `LOT-EMPTY`:** If 0 lots returned. Show M-63 + M-64. Show only [เริ่มใหม่] button (abort issue, no path forward).
- **State `LOT-PICK`:** Call `renderLotPicker(lots, lots[0].id, handleLotSelect)` from `shared/lots.js`. Display step heading M-55. Show [ขั้นต่อไป: ระบุจำนวน →] M-58 button.
- **FEFO override warning (Q-D2):** When staff selects a lot that is NOT the FEFO default (not `lots[0]`), store `selectedLot` but show a confirm modal:
  ```
  "ล็อต {lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"
  [ยืนยัน] → proceed with selectedLot, set fefo_override=true in movement payload
  [ยกเลิก] → return to LOT-PICK, revert to FEFO default
  ```
  On confirm: set `fefoOverride = true`.
- **State `QTY`:** Third chip shows M-59 (lot_number + expiry badge). The `lot_id` and `fefo_override` are included in the movement INSERT payload.
- **State `SUBMITTING` error handling:** If the server returns a 400/500 with error message containing `'ล็อตหมดอายุหรือถูกเรียกคืน'` (exact string from DB trigger), show toast M-65 and navigate to `LOT-PICK` (re-fetch lots so user gets fresh data).
- **Non-tracks_lots items:** Skip all lot states; transition directly `LOC → QTY` as in Phase 1.

- [ ] **Step 1: Implement lot picker step in `js/staff-scan.js`**

- [ ] **Step 2: Verify — lot picker appears for tracks_lots item**

Scan a medication item (tracks_lots=true) → scan a location. Confirm LOT-LOADING spinner → LOT-PICK with FEFO lot pre-selected. Submit. Confirm `stock_movements` row has correct `lot_id` and `fefo_override=false`.

- [ ] **Step 3: Verify — FEFO override warning**

In LOT-PICK, tap a different lot from the list (not first). Confirm Q-D2 warning modal appears with exact copy `"ล็อต {lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"`. Tap [ยืนยัน]. Confirm `fefo_override=true` in the resulting `stock_movements` row:
```sql
SELECT fefo_override, lot_id FROM stock_movements
ORDER BY performed_at DESC LIMIT 1;
-- Expected: fefo_override=true, lot_id = the non-FEFO lot's id
```

- [ ] **Step 4: Verify — expired lot DB error triggers navigation back to LOT-PICK**

Set a test lot `status='expired'` manually in SQL Editor. Attempt to issue it via the scan flow. Confirm the error toast M-65 appears and the UI returns to LOT-PICK (not stuck in SUBMITTING state).

- [ ] **Step 5: Commit**

```bash
git add "js/staff-scan.js"
git commit -m "feat(fe): staff-scan.js — lot picker step 2.5 + FEFO override warning + expired-lot error handling (Phase 2)"
```

---

## Task B5: CSS — `.lot-expiry-badge` tokens + edge-fade hint

**UX ref:** §8, §3.1.3, Q-D3, Q-D5.

**File:** `F:\@Coding\ระบบ\The Good Stock\shared\styles.css` (EDIT)

- [ ] **Step 1: Add Phase 2 CSS additions to `shared/styles.css`**

Append the following block at the end of `shared/styles.css`:

```css
/* ============================================================
   Phase 2 — Medication Lot Expiry Badges + Lot Picker
   Q-D3: expired badge uses bg-stock-accent-subtle (teal-neutral)
         to distinguish from green "normal" badge.
   Q-D5: 4-segment tab edge-fade hint at 360px.
   ============================================================ */

/* Recalled lot badge — purple (Bootstrap 5 utility via custom token) */
.bg-purple-subtle  { background-color: #e9d5f5 !important; }
.text-purple       { color: #6f42c1 !important; }

/* Lot expiry badge base */
.lot-expiry-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  white-space: nowrap;
}

/* Lot picker card — selected state */
.lot-picker-card {
  cursor: pointer;
  transition: border-color 0.15s;
}
.lot-picker-card.border-primary {
  border-color: var(--bs-primary) !important;
  box-shadow: 0 0 0 0.15rem rgba(13, 110, 253, 0.15);
}
.lot-picker-card:hover {
  border-color: #0d9488;
}

/* 4-segment Inventory tab — scrollable with right edge-fade (Q-D5) */
.inventory-tabs-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;         /* Firefox: hide scrollbar */
  position: relative;
}
.inventory-tabs-scroll::-webkit-scrollbar {
  display: none;                 /* Chrome/Safari: hide scrollbar */
}

/* Edge-fade hint: pseudo-element on the wrapper's right edge */
.inventory-tabs-scroll::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 2.5rem;
  height: 100%;
  background: linear-gradient(to left, rgba(255,255,255,0.95), transparent);
  pointer-events: none;
}

/* Lot list table — scrollable on mobile */
.lot-list-table-wrapper {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```

- [ ] **Step 2: Verify CSS loads**

Open `admin.html`. Open Chrome DevTools → Network → filter `styles.css`. Confirm 200 response and no parse errors in Console. Visually confirm the 4-segment Inventory tab shows an edge-fade at the right edge on a 360px viewport.

- [ ] **Step 3: Commit**

```bash
git add "shared/styles.css"
git commit -m "feat(fe): styles.css — lot expiry badge tokens + 4-tab edge-fade (Phase 2)"
```

---

## Task B4b: Extend `js/dashboard.js` — expiry timeline panel

**Spec ref:** §7 (dashboard panel). **UX ref:** §3.5, §6.7 (microcopy M-67 through M-79).
**Decisions ref:** The Phase 1 plan noted a placeholder "ภาพรวมสินค้าหมดอายุ — เปิดใช้งานใน Phase 2". Phase 2 replaces it.

**File:** `F:\@Coding\ระบบ\The Good Stock\js\dashboard.js` (EDIT — Phase 1 file)

Key implementation points:
- Find the existing placeholder card in `dashboard.js` that contains text "เปิดใช้งานใน Phase 2" and replace its content with a full 4-row expiry timeline panel.
- **Data source:** Query `stock_lots` directly (no view needed — aggregate in JS):
  ```javascript
  const { data: lots } = await supabase
    .from('stock_lots')
    .select('id, expiry_date, status, current_qty')
    .neq('status', 'depleted');
  ```
  Then bucket client-side:
  - `overdue`: `days < 0` (status may still be active between midnight and 09:00 cron run) OR `status='expired'`
  - `within30`: `days >= 0 && days <= 30 && status='active'`
  - `within60`: `days > 30 && days <= 60 && status='active'`
  - `within90`: `days > 60 && days <= 90 && status='active'`
  - `normal`: `days > 90 && status='active'`
- **Panel HTML skeleton:**
  ```html
  <div class="card mb-3" id="expiryTimelinePanel">
    <div class="card-header d-flex justify-content-between align-items-center">
      <span>ภาพรวมวันหมดอายุ</span>
      <small class="text-muted">อัปเดต: {HH:MM}</small>
    </div>
    <div class="card-body p-0">
      <!-- 4 rows: each row is a clickable <a> that navigates to Inventory > ล็อตยา with pre-set filter -->
      <div class="list-group list-group-flush">
        <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
           href="#" data-expiry-filter="overdue">
          <span class="border-start border-danger border-3 ps-2">เกินกำหนดแล้ว</span>
          <span><span class="badge bg-danger">{N} ล็อต</span> ดูล็อต →</span>
        </a>
        <!-- repeat for within30 (bg-warning), within60 (bg-warning opacity-75), within90 (bg-stock-accent-subtle) -->
      </div>
      <div class="px-3 py-2 text-muted small">
        ∙ ปกติ (> 90 วัน): {normal} ล็อต
      </div>
    </div>
  </div>
  ```
- Click handler on each row: switch to Inventory tab + activate ล็อตยา sub-view + apply the corresponding expiry filter.
- **Zero state (no lots at all):** M-76 + M-77.
- **All-clear state (overdue+within30+within60+within90 = 0):** M-78 only.
- **Error state:** M-79.

- [ ] **Step 1: Implement expiry timeline panel in `js/dashboard.js`**

- [ ] **Step 2: Verify — panel renders**

Open `admin.html` → Dashboard tab. Confirm expiry timeline panel renders (not the "เปิดใช้งานใน Phase 2" placeholder). If no lots exist: confirm zero-state M-76 text. If a test lot with known bucket exists: confirm correct count in the right row.

- [ ] **Step 3: Verify — drill-down link works**

Click one of the "ดูล็อต →" links. Confirm Navigation switches to Inventory tab → ล็อตยา sub-view with the corresponding expiry window pre-filtered.

- [ ] **Step 4: Commit**

```bash
git add "js/dashboard.js"
git commit -m "feat(fe): dashboard.js — expiry timeline panel replaces Phase 2 placeholder (Phase 2)"
```

---

## Task B6: Service Worker bump + add `shared/lots.js` to STATIC_ASSETS

**Spec ref:** §4 (repo structure). **UX ref:** n/a. **Phase 1 pattern:** Phase 1 bumped sw.js to `v0.2.0`.

**File:** `F:\@Coding\ระบบ\The Good Stock\sw.js` (EDIT)

- [ ] **Step 1: Edit `sw.js`**

Find `CACHE_VERSION = 'thegood-stock-v0.2.0'` (or whatever Phase 1 set it to) and change to `'thegood-stock-v0.3.0'`.

Find the `STATIC_ASSETS` array and add `'shared/lots.js'` to the list. Also add `'js/inventory-lots.js'`.

- [ ] **Step 2: Verify**

Open `admin.html` in Chrome. Open Application → Service Workers → confirm new SW with v0.3.0 cache is installed and activated (old v0.2.0 should be replaced after refresh). Open Cache Storage → `thegood-stock-v0.3.0` → confirm `shared/lots.js` and `js/inventory-lots.js` appear in the cached file list.

- [ ] **Step 3: Commit**

```bash
git add "sw.js"
git commit -m "feat(fe): sw.js — bump CACHE_VERSION to v0.3.0 + add lots.js and inventory-lots.js (Phase 2)"
```

---

# Phase C — Acceptance test plan (T45–T70)

## Task C1: Run acceptance tests T45–T70

All tests from spec §9 re-stated here with exact verification evidence required.

### Category & item setup

- [ ] **T45** — MEDICATION category seeded
  ```sql
  SELECT code, name FROM stock_categories WHERE code='MEDICATION';
  -- Expected: 1 row — MEDICATION / ยา
  ```

- [ ] **T46** — Create medication item with `tracks_lots=true`
  - Admin → Inventory → "+ เพิ่มสินค้า" → name "อะม็อกซิลิน 500mg", SKU "MED-AMOX-500", category MEDICATION, unit "เม็ด", reorder_threshold 100, toggle `ติดตามล็อต / วันหมดอายุ` ON.
  - Expected:
    ```sql
    SELECT tracks_lots FROM stock_items WHERE sku='MED-AMOX-500';
    -- Expected: true
    ```

- [ ] **T47** — Create non-medication item with `tracks_lots=false`
  - Create "ผ้าก๊อซ", SKU "SUPPLY-GAUZE-001", category SUPPLY, toggle OFF.
  - Expected: `tracks_lots=false`. In Receive form for this item: NO lot section appears.

### Lot creation via receive flow

- [ ] **T48** — Admin receive creates lot + movement
  - Admin → Inventory → รับเข้า → pick MED-AMOX-500 → lot section appears → fill: lot_number="LOT-2026-A", expiry_date=2027-05-01, supplier="Pfizer Thailand", qty=200, pick a location. Submit.
  - Expected:
    ```sql
    SELECT lot_number, status, received_qty, current_qty
    FROM stock_lots WHERE lot_number='LOT-2026-A';
    -- Expected: LOT-2026-A / active / 200 / 200
    SELECT movement_type, qty_delta, lot_id IS NOT NULL AS has_lot
    FROM stock_movements ORDER BY performed_at DESC LIMIT 1;
    -- Expected: receive / 200 / true
    ```

- [ ] **T49** — Non-medication item receive has no lot fields and lot_id IS NULL in movement
  - Admin receive SUPPLY-GAUZE-001, qty=50.
  - Expected: no lot fields in UI; `lot_id IS NULL` in resulting `stock_movements` row.

- [ ] **T50** — Client-side validation blocks receive when lot_number is empty (tracks_lots=true item)
  - In receive form for MED-AMOX-500, leave lot_number blank. Click submit.
  - Expected: submit blocked; toast/inline error M-44 "กรุณาระบุหมายเลขล็อต".

- [ ] **T51** — DB trigger `check_lot_status` blocks direct API insert with lot_id=NULL for tracks_lots item
  - In DevTools Console:
    ```javascript
    const {error} = await supabase.from('stock_movements').insert({
      item_id: '<MED-AMOX-500-item-id>',
      location_id: '<any-location-id>',
      movement_type: 'issue',
      qty_delta: -1,
      lot_id: null
    });
    console.log(error.message);
    // Expected: contains "lot_id is required for medication item"
    ```

- [ ] **T52** — Duplicate lot_number + item_id returns 409
  - In receive form, attempt to create another lot for MED-AMOX-500 with lot_number="LOT-2026-A".
  - Expected: UI shows inline error M-47 ("ล็อตนี้มีอยู่แล้ว"). No new row in `stock_lots`.

### Issue flow with lot picker

- [ ] **T53** — Staff scan with lot picker: lot picker appears, issue decrements lot qty
  - Open staff-scan.html. Scan MED-AMOX-500 barcode. Scan location where T48 stocked item. Confirm LOT-PICK step with LOT-2026-A as first row. Tap [ขั้นต่อไป]. Enter qty 10. Submit.
  - Expected:
    ```sql
    SELECT movement_type, qty_delta, fefo_override FROM stock_movements
    ORDER BY performed_at DESC LIMIT 1;
    -- Expected: issue / -10 / false
    SELECT current_qty FROM stock_lots WHERE lot_number='LOT-2026-A';
    -- Expected: 190
    ```

- [ ] **T54** — Over-issue triggers lot qty negative guard
  - Attempt to issue 300 from LOT-2026-A (current_qty=190).
  - Expected: DB trigger raises exception → error toast. `stock_lots.current_qty` unchanged at 190.

- [ ] **T55** — FEFO ordering with two lots
  - Create a second lot LOT-2026-B (expiry 2028-01-01, qty=50) for MED-AMOX-500.
  - Open lot picker. Confirm LOT-2026-A (expires 2027-05-01) appears first (FEFO).

- [ ] **T56** — Empty lot picker when all lots depleted or non-active
  - Manually set `status='depleted'` on all MED-AMOX-500 lots:
    ```sql
    UPDATE stock_lots SET status='depleted' WHERE item_id=(SELECT id FROM stock_items WHERE sku='MED-AMOX-500');
    ```
  - Scan and reach lot picker step. Expected: M-63/M-64 empty state. Issue aborted.

### Auto-depletion and expiry

- [ ] **T57** — Auto-deplete when current_qty reaches 0
  - Issue remaining qty from LOT-2026-B (e.g., if current_qty=50, issue 50).
  - Expected:
    ```sql
    SELECT status FROM stock_lots WHERE lot_number='LOT-2026-B';
    -- Expected: depleted
    ```

- [ ] **T58** — Manual cron run auto-expires stale lot
  - Insert test lot:
    ```sql
    INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty)
    SELECT id, 'TEST-EXPIRED', CURRENT_DATE - INTERVAL '1 day', 10, 10
    FROM stock_items WHERE sku='MED-AMOX-500';
    ```
  - Run cron manually:
    ```sql
    SELECT run_expiry_alert();
    ```
  - Expected:
    ```sql
    SELECT status FROM stock_lots WHERE lot_number='TEST-EXPIRED';
    -- Expected: expired
    ```

- [ ] **T59** — Expired lot absent from `v_lots_with_remaining`
  ```sql
  SELECT * FROM v_lots_with_remaining WHERE lot_number='TEST-EXPIRED';
  -- Expected: 0 rows
  ```

- [ ] **T60** — Auto-expire does NOT touch recalled or depleted lots
  - Insert a recalled lot with expiry yesterday:
    ```sql
    INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty, status)
    SELECT id, 'TEST-RECALLED-EXP', CURRENT_DATE - INTERVAL '1 day', 10, 5, 'recalled'
    FROM stock_items WHERE sku='MED-AMOX-500';
    ```
  - Run `SELECT run_expiry_alert()`.
  - Expected:
    ```sql
    SELECT status FROM stock_lots WHERE lot_number='TEST-RECALLED-EXP';
    -- Expected: recalled (unchanged — cron WHERE has AND status='active')
    ```

### Expiry alert Telegram messages

- [ ] **T61** — 30-day bucket alert fires
  - Insert a lot expiring today+25d:
    ```sql
    INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty)
    SELECT id, 'TEST-30D', CURRENT_DATE + 25, 10, 10
    FROM stock_items WHERE sku='MED-AMOX-500';
    ```
  - Ensure NOTIFY_SUPABASE_URL and NOTIFY_SERVICE_ROLE_KEY are set in `settings`.
  - Run `SELECT run_expiry_alert()`.
  - Expected:
    ```sql
    SELECT dedupe_key, event_type FROM notification_log
    WHERE dedupe_key = 'expiry:30:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
    -- Expected: 1 row
    ```

- [ ] **T62** — Dedupe: running cron twice same day does not double-alert
  - Run `SELECT run_expiry_alert()` again immediately.
  - Expected: `tg-notify` returns `{dedupe_hit: true}` for the bucket key. No duplicate Telegram message.

- [ ] **T63** — 60-day bucket correct
  - Insert lot expiring today+55d. Run cron.
  - Expected: `notification_log` row with `dedupe_key='expiry:60:<today>'`. No row for `expiry:30:<today>` attributable to this lot (it falls in 60d bucket, not 30d).

- [ ] **T64** — 90-day bucket correct
  - Insert lot expiring today+85d. Run cron.
  - Expected: `notification_log` row with `dedupe_key='expiry:90:<today>'`.

- [ ] **T65** — Telegram disabled setting: cron runs but tg-notify returns sent=false
  - Set `NOTIFY_TELEGRAM_ENABLED=false` in settings. Run cron.
  - Expected: `notification_log` row with `success=false` (or `sent=false` depending on tg-notify response shape). No Telegram message delivered.

### Admin lot management UI

- [ ] **T66** — ล็อตยา sub-view: color banding correct
  - Open Admin → Inventory → ล็อตยา. Confirm all lots for all medication items visible.
  - A lot expiring in 20 days shows amber/red badge "ใกล้หมดอายุ" (≤30d).
  - A lot expiring in 180 days shows green badge "ปกติ" (>90d).

- [ ] **T67** — Admin recall flow via UI
  - Click [เรียกคืน] on an active lot. Confirm recall modal opens with lot details.
  - Enter reason "ผู้ผลิตแจ้งเรียกคืน". Confirm.
  - Expected:
    ```sql
    SELECT status, recalled_reason FROM stock_lots WHERE lot_number='LOT-2026-A';
    -- Expected: recalled / ผู้ผลิตแจ้งเรียกคืน
    ```
  - Lot no longer appears in `v_lots_with_remaining`.
  - Staff scan lot picker for MED-AMOX-500 no longer shows LOT-2026-A.

- [ ] **T68** — Recall button absent for depleted lots
  - In ล็อตยา sub-view, locate a lot with `status='depleted'`.
  - Expected: [เรียกคืน] button is absent (not just disabled — not rendered).

### RLS and permissions

- [ ] **T69** — Employee cannot INSERT stock_lots
  - Log in as Employee role. In DevTools Console:
    ```javascript
    const {error} = await supabase.from('stock_lots').insert({
      item_id: '<any-item-id>', lot_number: 'TEST-RLS', expiry_date: '2030-01-01',
      received_qty: 1, current_qty: 1
    });
    console.log(error.code);
    // Expected: 42501 (insufficient_privilege) or error message "new row violates row-level security policy"
    ```

- [ ] **T70** — Employee cannot UPDATE stock_lots (recall)
  - In DevTools Console as Employee:
    ```javascript
    const {error} = await supabase.from('stock_lots')
      .update({status: 'recalled'}).eq('lot_number', 'LOT-2026-A');
    console.log(error.code);
    // Expected: RLS rejection (42501)
    ```

---

# Phase D — Docs + smoke checklist update

## Task D1: Update `docs/test-checklist.md` + `Project.md`

**Files:** `F:\@Coding\ระบบ\The Good Stock\docs\test-checklist.md` (EDIT), `F:\@Coding\ระบบ\The Good Stock\Project.md` (EDIT)

- [ ] **Step 1: Append T45–T70 to `docs/test-checklist.md`**

Add a new section `## Phase 2 — Medication Lots + Expiry` with all 26 tests as unchecked items using the convention:
```
- [ ] T45: ...
```

- [ ] **Step 2: Update `Project.md`**

  - In §2 Scope table: change Phase 2 status from `not started` to `LIVE` (after all tests pass and tag is applied).
  - In §5.2 Database: add the 8 Phase 2 migration files.
  - In §5.1 Frontend: add `js/inventory-lots.js` (NEW) and note the 4 edited files.
  - In §8 Quirks: add gotcha 10:
    ```
    10. **Phase 2 `check_lot_status` trigger raises EXACTLY `'ล็อตหมดอายุหรือถูกเรียกคืน'`** — FE staff-scan.js greps this string to map to Thai toast M-65. Do not change the exception message without updating staff-scan.js.
    ```

- [ ] **Step 3: Tag when T45–T70 all pass**

```bash
git tag phase2-medication
git push origin phase2-medication
```

- [ ] **Step 4: Commit docs**

```bash
git add "docs/test-checklist.md" "Project.md"
git commit -m "docs: Phase 2 test-checklist T45–T70 + Project.md §2/§5/§8 update"
```

---

# Effort estimate + Risk factors

| Phase | Tasks | Estimate | Risk notes |
|---|---|---|---|
| A (DB) | A1–A8 | 0.5 days | pg_cron uncertainty: if Free/Nano plan doesn't expose it, CF fallback adds ~0.5d extra |
| B (Frontend) | B1–B6 | 1.4 days | B2+B3 are large edits (inventory.js already complex); B4 (staff-scan.js) has complex state machine insertion |
| C (Tests) | C1 | 0.4 days | Requires test lots to be creatable; test data cleanup afterwards |
| D (Docs) | D1 | 0.1 days | Mechanical |
| **Total (pg_cron available)** | | **~2.4 days** | |
| **Total (pg_cron fallback)** | | **~2.9 days** | |

**Risk adjustment (+20%):** Implementation surface is large (4 triggers, 8 migrations, 5 JS files). Realistic estimate: **2.9–3.5 days**.

---

# Risks (Top 5 for implementer visibility)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | **pg_cron blocked on Supabase Free/Nano plan** | Medium — auto-expire and Telegram alerts don't run | PF-7 pre-flight check; CF Worker fallback path in Task A8 |
| R-2 | **Staff scan state machine regression** (inserting lot picker step breaks non-medication item flow) | High — core Phase 1 scan flow disrupted | Guard EVERY state transition with explicit `if (item.tracks_lots)` check; add T47 regression test |
| R-3 | **Trigger firing order** — `trg_check_lot_status` (BEFORE, alphabetical) must fire before `trg_sm_sign` (also BEFORE). PostgreSQL fires BEFORE triggers in alphabetical order by name | Low — `c` < `s` alphabetically so `check_lot_status` fires first | Verify in Step 3 of A5 (`SELECT tgname FROM pg_trigger ORDER BY tgname`) |
| R-4 | **`v_lots_with_remaining` view not created in Phase 2 plan** | Medium — lot picker and FEFO sort have no view to query | The plan uses the view as defined in spec §5.3. A migration creating this view must be added. **See Contradiction note below.** |
| R-5 | **UX design references force-issue override (S-2.5) in multiple places** | Low — implementer may accidentally build the removed feature | Explicitly: do NOT build the [บังคับเบิก-จ่าย] button (removed per Q-D1). Search for "บังคับ" in any new code before committing. |

---

# Contradictions escalated to PM

## Contradiction C-1 (ESCALATED): Migration timestamp collision

**Decision doc says:** Phase 2 migrations use `20260519000000_...` through `20260519000700_...`.
**Phase 1 reality:** Those same timestamps are already occupied by Phase 1 migrations (`20260519000000_stock_categories.sql` through `20260519000700_...`).
**Resolution used in this plan:** Phase 2 migrations use `20260519010000` through `20260519010700` (same calendar date, next sequence block).
**PM action required:** Confirm this is acceptable OR provide new timestamps.

## Contradiction C-2 (ESCALATED): `v_lots_with_remaining` view migration missing from task list

**Spec §5.3** defines a `v_lots_with_remaining` view with full DDL. The decisions-locked doc lists 8 migration tasks (A1–A8) but does NOT include a migration for this view. The plan currently relies on the view (in `shared/lots.js` `fetchAvailableLots` query) but has no Task Ax for creating it.
**Resolution:** A migration `20260519010800_lots_view.sql` must be added as **Task A5b** between A5 and A6. Implementer should add it. This is not a PM-level decision — it is a plan omission. Including the view DDL here for implementer convenience:

**Task A5b (add to plan before A6):**

```sql
-- supabase/migrations/20260519010800_lots_view.sql
-- Phase 2 — v_lots_with_remaining view. Spec §5.3.
-- FEFO lot picker source: active lots with current_qty > 0, soonest expiry first.

CREATE OR REPLACE VIEW v_lots_with_remaining AS
SELECT
  sl.id,
  sl.item_id,
  si.sku,
  si.name          AS item_name,
  si.unit,
  sl.lot_number,
  sl.expiry_date,
  sl.received_at,
  sl.received_qty,
  sl.current_qty,
  sl.supplier,
  sl.note,
  sl.status,
  (sl.expiry_date - CURRENT_DATE) AS days_until_expiry
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
WHERE sl.status = 'active'
  AND sl.current_qty > 0
ORDER BY sl.expiry_date ASC NULLS LAST, sl.received_at ASC;

COMMENT ON VIEW v_lots_with_remaining IS
  'Phase 2 FEFO lot picker source. Active lots with current_qty > 0, soonest expiry first.';
```

Verification:
```sql
SELECT count(*) FROM v_lots_with_remaining;
-- Expected: 0 (no lots yet); no error = view created
```

This view does NOT need an explicit RLS policy — it inherits `stock_lots` RLS (SECURITY INVOKER, default).

## Contradiction C-3 (ESCALATED): `recalled_reason`/`recalled_by`/`recalled_at` columns in decisions-locked but absent from spec DDL

**Decisions doc (derived #1):** Lists `recalled_reason text`, `recalled_by text`, `recalled_at timestamptz` as explicit columns.
**Spec §5.1 DDL:** Does not include these columns (uses generic `note` column for recall reason, appended by UI).
**Resolution used:** Plan follows decisions-locked doc (three explicit audit columns added, `note` kept for general use).
**PM action:** Confirm this resolution is correct, or decide which authoritative source to follow.

---

# Constraints checklist (verbatim from decisions-locked doc)

Implementer ticks each before marking Phase 2 complete:

- [ ] `stock_lots` has `UNIQUE(item_id, lot_number)` — Q-Phase2-1
- [ ] Recall workflow is soft flag only (`status='recalled'`) — Q-Phase2-2
- [ ] Daily cron auto-expires lots (`status='expired'`) always-on — Q-Phase2-3
- [ ] BEFORE INSERT trigger raises EXACTLY `'ล็อตหมดอายุหรือถูกเรียกคืน'` for expired/recalled lot issue — Q-Phase2-4
- [ ] No force-issue expired override in Phase 2 (removed per Q-D1)
- [ ] FEFO override shows warning modal before submit, exact copy: `"ล็อต {lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"` — Q-D2
- [ ] Badge for expired (≤0 days) uses `bg-stock-accent-subtle` for the ≤90d band; expired uses `bg-danger` — Q-D3
- [ ] Lot picker shows 5 by default, accordion link for rest — Q-D4
- [ ] 4-segment tab at 360px: `overflow-x: auto` with edge-fade, NO label shortening — Q-D5
- [ ] `stock_movements.fefo_override boolean NOT NULL DEFAULT false` column added — derived #11
- [ ] Cron reads `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from `settings` table — NOT `current_setting()` — derived #8 / Project.md §8 gotcha 9
- [ ] All migrations are idempotent (`CREATE ... IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `DO $$ BEGIN IF NOT EXISTS ... $$`) — project rule
- [ ] Dollar-quoting uses named tags (e.g., `$check_lot_status$`) not bare `$$` — project rule

---

## Hand-off note

**Next agent:** `backend-developer` for Phase A tasks (A1–A8 + A5b), then `frontend-developer` for Phase B tasks (B1–B6), then PM for Phase C acceptance sign-off and Phase D tag.

**What this plan provides:**
- Exact SQL to paste (no placeholders) for all 9 migrations.
- Exact JS function signatures and implementation guidance for all 5 frontend files.
- Concrete verification SQL/JS for every task.
- Rollback snippet for every DB migration.
- Escalated contradictions C-1, C-2, C-3 for PM ruling before or during implementation.
- pg_cron fallback path fully specified inline (Task A8 CF section).
