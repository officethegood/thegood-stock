# Phase 6 — Linens & Laundry Design

**Project:** Thegood Stock Management System
**Phase:** 6 (Linens & Laundry — count-based, photo-verified, cabinet-level)
**Date:** 2026-05-19
**Author:** Business/System Analyst
**Status:** DRAFT — pending PM review. Six open questions in §11 need PM decisions before plan write-up.
**Predecessor:** `docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md` (Phase 5)
**Source PDF:** `ระบบจัดการสต๊อกและอุปกรณ์การแพทย์.pdf` §6 (Linens & Laundry)

---

## 1. Purpose & Scope

### 1.1 Core architectural principle

**Linens are stock_items. Cabinets are locations. No parallel entity tables.**

This is not a simplification — it is the correct model. The Phase 1 inventory system was explicitly designed to accommodate Phase 6. The `stock_items` table holds every item whose identity is a SKU + quantity (not a serial number). Linen items (ผ้าปูที่นอน, ผ้าห่ม, ผ้าขนหนู, เสื้อกาวน์, ผ้าเช็ดเครื่องมือ) are exactly that: SKU-based, quantity-tracked.

Cabinets are Phase 0 locations with `type='cabinet'`. The `locations` table and its hierarchy (room → cabinet → shelf) already exist and are in production. No new entity is needed.

What Phase 6 adds:
1. A new category code `LINEN` seeded into `stock_categories`
2. A new table `linen_counts` — periodic count snapshots per (cabinet, linen item), with photo evidence
3. Two new movement reasons (`laundry_out`, `laundry_in`) on top of existing `adjustment_loss` / `adjustment_gain` movement types — **no new movement_type enum value needed**
4. A `pg_cron` job that runs the daily audit (compare most recent `linen_counts` row with `stock_item_locations.qty`, flag discrepancies via Telegram)
5. A staff scan flow: scan cabinet QR → list linen items → "นับใหม่" button → photo + count input
6. Admin UI extension: existing Inventory tab gains a "ผ้า" sub-filter (no new tab)

### 1.2 In scope (Phase 6)

- `LINEN` category seed in `stock_categories`
- Linen item seed data (5 standard linen types, one per subcategory) as examples — Admin can add more
- `linen_subcategory` column on `stock_items` (enum: `sheet` / `blanket` / `towel` / `gown` / `wipe`)
- New table `linen_counts` with RLS
- View `v_linen_audit` — most recent count per (location, item) vs current `stock_item_locations.qty`
- Staff workflow: **ส่งซัก (send to laundry)** — movement_type=`adjustment_loss`, reason=`laundry_out`, photo required
- Staff workflow: **รับคืน (receive from laundry)** — movement_type=`adjustment_gain`, reason=`laundry_in`, photo required
- Staff workflow: **นับผ้า (periodic count)** — inserts row into `linen_counts` with photo; does NOT update qty directly (count is a snapshot, not a movement)
- Daily cron at 06:00 BKK (configurable) — reads `v_linen_audit`, posts Telegram alert for each discrepancy where delta exceeds threshold (5% or min 2 pieces, whichever is larger)
- Admin Inventory tab: "ผ้า" filter (category=LINEN) → shows linen items with last-count date, last-count qty, current qty, and discrepancy indicator
- Acceptance tests T151–T170
- Migration timestamp namespace: 20260519060000–20260519060999

### 1.3 Out of scope (explicitly deferred)

- Per-piece laundry tag / QR on individual linen item (Phase 6.1) — would require a `linen_pieces` serial-tracking table analogous to Phase 5 `oxygen_tanks`
- External laundry vendor SLA / turnaround tracking — not in PDF §6
- Automated ส่งซัก pairing with รับคืน (expect-return-within-N-days alert) — listed as PM open question Q6-E; deferred pending PM decision
- Linen condition grading (good / worn / damaged) — not in PDF §6; would require an additional column on `linen_counts` and a separate workflow
- Multiple photos per movement/count — Phase 6.1 (same as Phase 3.1 pattern)
- Multi-cabinet bulk count in single session — Phase 6.1
- Staff-side CRUD for linen items (add/edit/deactivate) — Admin only per existing RBAC
- Subcategory filter on staff scan page — staff sees all LINEN items in the cabinet; filter is admin-only for now

---

## 2. Architecture

Phase 6 is purely additive. No Phase 0–5 surface changes.

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (mobile-first)                                             │
│  GitHub Pages: officethegood.github.io/thegood-stock                │
│                                                                     │
│  Admin (admin.html — Inventory tab, "ผ้า" filter)                   │
│   ├─ Linen item list (category=LINEN)                               │
│   │    Columns: ชื่อ | หมวดย่อย | ตู้ | คงเหลือ | นับล่าสุด | ต่างจาก │
│   ├─ Receive/Adjust form (laundry_in reason pre-filled for LINEN)   │
│   └─ Movement history for LINEN items                               │
│                                                                     │
│  Staff (staff-scan.html — extended with linen flows)                │
│   ├─ Scan cabinet QR → list linen items for that cabinet            │
│   ├─ "ส่งซัก" button → photo capture → qty → submit movement        │
│   ├─ "รับคืน" button → photo capture → qty → submit movement        │
│   └─ "นับใหม่" button → photo capture → count → submit linen_count  │
└────────────────────────────────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          │ Supabase REST/RPC           │
          └──────────────┬──────────────┘
                         │
          ┌──────────────┴──────────────────────────────────────────┐
          │ Postgres (thegood-stock)                                  │
          │  ── Phase 0–5 tables (unchanged)                         │
          │  ── Phase 6 CHANGES:                                     │
          │     stock_categories: +1 seed row (LINEN)                │
          │     stock_items: +linen_subcategory column               │
          │  ── Phase 6 NEW table:                                   │
          │     linen_counts                                         │
          │  ── Phase 6 NEW view:                                    │
          │     v_linen_audit                                        │
          │  ── Phase 6 NEW trigger:                                 │
          │     trg_linen_count_insert — validates cabinet type      │
          │  ── Phase 6 NEW cron:                                    │
          │     linen_daily_audit — 06:00 Asia/Bangkok               │
          └──────────────────────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          │ Edge Functions (all Phase 0) │
          │  ── tg-notify reused for     │
          │     event_type='linen_audit' │
          └──────────────────────────────┘
