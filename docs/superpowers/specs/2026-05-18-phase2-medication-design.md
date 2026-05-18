# DRAFT — Phase 2 Medication Lots + Expiry Tracking + 30/60/90-Day Alerts

**Project:** Thegood Stock Management System
**Phase:** 2 (Medication Lots + Expiry Tracking + 30/60/90-day Alerts)
**Date:** 2026-05-18
**Author:** Business/System Analyst (autonomous draft while PM "Pex" reviews Phase 1)
**Status:** **DRAFT — pending PM review.** Do not implement until Phase 1 is deployed and T24–T44 pass. Four open questions in §11 need PM decisions before plan write-up.
**Predecessor:** `docs/superpowers/specs/2026-05-18-phase1-inventory-design.md` (Phase 1 — general inventory + low-stock alert)

---

## 1. Purpose & Scope

Phase 2 extends Phase 1's general inventory system with **medication-specific controls**: lot tracking, expiry dates, and proactive expiry alerts. It covers the smallest vertical that addresses the real patient-safety risk in Thegood's operations — expired medications being administered.

Source of requirements: `ระบบจัดการสต๊อกและอุปกรณ์การแพทย์.pdf` §5 (Medication Module) and §6 (Expiry Tracking Module), provided by user 2026-05-18.

### In scope (Phase 2)

- New table `stock_lots` — one row per received batch of a medication item, carrying `lot_number`, `expiry_date`, `received_qty`, `current_qty`, `supplier`, and a `status` enum (`active` | `depleted` | `expired` | `recalled`).
- `stock_movements.lot_id` **promoted from nullable placeholder to an enforced FK** to `stock_lots(id)` for items where `stock_items.tracks_lots = true`.
- New view `v_lots_with_remaining` — powers lot pickers in the UI; ordered `ASC expiry_date` (FEFO: First Expiry First Out).
- New trigger `trg_lot_qty_apply` — mirrors the `apply_movement_to_sil` pattern: on `stock_movements` INSERT where `lot_id IS NOT NULL`, decrements (or increments) `stock_lots.current_qty`.
- New `pg_cron` job `expiry_alert` — runs daily at 09:00 Asia/Bangkok; scans active lots expiring within 90 days; groups into 30d / 60d / 90d buckets; posts one Telegram message per bucket; uses `tg-notify` with a date-stamped `dedupe_key`.
- Admin UI extension: **"ใบล็อตยา" sub-view** inside the existing Inventory tab; lot list, expiry timeline column, "mark as recalled" action.
- Receive flow extension for `tracks_lots` items: **lot modal** (lot_number + expiry_date + qty + supplier) must be completed before the movement is posted.
- Issue / scan flow extension: **lot picker** (FEFO order by default, manual override allowed) is shown before the qty step when the scanned item `tracks_lots = true`.
- New seed row: `MEDICATION` category added to `stock_categories`.
- Acceptance tests T45–T70 (continuing from Phase 1 T44).

### Out of scope (Phase 2 — deferred)

- DEA / Narcotics controlled-substance audit log (Thegood does not dispense controlled medications per PDF context).
- Lot-level photo proof (photos are introduced in Phase 3 for borrow/return; medication lot photos can be added in Phase 3+).
- Per-item configurable expiry-alert thresholds (e.g., alert at 15d for high-turnover items). Phase 2 uses a settings-level default only (`EXPIRY_ALERT_DAYS = '30,60,90'`). Per-item overrides deferred.
- FEFO algorithm tuning beyond `ORDER BY expiry_date ASC NULLS LAST`. Weighted FEFO, FIFO-override, etc. deferred.
- Lot merging / splitting.
- Multi-pharmacy handoff with inter-lot chain of custody.
- Quantity-unit conversion within lots (e.g., bottle → tablet). Phase 2 uses the parent item's `unit`.
- ALS bag medication granular expiry (Phase 4 covers kit-level expiry with the same `stock_lots` table as a child of a `bag` location).

---

## 2. Architecture Overview

Phase 2 is purely additive. No Phase 0 or Phase 1 tables are structurally changed; the only schema changes are:

1. ADD a new `stock_lots` table.
2. ADD a FK constraint on the existing `stock_movements.lot_id` column (already defined as `uuid` with no FK in Phase 1).
3. ADD a new view and trigger on `stock_lots`.
4. ADD one `pg_cron` job (cron extension already expected to be enabled by Phase 1 based on Phase 0 §3 row 8 and Project.md §9).
5. ADD seed row `MEDICATION` to `stock_categories`.
6. Extend existing Admin UI JS files.

```
Browser (mobile-first)
GitHub Pages: officethegood.github.io/thegood-stock

Admin (admin.html → Inventory tab)
  ├─ (Phase 1) Items list / Receive form / Item Finder
  └─ (NEW Phase 2) "ใบล็อตยา" sub-view
      ├─ Lot list table (item + lot_number + expiry + current_qty + status)
      ├─ Expiry timeline column with colour banding (red/amber/green)
      └─ Mark-recalled action → UPDATE stock_lots.status='recalled'

Staff (staff-scan.html, extended)
  └─ (NEW Phase 2) Lot picker step for tracks_lots items
      (between scan-location and qty steps)

                          │
         ┌────────────────┴──────────────────────────┐
         │ Supabase REST/RPC + Realtime (Phase 1+)   │
         └────────────────┬──────────────────────────┘
                          │
         ┌────────────────┴──────────────────────────┐
         │ Postgres (thegood-stock)                   │
         │  ── Phase 0 tables: (unchanged)             │
         │  ── Phase 1 tables: (unchanged)             │
         │      stock_items    stock_item_locations    │
         │      stock_movements (lot_id FK now live)   │
         │      stock_categories (MEDICATION seed)     │
         │  ── Phase 2 NEW:                            │
         │      stock_lots                             │
         │      view v_lots_with_remaining             │
         │      trigger trg_lot_qty_apply              │
         │      pg_cron job: expiry_alert (daily 09:00)│
         └────────────────┬──────────────────────────┘
                          │
         ┌────────────────┴──────────────────────────┐
         │ Edge Functions (Phase 0, reused unchanged) │
         │  └─ tg-notify: same fn, new event_type     │
         │     'expiry' from pg_cron job via pg_net   │
         └────────────────────────────────────────────┘
```

### Key Phase 2 principles

| Principle | How it shows up |
|---|---|
| **FEFO is the default, not a constraint** | Lot picker defaults to the soonest-expiring lot with `current_qty > 0`. Staff can override to a different lot when clinically appropriate. |
| **Expiry alert is a cron job, not a trigger** | Trigger-based expiry (checking expiry_date on every movement) would miss lots that simply age without being touched. A daily cron is the correct tool. |
| **Same transport as Phase 1** | `pg_net` → `tg-notify` → `NOTIFY_PROXY_URL` Cloudflare Worker. MUST read URL/key from `settings` table (`NOTIFY_SUPABASE_URL` / `NOTIFY_SERVICE_ROLE_KEY`) — not `current_setting()` (Project.md §8 gotcha 9). |
| **Lot qty is tracked separately from location qty** | `stock_lots.current_qty` counts how much of that lot remains (across all locations). `stock_item_locations.qty` tracks where the total of the item sits. Both are kept in sync by triggers on `stock_movements` INSERT. |
| **Backward-compatible with Phase 1** | Items with `tracks_lots = false` are unaffected by Phase 2 schema additions. All new enforcement is gated on that flag. |

