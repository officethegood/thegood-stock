# DRAFT — Phase 1 Inventory Design (pending PM review)

**Project:** Thegood Stock Management System
**Phase:** 1 (General Inventory + Storage Scanning + Low-stock Alert + Item Finder + Multi-Location)
**Date:** 2026-05-18
**Author:** Business/System Analyst (autonomous draft while PM "Pex" away)
**Status:** **DRAFT — pending PM review.** Do not implement yet. Five open questions in Section 11 need PM decisions before plan write-up.
**Predecessor:** `docs/superpowers/specs/2026-05-18-phase0-foundation-design.md` (Phase 0 — LIVE)

---

## 1. Purpose & Scope

Phase 1 turns the Phase 0 foundation into a *working inventory system* for the **non-medication, non-ALS, non-oxygen, non-linen** items at Thegood. It is the smallest end-to-end vertical that exercises Phase 0's auth, RLS, Realtime, notification, and locations infrastructure under real workload, so that Phases 2–6 plug in as feature additions rather than re-architecture.

The PDF (`ระบบจัดการสต๊อกและอุปกรณ์การแพทย์.pdf`, provided by user 2026-05-18) is the source of requirements. Phase 1 covers:
- **§4 General Inventory Module** — receive, issue, count, low-stock alert (in full)
- **§9 Storage Location / Multi-Location** — multi-location quantity tracking, item-to-location placement (in full for the items covered in Phase 1)
- **§1 RBAC** — applies to all phases; Phase 1 enforces the Admin-only "receive" vs Staff-allowed "issue" split for stock movements
- **§2 Dashboard** — Phase 1 lights up the inventory KPIs (total items, low-stock count, scans today)
- **§3 Telegram** — wires the low-stock notification path end-to-end; reuses the single `NOTIFY_TELEGRAM_CHAT_ID` from Phase 0