```

### Key Phase 6 reuse points

| Component | Source | How reused |
|---|---|---|
| `locations` with `type='cabinet'` | Phase 0 | Cabinets ARE the per-cabinet linen tracking unit. No new entity. |
| `stock_items` | Phase 1 | Linen items ARE stock_items. Just a different category. |
| `stock_item_locations` | Phase 1 | Cabinet-level qty for each linen item — same table, same trigger. |
| `stock_movements` | Phase 1 | ส่งซัก = `adjustment_loss` reason=`laundry_out`; รับคืน = `adjustment_gain` reason=`laundry_in`. |
| `movement_type` enum | Phase 1 | No alteration needed. `adjustment_loss` / `adjustment_gain` already exist. |
| `tg-notify` Edge Function | Phase 0 | Linen audit cron fires HTTP POST same as low-stock trigger. |
| `notification_log` + dedupe | Phase 0 | Dedupe key: `linen_audit:{location_code}:{item_sku}:{date}`. |
| `settings` table | Phase 0 | Cron trigger reads `NOTIFY_SUPABASE_URL`, `NOTIFY_SERVICE_ROLE_KEY`. New setting keys added for audit cadence and thresholds. |
| `shared/photo-capture.js` | Phase 3 | Photo capture component reused as-is. Both ส่งซัก and รับคืน use it. |
| `app_username()` / `app_user_role()` | Phase 0 | Used in `linen_counts.counted_by` and RLS policies. |

---

## 3. Sync Strategy (extends Phase 5 table, rows 38–42)

| # | Data | Type | Mechanism | Cadence | Phase |
|---|---|---|---|---|---|
| 1–37 | (Phase 0–5 entries) | — | — | — | 0–5 |
| 38 | **ส่งซัก / รับคืน movement** | Request-Response | `INSERT INTO stock_movements` (adjustment_loss/gain + reason) → trigger updates `stock_item_locations.qty` | per tap | **6** |
| 39 | **Linen count snapshot** | Request-Response | `INSERT INTO linen_counts` (no qty change; snapshot only) | per count session | **6** |
| 40 | **Linen audit discrepancy alert** | Autosync (cron) | `pg_cron` job `linen_daily_audit` → queries `v_linen_audit` → for each row where `abs_delta > threshold`, `pg_net` POST to `tg-notify` | 06:00 BKK daily (configurable) | **6** |
| 41 | **Admin linen audit panel refresh** | Request-Response | Admin Inventory tab fetches `v_linen_audit` on tab open (no Realtime — low churn data) | on demand | **6** |
| 42 | **Cabinet QR → linen item list** | Request-Response | Staff scans cabinet code → `SELECT stock_item_locations JOIN stock_items WHERE category=LINEN AND location_id=cabinet_id` | per scan | **6** |

---

## 4. Repository Structure (new files Phase 6 only)

```
thegood-stock/
│
├── shared/
│   └── linen.js                                            (NEW — linen workflow helpers:
│                                                            fetchLinenByCabinet, submitLinenCount,
│                                                            submitLinenMovement; reuses photo-capture.js)
│
├── js/
│   ├── inventory.js                                        (EDIT — add "ผ้า" filter + linen audit columns)
│   └── staff-scan.js                                       (EDIT — add ส่งซัก / รับคืน / นับใหม่ buttons
│                                                            when scanned cabinet has LINEN items)
│
├── supabase/
│   └── migrations/
│       ├── 20260519060000_linen_category.sql               (NEW — LINEN seed + linen_subcategory column)
│       ├── 20260519060100_linen_counts.sql                 (NEW — linen_counts table)
│       ├── 20260519060200_linen_counts_rls.sql             (NEW — RLS policies)
│       ├── 20260519060300_linen_audit_view.sql             (NEW — v_linen_audit view)
│       ├── 20260519060400_linen_audit_trigger.sql          (NEW — cabinet-type validation trigger)
│       ├── 20260519060500_linen_audit_cron.sql             (NEW — pg_cron job + notification function)
│       └── 20260519060600_linen_settings.sql               (NEW — new settings keys)
│
└── docs/
    └── superpowers/specs/2026-05-19-phase6-linens-laundry-design.md  (this file)
```

**No new Edge Functions.** All notification path goes DB trigger/cron → `pg_net` → existing `tg-notify` (same pattern as Phase 1 low-stock and Phase 5 refill alerts).

**No new HTML pages.** Staff linen workflows live inside `staff-scan.html` (existing Phase 1 page extended). Admin view is a filter inside the existing Inventory tab.

---

## 5. Data Model

### 5.1 LINEN category seed + `linen_subcategory` column (`20260519060000_linen_category.sql`)

**Assumption A:** `linen_subcategory` is stored as an enum column on `stock_items` (not free-text) to enable filtering, reporting, and future Phase 6.1 per-piece tracking. PM must confirm (see §11 Q6-D).

```sql
-- 5.1.1  Add LINEN category
INSERT INTO stock_categories(code, name, sort_order)
VALUES ('LINEN', 'ผ้าและสิ่งทอ', 50)
ON CONFLICT (code) DO NOTHING;

-- 5.1.2  Add linen_subcategory enum
CREATE TYPE linen_subcategory AS ENUM (
  'sheet',    -- ผ้าปูที่นอน
  'blanket',  -- ผ้าห่ม
  'towel',    -- ผ้าขนหนู
  'gown',     -- เสื้อกาวน์
  'wipe'      -- ผ้าเช็ดเครื่องมือ
);

-- 5.1.3  Add column to stock_items (nullable; non-LINEN items stay NULL)
ALTER TABLE stock_items
  ADD COLUMN linen_subcategory linen_subcategory;

-- 5.1.4  Constraint: LINEN items must have subcategory; non-LINEN must not
ALTER TABLE stock_items
  ADD CONSTRAINT chk_linen_subcategory CHECK (
    (category_id = (SELECT id FROM stock_categories WHERE code='LINEN')
     AND linen_subcategory IS NOT NULL)
    OR
    (category_id IS DISTINCT FROM (SELECT id FROM stock_categories WHERE code='LINEN')
     AND linen_subcategory IS NULL)
  );

-- 5.1.5  Seed 5 example linen items (Admin will add per-cabinet items for their real inventory)
DO $$
DECLARE v_linen_cat_id uuid;
BEGIN
  SELECT id INTO v_linen_cat_id FROM stock_categories WHERE code='LINEN';
  INSERT INTO stock_items(sku, name, category_id, unit, reorder_threshold, linen_subcategory, note)
  VALUES
    ('LINEN-SHEET-001', 'ผ้าปูที่นอน', v_linen_cat_id, 'ผืน', 0, 'sheet', 'ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-BLANKET-001','ผ้าห่ม',      v_linen_cat_id, 'ผืน', 0, 'blanket','ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-TOWEL-001',  'ผ้าขนหนู',   v_linen_cat_id, 'ผืน', 0, 'towel', 'ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-GOWN-001',   'เสื้อกาวน์', v_linen_cat_id, 'ตัว', 0, 'gown',  'ตัวอย่าง — ปรับแก้ตามจริง'),
    ('LINEN-WIPE-001',   'ผ้าเช็ดเครื่องมือ', v_linen_cat_id, 'ผืน', 0, 'wipe', 'ตัวอย่าง — ปรับแก้ตามจริง')
  ON CONFLICT (sku) DO NOTHING;