---

## 3. Sync Strategy (adds rows 18–22 to Phase 1 table)

| # | Data | Type | Mechanism | Cadence | Phase |
|---|---|---|---|---|---|
| 1–5 | Phase 0 (login, refresh, ambulance sync, locations CRUD, settings) | — | — | — | 0 |
| 6–17 | Phase 1 (stock Realtime, low-stock alert, scan, Item Finder, items CRUD, etc.) | — | — | — | 1 |
| 18 | **Lot master CRUD** | Request-Response | Supabase REST INSERT/UPDATE on `stock_lots` | per operation | **2** |
| 19 | **Lot picker for issue/receive** | Request-Response | SELECT `v_lots_with_remaining` filtered by `item_id`, ordered `expiry_date ASC` | per scan step 2 | **2** |
| 20 | **Lot qty decrement/increment** | Autosync (trigger on movement) | `trg_lot_qty_apply` AFTER INSERT on `stock_movements` WHERE `lot_id IS NOT NULL` | per movement | **2** |
| 21 | **Expiry alert (30/60/90d buckets)** | **Autosync (cron)** | `pg_cron` job `expiry_alert` daily at 09:00 Asia/Bangkok; reads `NOTIFY_SUPABASE_URL` + `NOTIFY_SERVICE_ROLE_KEY` from `settings`; calls `tg-notify` via `pg_net` | 1x/day | **2** |
| 22 | **Auto-expire stale lots** | Autosync (cron piggyback) | Same cron job as row 21: UPDATE `stock_lots SET status='expired' WHERE expiry_date < CURRENT_DATE AND status='active'` | 1x/day (before alert query) | **2** |

**Note on row 22 (assumption A-1):** The auto-expire UPDATE runs inside the same `pg_cron` function, before the alert SELECT, so that the alert never counts a lot as "active" when its expiry_date has already passed. PM sign-off needed (see §11 Q-Phase2-3).

---

## 4. Repository Structure (new files only)

Phase 0 and Phase 1 layouts are unchanged. Phase 2 adds:

```
thegood-stock/
├── js/
│   ├── inventory.js            (EDIT — register "ใบล็อตยา" sub-view; lot list table; recall action)
│   ├── inventory-scan.js       (EDIT — insert lot-picker step when item.tracks_lots=true)
│   ├── staff-scan.js           (EDIT — insert lot-picker step before qty step)
│   └── inventory-lots.js       (NEW  — lot CRUD helpers, timeline render, recall modal)
│
├── shared/
│   └── lots.js                 (NEW  — v_lots_with_remaining query wrapper + FEFO sort helper)
│
├── supabase/
│   └── migrations/
│       ├── 20260520000000_stock_lots.sql             (NEW — stock_lots table + lot_status enum + RLS)
│       ├── 20260520000100_lot_fk.sql                 (NEW — ADD FK stock_movements.lot_id → stock_lots.id)
│       ├── 20260520000200_lots_view.sql              (NEW — v_lots_with_remaining view)
│       ├── 20260520000300_lot_triggers.sql           (NEW — trg_lot_qty_apply trigger)
│       ├── 20260520000400_expiry_cron.sql            (NEW — pg_cron job expiry_alert)
│       └── 20260520000500_medication_seed.sql        (NEW — INSERT 'MEDICATION' into stock_categories)
│
└── docs/
    ├── superpowers/specs/2026-05-18-phase2-medication-design.md   (this file)
    └── superpowers/plans/2026-05-18-phase2-medication-plan.md     (NEXT step — not yet written)
```

**Assumption A-2:** `pg_cron` extension is enabled by Phase 1's plan. Phase 2 migration `20260520000400` must guard with `CREATE EXTENSION IF NOT EXISTS pg_cron;` in case Phase 1 did not enable it yet.

---

## 5. Data Model

### 5.1 `lot_status` enum and `stock_lots` table (`20260520000000_stock_lots.sql`)

```sql
-- ── Enum ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lot_status') THEN
    CREATE TYPE lot_status AS ENUM (
      'active',    -- current_qty > 0 and expiry_date > today
      'depleted',  -- current_qty = 0 (used up normally)
      'expired',   -- expiry_date < today (set by daily cron)
      'recalled'   -- manually marked by Admin via UI recall action
    );
  END IF;
END $$;

COMMENT ON TYPE lot_status IS
  'Phase 2. active=in use; depleted=used up; expired=past expiry_date (auto by cron); recalled=manually quarantined.';

-- ── Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_lots (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid        NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  lot_number    text        NOT NULL,
  expiry_date   date        NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  received_qty  int         NOT NULL CHECK (received_qty > 0),
  current_qty   int         NOT NULL DEFAULT 0 CHECK (current_qty >= 0),
  supplier      text,
  note          text,
  status        lot_status  NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text        NOT NULL DEFAULT app_username(),
  updated_by    text,

  -- Q-Phase2-1 answered (recommendation): lot_number unique per item, not globally.
  CONSTRAINT uq_lot_per_item UNIQUE (item_id, lot_number)
);

COMMENT ON TABLE stock_lots IS
  'Phase 2. One row per received medication batch. current_qty kept in sync by trg_lot_qty_apply trigger.';
COMMENT ON COLUMN stock_lots.lot_number   IS 'Manufacturer-assigned lot number. Unique within the same item (uq_lot_per_item).';
COMMENT ON COLUMN stock_lots.expiry_date  IS 'Date only (no time). Expiry alerts fire when expiry_date - today <= bucket threshold.';
COMMENT ON COLUMN stock_lots.current_qty  IS 'Running balance: received_qty minus all issued/adjusted movements referencing this lot.';
COMMENT ON COLUMN stock_lots.status       IS 'Set to expired by daily cron when expiry_date < today. Set to recalled by Admin. Set to depleted by trigger when current_qty reaches 0.';

CREATE INDEX IF NOT EXISTS idx_sl_item    ON stock_lots(item_id);
CREATE INDEX IF NOT EXISTS idx_sl_expiry  ON stock_lots(expiry_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sl_status  ON stock_lots(status);

CREATE TRIGGER trg_stock_lots_updated_at BEFORE UPDATE ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE stock_lots ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read lots (needed for lot picker on staff scan page).
CREATE POLICY sl_read ON stock_lots
  FOR SELECT TO authenticated USING (true);

-- Only Admin can INSERT new lots (receive flow gate).
CREATE POLICY sl_insert ON stock_lots
  FOR INSERT TO authenticated
  WITH CHECK (app_user_role() = 'Admin');

-- Only Admin can UPDATE lots (recall, correction).
-- The lot_qty trigger runs as SECURITY DEFINER (postgres role) and bypasses RLS.
CREATE POLICY sl_update ON stock_lots
  FOR UPDATE TO authenticated
  USING  (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- No DELETE: lots are audit records; use status='recalled' or 'depleted' instead.

-- ── Verification SQL ─────────────────────────────────────────────────────
-- 1) Enum labels (4 expected):
--    SELECT enumlabel FROM pg_enum
--    WHERE enumtypid='lot_status'::regtype ORDER BY enumsortorder;
--
-- 2) Table structure + constraints:
--    SELECT conname, contype FROM pg_constraint
--    WHERE conrelid='stock_lots'::regclass ORDER BY conname;
--    -- expected: stock_lots_pkey (p), stock_lots_item_id_fkey (f),
--    --           stock_lots_received_qty_check (c), stock_lots_current_qty_check (c),
--    --           uq_lot_per_item (u)
--
-- 3) RLS enabled:
--    SELECT relrowsecurity FROM pg_class WHERE relname='stock_lots';
--    -- expected: true
--
-- 4) Indexes:
--    SELECT indexname FROM pg_indexes WHERE tablename='stock_lots' ORDER BY indexname;
--    -- expected: idx_sl_expiry, idx_sl_item, idx_sl_status (+ pk + unique idx)
```

