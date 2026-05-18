# DRAFT — Phase 4 ALS Bags / Medical Kits: Restock Workflow + Granular Per-Bag Expiry

**Project:** Thegood Stock Management System
**Phase:** 4 (ALS Bags / Medical Kits — bag templates, restock workflow, per-bag expiry rollup)
**Date:** 2026-05-19
**Author:** Business/System Analyst
**Status:** **DRAFT — pending PM review.** Do not implement until Phase 3 (Borrow/Return) is deployed and verified. Six open questions in §11 need PM decisions before plan write-up.
**Predecessors:**
- `docs/superpowers/specs/2026-05-18-phase0-foundation-design.md` (Phase 0 — LIVE: locations.type='bag' enum)
- `docs/superpowers/specs/2026-05-18-phase1-inventory-design.md` (Phase 1 — stock_items, stock_item_locations, stock_movements)
- `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` (Phase 2 — stock_lots, FEFO, expiry cron)
- `docs/superpowers/specs/2026-05-19-phase3-decisions-locked.md` (Phase 3 — shared/photo-capture.js contract)

---

## 1. Purpose & Scope

### Core design principle: bags ARE locations — not a new entity

**ALS bags are locations** (Phase 0 `locations.type = 'bag'` enum value already exists). Phase 4 does NOT create a parallel `als_bags` table. Every ALS bag is a row in `locations` with `type = 'bag'` and a unique `code` (e.g., `BAG-ALS-001`) that matches the QR sticker printed on the physical bag.

Bag contents are tracked through the same `stock_item_locations` (qty per item per bag-location) and `stock_lots` (Phase 2, for items where `tracks_lots = true`, e.g., adrenaline ampoules) that Phase 1 and Phase 2 already use. No new stock-tracking mechanism is introduced.

Phase 4 adds:
- **Two new tables:** `bag_templates` and `bag_template_items` — the expected composition of a bag type.
- **One ALTER:** `locations.bag_template_id` — links a bag-location to its template.
- **One new view:** `v_bag_status` — aggregates per-bag status from existing `stock_item_locations` and `stock_lots`.
- **One new cron job:** `bag_status_alert` — daily Telegram alert for bags with issues.
- **Admin UI tab:** "ALS Bags" — new top-level tab in `admin.html`.
- **Staff scan flow:** scan bag QR → restock checklist.

### In scope (Phase 4)

- `bag_templates` table: defines the expected contents of a bag type (e.g., "ALS Adult Resus Kit").
- `bag_template_items` table: per-template expected sub-items with `target_qty` and `mandatory` flag.
- `ALTER TABLE locations ADD COLUMN bag_template_id` linking a bag-location to its template.
- `v_bag_status` view: aggregates per-bag-location — completion %, nearest expiry, alert level (`complete` / `low_stock` / `expiring` / `expired`).
- Admin UI: new top-level tab "ALS Bags" — list of bag-locations, status badges, restock action button.
- Restock workflow: scan bag QR → compare `stock_item_locations.qty` vs `bag_template_items.target_qty` → deficits list → confirm restock → creates N `stock_movements` (type `receive`) in one transaction.
- Staff scan: scan bag QR → see restock checklist with expired/low items highlighted.
- Daily cron `bag_status_alert` at 09:00 BKK: find bags where status IN (`low_stock`, `expiring`, `expired`) → grouped Telegram alert per bag.
- `ALS_KIT` seed row in `stock_categories` for items that are bag-sub-items.
- Acceptance tests T126–T150.

### Out of scope (Phase 4 — deferred or explicit exclusion)

| Item | Rationale |
|---|---|
| `als_bags` parallel table | **Explicitly excluded.** Bags ARE locations. See §1 core principle. |
| New movement types | **Explicitly excluded.** Reuse `receive` / `issue` / `adjustment_loss`. |
| Parallel stock tracking | **Explicitly excluded.** Reuse `stock_item_locations` + `stock_lots`. |
| Bag swap (swap entire bag contents between two bag-locations) | Out of scope pending PM Q-Phase4-E decision. |
| Bag overdue inspection (when was bag last fully verified) | Out of scope pending PM Q-Phase4-F decision. |
| Multi-photo per restock | Phase 3.1 pattern; Phase 4 follows Phase 3's advisory-photo model. |
| Template version history (v1 vs v2 of a kit composition) | Deferred; template CRUD via Admin UI handles evolution. |
| Inter-bag transfer of sub-items | Recorded as one `issue` from source bag + one `receive` to destination bag. No atomic transfer shortcut in Phase 4. |
| Linen / laundry integration (Phase 6) | Separate phase. |
| Oxygen tank integration (Phase 5) | Oxygen is per-serial model; does not use `bag_template_items`. |

---

## 2. Architecture Overview

Phase 4 is purely additive on Phase 0–3. No Phase 0–3 tables are structurally changed except for the single `ALTER TABLE locations ADD COLUMN bag_template_id`.

```
Browser (mobile-first)
GitHub Pages: officethegood.github.io/thegood-stock

Admin (admin.html)
  ├─ [Phase 0] Dashboard / Locations / Ambulances / Settings / Sessions
  ├─ [Phase 1] Inventory tab
  ├─ [Phase 3] อุปกรณ์ยืม-คืน tab
  └─ [Phase 4 NEW] "ALS Bags" top-level tab
      ├─ Bag list (from v_bag_status) + status badges
      ├─ Bag detail panel (template composition + item-by-item qty vs target)
      └─ Restock action (bulk stock_movements INSERT)

Staff (staff-scan.html, extended)
  └─ [Phase 4 NEW] Scan bag QR → restock checklist

                    │
    ┌───────────────┴──────────────────────────────────┐
    │ Supabase REST/RPC (Phase 0 plumbing)              │
    └───────────────┬──────────────────────────────────┘
                    │
    ┌───────────────┴──────────────────────────────────┐
    │ Postgres (thegood-stock)                          │
    │                                                   │
    │  ── Phase 0 (unchanged):                          │
    │     locations (EDIT: +bag_template_id column)     │
    │     settings, notification_log, user_sessions     │
    │                                                   │
    │  ── Phase 1 (unchanged):                          │
    │     stock_items, stock_item_locations             │
    │     stock_movements (movement_type 'receive' used)│
    │     stock_categories (ALS_KIT seed added)         │
    │                                                   │
    │  ── Phase 2 (unchanged):                          │
    │     stock_lots (used for lot-tracked bag items)   │
    │     v_lots_with_remaining                         │
    │                                                   │
    │  ── Phase 4 NEW:                                  │
    │     bag_templates                                 │
    │     bag_template_items                            │
    │     view v_bag_status                             │
    │     pg_cron job: bag_status_alert (daily 09:00)   │
    └───────────────┬──────────────────────────────────┘
                    │
    ┌───────────────┴──────────────────────────────────┐
    │ Edge Functions (Phase 0, reused unchanged)        │
    │  └─ tg-notify: new event_type='bag_alert'        │
    │     called from pg_cron via pg_net                │
    └───────────────────────────────────────────────────┘
```

### Key Phase 4 principles

| Principle | How it shows up |
|---|---|
| **Bags are locations** | Every bag-QR lookup is a `WHERE locations.code = $qr AND type = 'bag'`. No new entity needed. |
| **Templates define expectations, not constraints** | `bag_template_items.target_qty` is a target, not an enforced minimum. The system flags deficits; it does not block movements. |
| **Restock = N stock_movements** | One bulk restock action creates one `stock_movements` row per deficit item (type `receive`). Savepoint-per-item ensures partial success is recorded (not rolled back wholesale) — PM decision Q-Phase4-B. |
| **Expiry rollup per bag, not per item** | `v_bag_status.nearest_expiry` is the minimum `expiry_date` across all active lots in that bag. One alert per bag reduces Telegram noise. |
| **Settings table, never current_setting()** | All cron functions MUST read `NOTIFY_SUPABASE_URL` + `NOTIFY_SERVICE_ROLE_KEY` from `settings` table. Follows Project.md §8 gotcha 9. |
| **Reuse shared/photo-capture.js** | Phase 3 introduced this component (Phase 3 decision Q-Phase3-C). Phase 4 reuse is cross-phase coordination. |