END;
$$;

-- 5.1.6  Verification SQL (run after migration)
SELECT code, name FROM stock_categories WHERE code='LINEN';
-- Expected: 1 row

SELECT sku, name, linen_subcategory FROM stock_items
WHERE category_id = (SELECT id FROM stock_categories WHERE code='LINEN');
-- Expected: 5 rows
```

### 5.2 `linen_counts` table (`20260519060100_linen_counts.sql`)

`linen_counts` is a **periodic count snapshot**, not a stock ledger. Inserting a row does not change `stock_item_locations.qty`. The snapshot is compared against the current qty to detect discrepancies.

```sql
CREATE TABLE linen_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  item_id       uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  counted_qty   int NOT NULL CHECK (counted_qty >= 0),
  counted_at    timestamptz NOT NULL DEFAULT now(),
  counted_by    text NOT NULL DEFAULT app_username(),
  photo_url     text,        -- Cloudinary URL; advisory on periodic counts (see §11 Q6-B)
  note          text
);

CREATE INDEX idx_lc_location   ON linen_counts(location_id);
CREATE INDEX idx_lc_item       ON linen_counts(item_id);
CREATE INDEX idx_lc_counted_at ON linen_counts(counted_at DESC);
-- Compound index for "most recent per (location, item)" query used by audit view
CREATE INDEX idx_lc_loc_item_at ON linen_counts(location_id, item_id, counted_at DESC);
```

**Verification SQL:**
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='linen_counts'
ORDER BY ordinal_position;
-- Expected: 8 columns
```

### 5.3 `v_linen_audit` view (`20260519060300_linen_audit_view.sql`)

Shows the most recent count per (cabinet, linen item) alongside the current `stock_item_locations.qty`, and computes whether a discrepancy exceeds the configured threshold.

```sql
CREATE OR REPLACE VIEW v_linen_audit AS
WITH latest_counts AS (
  SELECT DISTINCT ON (location_id, item_id)
    location_id,
    item_id,
    counted_qty,
    counted_at,
    counted_by,
    photo_url
  FROM linen_counts
  ORDER BY location_id, item_id, counted_at DESC
),
audit_settings AS (
  SELECT
    COALESCE(
      (SELECT value::numeric FROM settings WHERE key='LINEN_AUDIT_THRESHOLD_PCT'),
      5
    ) AS threshold_pct,
    COALESCE(
      (SELECT value::int FROM settings WHERE key='LINEN_AUDIT_MIN_PIECES'),
      2
    ) AS min_pieces
  FROM (SELECT 1) _
),
combined AS (
  SELECT
    l.id          AS location_id,
    l.code        AS location_code,
    l.name        AS location_name,
    si.id         AS item_id,
    si.sku,
    si.name       AS item_name,
    si.linen_subcategory,
    sil.qty       AS current_qty,
    lc.counted_qty,
    lc.counted_at,
    lc.counted_by,
    lc.photo_url,
    (sil.qty - COALESCE(lc.counted_qty, sil.qty)) AS delta,
    ABS(sil.qty - COALESCE(lc.counted_qty, sil.qty)) AS abs_delta,
    s.threshold_pct,
    s.min_pieces,
    CASE
      WHEN lc.counted_at IS NULL THEN false   -- no count yet; don't flag
      WHEN ABS(sil.qty - lc.counted_qty) >
           GREATEST(
             CEIL(sil.qty * s.threshold_pct / 100.0),
             s.min_pieces
           )
      THEN true
      ELSE false
    END AS is_discrepancy
  FROM locations l
  JOIN stock_item_locations sil ON sil.location_id = l.id
  JOIN stock_items si ON si.id = sil.item_id
  JOIN stock_categories sc ON sc.id = si.category_id AND sc.code = 'LINEN'
  LEFT JOIN latest_counts lc ON lc.location_id = l.id AND lc.item_id = si.id
  CROSS JOIN audit_settings s
  WHERE l.type = 'cabinet'
    AND l.active = true
    AND si.active = true
)
SELECT * FROM combined;
```

**Verification SQL:**
```sql
SELECT count(*) FROM v_linen_audit;
-- Expected: ≥ 0 rows (0 if no LINEN items in cabinets yet)

-- Check view columns are all present:
SELECT column_name FROM information_schema.columns
WHERE table_name='v_linen_audit' AND table_schema='public'
ORDER BY ordinal_position;
```

### 5.4 Cabinet-type validation trigger (`20260519060400_linen_audit_trigger.sql`)

Prevents inserting a `linen_counts` row for a location that is not a cabinet.

```sql
CREATE OR REPLACE FUNCTION validate_linen_count_location() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type location_type;
BEGIN
  SELECT type INTO v_type FROM locations WHERE id = NEW.location_id;
  IF v_type <> 'cabinet' THEN
    RAISE EXCEPTION 'linen_counts สามารถบันทึกได้เฉพาะตู้ (cabinet) เท่านั้น — location_id % ไม่ใช่ cabinet', NEW.location_id;
  END IF;

  -- Validate that item is in LINEN category
  IF NOT EXISTS (
    SELECT 1 FROM stock_items si
    JOIN stock_categories sc ON sc.id = si.category_id
    WHERE si.id = NEW.item_id AND sc.code = 'LINEN'
  ) THEN
    RAISE EXCEPTION 'linen_counts รองรับเฉพาะสินค้าหมวด LINEN — item_id % ไม่ใช่ LINEN', NEW.item_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_linen_count_validate
  BEFORE INSERT ON linen_counts
  FOR EACH ROW EXECUTE FUNCTION validate_linen_count_location();
```

### 5.5 Daily audit cron + notification function (`20260519060500_linen_audit_cron.sql`)

**Assumption B:** `pg_cron` extension is already enabled (required by Phase 2 expiry cron). If Phase 6 deploys before Phase 2, the operator must run `CREATE EXTENSION IF NOT EXISTS pg_cron;` first.