### 5.2 FK promotion on `stock_movements.lot_id` (`20260520000100_lot_fk.sql`)

Phase 1 defined `lot_id uuid` with no FK. Phase 2 adds the constraint. The column already exists so no data migration is needed for existing rows (all have `lot_id IS NULL`).

```sql
-- Add FK: stock_movements.lot_id → stock_lots(id)
-- Only fails if a row with a non-null lot_id exists that doesn't match any stock_lots.id.
-- (Phase 1 rows all have lot_id IS NULL, so this is safe.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_lot_id_fkey'
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_lot_id_fkey
      FOREIGN KEY (lot_id) REFERENCES stock_lots(id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMENT ON COLUMN stock_movements.lot_id IS
  'Phase 2: FK to stock_lots(id). Required (NOT NULL enforced by trigger trg_lot_require_for_meds) when item.tracks_lots=true AND movement_type IN (issue, adjustment_loss, receive). Nullable for Phase 1 items.';

-- ── Verification SQL ─────────────────────────────────────────────────────
-- 1) FK constraint exists:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='stock_movements'::regclass AND contype='f' AND conname='stock_movements_lot_id_fkey';
--    -- expected: 1 row
--
-- 2) Existing Phase 1 rows unaffected (lot_id still NULL):
--    SELECT count(*) FROM stock_movements WHERE lot_id IS NOT NULL;
--    -- expected: 0 (assuming Phase 2 deployed before any medication lots are entered)
```

### 5.3 View `v_lots_with_remaining` (`20260520000200_lots_view.sql`)

This view powers the FEFO lot picker. It shows only lots that are `active` and have `current_qty > 0`, ordered by `expiry_date ASC` (soonest expiry first).

```sql
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
  -- Days until expiry (negative = already expired)
  (sl.expiry_date - CURRENT_DATE) AS days_until_expiry
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
WHERE sl.status = 'active'
  AND sl.current_qty > 0
ORDER BY sl.expiry_date ASC NULLS LAST, sl.received_at ASC;

COMMENT ON VIEW v_lots_with_remaining IS
  'Phase 2 FEFO lot picker source. Active lots with current_qty > 0, soonest expiry first. Used by receive and issue flows when item.tracks_lots=true.';

-- ── Verification SQL ─────────────────────────────────────────────────────
-- 1) View exists:
--    SELECT count(*) FROM v_lots_with_remaining;
--    -- expected: 0 rows (no lots yet); no error = view created correctly
--
-- 2) FEFO ordering: insert two test lots with different expiry_date values and
--    confirm the soonest expiry appears first:
--    SELECT lot_number, expiry_date FROM v_lots_with_remaining WHERE item_id = <test_id>;
```

### 5.4 Trigger: `trg_lot_qty_apply` and `trg_lot_require_for_meds` (`20260520000300_lot_triggers.sql`)

Two new trigger functions, both on `stock_movements` INSERT:

**`enforce_lot_required_for_meds`** (BEFORE INSERT, gating):
- If `item.tracks_lots = true` AND `movement_type IN ('issue', 'adjustment_loss', 'receive')` AND `lot_id IS NULL` → RAISE EXCEPTION.
- Ensures the UI cannot skip the lot picker step.