---

## 3. Sync Strategy (adds rows 33–37 to the cumulative table)

| # | Data | Type | Mechanism | Cadence | Phase |
|---|---|---|---|---|---|
| 1–5 | Phase 0 | — | — | — | 0 |
| 6–17 | Phase 1 | — | — | — | 1 |
| 18–22 | Phase 2 | — | — | — | 2 |
| 23–32 | Phase 3 | — | — | — | 3 |
| 33 | **Bag template CRUD** | Request-Response | Supabase REST INSERT/UPDATE on `bag_templates` + `bag_template_items` | per Admin action | **4** |
| 34 | **Bag status view** | Request-Response | SELECT `v_bag_status` (all bags for admin list); SELECT single row by location_id for detail | per page load / manual refresh | **4** |
| 35 | **Restock bulk movement** | Request-Response (idempotent per item) | Client sends N `stock_movements` INSERTs (one per deficit item); each has its own `client_ref_id`; Phase 1 trigger applies to `stock_item_locations` | per restock action | **4** |
| 36 | **Bag status alert (cron)** | Autosync (cron) | `pg_cron` job `bag_status_alert` daily 02:00 UTC (09:00 BKK); queries `v_bag_status` WHERE status IN ('low_stock','expiring','expired'); posts grouped tg-notify; reads URL/key from settings | 1x/day | **4** |
| 37 | **Nearest expiry per bag** | Embedded in view | `v_bag_status` computes `MIN(stock_lots.expiry_date)` per bag-location across all active lots at that location | on SELECT | **4** |

---

## 4. Repository Structure (new files only)

Phase 0–3 layouts are unchanged. Phase 4 adds:

```
thegood-stock/
│
├── js/
│   ├── als-bags.js                                       (NEW — admin ALS Bags tab init + bag list)
│   ├── als-bags-detail.js                                (NEW — bag detail panel: template vs actual + restock UI)
│   └── admin-shell.js                                    (EDIT — register new "ALS Bags" tab)
│
├── shared/
│   ├── bags.js                                           (NEW — bag status helpers, v_bag_status query wrapper)
│   └── photo-capture.js                                  (Phase 3 — reused unchanged; advisory photo on restock)
│
├── staff-scan.html                                       (EDIT — add bag-QR scan path)
├── js/staff-scan.js                                      (EDIT — add bag checklist step when scanned code is type='bag')
│
├── supabase/
│   └── migrations/
│       ├── 20260519040000_bag_templates.sql              (NEW — bag_templates + bag_template_items tables)
│       ├── 20260519040100_bag_template_rls.sql           (NEW — RLS for both new tables)
│       ├── 20260519040200_locations_bag_template_fk.sql  (NEW — ALTER TABLE locations ADD COLUMN bag_template_id)
│       ├── 20260519040300_v_bag_status.sql               (NEW — view v_bag_status)
│       ├── 20260519040400_bag_status_cron.sql            (NEW — pg_cron job bag_status_alert)
│       └── 20260519040500_als_kit_category.sql           (NEW — INSERT 'ALS_KIT' into stock_categories)
│
├── sw.js                                                 (EDIT — add new JS files to STATIC_ASSETS; bump CACHE_VERSION)
│
└── docs/
    ├── superpowers/specs/2026-05-19-phase4-als-bags-design.md    (this file)
    └── superpowers/plans/2026-05-19-phase4-als-bags-plan.md      (NEXT step — not yet written)
```

**Migration timestamp namespace:** `20260519040000–20260519040999` (Phase 4 reserved range).

---

## 5. Data Model

### 5.1 `bag_templates` table (`20260519040000_bag_templates.sql`)

A template defines the expected composition of a bag type. It is a master reference, not per-physical-bag. Multiple bag-locations can reference the same template (e.g., all four ambulances carry the same "ALS Adult Resus Kit" template).

Templates are hand-managed via Admin UI (see PM open question Q-Phase4-A for migration seed vs UI-only trade-off). No seed rows are in the migration; Admin creates templates via the UI.

```sql
-- ── bag_templates ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bag_templates (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text  UNIQUE NOT NULL,           -- e.g. 'TPL-ALS-ADULT', 'TPL-TRAUMA-01'
  name        text  NOT NULL,                  -- human name, Thai OK
  category    text  NOT NULL DEFAULT 'ALS',    -- free text category tag (e.g. ALS, Trauma, Pediatric)
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT app_username(),
  updated_by  text
);

COMMENT ON TABLE bag_templates IS
  'Phase 4. Defines the expected contents of a bag type. One template can be shared by many bag-locations.';
COMMENT ON COLUMN bag_templates.code IS
  'Unique short code for this template. Example: TPL-ALS-ADULT. Printed on admin UI; not on physical bag (that uses locations.code).';

CREATE TRIGGER trg_bag_templates_updated_at BEFORE UPDATE ON bag_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── bag_template_items ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bag_template_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_template_id  uuid NOT NULL REFERENCES bag_templates(id) ON DELETE CASCADE,
  item_id          uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  target_qty       int  NOT NULL CHECK (target_qty > 0),
  mandatory        boolean NOT NULL DEFAULT true,  -- if false, item is "nice to have" but doesn't affect bag status
  sort_order       int  NOT NULL DEFAULT 0,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bag_template_id, item_id)                -- one row per (template, item) pair
);

COMMENT ON TABLE bag_template_items IS
  'Phase 4. Expected sub-items per template. target_qty is a target, not a hard constraint — the system flags deficits but does not block movements.';
COMMENT ON COLUMN bag_template_items.mandatory IS
  'If true, a shortfall makes the bag status low_stock. If false, shortfall is informational only.';

CREATE INDEX IF NOT EXISTS idx_bti_template ON bag_template_items(bag_template_id);
CREATE INDEX IF NOT EXISTS idx_bti_item     ON bag_template_items(item_id);

-- ── Verification SQL ──────────────────────────────────────────────────────
-- 1) Tables exist:
--    SELECT tablename FROM pg_tables
--    WHERE schemaname='public' AND tablename IN ('bag_templates','bag_template_items');
--    -- expected: 2 rows
--
-- 2) UNIQUE constraints:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='bag_templates'::regclass AND contype='u';
--    -- expected: bag_templates_code_key
--
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='bag_template_items'::regclass AND contype='u';
--    -- expected: bag_template_items_bag_template_id_item_id_key
--
-- 3) ON DELETE CASCADE on bag_template_items:
--    SELECT confdeltype FROM pg_constraint
--    WHERE conname='bag_template_items_bag_template_id_fkey';
--    -- expected: 'c' (CASCADE)
```

### 5.2 `ALTER TABLE locations ADD COLUMN bag_template_id` (`20260519040200_locations_bag_template_fk.sql`)

```sql
-- Add bag_template_id to locations. Nullable; only bag-type locations will have it set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='locations' AND column_name='bag_template_id'
  ) THEN
    ALTER TABLE locations
      ADD COLUMN bag_template_id uuid REFERENCES bag_templates(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN locations.bag_template_id IS
  'Phase 4. FK to bag_templates. Non-null only for locations.type=''bag''. Admin assigns template when creating or editing a bag-location.';

CREATE INDEX IF NOT EXISTS idx_locations_bag_template ON locations(bag_template_id)
  WHERE bag_template_id IS NOT NULL;

-- ── Verification SQL ──────────────────────────────────────────────────────
-- 1) Column exists on locations:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_name='locations' AND column_name='bag_template_id';
--    -- expected: 1 row, data_type='uuid', is_nullable='YES'
--
-- 2) FK exists:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='locations'::regclass AND contype='f'
--    AND conname='locations_bag_template_id_fkey';
--    -- expected: 1 row
--
-- 3) Existing Phase 0 bag-locations have bag_template_id IS NULL (safe):
--    SELECT count(*) FROM locations WHERE type='bag' AND bag_template_id IS NULL;
--    -- expected: count of currently-existing bag-locations (no data loss)
```