### In scope (Phase 1)
- New table family `stock_items`, `stock_item_locations`, `stock_movements` (DDL in §5) plus an optional `stock_categories` lookup
- Admin form for **manual item intake** (เพิ่มของใหม่): name, SKU, optional barcode, category, unit, reorder threshold
- Admin form for **manual receive** (รับเข้า): pick item, pick location, qty, note → posts a `stock_movements` row (type=`receive`) and updates `stock_item_locations`
- **QR/barcode scan UI** for both intake (Admin) and issue (Staff): scan a printed item label or barcode, then scan a location QR (already in `locations.qr_payload` from Phase 0), then enter qty
- **Item Finder** (ค้นของ): text search by name/SKU/barcode → result lists every location currently holding that SKU with current qty
- **Multi-Location quantity tracking**: a single SKU can sit in multiple locations simultaneously; each `(item, location)` pair has its own qty; aggregating gives total stock
- **Low-stock alert** (เตือนของใกล้หมด): per-item `reorder_threshold`; when total qty across all locations crosses below the threshold via an issue movement, a Telegram alert fires (deduped per Phase 0 `notification_log.dedupe_key`, reusing single group chat)
- New admin tab **"Inventory"** in `admin.html` (lazy-loaded)
- New staff page **`staff-scan.html`** (mobile-first scan flow)
- Realtime subscription on `stock_item_locations` so admin Inventory tab updates live when a staff scan posts
- Acceptance tests T24–T44 (continue from Phase 0's T23)

### Out of scope (deferred — schema designed to extend)
- Phase 2: medication lots, lot numbers, **expiry dates**, multiple expiry per SKU, 30/60/90-day alerts. *Schema hook:* `stock_movements.lot_id nullable` placeholder + `stock_items.tracks_lots boolean default false`.
- Phase 3: equipment borrow/return with photo proof, overdue alerts. *Schema hook:* `stock_movements.movement_type` enum already includes `borrow|return` reserved values.
- Phase 4: ALS bag composition + kit-restock. *Schema hook:* the `bag` location type from Phase 0 + nullable parent on `stock_movements` to a future `kit_id`.
- Phase 5: oxygen tank per-tank lifecycle (per-unit serial, status state machine). Oxygen is a *different* identity model (per-piece serial), so Phase 5 introduces a separate `oxygen_tanks` table — *not* a child of `stock_items`. Decision Q-Phase1-D in §12 explains why.
- Phase 6: linens/laundry cabinet-based counts. *Schema hook:* general inventory works for this; Phase 6 adds the laundry-status state machine on top.
- Per-piece serial numbers for general inventory (user confirmed: SKU + qty only; no serials per piece)
- Multiple alert chats / per-category routing (user confirmed: single Telegram group; reuse `NOTIFY_TELEGRAM_CHAT_ID`)
- Stock-take / cycle count workflow (deferred; can post `adjustment` movements manually in Phase 1)
- Transfer between locations as a *single* atomic operation (Phase 1 records as one `issue` + one `receive` pair; a true `transfer` movement type can be added later)
- Barcode generation / label printing (Phase 1 *reads* existing barcodes only)
- Image attachment on items (Phase 3 wires Cloudinary; Phase 1 has `image_url text` column but no UI)

---

## 2. Architecture Overview

Phase 1 is purely additive on top of Phase 0. No Phase 0 surface changes.

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (mobile-first)                                             │
│  GitHub Pages: officethegood.github.io/thegood-stock                │
│                                                                     │
│  Admin (admin.html, NEW tab "Inventory")                            │
│   ├─ Items list + search          ───── Realtime: stock_items       │
│   ├─ Receive form (manual)        ───── Realtime: stock_item_loc.   │
│   ├─ Item Finder                                                    │
│   └─ Scan-receive (camera)                                          │
│                                                                     │
│  Staff (NEW page staff-scan.html)                                   │
│   ├─ Scan item → scan location → qty → submit (issue)               │
│   └─ Item Finder (read-only)                                        │
└────────────────────────────────────────┬───────────────────────────┘
                                         │
                  ┌──────────────────────┴──────────────────────┐
                  │ Supabase REST/RPC + Realtime WebSocket      │
                  └──────────────────────┬──────────────────────┘
                                         │
                  ┌──────────────────────┴──────────────────────┐
                  │ Postgres (thegood-stock)                     │
                  │  ── Phase 0 tables (unchanged):              │
                  │     ambulances, locations, settings,         │
                  │     notification_log, user_sessions          │
                  │  ── Phase 1 NEW tables:                      │
                  │     stock_categories (optional lookup)       │
                  │     stock_items                              │
                  │     stock_item_locations                     │
                  │     stock_movements                          │
                  │  ── Phase 1 NEW trigger:                     │
                  │     trg_low_stock_alert AFTER UPDATE         │
                  │     on stock_item_locations →                │
                  │     pg_net POST → tg-notify                  │
                  └──────────────────────┬──────────────────────┘
                                         │
                  ┌──────────────────────┴──────────────────────┐
                  │ Edge Functions (Phase 0 reused, no new fn)  │
                  │  ├─ auth-bridge      [Phase 0]              │
                  │  ├─ sync-ambulances  [Phase 0]              │
                  │  └─ tg-notify        [Phase 0; new event_   │
                  │      type='low_stock' caller from trigger]  │
                  └─────────────────────────────────────────────┘
```

### Key Phase 1 principles

| Principle | How it shows up |
|---|---|
| **Reuse, don't re-architect** | All stock writes go through plain Supabase REST + RLS; no new Edge Function. Telegram path is the same `tg-notify` Phase 0 already ships. |
| **Movements ledger as audit trail** | Every change to `stock_item_locations.qty` is preceded by a `stock_movements` insert. The trigger that updates qty also fires the low-stock check. This gives audit + reversibility for Phase 2+ (lot recalls, return rollbacks). |
| **RLS owns the receive/issue split** | Admin policy = full write. Staff policy = INSERT into `stock_movements` only when `movement_type IN ('issue','adjustment_loss')`. The DB enforces; the UI hides what the user can't do. |
| **Mobile-first scan path** | Camera-only on `staff-scan.html`; admin can also use it but has a parallel keyboard-entry form. Uses `BarcodeDetector` API where available, falls back to `html5-qrcode` library. |
| **Dedupe via Phase 0 plumbing** | Trigger composes `dedupe_key = 'low_stock:' || sku || ':' || to_char(now(), 'YYYY-MM-DD')`; `tg-notify` checks `notification_log` within the configured `LOW_STOCK_DEDUPE_HOURS` (default 24) — *same setting Phase 0 already seeds*. |

---

## 3. Sync Strategy (extends Phase 0 table)

Phase 1 adds rows 13–17 to the Phase 0 sync table.

| # | Data | Type | Mechanism | Cadence | Phase |
|---|---|---|---|---|---|
| 1–5 | (Phase 0 — login, refresh, ambulance sync, locations CRUD, settings) | — | — | — | 0 |
| 6 | Stock balance per location | **Realtime** | Postgres replication → WS on `stock_item_locations` | live | **1** |
| 7 | Inventory dashboard counters | **Realtime + aggregate query** | Realtime fires re-aggregate of `stock_items` joined to sum of `stock_item_locations.qty` | live | **1** |
| 8 | Expiry alert (30/60/90d) | Autosync (cron) | `pg_cron` daily | 1×/day | 2+ |
| 9 | **Low-stock alert** | **Autosync (trigger + dedupe)** | `AFTER UPDATE OF qty ON stock_item_locations` → trigger checks new SUM(qty) per item vs `reorder_threshold` → if crossed, `pg_net` POST to `tg-notify` with dedupe_key | event-driven + 24h dedupe | **1** |
| 10 | Overdue borrow | Autosync (cron) | `pg_cron` 09:00 + 17:00 | 2×/day | 3+ |
| 11 | Oxygen refill batch | Autosync (trigger) | trigger on tank count change | on threshold | 5+ |
| 12 | User list cache | Manual sync | Admin button | rare | deferred |
| 13 | **Item Finder lookup** | **Request-Response** | Supabase REST: `select stock_items + stock_item_locations(*) inner join` with `ilike` filter on name/sku/barcode | per query | **1** |
| 14 | **Scan-driven movement** | **Request-Response (idempotent)** | Client sends `INSERT INTO stock_movements` with `client_ref_id` UUID; trigger updates `stock_item_locations` and (if needed) fires low-stock | per scan | **1** |
| 15 | **Items master CRUD** | Request-Response | Supabase REST | immediate | **1** |
| 16 | **Categories master CRUD** | Request-Response | Supabase REST | immediate | **1** |
| 17 | **Scan idempotency check** | Pre-insert lookup | `SELECT id FROM stock_movements WHERE client_ref_id = $1` (offline replay safety; SW will buffer scans in Phase 1.1) | per scan | **1** |

**Realtime topics enabled in Phase 1:**
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE stock_items;
ALTER PUBLICATION supabase_realtime ADD TABLE stock_item_locations;
-- stock_movements NOT in realtime to avoid noise; admin can poll a "recent movements" tab if needed.
```

---

## 4. Repository Structure (new files only)

Phase 0 layout from §4 of Phase 0 spec is unchanged. Phase 1 adds:

```
thegood-stock/
├── staff-scan.html                                    (NEW — mobile staff scan flow)
│
├── shared/
│   ├── scanner.js                                     (NEW — BarcodeDetector + html5-qrcode fallback wrapper)
│   ├── inventory.js                                   (NEW — item/movement REST helpers + Realtime subscribe)
│   └── (unchanged Phase 0 modules)
│
├── js/
│   ├── inventory.js                                   (NEW — admin "Inventory" tab init + CRUD)
│   ├── inventory-finder.js                            (NEW — Item Finder panel)
│   ├── inventory-scan.js                              (NEW — admin scan-receive UI)
│   ├── staff-scan.js                                  (NEW — staff scan-issue UI)
│   └── admin-shell.js                                 (EDIT — register new "Inventory" tab; no other change)
│
├── supabase/
│   ├── migrations/
│   │   ├── 20260519000000_stock_categories.sql        (NEW)
│   │   ├── 20260519000100_stock_items.sql             (NEW)
│   │   ├── 20260519000200_stock_item_locations.sql    (NEW)
│   │   ├── 20260519000300_stock_movements.sql         (NEW — includes movement_type enum)
│   │   ├── 20260519000400_stock_triggers.sql          (NEW — qty update + low-stock alert)
│   │   ├── 20260519000500_stock_rls.sql               (NEW — admin/staff split)
│   │   └── 20260519000600_stock_realtime.sql          (NEW — publication ALTERs)
│   └── functions/
│       └── (no new function; tg-notify reused)
│
├── sw.js                                              (EDIT — add new HTML/JS to STATIC_ASSETS; bump CACHE_VERSION)
│
└── docs/
    ├── superpowers/specs/2026-05-18-phase1-inventory-design.md    (this file)
    └── superpowers/plans/2026-05-18-phase1-inventory-plan.md      (NEXT step — not yet written)
```

External scanner library: `html5-qrcode` via CDN (`https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js`) — loaded only on pages that need it (lazy `<script>` injection from `shared/scanner.js`). Falls back from native `BarcodeDetector` to library only when API absent (Safari iOS < 17).

---

## 5. Data Model

**Recommended Multi-Location data model:** **Option A — `stock_items` + `stock_item_locations` join with per-location qty.** Rationale and trade-offs in §11 Open Question 1. The DDL below assumes Option A *and* adds a `stock_movements` ledger that is *not* the qty source of truth but is the audit trail; the qty source of truth is `stock_item_locations.qty`, kept in sync by a trigger on `stock_movements` insert. This hybrid was chosen so:
- per-location qty reads are O(1) (no SUM over ledger) — important for the Item Finder hot path
- every change is still auditable and reversible (every qty change has a `stock_movements` row)
- Phase 2 lots plug in as a child of `stock_movements` (a `stock_movement_lots` table) without changing the qty contract
- Phase 3 borrows plug in as `movement_type='borrow'` → qty stays at the source location but a `stock_loans` table holds the in-flight record

### 5.1 `stock_categories` — optional lookup (`20260519000000_stock_categories.sql`)

Decision Q-Phase1-E in §12 recommends a *minimal* category enum in Phase 1 (one level, optional), with a full taxonomy deferred. Implementation as a table (not enum) so Phase 2+ can extend without migration.

```sql
CREATE TABLE stock_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  active      boolean DEFAULT true,
  sort_order  int DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

INSERT INTO stock_categories(code, name, sort_order) VALUES
  ('GENERAL',  'ทั่วไป',        10),
  ('SUPPLY',   'วัสดุสิ้นเปลือง', 20),
  ('TOOL',     'อุปกรณ์ใช้ซ้ำ',   30),
  ('CONSUME',  'ของใช้แล้วทิ้ง',   40);
-- Phase 2 will add 'MEDICATION', Phase 4 will add 'ALS_KIT', etc.
```

### 5.2 `stock_items` — master (`20260519000100_stock_items.sql`)

```sql
CREATE TABLE stock_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                 text UNIQUE NOT NULL,
  barcode             text UNIQUE,                          -- nullable; not all items have printed barcodes
  name                text NOT NULL,
  name_en             text,                                 -- optional English; useful for barcode lookup vendors
  category_id         uuid REFERENCES stock_categories(id),
  unit                text NOT NULL DEFAULT 'ชิ้น',          -- ชิ้น, กล่อง, ขวด, ...
  reorder_threshold   int NOT NULL DEFAULT 0,               -- total across all locations; 0 = no alert
  tracks_lots         boolean NOT NULL DEFAULT false,       -- Phase 2 hook
  tracks_serial       boolean NOT NULL DEFAULT false,       -- Phase 5 hook (oxygen-style)
  image_url           text,                                 -- Phase 3 wires UI; Phase 1 nullable
  note                text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  created_by          text DEFAULT app_username(),
  updated_by          text
);
CREATE INDEX idx_stock_items_name     ON stock_items USING gin (to_tsvector('simple', name));
CREATE INDEX idx_stock_items_barcode  ON stock_items(barcode);
CREATE INDEX idx_stock_items_category ON stock_items(category_id);
CREATE TRIGGER trg_stock_items_updated_at BEFORE UPDATE ON stock_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### 5.3 `stock_item_locations` — qty per (item, location) (`20260519000200_stock_item_locations.sql`)

```sql
CREATE TABLE stock_item_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id     uuid NOT NULL REFERENCES locations(id)   ON DELETE RESTRICT,
  qty             int NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_movement_at timestamptz,
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (item_id, location_id)
);
CREATE INDEX idx_sil_item     ON stock_item_locations(item_id);
CREATE INDEX idx_sil_location ON stock_item_locations(location_id);
CREATE INDEX idx_sil_nonzero  ON stock_item_locations(item_id) WHERE qty > 0;
CREATE TRIGGER trg_sil_updated_at BEFORE UPDATE ON stock_item_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### 5.4 `stock_movements` — ledger / audit (`20260519000300_stock_movements.sql`)