**`apply_movement_to_lot_qty`** (AFTER INSERT, running balance):
- If `lot_id IS NOT NULL`, UPDATE `stock_lots SET current_qty = current_qty + NEW.qty_delta WHERE id = NEW.lot_id`.
- If `current_qty` goes negative → RAISE EXCEPTION (same guard as Phase 1's `apply_movement_to_sil`).
- If `current_qty` becomes 0 after the UPDATE → SET `status = 'depleted'` on the lot row.

```sql
-- ── Trigger 1: enforce lot_id required for medication movements ──────────
CREATE OR REPLACE FUNCTION enforce_lot_required_for_meds()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tracks_lots boolean;
BEGIN
  -- Only check items that track lots.
  SELECT tracks_lots INTO v_tracks_lots
  FROM stock_items WHERE id = NEW.item_id;

  IF v_tracks_lots = true
     AND NEW.movement_type IN ('issue', 'adjustment_loss', 'receive')
     AND NEW.lot_id IS NULL
  THEN
    RAISE EXCEPTION
      'lot_id is required for medication item % (tracks_lots=true) on movement_type=%',
      NEW.item_id, NEW.movement_type;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_lot_required_for_meds() IS
  'Phase 2 BEFORE INSERT guard. When item.tracks_lots=true, issue/adjustment_loss/receive must supply a lot_id. Prevents silent lot bypass.';

DROP TRIGGER IF EXISTS trg_lot_require_for_meds ON stock_movements;
CREATE TRIGGER trg_lot_require_for_meds
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_lot_required_for_meds();

-- ── Trigger 2: apply movement qty to lot running balance ─────────────────
CREATE OR REPLACE FUNCTION apply_movement_to_lot_qty()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_lot_qty int;
BEGIN
  -- Only act when a lot is referenced.
  IF NEW.lot_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE stock_lots
    SET current_qty = current_qty + NEW.qty_delta,
        updated_at  = now()
  WHERE id = NEW.lot_id
  RETURNING current_qty INTO v_new_lot_qty;

  IF v_new_lot_qty < 0 THEN
    RAISE EXCEPTION
      'movement would drive lot current_qty negative for lot %', NEW.lot_id;
  END IF;

  -- Auto-deplete when lot reaches zero.
  IF v_new_lot_qty = 0 THEN
    UPDATE stock_lots
      SET status     = 'depleted',
          updated_at = now()
    WHERE id = NEW.lot_id AND status = 'active';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION apply_movement_to_lot_qty() IS
  'Phase 2 AFTER INSERT. Applies qty_delta to stock_lots.current_qty; auto-depletes when reaching zero. SECURITY DEFINER to bypass lot RLS.';

DROP TRIGGER IF EXISTS trg_lot_qty_apply ON stock_movements;
CREATE TRIGGER trg_lot_qty_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_lot_qty();

-- ── Verification SQL ─────────────────────────────────────────────────────
-- 1) Both triggers exist on stock_movements:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid='stock_movements'::regclass AND NOT tgisinternal
--    ORDER BY tgname;
--    -- expected: trg_lot_qty_apply, trg_lot_require_for_meds, trg_sm_apply,
--    --           trg_sm_lowstock, trg_sm_sign
--
-- 2) enforce_lot_required_for_meds SECURITY = false (no elevated privilege needed):
--    SELECT prosecdef FROM pg_proc WHERE proname='enforce_lot_required_for_meds';
--    -- expected: false
--
-- 3) apply_movement_to_lot_qty SECURITY DEFINER:
--    SELECT prosecdef FROM pg_proc WHERE proname='apply_movement_to_lot_qty';
--    -- expected: true
--
-- 4) Lot_id missing for tracks_lots item is rejected:
--    -- (Requires a tracks_lots=true item in stock_items to be meaningful)
--    -- See T51 in §9.
```

### 5.5 Daily cron job: `expiry_alert` (`20260520000400_expiry_cron.sql`)

The cron job runs at 09:00 Asia/Bangkok time (UTC+7 = 02:00 UTC). It reads thresholds from `EXPIRY_ALERT_DAYS` setting (default `'30,60,90'`), auto-expires stale lots, then posts bucket alerts via `tg-notify`.

**DEPLOY NOTE (follow Project.md §8 gotcha 9):** The function MUST read `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from the `settings` table, NOT from `current_setting()`. Same pattern as `check_low_stock()` in Phase 1 `20260518010500_stock_triggers.sql`.

```sql
-- Enable pg_cron if not already enabled (Phase 1 may have done this).
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── Cron function ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION run_expiry_alert()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
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
  r             RECORD;
BEGIN
  -- Step 1: Read settings (MUST use settings table — see Project.md §8 gotcha 9).
  SELECT value INTO v_url FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING 'run_expiry_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in settings; skipping.';
    RETURN;
  END IF;

  -- Step 2: Parse EXPIRY_ALERT_DAYS (e.g. '30,60,90' → ARRAY[30,60,90]).
  SELECT value INTO v_days_raw FROM settings WHERE key = 'EXPIRY_ALERT_DAYS';
  IF v_days_raw IS NULL OR v_days_raw = '' THEN
    v_days_raw := '30,60,90';
  END IF;

  SELECT ARRAY(
    SELECT trim(unnest)::int
    FROM unnest(string_to_array(v_days_raw, ','))
  ) INTO v_thresholds;

  -- Step 3: Auto-expire lots whose expiry_date < today.
  UPDATE stock_lots
    SET status = 'expired', updated_at = now()
  WHERE expiry_date < v_today
    AND status = 'active';

  -- Step 4: For each threshold bucket, find active lots expiring within
  --         [today, today + threshold] and post one Telegram alert.
  FOREACH v_threshold IN ARRAY v_thresholds LOOP
    -- Collect lots expiring in this bucket window.
    SELECT jsonb_agg(
      jsonb_build_object(
        'lot_id',       sl.id,
        'lot_number',   sl.lot_number,
        'item_name',    si.name,
        'sku',          si.sku,
        'expiry_date',  sl.expiry_date,
        'current_qty',  sl.current_qty,
        'unit',         si.unit,
        'days_left',    (sl.expiry_date - v_today)
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

    -- Skip bucket if no lots qualify.
    IF v_bucket_lots IS NULL OR jsonb_array_length(v_bucket_lots) = 0 THEN
      CONTINUE;
    END IF;

    -- Build human-readable message (Thai, matching Phase 0/1 alert style).
    v_msg := format(
      '⏳ แจ้งเตือนวันหมดอายุ (ภายใน %s วัน) — มี %s รายการ',
      v_threshold,
      jsonb_array_length(v_bucket_lots)
    );

    -- dedupe_key includes bucket + date to avoid duplicate same-day alerts per bucket.
    v_dedupe := 'expiry:' || v_threshold || ':' || to_char(v_today, 'YYYY-MM-DD');

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
$$;

COMMENT ON FUNCTION run_expiry_alert() IS
  'Phase 2 daily cron. Auto-expires stale lots then posts one tg-notify alert per EXPIRY_ALERT_DAYS bucket. Reads NOTIFY_SUPABASE_URL/NOTIFY_SERVICE_ROLE_KEY from settings table (Project.md §8 gotcha 9).';

-- ── Schedule via pg_cron (02:00 UTC = 09:00 Asia/Bangkok UTC+7) ───────────
-- NOTE for Dashboard-only deploy: run this as a separate SQL statement in
-- the SQL Editor AFTER the function is created.
-- If a cron job with this name already exists from a prior test, unschedule it first:
--   SELECT cron.unschedule('expiry_alert');
SELECT cron.schedule(
  'expiry_alert',
  '0 2 * * *',
  $$SELECT run_expiry_alert()$$
);

-- ── Verification SQL ─────────────────────────────────────────────────────
-- 1) pg_cron enabled:
--    SELECT extname FROM pg_extension WHERE extname='pg_cron';
--    -- expected: 1 row
--
-- 2) Cron job scheduled:
--    SELECT jobname, schedule, command FROM cron.job WHERE jobname='expiry_alert';
--    -- expected: 1 row, schedule='0 2 * * *'
--
-- 3) Manual test (smoke run) — run function directly:
--    SELECT run_expiry_alert();
--    -- expected: no exception; if NOTIFY_SUPABASE_URL/NOTIFY_SERVICE_ROLE_KEY are set,
--    --           a tg-notify call is attempted and a notification_log row is inserted.
--
-- 4) After smoke run, check notification_log for expiry events:
--    SELECT dedupe_key, success, sent_at FROM notification_log
--    WHERE event_type = 'expiry' ORDER BY sent_at DESC LIMIT 5;
```

### 5.6 Category seed (`20260520000500_medication_seed.sql`)

```sql
INSERT INTO stock_categories(code, name, sort_order)
VALUES ('MEDICATION', 'ยาและเวชภัณฑ์', 15)
ON CONFLICT (code) DO NOTHING;