### 5.3 `v_bag_status` view (`20260519040300_v_bag_status.sql`)

This view aggregates per-bag-location: total items present vs template target, nearest expiry, and a computed alert level. It is the primary data source for the Admin ALS Bags tab and the daily cron.

**Alert level logic (computed column `alert_level`):**
- `'expired'` — any active lot at this bag-location has `expiry_date < CURRENT_DATE` (should have been set to `expired` by Phase 2 cron, but defensive check included)
- `'expiring'` — any active lot has `(expiry_date - CURRENT_DATE) <= 30`
- `'low_stock'` — any mandatory bag_template_item has `COALESCE(sil.qty, 0) < bti.target_qty`
- `'complete'` — all mandatory items meet target AND no expiring/expired lots

Priority: `expired` > `expiring` > `low_stock` > `complete`.

```sql
CREATE OR REPLACE VIEW v_bag_status AS
WITH

-- Step 1: All bag-locations with their templates
bag_locs AS (
  SELECT
    l.id          AS location_id,
    l.code        AS bag_code,
    l.name        AS bag_name,
    l.bag_template_id,
    bt.code       AS template_code,
    bt.name       AS template_name,
    l.active      AS bag_active
  FROM locations l
  LEFT JOIN bag_templates bt ON bt.id = l.bag_template_id
  WHERE l.type = 'bag'
),

-- Step 2: Per-bag — mandatory item deficit count
deficit AS (
  SELECT
    bl.location_id,
    COUNT(*) FILTER (
      WHERE bti.mandatory = true
        AND COALESCE(sil.qty, 0) < bti.target_qty
    ) AS mandatory_deficit_count,
    COUNT(*) FILTER (WHERE bti.mandatory = true) AS mandatory_total,
    SUM(bti.target_qty) FILTER (WHERE bti.mandatory = true) AS total_target_mandatory,
    SUM(COALESCE(sil.qty, 0)) FILTER (WHERE bti.mandatory = true) AS total_actual_mandatory
  FROM bag_locs bl
  LEFT JOIN bag_template_items bti ON bti.bag_template_id = bl.bag_template_id
  LEFT JOIN stock_item_locations sil
    ON sil.item_id = bl.location_id  -- intentional: note this joins item_id, corrected below
    -- CORRECTION: sil links item to bag-location:
  -- Rewritten with correct join:
  FROM bag_locs bl
  LEFT JOIN bag_template_items bti ON bti.bag_template_id = bl.bag_template_id
  LEFT JOIN stock_item_locations sil
    ON sil.location_id = bl.location_id AND sil.item_id = bti.item_id
  GROUP BY bl.location_id
),

-- Step 3: Per-bag — nearest expiry from active lots
bag_expiry AS (
  SELECT
    sil.location_id,
    MIN(sl.expiry_date) AS nearest_expiry,
    COUNT(*) FILTER (
      WHERE sl.expiry_date < CURRENT_DATE AND sl.status = 'active'
    ) AS expired_lots_count,
    COUNT(*) FILTER (
      WHERE (sl.expiry_date - CURRENT_DATE) <= 30
        AND sl.expiry_date >= CURRENT_DATE
        AND sl.status = 'active'
    ) AS expiring_30d_count
  FROM stock_item_locations sil
  JOIN locations l ON l.id = sil.location_id AND l.type = 'bag'
  LEFT JOIN stock_lots sl
    ON sl.item_id = sil.item_id
    AND sl.status IN ('active', 'expired')  -- include expired for alert; exclude recalled/depleted
  GROUP BY sil.location_id
)

SELECT
  bl.location_id,
  bl.bag_code,
  bl.bag_name,
  bl.bag_template_id,
  bl.template_code,
  bl.template_name,
  bl.bag_active,
  -- Completion percentage (based on mandatory items)
  CASE
    WHEN COALESCE(d.mandatory_total, 0) = 0 THEN NULL  -- no template assigned
    ELSE ROUND(
      100.0 * COALESCE(d.total_actual_mandatory, 0)
           / NULLIF(d.total_target_mandatory, 0)
    )
  END AS completion_pct,
  COALESCE(d.mandatory_deficit_count, 0) AS mandatory_deficit_count,
  COALESCE(d.mandatory_total, 0)         AS mandatory_total,
  be.nearest_expiry,
  COALESCE(be.expired_lots_count, 0)     AS expired_lots_count,
  COALESCE(be.expiring_30d_count, 0)     AS expiring_30d_count,
  -- Alert level (priority: expired > expiring > low_stock > complete > no_template)
  CASE
    WHEN bl.bag_template_id IS NULL                  THEN 'no_template'
    WHEN COALESCE(be.expired_lots_count, 0) > 0      THEN 'expired'
    WHEN COALESCE(be.expiring_30d_count, 0) > 0      THEN 'expiring'
    WHEN COALESCE(d.mandatory_deficit_count, 0) > 0  THEN 'low_stock'
    ELSE                                                   'complete'
  END AS alert_level
FROM bag_locs bl
LEFT JOIN deficit   d  ON d.location_id  = bl.location_id
LEFT JOIN bag_expiry be ON be.location_id = bl.location_id;

COMMENT ON VIEW v_bag_status IS
  'Phase 4. Per-bag-location aggregated status. alert_level: complete | low_stock | expiring | expired | no_template. Source for Admin ALS Bags tab and daily bag_status_alert cron.';

-- ── Verification SQL ──────────────────────────────────────────────────────
-- 1) View compiles without error:
--    SELECT * FROM v_bag_status LIMIT 1;
--    -- expected: 0 or more rows, no error
--
-- 2) Alert level values:
--    SELECT DISTINCT alert_level FROM v_bag_status;
--    -- expected: subset of {complete, low_stock, expiring, expired, no_template}
--
-- 3) No bag-type location is missing:
--    SELECT count(*) FROM locations WHERE type='bag';
--    SELECT count(*) FROM v_bag_status;
--    -- expected: counts match (every bag-location has exactly one v_bag_status row)
```

**Note on the deficit CTE:** The view above uses a clean two-step CTE. The DDL in the migration file should be tested in the SQL Editor before saving. The verification SQL in step 3 is the acceptance check.

### 5.4 Daily cron: `bag_status_alert` (`20260519040400_bag_status_cron.sql`)