**Design note on trigger reads from settings:** The notification function reads `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from the `settings` table, following the pattern established in Phase 1 (Project.md §8 gotcha 9). Hard-coding these values in PL/pgSQL is explicitly prohibited by project rules. The cron job WARN-and-skips if the keys are empty.

```sql
-- 5.5.1  Linen audit notification function
CREATE OR REPLACE FUNCTION run_linen_audit_alert() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_url     text;
  v_srk     text;
  v_chat    text;
  v_enabled text;
  v_rec     record;
  v_dedupe  text;
  v_msg     text;
  v_payload jsonb;
  v_sent    int := 0;
BEGIN
  -- Read config from settings (required — no hard-coded credentials)
  SELECT value INTO v_url  FROM settings WHERE key='NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk  FROM settings WHERE key='NOTIFY_SERVICE_ROLE_KEY';
  SELECT value INTO v_chat FROM settings WHERE key='NOTIFY_TELEGRAM_CHAT_ID';
  SELECT value INTO v_enabled FROM settings WHERE key='NOTIFY_TELEGRAM_ENABLED';

  IF v_url IS NULL OR v_srk IS NULL THEN
    RAISE WARNING 'linen_audit: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่า — ข้ามการแจ้งเตือน';
    RETURN;
  END IF;

  IF v_enabled IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'linen_audit: การแจ้งเตือน Telegram ถูกปิดอยู่ — ข้าม';
    RETURN;
  END IF;

  -- Iterate over discrepancies in v_linen_audit
  FOR v_rec IN
    SELECT *
    FROM v_linen_audit
    WHERE is_discrepancy = true
  LOOP
    v_dedupe := 'linen_audit:' || v_rec.location_code || ':' || v_rec.sku
                || ':' || to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');

    v_msg := format(
      '⚠️ นับผ้าผิดมากกว่าเกณฑ์: %s ที่ตู้ %s — นับได้ %s ผืน, ระบบบันทึก %s ผืน (ต่างกัน %s)',
      v_rec.item_name, v_rec.location_name,
      v_rec.counted_qty, v_rec.current_qty, v_rec.delta
    );

    v_payload := jsonb_build_object(
      'location_id',  v_rec.location_id,
      'location_code',v_rec.location_code,
      'item_id',      v_rec.item_id,
      'sku',          v_rec.sku,
      'current_qty',  v_rec.current_qty,
      'counted_qty',  v_rec.counted_qty,
      'delta',        v_rec.delta,
      'counted_at',   v_rec.counted_at,
      'counted_by',   v_rec.counted_by
    );

    PERFORM net.http_post(
      url     := v_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'content-type',  'application/json',
        'apikey',        v_srk,
        'authorization', 'Bearer ' || v_srk,
        'X-Internal',    'true'
      ),
      body    := jsonb_build_object(
        'event_type',  'linen_audit',
        'entity_type', 'linen_count',
        'entity_id',   v_rec.location_id::text || ':' || v_rec.item_id::text,
        'dedupe_key',  v_dedupe,
        'message',     v_msg,
        'payload',     v_payload
      )
    );
    v_sent := v_sent + 1;
  END LOOP;

  RAISE NOTICE 'linen_audit: ส่งการแจ้งเตือน % รายการ', v_sent;
END;
$$;