-- ── Verification SQL ─────────────────────────────────────────────────────
-- SELECT code, name FROM stock_categories WHERE code = 'MEDICATION';
-- expected: 1 row
```

---

## 6. Edge Functions

**None new.** Phase 2 reuses `tg-notify` exactly as Phase 1 does. The cron function calls `tg-notify` via `pg_net` with `event_type='expiry'` — a new event type string, but `tg-notify` doesn't filter on event type; it dedupes against `notification_log.dedupe_key` and proxies to the Cloudflare Worker regardless. No code change to the Edge Function is required.

**Assumption A-3:** The `tg-notify` function at `supabase/functions/tg-notify/index.ts` does not validate or restrict `event_type` values. If PM or a future engineer adds event-type whitelisting to `tg-notify`, `'expiry'` must be added to that whitelist.

---

## 7. UI Spec

### 7.1 Admin — "ใบล็อตยา" sub-view (new segment inside Inventory tab)

The Inventory tab already has a segmented control (from Phase 1) with "รายการสินค้า" / "รับเข้า-ปรับสต๊อก" / "ค้นของ". Phase 2 adds a fourth segment: **"ล็อตยา"**.

**File changes:** `js/inventory.js` (register new segment) + new `js/inventory-lots.js`.

#### 7.1.1 Lot list table

Columns: ชื่อยา (item name) | ล็อตนัมเบอร์ | วันหมดอายุ | คงเหลือ (current_qty + unit) | สถานะ | จัดการ

- Source: SELECT from `stock_lots` JOIN `stock_items` WHERE `stock_items.tracks_lots = true`, ordered by `expiry_date ASC`.
- **Expiry colour banding** (read from the same `EXPIRY_ALERT_DAYS` setting used by cron):
  - `days_until_expiry <= 30` → red badge `หมดอายุเร็ว`
  - `days_until_expiry <= 60` → amber badge `ใกล้หมดอายุ`
  - `days_until_expiry <= 90` → yellow badge `เฝ้าระวัง`
  - `days_until_expiry > 90` AND `status='active'` → green badge `ปกติ`
  - `status='expired'` → dark-red badge `หมดอายุแล้ว`
  - `status='recalled'` → purple badge `ถูกเรียกคืน`
  - `status='depleted'` → grey badge `ใช้หมดแล้ว`

#### 7.1.2 Mark-recalled action

- "จัดการ" column has a "เรียกคืน" button visible only for `status='active'` or `status='expired'` lots.
- Clicking opens a confirm modal: "ยืนยันการเรียกคืนล็อต [lot_number] ของ [item_name]? — ล็อตนี้จะถูกล็อคจากการเบิก-จ่าย"
- On confirm: PATCH `stock_lots.status = 'recalled'` via Supabase REST (Admin RLS allows UPDATE).
- Recalled lots disappear from `v_lots_with_remaining` (view filters `status='active'`), so staff scan will no longer offer them.

#### 7.1.3 Lot receive form (inline in the existing "รับเข้า-ปรับสต๊อก" sub-view)

When the Admin picks an item with `tracks_lots = true` in the Receive form:
- A collapsible "รายละเอียดล็อต" section appears with fields:
  - ล็อตนัมเบอร์ (text, required)
  - วันหมดอายุ (date picker, required; must be >= today; validate client-side)
  - ผู้จัดจำหน่าย/Supplier (text, optional)
  - หมายเหตุ (text, optional)
- The form then INSERTs a `stock_lots` row first, then INSERTs the `stock_movements` row with `lot_id` set to the new lot's `id`, `movement_type='receive'`.
- If the lot_number already exists for that item (409 from `uq_lot_per_item`), the UI shows inline error "ล็อตนี้มีอยู่แล้ว — ตรวจสอบหรือเพิ่มจำนวนให้ล็อตเดิม".

**Assumption A-4:** A "top-up" scenario (adding more qty to an existing lot from a second delivery) is handled by inserting a new `stock_movements` row referencing the existing lot, not by creating a second `stock_lots` row. The UI offers an "เพิ่มของให้ล็อตเดิม" option on the lot list. This is simpler and avoids the 409 on the unique constraint.

### 7.2 Staff / Admin scan flow extension (lot picker step)

The scan overlay is a 3-step state machine in Phase 1:
1. Scan item
2. Scan location
3. Enter qty + submit

Phase 2 inserts a new **Step 2.5: เลือกล็อต** between location and qty when `item.tracks_lots = true` and `movement_type = 'issue'` or `'adjustment_loss'`:

- Fetch `v_lots_with_remaining` WHERE `item_id = <scanned_item>`.
- Display as a scrollable list: lot_number + expiry_date (days badge) + current_qty.
- Default selection: first row (FEFO — soonest expiry).
- Staff can scroll and tap another lot to override. No lock-out; staff has full discretion.
- If zero lots are available → toast "ไม่มีล็อตยาที่พร้อมใช้งาน — ติดต่อผู้ดูแลระบบ" and abort the issue.

**For receive (Admin scan):** After step 1 (item) and step 2 (location), a "lot form" overlay slides in for lot details (same fields as §7.1.3) before proceeding to qty.

**Files changed:** `js/inventory-scan.js` (admin receive path), `js/staff-scan.js` (staff issue path). New shared helper `shared/lots.js` provides `fetchAvailableLots(itemId)` and `renderLotPicker(lots)`.

### 7.3 Localization

All new UI strings in Thai. No i18n framework; follows Phase 0/1 pattern.

---

## 8. RLS Policies (Phase 2 additions — extends Phase 0 + Phase 1)

New policies are in `20260520000000_stock_lots.sql` (§5.1 above). Summary of Phase 2 additions:

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `stock_lots` | authenticated (read all — needed for lot picker) | Admin only | Admin only | — (use status instead) |

**Interaction with existing policies:**
- `stock_movements`: Phase 1 policies unchanged. Staff INSERT remains allowed for `issue` and `adjustment_loss`. The new `enforce_lot_required_for_meds` trigger (§5.4) is the enforcement layer for lot_id presence — it is a DB-level control that operates regardless of which role inserts.
- `stock_items`: Phase 1 Admin-write policy covers the Admin updating `tracks_lots = true` on an existing item.

**Assumption A-5:** There is no automated flag-setting. An Admin must manually toggle `tracks_lots = true` on each medication item via the item edit form (admin "รายการสินค้า" sub-view). Phase 2 spec does not include a bulk-migration utility.

---

## 9. Acceptance Tests (T45–T70, continuing from Phase 1 T44)

### Category & item setup (T45–T47)

**T45** Admin opens stock_categories in the database (or Admin uses a category picker in item create): confirm `MEDICATION` row exists after Phase 2 migration.
- Expected: `SELECT code FROM stock_categories WHERE code='MEDICATION'` → 1 row.

**T46** Admin creates a new item: name "อะม็อกซิลิน 500mg", SKU "MED-AMOX-500", category MEDICATION, unit "เม็ด", reorder_threshold 100, `tracks_lots = true`.
- Expected: `stock_items` row with `tracks_lots=true`; item appears in Inventory tab.

**T47** Admin creates a second item: name "ผ้าก๊อซ (Phase 1 item)", `tracks_lots = false` (default).
- Expected: `tracks_lots=false`; no lot UI is shown in any receive/issue flow for this item.

### Lot creation via receive flow (T48–T52)

**T48** Admin opens Receive form, picks T46 item (MED-AMOX-500). Lot section appears. Fills: lot_number="LOT-2026-A", expiry_date=2027-05-01, supplier="Pfizer Thailand", qty=200. Submits.
- Expected: (1) `stock_lots` row inserted with `status='active'`, `current_qty=200`, `received_qty=200`. (2) `stock_movements` row with `movement_type='receive'`, `lot_id` = new lot's id, `qty_delta=200`. (3) `stock_item_locations` updated with qty=200 at the chosen location.

**T49** Admin attempts to receive T47 (non-medication) item. Lot section must NOT appear. Submit posts `stock_movements` with `lot_id=NULL`.
- Expected: no lot fields in UI; movement succeeds; `lot_id IS NULL` in the row.

**T50** Admin attempts to receive T46 (medication) item via the Receive form but omits lot_number. Submit fails.
- Expected: client-side validation blocks submit; toast "กรุณาระบุหมายเลขล็อต".

**T51** Admin tries to INSERT `stock_movements` directly via DevTools with `lot_id=NULL` for T46 medication item, `movement_type='receive'`.
- Expected: DB trigger `trg_lot_require_for_meds` raises exception → REST returns 400 / 500; movement row NOT created.

**T52** Admin attempts to create a second lot with the same `item_id` + `lot_number="LOT-2026-A"` for T46.
- Expected: 409 unique constraint violation `uq_lot_per_item`; UI shows inline error "ล็อตนี้มีอยู่แล้ว".

### Issue flow with lot picker (T53–T56)

**T53** Employee (staff) opens staff-scan.html, scans T46 barcode, scans a location where T46 is stocked (qty > 0). Lot picker step appears with "LOT-2026-A" as first/default row. Staff taps submit with qty 10.
- Expected: (1) `stock_movements` row `movement_type=issue`, `qty_delta=-10`, `lot_id=<lot-A-id>`. (2) `stock_lots.current_qty` = 190. (3) `stock_item_locations.qty` decremented by 10. (4) `qty_after=<updated sil qty>`.

**T54** Staff attempts to issue more than `stock_lots.current_qty` (e.g., qty=300 when lot has current_qty=190).
- Expected: trigger `apply_movement_to_lot_qty` raises "lot current_qty negative" → REST 400; toast "ของในล็อตไม่พอ"; no row inserted.

**T55** Staff opens lot picker for T46. Two lots available: LOT-2026-A (expires 2027-05-01) and LOT-2026-B (expires 2028-01-01). FEFO default selects LOT-2026-A first.
- Expected: LOT-2026-A displayed at top of picker; staff can scroll and select LOT-2026-B instead.

**T56** Staff opens lot picker for T46 but all available lots have `current_qty=0` or `status!='active'`.
- Expected: toast "ไม่มีล็อตยาที่พร้อมใช้งาน"; issue aborted.

### Auto-depletion and expiry (T57–T60)

**T57** Admin issues all remaining qty from LOT-2026-A (e.g., issue 190 when current_qty=190).
- Expected: trigger auto-sets `stock_lots.status='depleted'`. LOT-2026-A no longer appears in `v_lots_with_remaining` and lot picker.

**T58** Manually INSERT a test lot with `expiry_date = yesterday's date` and `status='active'`. Run `SELECT run_expiry_alert()` manually in SQL Editor.
- Expected: (1) `UPDATE stock_lots SET status='expired'` fires for the test lot. (2) If NOTIFY settings are populated, `notification_log` row with `event_type='expiry'` is inserted.