```sql
CREATE TYPE stock_movement_type AS ENUM (
  'receive',           -- Admin-only: incoming stock
  'issue',             -- Staff or Admin: outgoing stock (เบิก-จ่าย)
  'adjustment_gain',   -- Admin-only: stock-take found extra
  'adjustment_loss',   -- Staff or Admin: report damage/loss
  'transfer_out',      -- (reserved; Phase 1 records as issue+receive pair)
  'transfer_in',       -- (reserved)
  'borrow',            -- (reserved for Phase 3)
  'return'             -- (reserved for Phase 3)
);

CREATE TABLE stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref_id       uuid UNIQUE,                          -- idempotency key from client
  item_id             uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id         uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  movement_type       stock_movement_type NOT NULL,
  qty_delta           int NOT NULL CHECK (qty_delta <> 0),  -- positive for receive/gain/return, negative for issue/loss/borrow
  qty_after           int,                                  -- snapshot of stock_item_locations.qty after this move, filled by trigger
  reason              text,
  note                text,
  lot_id              uuid,                                 -- Phase 2 hook (FK added later)
  source_movement_id  uuid REFERENCES stock_movements(id),  -- for return-of-borrow, transfer pair
  performed_by        text NOT NULL DEFAULT app_username(),
  performed_role      text NOT NULL DEFAULT app_user_role(),
  performed_at        timestamptz DEFAULT now()
);
CREATE INDEX idx_sm_item       ON stock_movements(item_id, performed_at);
CREATE INDEX idx_sm_location   ON stock_movements(location_id, performed_at);
CREATE INDEX idx_sm_performed  ON stock_movements(performed_at);
```

