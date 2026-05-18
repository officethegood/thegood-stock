# DRAFT — Phase 1 Inventory Implementation Plan (pending PM review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT — pending PM (user "Pex") review. Do not execute until approved.
**Predecessor:** [`docs/superpowers/plans/2026-05-18-phase0-foundation-plan.md`](2026-05-18-phase0-foundation-plan.md) (Phase 0 — shipped)
**Source of truth:** [`docs/superpowers/specs/2026-05-18-phase1-inventory-design.md`](../specs/2026-05-18-phase1-inventory-design.md)

---

## Pre-implementation findings (dissent log)

The plan author ran the spec, the PDF, the existing artifacts, and the locked decisions through the **no magic / verify before done / dissent / scope drift** rules. Findings below are flagged for PM review **before** any task starts.

### F1. PDF coverage — gaps & near-gaps

| PDF requirement | Spec §13 status | Plan stance |
|---|---|---|
| §4 add / edit / **deactivate** item | Listed as "T25, T26" | T25/T26 cover **create + duplicate**; **no test for deactivate**. Plan adds a verification step inside Task D2 (admin form supports `active=false` toggle) and a new T26b sub-test ("deactivate hides item from staff Item Finder"). Logged as suggestion for spec §13 — **not editing the spec**. |
| §4 issue (เบิก-จ่าย) — staff scan flow including **photo evidence for damage** | Spec §10 says "Image upload on items deferred to Phase 3" | The PDF §1 only mandates photo evidence for **borrow-return (§6)** and **laundry (§8)**, *not* for general issue. **adjustment_loss** is not explicitly photo-mandated in PDF §4. Plan keeps photo upload **optional** on `adjustment_loss` (file input, soft, can be skipped). No spec edit needed but flagged so PM can override. |
| §2 Dashboard — "สถานะสินค้าคงเหลือ (current stock total)" + "low-stock list" | Listed as "T40" (Realtime only) | T40 verifies live update but does **not** verify the dashboard panels themselves render the count & list. Plan adds Task F2 with explicit "open dashboard, see total items + low-stock list" verification. |
| §2 Dashboard — "ภาพรวมสินค้าหมดอายุ (expiry overview)" | — | Out of scope per spec §1 (deferred to Phase 2). Plan does **not** add an expiry panel; documented in Deferred section. |
| §2 Dashboard — "สถานะอุปกรณ์ยืม-คืน (borrow status)" | — | Out of scope per spec §1 (deferred to Phase 3). |
| §3 Telegram — **low-stock only** in Phase 1 | Covered T41-T43 | OK — expiry & overdue alerts are Phase 2/3. |
| §4 — "การตัดยอดอัตโนมัติ (auto-deduct on issue)" | Covered by trigger §5.5.2 + T37 | OK. |
| §9 Multi-Location — item finder "shows location immediately" | Covered T28, T32 | OK. |
| PDF summary table row "general items: QR Code on item, track stock + location" | All covered | OK. |

**Net:** No requirement-without-task gap that blocks Phase 1. Two small additions (deactivate test, dashboard render test) are folded into the plan but **not** back-ported into the spec — per project rule "don't modify the spec".

### F2. Spec-vs-Phase-0-reality reconciliation

- Spec §5.5 uses `current_setting('app.supabase_url', true)` and `current_setting('app.service_role_key', true)` inside the trigger. Phase 0 did **not** set these `ALTER DATABASE` parameters. **Plan Task B5 adds them explicitly** (paste-in step + verification SQL).
- Spec §6 says "no new Edge Functions". This is correct, but the trigger calls `tg-notify` via `pg_net` using `X-Internal: true` + `service_role_key`. Phase 0's `tg-notify` already accepts this auth path (`isAuthorized()` checks `internal && token === SERVICE_ROLE_KEY` — verified in `supabase/functions/tg-notify/index.ts`). **No tg-notify code change required.**
- Spec §4 lists `inventory-finder.js` and `inventory-scan.js` as separate JS files; spec §5 / §7 keep their behavior inside the admin Inventory tab. Plan splits the work this way: `js/inventory.js` is the tab shell, `js/inventory-finder.js` is the Item Finder panel module, `js/inventory-scan.js` is the scan overlay module — all loaded from `admin.html`. Matches spec §4 file list exactly.
- Phase 0 `sw.js` `CACHE_VERSION = 'thegood-stock-v0.1.0'`. Phase 1 plan bumps to `v0.2.0` (Task G1).

### F3. Locked-decisions sanity check

Every locked decision (Q-Phase1-A through Q-Phase1-O) is consistent with this plan. No contradictions found. Spec §11 Q5 (categorization) and Q3 (dedupe window) were not yet PM-confirmed in the spec table — **plan assumes the recommendations (Option B for Q5, 24h for Q3) per the user's locked-decisions list passed to the plan author**.

### F4. Assumptions made by the plan (not in spec)

| # | Assumption | Why safe |
|---|---|---|
| A1 | Migration timestamps `20260519000000…000700` are unused (next-day pattern) | Phase 0 ended at `20260518000600` — next day is fine. |
| A2 | `html5-qrcode@2.3.8` CDN is reachable from Thailand | Stated in spec §4. Plan still adds a fallback "type SKU manually" path (spec §7.3). |
| A3 | Trigger uses **`SECURITY DEFINER`** so it can read `app.service_role_key` regardless of caller | Standard Postgres pattern; verified by checking Phase 0 migrations (no DEFINER security on existing triggers — but the existing triggers don't need it; the new low-stock trigger does because `current_setting('app.service_role_key', true)` is owned-by-`postgres` only). |
| A4 | The `v_stock_items_with_total` view inherits RLS from underlying tables when defined `SECURITY INVOKER` (default) | True per Postgres docs; plan adds explicit comment. |
| A5 | Staff scan page is reachable from staff.html via a button; no new redirect logic needed | Matches spec §7.3. |

---

## Goal

Turn the Phase 0 foundation into a working general-inventory system at Thegood: master items + multi-location quantity + admin/staff scan flows + Item Finder + low-stock Telegram alerts, fully wired end-to-end on top of the Phase 0 auth, RLS, Realtime, locations, and notification pipes. Phase 1 ships **only** the non-medication, non-ALS, non-oxygen, non-linen subset of the PDF (per spec §1 scope).

## Architecture summary

Phase 1 is purely additive on Phase 0. Browsers (admin + staff) talk to Supabase REST + Realtime; all writes flow through PostgREST with RLS doing authorization. A new `stock_movements` ledger is the audit trail; an `AFTER INSERT` trigger applies each row to the denormalized qty-per-location table `stock_item_locations` and, on negative deltas, checks the SUM(qty) vs the per-item `reorder_threshold`, firing a `pg_net` POST to the existing `tg-notify` Edge Function with a Bangkok-local `dedupe_key` — same plumbing Phase 0 designed for. Realtime subscribes to `stock_items` + `stock_item_locations` only. No new Edge Function.

## Tech Stack

Vanilla HTML/JS + Bootstrap 5 + `html5-qrcode` (CDN, lazy-loaded) on the front end; Postgres + `pg_net` + Realtime + Phase 0 `tg-notify` Edge Function on the back end; GitHub Pages hosting.

## Testing approach

Same manual-checklist pattern as Phase 0 (per Phase 0 Q16). Each task ends with a concrete verification: curl/SQL/screenshot/observed Telegram message. The 21 new acceptance tests **T24–T44** from spec §9 are run as the Phase G final checklist (Task G3) after all build tasks pass their per-task verification. Trigger-level invariants get small SQL smoke tests (Task G2). Edge Function code is unchanged from Phase 0 so no new Deno unit tests are added.

## Source of truth

[`docs/superpowers/specs/2026-05-18-phase1-inventory-design.md`](../specs/2026-05-18-phase1-inventory-design.md) — locked decisions Q-Phase1-A through Q-Phase1-O are binding. Acceptance tests T24–T44 live in §9 of that file.

---

## Reading order

This plan has 7 execution phases (A–G). Within a phase tasks are sequential. Phase A (DB) must finish before B (trigger), which must finish before D/E (frontend writes). Phase C (shared modules) can run in parallel with later A tasks if needed.

| Phase | Tasks | Focus |
|---|---|---|
| A | A1–A7 | DB migrations: categories, items, item-locations, movements, view, RLS, realtime |
| B | B1–B5 | Trigger functions + low-stock alert wiring + DB parameters |
| C | C1–C3 | Shared frontend modules: `inventory.js`, `scanner.js`, finder helper |
| D | D1–D7 | Admin Inventory tab: items list, form, receive, scan-receive, finder panel, realtime |
| E | E1–E4 | Staff scan page: `staff-scan.html` + issue + adjustment_loss + manual fallback |
| F | F1–F2 | Item Finder embed on staff.html + Dashboard inventory panels |
| G | G1–G4 | SW bump + smoke tests + manual checklist T24–T44 + docs |

Effort estimate (per spec §14): Phase A 0.4d, B 0.3d, C 0.4d, D 0.9d, E 0.5d, F 0.3d, G 0.4d → **~3.2 days** (or one focused multi-session block).

---

# Phase A — Database migrations

All migration files go under `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\` with the timestamp prefixes shown in spec §4.

## Task A1: Migration — stock_categories + seed

**Spec ref:** §5.1, Q-Phase1-E.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519000000_stock_categories.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260519000000_stock_categories.sql
-- Phase 1 — Optional category lookup. Spec §5.1, Q-Phase1-E.

CREATE TABLE stock_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  active      boolean DEFAULT true,
  sort_order  int DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

INSERT INTO stock_categories(code, name, sort_order) VALUES
  ('GENERAL',  'ทั่วไป',          10),
  ('SUPPLY',   'วัสดุสิ้นเปลือง',  20),
  ('TOOL',     'อุปกรณ์ใช้ซ้ำ',    30),
  ('CONSUME',  'ของใช้แล้วทิ้ง',    40);
```

- [ ] **Step 2: Apply locally / push**

```bash
cd "F:/@Coding/ระบบ/The Good Stock"
supabase db push
```

- [ ] **Step 3: Verify**

In Supabase SQL editor:

```sql
SELECT code, name, sort_order FROM stock_categories ORDER BY sort_order;
```

Expected: 4 rows, `GENERAL / SUPPLY / TOOL / CONSUME`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260519000000_stock_categories.sql
git commit -m "feat(db): stock_categories lookup + 4-seed (Phase 1)"
```

---

## Task A2: Migration — stock_items master

**Spec ref:** §5.2, Q-Phase1-A, Q-Phase1-N.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519000100_stock_items.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260519000100_stock_items.sql
-- Phase 1 — Items master. Spec §5.2.
-- Qty type is int (Q-Phase1-N). Phase 2 may switch reorder_threshold to numeric.

CREATE TABLE stock_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                 text UNIQUE NOT NULL,
  barcode             text UNIQUE,
  name                text NOT NULL,
  name_en             text,
  category_id         uuid REFERENCES stock_categories(id),
  unit                text NOT NULL DEFAULT 'ชิ้น',
  reorder_threshold   int NOT NULL DEFAULT 0,
  tracks_lots         boolean NOT NULL DEFAULT false,  -- Phase 2 hook
  tracks_serial       boolean NOT NULL DEFAULT false,  -- Phase 5 hook
  image_url           text,                            -- Phase 3 wires UI
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

- [ ] **Step 2: Push**

```bash
supabase db push
```

- [ ] **Step 3: Verify schema**

```sql
\d stock_items
```

(Or via PostgREST:)

```bash
curl -sS "https://<PROJECT_REF>.supabase.co/rest/v1/stock_items?select=id&limit=1" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```

Expected: empty array `[]` (200). Errors would mean schema didn't apply.

- [ ] **Step 4: Verify GIN index (text search readiness for Item Finder)**

```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'stock_items';
```

Expected: `idx_stock_items_name`, `idx_stock_items_barcode`, `idx_stock_items_category`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260519000100_stock_items.sql
git commit -m "feat(db): stock_items master + GIN name index (Phase 1)"
```

---

## Task A3: Migration — stock_item_locations + qty view

**Spec ref:** §5.3, §7.1.1 (view), Q-Phase1-D.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519000200_stock_item_locations.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260519000200_stock_item_locations.sql
-- Phase 1 — Per-location qty. Spec §5.3 + §7.1.1.

CREATE TABLE stock_item_locations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id          uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id      uuid NOT NULL REFERENCES locations(id)   ON DELETE RESTRICT,
  qty              int  NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_movement_at timestamptz,
  updated_at       timestamptz DEFAULT now(),
  UNIQUE (item_id, location_id)
);
CREATE INDEX idx_sil_item     ON stock_item_locations(item_id);
CREATE INDEX idx_sil_location ON stock_item_locations(location_id);
CREATE INDEX idx_sil_nonzero  ON stock_item_locations(item_id) WHERE qty > 0;
CREATE TRIGGER trg_sil_updated_at BEFORE UPDATE ON stock_item_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- View used by Admin Items list (§7.1.1) — total qty across all locations per item.
-- SECURITY INVOKER (default) so RLS on base tables still applies.
CREATE VIEW v_stock_items_with_total AS
SELECT si.*, COALESCE(SUM(sil.qty), 0)::int AS total_qty
FROM stock_items si
LEFT JOIN stock_item_locations sil ON sil.item_id = si.id
GROUP BY si.id;
```

- [ ] **Step 2: Push + verify**

```bash
supabase db push
```

```sql
SELECT count(*) FROM stock_item_locations;     -- expect 0
SELECT count(*) FROM v_stock_items_with_total; -- expect 0
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260519000200_stock_item_locations.sql
git commit -m "feat(db): stock_item_locations + total-qty view (Phase 1)"
```

---

## Task A4: Migration — stock_movements ledger + enum

**Spec ref:** §5.4, Q-Phase1-J, Q-Phase1-L.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519000300_stock_movements.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260519000300_stock_movements.sql
-- Phase 1 — Ledger / audit trail. Spec §5.4.
-- Enum includes Phase 3+ reserved values per Q-Phase1-L.

CREATE TYPE stock_movement_type AS ENUM (
  'receive',
  'issue',
  'adjustment_gain',
  'adjustment_loss',
  'transfer_out',     -- reserved (Phase 1 records pair as issue+receive)
  'transfer_in',      -- reserved
  'borrow',           -- reserved Phase 3
  'return'            -- reserved Phase 3
);

CREATE TABLE stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ref_id       uuid UNIQUE,                          -- Q-Phase1-J idempotency
  item_id             uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id         uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  movement_type       stock_movement_type NOT NULL,
  qty_delta           int NOT NULL CHECK (qty_delta <> 0),
  qty_after           int,                                  -- filled by trigger (B2)
  reason              text,
  note                text,
  lot_id              uuid,                                 -- Phase 2 hook
  source_movement_id  uuid REFERENCES stock_movements(id),  -- borrow-return / transfer pair
  performed_by        text NOT NULL DEFAULT app_username(),
  performed_role      text NOT NULL DEFAULT app_user_role(),
  performed_at        timestamptz DEFAULT now()
);
CREATE INDEX idx_sm_item      ON stock_movements(item_id, performed_at);
CREATE INDEX idx_sm_location  ON stock_movements(location_id, performed_at);
CREATE INDEX idx_sm_performed ON stock_movements(performed_at);
```