**T59** After T58, test lot should not appear in `v_lots_with_remaining`.
- Expected: `SELECT * FROM v_lots_with_remaining WHERE lot_number='TEST-EXPIRED'` → 0 rows.

**T60** Verify auto-expire does NOT affect lots with `status='recalled'` or `status='depleted'`. Insert a recalled lot with `expiry_date = yesterday`. Run `SELECT run_expiry_alert()`.
- Expected: `UPDATE stock_lots SET status='expired'` WHERE clause has `AND status='active'` — recalled lot status unchanged.

### Expiry alert Telegram messages (T61–T65)

**T61** Insert a lot with `expiry_date = today + 25 days` and `status='active'`, `current_qty > 0`. Run `SELECT run_expiry_alert()`. NOTIFY settings must be configured.
- Expected: `notification_log` row with `dedupe_key = 'expiry:30:<today>'` and `event_type='expiry'`. Telegram group receives a message mentioning the lot.

**T62** Run `SELECT run_expiry_alert()` a second time on the same day.
- Expected: `tg-notify` returns `{dedupe_hit: true}` for the same bucket; no second Telegram message. `notification_log` shows the deduplication.

**T63** Insert a lot expiring in 55 days (should appear in the 60-day bucket but NOT the 30-day bucket). Run cron.
- Expected: `notification_log` row with `dedupe_key='expiry:60:<today>'` exists. No `dedupe_key='expiry:30:<today>'` row for that lot.

**T64** Verify the 90-day bucket: insert a lot expiring in 85 days. Run cron.
- Expected: `notification_log` row with `dedupe_key='expiry:90:<today>'`.

**T65** With `NOTIFY_TELEGRAM_ENABLED=false` in settings, run `SELECT run_expiry_alert()`.
- Expected: `tg-notify` returns `{sent:false, reason:'disabled'}`; `notification_log` row inserted with `success=false` or `sent=false`.

### Admin lot management UI (T66–T68)

**T66** Admin opens Inventory tab → "ล็อตยา" sub-view. All active lots for all medication items are listed. Colour banding: a lot expiring in 20 days shows red badge; a lot expiring in 180 days shows green badge.

**T67** Admin clicks "เรียกคืน" on a lot with `status='active'`. Confirm dialog appears. Admin confirms.
- Expected: `stock_lots.status='recalled'`; lot disappears from `v_lots_with_remaining`; lot picker for staff no longer shows it.

**T68** Admin tries to recall an already-depleted lot. "เรียกคืน" button should be hidden or disabled for `status='depleted'` lots.
- Expected: button absent for depleted lots; no PATCH sent.

### RLS and permission (T69–T70)

**T69** Employee attempts to INSERT `stock_lots` directly via DevTools (bypassing UI).
- Expected: RLS `sl_insert` policy rejects (only `app_user_role()='Admin'` allowed); 403 response.

**T70** Employee attempts to UPDATE `stock_lots.status='recalled'` via DevTools.
- Expected: RLS `sl_update` policy rejects; 403 response.

---

## 10. Out of Scope (Phase 2)