**Sign convention for `qty_delta`:**
- `receive`, `adjustment_gain`, `return`, `transfer_in` → positive
- `issue`, `adjustment_loss`, `borrow`, `transfer_out` → negative
- Trigger enforces sign matches type (see §5.5).

### 5.5 Triggers (`20260519000400_stock_triggers.sql`)

```sql
-- 5.5.1 Enforce qty_delta sign matches movement_type
CREATE OR REPLACE FUNCTION enforce_movement_sign() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.movement_type IN ('receive','adjustment_gain','return','transfer_in') AND NEW.qty_delta <= 0 THEN
    RAISE EXCEPTION 'qty_delta must be positive for %', NEW.movement_type;
  ELSIF NEW.movement_type IN ('issue','adjustment_loss','borrow','transfer_out') AND NEW.qty_delta >= 0 THEN
    RAISE EXCEPTION 'qty_delta must be negative for %', NEW.movement_type;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_sm_sign BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION enforce_movement_sign();

-- 5.5.2 Apply movement to stock_item_locations + snapshot qty_after
CREATE OR REPLACE FUNCTION apply_movement_to_sil() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_new_qty int;
BEGIN
  INSERT INTO stock_item_locations(item_id, location_id, qty, last_movement_at)
  VALUES (NEW.item_id, NEW.location_id, GREATEST(0, NEW.qty_delta), NEW.performed_at)
  ON CONFLICT (item_id, location_id) DO UPDATE
    SET qty = stock_item_locations.qty + NEW.qty_delta,
        last_movement_at = NEW.performed_at
  RETURNING qty INTO v_new_qty;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'movement would drive qty negative for item % at location %', NEW.item_id, NEW.location_id;
  END IF;

  UPDATE stock_movements SET qty_after = v_new_qty WHERE id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_sm_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_movement_to_sil();

-- 5.5.3 Low-stock alert: only on negative deltas (issue/loss/borrow/transfer_out)
CREATE OR REPLACE FUNCTION check_low_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_total     int;
  v_threshold int;
  v_sku       text;
  v_name      text;
  v_dedupe    text;
  v_msg       text;
  v_payload   jsonb;
  v_url       text := current_setting('app.supabase_url', true);
  v_srk       text := current_setting('app.service_role_key', true);
BEGIN
  IF NEW.qty_delta >= 0 THEN
    RETURN NEW;  -- only on outgoing
  END IF;

  SELECT sku, name, reorder_threshold INTO v_sku, v_name, v_threshold
  FROM stock_items WHERE id = NEW.item_id;

  IF v_threshold <= 0 THEN
    RETURN NEW;  -- alert disabled for this item
  END IF;

  SELECT COALESCE(SUM(qty), 0) INTO v_total
  FROM stock_item_locations WHERE item_id = NEW.item_id;

  IF v_total > v_threshold THEN
    RETURN NEW;  -- still above threshold
  END IF;

  v_dedupe := 'low_stock:' || v_sku || ':' || to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD');
  v_msg    := format('⚠️ ของใกล้หมด: %s (%s) คงเหลือรวม %s จากเกณฑ์ %s', v_name, v_sku, v_total, v_threshold);
  v_payload := jsonb_build_object(
    'item_id', NEW.item_id, 'sku', v_sku, 'name', v_name,
    'total_qty', v_total, 'threshold', v_threshold,
    'last_movement_id', NEW.id, 'location_id', NEW.location_id
  );

  PERFORM net.http_post(
    url     := v_url || '/functions/v1/tg-notify',
    headers := jsonb_build_object(
      'content-type',     'application/json',
      'apikey',           v_srk,
      'authorization',    'Bearer ' || v_srk,
      'X-Internal',       'true'
    ),
    body    := jsonb_build_object(
      'event_type',  'low_stock',
      'entity_type', 'stock_item',
      'entity_id',   NEW.item_id::text,
      'dedupe_key',  v_dedupe,
      'message',     v_msg,
      'payload',     v_payload
    )
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_sm_lowstock AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_low_stock();
```

Note: `current_setting('app.supabase_url', true)` and `app.service_role_key` are set as database parameters by the migration's `ALTER DATABASE` step (paste-in step in plan). This avoids hard-coding the URL/key in PL/pgSQL and lets the same migration work across dev/prod projects.

### 5.6 RLS (`20260519000500_stock_rls.sql`)

```sql
ALTER TABLE stock_categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_item_locations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements        ENABLE ROW LEVEL SECURITY;

-- stock_categories: read all, write Admin
CREATE POLICY scat_read  ON stock_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY scat_write ON stock_categories FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- stock_items: read all, write Admin
CREATE POLICY si_read  ON stock_items FOR SELECT TO authenticated USING (true);
CREATE POLICY si_write ON stock_items FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- stock_item_locations: read all; writes ONLY from trigger (service_role), never client
CREATE POLICY sil_read   ON stock_item_locations FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE/DELETE for authenticated; trigger uses postgres role which bypasses RLS.

-- stock_movements: read all authenticated; INSERT split by movement_type
CREATE POLICY sm_read    ON stock_movements FOR SELECT TO authenticated USING (true);
CREATE POLICY sm_insert_admin ON stock_movements FOR INSERT TO authenticated
  WITH CHECK (app_user_role() = 'Admin');
CREATE POLICY sm_insert_staff ON stock_movements FOR INSERT TO authenticated
  WITH CHECK (
    app_user_role() IN ('Admin','Employee')
    AND movement_type IN ('issue','adjustment_loss')   -- staff can ISSUE only
  );
-- Phase 3 will add borrow/return to staff-allowed set.
-- No UPDATE / DELETE: movements are immutable (corrections are reverse-movements).
```