- [ ] **Step 2: Push + verify**

```bash
supabase db push
```

```sql
SELECT enumlabel FROM pg_enum WHERE enumtypid = 'stock_movement_type'::regtype ORDER BY enumsortorder;
```

Expected: 8 rows, in declared order.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260519000300_stock_movements.sql
git commit -m "feat(db): stock_movements ledger + enum (Phase 1)"
```

---

## Task A5: Migration — RLS policies for stock_* tables

**Spec ref:** §5.6, §8, Q-Phase1-G.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519000500_stock_rls.sql`

(Filename matches spec §4. Note: number 400 is for triggers in Task B1, applied **after** RLS so triggers can rely on table existence; ordering of 400 vs 500 here is OK because triggers run as `postgres` role and bypass RLS.)

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260519000500_stock_rls.sql
-- Phase 1 — Row-level security. Spec §5.6, Q-Phase1-G.

ALTER TABLE stock_categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_item_locations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements        ENABLE ROW LEVEL SECURITY;

-- stock_categories
CREATE POLICY scat_read  ON stock_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY scat_write ON stock_categories FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- stock_items
CREATE POLICY si_read  ON stock_items FOR SELECT TO authenticated USING (true);
CREATE POLICY si_write ON stock_items FOR ALL    TO authenticated
  USING (app_user_role() = 'Admin') WITH CHECK (app_user_role() = 'Admin');

-- stock_item_locations — read all; writes ONLY via trigger (postgres role)
CREATE POLICY sil_read ON stock_item_locations FOR SELECT TO authenticated USING (true);
-- (No INSERT/UPDATE/DELETE policies for `authenticated` → trigger-only writes.)

-- stock_movements
CREATE POLICY sm_read         ON stock_movements FOR SELECT TO authenticated USING (true);
CREATE POLICY sm_insert_admin ON stock_movements FOR INSERT TO authenticated
  WITH CHECK (app_user_role() = 'Admin');
CREATE POLICY sm_insert_staff ON stock_movements FOR INSERT TO authenticated
  WITH CHECK (
    app_user_role() IN ('Admin','Employee')
    AND movement_type IN ('issue','adjustment_loss')
  );
-- No UPDATE / DELETE policies — movements are immutable. Corrections = reverse-movements.
```

- [ ] **Step 2: Push + verify**

```bash
supabase db push
```

```sql
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('stock_categories','stock_items','stock_item_locations','stock_movements')
ORDER BY tablename, policyname;
```

Expected:
- `stock_categories`: `scat_read`, `scat_write`
- `stock_items`: `si_read`, `si_write`
- `stock_item_locations`: `sil_read`
- `stock_movements`: `sm_insert_admin`, `sm_insert_staff`, `sm_read`

- [ ] **Step 3: Smoke — staff cannot insert receive (T31 dry run)**

```bash
# With a Staff JWT (from Phase 0 login)
curl -i -X POST "https://<PROJECT_REF>.supabase.co/rest/v1/stock_movements" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <STAFF_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"item_id":"00000000-0000-0000-0000-000000000000","location_id":"00000000-0000-0000-0000-000000000000","movement_type":"receive","qty_delta":1}'
```

Expected: `HTTP/2 403` (RLS) or `400` (FK violation) — either way **never** 201. If 201 → RLS broken, halt.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260519000500_stock_rls.sql
git commit -m "feat(db): RLS for stock_* — admin/staff split (Phase 1)"
```

---

## Task A6: Migration — Realtime publication

**Spec ref:** §3, §5.7, Q-Phase1-K.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519000600_stock_realtime.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/20260519000600_stock_realtime.sql
-- Phase 1 — Realtime tables. Q-Phase1-K (stock_movements EXCLUDED to limit noise).

ALTER PUBLICATION supabase_realtime ADD TABLE stock_items;
ALTER PUBLICATION supabase_realtime ADD TABLE stock_item_locations;
```

- [ ] **Step 2: Push + verify**

```bash
supabase db push
```

```sql
SELECT schemaname, tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' ORDER BY tablename;
```

Expected: list **includes** `stock_items` and `stock_item_locations`. Does **not** include `stock_movements`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260519000600_stock_realtime.sql
git commit -m "feat(db): realtime publication for stock_items + stock_item_locations"
```

---

## Task A7: Phase A integration check

- [ ] **Step 1: Confirm every Phase A migration applied in order**

```sql
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version LIKE '20260519%' ORDER BY version;
```

Expected: 5 rows (000000, 000100, 000200, 000300, 000500, 000600) — note `000400` lands in Task B1.

- [ ] **Step 2: Take pre-trigger snapshot**

```bash
supabase db dump --schema public > tools/snapshots/$(date +%Y%m%d-%H%M)-phase1a.sql
git add tools/snapshots/
git commit -m "chore(db): snapshot after Phase 1A migrations"
```

---

# Phase B — Trigger + low-stock alert wiring

## Task B1: Migration — stock triggers (sign / apply / low-stock)

**Spec ref:** §5.5.1, §5.5.2, §5.5.3. Q-Phase1-I, Q-Phase1-O.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\supabase\migrations\20260519000400_stock_triggers.sql`

- [ ] **Step 1: Write migration — sign enforcement (§5.5.1)**

```sql
-- supabase/migrations/20260519000400_stock_triggers.sql
-- Phase 1 — Triggers: sign, apply-to-SIL, low-stock alert. Spec §5.5.

-- 1) BEFORE INSERT — enforce qty_delta sign matches movement_type
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
```

- [ ] **Step 2: Append — apply-to-SIL + snapshot qty_after (§5.5.2)**

```sql
-- 2) AFTER INSERT — apply to stock_item_locations + write qty_after snapshot
CREATE OR REPLACE FUNCTION apply_movement_to_sil() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
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
```

- [ ] **Step 3: Append — low-stock alert via pg_net → tg-notify (§5.5.3)**

```sql
-- 3) AFTER INSERT — low-stock check on negative deltas only
CREATE OR REPLACE FUNCTION check_low_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
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
  IF NEW.qty_delta >= 0 THEN RETURN NEW; END IF;

  SELECT sku, name, reorder_threshold INTO v_sku, v_name, v_threshold
  FROM stock_items WHERE id = NEW.item_id;

  IF v_threshold <= 0 THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(qty), 0) INTO v_total
  FROM stock_item_locations WHERE item_id = NEW.item_id;

  IF v_total > v_threshold THEN RETURN NEW; END IF;

  -- Asia/Bangkok dedupe key per Q-Phase1-O
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

- [ ] **Step 4: Push**

```bash
supabase db push
```

- [ ] **Step 5: Verify triggers exist**

```sql
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'stock_movements'::regclass AND NOT tgisinternal
ORDER BY tgname;
```

Expected: `trg_sm_apply`, `trg_sm_lowstock`, `trg_sm_sign`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260519000400_stock_triggers.sql
git commit -m "feat(db): movement sign + SIL apply + low-stock pg_net trigger"
```

---

## Task B2: Set database parameters for trigger (`app.supabase_url`, `app.service_role_key`)

**Spec ref:** §5.5 note ("paste-in step"). Finding F2.

These two `current_setting()` lookups in the low-stock trigger require database-level parameters that Phase 0 did **not** set. They must be applied via `ALTER DATABASE` once per project.

**Files:** None — runs as one-off SQL.

- [ ] **Step 1: Discover project ref + service role key**

```bash
supabase projects list
# Copy the URL: https://<PROJECT_REF>.supabase.co
# Service role key from Supabase Dashboard → Settings → API → service_role
```

- [ ] **Step 2: Apply ALTER DATABASE (one-off, in SQL editor as project owner)**

```sql
-- Replace <PROJECT_REF> and <SRK> with real values from Step 1
ALTER DATABASE postgres SET app.supabase_url       = 'https://<PROJECT_REF>.supabase.co';
ALTER DATABASE postgres SET app.service_role_key   = '<SERVICE_ROLE_KEY>';
```

Note: `ALTER DATABASE` only takes effect for **new** connections. Existing pooled connections need to reconnect (in practice, wait ~30s).

- [ ] **Step 3: Verify in a fresh SQL session**

```sql
SELECT current_setting('app.supabase_url', true) AS url,
       length(current_setting('app.service_role_key', true)) AS srk_len;
```

Expected: `url` = your project URL; `srk_len` ≈ 200+. If either is NULL, the trigger will fail at insert time with "permission denied for parameter".

- [ ] **Step 4: Document in deploy.md**

Add a section to `docs/deploy.md` (edited later in Task G4):

```markdown
## Phase 1 — One-off DB parameters

After applying Phase 1 migrations, set:

```sql
ALTER DATABASE postgres SET app.supabase_url     = 'https://<PROJECT_REF>.supabase.co';
ALTER DATABASE postgres SET app.service_role_key = '<SRK>';
```

Required by the `check_low_stock()` trigger to POST to `tg-notify` via `pg_net`.
```

- [ ] **Step 5: No git commit yet** (no file changed — note only). Continue.

---

## Task B3: Smoke test the trigger chain end-to-end (no Telegram yet)

**Spec ref:** §9 T29 dry run.

- [ ] **Step 1: Create a dummy item via SQL (bypasses RLS for now using SQL editor as `postgres`)**

```sql
-- Use the existing seed category SUPPLY
INSERT INTO stock_items(sku, name, category_id, unit, reorder_threshold)
SELECT 'TEST-001', 'ทดสอบ', id, 'ชิ้น', 5
FROM stock_categories WHERE code='SUPPLY';
```

- [ ] **Step 2: Receive 10 at any existing ROOM-A location**

```sql
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
SELECT
  (SELECT id FROM stock_items WHERE sku='TEST-001'),
  (SELECT id FROM locations  WHERE code='ROOM-A' LIMIT 1),
  'receive', 10;