| Item | Phase / Notes |
|---|---|
| DEA / Narcotics controlled substance audit | Not applicable to Thegood per PDF context. |
| Lot-level photo proof (e.g., photo of lot label on receive) | Phase 3+ — Cloudinary wiring lands in Phase 3 for borrow/return; medication lot photos can piggyback. |
| Per-item configurable expiry alert thresholds | Deferred per §1. Phase 2 uses global `EXPIRY_ALERT_DAYS` only. |
| FEFO tuning beyond `ORDER BY expiry_date ASC` | Deferred. Weighted FEFO, FIFO-override, blocked-lot skip, etc. |
| Lot merging / splitting | Not planned. Each delivery = one lot row. |
| ALS bag kit-level lot composition | Phase 4 — a kit references multiple lots; Phase 4 introduces `kit_lot_components` table. |
| Transfer between locations for lot-tracked items | Phase 2 supports issue from one location + receive at another (two movements referencing the same lot). An atomic transfer shortcut is deferred. |
| Offline scan + lot picker for staff (SW background sync) | Deferred (same as Phase 1.1 offline queue). The lot picker requires a network call to `v_lots_with_remaining`. Phase 2 is online-only. |
| Automated `tracks_lots` flag migration (bulk-set for all MEDICATION items) | Admin must set manually per item via the item edit form. |

---

## 11. Open Questions (for PM "Pex" — answer before plan write-up)

Four questions require PM decision. Recommendations included with options A/B/C.

---

### Q-Phase2-1 — Lot number uniqueness scope

**Question:** Should `lot_number` be unique globally across all items, or only unique per item?

**Context:** Manufacturers assign lot numbers per their own product lines. A lot number "2026-BATCH-01" from Pfizer (amoxicillin) and the same string from a different manufacturer (different drug) are legitimately separate lots. Enforcing global uniqueness would force prefix schemes that add complexity to receiving and staff lookup.

| Option | Constraint | Pros | Cons |
|---|---|---|---|
| **A — Unique per item (RECOMMENDED)** | `UNIQUE(item_id, lot_number)` | Matches manufacturer assignment semantics; Admin can reuse simple lot numbers per drug | Two items could share the same lot_number string, which could confuse a manual lookup |
| B — Globally unique | `UNIQUE(lot_number)` | Simpler query ("find lot X" returns exactly one row) | Forces artificial prefix on every lot; breaks when two suppliers happen to use same numbering |
| C — No uniqueness constraint | No constraint | Maximum flexibility | Opens door for duplicate entry; requires UI dedup check instead |

**Recommendation: A.** The `UNIQUE(item_id, lot_number)` constraint in §5.1 encodes this decision. Lot lookups always occur in the context of a known item.

---

### Q-Phase2-2 — Recall workflow depth

**Question:** Should a "recalled" lot be soft-disabled via `status='recalled'` (as specced), or should it trigger a hard quarantine (move stock to a "recalled" location, lock down any pending issues)?

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| **A — Soft status flag (RECOMMENDED)** | `status='recalled'`: lot disappears from `v_lots_with_remaining`, so new issues are blocked; existing movements are not reversed | Simple; low risk of data loss; audit trail preserved | Does not prevent a staff member who already has the lot open in their scan session from issuing it in the narrow window between recall and page reload |
| B — Hard quarantine | Move current_qty to a virtual "Recalled" location, UPDATE `stock_item_locations`, generate a compensating movement | Fully auditable qty path | Complex; requires a "Recalled" system location; triggers a movement chain that may confuse the ledger |
| C — Recalled + Telegram alert | Option A + automatic Telegram message when recalled | Proactive notification | Added complexity for a relatively rare event |

**Recommendation: A** for Phase 2. If Thegood staff are routinely recalling in-use lots under time pressure, escalate to Option B in Phase 3+. Option C can be added without schema change (just trigger a `tg-notify` POST in the lot UPDATE path).

---

### Q-Phase2-3 — Auto-expire lots: opt-in or always-on?

**Question:** Should the daily cron always auto-set `status='expired'` for lots past their `expiry_date`, or should this require Admin confirmation?

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| **A — Always-on auto-expire (RECOMMENDED)** | Daily cron UPDATEs `status='expired'` for all `expiry_date < today AND status='active'` lots. No Admin action required. | Ensures the system is always accurate; expired lots can never be issued by oversight | Requires trust that the cron runs; Admin cannot defer the expiry for a "use today" scenario |
| B — Alert only; Admin confirms | Cron sends Telegram; Admin must manually set `status='expired'` via UI | Admin retains control; can delay expiry for a legitimate "using today" situation | Risk: Admin forgets to act; expired lots remain issuable |
| C — Configurable | New setting `AUTO_EXPIRE_LOTS=true/false` | Maximum flexibility | More config = more cognitive load; most installations will want always-on |

**Recommendation: A.** Always-on auto-expire is the patient-safety-first option. If clinical staff legitimately need to use a lot that expired yesterday, Admin can set `status='active'` back manually — a deliberate override with an audit trail. Option C can be added without schema change.

---

### Q-Phase2-4 — Should expired/recalled lots hard-block issue at the DB level (RLS)?

**Question:** Currently the trigger `enforce_lot_required_for_meds` only enforces that a `lot_id` is supplied. Should there be a second guard — either trigger or RLS — that rejects an INSERT to `stock_movements` when the referenced `stock_lots.status IN ('expired', 'recalled')`?

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| **A — DB trigger blocks issue of expired/recalled lots (RECOMMENDED)** | Extend `enforce_lot_required_for_meds` (or add a second BEFORE trigger) to check `stock_lots.status NOT IN ('expired','recalled')` for issue/adjustment_loss movements | Belt-and-braces: even if the UI or a direct API call bypasses the lot picker, the DB refuses the issue | Adds a SELECT to every `stock_movements` INSERT for medication items; minor perf cost (negligible at this scale) |
| B — UI-only block | Lot picker filter (`v_lots_with_remaining`) already excludes `status!='active'`; no additional DB guard | Simpler trigger; no extra SELECT | A direct API call or a staff member with a stale cached lot list could bypass it |
| C — RLS expression | `CREATE POLICY sm_insert_staff ... WITH CHECK (lot_id IS NULL OR (SELECT status FROM stock_lots WHERE id=lot_id) = 'active')` | RLS layer (enforced by PostgREST) | RLS expressions with sub-selects have performance implications; Supabase RLS with auth.jwt() functions and sub-selects can be subtle |

**Recommendation: A.** Extend the BEFORE trigger in §5.4. The extra SELECT on `stock_lots` is O(pk-lookup) and the trigger already does a SELECT on `stock_items`. A DB-level guard is the right safety layer. Concrete DDL change to `enforce_lot_required_for_meds`: add a check after the `lot_id IS NULL` block:

```sql
-- (pseudocode — concrete DDL in plan)
IF NEW.lot_id IS NOT NULL AND NEW.movement_type IN ('issue','adjustment_loss') THEN
  SELECT status INTO v_lot_status FROM stock_lots WHERE id = NEW.lot_id;
  IF v_lot_status IN ('expired','recalled') THEN
    RAISE EXCEPTION 'Cannot issue from lot % with status=%', NEW.lot_id, v_lot_status;
  END IF;
END IF;
```

This guard is the concrete implementation of Q-Phase2-4 Option A. It must be part of the Phase 2 plan's trigger DDL.

---

## 12. Decisions Log

IDs use `Q-Phase2-X` to avoid collision with Phase 0 (Q1–Q18) and Phase 1 (Q-Phase1-A through Q-Phase1-P).