This is the split the PDF §1 describes (Staff scans เบิก-จ่าย only; รับเข้า is Admin). See Open Question 2.

### 5.7 Realtime publication (`20260519000600_stock_realtime.sql`)

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE stock_items;
ALTER PUBLICATION supabase_realtime ADD TABLE stock_item_locations;
```

---

## 6. Edge Functions

**None new.** Phase 1 deliberately avoids new Edge Functions. Justification:
- All writes go through Supabase REST with RLS doing authorization — same pattern as Phase 0 locations CRUD.
- The low-stock notification path goes DB trigger → `pg_net` → existing `tg-notify` (same path Phase 0 already designed for; Phase 1 is the first real caller).
- The scan UI runs entirely in browser (camera API + REST insert).
- Idempotency for retried scans is handled by the `client_ref_id UUID UNIQUE` constraint on `stock_movements` — a duplicate INSERT returns 409 and the client treats it as "already posted".

If PM rejects the trigger-based approach (e.g., over `pg_net` reliability concerns), the fallback is a new `scan-handler` Edge Function that wraps the INSERT + alert in one HTTP call. Effort estimate ~+0.5 day. See Open Question 3.

---

## 7. UI Spec

### 7.1 Admin shell: new tab **"Inventory"** (after Locations, before Ambulances)

Registered in `js/admin-shell.js` tab list. Lazy-loaded via `js/inventory.js`.

**Layout — three sub-views inside the tab, switched by a segmented control:**

#### 7.1.1 รายการสินค้า (Items list)
- Search box (debounced `ilike` on `name`/`sku`/`barcode`)
- Filter: category, active, low-stock-only toggle
- Table columns: SKU | ชื่อ | หมวด | คงเหลือรวม | เกณฑ์เตือน | สถานะ
  - "คงเหลือรวม" is `SUM(stock_item_locations.qty)` per row, fetched in a single query: `select stock_items.*, stock_item_locations(qty.sum())` via a PostgREST RPC view (introduced in migration `20260519000100`):
    ```sql
    CREATE VIEW v_stock_items_with_total AS
    SELECT si.*, COALESCE(SUM(sil.qty), 0) AS total_qty
    FROM stock_items si
    LEFT JOIN stock_item_locations sil ON sil.item_id = si.id
    GROUP BY si.id;
    ```
- Row click → side drawer with full detail + per-location breakdown
- Top-right buttons: **+ เพิ่มสินค้า** (modal: name, SKU, barcode optional, category, unit, threshold), **📷 สแกนรับเข้า** (opens scan-receive overlay)
- Realtime: subscribes to `stock_items` + `stock_item_locations` channel; debounce 300ms to re-aggregate

#### 7.1.2 รับเข้า / ปรับสต๊อก (Receive / Adjust)
- Manual form (Admin's main alternative to scanning):
  - Item picker (autocomplete by name/SKU)
  - Location picker (tree-aware, only `room|cabinet|shelf|bag|ambulance` types)
  - Qty (positive int)
  - Movement type: `receive` (default) / `adjustment_gain`
  - Reason / note
  - Submit → INSERT into `stock_movements` (trigger applies to `stock_item_locations`)
- Right side: "Recent movements" table (last 50, scrollable, real-time)

#### 7.1.3 ค้นของ (Item Finder)
- Search bar (full-width, mobile-friendly): name / SKU / barcode
- Result list: each row = one location with > 0 qty for the matched item:
  - SKU + name (top)
  - Location code + breadcrumb (`ROOM-A > CAB-A-1 > SHELF-A1-T1`)
  - Qty
  - Last updated timestamp
- Empty state: "ไม่พบรายการ — ลองสแกนบาร์โค้ดแทน"

### 7.2 Scan overlay (shared component, used in admin scan-receive)

- Full-screen mobile-style modal
- Top: instruction text (ภาษาไทย)
- Center: camera preview rectangle with scan crosshair
- Bottom: result chip (SKU/location code) + qty input + Submit
- Three-step state machine:
  1. **Scan item** — wait for barcode/QR matching `stock_items.barcode` OR `stock_items.sku` (Admin can also scan a SKU printed label)
  2. **Scan location** — wait for QR matching `locations.qr_payload` OR `locations.code`
  3. **Enter qty + submit** — manual qty input; submit posts `stock_movements` with `movement_type='receive'` and a fresh `client_ref_id = crypto.randomUUID()`
- Cancel button at any stage; "Re-scan" mini-button per chip

### 7.3 Staff page `staff-scan.html`

- Standalone page (NOT a tab inside `staff.html`); accessible from the Phase 0 staff landing via a big "📷 สแกนเบิก-จ่าย" button
- Same scan flow as 7.2 BUT with `movement_type='issue'` and `qty_delta` negated
- "Item Finder" link (read-only) at top — for "where is this located?" use case
- Pre-flight check: if camera permission denied → fallback to text input ("พิมพ์รหัส SKU" / "พิมพ์รหัสตู้")

Decision on which page(s) host the scanner — see Open Question 4.

### 7.4 Localization

All UI strings in Thai (matching Phase 0). Error messages use the same toast helper from `shared/ui.js`. No i18n framework in Phase 1.

---

## 8. RLS Policies (full Phase 1 set — extends Phase 0)

Already shown in §5.6. Summary of role matrix:

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `stock_categories` | authenticated | Admin | Admin | Admin |
| `stock_items` | authenticated | Admin | Admin | Admin |
| `stock_item_locations` | authenticated | trigger-only (no client policy) | trigger-only | trigger-only |
| `stock_movements` | authenticated | **Admin: any type; Staff: only `issue`/`adjustment_loss`** | — (immutable) | — (immutable) |

Reading: every authenticated user (Admin + Employee) can read all stock data — needed for the Item Finder. Writing is split per the PDF §1 RBAC table.

Edge-case behavior worth noting in tests:
- A Staff user crafting a `movement_type='receive'` request gets 403 from RLS even if they pass the right JWT — verified by T-test in §9.
- An Admin issuing stock writes the same `stock_movements` row a Staff would; the `performed_role` column captures whoever did it for audit.

---

## 9. Acceptance Tests (T24–T44, continuing from Phase 0 T23)

**Items & categories (T24–T28):**
- **T24** Admin creates a new category "GENERAL" already seeded; create a new "ITAS" category → row appears in `stock_categories`
- **T25** Admin creates a new item: name "ผ้าก๊อซ", SKU "SUP-GAUZE-001", barcode "8851234567890", category SUPPLY, threshold 20 → row in `stock_items`; appears in Items list with total_qty=0
- **T26** Admin creates an item with duplicate SKU → 409 inline error "SKU ซ้ำ"
- **T27** Employee navigates to admin → blocked (Phase 0 RLS still enforces); Employee posts `stock_items` INSERT via DevTools → 403
- **T28** Item Finder searches "ผ้า" → finds T25 item; with zero qty shows "ไม่มีในคลัง"

**Receive (T29–T32):**
- **T29** Admin opens Receive form, picks T25 item, picks ROOM-A, qty 100, submit → `stock_movements` row with `movement_type=receive`; `stock_item_locations` row with qty=100; `qty_after=100`
- **T30** Same item received at SHELF-A1-T1 qty 30 → `stock_item_locations` has TWO rows now (ROOM-A=100, SHELF-A1-T1=30); Items list shows total_qty=130
- **T31** Employee tries to POST `stock_movements` `movement_type=receive` via fetch in DevTools → 403 RLS
- **T32** Item Finder for "ผ้าก๊อซ" now lists both locations with breakdown

**Scan-receive (T33–T36):**
- **T33** Admin opens scan-receive overlay → grants camera → scans T25 barcode → SKU chip populated; scans ROOM-A QR → location chip populated; qty 50 → submit → `stock_movements` row + `client_ref_id` populated
- **T34** Replay same submission (network retry simulation) → 409 unique violation on `client_ref_id` → client treats as success-already-posted
- **T35** Scan an unknown barcode "0000000000000" → toast "ไม่พบสินค้า — ตรวจสอบ SKU"
- **T36** Scan a location QR that doesn't match any `locations.qr_payload`/`code` → toast "ไม่พบตู้/ชั้น"

**Issue / Staff scan (T37–T40):**
- **T37** Employee logs in → staff.html → "สแกนเบิก-จ่าย" → camera → scan T25 item + ROOM-A + qty 10 → submits → `stock_movements` row `movement_type=issue qty_delta=-10`; `stock_item_locations` ROOM-A qty=90 (was 100)
- **T38** Employee tries qty 200 (more than on hand) → trigger raises exception "would drive qty negative" → toast "ของไม่พอ" + no row created
- **T39** Employee scans an item not present at the chosen location (no `stock_item_locations` row) → trigger error "would drive qty negative" → same toast
- **T40** Admin Realtime: admin Inventory tab open in another browser → T37 issue → row updates live within ~1s

**Low-stock alert (T41–T43):**
- **T41** Set T25 reorder_threshold=20. Issue 110 (split across locations) bringing total to 20. Should be `<=` threshold → trigger fires → message in Telegram group (the Phase 0 chat_id) → `notification_log` row `event_type=low_stock`
- **T42** Issue another 5 same day → total now 15 → trigger fires again BUT dedupe_key already exists within 24h → `notification_log` shows the trigger hit `dedupe_hit=true` (no second Telegram message). To verify: count messages in Telegram chat (should be 1, not 2).
- **T43** Wait 24h (or manually expire the dedupe row in `notification_log`) → next issue triggers a fresh message

**Multi-Location (T44):**
- **T44** Two locations of same SKU; issue some from ROOM-A then issue more from SHELF-A1-T1 → both movements succeed; total_qty math correct; Item Finder reflects new per-location qty; only one low-stock alert when total crosses threshold (not per-location)

**Smoke tests (extend `tools/smoke-test.sh`):**
1. `SELECT count(*) FROM stock_items` → expected ≥ 0 (sanity)
2. `SELECT pg_get_publication_tables('supabase_realtime')` → includes `stock_items` and `stock_item_locations`
3. `SELECT current_setting('app.supabase_url', true)` → returns the project URL (verifies migration's ALTER DATABASE ran)
4. POST a fake low-stock event to `tg-notify` with `event_type=low_stock dedupe_key=smoke:test` → 200; second POST same dedupe_key → `dedupe_hit:true`

---

## 10. Out of Scope (and why)

| Item | Phase | Why deferred |
|---|---|---|
| Medication lots + expiry per lot + 30/60/90d alert | 2 | Different identity model (lot is a child of item, with own expiry). Schema hook `tracks_lots boolean` + `stock_movements.lot_id` already present in Phase 1 DDL. Phase 2 adds `stock_lots` table + `pg_cron` job. |
| Borrow/Return + overdue alert + photo proof | 3 | Adds a `stock_loans` table with state machine + Cloudinary upload. `movement_type` enum already reserves `borrow`/`return`. |
| ALS bag kit composition + restock | 4 | Uses Phase 0 `bag` location type; needs `kits` table (kit = template of items+qty). Out of Phase 1 because composition rules and "is this kit complete?" check are non-trivial. |
| Oxygen tank per-piece lifecycle | 5 | **Different identity model — per-piece serial.** A tank has a state (ready/onboard/refilling) and a refill history; SKU+qty doesn't fit. Phase 5 introduces `oxygen_tanks` table parallel to `stock_items`. (Cross-cutting: the Phase 1 dashboard count of "items" *excludes* oxygen.) |
| Linens cabinet count + photo | 6 | Item model fits but adds a per-cabinet count + laundry state machine. Phase 6 adds `linen_counts` per cabinet on a schedule. |
| Per-piece serial for general inventory | not planned | User confirmed: SKU + qty model only for Phase 1 inventory. Serial-tracked items are oxygen tanks (Phase 5) only. |
| Multi-Telegram-chat routing (per category, per alert type) | not planned | User confirmed single group reuse. Architecture supports it if needed (add `chat_id` column to `notification_log` + per-event mapping table). |
| Stock-take / cycle count workflow with auto-adjustment | Phase 2+ | Phase 1 supports manual `adjustment_gain`/`adjustment_loss` movements; a guided cycle-count UI is a separate feature. |
| Offline scan queue (SW background sync) | Phase 1.1 | Phase 1 ships online-only scan. The `client_ref_id` idempotency makes a later offline queue safe to add without schema change. |
| Label / barcode printing | not planned | Read-only barcode use only. Items without a printed barcode use their SKU as fallback (Admin can type instead of scan). |
| Image upload on items | Phase 3 | `image_url` column exists; Cloudinary wiring lands when Phase 3 needs it for borrow/return photo proof anyway. |

---

## 11. Open Questions

Five questions for PM (user "Pex") to resolve **before** plan write-up. I have a recommendation on each but flag the trade-offs.

### Q1 (Phase 1) — Multi-Location data model

The PDF §9 says one item can sit in multiple locations and we must show per-location qty. Three viable shapes:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A — `stock_items` + `stock_item_locations` join with per-location qty (RECOMMENDED)** | One row per item, many rows in join table with `qty` column | O(1) per-location read; simple aggregate `SUM(qty)`; clear UI mapping; easy to add Phase 2 lots as child of item *and* of `stock_item_locations` | qty is denormalized — must keep in sync with movements (handled by trigger) |
| B — `stock_movements` ledger only (event-sourced) | One row per change; qty = `SUM(qty_delta)` always | Pure audit trail; reversible; aligns with accounting | Every Item Finder query and dashboard does a SUM over the ledger → slow as ledger grows; needs materialized view → adds complexity Phase 1 doesn't need |
| C — Denormalized `current_qty` on items + placement records (no join table) | `stock_items.current_qty` + `stock_item_placements(item, location)` no qty | Simplest UI for "current total" | Loses per-location qty — explicitly required by PDF §9 Item Finder |

**Recommendation: A.** It pays for Phase 2+ extensibility (lots become a third dimension on top of `stock_item_locations`), serves the Item Finder hot path with no aggregation, and the movements ledger we keep alongside it gives us audit and reversibility "for free". The trigger in §5.5 keeps the denormalized qty correct on every write.

### Q2 (Phase 1) — RBAC nuance for stock_movements

PDF §1 distinguishes:
- **Receive (รับเข้า) — Admin only.** Use case: admin onboarding new inventory or restocking after purchase.
- **Issue (เบิก-จ่าย) — Staff allowed.** Use case: staff scans gauze off a shelf for a patient encounter.

The Phase 1 RLS in §5.6 implements this with split `INSERT` policies: `sm_insert_admin` (any type) vs `sm_insert_staff` (only `issue`/`adjustment_loss`).

**Question:** Should `adjustment_loss` (reporting damage / mis-count) be Staff-allowed, or Admin-only?

**My recommendation:** **Staff-allowed.** Real-world: a staff member finds 3 broken bottles → should be able to flag without waiting for admin. If PM wants tighter control, change Phase 1's policy to admin-only and add a Phase 2 workflow "request adjustment → admin approves".

### Q3 (Phase 1) — Low-stock dedupe window

Phase 0 seeded `LOW_STOCK_DEDUPE_HOURS=24`. PDF §3 doesn't specify.

**Options:**
- A. Keep 24h (one alert per SKU per day)
- B. Shorter: 4h or 8h (more responsive to repeat issues)
- C. Per-SKU configurable (column on `stock_items`)

**Recommendation: A (24h).** Matches Phase 0 default; matches operational rhythm of stock restock; tunable globally via `settings` table without code change. Per-SKU configurability is a Phase 2+ enhancement when we have data on alert fatigue.

### Q4 (Phase 1) — Scanner UX placement

The PDF §4 implies both Admin and Staff scan. Options:

| Option | Admin entry | Staff entry |
|---|---|---|
| A. New tab in `admin.html` + new page `staff-scan.html` (RECOMMENDED) | Inside Inventory tab, "📷 สแกนรับเข้า" button | Standalone page linked from staff.html |
| B. Single shared `scan.html` page used by both | Admin clicks link inside Inventory tab | Staff clicks link from staff.html |
| C. Scan only on staff side; Admin always manual form | Manual form only | Standalone page |

**Recommendation: A.** Admin-side scanner is in-context (inside the Inventory workflow) so admins doing a bulk receive don't context-switch out of the tab. Staff-side gets its own dedicated mobile page because staff almost always use scan, almost never need the rest of the admin tabs.

### Q5 (Phase 1) — Item categorization

PDF doesn't explicitly require categories for "general inventory". Options:

| Option | Phase 1 categories | Trade-off |
|---|---|---|
| A. None — items uncategorized in Phase 1 | Simpler migration | Items list has no filter; hard to navigate >50 items |
| B. **Minimal: 4-category seed, optional FK (RECOMMENDED)** | `GENERAL`, `SUPPLY`, `TOOL`, `CONSUME` seeded; `category_id nullable` | Quick to use; Phase 2+ extends taxonomy without migration; nullable so Admin can skip |
| C. Full taxonomy (multi-level tree) | Categories table with parent_id | Overengineering for Phase 1; defer to when we know real-world category needs |

**Recommendation: B.** Cheap to ship, useful for filtering, schema accommodates Phase 2's MEDICATION/ALS_KIT additions.

### Additional questions discovered during draft

- **Q6 — `pg_net` reliability for low-stock alert.** `pg_net` is async (fire-and-forget). If the function is briefly down, alerts are silently dropped (the trigger doesn't know). Mitigation options: (a) accept (consistent with Phase 0's design), (b) add a `pending_notifications` table that retries via `pg_cron`. **Recommend (a) for Phase 1.** Phase 0 already accepted this trade-off (Q11). If reliability becomes an issue, Phase 2 adds the retry table.
- **Q7 — Negative-qty error UX.** Trigger raises an exception when an issue would drive qty negative; the REST call gets a 400 with the PG message. UI translates to "ของไม่พอ — คงเหลือ X". Is that wording correct? (User may want stricter: "ของหมดสต๊อก" / "ไม่อนุญาตให้ติดลบ".)
- **Q8 — Decimal qty?** PDF doesn't say. Phase 1 uses `int`. If items like "เทป" (per meter) or "น้ำเกลือ" (per ml) are general inventory, we'd need numeric. **Recommend deferring** — Phase 2 medication likely revisits with `numeric(10,3)` for ml/mg.
- **Q9 — Display timezone for dedupe_key.** Trigger uses `Asia/Bangkok` for the date string. Confirms operator-local. Hard-coded in trigger; if Thegood expands across timezones, revisit.

---

## 12. Decisions Log

Mirroring Phase 0 spec format. IDs use `Q-Phase1-X` to avoid collision with Phase 0 Q1–Q18.

| ID | Question | Decision | Source |
|---|---|---|---|
| Q-Phase1-A | Item identity | **SKU + quantity**, no per-piece serial in Phase 1 | User decision 2026-05-18 |
| Q-Phase1-B | Intake methods | **Both manual Admin form AND QR/barcode scan** | User decision 2026-05-18 |
| Q-Phase1-C | Alert routing | **Single Telegram group**, reuse Phase 0 `NOTIFY_TELEGRAM_CHAT_ID` | User decision 2026-05-18 |
| Q-Phase1-D | Multi-Location model | **Option A — `stock_item_locations` join with per-location qty**, ledger as audit, trigger keeps qty correct | **User decision 2026-05-18** (confirmed Recommended) |
| Q-Phase1-E | Categorization in Phase 1 | **Option B — 4-category seed, optional FK** | This spec §11 Q5 (recommend; pending PM) |
| Q-Phase1-F | Scanner UX placement | **Option A — admin tab + dedicated `staff-scan.html`** | **User decision 2026-05-18** (confirmed Recommended) |
| Q-Phase1-G | RBAC for stock_movements | **Admin = any type; Staff = `issue`+`adjustment_loss` only** | PDF §1 + **User decision 2026-05-18** (confirmed Recommended) |
| Q-Phase1-H | Low-stock dedupe window | **24h, reusing Phase 0 `LOW_STOCK_DEDUPE_HOURS` setting** | This spec §11 Q3 (recommend; pending PM) |
| Q-Phase1-I | Edge Function additions | **None.** Trigger + `pg_net` + existing `tg-notify`. | §6 |
| Q-Phase1-J | Idempotency for scans | **`client_ref_id UUID UNIQUE` on `stock_movements`** | §5.4 / §6 |
| Q-Phase1-K | Realtime tables | **`stock_items` + `stock_item_locations`**; `stock_movements` excluded to limit noise | §3 row 6/7 + §5.7 |
| Q-Phase1-L | Movement type enum | **Includes Phase 3+ reserved values** (`borrow`/`return`/`transfer_*`) so future phases don't need enum-altering migrations | §5.4 |
| Q-Phase1-M | Why no Edge Function `scan-handler` | Trigger-based approach reuses Phase 0 plumbing; idempotency from `client_ref_id`; falls back to dedicated fn only if `pg_net` reliability becomes a problem (see Q6) | §6 |
| Q-Phase1-N | Qty type | **`int`** for Phase 1; revisit with `numeric` when Phase 2 medication needs it | §11 Q8 |
| Q-Phase1-O | Trigger dedupe-key timezone | **Asia/Bangkok** hard-coded in trigger date format | §11 Q9 |
| Q-Phase1-P | Oxygen does not inherit from `stock_items` | Oxygen tanks are per-piece serial → Phase 5 separate table | §10 + §1 out-of-scope |

---

## 13. Phase 1 Requirement → Acceptance Test Coverage Self-Check

Per the **verify before done** project rule. Each PDF Phase 1 requirement must map to ≥1 acceptance test.

| PDF requirement (Phase 1 portion) | Covered by |
|---|---|
| §4 General Inventory — add item, edit, deactivate | T25, T26 |
| §4 General Inventory — receive | T29, T30, T33, T34 |
| §4 General Inventory — issue (เบิก-จ่าย) | T37, T38, T39 |
| §4 General Inventory — low-stock alert via Telegram | T41, T42, T43 |
| §4 General Inventory — search by name/SKU/barcode | T28, T32 |
| §9 Multi-Location — same SKU in multiple locations | T30, T44 |
| §9 Multi-Location — Item Finder shows per-location qty | T32, T44 |
| §1 RBAC — Admin-only receive | T31 |
| §1 RBAC — Staff allowed issue | T37 |
| §1 RBAC — Staff blocked from admin pages | T27 (Phase 0 already covered base case in T8; Phase 1 confirms it for stock_items insert) |
| §2 Dashboard — inventory counter live updates | T40 |
| §3 Telegram — single chat reuse + dedupe | T41, T42, T43 |

**Self-check result:** Every Phase 1 requirement extracted from the PDF (per the scope confirmed in §1) has at least one acceptance test. No requirement-without-test gaps found.

---

## 14. Effort estimate

Given Phase 0 took ~1 session to design + implement + verify, Phase 1 is comparable in raw scope:

| Workstream | Effort |
|---|---|
| Migrations (5 new files + view + triggers + RLS + realtime) | 0.5 day |
| Frontend admin tab (3 sub-views + recent-movements + Realtime wiring) | 1.0 day |
| Frontend staff scan page + shared scanner wrapper | 0.5 day |
| Test pass T24–T44 | 0.5 day |
| Buffer for first-real-trigger debugging + PM review feedback | 0.5 day |
| **Total** | **~3 days** (or 1 focused multi-session block, similar to Phase 0) |

Risk factors that could push it longer:
- `BarcodeDetector` API support on user's actual mobile devices — may need to fall back to `html5-qrcode` for all paths (adds ~0.25 day)
- `pg_net` egress from Supabase free tier — first real test; if blocked, fallback to Edge Function `scan-handler` (adds ~0.5 day)
- Realtime subscription churn when many staff are scanning — may need debounce tuning (adds ~0.25 day)

---

## 15. Next Step

When this DRAFT is approved by PM:
1. Resolve the 5 open questions in §11 (or accept the recommendations)
2. Hand off to `superpowers:writing-plans` to produce `docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md`
3. Execute the plan; verify all T24–T44 pass; tag `phase1-inventory`