```

- [ ] **Step 3: Verify ripple**

```sql
SELECT m.movement_type, m.qty_delta, m.qty_after, s.qty AS sil_qty
FROM stock_movements m
JOIN stock_item_locations s ON s.item_id = m.item_id AND s.location_id = m.location_id
WHERE m.item_id = (SELECT id FROM stock_items WHERE sku='TEST-001')
ORDER BY m.performed_at DESC LIMIT 1;
```

Expected: `movement_type=receive`, `qty_delta=10`, `qty_after=10`, `sil_qty=10`.

- [ ] **Step 4: Issue 6 — should NOT trigger low-stock (total=4 ≤ threshold=5 → fires)**

```sql
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
SELECT
  (SELECT id FROM stock_items WHERE sku='TEST-001'),
  (SELECT id FROM locations  WHERE code='ROOM-A' LIMIT 1),
  'issue', -6;

SELECT event_type, dedupe_key, success, error
FROM notification_log
WHERE entity_id = (SELECT id::text FROM stock_items WHERE sku='TEST-001')
ORDER BY sent_at DESC LIMIT 1;
```

Expected: one row, `event_type=low_stock`, `success=true` if Telegram enabled, or `success=false` with detail if disabled / wrong chat_id. **A row at all** confirms the trigger reached `tg-notify`.

- [ ] **Step 5: Issue more — verify dedupe (T42 dry run)**

```sql
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
SELECT
  (SELECT id FROM stock_items WHERE sku='TEST-001'),
  (SELECT id FROM locations  WHERE code='ROOM-A' LIMIT 1),
  'issue', -1;

SELECT count(*) FROM notification_log
WHERE dedupe_key LIKE 'low_stock:TEST-001:%';
```

Expected: still **1 row** (deduped within 24h).

- [ ] **Step 6: Clean up test data**

```sql
DELETE FROM stock_movements      WHERE item_id = (SELECT id FROM stock_items WHERE sku='TEST-001');
DELETE FROM stock_item_locations WHERE item_id = (SELECT id FROM stock_items WHERE sku='TEST-001');
DELETE FROM stock_items          WHERE sku='TEST-001';
DELETE FROM notification_log     WHERE dedupe_key LIKE 'low_stock:TEST-001:%';
```

- [ ] **Step 7: Commit nothing — verification only.** Halt the plan and escalate to PM if any step fails.

---

## Task B4: Verify negative-qty guard (T38 / T39 dry run)

**Spec ref:** §9 T38, T39.

- [ ] **Step 1: Create a fresh test item with no stock**

```sql
INSERT INTO stock_items(sku, name, reorder_threshold) VALUES ('TEST-NEG','ทดสอบติดลบ', 0);
```

- [ ] **Step 2: Try to issue 1 — should fail**

```sql
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
SELECT
  (SELECT id FROM stock_items WHERE sku='TEST-NEG'),
  (SELECT id FROM locations   WHERE code='ROOM-A' LIMIT 1),
  'issue', -1;
```

Expected: ERROR `movement would drive qty negative for item ... at location ...`. **No row inserted.**

- [ ] **Step 3: Clean up**

```sql
DELETE FROM stock_items WHERE sku='TEST-NEG';
```

- [ ] **Step 4: Verification-only — no commit.**

---

## Task B5: Phase B integration check + snapshot

- [ ] **Step 1: Confirm `pg_net` extension installed (Phase 0)**

```sql
SELECT extname FROM pg_extension WHERE extname='pg_net';
```

Expected: 1 row.

- [ ] **Step 2: Snapshot DB after triggers**

```bash
supabase db dump --schema public > tools/snapshots/$(date +%Y%m%d-%H%M)-phase1b.sql
git add tools/snapshots/
git commit -m "chore(db): snapshot after Phase 1B triggers + DB params"
```

---

# Phase C — Frontend shared modules

These two modules are reused by both admin (Inventory tab) and staff (`staff-scan.html`).

## Task C1: shared/inventory.js — REST + Realtime helpers

**Spec ref:** §3 rows 6/7/13/14/15, §7.1.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\shared\inventory.js`

- [ ] **Step 1: Write file**

```javascript
// shared/inventory.js
// REST + Realtime helpers for Phase 1 inventory. Spec §3 + §7.

(function () {

  // ---- Categories ----
  async function listCategories() {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('stock_categories')
      .select('id,code,name,sort_order,active').eq('active', true).order('sort_order');
    if (error) throw error;
    return data;
  }

  // ---- Items ----
  async function listItemsWithTotal(opts = {}) {
    const sb = getSupabaseClient();
    let q = sb.from('v_stock_items_with_total')
      .select('id,sku,barcode,name,category_id,unit,reorder_threshold,active,total_qty');
    if (opts.q) {
      const like = `%${opts.q}%`;
      q = q.or(`name.ilike.${like},sku.ilike.${like},barcode.ilike.${like}`);
    }
    if (opts.activeOnly !== false) q = q.eq('active', true);
    if (opts.lowOnly) q = q.lte('total_qty', sb.rpc); // see Step 1b note
    q = q.order('name').limit(opts.limit ?? 200);
    const { data, error } = await q;
    if (error) throw error;
    return opts.lowOnly
      ? data.filter((r) => r.reorder_threshold > 0 && r.total_qty <= r.reorder_threshold)
      : data;
  }

  async function createItem(payload) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('stock_items').insert(payload).select().single();
    if (error) throw error;
    return data;
  }

  async function updateItem(id, patch) {
    const sb = getSupabaseClient();
    patch.updated_by = getUserUsername();
    const { data, error } = await sb.from('stock_items').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async function findItemByCode(code) {
    // Used by scanner: code can be barcode OR sku
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('stock_items')
      .select('id,sku,barcode,name,unit,reorder_threshold,active')
      .or(`barcode.eq.${code},sku.eq.${code}`).eq('active', true).limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  }

  // ---- Locations (Phase 0 table, used by scan flow) ----
  async function findLocationByCode(code) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('locations')
      .select('id,code,name,type,parent_id,qr_payload,active')
      .or(`qr_payload.eq.${code},code.eq.${code}`).eq('active', true).limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  }

  // ---- Item Finder (per-location breakdown) ----
  async function findItemLocations(itemId) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('stock_item_locations')
      .select('id,location_id,qty,last_movement_at,locations(code,name,type,parent_id)')
      .eq('item_id', itemId).gt('qty', 0).order('qty', { ascending: false });
    if (error) throw error;
    return data;
  }

  // ---- Movements ----
  async function postMovement({ item_id, location_id, movement_type, qty_delta, reason, note, client_ref_id }) {
    const sb = getSupabaseClient();
    const ref = client_ref_id || crypto.randomUUID();
    const { data, error } = await sb.from('stock_movements').insert({
      item_id, location_id, movement_type, qty_delta, reason, note, client_ref_id: ref,
    }).select().single();
    if (error) {
      // 409 on client_ref_id duplicate = idempotent retry
      if (error.code === '23505' && /client_ref_id/.test(error.message)) {
        return { ok: true, idempotent_replay: true, client_ref_id: ref };
      }
      throw error;
    }
    return { ok: true, movement: data };
  }

  async function listRecentMovements(limit = 50) {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('stock_movements')
      .select('id,movement_type,qty_delta,qty_after,performed_at,performed_by,performed_role,note,stock_items(sku,name),locations(code,name)')
      .order('performed_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data;
  }

  // ---- Realtime ----
  function subscribeInventory(onChange) {
    const sb = getSupabaseClient();
    const ch = sb.channel('inv:phase1')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_items' },          (p) => onChange('stock_items', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_item_locations' }, (p) => onChange('stock_item_locations', p))
      .subscribe();
    return () => sb.removeChannel(ch);
  }

  window.invListCategories      = listCategories;
  window.invListItems           = listItemsWithTotal;
  window.invCreateItem          = createItem;
  window.invUpdateItem          = updateItem;
  window.invFindItemByCode      = findItemByCode;
  window.invFindLocationByCode  = findLocationByCode;
  window.invFindItemLocations   = findItemLocations;
  window.invPostMovement        = postMovement;
  window.invListRecentMovements = listRecentMovements;
  window.invSubscribe           = subscribeInventory;
})();
```

Note Step 1b: the `sb.rpc` placeholder in `lowOnly` path is unused — we filter client-side after fetch because PostgREST cannot do `col <= other_col` in a `.lte()` chain. The client-side filter is cheap (the result set is already bounded by `limit`).

- [ ] **Step 2: Quick smoke in DevTools (admin tab open, F12 console)**

```javascript
await window.invListCategories(); // expect 4 categories
await window.invListItems();      // expect [] until Phase D adds items
```

- [ ] **Step 3: Commit**

```bash
git add shared/inventory.js
git commit -m "feat(ui): shared inventory module — REST + realtime helpers (Phase 1)"
```

---

## Task C2: shared/scanner.js — BarcodeDetector + html5-qrcode fallback

**Spec ref:** §4 (lib choice), §7.2.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\shared\scanner.js`

- [ ] **Step 1: Write file**

```javascript
// shared/scanner.js
// Wraps native BarcodeDetector with html5-qrcode fallback (Safari < 17).
// API:
//   const scanner = scannerCreate({ onResult: (text) => ..., onError: (msg) => ... });
//   await scanner.start(videoEl);   // attach to <video> element
//   scanner.stop();
//
// Lazy-loads html5-qrcode only when BarcodeDetector is absent.

(function () {

  const LIB_URL = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
  let _libLoaded = false;

  function loadLibOnce() {
    if (_libLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB_URL;
      s.onload = () => { _libLoaded = true; resolve(); };
      s.onerror = () => reject(new Error('failed to load html5-qrcode'));
      document.head.appendChild(s);
    });
  }

  function hasNativeDetector() {
    return typeof window.BarcodeDetector !== 'undefined';
  }

  function scannerCreate({ onResult, onError }) {
    let active = false;
    let stream = null;
    let nativeRaf = null;
    let h5q = null;

    async function startNative(videoEl) {
      const detector = new window.BarcodeDetector({
        formats: ['qr_code','code_128','code_39','ean_13','ean_8','upc_a','upc_e'],
      });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      videoEl.srcObject = stream;
      await videoEl.play();
      const loop = async () => {
        if (!active) return;
        try {
          const codes = await detector.detect(videoEl);
          if (codes && codes[0]) {
            onResult(codes[0].rawValue);
            return; // caller will stop()
          }
        } catch (e) { /* ignore frame errors */ }
        nativeRaf = requestAnimationFrame(loop);
      };
      nativeRaf = requestAnimationFrame(loop);
    }

    async function startFallback(videoEl) {
      await loadLibOnce();
      // html5-qrcode needs a div, not a video — wrap:
      const wrap = document.createElement('div');
      wrap.id = 'h5q-' + Math.random().toString(36).slice(2,9);
      wrap.style.width = '100%';
      videoEl.replaceWith(wrap);
      h5q = new window.Html5Qrcode(wrap.id);
      await h5q.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (text) => { onResult(text); },
        () => {/* per-frame errors silenced */},
      );
    }

    return {
      async start(videoEl) {
        active = true;
        try {
          if (hasNativeDetector()) await startNative(videoEl);
          else                     await startFallback(videoEl);
        } catch (e) {
          active = false;
          onError?.(String(e?.message || e));
        }
      },
      stop() {
        active = false;
        if (nativeRaf) cancelAnimationFrame(nativeRaf);
        if (stream)   stream.getTracks().forEach((t) => t.stop());
        if (h5q)      h5q.stop().catch(() => {}).then(() => h5q.clear?.());
      },
    };
  }

  window.scannerCreate         = scannerCreate;
  window.scannerHasNative      = hasNativeDetector;
})();
```

- [ ] **Step 2: Manual smoke (Chrome on desktop with webcam)**

Create `tools/scan-smoke.html`:

```html
<!doctype html><html><body>
<video id="v" style="width:300px;border:1px solid #ccc"></video>
<pre id="out"></pre>
<script src="../shared/scanner.js"></script>
<script>
const s = scannerCreate({
  onResult: (t) => { document.getElementById('out').textContent += t + '\n'; s.stop(); },
  onError:  (e) => alert('err: ' + e),
});
s.start(document.getElementById('v'));
</script>
</body></html>
```

Open in Chrome, show a QR code at the camera. Expected: code text printed.

- [ ] **Step 3: Commit (delete smoke file before commit)**

```bash
rm tools/scan-smoke.html
git add shared/scanner.js
git commit -m "feat(ui): shared scanner wrapper — native + html5-qrcode fallback"
```

---

## Task C3: Quick lint of Phase C modules

- [ ] **Step 1: In admin.html (Phase D will wire it in, but for now)** open DevTools console in the live admin page after temporarily adding `<script src="./shared/inventory.js"></script>` and `<script src="./shared/scanner.js"></script>`.

```javascript
typeof invListItems     // 'function'
typeof scannerCreate    // 'function'
typeof scannerHasNative // 'function'
```

Expected: all three `'function'`.

- [ ] **Step 2: Revert temporary script tags. No commit.**

---

# Phase D — Admin Inventory tab

## Task D1: Register the Inventory tab in admin shell

**Spec ref:** §7.1, Q-Phase1-F. Touches `js/admin-shell.js` and `admin.html`.

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\js\admin-shell.js`
- Edit: `F:\@Coding\ระบบ\The Good Stock\admin.html`