-- 5.5.2  Schedule at 06:00 Asia/Bangkok = 23:00 UTC (previous day)
-- NOTE: pg_cron uses UTC. 06:00 BKK = UTC+7, so 06:00 BKK = 23:00 UTC.
-- If LINEN_AUDIT_CRON_HOUR setting changes the desired hour, this cron must be
-- manually updated via unschedule + reschedule (pg_cron doesn't support dynamic schedules).
SELECT cron.schedule(
  'linen_daily_audit',
  '0 23 * * *',           -- 23:00 UTC = 06:00 Asia/Bangkok
  $$ SELECT run_linen_audit_alert(); $$
);

-- 5.5.3  Verification SQL
SELECT jobname, schedule, command
FROM cron.job
WHERE jobname = 'linen_daily_audit';
-- Expected: 1 row with schedule '0 23 * * *'
```

### 5.6 New settings keys (`20260519060600_linen_settings.sql`)

```sql
INSERT INTO settings(key, value) VALUES
  ('LINEN_AUDIT_THRESHOLD_PCT', '5'),     -- % discrepancy threshold
  ('LINEN_AUDIT_MIN_PIECES',    '2'),     -- minimum absolute piece tolerance
  ('LINEN_AUDIT_CRON_HOUR',     '6')      -- desired BKK hour (documentation only;
                                           -- actual cron schedule is UTC hard-coded above;
                                           -- admin must update cron manually if this changes)
ON CONFLICT (key) DO NOTHING;

-- Verification SQL
SELECT key, value FROM settings
WHERE key LIKE 'LINEN_%'
ORDER BY key;
-- Expected: 3 rows
```

---

## 6. Edge Functions

**None new.** All Phase 6 notification paths reuse the existing `tg-notify` Edge Function from Phase 0. The linen audit cron posts HTTP requests via `pg_net` with `event_type='linen_audit'`, which `tg-notify` handles generically (it does not inspect `event_type` content, only routes to Telegram and records in `notification_log`).

The `ส่งซัก` and `รับคืน` workflows are plain `INSERT INTO stock_movements` via Supabase REST, protected by existing RLS. The existing trigger chain (`trg_sm_apply` → updates `stock_item_locations.qty`) handles these movements without any new Edge Function or trigger.

The `นับผ้า` workflow is a plain `INSERT INTO linen_counts` via Supabase REST. No trigger fires a notification on insert — discrepancies surface only via the scheduled cron (not on every count insert).

---

## 7. UI Spec

### 7.1 Admin — Inventory tab extension (EDIT `js/inventory.js`)

The existing "Inventory" tab gains a **"ผ้า"** quick-filter button in the category filter row (alongside GENERAL, SUPPLY, TOOL, CONSUME).

When the "ผ้า" filter is active:
- The items table renders additional columns: **หมวดย่อย** (`linen_subcategory` display name), **นับล่าสุด** (`counted_at` formatted), **จำนวนที่นับ** (`counted_qty`), **ต่างจากระบบ** (`delta` with red badge if `is_discrepancy=true`)
- Data is fetched from `v_linen_audit` (not directly from `stock_items` + `stock_item_locations`)
- A banner at the top shows: "ผ้าที่มีความคลาดเคลื่อน: N รายการ" in amber if any `is_discrepancy=true` rows exist

**No new admin sub-view is added.** The existing "รับเข้า / ปรับสต๊อก" form already supports `adjustment_gain` (reason=`laundry_in`) for Admin. The `reason` field (already exists as a text input) is pre-populated with `laundry_in` when the selected item has `category=LINEN`. Same for `adjustment_loss` → `laundry_out`.

**Thai label mapping for linen_subcategory in UI:**

| enum value | Thai display |
|---|---|
| `sheet` | ผ้าปูที่นอน |
| `blanket` | ผ้าห่ม |
| `towel` | ผ้าขนหนู |
| `gown` | เสื้อกาวน์ |
| `wipe` | ผ้าเช็ดเครื่องมือ |

### 7.2 Staff scan flow extension (EDIT `js/staff-scan.js` and `shared/linen.js`)

Staff scan flow currently: scan item barcode → scan location → qty → submit movement.

For Phase 6, when the staff scans a **cabinet QR code** (location type = `cabinet`), the system queries for LINEN items at that cabinet and renders a dedicated linen cabinet view.

#### 7.2.1 Linen cabinet view (after cabinet QR scan)

- Header: "ตู้ [location_name] — รายการผ้า"
- List of LINEN items stored in this cabinet (from `stock_item_locations JOIN stock_items WHERE category=LINEN AND location_id={cabinet_id}`):
  - Each row: item name (Thai) | คงเหลือ qty | นับล่าสุด date (from `v_linen_audit`)
  - Three action buttons per row:
    1. **ส่งซัก** (orange) — initiates laundry-out workflow
    2. **รับคืน** (green) — initiates laundry-in workflow
    3. **นับใหม่** (blue) — initiates count workflow
- If no LINEN items found for this cabinet: "ตู้นี้ยังไม่มีรายการผ้า — ติดต่อผู้ดูแลระบบ"

#### 7.2.2 ส่งซัก workflow (laundry-out)

1. Staff taps "ส่งซัก" on a linen item row
2. **Photo screen** — reuses `shared/photo-capture.js`:
   - Prompt: "ถ่ายรูปผ้าก่อนส่งซัก (บังคับ)"
   - Photo is **required** (see §11 Q6-B; requirement is advisory on count but required on laundry transitions)
   - "Skip" button is **hidden** on this screen
3. **Qty screen**: "จำนวนที่ส่งซัก" — numeric input, max = current qty in cabinet
4. **Confirm screen**: shows item name, cabinet, qty, photo thumbnail → "ยืนยัน ส่งซัก"
5. On confirm: POST to Supabase `stock_movements` with:
   - `movement_type = 'adjustment_loss'`
   - `qty_delta = -(qty_entered)`
   - `reason = 'laundry_out'`
   - `note` = photo_url (Cloudinary URL after upload)
   - `client_ref_id = crypto.randomUUID()`
6. Success toast: "ส่งซักเรียบร้อย — qty ผ้าลดแล้ว X ผืน"

#### 7.2.3 รับคืน workflow (laundry-in)

1. Staff taps "รับคืน" on a linen item row
2. **Photo screen** — `shared/photo-capture.js`:
   - Prompt: "ถ่ายรูปผ้าที่รับคืน (บังคับ)"
   - Photo **required**; "Skip" button **hidden**
3. **Qty screen**: "จำนวนที่รับคืน" — numeric input, minimum 1
4. **Confirm screen** → "ยืนยัน รับคืน"
5. On confirm: POST to `stock_movements` with:
   - `movement_type = 'adjustment_gain'`
   - `qty_delta = +(qty_entered)`
   - `reason = 'laundry_in'`
   - `note` = photo_url
   - `client_ref_id = crypto.randomUUID()`
6. Success toast: "รับคืนเรียบร้อย — qty ผ้าเพิ่มแล้ว X ผืน"

#### 7.2.4 นับใหม่ workflow (count snapshot)

1. Staff taps "นับใหม่" on a linen item row
2. **Photo screen** — `shared/photo-capture.js`:
   - Prompt: "ถ่ายรูปผ้าที่นับ (แนะนำ — ไม่บังคับ)"
   - "Skip" button **visible** (advisory; see §11 Q6-B)
3. **Count screen**: "จำนวนที่นับได้จริง" — numeric input
4. **Confirm screen** → "ยืนยัน บันทึกการนับ"
5. On confirm: POST to `linen_counts` with:
   - `location_id` = cabinet id
   - `item_id` = linen item id
   - `counted_qty` = entered count
   - `photo_url` = Cloudinary URL (null if skipped)
   - `counted_by` = auto from JWT (`app_username()`)
6. Success toast: "บันทึกการนับแล้ว — จำนวน X ผืน"
7. Row in linen cabinet view updates `นับล่าสุด` column immediately (re-fetch)

**Note:** The count snapshot does NOT update `stock_item_locations.qty`. If the counted qty differs materially from the system qty, staff should use ส่งซัก / รับคืน (or Admin uses Adjust) to reconcile.

### 7.3 Photo upload via Cloudinary

Reuses `shared/cloudinary.js` (Phase 0). Folder: `thegood-stock/linen/{cabinet_code}/{item_sku}/`

The `shared/photo-capture.js` component (Phase 3) is used as-is. No modification.

---

## 8. RLS Policies (`20260519060200_linen_counts_rls.sql`)

`linen_counts` is a new table; RLS must be explicitly enabled.

```sql
ALTER TABLE linen_counts ENABLE ROW LEVEL SECURITY;

-- Read: all authenticated users can read all counts
CREATE POLICY lc_read ON linen_counts
  FOR SELECT TO authenticated
  USING (true);

-- Insert: Admin or Employee (Staff) may insert counts
-- Reasoning: Staff perform the physical count; Admin may also count.
-- No UPDATE/DELETE: counts are immutable; corrections = new count row.
CREATE POLICY lc_insert ON linen_counts
  FOR INSERT TO authenticated
  WITH CHECK (
    app_user_role() IN ('Admin', 'Employee')
    AND counted_by = app_username()   -- must record own username; no proxy-count in Phase 6
  );

-- No UPDATE policy (immutable)
-- No DELETE policy (immutable; Admin can soft-delete via note if needed in Phase 6.1)
```

**RLS on `stock_movements` for laundry reasons:** No new policy needed. `adjustment_loss` and `adjustment_gain` are already allowed for both Admin and Employee under the `sm_insert_staff` policy from Phase 1. The `reason` field is free-text — RLS does not filter on it.

**View `v_linen_audit`:** Views in Supabase inherit the RLS of the underlying tables. Both `stock_item_locations` and `linen_counts` allow authenticated reads, so the view is readable by all authenticated users.

**Role matrix for Phase 6 additions:**

| Table / View | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `linen_counts` | authenticated | Admin + Employee (own username only) | — (immutable) | — (immutable) |
| `v_linen_audit` | authenticated (via base table RLS) | n/a (view) | n/a | n/a |

---

## 9. Acceptance Tests (T151–T170)

Tests continue from Phase 5 (T101–T120). The gap T121–T150 is reserved for Phase 4 (ALS Bags).

**LINEN category & items (T151–T153):**

- **T151** Run migration `20260519060000`; verify: `SELECT code FROM stock_categories WHERE code='LINEN'` returns 1 row. `SELECT count(*) FROM stock_items WHERE linen_subcategory IS NOT NULL` returns 5 (seed items).
- **T152** Admin attempts to create a stock_item with `category=LINEN` but `linen_subcategory=null` → DB constraint `chk_linen_subcategory` raises exception; client receives 400 error. Admin fills `linen_subcategory='sheet'` → succeeds.
- **T153** Admin creates a non-LINEN item (category=SUPPLY) with `linen_subcategory='towel'` → constraint raises exception. After removing the field → succeeds.

**linen_counts table & validation (T154–T156):**

- **T154** Staff inserts a `linen_counts` row for a valid cabinet location with a LINEN item → row created; `counted_by` = staff username.
- **T155** Attempt to insert `linen_counts` for a location with `type='shelf'` → trigger `trg_linen_count_validate` raises exception `'linen_counts สามารถบันทึกได้เฉพาะตู้ (cabinet) เท่านั้น — location_id ...'` → client receives 400; no row created.
- **T156** Attempt to insert `linen_counts` for a non-LINEN item → trigger raises exception `'linen_counts รองรับเฉพาะสินค้าหมวด LINEN'` → client receives 400; no row created.

**ส่งซัก workflow (T157–T158):**

- **T157** Staff scans cabinet QR (type=cabinet with ≥1 LINEN item). Linen cabinet view renders. Staff taps "ส่งซัก" on ผ้าปูที่นอน (current qty=10). Photo screen opens, photo captured. Qty entered as 3. Confirm → `stock_movements` row inserted with `movement_type='adjustment_loss'`, `qty_delta=-3`, `reason='laundry_out'`, `note` contains Cloudinary URL. `stock_item_locations.qty` for that (cabinet, item) pair = 7. Toast confirms success.
- **T158** Staff attempts ส่งซัก without taking a photo → "Skip" button is not visible; cannot proceed past photo screen without capturing.

**รับคืน workflow (T159–T160):**

- **T159** Staff taps "รับคืน" on same ผ้าปูที่นอน (current qty=7). Photo captured. Qty entered as 3. Confirm → `stock_movements` row `movement_type='adjustment_gain'`, `qty_delta=+3`, `reason='laundry_in'`. `stock_item_locations.qty` = 10. Toast confirms success.
- **T160** Staff attempts รับคืน without photo → "Skip" button is not visible; cannot proceed.

**นับใหม่ workflow (T161–T163):**

- **T161** Staff taps "นับใหม่" on ผ้าห่ม (current qty=8). Photo screen shows "Skip" button visible. Staff taps Skip. Enters counted_qty=8 (matches system). Confirm → `linen_counts` row inserted with `photo_url=null`. `stock_item_locations.qty` unchanged (still 8). Toast confirms success.
- **T162** Staff performs นับใหม่ with counted_qty=5 on an item with system qty=8. Row inserted. `stock_item_locations.qty` remains 8 (count is snapshot only, not an adjustment). Admin Inventory tab "ผ้า" filter shows `delta=-3` and amber discrepancy badge for that item.
- **T163** RLS: Staff attempts to insert `linen_counts` row with `counted_by` = another user's username (tampered request) → RLS policy `counted_by = app_username()` rejects → 403.

**Audit view (T164–T165):**

- **T164** `SELECT * FROM v_linen_audit WHERE is_discrepancy=true` — after T162, returns at least 1 row for the item with delta=-3. Columns `threshold_pct=5`, `min_pieces=2` match settings.
- **T165** A linen item at a cabinet with no `linen_counts` row → `v_linen_audit.is_discrepancy=false` (no count yet; no false alarm per view logic).

**Daily audit cron & Telegram alert (T166–T168):**

- **T166** Run `SELECT run_linen_audit_alert()` manually from SQL Editor. With the T162 discrepancy in place and Telegram enabled → at least 1 `pg_net` call fired. `notification_log` has a new row with `event_type='linen_audit'` and `dedupe_key` containing the location code, SKU, and today's date.
- **T167** Run `SELECT run_linen_audit_alert()` again on the same day → `tg-notify` dedupe logic catches the same `dedupe_key` → `notification_log` row shows `dedupe_hit=true`; no second Telegram message sent.
- **T168** Verify cron job registered: `SELECT jobname, schedule FROM cron.job WHERE jobname='linen_daily_audit'` → 1 row, schedule=`'0 23 * * *'`.

**RLS and RBAC (T169):**

- **T169** Employee with role='Employee' opens DevTools and attempts to POST `stock_movements` with `movement_type='receive'` for a LINEN item → 403 from Phase 1 RLS policy `sm_insert_staff` (receive is Admin-only). The `reason='laundry_in'` / `adjustment_gain` path works because `adjustment_gain` is Admin-only per Phase 1 RLS. **PM Q6-F open question:** should staff be allowed to confirm laundry returns (adjustment_gain)? See §11 Q6-F.

**Settings keys (T170):**

- **T170** `SELECT key, value FROM settings WHERE key LIKE 'LINEN_%'` → 3 rows (`LINEN_AUDIT_THRESHOLD_PCT=5`, `LINEN_AUDIT_MIN_PIECES=2`, `LINEN_AUDIT_CRON_HOUR=6`).

---

## 10. Out of Scope

| Item | Reason |
|---|---|
| New `movement_type` enum values for laundry | Explicit constraint in task brief. Reuse `adjustment_loss` / `adjustment_gain` with `reason` field. No ALTER TYPE needed. |
| Parallel `linens` table | **PROHIBITED.** Linens ARE stock_items with category=LINEN. |
| Parallel `cabinets` table | **PROHIBITED.** Cabinets ARE locations with type=cabinet. |
| Per-piece laundry tag / QR on individual linen | Phase 6.1. Would require per-serial tracking analogous to Phase 5 oxygen tanks. |
| ส่งซัก pairing with รับคืน (N-day return alert) | Pending PM decision Q6-E. Not in Phase 6 base scope. |
| Linen condition grading (good/worn/damaged) | Not in PDF §6. Phase 6.1 or deferred indefinitely. |
| Staff adding / editing linen items | Admin CRUD only; Phase 1 RLS unchanged. |
| External laundry vendor tracking | Not in PDF §6. |
| Multiple photos per count/movement | Phase 6.1 (Phase 3.1 same pattern). |
| Bulk multi-cabinet count in single session | Phase 6.1. |
| Dynamic cron schedule via settings UI | Not feasible in pg_cron (no dynamic scheduling without unschedule+reschedule). Admin must update cron manually if hour changes. `LINEN_AUDIT_CRON_HOUR` setting is documentation only. |

---

## 11. Open Questions for PM

Six questions for PM (user "Pex") to resolve before plan write-up. Recommendations provided; PM must confirm or override.

### Q6-A — Count audit cadence: daily, weekly, or per-shift?

| Option | Mechanism | Recommendation |
|---|---|---|
| **A. Daily 06:00 BKK (RECOMMENDED)** | pg_cron `'0 23 * * *'` UTC | Matches daily linen rotation rhythm; one alert per discrepancy per day (dedupe); matches low-stock pattern already in production |
| B. Per-shift (2–3×/day) | pg_cron `'0 1,9,15 * * *'` | More responsive; higher Telegram noise; more useful if laundry cycles are intraday |
| C. Weekly | pg_cron `'0 23 * * 0'` | Minimal noise; useful only if linen rotation is infrequent |

**Recommendation: A — daily 06:00 BKK.** Configurable via settings key `LINEN_AUDIT_CRON_HOUR` for future adjustment, but pg_cron schedule must be manually updated by Admin when the setting changes.

### Q6-B — Photo requirement: required or advisory on count vs laundry transitions?

| Scenario | This spec | Alternative |
|---|---|---|
| ส่งซัก (laundry-out) | **Required** (no Skip) | Advisory (Skip visible) |
| รับคืน (laundry-in) | **Required** (no Skip) | Advisory |
| นับใหม่ (count) | **Advisory** (Skip visible) | Required |

**Recommendation:** Required on laundry transitions (ส่งซัก / รับคืน) for audit integrity. Advisory on periodic count (นับใหม่) to reduce friction on routine daily counts. PM may elevate count photo to required if the organisation wants full photo coverage.

### Q6-C — Discrepancy threshold: percentage, absolute, or combined?

| Option | Formula | Example (qty=8) |
|---|---|---|
| A. Percentage only (e.g., 5%) | `abs_delta > qty * 0.05` | alerts if delta > 0.4 → effectively delta ≥ 1 for small qty |
| B. Absolute only (e.g., ≥ 2 pieces) | `abs_delta >= 2` | too aggressive for large inventories |
| **C. Combined: max(pct, min_pieces) (RECOMMENDED)** | `abs_delta > max(ceil(qty * pct/100), min_pieces)` | alerts only if delta > 2 AND delta > 5% of qty |

**Recommendation: C.** This is what `v_linen_audit` implements. Default `LINEN_AUDIT_THRESHOLD_PCT=5` and `LINEN_AUDIT_MIN_PIECES=2`. PM may adjust via settings table without code change.

### Q6-D — Sub-category model: enum column vs free-text?

| Option | Implementation | Trade-off |
|---|---|---|
| **A. Enum column `linen_subcategory` on stock_items (RECOMMENDED)** | Phase 6 adds `linen_subcategory` enum; constraint enforces LINEN items must have it | Filterable, reportable, extensible; Phase 6.1 per-piece tracking will need this as a structured field; adding a new subcategory requires a migration |
| B. Free-text in `stock_items.note` | No schema change | No filter/group-by capability; Phase 6.1 per-piece tracking cannot rely on it; inconsistent spellings across staff |
| C. Free-text in `stock_items.name` | No schema change | Same problems as B; names are display-only |

**Recommendation: A.** The five subcategories (sheet/blanket/towel/gown/wipe) cover the PDF §6 scope and are stable. If a new linen type arises (e.g., `face_mask`), a migration adds one enum value — low effort, high data quality gain.

### Q6-E — ส่งซัก / รับคืน pairing: paired or independent?

If ส่งซัก creates an "open laundry ticket", the system can alert when a batch of linens hasn't returned within N days.

| Option | Mechanism | Complexity |
|---|---|---|
| A. Independent movements (RECOMMENDED for Phase 6 base) | Each movement is standalone; no pairing | Low complexity; existing movements ledger sufficient |
| B. Paired with N-day return alert | New table `linen_laundry_batches`; `pg_cron` checks open batches | Medium complexity; adds ~2 migrations; useful operationally |

**Recommendation: A for Phase 6 base; B as Phase 6.1 scope.** The `reason` field (`laundry_out` / `laundry_in`) allows retrospective pairing analysis in SQL even without a dedicated batch table. If PM wants the N-day alert in Phase 6, scope must be explicitly expanded — estimate +0.5 day.

### Q6-F — Staff RBAC on รับคืน (adjustment_gain): Staff-allowed or Admin-only?

**Context:** Phase 1 RLS grants `adjustment_gain` to Admin only (`sm_insert_admin` policy covers all types; `sm_insert_staff` covers only `issue` + `adjustment_loss`). This means Staff cannot confirm รับคืน from laundry — only Admin can.

**Operational concern:** If linens arrive back during a night shift when no Admin is present, staff cannot confirm receipt in the system.

| Option | RLS change | Risk |
|---|---|---|
| A. Keep Admin-only for adjustment_gain | No migration | Staff cannot confirm laundry returns; Admin bottleneck |
| **B. Allow Staff to do adjustment_gain with reason='laundry_in' only (RECOMMENDED)** | Modify `sm_insert_staff` policy to add `adjustment_gain` when `reason='laundry_in'` | Staff can confirm returns; cannot abuse adjustment_gain for other stock increases; slight increase in RLS complexity |
| C. Allow Staff all adjustment_gain | No reason filter in RLS | Broadest access; risk of unauthorized stock inflation |

**Recommendation: B.** Update `sm_insert_staff` to allow `adjustment_gain` when `reason = 'laundry_in'`. This is the minimal change that unblocks the laundry-return workflow for night staff.

**Note for PM:** If Option B is chosen, Phase 6 must include a migration to update the `sm_insert_staff` policy. This migration is not yet written in the data model section above — it is held pending PM confirmation to avoid changing a locked Phase 1 policy without explicit approval.

---

## 12. Decisions Log

IDs use `Q-Phase6-X` to avoid collision with prior phases (Q-Phase1 through Q-Phase5).

| ID | Question | Decision | Source |
|---|---|---|---|
| Q-Phase6-A | Linens entity model | **Linens ARE stock_items with category=LINEN.** No parallel table. | Explicit constraint in task brief; Phase 1 schema designed for this. |
| Q-Phase6-B | Cabinets entity model | **Cabinets ARE locations with type='cabinet'.** No new entity. | Phase 0 `location_type` enum includes `cabinet`. |
| Q-Phase6-C | movement_type enum | **No new enum values.** `adjustment_loss` (reason=`laundry_out`) + `adjustment_gain` (reason=`laundry_in`) reuse Phase 1 enum. | Explicit constraint in task brief. |
| Q-Phase6-D | Photo capture component | **Reuse `shared/photo-capture.js` from Phase 3.** No modifications. | Phase 3 decisions locked doc §10 item 10. |
| Q-Phase6-E | New Edge Functions | **None.** All notification via `pg_net` → existing `tg-notify`. | §6 of this spec. |
| Q-Phase6-F | `linen_counts` as snapshot | **`linen_counts` is a count snapshot only.** It does not update `stock_item_locations.qty`. Discrepancies are surfaced by audit view + cron, not by the count insert. | §5.2 design note. |
| Q-Phase6-G | Trigger credential source | **Triggers read credentials from `settings` table** (`NOTIFY_SUPABASE_URL`, `NOTIFY_SERVICE_ROLE_KEY`). Hard-coding in PL/pgSQL prohibited. | Project.md §8 gotcha 9; Phase 1 deviation pattern. |
| Q-Phase6-H | Audit threshold formula | **Combined: `abs_delta > max(ceil(qty * pct/100), min_pieces)`** with defaults `pct=5`, `min_pieces=2`. Configurable via `settings`. | §5.3 view design + §11 Q6-C recommendation. |
| Q-Phase6-I | Trigger error strings | **Thai.** Example: `'linen_counts สามารถบันทึกได้เฉพาะตู้ (cabinet) เท่านั้น — location_id %'` | Project rule: Trigger error strings must be exact Thai. |
| Q-Phase6-J | Migration namespace | **20260519060000–20260519060999** (Phase 6). | Task brief constraint. |
| Q-Phase6-K | cron UTC offset | **06:00 BKK = 23:00 UTC** (UTC+7). Cron schedule hard-coded as `'0 23 * * *'`. `LINEN_AUDIT_CRON_HOUR` setting is documentation only; pg_cron must be manually updated if the schedule changes. | §5.5 + §10 out-of-scope note. |

**Pending PM decisions (will be added to this log when resolved):**

| ID | Pending |
|---|---|
| Q-Phase6-L | Q6-A (cron cadence) — PM accept daily or override |
| Q-Phase6-M | Q6-B (photo advisory vs required on counts) |
| Q-Phase6-N | Q6-D (subcategory enum vs free-text) |
| Q-Phase6-O | Q6-E (laundry pairing) |
| Q-Phase6-P | Q6-F (Staff RBAC for adjustment_gain/laundry_in) |

---

## 13. Phase 6 Requirement → Acceptance Test Coverage

| PDF §6 requirement | Covered by |
|---|---|
| Cabinet-level linen tracking | T151 (category seed), T154 (linen_counts insert) |
| Count-based qty (not per-piece) | T157, T159, T161, T162 |
| ส่งซัก (send to laundry) workflow | T157, T158 |
| รับคืน (receive from laundry) workflow | T159, T160 |
| Photo required on laundry transitions | T158, T160 |
| Periodic count snapshot | T161, T162 |
| Count snapshot does not change qty | T162 |
| Audit discrepancy detection | T162, T164 |
| Telegram alert for discrepancy | T166, T167 |
| Dedupe on audit alerts | T167 |
| Cabinet type validation (not shelf/room) | T155 |
| LINEN category only in linen_counts | T156 |
| Admin Inventory tab "ผ้า" filter | T164 (v_linen_audit), T170 (settings) |
| Staff can only count own username | T163 |
| Settings keys seeded | T170 |
| Cron job registered | T168 |

**Coverage self-check result:** All Phase 6 PDF §6 requirements have at least one acceptance test. No requirement-without-test gaps.

---

## 14. Effort Estimate

| Workstream | Effort |
|---|---|
| Migrations (7 files: category, linen_counts, RLS, view, trigger, cron, settings) | 0.5 day |
| `shared/linen.js` (fetchLinenByCabinet, submitLinenCount, submitLinenMovement) | 0.25 day |
| `js/staff-scan.js` extension (linen cabinet view + 3 workflows) | 0.5 day |
| `js/inventory.js` extension ("ผ้า" filter + audit columns) | 0.25 day |
| Test pass T151–T170 | 0.5 day |
| PM review feedback + open question resolution | 0.25 day |
| **Total** | **~2.25 days** |

**Risk factors:**
- Q6-F resolution (Staff RBAC for laundry_in) requires a policy migration that alters a Phase 1 locked policy — adds ~0.25 day for careful testing
- `linen_subcategory` enum constraint on existing `stock_items` table — if any legacy rows conflict, migration must handle via `UPDATE stock_items SET linen_subcategory = null WHERE ... ; ALTER TABLE ...` sequence (low risk; Phase 1 items are all non-LINEN)
- `v_linen_audit` sub-query reads from `settings` table — if `LINEN_AUDIT_THRESHOLD_PCT` or `LINEN_AUDIT_MIN_PIECES` keys don't exist, `COALESCE` defaults apply; low risk
- Phase 6 before Phase 2 deployment: `pg_cron` extension may not exist yet; operator must run `CREATE EXTENSION IF NOT EXISTS pg_cron` — documented in plan deploy notes

---

## 15. Next Step

When this DRAFT is approved by PM:
1. Resolve the 6 open questions in §11 (or accept the recommendations)
2. If Q6-F resolved to Option B, author adds the `sm_insert_staff` policy update migration (`20260519060700_linen_rbac_staff_laundry_in.sql`)
3. Hand off to `superpowers:writing-plans` to produce `docs/superpowers/plans/2026-05-19-phase6-linens-laundry-plan.md`
4. Execute the plan; verify all T151–T170 pass; tag `phase6-linens`

---

*Hand-off note:* The next agent is `superpowers:writing-plans` (after PM approves and resolves open questions). The plan agent needs:
- This spec (all DDL is ready to paste)
- PM decisions on Q6-A through Q6-F
- Confirmation of whether Q6-F Option B is adopted (triggers one additional migration file)
- Note: `shared/photo-capture.js` already exists from Phase 3; do not re-create it