| ID | Question | Decision | Source |
|---|---|---|---|
| Q-Phase2-A | Lot tracking enabled per item, not globally | `stock_items.tracks_lots boolean` flag already in Phase 1 DDL; Phase 2 uses it as the gate for all lot enforcement | Phase 1 spec §1 "Out of scope" hook |
| Q-Phase2-B | `stock_movements.lot_id` promoted to real FK in Phase 2 | ALTER TABLE adds FK constraint on existing nullable column; Phase 1 rows unaffected (all NULL) | Phase 1 spec §5.4 comment + this spec §5.2 |
| Q-Phase2-C | Lot number unique per item (not globally) | `UNIQUE(item_id, lot_number)` — pending PM answer on Q-Phase2-1 | This spec §11 Q-Phase2-1 recommendation |
| Q-Phase2-D | FEFO default: `ORDER BY expiry_date ASC NULLS LAST` | Simplest correct FEFO; no tuning beyond `expiry_date` sort | This spec §1, §7.2 |
| Q-Phase2-E | No new Edge Function | Cron job calls `tg-notify` via `pg_net`; same pattern as Phase 1 low-stock alert; no new function needed | This spec §6 |
| Q-Phase2-F | Cron reads NOTIFY settings from `settings` table | MUST NOT use `current_setting()`; follows Project.md §8 gotcha 9 (Supabase pg-meta denies `ALTER DATABASE` for `app.*`) | Project.md §8 gotcha 9 + Phase 1 triggers migration |
| Q-Phase2-G | Cron runs at 02:00 UTC (09:00 Asia/Bangkok) | Matches operational hour in `NOTIFY_CRON_HOUR` setting (Phase 0 default = 6, but cron expression is explicit) | Phase 0 spec §3 row 8 |
| Q-Phase2-H | Expiry alert deduped per bucket per day | `dedupe_key = 'expiry:<bucket>:<YYYY-MM-DD>'` — same pattern as `'low_stock:<sku>:<date>'` in Phase 1 | Phase 1 `check_low_stock` trigger pattern |
| Q-Phase2-I | Auto-depletion when lot current_qty hits zero | Trigger sets `status='depleted'` — eliminates need for manual Admin cleanup | This spec §5.4 |
| Q-Phase2-J | No DELETE on stock_lots; use status instead | Lots are an audit record; Admin sets `status='recalled'` / `'depleted'` for removal | This spec §5.1 RLS |
| Q-Phase2-K | `v_lots_with_remaining` is a plain view (not materialized) | Volume: one view per lot picker request; lots table will be small (tens to low hundreds of rows at Thegood's scale) | This spec §5.3 |

---

## 13. Requirement → Acceptance Test Coverage Self-Check

Per the **verify before done** project rule. Every PDF Phase 2 requirement must map to at least one acceptance test.

| PDF requirement (Phase 2 portion) | Tests |
|---|---|
| §5 Medication — lot number + expiry_date on receive | T48, T50, T51 |
| §5 Medication — lot uniqueness per item | T52 |
| §5 Medication — items without lots unaffected | T49 |
| §5 Medication — lot qty tracked separately from location qty | T53, T54 |
| §5 Medication — FEFO lot picker on issue | T53, T55 |
| §5 Medication — no lot available blocks issue | T56 |
| §6 Expiry — lots auto-set to expired when past date | T58, T60 |
| §6 Expiry — expired lots not available for issue | T59 (view excludes them); T70 (recall blocks directly) |
| §6 Expiry — 30/60/90-day Telegram alerts | T61, T62, T63, T64 |
| §6 Expiry — alert dedupe (no duplicate per bucket per day) | T62 |
| §6 Expiry — alert respects NOTIFY_TELEGRAM_ENABLED=false | T65 |
| §5 RBAC — only Admin can create/recall lots | T69, T70 |
| §5 RBAC — Staff can issue with lot picker (issue movement allowed) | T53 |
| §5 DB-level guard — expired/recalled lot cannot be issued | T58 (post-expire, attempt issue → blocked by trigger per Q-Phase2-4 Option A) |
| §5 Admin UI — lot list with colour expiry banding | T66 |
| §5 Admin UI — mark recalled | T67 |
| §5 Admin UI — no recall on depleted | T68 |

**Self-check result:** All Phase 2 requirements extracted from PDF §5 and §6 have at least one corresponding acceptance test. No requirement-without-test gap found.

---

## 14. Effort Estimate

Phase 2 is smaller in surface area than Phase 1 (no new scan page; extends existing flows).

| Workstream | Estimate |
|---|---|
| Migrations (6 files: stock_lots + FK + view + triggers + cron + seed) | 0.5 day |
| Admin UI: "ล็อตยา" sub-view + lot receive form extension | 0.75 day |
| Staff/Admin scan flow: lot picker step + `shared/lots.js` | 0.5 day |
| Cron smoke-test + expiry alert end-to-end verification | 0.25 day |
| Test pass T45–T70 | 0.5 day |
| Buffer for PM review feedback + pg_cron setup on Dashboard | 0.25 day |
| **Total** | **~2.75 days** |

Risk factors:

- `pg_cron` enablement on Supabase Free/Nano plan — must be enabled via Dashboard Extensions page; if not available on free tier, fallback is a Scheduled Edge Function invoked by an external cron service (adds ~0.5 day).
- First real use of `SECURITY DEFINER` for lot qty trigger: if the function owner changes (schema owner rotation), trigger may lose permissions. Mitigation: document the deployment sequence in the plan.
- PM decisions on Q-Phase2-1 through Q-Phase2-4 may alter trigger DDL (especially Q-Phase2-4 option A vs B); budget ~0.25 day per non-recommended decision.

---

## 15. Next Step

When PM approves this DRAFT:

1. **Answer the four open questions** in §11 (or accept recommendations).
2. **Hand off to `superpowers:writing-plans`** to produce `docs/superpowers/plans/2026-05-18-phase2-medication-plan.md`.
3. **Pre-condition:** Phase 1 must be deployed and T24–T44 verified before Phase 2 implementation starts. In particular, `stock_items.tracks_lots`, `stock_categories`, and `stock_movements.lot_id` must exist in the production DB.
4. **Execute the plan**; verify T45–T70 pass; tag `phase2-medication`.

**Hand-off note:** The next agent after PM approval of this spec is the **backend-developer** (for migrations 20260520000000 through 20260520000500 and trigger DDL), followed by the **frontend-developer / ui-ux-designer** (for the "ล็อตยา" sub-view and scan flow lot-picker step). Both agents need:
- This spec (§5 for all DDL with verification SQL, §7 for UI requirements).
- Phase 1 triggers migration at `supabase/migrations/20260518010500_stock_triggers.sql` as the pattern for SECURITY DEFINER trigger functions reading from `settings` table.
- `shared/lots.js` (new file) is the recommended home for the `fetchAvailableLots(itemId)` helper so both admin and staff scan share it.