Mirrors the Phase 2 `run_expiry_alert()` pattern exactly. MUST read `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from `settings` table (Project.md §8 gotcha 9 — never `current_setting()`).

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── Cron function ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION run_bag_status_alert()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
DECLARE
  v_url     text;
  v_srk     text;
  v_msg     text;
  v_dedupe  text;
  v_bags    jsonb;
  v_today   date := CURRENT_DATE;
  r         RECORD;
BEGIN
  -- Step 1: Read settings from table (MUST NOT use current_setting — Project.md §8 gotcha 9).
  SELECT value INTO v_url FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';

  IF v_url IS NULL OR v_url = '' OR v_srk IS NULL OR v_srk = '' THEN
    RAISE WARNING 'run_bag_status_alert: NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set in settings; skipping.';
    RETURN;
  END IF;

  -- Step 2: Collect bags with issues.
  SELECT jsonb_agg(
    jsonb_build_object(
      'bag_code',         vbs.bag_code,
      'bag_name',         vbs.bag_name,
      'alert_level',      vbs.alert_level,
      'completion_pct',   vbs.completion_pct,
      'deficit_count',    vbs.mandatory_deficit_count,
      'nearest_expiry',   vbs.nearest_expiry,
      'expired_lots',     vbs.expired_lots_count,
      'expiring_30d',     vbs.expiring_30d_count
    )
    ORDER BY
      CASE vbs.alert_level
        WHEN 'expired'   THEN 1
        WHEN 'expiring'  THEN 2
        WHEN 'low_stock' THEN 3
        ELSE 4
      END,
      vbs.bag_code
  )
  INTO v_bags
  FROM v_bag_status vbs
  WHERE vbs.alert_level IN ('low_stock', 'expiring', 'expired')
    AND vbs.bag_active = true;

  -- Step 3: Skip if no issues.
  IF v_bags IS NULL OR jsonb_array_length(v_bags) = 0 THEN
    RETURN;
  END IF;

  -- Step 4: Build Thai-language summary message.
  v_msg := format(
    '🩺 สถานะถุงยา / ชุดปฐมพยาบาล — %s — มี %s ถุงที่ต้องตรวจสอบ',
    to_char(v_today AT TIME ZONE 'Asia/Bangkok', 'DD Mon YYYY'),
    jsonb_array_length(v_bags)
  );

  v_dedupe := 'bag_alert:' || to_char(v_today, 'YYYY-MM-DD');

  -- Step 5: Post to tg-notify via pg_net.
  PERFORM net.http_post(
    url     := v_url || '/functions/v1/tg-notify',
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'apikey',        v_srk,
      'authorization', 'Bearer ' || v_srk,
      'X-Internal',    'true'
    ),
    body    := jsonb_build_object(
      'event_type',  'bag_alert',
      'entity_type', 'bag_location',
      'entity_id',   null,
      'dedupe_key',  v_dedupe,
      'message',     v_msg,
      'payload',     jsonb_build_object(
        'run_date', v_today,
        'bags',     v_bags
      )
    )
  );
END;
$$;

COMMENT ON FUNCTION run_bag_status_alert() IS
  'Phase 4. Daily cron (02:00 UTC = 09:00 BKK). Queries v_bag_status for bags with alert_level IN (low_stock, expiring, expired) and posts one grouped Telegram alert. Reads NOTIFY_SUPABASE_URL/NOTIFY_SERVICE_ROLE_KEY from settings table per Project.md §8 gotcha 9.';

-- ── Schedule (02:00 UTC = 09:00 Asia/Bangkok UTC+7) ───────────────────────
-- Run in SQL Editor AFTER function is created.
-- Unschedule first if re-running: SELECT cron.unschedule('bag_status_alert');
SELECT cron.schedule(
  'bag_status_alert',
  '0 2 * * *',
  $$SELECT run_bag_status_alert()$$
);

-- ── Verification SQL ──────────────────────────────────────────────────────
-- 1) pg_cron enabled:
--    SELECT extname FROM pg_extension WHERE extname='pg_cron';
--    -- expected: 1 row
--
-- 2) Cron job scheduled:
--    SELECT jobname, schedule, command FROM cron.job WHERE jobname='bag_status_alert';
--    -- expected: 1 row, schedule='0 2 * * *'
--
-- 3) Manual smoke run:
--    SELECT run_bag_status_alert();
--    -- expected: no exception; if bags with issues exist AND NOTIFY settings are populated,
--    --           a notification_log row with event_type='bag_alert' is inserted.
--
-- 4) Dedupe check:
--    SELECT run_bag_status_alert(); SELECT run_bag_status_alert();
--    -- second call: tg-notify returns dedupe_hit=true; only 1 Telegram message sent.
```

### 5.5 `ALS_KIT` category seed (`20260519040500_als_kit_category.sql`)

```sql
INSERT INTO stock_categories(code, name, sort_order)
VALUES ('ALS_KIT', 'อุปกรณ์ถุงยา / ชุดปฐมพยาบาล', 25)
ON CONFLICT (code) DO NOTHING;

-- ── Verification SQL ──────────────────────────────────────────────────────
-- SELECT code, name FROM stock_categories WHERE code = 'ALS_KIT';
-- expected: 1 row
```

### 5.6 RLS (`20260519040100_bag_template_rls.sql`)

```sql
ALTER TABLE bag_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bag_template_items ENABLE ROW LEVEL SECURITY;

-- bag_templates: read all authenticated; write Admin only
CREATE POLICY bt_read  ON bag_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY bt_write ON bag_templates FOR ALL    TO authenticated
  USING  (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- bag_template_items: read all authenticated; write Admin only
CREATE POLICY bti_read  ON bag_template_items FOR SELECT TO authenticated USING (true);
CREATE POLICY bti_write ON bag_template_items FOR ALL    TO authenticated
  USING  (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- ── Verification SQL ──────────────────────────────────────────────────────
-- SELECT tablename, relrowsecurity::text
-- FROM pg_tables pt JOIN pg_class pc ON pc.relname=pt.tablename
-- WHERE schemaname='public'
--   AND tablename IN ('bag_templates','bag_template_items');
-- expected: both rows show relrowsecurity='t'

-- Policies exist:
-- SELECT policyname, cmd, roles FROM pg_policies
-- WHERE tablename IN ('bag_templates','bag_template_items')
-- ORDER BY tablename, policyname;
-- expected: 4 policies total (bt_read, bt_write, bti_read, bti_write)
```

---

## 6. Edge Functions

**None new.** Phase 4 deliberately adds no new Edge Functions:

- All writes (template CRUD, restock movements) go through Supabase REST with RLS.
- The Telegram notification path uses the existing `tg-notify` function via `pg_net` from the cron job — same transport as Phase 1 `check_low_stock` and Phase 2 `run_expiry_alert`.
- The restock workflow is N individual `stock_movements` INSERTs from the browser. No server-side orchestration is needed because `client_ref_id` on each movement provides idempotency (Phase 1 pattern).

If the PM decides the bulk restock should be a single atomic server-side transaction (PM decision Q-Phase4-B bulk-with-savepoint option), a lightweight RPC function (`bag_restock_bulk`) could wrap the N inserts. Estimated effort: +0.25 day. This is flagged in §11 Q-Phase4-B.

---

## 7. UI Spec

### 7.1 Admin: new top-level tab "ALS Bags"

Registered in `js/admin-shell.js` tab list after the Phase 3 "อุปกรณ์ยืม-คืน" tab. Lazy-loaded via `js/als-bags.js`.

**File changes:** `js/admin-shell.js` (EDIT — register tab), `js/als-bags.js` (NEW), `js/als-bags-detail.js` (NEW).

#### 7.1.1 Bag list panel

- Source: SELECT from `v_bag_status` WHERE `bag_active = true`.
- Table columns: รหัสถุง (bag_code) | ชื่อ (bag_name) | เทมเพลต (template_name) | สถานะ (alert_level badge) | ความสมบูรณ์ (completion_pct %) | วันหมดอายุใกล้สุด (nearest_expiry) | จัดการ
- Alert level badge colours:
  - `complete` → green badge "สมบูรณ์"
  - `low_stock` → amber badge "ของไม่ครบ"
  - `expiring` → orange badge "ใกล้หมดอายุ"
  - `expired` → red badge "หมดอายุ"
  - `no_template` → grey badge "ไม่มีเทมเพลต"
- Filter bar: alert_level filter (all / issues only), template filter, text search on bag_code/bag_name.
- Row click → opens bag detail panel (§7.1.2).
- Top-right button: **"+ เพิ่มถุงยา"** — opens the standard Locations create modal pre-filled with `type=bag`. Template picker field added to that modal when `type=bag` is selected.
- Bottom: **"จัดการเทมเพลต"** button → opens template management panel (§7.1.3).