- [ ] **Step 1: Edit `js/admin-shell.js` — add `inventory` to the `inits` map**

Replace the `inits` block with:

```javascript
  const inits = {
    dashboard:  () => window.initDashboardTab  && window.initDashboardTab(),
    locations:  () => window.initLocationsTab  && window.initLocationsTab(),
    inventory:  () => window.initInventoryTab  && window.initInventoryTab(),
    ambulances: () => window.initAmbulancesTab && window.initAmbulancesTab(),
    settings:   () => window.initSettingsTab   && window.initSettingsTab(),
    sessions:   () => window.initSessionsTab   && window.initSessionsTab(),
  };
```

- [ ] **Step 2: Edit `admin.html` — add tab button + pane + script tag**

Inside the `<ul class="nav nav-pills...">` between Locations and Ambulances buttons:

```html
    <li><button class="btn nav-link stock-tab" data-tab="inventory"><i class="bi bi-box-seam"></i> Inventory</button></li>
```

Below the existing `<div id="tab-locations" ...>` pane (after locations, before ambulances pane):

```html
  <div id="tab-inventory"  class="tab-pane d-none"></div>
```

In the per-tab scripts block (after `js/locations.js`):

```html
<script src="./shared/inventory.js"></script>
<script src="./shared/scanner.js"></script>
<script src="./js/inventory.js"></script>
<script src="./js/inventory-finder.js"></script>
<script src="./js/inventory-scan.js"></script>
```

- [ ] **Step 3: Push to local server / open admin.html**

Expected: clicking the new "Inventory" pill switches to an empty pane (`#tab-inventory`). No JS errors in console — `initInventoryTab` will be `undefined` until D2, so the call is a no-op (`?.()`).

- [ ] **Step 4: Commit**

```bash
git add js/admin-shell.js admin.html
git commit -m "feat(ui): register Inventory tab in admin shell"
```

---

## Task D2: js/inventory.js — Items list (search, filter, table)

**Spec ref:** §7.1.1, T25, T26, T28.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\js\inventory.js`

- [ ] **Step 1: Write file**

```javascript
// js/inventory.js — Admin Inventory tab. Spec §7.1.