#### 7.1.2 Bag detail panel (side drawer or full-width sub-panel)

Displays for the selected bag-location:
- Header: bag_code + bag_name + alert_level badge + last_restock_at (TBD — see Q-Phase4-F).
- **Template composition table**: columns — ชื่อสินค้า | SKU | เป้าหมาย | ปัจจุบัน | ผล
  - "ผล" = green check if `actual >= target`, red "ขาด X" if below, grey dash if `mandatory=false`.
  - Source: JOIN `bag_template_items` → `stock_items` → `stock_item_locations WHERE location_id = <bag>`.
- **Lots in this bag** (expandable section — only for items where `tracks_lots=true`):
  - Columns: ชื่อยา | ล็อตนัมเบอร์ | วันหมดอายุ | คงเหลือ | สถานะ
  - Source: JOIN `stock_lots` via `stock_movements` WHERE `location_id = <bag>`.
  - Colour banding mirrors Phase 2 §7.1.1.
- **"เติมของ (Restock)"** button — active when `alert_level IN ('low_stock','expiring','expired','no_template')` or always (Admin discretion). Opens restock flow (§7.1.4).

#### 7.1.3 Template management panel

Sub-panel accessible from "จัดการเทมเพลต" button.
- Template list: code | name | category | item count | actions (Edit / Deactivate).
- Create/Edit modal:
  - Template code (text, uppercase enforced), name (Thai), category (text), description.
  - Sub-item editor: item picker (autocomplete on `stock_items.name`/`sku`) + target_qty (int) + mandatory toggle + sort_order.
  - Save → INSERT `bag_templates` + N INSERT `bag_template_items` (Admin RLS enforced).
- **No seed data in migration** — Admin creates templates via this UI (see PM decision Q-Phase4-A).

#### 7.1.4 Restock flow (admin)

Triggered by "เติมของ (Restock)" button in bag detail panel.

1. **Shopping list step**: shows all `bag_template_items` ordered by sort_order. For each mandatory item with deficit, pre-fills `restock_qty = target_qty - current_qty`. Admin can adjust qty per item. Lot-tracked items: a lot picker appears per item (FEFO, reuses Phase 2 `shared/lots.js` `fetchAvailableLots(itemId)`).
2. **Photo step (advisory)**: optional photo of restocked bag. Reuses `shared/photo-capture.js` from Phase 3. Skip button always visible.
3. **Confirm step**: summary of changes. "ยืนยันการเติมของ" button.
4. **Submit**: for each item with `restock_qty > 0`, INSERT `stock_movements` with:
   - `movement_type = 'receive'`
   - `location_id = <bag location>`
   - `qty_delta = <restock_qty>` (positive)
   - `lot_id = <selected lot>` if `tracks_lots = true`
   - `client_ref_id = crypto.randomUUID()` (per movement, idempotency)
   - `reason = 'bag_restock'`
   - `note = 'bag:' || <bag_code> || ' restock ' || <ISO date>`
5. On success: toast "เติมของเสร็จสิ้น — X รายการ" and refresh bag detail panel.
6. On partial failure (one item fails): continue others; report failures at end with "X รายการล้มเหลว" and list which items.

**Assumption A-1:** Restock is implemented as N sequential REST INSERTs from the browser, not a server-side RPC. Each INSERT has its own `client_ref_id`. If PM chooses bulk-with-savepoint (Q-Phase4-B option B), a new RPC `bag_restock_bulk(p_items jsonb)` wraps the inserts.

### 7.2 Staff scan flow extension: bag QR path

**File changes:** `staff-scan.html` (EDIT), `js/staff-scan.js` (EDIT — detect bag-type location).

When a staff member scans a QR code and it resolves to `locations.type = 'bag'`:

1. **Bag detected mode**: scan flow switches from the standard issue/receive flow to the "bag checklist" view.
2. **Bag checklist view**:
   - Bag name + code + alert_level badge at top.
   - Template composition list: each item row shows `actual_qty / target_qty`. Shortfalls highlighted in red. Expired/expiring lots shown with warning icon.
   - Read-only for Staff (no restock action from this view — restock is Admin-only, consistent with receive movement type being Admin-only per Phase 1 §8 RBAC).
   - "รายงานปัญหา" button: lets Staff submit a note / flag the bag for Admin attention. Writes a `stock_movements` row with `movement_type = 'adjustment_loss'`, `qty_delta = 0` (note-only), or — **TBD per Q-Phase4-B** — a separate `bag_inspection_notes` table. Simplest Phase 4 implementation: Staff can only view, not act.
3. "กลับ" button returns to scan mode.

**Open assumption (A-2):** Phase 4 bag checklist for Staff is **read-only** (view only). Restock is Admin-initiated. If PM wants Staff to trigger a restock request, that is Phase 4.1 scope.

### 7.3 Localization

All new UI strings in Thai. No i18n framework. Follows Phase 0–3 pattern.

---

## 8. RLS Policies

Full Phase 4 RLS is in `20260519040100_bag_template_rls.sql` (§5.6). Summary of Phase 4 role matrix:

| Table / View | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `bag_templates` | authenticated (all) | Admin | Admin | Admin |
| `bag_template_items` | authenticated (all) | Admin | Admin | Admin |
| `locations` (existing) | authenticated (all) | Admin | Admin | Admin |
| `v_bag_status` (view) | authenticated (view inherits from base tables) | — | — | — |

**Interaction with existing policies:**
- `stock_item_locations`: Phase 1 trigger-only write pattern unchanged. Restock `stock_movements` INSERTs go through Phase 1's `sm_insert_admin` policy (Admin-only for `receive` type).
- `stock_lots`: Phase 2 policies unchanged. When a restock involves lot-tracked items, Admin inserts both `stock_lots` (if new lot) and `stock_movements` with `lot_id`.
- Staff cannot initiate restock (Phase 1 RLS blocks `movement_type='receive'` for Staff role). The bag checklist in staff scan is read-only.

---

## 9. Acceptance Tests (T126–T150, continuing from Phase 3)

**T126–T125 range is reserved for Phase 3 (Phase 3 spec should number T71–T125).** Phase 4 begins at T126.

### Template setup (T126–T130)

**T126** Admin opens ALS Bags tab. "ไม่มีถุงยาที่กำหนด" empty state shown (no bag-locations yet). Button "จัดการเทมเพลต" is visible.
- Expected: tab loads without error; `SELECT count(*) FROM bag_templates` = 0.

**T127** Admin creates template: code="TPL-ALS-ADULT", name="ALS ผู้ใหญ่", category="ALS". Adds items: (1) SKU "MED-EPI-1MG", target_qty=5, mandatory=true; (2) SKU "SUP-AIRWAY-OPA", target_qty=3, mandatory=true; (3) SKU "SUP-GAUZE-001", target_qty=10, mandatory=false. Saves.
- Expected: `bag_templates` row inserted; 3 `bag_template_items` rows inserted. `SELECT count(*) FROM bag_template_items WHERE bag_template_id = '<new id>'` = 3.

**T128** Admin attempts to create a second template with code="TPL-ALS-ADULT" (duplicate code). Save fails.
- Expected: 409 unique constraint `bag_templates_code_key`; UI shows inline error "รหัสเทมเพลตนี้มีอยู่แล้ว".

**T129** Employee (staff) attempts to INSERT `bag_templates` directly via DevTools.
- Expected: RLS `bt_write` policy rejects; 403 response.

**T130** Employee attempts to INSERT `bag_template_items` directly via DevTools.
- Expected: RLS `bti_write` policy rejects; 403 response.

### Bag-location setup (T131–T133)

**T131** Admin opens Locations tab, creates a new location: type=bag, code="BAG-ALS-001", name="ถุง ALS รถ TG1", bag_template_id=<TPL-ALS-ADULT id>. Saves.
- Expected: `locations` row with `type='bag'`, `bag_template_id` populated. `SELECT bag_template_id FROM locations WHERE code='BAG-ALS-001'` returns the template ID.

**T132** Admin opens ALS Bags tab after T131. "BAG-ALS-001" appears in bag list. Alert level = `low_stock` (no items stocked yet → all mandatory items at qty 0 < target). Completion % = 0%.
- Expected: `v_bag_status` row for BAG-ALS-001 has `alert_level='low_stock'`, `mandatory_deficit_count=2` (the 2 mandatory items).

**T133** Admin creates a second bag "BAG-ALS-002" with no `bag_template_id`. Appears in list with alert_level = `no_template`.
- Expected: `SELECT alert_level FROM v_bag_status WHERE bag_code='BAG-ALS-002'` = `'no_template'`.

### Restock workflow (T134–T139)

**T134** Admin opens BAG-ALS-001 detail panel. Shopping list shows 2 mandatory deficits: MED-EPI-1MG (0/5) and SUP-AIRWAY-OPA (0/3). SUP-GAUZE-001 shows informational (0/10 but non-mandatory).
- Expected: `mandatory_deficit_count=2`; detail panel renders all 3 items with correct target/actual.

**T135** Admin completes restock for BAG-ALS-001: sets MED-EPI-1MG restock_qty=5, SUP-AIRWAY-OPA restock_qty=3, SUP-GAUZE-001 restock_qty=10. Skips photo. Confirms.
- Expected: 3 `stock_movements` rows with `movement_type='receive'`, `location_id=<BAG-ALS-001>`, `reason='bag_restock'`. `stock_item_locations` rows updated: MED-EPI-1MG qty=5, SUP-AIRWAY-OPA qty=3, SUP-GAUZE-001 qty=10 at BAG-ALS-001.

**T136** After T135, ALS Bags tab shows BAG-ALS-001 with alert_level = `complete`, completion_pct = 100%.
- Expected: `SELECT alert_level, completion_pct FROM v_bag_status WHERE bag_code='BAG-ALS-001'` = (`'complete'`, 100).

**T137** Admin replays the same restock submit (network retry: same `client_ref_id` values). Each INSERT returns 409 (unique constraint on `client_ref_id`). Client treats as already-posted.
- Expected: `stock_item_locations` qty unchanged; no duplicate movement rows; toast "รายการนี้บันทึกแล้ว" (or equivalent success-already-posted message).

**T138** Admin restocks MED-EPI-1MG with a lot: item has `tracks_lots=true`. Lot picker appears in shopping list step (FEFO, reuses Phase 2 `v_lots_with_remaining`). Admin selects a lot, enters qty. Confirms.
- Expected: `stock_movements` row has `lot_id` populated. `stock_lots.current_qty` decremented by issued qty or incremented per direction.

**T139** Employee attempts to post `stock_movements` with `movement_type='receive'` for a bag location via DevTools.
- Expected: Phase 1 RLS policy `sm_insert_admin` blocks (only Admin can receive); 403 response.

### Bag status view correctness (T140–T143)

**T140** Issue 3 units of MED-EPI-1MG from BAG-ALS-001 (reducing qty from 5 to 2, below target 5). Admin refreshes ALS Bags tab.
- Expected: BAG-ALS-001 `alert_level` changes to `'low_stock'`; `mandatory_deficit_count=1`; `completion_pct < 100`.

**T141** Insert a test `stock_lots` row for an item in BAG-ALS-001 with `expiry_date = CURRENT_DATE + 25`. Query `v_bag_status`.
- Expected: `alert_level='expiring'` (expiring takes priority over low_stock? Check priority: expired > expiring > low_stock). If MED-EPI-1MG is also below target, alert_level should still be `'expiring'` (higher priority). Verify: `SELECT alert_level FROM v_bag_status WHERE bag_code='BAG-ALS-001'` = `'expiring'`.

**T142** Set the test lot's `expiry_date = CURRENT_DATE - 1` (already expired, status still 'active' to simulate missed cron). Query `v_bag_status`.
- Expected: `alert_level='expired'` (expired takes top priority). `expired_lots_count = 1`.

**T143** Run Phase 2 cron `SELECT run_expiry_alert()` to auto-expire the test lot. Re-query `v_bag_status`. Lot is now `status='expired'`; if no other issues, `alert_level` may revert to `'low_stock'` or `'complete'` depending on qty.
- Expected: `stock_lots.status='expired'` for the test lot; `v_bag_status` reflects updated state.

### Cron and Telegram alert (T144–T147)

**T144** With BAG-ALS-001 in `low_stock` state (after T140), run `SELECT run_bag_status_alert()` manually. NOTIFY settings configured.
- Expected: `notification_log` row with `event_type='bag_alert'`, `dedupe_key='bag_alert:<YYYY-MM-DD>'`. Telegram group receives message mentioning BAG-ALS-001.

**T145** Run `SELECT run_bag_status_alert()` a second time on the same day.
- Expected: `tg-notify` returns `{dedupe_hit: true}`; no second Telegram message. `notification_log` shows deduplication.

**T146** Set all bags to `alert_level='complete'`. Run `SELECT run_bag_status_alert()`.
- Expected: function returns without posting to Telegram (Step 3 skip check: `v_bags IS NULL`). No new `notification_log` row.

**T147** With `NOTIFY_TELEGRAM_ENABLED=false` in settings, run `SELECT run_bag_status_alert()`.
- Expected: `tg-notify` returns `{sent:false, reason:'disabled'}`; `notification_log` row with success=false (same behavior as T65 in Phase 2).

### Staff scan bag path (T148–T149)

**T148** Employee opens `staff-scan.html`, scans "BAG-ALS-001" QR. Bag checklist view appears (not the standard issue flow). Shows template composition with qty vs target. Expired/expiring items highlighted.
- Expected: checklist rendered; no restock action visible (Staff is read-only for bag restock per §7.2 A-2).

**T149** Employee on bag checklist view has no "เติมของ" button. Verifies read-only state.
- Expected: restock button absent from Staff view; no paths to `movement_type='receive'` from Staff bag scan.

### ALS_KIT category (T150)

**T150** After Phase 4 migration runs, `stock_categories` contains "ALS_KIT".
- Expected: `SELECT code FROM stock_categories WHERE code='ALS_KIT'` → 1 row. Admin can assign ALS_KIT category to bag sub-items via item edit form.

---

## 10. Out of Scope

| Item | Phase / Notes |
|---|---|
| `als_bags` parallel table | **Explicitly excluded.** Bags ARE locations (Phase 0 `type='bag'`). |
| New movement types for bag events | **Explicitly excluded.** Reuse `receive` / `issue` / `adjustment_loss`. |
| Duplicate stock-tracking mechanism | **Explicitly excluded.** Reuse `stock_item_locations` + `stock_lots`. |
| Bag swap (swap contents between two bag-locations) | Pending PM decision Q-Phase4-E. Deferred unless PM approves. |
| Bag overdue inspection / last-verified timestamp | Pending PM decision Q-Phase4-F. Deferred unless PM approves. |
| Template version history | Admin edits template in-place via CRUD. Version history deferred. |
| Staff-initiated restock request | Phase 4.1. Phase 4 staff scan is read-only (checklist only). |
| Multi-photo per restock | Phase 3.1 pattern. Phase 4 has optional single photo (advisory). |
| Atomic server-side restock transaction (RPC) | Optional per PM Q-Phase4-B decision. Default is N client-side INSERTs. |
| Oxygen tanks in bag compositions | Phase 5 introduces oxygen serial model; does not fit bag_template_items qty model. |
| Linen / laundry in bags | Not applicable to ALS bag context. |
| Per-item expiry alert threshold (less than 30d) | Phase 2 `EXPIRY_ALERT_DAYS` governs. Phase 4 uses the same setting. |