(function () {
  let _categories = [];
  let _unsub = null;
  let _currentSubview = 'items';  // items | receive | finder

  window.initInventoryTab = async function () {
    const root = document.getElementById('tab-inventory');
    root.innerHTML = renderShell();

    document.querySelectorAll('[data-subview]').forEach((btn) => {
      btn.addEventListener('click', () => switchSubview(btn.dataset.subview));
    });

    try { _categories = await window.invListCategories(); } catch (e) { console.warn(e); }
    populateCategoryFilter();

    // Default subview
    switchSubview('items');

    // Realtime — debounced refresh of current subview
    let pending = null;
    _unsub = window.invSubscribe(() => {
      clearTimeout(pending);
      pending = setTimeout(() => refreshCurrentSubview(), 300);
    });

    // Wire toolbar
    document.getElementById('inv-search').addEventListener('input', debounce(refreshItemsList, 250));
    document.getElementById('inv-cat-filter').addEventListener('change', refreshItemsList);
    document.getElementById('inv-low-only').addEventListener('change', refreshItemsList);
    document.getElementById('btn-add-item').addEventListener('click', openItemModal);
    document.getElementById('btn-scan-receive').addEventListener('click', () => window.openScanReceive?.());
  };

  function renderShell() {
    return `
      <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
        <div class="btn-group" role="group">
          <button class="btn btn-outline-stock-accent active" data-subview="items">รายการสินค้า</button>
          <button class="btn btn-outline-stock-accent"        data-subview="receive">รับเข้า / ปรับสต๊อก</button>
          <button class="btn btn-outline-stock-accent"        data-subview="finder">ค้นของ</button>
        </div>
        <div class="ms-auto d-flex gap-2">
          <button class="btn btn-stock-primary"  id="btn-add-item"><i class="bi bi-plus-lg"></i> เพิ่มสินค้า</button>
          <button class="btn btn-outline-stock-accent" id="btn-scan-receive"><i class="bi bi-upc-scan"></i> สแกนรับเข้า</button>
        </div>
      </div>

      <div id="sub-items">
        <div class="row g-2 mb-2">
          <div class="col-12 col-md-6"><input id="inv-search" class="form-control" placeholder="ค้นชื่อ / SKU / Barcode"></div>
          <div class="col-6 col-md-3"><select id="inv-cat-filter" class="form-select"><option value="">หมวด: ทั้งหมด</option></select></div>
          <div class="col-6 col-md-3"><div class="form-check pt-2"><input id="inv-low-only" type="checkbox" class="form-check-input"><label class="form-check-label">เฉพาะของใกล้หมด</label></div></div>
        </div>
        <div class="table-responsive"><table class="table table-sm align-middle">
          <thead><tr><th>SKU</th><th>ชื่อ</th><th>หมวด</th><th class="text-end">คงเหลือรวม</th><th class="text-end">เกณฑ์</th><th>สถานะ</th></tr></thead>
          <tbody id="inv-items-body"><tr><td colspan="6" class="text-muted">กำลังโหลด…</td></tr></tbody>
        </table></div>
      </div>

      <div id="sub-receive" class="d-none"><!-- filled by inventory-receive panel below --></div>
      <div id="sub-finder"  class="d-none"><!-- filled by inventory-finder.js  --></div>
    `;
  }

  function populateCategoryFilter() {
    const sel = document.getElementById('inv-cat-filter');
    _categories.forEach((c) => sel.insertAdjacentHTML('beforeend', `<option value="${c.id}">${c.name}</option>`));
  }

  function switchSubview(name) {
    _currentSubview = name;
    ['items','receive','finder'].forEach((n) => {
      document.getElementById('sub-' + n).classList.toggle('d-none', n !== name);
      document.querySelector(`[data-subview="${n}"]`)?.classList.toggle('active', n === name);
    });
    if (name === 'items')   refreshItemsList();
    if (name === 'receive') window.initInventoryReceive?.();
    if (name === 'finder')  window.initInventoryFinder?.();
  }

  function refreshCurrentSubview() {
    if (_currentSubview === 'items')   refreshItemsList();
    if (_currentSubview === 'receive') window.invReceiveRefresh?.();
    if (_currentSubview === 'finder')  window.invFinderRefresh?.();
  }

  async function refreshItemsList() {
    const q       = document.getElementById('inv-search').value.trim();
    const catId   = document.getElementById('inv-cat-filter').value;
    const lowOnly = document.getElementById('inv-low-only').checked;
    let rows;
    try { rows = await window.invListItems({ q, lowOnly }); }
    catch (e) { showToast('error', 'โหลดสินค้าไม่สำเร็จ: ' + e.message); return; }
    if (catId) rows = rows.filter((r) => r.category_id === catId);

    const tbody = document.getElementById('inv-items-body');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted">— ไม่มีรายการ —</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const cat = _categories.find((c) => c.id === r.category_id)?.name ?? '';
      const low = r.reorder_threshold > 0 && r.total_qty <= r.reorder_threshold;
      return `<tr data-id="${r.id}" style="cursor:pointer">
        <td><code>${escapeHtml(r.sku)}</code></td>
        <td>${escapeHtml(r.name)}</td>
        <td><small>${escapeHtml(cat)}</small></td>
        <td class="text-end ${low ? 'text-danger fw-bold' : ''}">${r.total_qty}</td>
        <td class="text-end"><small>${r.reorder_threshold || '—'}</small></td>
        <td>${r.active ? '<span class="badge bg-success">ใช้งาน</span>' : '<span class="badge bg-secondary">ปิด</span>'}</td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openItemDrawer(tr.dataset.id));
    });
  }

  // -------- modal: add / edit item --------
  function openItemModal(editRow) {
    const id  = 'mod-' + Math.random().toString(36).slice(2,9);
    const cur = editRow || { active: true, unit: 'ชิ้น', reorder_threshold: 0 };
    const isEdit = !!editRow;
    const html = `
      <div class="modal fade" id="${id}" tabindex="-1"><div class="modal-dialog">
        <div class="modal-content"><div class="modal-body">
          <h5 class="mb-3">${isEdit ? 'แก้ไขสินค้า' : 'เพิ่มสินค้าใหม่'}</h5>
          <div class="mb-2"><label class="form-label small">ชื่อ *</label><input id="f-name" class="form-control" value="${escapeHtml(cur.name || '')}"></div>
          <div class="row g-2 mb-2">
            <div class="col-6"><label class="form-label small">SKU *</label><input id="f-sku" class="form-control" value="${escapeHtml(cur.sku || '')}" ${isEdit?'disabled':''}></div>
            <div class="col-6"><label class="form-label small">Barcode</label><input id="f-barcode" class="form-control" value="${escapeHtml(cur.barcode || '')}"></div>
          </div>
          <div class="row g-2 mb-2">
            <div class="col-6"><label class="form-label small">หมวด</label><select id="f-cat" class="form-select"><option value="">—</option>${_categories.map((c) => `<option value="${c.id}" ${c.id===cur.category_id?'selected':''}>${c.name}</option>`).join('')}</select></div>
            <div class="col-3"><label class="form-label small">หน่วย</label><input id="f-unit" class="form-control" value="${escapeHtml(cur.unit || 'ชิ้น')}"></div>
            <div class="col-3"><label class="form-label small">เกณฑ์เตือน</label><input id="f-thr" type="number" min="0" class="form-control" value="${cur.reorder_threshold ?? 0}"></div>
          </div>
          <div class="form-check mb-3"><input id="f-active" class="form-check-input" type="checkbox" ${cur.active?'checked':''}><label class="form-check-label">ใช้งานอยู่</label></div>
          <div id="f-err" class="alert alert-danger d-none py-2 small"></div>
          <div class="text-end"><button class="btn btn-secondary me-2" data-act="x">ยกเลิก</button><button class="btn btn-stock-primary" data-act="save">บันทึก</button></div>
        </div></div></div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const el = document.getElementById(id);
    const m  = new bootstrap.Modal(el);
    el.querySelector('[data-act="x"]').onclick = () => m.hide();
    el.querySelector('[data-act="save"]').onclick = async () => {
      const payload = {
        name: el.querySelector('#f-name').value.trim(),
        sku:  el.querySelector('#f-sku').value.trim(),
        barcode: el.querySelector('#f-barcode').value.trim() || null,
        category_id: el.querySelector('#f-cat').value || null,
        unit: el.querySelector('#f-unit').value.trim() || 'ชิ้น',
        reorder_threshold: Number(el.querySelector('#f-thr').value) || 0,
        active: el.querySelector('#f-active').checked,
      };
      try {
        if (isEdit) await window.invUpdateItem(editRow.id, payload);
        else        await window.invCreateItem(payload);
        m.hide();
        refreshItemsList();
        showToast('success', isEdit ? 'อัปเดตแล้ว' : 'เพิ่มสินค้าแล้ว');
      } catch (e) {
        const errEl = el.querySelector('#f-err');
        errEl.classList.remove('d-none');
        errEl.textContent = /sku/.test(e.message) ? 'SKU ซ้ำ' : e.message;
      }
    };
    el.addEventListener('hidden.bs.modal', () => el.remove());
    m.show();
  }

  async function openItemDrawer(id) {
    const sb = getSupabaseClient();
    const { data: item } = await sb.from('stock_items').select('*').eq('id', id).single();
    const locs = await window.invFindItemLocations(id);
    // Quick offcanvas — use a modal for simplicity
    const mid = 'mod-' + Math.random().toString(36).slice(2,9);
    const html = `
      <div class="modal fade" id="${mid}" tabindex="-1"><div class="modal-dialog modal-lg">
      <div class="modal-content"><div class="modal-body">
        <div class="d-flex"><h5 class="me-auto">${escapeHtml(item.name)} <small class="text-muted">${escapeHtml(item.sku)}</small></h5>
          <button class="btn btn-sm btn-outline-secondary me-2" data-act="edit">แก้ไข</button>
          <button class="btn btn-sm btn-outline-danger" data-act="deact">${item.active?'ปิดใช้งาน':'เปิดใช้งาน'}</button></div>
        <p class="text-muted small mb-2">หมวด: ${escapeHtml(_categories.find((c)=>c.id===item.category_id)?.name || '—')} ·
           หน่วย: ${escapeHtml(item.unit)} · เกณฑ์เตือน: ${item.reorder_threshold || '—'}</p>
        <h6 class="mt-3">คงเหลือต่อสถานที่</h6>
        ${locs.length ? `<ul class="list-unstyled">${locs.map((l)=>`<li><code>${escapeHtml(l.locations.code)}</code> ${escapeHtml(l.locations.name)} — <strong>${l.qty}</strong></li>`).join('')}</ul>` : '<p class="text-muted">ไม่มีในคลัง</p>'}
      </div></div></div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const el = document.getElementById(mid);
    const m  = new bootstrap.Modal(el);
    el.querySelector('[data-act="edit"]').onclick  = () => { m.hide(); openItemModal(item); };
    el.querySelector('[data-act="deact"]').onclick = async () => {
      await window.invUpdateItem(id, { active: !item.active });
      m.hide(); refreshItemsList();
      showToast('success', item.active ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว');
    };
    el.addEventListener('hidden.bs.modal', () => el.remove());
    m.show();
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
})();
```

- [ ] **Step 2: Open admin → Inventory tab → "+ เพิ่มสินค้า"**

Verify modal opens, 4 categories listed. Add: name "ผ้าก๊อซ", SKU "SUP-GAUZE-001", barcode "8851234567890", category SUPPLY, threshold 20 → row appears in table (T25).

- [ ] **Step 3: Try same SKU again → expect "SKU ซ้ำ" red error (T26).**

- [ ] **Step 4: Search "ผ้า" → expect the row, total_qty 0, status badge "ใช้งาน" (T28 + F1 deactivate-test setup).**

- [ ] **Step 5: Click row → drawer shows "ไม่มีในคลัง" → click "ปิดใช้งาน" → reopen list, item disappears unless `inv-active-only` is unchecked (covers F1's deactivate gap test "T26b").**

- [ ] **Step 6: Commit**

```bash
git add js/inventory.js
git commit -m "feat(ui): admin Inventory tab — items list + add/edit/deactivate"
```

---

## Task D3: Admin Receive/Adjust sub-view (manual form)

**Spec ref:** §7.1.2, T29, T30.

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\js\inventory.js` (extend with `initInventoryReceive`)

- [ ] **Step 1: Append to `js/inventory.js`** (before the IIFE close):

```javascript
  // -------- Receive / Adjust sub-view --------
  let _recentMovUnsub = null;

  window.initInventoryReceive = async function () {
    const root = document.getElementById('sub-receive');
    root.innerHTML = `
      <div class="row g-3">
        <div class="col-12 col-lg-5">
          <div class="card"><div class="card-body">
            <h6 class="mb-3">รับเข้า / ปรับสต๊อก (Manual)</h6>
            <div class="mb-2"><label class="form-label small">สินค้า *</label><select id="rcv-item" class="form-select"><option value="">— เลือก —</option></select></div>
            <div class="mb-2"><label class="form-label small">สถานที่ *</label><select id="rcv-loc"  class="form-select"><option value="">— เลือก —</option></select></div>
            <div class="row g-2 mb-2">
              <div class="col-6"><label class="form-label small">ประเภท</label>
                <select id="rcv-type" class="form-select">
                  <option value="receive">รับเข้า (Receive)</option>
                  <option value="adjustment_gain">ปรับเพิ่ม</option>
                  <option value="adjustment_loss">ปรับลด (ของชำรุด/หาย)</option>
                </select>
              </div>
              <div class="col-6"><label class="form-label small">จำนวน *</label><input id="rcv-qty" type="number" min="1" class="form-control"></div>
            </div>
            <div class="mb-2"><label class="form-label small">เหตุผล / Note</label><input id="rcv-note" class="form-control"></div>
            <button id="btn-rcv-submit" class="btn btn-stock-primary w-100">บันทึก</button>
          </div></div>
        </div>
        <div class="col-12 col-lg-7">
          <h6>50 รายการล่าสุด</h6>
          <div class="table-responsive" style="max-height:60vh;overflow:auto"><table class="table table-sm">
            <thead><tr><th>เวลา</th><th>ประเภท</th><th>SKU/ชื่อ</th><th>สถานที่</th><th class="text-end">Δ</th><th class="text-end">คงเหลือ</th><th>ผู้ทำ</th></tr></thead>
            <tbody id="rcv-recent-body"><tr><td colspan="7" class="text-muted">กำลังโหลด…</td></tr></tbody>
          </table></div>
        </div>
      </div>
    `;
    await Promise.all([ populateItemSelect(), populateLocSelect() ]);
    document.getElementById('btn-rcv-submit').addEventListener('click', submitReceive);
    await refreshRecent();
  };

  window.invReceiveRefresh = refreshRecent;

  async function populateItemSelect() {
    const items = await window.invListItems({ activeOnly: true });
    const sel = document.getElementById('rcv-item');
    items.forEach((i) => sel.insertAdjacentHTML('beforeend', `<option value="${i.id}">${escapeHtml(i.sku)} — ${escapeHtml(i.name)}</option>`));
  }
  async function populateLocSelect() {
    const sb = getSupabaseClient();
    const { data } = await sb.from('locations').select('id,code,name,type').eq('active', true).order('code');
    const sel = document.getElementById('rcv-loc');
    data.forEach((l) => sel.insertAdjacentHTML('beforeend', `<option value="${l.id}">${escapeHtml(l.code)} — ${escapeHtml(l.name)} (${l.type})</option>`));
  }

  async function submitReceive() {
    const item_id = document.getElementById('rcv-item').value;
    const location_id = document.getElementById('rcv-loc').value;
    const type = document.getElementById('rcv-type').value;
    const qty  = Number(document.getElementById('rcv-qty').value);
    const note = document.getElementById('rcv-note').value.trim() || null;
    if (!item_id || !location_id || !qty) return showToast('warning', 'กรอกข้อมูลไม่ครบ');
    if (qty <= 0) return showToast('warning', 'จำนวนต้องมากกว่า 0');
    const delta = (type === 'adjustment_loss') ? -qty : qty;
    try {
      await window.invPostMovement({ item_id, location_id, movement_type: type, qty_delta: delta, note });
      showToast('success', 'บันทึกแล้ว');
      document.getElementById('rcv-qty').value = '';
      document.getElementById('rcv-note').value = '';
      refreshRecent();
    } catch (e) {
      showToast('error', /negative/.test(e.message) ? 'ของไม่พอ' : e.message);
    }
  }

  async function refreshRecent() {
    const tbody = document.getElementById('rcv-recent-body');
    if (!tbody) return;
    const rows = await window.invListRecentMovements(50);
    tbody.innerHTML = rows.map((r) => `<tr>
      <td><small>${new Date(r.performed_at).toLocaleString('th-TH')}</small></td>
      <td><small>${r.movement_type}</small></td>
      <td><small>${escapeHtml(r.stock_items?.sku || '')} ${escapeHtml(r.stock_items?.name || '')}</small></td>
      <td><small>${escapeHtml(r.locations?.code || '')}</small></td>
      <td class="text-end ${r.qty_delta < 0 ? 'text-danger' : 'text-success'}">${r.qty_delta > 0 ? '+' : ''}${r.qty_delta}</td>
      <td class="text-end">${r.qty_after ?? '—'}</td>
      <td><small>${escapeHtml(r.performed_by)} (${r.performed_role})</small></td>
    </tr>`).join('') || '<tr><td colspan="7" class="text-muted">— ยังไม่มีรายการ —</td></tr>';
  }
```

- [ ] **Step 2: T29 — Admin opens Receive, picks gauze, picks ROOM-A, qty 100 → success toast → "50 รายการล่าสุด" shows the row.**

- [ ] **Step 3: T30 — Same item, SHELF-A1-T1, qty 30 → success → Items tab shows total_qty=130.**

- [ ] **Step 4: SQL spot-check**

```sql
SELECT m.movement_type, m.qty_delta, m.qty_after, l.code
FROM stock_movements m JOIN locations l ON l.id = m.location_id
WHERE m.item_id = (SELECT id FROM stock_items WHERE sku='SUP-GAUZE-001')
ORDER BY m.performed_at DESC LIMIT 5;
```

Expected: 2 rows (100 at ROOM-A and 30 at SHELF-A1-T1), with `qty_after` snapshots matching.

- [ ] **Step 5: Commit**

```bash
git add js/inventory.js
git commit -m "feat(ui): admin Receive/Adjust subview + recent movements"
```

---

## Task D4: Admin scan-receive overlay

**Spec ref:** §7.2, T33, T34, T35, T36.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\js\inventory-scan.js`

- [ ] **Step 1: Write file**

```javascript
// js/inventory-scan.js — Admin scan-receive overlay (3-step state machine). Spec §7.2.

(function () {
  let _overlay = null, _scanner = null, _state = 'item', _item = null, _loc = null;

  window.openScanReceive = function () {
    if (_overlay) return;
    const html = `
      <div id="scan-overlay" class="modal fade show" tabindex="-1" style="display:block;background:rgba(0,0,0,.5)"><div class="modal-dialog modal-fullscreen-sm-down"><div class="modal-content">
        <div class="modal-body p-3">
          <div class="d-flex"><h5 class="me-auto">📷 สแกนรับเข้า</h5><button class="btn btn-sm btn-light" id="scan-x">ปิด</button></div>
          <p id="scan-hint" class="text-muted mb-2">ขั้นที่ 1: สแกนบาร์โค้ดสินค้า</p>
          <video id="scan-video" autoplay muted playsinline style="width:100%;max-height:50vh;background:#000;border-radius:.5rem;"></video>
          <div class="mt-2"><div id="chip-item" class="badge bg-secondary me-1">item: —</div><div id="chip-loc" class="badge bg-secondary">location: —</div></div>
          <div id="qty-row" class="row g-2 mt-2 d-none">
            <div class="col-8"><input id="scan-qty" type="number" min="1" class="form-control" placeholder="จำนวน"></div>
            <div class="col-4"><button id="scan-submit" class="btn btn-stock-primary w-100">บันทึก</button></div>
          </div>
          <div class="mt-2"><button class="btn btn-sm btn-outline-secondary" id="scan-reset">เริ่มใหม่</button></div>
        </div>
      </div></div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    _overlay = document.getElementById('scan-overlay');
    _state = 'item'; _item = null; _loc = null;

    _scanner = scannerCreate({
      onResult: handleScan,
      onError:  (e) => showToast('error', 'กล้อง: ' + e),
    });
    _scanner.start(document.getElementById('scan-video'));

    document.getElementById('scan-x').onclick     = close;
    document.getElementById('scan-reset').onclick = reset;
    document.getElementById('scan-submit').onclick = submit;
  };

  async function handleScan(code) {
    if (_state === 'item') {
      const it = await window.invFindItemByCode(code);
      if (!it) { showToast('error', 'ไม่พบสินค้า — ตรวจสอบ SKU'); return; }
      _item = it;
      document.getElementById('chip-item').textContent = `item: ${it.sku} ${it.name}`;
      document.getElementById('chip-item').className = 'badge bg-success me-1';
      _state = 'loc';
      document.getElementById('scan-hint').textContent = 'ขั้นที่ 2: สแกน QR ของสถานที่จัดเก็บ';
    } else if (_state === 'loc') {
      const l = await window.invFindLocationByCode(code);
      if (!l) { showToast('error', 'ไม่พบตู้/ชั้น'); return; }
      _loc = l;
      document.getElementById('chip-loc').textContent = `location: ${l.code} ${l.name}`;
      document.getElementById('chip-loc').className = 'badge bg-success';
      _state = 'qty';
      _scanner.stop();
      document.getElementById('scan-hint').textContent = 'ขั้นที่ 3: ใส่จำนวนแล้วบันทึก';
      document.getElementById('qty-row').classList.remove('d-none');
      document.getElementById('scan-qty').focus();
    }
  }

  async function submit() {
    const qty = Number(document.getElementById('scan-qty').value);
    if (!qty || qty <= 0) return showToast('warning', 'จำนวนไม่ถูกต้อง');
    const res = await window.invPostMovement({
      item_id: _item.id, location_id: _loc.id, movement_type: 'receive',
      qty_delta: qty, client_ref_id: crypto.randomUUID(),
    }).catch((e) => ({ ok: false, err: e }));
    if (!res.ok) return showToast('error', res.err?.message || 'บันทึกไม่สำเร็จ');
    showToast('success', res.idempotent_replay ? 'บันทึกแล้ว (ซ้ำ)' : 'บันทึกแล้ว');
    close();
  }

  function reset() {
    _state = 'item'; _item = null; _loc = null;
    document.getElementById('chip-item').textContent = 'item: —';
    document.getElementById('chip-loc').textContent  = 'location: —';
    document.getElementById('chip-item').className = 'badge bg-secondary me-1';
    document.getElementById('chip-loc').className  = 'badge bg-secondary';
    document.getElementById('qty-row').classList.add('d-none');
    document.getElementById('scan-hint').textContent = 'ขั้นที่ 1: สแกนบาร์โค้ดสินค้า';
    _scanner.start(document.getElementById('scan-video'));
  }

  function close() {
    _scanner?.stop(); _scanner = null;
    _overlay?.remove(); _overlay = null;
  }
})();
```

- [ ] **Step 2: T33 — open admin → Inventory → "📷 สแกนรับเข้า", grant camera, scan SUP-GAUZE-001 barcode → chip turns green; scan a ROOM-A QR → chip turns green; enter qty 50 → submit → success toast.**

- [ ] **Step 3: T35 — scan unknown barcode "0000000000000" → expect "ไม่พบสินค้า — ตรวจสอบ SKU" toast.**

- [ ] **Step 4: T36 — scan an unknown location code → expect "ไม่พบตู้/ชั้น" toast.**

- [ ] **Step 5: T34 — manually replay an INSERT via DevTools with the same `client_ref_id`:**

```javascript
await window.invPostMovement({ item_id:'<id>', location_id:'<id>', movement_type:'receive', qty_delta:1, client_ref_id:'<the-uuid-from-the-row-above>' });
```

Expected: returns `{ ok: true, idempotent_replay: true }` — no second `stock_movements` row.

- [ ] **Step 6: Commit**

```bash
git add js/inventory-scan.js
git commit -m "feat(ui): admin scan-receive overlay (3-step state machine)"
```

---

## Task D5: Item Finder panel (admin)

**Spec ref:** §7.1.3, T28, T32.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\js\inventory-finder.js`

- [ ] **Step 1: Write file**

```javascript
// js/inventory-finder.js — Item Finder panel. Spec §7.1.3.

(function () {
  let _lastQuery = '';

  window.initInventoryFinder = function () {
    const root = document.getElementById('sub-finder');
    root.innerHTML = `
      <div class="mb-3"><input id="fin-q" class="form-control form-control-lg" placeholder="ค้นชื่อ / SKU / Barcode"></div>
      <div id="fin-results"></div>
    `;
    document.getElementById('fin-q').addEventListener('input', debounce(runSearch, 250));
  };
  window.invFinderRefresh = () => { if (_lastQuery) runSearch(); };

  async function runSearch() {
    const q = document.getElementById('fin-q').value.trim();
    _lastQuery = q;
    const root = document.getElementById('fin-results');
    if (!q) { root.innerHTML = '<p class="text-muted">พิมพ์เพื่อค้นหา …</p>'; return; }
    const items = await window.invListItems({ q, activeOnly: true, limit: 20 });
    if (!items.length) { root.innerHTML = '<p class="text-muted">ไม่พบรายการ — ลองสแกนบาร์โค้ดแทน</p>'; return; }
    const blocks = await Promise.all(items.map(async (it) => {
      const locs = await window.invFindItemLocations(it.id);
      if (!locs.length) return `<div class="card mb-2"><div class="card-body py-2">
        <strong>${escapeHtml(it.name)}</strong> <small class="text-muted">${escapeHtml(it.sku)}</small>
        <p class="text-muted small mb-0">ไม่มีในคลัง</p></div></div>`;
      return `<div class="card mb-2"><div class="card-body py-2">
        <strong>${escapeHtml(it.name)}</strong> <small class="text-muted">${escapeHtml(it.sku)}</small>
        <ul class="list-unstyled mt-1 mb-0 small">
          ${locs.map((l) => `<li><code>${escapeHtml(l.locations.code)}</code> ${escapeHtml(l.locations.name)} — <strong>${l.qty}</strong> <small class="text-muted">(${new Date(l.last_movement_at || 0).toLocaleString('th-TH')})</small></li>`).join('')}
        </ul></div></div>`;
    }));
    root.innerHTML = blocks.join('');
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
})();
```

- [ ] **Step 2: T28 — empty (zero-qty) item search → expect "ไม่มีในคลัง" message.**

- [ ] **Step 3: T32 — after Receive 100 at ROOM-A + 30 at SHELF-A1-T1, search "ผ้าก๊อซ" → expect both locations listed with qty 100 and 30, sorted by qty desc.**

- [ ] **Step 4: Commit**

```bash
git add js/inventory-finder.js
git commit -m "feat(ui): admin Item Finder panel"
```

---

## Task D6: T27 + T31 — RLS via DevTools (Employee attempts)

**Spec ref:** §9 T27, T31.

This is a verify-only task; no code change.

- [ ] **Step 1: Log in as Employee (Phase 0 test account).**

- [ ] **Step 2: In DevTools console:**

```javascript
// T27 — insert into stock_items must 403
await getSupabaseClient().from('stock_items').insert({ sku:'EVIL-001', name:'evil' });
// T31 — insert into stock_movements with type=receive must 403
await getSupabaseClient().from('stock_movements').insert({
  item_id:'<any uuid>', location_id:'<any uuid>',
  movement_type:'receive', qty_delta:1,
});
```

Expected: both return `error.code === '42501'` (insufficient_privilege / RLS).

- [ ] **Step 3: Take screenshots, paste into `docs/test-checklist.md` (edited in Task G3).**

---

## Task D7: T40 — Realtime live update

**Spec ref:** §9 T40.

- [ ] **Step 1: Open admin → Inventory tab → Items list, in Browser A (Admin).**

- [ ] **Step 2: In Browser B, log in as Employee → staff.html (we'll get the staff-scan page in Phase E; for now use SQL editor as a stand-in for B):** run

```sql
INSERT INTO stock_movements(item_id, location_id, movement_type, qty_delta)
SELECT
  (SELECT id FROM stock_items WHERE sku='SUP-GAUZE-001'),
  (SELECT id FROM locations WHERE code='ROOM-A' LIMIT 1),
  'issue', -10;
```

- [ ] **Step 3: In Browser A — within ~1s, total_qty drops by 10 without page refresh.**

- [ ] **Step 4: Verify-only.** No commit.

---

# Phase E — Staff scan page

## Task E1: staff-scan.html shell

**Spec ref:** §7.3, Q-Phase1-F.

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\staff-scan.html`

- [ ] **Step 1: Write file**

```html
<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>สแกนเบิก-จ่าย — Thegood Stock</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./shared/styles.css">
</head>
<body>

<nav class="navbar bg-modern-primary navbar-dark px-3">
  <a class="navbar-brand mb-0 text-white" href="./staff.html"><i class="bi bi-arrow-left"></i> Thegood Stock</a>
  <button class="btn btn-sm btn-outline-light" id="btn-logout">ออก</button>
</nav>

<div class="container py-3">
  <div class="d-flex mb-3"><h5 class="me-auto">📷 สแกนเบิก-จ่าย</h5>
    <a class="btn btn-sm btn-outline-secondary" href="#finder-anchor">ค้นของ</a></div>

  <div class="mb-2 small">
    <span id="chip-item" class="badge bg-secondary me-1">item: —</span>
    <span id="chip-loc"  class="badge bg-secondary">location: —</span>
  </div>

  <video id="scan-video" autoplay muted playsinline style="width:100%;max-height:55vh;background:#000;border-radius:.5rem;"></video>

  <div id="manual-fallback" class="mt-2 d-none">
    <div class="row g-2"><div class="col-6"><input id="man-item" class="form-control" placeholder="SKU / barcode"></div>
                         <div class="col-6"><input id="man-loc"  class="form-control" placeholder="รหัสตู้/ชั้น"></div></div>
    <button id="man-confirm" class="btn btn-sm btn-outline-stock-accent mt-2">ใช้ค่าที่พิมพ์</button>
  </div>

  <div class="row g-2 mt-3">
    <div class="col-6"><select id="scan-type" class="form-select">
      <option value="issue">เบิก-จ่าย (issue)</option>
      <option value="adjustment_loss">รายงานของชำรุด/หาย</option>
    </select></div>
    <div class="col-3"><input id="scan-qty" type="number" min="1" class="form-control" placeholder="จำนวน"></div>
    <div class="col-3"><button id="scan-submit" class="btn btn-stock-primary w-100">บันทึก</button></div>
  </div>

  <div id="photo-row" class="mt-2 d-none">
    <label class="form-label small">แนบรูป (ไม่บังคับ — สำหรับของชำรุด)</label>
    <input id="scan-photo" type="file" accept="image/*" capture="environment" class="form-control">
  </div>

  <div class="mt-3"><button class="btn btn-sm btn-outline-secondary" id="scan-reset">เริ่มใหม่</button></div>

  <hr class="my-4">
  <h6 id="finder-anchor">ค้นของ (ดูสถานที่จัดเก็บ)</h6>
  <input id="fin-q" class="form-control mb-2" placeholder="ค้นชื่อ / SKU / Barcode">
  <div id="fin-results" class="small"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="./shared/config.js"></script>
<script src="./shared/supabase-client.js"></script>
<script src="./shared/auth.js"></script>
<script src="./shared/auth-jwt.js"></script>
<script src="./shared/ui.js"></script>
<script src="./shared/inventory.js"></script>
<script src="./shared/scanner.js"></script>
<script src="./shared/cloudinary.js"></script>
<script src="./js/staff-scan.js"></script>

<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e)));
}
</script>