---

## 11. Open Questions (for PM "Pex" — answer before plan write-up)

Six questions require PM decision. Recommendations included with options.

---

### Q-Phase4-A — Template seeding: Admin UI vs migration seed data

**Question:** Should the initial bag templates (e.g., "ALS Adult Resus Kit", "Trauma Kit") be hand-seeded by Admin via the UI, or pre-populated in a migration SQL file?

**Context:** The exact composition of Thegood's ALS bags is not in the PDF and is likely to evolve as protocols change. A migration seed would hard-code the first version.

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| **A — Admin UI only (RECOMMENDED)** | Migration creates empty tables; Admin creates templates via UI before first use | Template evolves without new migrations; Admin owns the data | Admin must do initial data entry before the ALS Bags tab is useful |
| B — Seed in migration | Migration includes INSERT rows for standard ALS templates | Ready out-of-the-box | Any change to template requires a new migration or manual SQL; risk of stale templates |
| C — Hybrid: seed starter + Admin editable | Migration seeds a commented-out example; Admin activates/edits | Guidance without lock-in | Migration noise; same maintenance risk as B |

**Recommendation: A.** Template composition is clinical data that belongs in the Admin UI, not in code. The migration creates the tables; the Admin populates them.

---

### Q-Phase4-B — Restock action: N individual REST INSERTs vs server-side bulk RPC

**Question:** Should the restock action POST N individual `stock_movements` from the browser, or should it call a single RPC function (`bag_restock_bulk`) that runs all inserts in one server-side transaction?

**Context:** Phase 4 bag restock involves 3–15 items per bag. If one item INSERT fails mid-restock, the browser-side approach leaves a partial restock (some items received, some not).

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| **A — N individual client-side INSERTs (RECOMMENDED)** | Browser posts each `stock_movements` row separately; each has its own `client_ref_id`; partial success is recorded | Simpler; no new Edge Function or RPC; idempotent per item via `client_ref_id`; UI reports which items succeeded and which failed | Partial restock possible; UI must handle mixed success/failure display |
| B — Bulk RPC with savepoint per item | New PL/pgSQL function `bag_restock_bulk(p_items jsonb)` wraps N inserts; `SAVEPOINT` per item so failure of one item does not roll back others; returns per-item result | Server-side atomicity per item; single HTTP call from browser | New RPC adds ~0.25 day; more complex PL/pgSQL; SAVEPOINT-in-function is non-trivial in Postgres |
| C — Full atomic transaction | Single RPC wraps all N inserts; all-or-nothing | True atomicity | Any single item failure rolls back all; worse UX for partial restocks |

**Recommendation: A.** At Thegood's scale (3–15 items per bag, low concurrency), individual INSERTs with `client_ref_id` idempotency are sufficient. The UI should handle partial failure gracefully (continue remaining items, report failures at end).

---

### Q-Phase4-C — Bag expiry rollup: nearest expiry per bag vs per-sub-item alerts

**Question:** Should the Telegram alert report the nearest expiry across all lots in the bag (one line per bag), or should it enumerate every expiring lot per bag (multiple lines per bag)?

**Context:** An ALS bag may contain 5–10 lot-tracked items with different expiry dates. Per-item enumeration provides more detail but increases Telegram message length.

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| **A — Nearest expiry per bag, one line per bag (RECOMMENDED)** | `v_bag_status.nearest_expiry` is the single date. Telegram message: "BAG-ALS-001 — nearest expiry 2026-06-15 (5 lots)" | Low Telegram noise; daily summary is scannable | Admin must open the app to see which specific lot is expiring |
| B — Per-sub-item enumeration | Telegram message lists each expiring lot: "BAG-ALS-001 > MED-EPI-1MG (LOT-2026-A expires 2026-06-15 — 27 days)" | All detail in the message | Long message if many lots are expiring; Telegram truncates at 4096 chars |
| C — Summary line + detail in payload | Same as A but the `payload` JSON in `notification_log` includes the full per-lot list (for a future drill-down UI) | Best of both | No immediate UI to view the payload; the detail is hidden |

**Recommendation: A** for Phase 4. The summary per bag is actionable: Admin opens the ALS Bags tab, clicks the bag, and sees the full lot table with expiry colour banding. Phase 4.1 can add payload detail (Option C) if Thegood requests it.

---

### Q-Phase4-D — Photo on restock: required, advisory, or none?

**Question:** Should taking a photo of the restocked bag be required, advisory (skip allowed), or omitted entirely?

**Context:** Phase 3 decision Q-Phase3-C established **advisory photo** as the project standard for safety-critical actions. The same trade-off applies here (one-handed operation, dim ambulance storeroom).

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| A — Required photo | Restock submit blocked if no photo | Full audit trail per restock | Friction in storeroom; mirrors Phase 3 risk: skip button UX was why Q-Phase3-C chose advisory |
| **B — Advisory photo (RECOMMENDED)** | Skip button always visible; `photo_restock_url` nullable on `stock_movements.note` or a separate column; restock succeeds with null | Consistent with Phase 3 Q-Phase3-C pattern; low friction | No visual evidence if admin skips |
| C — No photo | Photo step omitted entirely | Simplest | No audit trail for disputed restocks |

**Recommendation: B.** Consistent with Phase 3 Q-Phase3-C. Reuses `shared/photo-capture.js` from Phase 3 unchanged. If PM wants to track advisory-skip rate, Phase 4.1 can add an `Audit dashboard` (mirroring Phase 3.1 scope).

**Assumption A-3:** Advisory photo means `stock_movements.note` stores the Cloudinary URL when provided, or null when skipped. No new column needed in Phase 4 (note field is free text and already exists on `stock_movements`).

---

### Q-Phase4-E — Bag swap action in scope?

**Question:** Should Phase 4 include a "Bag Swap" action — transferring the entire contents of one bag-location to another bag-location?

**Context:** A real scenario: BAG-ALS-001 goes out for washing/repair; its contents are transferred to BAG-ALS-TMP. Phase 4 without a swap requires Admin to manually issue from one bag and receive into another.

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| **A — Out of scope, manual issue+receive (RECOMMENDED)** | Admin issues all items from source bag (N movements), then restocks destination bag | No new UI; same pattern as any inter-location transfer | Extra manual steps for a full bag swap |
| B — In scope: bulk swap UI | New UI action "สลับถุง" → pick source + destination → system generates N `issue` from source + N `receive` to destination | Single UX action | Complex; N*2 movements; edge cases with lot-tracked items; adds ~0.5 day |

**Recommendation: A.** Defer bag swap to Phase 4.1. The manual issue+receive path works and adds no special-case code.

---

### Q-Phase4-F — Bag overdue inspection tracking in scope?

**Question:** Should Phase 4 track "when was this bag last verified" — i.e., record a timestamp each time an Admin or Staff performs a bag verification (even if no restock was needed)?

**Context:** In EMS protocols, ALS bags are checked on a schedule (e.g., every shift, every week). A "last verified" timestamp helps compliance tracking.

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| A — In scope: `last_inspected_at` column on `locations` | `ALTER TABLE locations ADD COLUMN last_inspected_at timestamptz`; updated on each restock or inspection event | EMS-compliance visibility | Adds another ALTER to `locations`; "inspection without restock" needs a new movement_type or a separate `bag_inspections` table |
| **B — Out of scope (RECOMMENDED)** | Phase 4 records restocks only (the `stock_movements` ledger shows restock history). Last restock can be inferred as `MAX(performed_at)` from `stock_movements WHERE location_id = <bag> AND reason='bag_restock'`. | No new columns; restock history IS inspection history in most cases | No "verified-but-no-change" record; if Admin just looks and confirms bag is OK, that's not captured |
| C — Lightweight: `last_inspected_at` on `locations` + "Mark Inspected" button (no restock) | Admin clicks "ตรวจสอบแล้ว" button → UPDATE `locations.last_inspected_at`; no stock_movements row | Low overhead | Another ALTER TABLE; adds the concept of a non-movement event |