</body>
</html>
```

- [ ] **Step 2: Open `./staff-scan.html` as Employee → expect the layout (video black, type select, qty input, finder field at bottom). No JS error.**

- [ ] **Step 3: Commit**

```bash
git add staff-scan.html
git commit -m "feat(ui): staff-scan.html shell (mobile-first)"
```

---

## Task E2: js/staff-scan.js — issue + adjustment_loss + manual fallback

**Spec ref:** §7.3, T37–T39, F1 (optional photo).

**Files:**
- Create: `F:\@Coding\ระบบ\The Good Stock\js\staff-scan.js`

- [ ] **Step 1: Write file**

```javascript
// js/staff-scan.js — Staff scan-issue page. Spec §7.3.

(async function () {
  const ok = await window.ensureLoggedIn();
  if (!ok) return;
  // No requireRole here: Admin can also reach this page for convenience.

  document.getElementById('btn-logout').onclick = () => window.handleLogout();

  let _state = 'item', _item = null, _loc = null;
  const video = document.getElementById('scan-video');
  const chipI = document.getElementById('chip-item');
  const chipL = document.getElementById('chip-loc');
  const typeSel = document.getElementById('scan-type');
  const photoRow = document.getElementById('photo-row');

  typeSel.addEventListener('change', () => {
    photoRow.classList.toggle('d-none', typeSel.value !== 'adjustment_loss');
  });

  const scanner = scannerCreate({
    onResult: onScan,
    onError:  (e) => { document.getElementById('manual-fallback').classList.remove('d-none'); showToast('warning', 'กล้อง: ' + e + ' — พิมพ์รหัสได้'); },
  });
  scanner.start(video);

  async function onScan(code) {
    if (_state === 'item') {
      const it = await window.invFindItemByCode(code);
      if (!it) return showToast('error', 'ไม่พบสินค้า');
      _item = it; chipI.textContent = `item: ${it.sku} ${it.name}`; chipI.className = 'badge bg-success me-1';
      _state = 'loc';
    } else if (_state === 'loc') {
      const l = await window.invFindLocationByCode(code);
      if (!l) return showToast('error', 'ไม่พบตู้/ชั้น');
      _loc = l; chipL.textContent = `location: ${l.code} ${l.name}`; chipL.className = 'badge bg-success';
      scanner.stop();
      _state = 'qty';
      document.getElementById('scan-qty').focus();
    }
  }

  document.getElementById('man-confirm').addEventListener('click', async () => {
    const ic = document.getElementById('man-item').value.trim();
    const lc = document.getElementById('man-loc').value.trim();
    if (ic) { const it = await window.invFindItemByCode(ic); if (!it) return showToast('error', 'ไม่พบสินค้า'); onScan(ic); }
    if (lc) { const l = await window.invFindLocationByCode(lc); if (!l) return showToast('error', 'ไม่พบตู้/ชั้น'); onScan(lc); }
  });

  document.getElementById('scan-submit').addEventListener('click', async () => {
    if (!_item || !_loc) return showToast('warning', 'ยังสแกนไม่ครบ');
    const qty = Number(document.getElementById('scan-qty').value);
    if (!qty || qty <= 0) return showToast('warning', 'จำนวนไม่ถูกต้อง');
    const type = typeSel.value;
    const delta = -qty;

    // optional photo for adjustment_loss
    let note = null;
    if (type === 'adjustment_loss') {
      const f = document.getElementById('scan-photo').files?.[0];
      if (f) {
        try {
          const url = await window.uploadToCloudinary(f, 'adjustment_loss');
          note = 'photo:' + url;
        } catch (e) { showToast('warning', 'อัปโหลดรูปไม่สำเร็จ (จะบันทึกโดยไม่มีรูป)'); }
      }
    }

    const res = await window.invPostMovement({
      item_id: _item.id, location_id: _loc.id, movement_type: type,
      qty_delta: delta, note, client_ref_id: crypto.randomUUID(),
    }).catch((e) => ({ ok: false, err: e }));
    if (!res.ok) {
      const msg = res.err?.message || '';
      return showToast('error', /negative/.test(msg) ? 'ของไม่พอ' : msg);
    }
    showToast('success', 'บันทึกแล้ว');
    setTimeout(reset, 800);
  });

  function reset() {
    _state = 'item'; _item = null; _loc = null;
    chipI.textContent = 'item: —'; chipI.className = 'badge bg-secondary me-1';
    chipL.textContent = 'location: —'; chipL.className = 'badge bg-secondary';
    document.getElementById('scan-qty').value = '';
    document.getElementById('scan-photo').value = '';
    scanner.start(video);
  }
  document.getElementById('scan-reset').addEventListener('click', reset);

  // -------- Item Finder embed (read-only) --------
  document.getElementById('fin-q').addEventListener('input', debounce(runFinder, 250));
  async function runFinder() {
    const q = document.getElementById('fin-q').value.trim();
    const root = document.getElementById('fin-results');
    if (!q) { root.innerHTML = ''; return; }
    const items = await window.invListItems({ q, activeOnly: true, limit: 10 });
    if (!items.length) { root.innerHTML = '<p class="text-muted">ไม่พบ — ลองสแกนได้</p>'; return; }
    const blocks = await Promise.all(items.map(async (it) => {
      const locs = await window.invFindItemLocations(it.id);
      return `<div class="border rounded p-2 mb-2">
        <strong>${escapeHtml(it.name)}</strong> <small class="text-muted">${escapeHtml(it.sku)}</small>
        ${locs.length ? `<ul class="list-unstyled mt-1 mb-0">${locs.map((l) => `<li><code>${escapeHtml(l.locations.code)}</code> — <strong>${l.qty}</strong></li>`).join('')}</ul>` : '<p class="text-muted mb-0">ไม่มีในคลัง</p>'}
      </div>`;
    }));
    root.innerHTML = blocks.join('');
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
})();
```

- [ ] **Step 2: T37 — login as Employee, open `staff-scan.html`, grant camera, scan SUP-GAUZE-001 + ROOM-A QR + qty 10 → submit → success → SQL check:**

```sql
SELECT movement_type, qty_delta, qty_after FROM stock_movements
WHERE item_id = (SELECT id FROM stock_items WHERE sku='SUP-GAUZE-001')
ORDER BY performed_at DESC LIMIT 1;
```

Expected: `issue / -10 / 90` (was 100).

- [ ] **Step 3: T38 — try qty 200 (> on hand) → expect "ของไม่พอ" toast, no row added.**

- [ ] **Step 4: T39 — scan an item that's not at the chosen location (e.g. issue from SHELF-A1-T1 something only at ROOM-A) → expect "ของไม่พอ".**

- [ ] **Step 5: Switch type to "adjustment_loss" → photo file picker appears; pick a photo → submit → check `stock_movements.note` starts with `photo:https://...cloudinary.../adjustment_loss/...` (or no photo prefix if upload failed — still succeeds).**

- [ ] **Step 6: Commit**

```bash
git add js/staff-scan.js
git commit -m "feat(ui): staff scan-issue + manual fallback + optional photo"
```

---

## Task E3: Link from staff.html → staff-scan.html

**Spec ref:** §7.3 ("accessible from the Phase 0 staff landing via a big button").

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\staff.html`
- Optional edit: `F:\@Coding\ระบบ\The Good Stock\js\staff-home.js` (no logic change needed — pure markup)

- [ ] **Step 1: Edit `staff.html`** — replace the existing "ระบบอยู่ระหว่างพัฒนา" card with:

```html
  <div class="card mb-3"><div class="card-body">
    <a class="btn btn-stock-primary btn-lg w-100 mb-2" href="./staff-scan.html"><i class="bi bi-upc-scan"></i> สแกนเบิก-จ่าย</a>
    <a class="btn btn-outline-stock-accent w-100" href="./staff-scan.html#finder-anchor"><i class="bi bi-search"></i> ค้นของ (Item Finder)</a>
  </div></div>
```

(Keep the existing dual buttons for Locations / Ambulances below, unchanged.)

- [ ] **Step 2: Open as Employee → click "สแกนเบิก-จ่าย" → lands on `staff-scan.html`.**

- [ ] **Step 3: Commit**

```bash
git add staff.html
git commit -m "feat(ui): staff.html — link to scan page + finder anchor"
```

---

## Task E4: T44 — Multi-location issue from two locations

**Spec ref:** §9 T44.

- [ ] **Step 1: Confirm ROOM-A has 90 and SHELF-A1-T1 has 30 of SUP-GAUZE-001** (set up from Task D3/D4 + Task E2 minus 10).

- [ ] **Step 2: From `staff-scan.html` issue 80 from ROOM-A → success, qty_after=10.**

- [ ] **Step 3: From `staff-scan.html` issue 25 from SHELF-A1-T1 → success, qty_after=5.**

- [ ] **Step 4: Open admin → Inventory → Items → SUP-GAUZE-001 row → total_qty = 15.**

- [ ] **Step 5: Item Finder → 2 rows (ROOM-A qty 10, SHELF-A1-T1 qty 5).** Both via T44.

- [ ] **Step 6: Confirm ONE low-stock alert fired** (set threshold=20 earlier; now total=15 ≤ 20 → first issue across threshold).

```sql
SELECT dedupe_key, count(*) FROM notification_log
WHERE entity_id = (SELECT id::text FROM stock_items WHERE sku='SUP-GAUZE-001')
  AND event_type='low_stock'
GROUP BY dedupe_key;
```

Expected: one dedupe_key row, count=1 (the trigger fired exactly once today; subsequent issues hit dedupe).

- [ ] **Step 7: Verify-only.**

---

# Phase F — Item Finder polish + Dashboard inventory panels

## Task F1: staff.html — embed Finder anchor smoke

**Spec ref:** spec §1 + PDF §9 Item Finder. Already implemented in Task E1+E3; verify here.

- [ ] **Step 1: As Employee on staff-scan.html scroll down to "ค้นของ" → search "ผ้า" → expect the gauze item with 2 locations.**

- [ ] **Step 2: As Admin on admin → Inventory → "ค้นของ" segment → same result.**

- [ ] **Step 3: Verify-only.**

---

## Task F2: Dashboard — inventory panels (per PDF §2)

**Spec ref:** PDF §2 + spec §1 dashboard line. Finding F1 added explicit task here.

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\js\dashboard.js`

- [ ] **Step 1: Append Phase 1 panels to existing dashboard render**

Inside `initDashboardTab` (after existing status list), replace the final `</div>` block with:

```javascript
  // Phase 1 — inventory panels
  const sbCli = getSupabaseClient();
  const [itemsCnt, lowItems, todayMoves] = await Promise.all([
    sbCli.from('stock_items').select('id', { count:'exact', head:true }).eq('active', true),
    sbCli.from('v_stock_items_with_total').select('sku,name,total_qty,reorder_threshold')
         .gt('reorder_threshold', 0).order('total_qty').limit(20),
    sbCli.from('stock_movements').select('id', { count:'exact', head:true })
         .gte('performed_at', new Date(new Date().toDateString()).toISOString()),
  ]);
  const low = (lowItems.data || []).filter((r) => r.total_qty <= r.reorder_threshold);

  root.insertAdjacentHTML('beforeend', `
    <div class="row g-3 mt-3">
      <div class="col-12 col-md-4"><div class="card"><div class="card-body">
        <p class="text-muted small mb-1">สินค้าทั้งหมด (active)</p>
        <h3 class="mb-0">${itemsCnt.count ?? 0}</h3></div></div></div>
      <div class="col-12 col-md-4"><div class="card border-warning"><div class="card-body">
        <p class="text-muted small mb-1">ของใกล้หมด (≤ เกณฑ์)</p>
        <h3 class="mb-0 text-warning">${low.length}</h3></div></div></div>
      <div class="col-12 col-md-4"><div class="card"><div class="card-body">
        <p class="text-muted small mb-1">รายการสแกน/รับ/จ่าย วันนี้</p>
        <h3 class="mb-0">${todayMoves.count ?? 0}</h3></div></div></div>
    </div>
    ${low.length ? `<div class="card mt-3"><div class="card-body">
      <h6>รายการที่ควรสั่งเพิ่ม</h6>
      <ul class="mb-0">${low.map((r) => `<li><code>${escapeHtml(r.sku)}</code> ${escapeHtml(r.name)} — คงเหลือ <strong class="text-danger">${r.total_qty}</strong> / เกณฑ์ ${r.reorder_threshold}</li>`).join('')}</ul>
    </div></div>` : ''}
  `);
```

- [ ] **Step 2: Realtime hook — make the dashboard refresh on inventory change**

At end of `initDashboardTab`, add:

```javascript
  if (window.invSubscribe) {
    let pending = null;
    window.invSubscribe(() => {
      clearTimeout(pending);
      pending = setTimeout(() => window.initDashboardTab(), 500);
    });
  }
```

- [ ] **Step 3: Verify (UI)** — open admin → Dashboard → see 3 KPI cards + low-stock list (if any). After issuing a movement from another tab, the dashboard auto-refreshes within ~1s.

- [ ] **Step 4: Commit**

```bash
git add js/dashboard.js
git commit -m "feat(ui): dashboard inventory panels (total / low-stock / today)"
```

---

# Phase G — SW bump + smoke tests + manual checklist + docs

## Task G1: Bump CACHE_VERSION and register new Phase 1 assets

**Spec ref:** §4 "EDIT — add new HTML/JS to STATIC_ASSETS; bump CACHE_VERSION".

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\sw.js`

- [ ] **Step 1: Edit `sw.js`** — bump version + add Phase 1 entries:

```javascript
const CACHE_VERSION = 'thegood-stock-v0.2.0';
const STATIC_ASSETS = [
  './',
  './login.html',
  './index.html',
  './admin.html',
  './staff.html',
  './staff-scan.html',          // Phase 1
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
  './shared/inventory.js',      // Phase 1
  './shared/scanner.js',        // Phase 1
  './js/login.js',
  './js/admin-shell.js',
  './js/dashboard.js',
  './js/locations.js',
  './js/ambulances.js',
  './js/settings-ui.js',
  './js/sessions-ui.js',
  './js/staff-home.js',
  './js/inventory.js',          // Phase 1
  './js/inventory-finder.js',   // Phase 1
  './js/inventory-scan.js',     // Phase 1
  './js/staff-scan.js',         // Phase 1
];
```

- [ ] **Step 2: Push to Pages, reload twice (first reload activates new SW; second is cache-hit).**

- [ ] **Step 3: DevTools → Application → Service Workers** — expect `thegood-stock-v0.2.0` active. Cache Storage shows the v0.2.0 cache populated, v0.1.0 deleted.

- [ ] **Step 4: Commit**

```bash
git add sw.js
git commit -m "chore(pwa): bump CACHE_VERSION v0.2.0 + Phase 1 assets"
```

---

## Task G2: Extend smoke-test.sh with Phase 1 checks

**Spec ref:** §9 smoke tests (4 listed).

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\tools\smoke-test.sh`

- [ ] **Step 1: Append**

```bash

echo "5. stock_items count"
curl -sS "https://$PROJECT_REF.supabase.co/rest/v1/stock_items?select=id" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('stock_items rows:', len(d))"

echo "6. Realtime publication includes stock tables"
curl -sS "https://$PROJECT_REF.supabase.co/rest/v1/rpc/pg_get_publication_tables" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" -d '{"pubname":"supabase_realtime"}' | head -c 400; echo
# Fallback if no RPC wrapper — run via SQL editor:
#   SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename LIKE 'stock_%';
# Expected: stock_items, stock_item_locations

echo "7. Low-stock dedupe round-trip (Admin JWT required)"
if [ -n "${ADMIN_JWT:-}" ]; then
  curl -sS -X POST "https://$PROJECT_REF.supabase.co/functions/v1/tg-notify" \
    -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
    -d '{"event_type":"low_stock","dedupe_key":"smoke:phase1","message":"smoke phase1"}' | head -c 200; echo
  echo "  → second call same key:"
  curl -sS -X POST "https://$PROJECT_REF.supabase.co/functions/v1/tg-notify" \
    -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
    -d '{"event_type":"low_stock","dedupe_key":"smoke:phase1","message":"smoke phase1"}' | head -c 200; echo
fi
```

- [ ] **Step 2: Run** `PROJECT_REF=... ANON_KEY=... ADMIN_JWT=... ./tools/smoke-test.sh`

Expected: stock_items row count ≥ 1, 7th check shows `dedupe_hit:true` on second call.

- [ ] **Step 3: Commit**

```bash
git add tools/smoke-test.sh
git commit -m "tools: extend smoke-test.sh with Phase 1 checks"
```

---

## Task G3: Manual checklist T24–T44 — execute and tick

**Spec ref:** §9 (full list).

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\docs\test-checklist.md` (append Phase 1 section)

- [ ] **Step 1: Append Phase 1 section to `docs/test-checklist.md`**:

```markdown

## Phase 1 — Inventory + Multi-Location + Low-stock + Item Finder

### Items & categories
- [ ] T24: Create category "ITAS" → row in stock_categories
- [ ] T25: Create item gauze SUP-GAUZE-001 with threshold 20 → list shows it with total_qty=0
- [ ] T26: Duplicate SKU on create → 409 inline "SKU ซ้ำ"
- [ ] T26b (F1-added): Deactivate the item → disappears from active-only list; reappears when active filter off
- [ ] T27: Employee POST to stock_items via DevTools → 403
- [ ] T28: Item Finder "ผ้า" with zero qty → "ไม่มีในคลัง"

### Receive
- [ ] T29: Admin Receive 100 at ROOM-A → mv row + sil qty=100 + qty_after=100
- [ ] T30: Receive 30 at SHELF-A1-T1 → 2 sil rows, total=130
- [ ] T31: Employee POSTs movement_type=receive via DevTools → 403
- [ ] T32: Finder lists both locations

### Scan-receive (admin)
- [ ] T33: Open scan-receive → barcode → location QR → qty 50 → success row with client_ref_id
- [ ] T34: Replay same client_ref_id → idempotent_replay:true (no second row)
- [ ] T35: Scan unknown barcode → "ไม่พบสินค้า"
- [ ] T36: Scan unknown location → "ไม่พบตู้/ชั้น"

### Issue / staff scan
- [ ] T37: Employee scan-issue 10 from ROOM-A → mv issue -10 + sil 90
- [ ] T38: Issue 200 (> on hand) → "ของไม่พอ" / no row
- [ ] T39: Issue from a location with no SIL row → "ของไม่พอ"
- [ ] T40: Admin Inventory tab in browser A sees T37 update within ~1s (Realtime)

### Low-stock alert
- [ ] T41: Threshold=20, issue across total down to ≤20 → Telegram message + notification_log row
- [ ] T42: Same-day repeat → dedupe (no 2nd Telegram message; notification_log shows dedupe_hit path)
- [ ] T43: Expire dedupe (or wait 24h) → next issue triggers fresh message

### Multi-Location
- [ ] T44: Issue from 2 locations → math correct, ONE alert (not per-location)

### Dashboard (F1-added)
- [ ] T44b: Admin dashboard shows 3 KPI cards + "รายการที่ควรสั่งเพิ่ม" list
- [ ] T44c: Issue a movement in another tab → dashboard auto-refreshes within ~1s
```

- [ ] **Step 2: Execute every row** as a human (or via Chrome MCP for the click-heavy ones). Capture screenshots for T33, T37, T40, T41, T44.

- [ ] **Step 3: Tick all boxes, commit**

```bash
git add docs/test-checklist.md
git commit -m "test: Phase 1 manual checklist T24-T44 all green"
```

If a row fails: open an issue, fix in a new commit, re-run only the affected row.

---

## Task G4: Docs hand-off

**Files:**
- Edit: `F:\@Coding\ระบบ\The Good Stock\docs\deploy.md` (append Phase 1 section already drafted in Task B2 Step 4)
- Edit: `F:\@Coding\ระบบ\The Good Stock\README.md` (update status line)

- [ ] **Step 1: Append to `docs/deploy.md`**

```markdown

## Phase 1 — Inventory deploy steps

In addition to Phase 0:

1. `supabase db push` — applies migrations `20260519000000…000600`
2. **One-off**: in SQL editor (as project owner):

   ```sql
   ALTER DATABASE postgres SET app.supabase_url     = 'https://<PROJECT_REF>.supabase.co';
   ALTER DATABASE postgres SET app.service_role_key = '<SRK>';
   ```

   Required by the low-stock trigger. Verify with:

   ```sql
   SELECT current_setting('app.supabase_url', true) AS url,
          length(current_setting('app.service_role_key', true)) AS srk_len;
   ```

3. No new Edge Function — `tg-notify` (Phase 0) is reused for `event_type='low_stock'`.
4. Push frontend — GitHub Pages auto-deploys.
5. Verify `staff-scan.html` is reachable from staff landing.
6. Run `./tools/smoke-test.sh` — expect all 7 checks pass.
```

- [ ] **Step 2: Update `README.md`** — change status line to:

```markdown
- **Status:** Phase 1 (Inventory) — DRAFT plan pending, will be LIVE on merge
- **Phase 1 spec:** `docs/superpowers/specs/2026-05-18-phase1-inventory-design.md`
- **Phase 1 plan:** `docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md`
```

- [ ] **Step 3: Snapshot DB**

```bash
supabase db dump --schema public > tools/snapshots/$(date +%Y%m%d-%H%M)-phase1-final.sql
git add tools/snapshots/ docs/deploy.md README.md
git commit -m "docs: Phase 1 deploy steps + status update"
```

- [ ] **Step 4: Hand-off**

Phase 1 is done when:
- All boxes in the Phase 1 section of `docs/test-checklist.md` are ticked.
- `tools/smoke-test.sh` passes 7 checks cleanly.
- A real Telegram low-stock message has appeared in the configured group from a real issue movement.
- `https://officethegood.github.io/thegood-stock/admin.html` shows the Inventory tab; `staff-scan.html` works on mobile.

Tag the release:

```bash
git tag -a phase1-inventory -m "Phase 1 — Inventory + Multi-Location + Low-stock + Item Finder"
git push --tags
```

---

# Self-Review

Run after the plan is written. Findings folded inline above.

**Spec coverage:** every spec section maps to ≥1 task.

| Spec section | Tasks |
|---|---|
| §1 Purpose | informational |
| §2 Architecture | covered collectively by A1–G4 |
| §3 Sync strategy | row 6/7/13-17 → C1 (REST helpers + Realtime), B1 (trigger), D7 (live-update test) |
| §4 Repo structure | every file in §4 has a Create task |
| §5.1 stock_categories | A1 |
| §5.2 stock_items | A2 |
| §5.3 stock_item_locations + view | A3 |
| §5.4 stock_movements + enum | A4 |
| §5.5 triggers (sign / apply / lowstock) | B1 |
| §5.6 RLS | A5 |
| §5.7 Realtime | A6 |
| §6 No new edge fn | architectural; B1 reuses tg-notify via pg_net |
| §7.1 Admin tab | D1–D5 |
| §7.2 Scan overlay | D4 |
| §7.3 staff-scan.html | E1–E3 |
| §8 RLS matrix | A5 + D6 verify |
| §9 T24–T44 | G3 (all 21) plus per-task verifications threaded through D2–E4 |
| §10 Out-of-scope | listed in Deferred below |
| §11 Open Qs | all locked per Q-Phase1-A…O |
| §12 Decisions log | binding; honored throughout |
| §13 PDF coverage self-check | extended by F1 finding (T26b, T44b, T44c) |
| §14 Effort | reflected in Reading-order table |

**PDF coverage:** every PDF §1/§2/§3/§4/§9 Phase 1 requirement has at least one acceptance row in `docs/test-checklist.md`. See the "Pre-implementation findings" §F1 table.

**Files touched:** strictly the file list in spec §4 plus `js/admin-shell.js` (edit, registered in spec §4), `admin.html` (edit), `staff.html` (edit), `sw.js` (edit), `docs/test-checklist.md`, `docs/deploy.md`, `README.md`, `tools/smoke-test.sh`. **No file outside Phase 1 scope is touched.**

---

# Deferred (Phase 2+ — out of Phase 1 scope, do not implement here)

Mirror of spec §10. Listed so future agents do not pull these into Phase 1.

| Item | Phase | Schema hook already in Phase 1 |
|---|---|---|
| Medication lots + expiry + 30/60/90d alerts | 2 | `stock_items.tracks_lots boolean` + `stock_movements.lot_id uuid` |
| Borrow / return + photo proof + overdue alerts | 3 | `movement_type` enum has `borrow`/`return`; `stock_movements.source_movement_id` |
| Cloudinary item images on items master | 3 | `stock_items.image_url text` |
| ALS bag kit composition + kit-restock workflow | 4 | Phase 0 `bag` location type; new `kits` table to be added |
| Oxygen tank per-piece serial state machine | 5 | **separate** `oxygen_tanks` table (not a child of stock_items) — Q-Phase1-P |
| Linens cabinet count + photo + laundry state | 6 | new `linen_counts` table to be added |
| Offline scan queue (SW background sync) | 1.1 | `client_ref_id UUID UNIQUE` already there for safe replay |
| Per-piece serial for general inventory | not planned | n/a |
| Multi-Telegram-chat routing | not planned | n/a (current single chat) |
| Per-SKU dedupe-window override | 2+ | global `LOW_STOCK_DEDUPE_HOURS` reused for Phase 1 |
| Decimal qty (numeric) | 2 (with medication) | Phase 1 keeps `int` per Q-Phase1-N |
| Label / barcode printing | not planned | Phase 1 reads only |
| Transfer between locations as one atomic op | 2+ | enum has `transfer_in`/`transfer_out` reserved |
| Stock-take / cycle-count guided workflow | 2+ | manual `adjustment_gain`/`adjustment_loss` works for Phase 1 |
| Dashboard expiry overview + borrow status panels | 2 / 3 | scoped out per spec §1 |

---

# End of plan