**Recommendation: B** for Phase 4. Restock history serves as the inspection record. Phase 4.1 can add explicit inspection tracking (Option C) if EMS compliance requires it.

---

## 12. Decisions Log

IDs use `Q-Phase4-X` to avoid collision with Phase 0 (Q1–Q18), Phase 1 (Q-Phase1-A through Q-Phase1-P), Phase 2 (Q-Phase2-A through Q-Phase2-K), Phase 3 (Q-Phase3-A through Q-Phase3-G).

| ID | Question | Decision | Source |
|---|---|---|---|
| Q-Phase4-A | Bags are locations, not a new entity | **Confirmed: bags ARE locations.** Phase 0 `locations.type='bag'` is the bag identity. No `als_bags` table. | Phase 0 spec + this spec §1 |
| Q-Phase4-B | New movement types for bag events | **None.** Reuse `receive` / `issue` / `adjustment_loss`. | This spec §1 out-of-scope |
| Q-Phase4-C | Stock tracking duplication | **None.** Reuse `stock_item_locations` + `stock_lots`. | This spec §1 out-of-scope |
| Q-Phase4-D | Trigger reads settings from settings table | **Confirmed.** `run_bag_status_alert()` reads `NOTIFY_SUPABASE_URL` / `NOTIFY_SERVICE_ROLE_KEY` from `settings` table. Never `current_setting()`. | Project.md §8 gotcha 9 + Phase 2 pattern |
| Q-Phase4-E | Template management | **Admin UI only** (recommend Option A — pending PM on Q-Phase4-A open question) | This spec §11 Q-Phase4-A |
| Q-Phase4-F | Restock transaction model | **N individual client-side INSERTs** with `client_ref_id` idempotency (recommend Option A — pending PM on Q-Phase4-B) | This spec §11 Q-Phase4-B |
| Q-Phase4-G | Expiry rollup granularity | **Nearest expiry per bag** (recommend Option A — pending PM on Q-Phase4-C) | This spec §11 Q-Phase4-C |
| Q-Phase4-H | Photo on restock | **Advisory** — reuses Phase 3 `shared/photo-capture.js`; skip button always visible (recommend Option B — pending PM on Q-Phase4-D) | Phase 3 Q-Phase3-C + this spec §11 Q-Phase4-D |
| Q-Phase4-I | Bag swap | **Out of scope** (recommend Option A — pending PM on Q-Phase4-E) | This spec §11 Q-Phase4-E |
| Q-Phase4-J | Bag inspection tracking | **Out of scope** for Phase 4 (recommend Option B — pending PM on Q-Phase4-F) | This spec §11 Q-Phase4-F |
| Q-Phase4-K | Cron schedule | **02:00 UTC (09:00 Asia/Bangkok)** — same as Phase 2 `expiry_alert` | Phase 2 spec §12 Q-Phase2-G |

---

## 13. Requirement → Acceptance Test Coverage Self-Check

Per the **verify before done** project rule. Every Phase 4 requirement extracted from Project.md §2 and the brief must map to at least one acceptance test.

| Requirement | Tests |
|---|---|
| Bag identified by `bag_code` (QR sticker) | T131, T148 |
| Bag IS a location (`locations.type='bag'`) | T131, T132 |
| `bag_templates` table: create, unique code | T127, T128 |
| `bag_template_items`: per-template items with target_qty + mandatory | T127, T134 |
| `locations.bag_template_id` FK column | T131, T133 |
| `v_bag_status` — aggregates completion %, nearest expiry, alert_level | T132, T133, T136, T140, T141, T142 |
| Alert level priority: expired > expiring > low_stock > complete | T141, T142 |
| Admin ALS Bags tab — bag list with status badges | T126, T132, T136 |
| Admin bag detail panel — template vs actual comparison | T134, T135 |
| Restock workflow — shopping list, lot picker for tracked items | T135, T138 |
| Restock idempotency via `client_ref_id` | T137 |
| Admin-only restock (Staff blocked) | T139 |
| `bag_status_alert` cron — posts Telegram when bags have issues | T144, T145 |
| Cron deduplication per day | T145 |
| Cron skips when no bags with issues | T146 |
| Cron respects `NOTIFY_TELEGRAM_ENABLED=false` | T147 |
| Staff scan bag QR → read-only checklist | T148, T149 |
| RLS: read all authenticated, write Admin only | T129, T130, T139 |
| `ALS_KIT` category seed | T150 |
| Bags without templates show `no_template` alert level | T133 |

**Self-check result:** All Phase 4 requirements have at least one acceptance test. No requirement-without-test gap found.

---

## 14. Effort Estimate

Phase 4 is moderate in scope: two new tables, one view, one cron job, one ALTER, and a new Admin tab with a moderately complex restock UI.

| Workstream | Estimate |
|---|---|
| Migrations (6 files: tables + RLS + ALTER + view + cron + seed) | 0.5 day |
| Admin ALS Bags tab: bag list + bag detail + restock flow UI | 1.0 day |
| Template management panel (CRUD in Admin) | 0.5 day |
| Staff scan bag QR path + checklist view | 0.25 day |
| Cron smoke-test + Telegram end-to-end verification | 0.25 day |
| Test pass T126–T150 | 0.5 day |
| Buffer for PM review feedback + lot-picker integration (Phase 2 reuse) | 0.25 day |
| **Total** | **~3.25 days** |

Risk factors:
- `v_bag_status` CTE complexity — the deficit calculation with nullable `bag_template_id` and LEFT JOINs needs careful testing in SQL Editor before finalizing the migration DDL (~0.25 day risk).
- Phase 2 `shared/lots.js` `fetchAvailableLots(itemId)` reuse in restock shopping list — verify the function is parameterized for standalone use outside the staff scan flow (~0.1 day).
- PM decisions on Q-Phase4-A through Q-Phase4-F: each non-recommended choice may alter scope; budget 0.25 day per deviation.

---

## 15. Next Step

When PM approves this DRAFT:

1. **Answer the six open questions** in §11 (or accept all recommendations).
2. **Hand off to `superpowers:writing-plans`** to produce `docs/superpowers/plans/2026-05-19-phase4-als-bags-plan.md`.
3. **Pre-conditions** before Phase 4 implementation:
   - Phase 1 deployed and T24–T44 verified (`stock_item_locations`, `stock_movements` with `client_ref_id`).
   - Phase 2 deployed and T45–T70 verified (`stock_lots`, `v_lots_with_remaining`, `shared/lots.js`).
   - Phase 3 deployed and verified (`shared/photo-capture.js` contract per Q-Phase3-C advisory pattern).
4. **Execute the plan**; verify T126–T150 pass; tag `phase4-als-bags`.

**Hand-off note:** The next agent after PM approval is the **backend-developer** (migrations 20260519040000–20260519040500 and the `v_bag_status` view DDL, which needs careful CTE validation in SQL Editor). After the DB layer is verified, hand to **frontend-developer / ui-ux-designer** for the ALS Bags admin tab, bag detail panel, restock flow, and staff scan bag path. Both agents need:
- This spec §5 for all DDL with verification SQL.
- §7 for full UI requirements.
- `supabase/migrations/20260518000200_locations.sql` — the `locations` table schema (specifically `type='bag'` enum value and the base columns being extended in §5.2).
- Phase 2 spec §5.3 (`v_lots_with_remaining`) and `shared/lots.js` — the FEFO lot picker reused in bag restock.
- Phase 3 decisions (`docs/superpowers/specs/2026-05-19-phase3-decisions-locked.md`) — `shared/photo-capture.js` contract for advisory photo on restock (Q-Phase3-C).
