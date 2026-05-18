# DRAFT — Phase 3 Equipment Borrow/Return Design
# Status: DRAFT — pending PM review

**Project:** Thegood Stock Management System
**Phase:** 3 — Equipment Borrow/Return with Photo Proof + Overdue Alerts
**Date:** 2026-05-19
**Author:** Business/System Analyst
**Status:** DRAFT — pending PM review. Six open questions in §11 need PM decisions before plan write-up.
**Predecessor:**
- `docs/superpowers/specs/2026-05-18-phase1-inventory-design.md` (Phase 1 — General Inventory)
- `docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md` (Phase 2 — Medication Lots; decisions locked)
- `docs/superpowers/audits/2026-05-19-phase2-security.md` (S-1 `is_secret` pattern; applied here)

---

## 1. Purpose & Scope

### 1.1 Purpose

Phase 3 enables staff at Thegood to formally **borrow** reusable equipment (stretchers, monitors, splints, bags, etc.) and **return** it with photographic proof, and alerts the admin team when loans become overdue.

The PDF source (`ระบบจัดการสต๊อกและอุปกรณ์การแพทย์.pdf`, §3 + §7 + §8) specifies:

- **§3 Borrow/Return module:** item scan, borrower identity, due date, photo at borrow and at return.
- **§7 Overdue alerts:** automated Telegram notification when `due_at < now()` and item not yet returned.
- **§8 Photo proof via Cloudinary:** direct browser-to-Cloudinary upload; server stores the resulting URL only.

Phase 1 reserved `borrow` and `return` in `stock_movement_type` enum (§5.4, decision Q-Phase1-L) and explicitly noted RLS would be extended in Phase 3 (§5.6 comment). Phase 3 fulfils both reservations.

### 1.2 In Scope

- New table `stock_loans` (§5.1) — loan lifecycle state machine.
- Trigger `trg_sm_create_loan` — AFTER INSERT on `stock_movements` WHERE `movement_type='borrow'` → creates a `stock_loans` row and updates `stock_item_locations.qty` (via the existing Phase 1 `apply_movement_to_sil` trigger, qty_delta negative).
- Trigger `trg_sm_close_loan` — AFTER INSERT on `stock_movements` WHERE `movement_type='return'` → closes the matching `stock_loans` row, sets `returned_at` + `photo_return_url`, updates `stock_item_locations.qty` (qty_delta positive).
- RLS extension on `stock_movements`: Staff (Employee role) can INSERT `movement_type IN ('borrow','return')` (extends Phase 1 §5.6; no DDL change to the enum needed).
- Cloudinary photo upload — client-side direct upload using `shared/cloudinary.js` (Phase 0 already ships this helper). Folder prefix: `thegood-stock/borrow/{loan_id}/`. Server stores URL only. Photo upload failure does NOT block the movement; UI shows a warning toast.
- `pg_cron` overdue alerts at **09:00 and 17:00 Asia/Bangkok** — finds `stock_loans.status='active'` AND `due_at < now()`, updates their `status='overdue'`, and posts a Telegram message per loan (or grouped if > 10 loans overdue; see §11 Q-Phase3-F).
- New admin section **"อุปกรณ์ยืม-คืน"** — placement decision in §11 Q-Phase3-A (5th segment in existing 4-segment Inventory tab vs new standalone admin tab).
- Staff borrow flow: scan item → scan source location → capture photo → set due_at → submit.
- Staff return flow: scan item → capture photo → confirm return.
- Dashboard panel **"สถานะอุปกรณ์ยืม-คืน"** — replaces Phase 1's placeholder widget.
- Acceptance tests T76–T100 (continuing from Phase 2's T75; assumed; TBD exact Phase 2 end-test — flag Q-Phase3-B).
- DEPLOY NOTE: every new trigger function that reads `NOTIFY_SUPABASE_URL` / `NOTIFY_SERVICE_ROLE_KEY` must read from the `settings` table rows (NOT `current_setting()`), following Project.md §8 gotcha #9. Both keys must be present in `settings` before Phase 3 migrations run.

### 1.3 Out of Scope (Phase 3)

| Item | Deferred to | Reason |
|---|---|---|
| Per-piece serial tracking for borrowed items | Phase 5 | Oxygen-style serial identity is Phase 5; Phase 3 borrows by item_id + qty (same Phase 1 model) |
| Equipment maintenance / service state machine | Not planned | Not in PDF; separate concern from borrow lifecycle |
| Borrow approval workflow (admin must approve before item leaves) | Phase 3.1 | Phase 3 is self-service for staff; approval gate can be added without schema change |
| Multiple borrowers for same item split across qty | Phase 3.1 | Phase 3 creates one `stock_loans` row per borrow movement; qty split across borrowers is a future enhancement |
| Late-return penalty or fee tracking | Not planned | Not in PDF |
| Push notifications (browser Web Push) | Not planned | User confirmed web-only, no PWA install; Telegram is the notification channel |
| QR label generation for equipment | Phase 3.1 | Phase 3 reads existing QR/barcode labels; printing is out of scope (same as Phase 1) |
| Bulk borrow (multiple items in one transaction) | Phase 3.1 | Single-item scan flow in Phase 3; batch flow deferred |
| Photo required enforcement | Phase 3.1 | Phase 3 allows null photo with warning toast (business requires no hard block; confirm in Q-Phase3-C) |
| Email / LINE notification channel | Not planned | Single Telegram group reused from Phase 0 |

---

## 2. Architecture

Phase 3 is additive. Phase 0–2 surfaces are unchanged.

```
┌───────────────────────────────────────────────────────────────────────┐
│ Browser (mobile-first)                                                 │
│ GitHub Pages: officethegood.github.io/thegood-stock                    │
│                                                                        │
│ Admin (admin.html)                                                     │
│   └─ Inventory tab OR new "ยืม-คืน" tab (Q-Phase3-A)                  │
│       ├─ Segment: รายการยืม-คืน  (loan list, status filter)            │
│       ├─ Segment: ยืมออก         (admin borrow on behalf of staff)     │
│       └─ Dashboard panel: สถานะอุปกรณ์ยืม-คืน                         │
│                                                                        │
│ Staff (staff.html / staff-scan.html)                                   │
│   ├─ ยืมอุปกรณ์ button → borrow scan flow                              │
│   └─ คืนอุปกรณ์ button → return scan flow                             │
└──────────────────────────────────┬────────────────────────────────────┘
                                   │
               ┌───────────────────┴───────────────────┐
               │ Supabase REST + Realtime WebSocket    │
               └───────────────────┬───────────────────┘
                                   │
               ┌───────────────────┴───────────────────┐
               │ Postgres (thegood-stock)               │
               │  Phase 0 tables (unchanged)            │
               │  Phase 1 tables (unchanged)            │
               │  Phase 2 tables (unchanged)            │
               │  Phase 3 NEW:                          │
               │    stock_loans                         │
               │  Phase 3 NEW triggers:                 │
               │    trg_sm_create_loan (AFTER INSERT    │
               │       on stock_movements type=borrow)  │
               │    trg_sm_close_loan  (AFTER INSERT    │
               │       on stock_movements type=return)  │
               │  Phase 3 MODIFIED:                     │
               │    stock_movements RLS — add borrow/   │
               │      return to Staff INSERT policy     │
               │  Phase 3 NEW pg_cron jobs:             │
               │    overdue_alert_morning (09:00 BKK)   │
               │    overdue_alert_evening (17:00 BKK)   │
               └───────────────────┬───────────────────┘
                                   │
                    ┌──────────────┤
                    ▼              ▼
          ┌──────────────┐  ┌─────────────────────────────────┐
          │ Cloudinary   │  │ tg-notify Edge Function (Phase 0)│
          │ ddummbyql    │  │  ← pg_net POST from triggers +   │
          │ direct upload│  │    cron                          │
          │ (browser)    │  └─────────────────────────────────┘
          └──────────────┘
```

### Key Phase 3 Principles

| Principle | Implementation |
|---|---|
| **Reuse existing plumbing** | No new Edge Function. Trigger + pg_net + tg-notify (same path as Phase 1 low-stock and Phase 2 expiry). |
| **`stock_loans` as state machine** | Status enum `active → overdue` (by cron) or `active → returned` (by return movement). Triggers maintain consistency between `stock_loans` and `stock_movements`. |
| **Photo is advisory, not blocking** | Cloudinary upload is browser-side; server accepts movement even if `photo_url = null`. Warning toast only. This mirrors real-world constraint: a camera failure must not prevent a return. |
| **Settings table for secrets** | All trigger functions read `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from `settings` table (not `current_setting`). Required by Project.md §8 gotcha #9 (verified live in Phase 1). |
| **is_secret hygiene** | No new secret keys added to `settings` in Phase 3. Cloudinary API key is NOT stored in `settings`; it is used only in the browser via the existing Phase 0 `shared/cloudinary.js` (which reads from `shared/config.js` — already public). Any future Cloudinary signing secret must use `is_secret=true` per S-1 pattern. |
| **Quantity semantics** | A `borrow` movement has `qty_delta` negative (reduces stock at source location, same as `issue`). A `return` movement has `qty_delta` positive (restores qty at source location, same as `receive`). The existing Phase 1 `apply_movement_to_sil` trigger handles qty update; Phase 3 trigger fires AFTER it. |

---

## 3. Sync Strategy (rows 23–27 added to Phase 1 table)

Phase 3 adds 5 rows to the sync strategy. Rows 1–22 are inherited from Phase 0, Phase 1, and Phase 2 specs.

| # | Data | Type | Mechanism | Cadence | Phase |
|---|---|---|---|---|---|
| 1–22 | (Phase 0–2 sync rows — login, realtime stock, expiry cron, etc.) | — | — | — | 0–2 |
| 23 | **Borrow movement write** | Request-Response (idempotent) | Client INSERT `stock_movements(movement_type='borrow')` with `client_ref_id` UUID; trigger creates `stock_loans` row; `apply_movement_to_sil` reduces qty | per scan | **3** |
| 24 | **Return movement write** | Request-Response (idempotent) | Client INSERT `stock_movements(movement_type='return')` with `client_ref_id` UUID; trigger closes `stock_loans` row | per scan | **3** |
| 25 | **Loan list (admin)** | Request-Response | Supabase REST: `SELECT stock_loans LEFT JOIN stock_items LEFT JOIN stock_movements` with status/date filters | per page load + filter | **3** |
| 26 | **Dashboard borrow panel** | Realtime | Postgres replication → WS on `stock_loans` channel; refresh counters (active / overdue / returned today) | live | **3** |
| 27 | **Overdue alert (cron)** | Autosync (cron) | `pg_cron` at 09:00 + 17:00 Asia/Bangkok: UPDATE `stock_loans.status='overdue'` where `status='active' AND due_at < now()`; pg_net POST to `tg-notify` per overdue loan (grouped if >10) | 2× / day | **3** |

**Realtime table added in Phase 3:**
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE stock_loans;
```

---

## 4. Repository Structure (new files only)

Phase 0–2 layout is unchanged. Phase 3 adds:

```
thegood-stock/
│
├── js/
│   ├── loans.js                               (NEW — admin "ยืม-คืน" tab or segment init + loan list)
│   ├── loans-scan.js                          (NEW — admin borrow-on-behalf scan flow)
│   └── staff-borrow.js                        (NEW — staff borrow + return scan flow)
│
├── shared/
│   └── (cloudinary.js already exists — Phase 0; no changes needed for Phase 3 upload path)
│
├── supabase/
│   └── migrations/
│       ├── 20260519020000_stock_loans.sql      (NEW — stock_loans table + enum)
│       ├── 20260519020100_loan_triggers.sql    (NEW — trg_sm_create_loan + trg_sm_close_loan + overdue cron function)
│       ├── 20260519020200_loan_rls.sql         (NEW — RLS on stock_loans + extend sm_insert_staff)
│       ├── 20260519020300_loan_realtime.sql    (NEW — ADD TABLE stock_loans to publication)
│       └── 20260519020400_loan_cron.sql        (NEW — pg_cron schedule for 09:00 + 17:00 BKK)
│
├── js/
│   └── admin-shell.js                         (EDIT — register new tab or segment per Q-Phase3-A decision)
│
├── sw.js                                      (EDIT — add new JS files to STATIC_ASSETS; bump CACHE_VERSION)
│
└── docs/
    └── superpowers/specs/
        └── 2026-05-19-phase3-borrow-return-design.md   (this file)
```

No new Edge Function. `tg-notify` (Phase 0) is reused unchanged.

---

## 5. Data Model

### 5.1 `stock_loan_status` enum + `stock_loans` table (`20260519020000_stock_loans.sql`)

**Assumption A1:** One `stock_loans` row corresponds to one borrow event (one `stock_movements` row with `movement_type='borrow'`). A return closes the loan. Partial returns are out of scope for Phase 3.

**Assumption A2:** `borrower_username` is the `app_username()` of whoever inserts the borrow movement. Overridable by Admin (Admin can borrow on behalf of a staff member by passing a different `borrower_username` in the note or a dedicated column — see Q-Phase3-D).

**Assumption A3:** `location_id_from` is the `location_id` on the borrow movement (the shelf/cabinet the item came from). It is stored in `stock_loans` for the return path, so the return movement can credit qty back to the correct location.

```sql
-- Verification SQL: SELECT count(*) FROM stock_loans WHERE status NOT IN ('active','returned','overdue');
-- Expected: 0

CREATE TYPE stock_loan_status AS ENUM (
  'active',     -- borrowed; not yet returned; not yet overdue
  'returned',   -- returned; loan closed
  'overdue'     -- due_at < now() and not yet returned (set by cron)
);

CREATE TABLE stock_loans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Movement links
  movement_id_borrow    uuid NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  movement_id_return    uuid          REFERENCES stock_movements(id) ON DELETE RESTRICT,

  -- Item + location snapshot (denormalized for query performance; source is the borrow movement)
  item_id               uuid NOT NULL REFERENCES stock_items(id)     ON DELETE RESTRICT,
  location_id_from      uuid NOT NULL REFERENCES locations(id)       ON DELETE RESTRICT,

  -- Borrower
  borrower_username     text NOT NULL,

  -- Timestamps
  borrowed_at           timestamptz NOT NULL DEFAULT now(),
  due_at                timestamptz NOT NULL,
  returned_at           timestamptz,

  -- Photo proof (nullable; upload failure must not block movement)
  photo_borrow_url      text,    -- Cloudinary URL; folder: thegood-stock/borrow/{id}/borrow.*
  photo_return_url      text,    -- Cloudinary URL; folder: thegood-stock/borrow/{id}/return.*

  -- Quantity borrowed
  qty                   int NOT NULL DEFAULT 1 CHECK (qty > 0),

  -- State
  status                stock_loan_status NOT NULL DEFAULT 'active',

  -- Free-text fields
  notes                 text,

  -- Audit
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  created_by            text DEFAULT app_username(),
  updated_by            text,

  -- Constraints
  CONSTRAINT chk_loan_return_consistency
    CHECK (
      (status = 'returned') = (returned_at IS NOT NULL)
      OR status IN ('active','overdue')  -- active/overdue: returned_at must be null
    ),
  CONSTRAINT chk_loan_due_after_borrow CHECK (due_at > borrowed_at)
);

CREATE INDEX idx_loans_item     ON stock_loans(item_id);
CREATE INDEX idx_loans_borrower ON stock_loans(borrower_username);
CREATE INDEX idx_loans_status   ON stock_loans(status) WHERE status IN ('active','overdue');
CREATE INDEX idx_loans_due      ON stock_loans(due_at) WHERE status IN ('active','overdue');
CREATE INDEX idx_loans_mvborrow ON stock_loans(movement_id_borrow);

CREATE TRIGGER trg_loans_updated_at BEFORE UPDATE ON stock_loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Verification SQL (paste into SQL Editor after migration):**
```sql
-- Table exists with correct columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='stock_loans'
ORDER BY ordinal_position;
-- Expected: 18+ rows including id, movement_id_borrow, status, photo_borrow_url, etc.

-- Enum exists
SELECT enumlabel FROM pg_enum
JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
WHERE pg_type.typname = 'stock_loan_status';
-- Expected: active, returned, overdue
```

---

### 5.2 Trigger Functions (`20260519020100_loan_triggers.sql`)

#### 5.2.1 `trg_sm_create_loan` — AFTER INSERT on `stock_movements` WHERE `movement_type='borrow'`

**Design note:** This trigger fires AFTER `apply_movement_to_sil` (Phase 1) has already reduced the qty. So by the time this trigger runs, the source location's qty is already reduced. If `apply_movement_to_sil` raised an exception (e.g., negative qty), the whole transaction was rolled back and this trigger never fires.

```sql
CREATE OR REPLACE FUNCTION create_loan_from_borrow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.movement_type <> 'borrow' THEN
    RETURN NEW;
  END IF;

  -- due_at must be supplied in stock_movements.reason field as ISO 8601 string
  -- OR via a future dedicated column. For Phase 3, encode due_at as note prefix "due_at:<ISO8601>".
  -- See Q-Phase3-E for the preferred mechanism.
  -- TBD: decode due_at from NEW.note or NEW.reason.
  -- If due_at cannot be parsed, default to now() + 7 days with a WARNING.
  -- Assumption: phase 3 client always passes note LIKE 'due_at:2026-06-01T00:00:00+07:00|...'

  INSERT INTO stock_loans (
    movement_id_borrow,
    item_id,
    location_id_from,
    borrower_username,
    borrowed_at,
    due_at,
    qty,
    notes,
    photo_borrow_url,
    status
  ) VALUES (
    NEW.id,
    NEW.item_id,
    NEW.location_id,
    NEW.performed_by,
    NEW.performed_at,
    COALESCE(
      -- Parse due_at from note field; if absent or malformed, default to 7 days
      (CASE
        WHEN NEW.note LIKE 'due_at:%'
        THEN (regexp_match(NEW.note, '^due_at:([^|]+)'))[1]::timestamptz
        ELSE NULL
      END),
      NEW.performed_at + INTERVAL '7 days'
    ),
    ABS(NEW.qty_delta),   -- borrow qty_delta is negative; store absolute value
    NULLIF(regexp_replace(NEW.note, '^due_at:[^|]*\|?', ''), ''),
    NULL,                 -- photo_borrow_url updated by client PATCH after Cloudinary upload
    'active'
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sm_create_loan
  AFTER INSERT ON stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type = 'borrow')
  EXECUTE FUNCTION create_loan_from_borrow();
```

**DEPLOY NOTE — due_at encoding:** The above trigger parses `due_at` from the `note` field using a prefix convention (`due_at:ISO8601|rest of note`). This is a temporary design pending PM decision on Q-Phase3-E (dedicated column vs note encoding vs RPC wrapper). If PM chooses a dedicated column, the trigger changes to read `NEW.due_at` directly and the note-parsing code is removed.

**Trigger error strings (FE-greppable, Thai):**
- `'ไม่พบรายการยืมที่เปิดอยู่'` — return movement posted but no active `stock_loans` row found for that item+borrower.
- `'ของยืมเลยกำหนด'` — informational: borrow movement posted when `due_at < now()` (past-due borrow date; unlikely but guard).
- Negative qty error from Phase 1 `apply_movement_to_sil`: `'movement would drive qty negative for item % at location %'` (already exists in Phase 1 trigger; surfaced to FE as "ของไม่พอ").

#### 5.2.2 `trg_sm_close_loan` — AFTER INSERT on `stock_movements` WHERE `movement_type='return'`

```sql
CREATE OR REPLACE FUNCTION close_loan_from_return()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_loan_id   uuid;
  v_loan_status stock_loan_status;
BEGIN
  IF NEW.movement_type <> 'return' THEN
    RETURN NEW;
  END IF;

  -- Find the most recent open loan for this item by this borrower.
  -- Match criteria: same item_id, borrower = performed_by, status IN ('active','overdue').
  SELECT id, status INTO v_loan_id, v_loan_status
  FROM stock_loans
  WHERE item_id = NEW.item_id
    AND borrower_username = NEW.performed_by
    AND status IN ('active','overdue')
  ORDER BY borrowed_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %',
      NEW.performed_by, NEW.item_id;
  END IF;

  UPDATE stock_loans
  SET
    movement_id_return = NEW.id,
    returned_at        = NEW.performed_at,
    photo_return_url   = NULL,   -- updated by client PATCH after Cloudinary upload
    status             = 'returned',
    updated_by         = NEW.performed_by
  WHERE id = v_loan_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sm_close_loan
  AFTER INSERT ON stock_movements
  FOR EACH ROW
  WHEN (NEW.movement_type = 'return')
  EXECUTE FUNCTION close_loan_from_return();
```

#### 5.2.3 `run_overdue_alert()` — Called by `pg_cron`

This function is called by both the 09:00 and 17:00 `pg_cron` jobs. It:
1. Updates `stock_loans.status = 'overdue'` for all active loans where `due_at < now()`.
2. For each newly-overdue loan (or all overdue loans if PM chooses — see Q-Phase3-F), posts a Telegram message via `tg-notify`.

**DEPLOY NOTE:** Reads `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` from the `settings` table (NOT `current_setting`). This is mandatory per Project.md §8 gotcha #9. The two keys must exist in `settings` and be non-empty before Phase 3 cron jobs run.

```sql
CREATE OR REPLACE FUNCTION run_overdue_alert()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_url       text;
  v_srk       text;
  v_enabled   text;
  v_chat_id   text;
  v_loan      record;
  v_count     int := 0;
  v_summary   text := '';
  v_dedupe    text;
  v_msg       text;
  v_payload   jsonb;
BEGIN
  -- Read settings from table (NOT current_setting — per Project.md §8 gotcha #9)
  SELECT value INTO v_url   FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_srk   FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT value INTO v_enabled FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
  SELECT value INTO v_chat_id FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';

  IF v_url IS NULL OR v_srk IS NULL THEN
    RAISE WARNING 'run_overdue_alert: NOTIFY_SUPABASE_URL or NOTIFY_SERVICE_ROLE_KEY missing in settings — skipping pg_net call';
    RETURN;
  END IF;

  -- Step 1: Mark newly overdue loans
  UPDATE stock_loans
  SET status = 'overdue', updated_by = 'system:cron'
  WHERE status = 'active'
    AND due_at < now();

  -- Step 2: Count all currently overdue (not yet returned) loans
  SELECT count(*) INTO v_count
  FROM stock_loans
  WHERE status = 'overdue';

  IF v_count = 0 THEN
    RETURN;  -- nothing to alert
  END IF;

  -- Step 3: Alert — grouped if > 10, individual if <= 10
  IF v_count > 10 THEN
    -- Grouped summary
    v_dedupe := 'overdue_batch:' || to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24');
    v_msg    := format('⚠️ มีอุปกรณ์เลยกำหนดคืน %s รายการ กรุณาตรวจสอบแท็บอุปกรณ์ยืม-คืน', v_count);
    v_payload := jsonb_build_object(
      'event_type',   'overdue_batch',
      'overdue_count', v_count,
      'checked_at',   now()
    );
    PERFORM net.http_post(
      url     := v_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'content-type',  'application/json',
        'apikey',        v_srk,
        'authorization', 'Bearer ' || v_srk,
        'X-Internal',    'true'
      ),
      body := jsonb_build_object(
        'event_type', 'overdue_batch',
        'entity_type', 'stock_loans',
        'entity_id',   'batch',
        'dedupe_key',  v_dedupe,
        'message',     v_msg,
        'payload',     v_payload
      )
    );
  ELSE
    -- Individual alert per loan
    FOR v_loan IN
      SELECT sl.id, sl.borrower_username, sl.due_at, sl.qty,
             si.name AS item_name, si.sku
      FROM stock_loans sl
      JOIN stock_items si ON si.id = sl.item_id
      WHERE sl.status = 'overdue'
      ORDER BY sl.due_at ASC
    LOOP
      v_dedupe := 'overdue_loan:' || v_loan.id::text || ':' ||
                  to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24');
      v_msg    := format('⚠️ เลยกำหนดคืน: %s (%s) จำนวน %s — ยืมโดย %s — ครบกำหนด %s',
                    v_loan.item_name,
                    v_loan.sku,
                    v_loan.qty,
                    v_loan.borrower_username,
                    to_char(v_loan.due_at AT TIME ZONE 'Asia/Bangkok', 'DD Mon YYYY HH24:MI'));
      v_payload := jsonb_build_object(
        'loan_id',           v_loan.id,
        'item_name',         v_loan.item_name,
        'sku',               v_loan.sku,
        'borrower_username', v_loan.borrower_username,
        'due_at',            v_loan.due_at,
        'qty',               v_loan.qty
      );
      PERFORM net.http_post(
        url     := v_url || '/functions/v1/tg-notify',
        headers := jsonb_build_object(
          'content-type',  'application/json',
          'apikey',        v_srk,
          'authorization', 'Bearer ' || v_srk,
          'X-Internal',    'true'
        ),
        body := jsonb_build_object(
          'event_type', 'overdue_loan',
          'entity_type', 'stock_loan',
          'entity_id',   v_loan.id::text,
          'dedupe_key',  v_dedupe,
          'message',     v_msg,
          'payload',     v_payload
        )
      );
    END LOOP;
  END IF;
END;
$$;
```

**Trigger error strings summary (all Thai, FE-greppable):**

| String | Where raised | Meaning |
|---|---|---|
| `'ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %'` | `close_loan_from_return` | Return posted but no open loan found for that borrower+item |
| `'ของยืมเลยกำหนด'` | `create_loan_from_borrow` (guard; unlikely) | Borrow posted with a `due_at` in the past |
| Phase 1 existing: `'movement would drive qty negative...'` | `apply_movement_to_sil` (Phase 1) | Item not in stock at the source location |

---

### 5.3 `pg_cron` Schedule (`20260519020400_loan_cron.sql`)

```sql
-- Prerequisite: pg_cron extension already enabled (Phase 2 did this).
-- Verify: SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron';

-- 09:00 Asia/Bangkok = 02:00 UTC (UTC+7)
SELECT cron.schedule(
  'overdue_alert_morning',
  '0 2 * * *',       -- 02:00 UTC = 09:00 BKK
  $$SELECT run_overdue_alert();$$
);

-- 17:00 Asia/Bangkok = 10:00 UTC (UTC+7)
SELECT cron.schedule(
  'overdue_alert_evening',
  '0 10 * * *',      -- 10:00 UTC = 17:00 BKK
  $$SELECT run_overdue_alert();$$
);

-- Verification SQL:
-- SELECT jobname, schedule, command FROM cron.job
-- WHERE jobname IN ('overdue_alert_morning','overdue_alert_evening');
-- Expected: 2 rows with correct schedule strings.
```

**Assumption A4:** Phase 2's `pg_cron` job for expiry alerts already used `pg_cron.run_in_database = 'postgres'` (required on Supabase for functions in `public` schema). If Phase 2 cron is verified working, Phase 3 cron will work with the same extension setup. If Phase 2 cron has not been run yet, pre-flight must confirm `pg_cron` is enabled and the extension is on the Supabase plan.

---

## 6. Edge Functions

**None new in Phase 3.**

Rationale:
- All writes go through Supabase REST with RLS. The triggers handle `stock_loans` lifecycle.
- Overdue alerts fire from `pg_cron` → `run_overdue_alert()` → `pg_net` → `tg-notify` (existing Phase 0 function, unchanged).
- Photo upload is client-to-Cloudinary direct; the server receives only the resulting URL via a PATCH on `stock_loans`.
- Idempotency: borrow and return movements use `client_ref_id UUID UNIQUE` on `stock_movements` (same as Phase 1 §5.4).

The existing three Edge Functions (auth-bridge, sync-ambulances, tg-notify) require no changes.

---

## 7. UI Spec

### 7.1 Admin Tab Decision: Open Question Q-Phase3-A

See §11 Q-Phase3-A for options. This section describes the UI spec for both options; the difference is only in tab placement.

### 7.2 Loan List View (admin)

**Location:** Either a new 5th segment inside the Inventory tab or a new top-level "ยืม-คืน" tab (per Q-Phase3-A).

**Columns:** รหัสการยืม (short ID) | สินค้า (ชื่อ + SKU) | ผู้ยืม | ตำแหน่งเดิม | จำนวน | ยืมเมื่อ | ครบกำหนด | สถานะ | รูปถ่าย

**Status badge colors (reuse Phase 0 teal palette):**
- `active` → teal badge "กำลังยืม"
- `overdue` → red badge "เลยกำหนด"
- `returned` → grey badge "คืนแล้ว"

**Filters:** สถานะ (all / active+overdue / returned) | ผู้ยืม (text) | ช่วงวันที่

**Row actions:**
- "บันทึกคืน" button (Admin only) — opens return modal → Admin can record return on behalf of staff.
- "ดูรูปถ่าย" — opens photo in new tab (Cloudinary URL).

**Dashboard panel** (top of tab or widget on admin dashboard.js):
- Card: กำลังยืม (count of `status='active'`), เลยกำหนด (count of `status='overdue'`), คืนวันนี้ (count of `returned_at::date = today`)
- Realtime subscription on `stock_loans` channel.

### 7.3 Staff Borrow Flow

Triggered by "ยืมอุปกรณ์" button on `staff.html` landing page (or inside `staff-scan.html`).

**Step 1 — Scan item:**
- Camera scan (same `shared/scanner.js` as Phase 1) or type SKU.
- On match: show item name, current total qty across all locations.
- If `total_qty = 0` → toast "ของไม่เหลือในคลัง — ไม่สามารถยืมได้" + block proceed.

**Step 2 — Scan source location:**
- Scan location QR or type location code.
- Show current qty at that specific location.
- If location qty = 0 at that location → suggest nearest location with qty > 0 (Item Finder lookup).

**Step 3 — Set qty + due date:**
- Qty input (default 1; max = current qty at location).
- Due date picker (Thai calendar; default = today + TBD days — see Q-Phase3-G).
- Notes textarea (optional).

**Step 4 — Capture borrow photo (optional):**
- "ถ่ายรูปอุปกรณ์ก่อนยืม" button → camera → preview → "ใช้รูปนี้" / "ถ่ายใหม่".
- Skip button available ("ข้าม — ยืนยันโดยไม่มีรูป") → shows warning toast after submit.
- Upload flow: browser calls Cloudinary upload API (`shared/cloudinary.js`) with `folder: thegood-stock/borrow/pending/` (before loan_id exists) → gets back Cloudinary URL → client stores URL in memory for the next step.

**Step 5 — Submit:**
- Client generates `client_ref_id = crypto.randomUUID()`.
- INSERT `stock_movements`: `{movement_type:'borrow', item_id, location_id, qty_delta: -qty, note: 'due_at:<ISO8601>|<user notes>', client_ref_id, performed_by: app_username()}`.
- Trigger `trg_sm_create_loan` fires → `stock_loans` row created with the new `id`.
- Client then PATCHes `stock_loans.photo_borrow_url = <cloudinary_url>` using the `id` returned from the SELECT after INSERT (or from a RPC if needed — see Q-Phase3-E).
- On success: toast "ยืมสำเร็จ — คืนภายใน {due_at}".
- On `client_ref_id` duplicate (409): treat as success-already-posted.

### 7.4 Staff Return Flow

Triggered by "คืนอุปกรณ์" button.

**Step 1 — Scan item:**
- Camera scan or type SKU.
- System looks up open loans for `borrower_username = current_user` and `item_id`. Shows the loan details (borrowed date, due date, qty, overdue badge if applicable).

**Step 2 — Capture return photo (optional):**
- "ถ่ายรูปอุปกรณ์เมื่อคืน" button → same flow as borrow.

**Step 3 — Confirm return:**
- Summary card: สินค้า, จำนวน, ยืมเมื่อ, ครบกำหนด, สถานะ (เลยกำหนด badge if applicable).
- "ยืนยันคืน" button → INSERT `stock_movements` `{movement_type:'return', item_id, location_id: loan.location_id_from, qty_delta: loan.qty, client_ref_id, performed_by}`.
- Trigger `trg_sm_close_loan` fires → loan status = 'returned'.
- Client PATCHes `stock_loans.photo_return_url`.
- On success: toast "คืนสำเร็จ ขอบคุณ".
- If multiple open loans exist for same item → show a list for staff to pick which loan to close (edge case; see Q-Phase3-D).

### 7.5 Cloudinary Upload Details

- **Helper:** `shared/cloudinary.js` (Phase 0, already exists — no changes needed for basic upload).
- **Account:** `ddummbyql` (same as HR; from Project.md §4.6).
- **Upload preset:** `pt-medical` (unsigned; same as HR).
- **Folder prefix for borrow photo:** `thegood-stock/borrow/{loan_id}/borrow` — but `loan_id` is only known AFTER the movement INSERT. Phase 3 client flow:
  1. Upload photo to temp folder `thegood-stock/borrow/pending/` with `client_ref_id` as filename suffix.
  2. After INSERT + trigger creates loan → client fetches the new `stock_loans.id` from the returned movement (via SELECT WHERE `movement_id_borrow = <new movement id>`).
  3. Client PATCHes `stock_loans.photo_borrow_url` with the Cloudinary URL.
  - **Alternative:** upload with `public_id = thegood-stock/borrow/{client_ref_id}/borrow` (use client_ref_id as folder; no rename needed). Simpler; recommended unless PM wants loan_id in the path (Q-Phase3-E).
- **Upload failure handling:** if Cloudinary upload times out or returns error, client proceeds to submit the movement without a photo. After successful movement INSERT, client shows: "ยืม/คืนสำเร็จ แต่ไม่สามารถอัปโหลดรูปถ่ายได้ — กรุณาอัปโหลดภายหลัง" (warning toast, not error). `photo_borrow_url` / `photo_return_url` remains `null` in `stock_loans`.
- **Post-upload PATCH on `stock_loans`:** client sends `PATCH /rest/v1/stock_loans?id=eq.<id>` `{photo_borrow_url: '<url>'}`. RLS must allow Staff to UPDATE their own loan's photo fields (§8).

### 7.6 Localization

All UI strings in Thai (matching Phase 0–2). Toast messages use `shared/ui.js` toast helper. Date display uses `Asia/Bangkok` timezone. No i18n framework.

---

## 8. RLS Policies (`20260519020200_loan_rls.sql`)

### 8.1 `stock_loans` table policies

```sql
ALTER TABLE stock_loans ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read loans
CREATE POLICY sl3_read ON stock_loans
  FOR SELECT TO authenticated
  USING (true);

-- Staff can INSERT their own loans (created by trigger; client does NOT directly INSERT stock_loans)
-- stock_loans rows are created by the trigger on stock_movements — which runs as postgres role (bypasses RLS)
-- So no client-facing INSERT policy needed on stock_loans.

-- Staff can UPDATE photo_borrow_url / photo_return_url on their own loans only
CREATE POLICY sl3_update_photo_own ON stock_loans
  FOR UPDATE TO authenticated
  USING (borrower_username = app_username())
  WITH CHECK (
    borrower_username = app_username()
    -- Staff may only update photo fields; they cannot change status, qty, or movement links.
    -- NOTE: PostgREST does not enforce column-level restrictions in UPDATE policies.
    -- Use trigger guard below for immutable columns.
  );

-- Admin can UPDATE any loan (for admin-recorded returns, notes, corrections)
CREATE POLICY sl3_update_admin ON stock_loans
  FOR UPDATE TO authenticated
  USING  (app_user_role() = 'Admin')
  WITH CHECK (app_user_role() = 'Admin');

-- No DELETE on stock_loans (immutable audit trail; same principle as stock_movements)
-- Default deny from RLS; add explicit prevention trigger for SECURITY DEFINER context safety:
CREATE OR REPLACE FUNCTION prevent_loan_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_loans rows are immutable; close loans via return movement, not DELETE';
END;
$$;
CREATE TRIGGER trg_no_delete_loans
  BEFORE DELETE ON stock_loans
  FOR EACH ROW EXECUTE FUNCTION prevent_loan_delete();
```

**Immutability guard for critical columns (mirrors S-11 pattern from Phase 2 security audit):**
```sql
CREATE OR REPLACE FUNCTION guard_loan_immutable_cols()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.movement_id_borrow IS DISTINCT FROM NEW.movement_id_borrow
     OR OLD.item_id          IS DISTINCT FROM NEW.item_id
     OR OLD.location_id_from IS DISTINCT FROM NEW.location_id_from
     OR OLD.borrower_username IS DISTINCT FROM NEW.borrower_username
     OR OLD.borrowed_at      IS DISTINCT FROM NEW.borrowed_at
     OR OLD.qty              IS DISTINCT FROM NEW.qty
  THEN
    RAISE EXCEPTION 'movement_id_borrow, item_id, location_id_from, borrower_username, borrowed_at, qty are immutable after loan creation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_loan_immutable
  BEFORE UPDATE ON stock_loans
  FOR EACH ROW EXECUTE FUNCTION guard_loan_immutable_cols();
```

### 8.2 Extend `stock_movements` Staff INSERT Policy

Phase 1 `sm_insert_staff` policy allows only `issue`/`adjustment_loss`. Phase 3 extends it to also allow `borrow`/`return`:

```sql
-- Drop Phase 1 staff insert policy and replace
DROP POLICY IF EXISTS sm_insert_staff ON stock_movements;

CREATE POLICY sm_insert_staff ON stock_movements
  FOR INSERT TO authenticated
  WITH CHECK (
    app_user_role() IN ('Admin','Employee')
    AND movement_type IN ('issue','adjustment_loss','borrow','return')
    -- Admin policy (sm_insert_admin) already covers all types; this is the staff-only extension.
  );
```

**Verification SQL:**
```sql
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'stock_movements' AND policyname LIKE 'sm_insert%';
-- Expected: sm_insert_admin (any type) + sm_insert_staff (issue, adjustment_loss, borrow, return)
```

### 8.3 Role matrix summary (Phase 3 additions only)

| Table | Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| `stock_loans` | Admin | all | trigger-only | all columns | blocked (trigger) |
| `stock_loans` | Employee | all | trigger-only | photo fields on own loans only | blocked (trigger) |
| `stock_movements` | Employee (Phase 3 change) | all | `issue`, `adjustment_loss`, `borrow`, `return` | — | — |

---

## 9. Acceptance Tests T76–T100

**Assumption T-note:** Phase 2 spec ends at T75. If actual Phase 2 end test differs, renumber these to follow the real last Phase 2 test. PM to confirm (Q-Phase3-B).

### Borrow flow (T76–T82)

**T76** Staff logs in → `staff.html` → "ยืมอุปกรณ์" button is visible.

**T77** Staff completes borrow flow: scan item SUP-GAUZE-001 (Phase 1 seed) from ROOM-A, qty 5, due_at = today + 3 days, no photo → submit. Verify:
- `stock_movements` row: `movement_type='borrow'`, `qty_delta=-5`, `client_ref_id` populated.
- `stock_loans` row: `status='active'`, `borrower_username = staff_user`, `qty=5`, `photo_borrow_url=null`.
- `stock_item_locations` ROOM-A qty reduced by 5.

**T78** Staff completes borrow flow with photo: same item, qty 1, provides photo → Cloudinary URL in `stock_loans.photo_borrow_url` (non-null, starts with `https://res.cloudinary.com/`).

**T79** Replay same `client_ref_id` (network retry simulation) → 409 unique violation on `stock_movements.client_ref_id` → client treats as success-already-posted; no duplicate `stock_loans` row.

**T80** Staff attempts borrow of qty > available at location → Phase 1 trigger raises exception → toast "ของไม่พอ"; no `stock_loans` row created.

**T81** Admin opens loan list tab/segment → T77 loan appears with status "กำลังยืม".

**T82** Employee POSTs `movement_type='receive'` via DevTools → 403 RLS (Staff blocked from receive; borrow/return only).

### Return flow (T83–T88)

**T83** Staff returns item from T77: scan same item → system shows open loan details → confirm return → INSERT `movement_type='return'`, `qty_delta=+5`. Verify:
- `stock_movements` return row created.
- `stock_loans` status = 'returned', `returned_at` populated, `movement_id_return` populated.
- `stock_item_locations` ROOM-A qty restored by 5.

**T84** Return with photo: capture photo during return flow → `stock_loans.photo_return_url` non-null.

**T85** Staff attempts to return same loan a second time (loan already closed) → trigger raises `'ไม่พบรายการยืมที่เปิดอยู่'` → toast "ไม่พบรายการยืมที่เปิดอยู่".

**T86** Admin records return on behalf of staff via admin loan-list "บันทึกคืน" button → same outcome as T83 but `performed_by = admin_user`.

**T87** Staff attempts `DELETE` on `stock_loans` via DevTools → blocked by prevent_loan_delete trigger (500 with Thai error message).

**T88** Staff attempts to UPDATE `borrower_username` on their own loan via DevTools PATCH → blocked by `trg_loan_immutable` trigger.

### Overdue cron (T89–T93)

**T89** Create a loan with `due_at = now() - INTERVAL '1 hour'` (past due; insert via Admin form or SQL). Run `SELECT run_overdue_alert()` manually from SQL Editor. Verify:
- `stock_loans.status` changes to `'overdue'` for that loan.
- `notification_log` row with `event_type='overdue_loan'` and `dedupe_key` containing the loan id.
- Telegram message received in the test group (or `success=true` in `notification_log`).

**T90** Run `SELECT run_overdue_alert()` again within the same clock-hour → `notification_log` shows `dedupe_hit=true` for the same loan (deduped; no second Telegram message).

**T91** Create 11+ overdue loans → run `SELECT run_overdue_alert()` → single grouped message "มีอุปกรณ์เลยกำหนดคืน 11 รายการ" (not 11 individual messages). Verify single `notification_log` row with `event_type='overdue_batch'`.

**T92** Verify `pg_cron` jobs registered: `SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'overdue_alert%'` → 2 rows: `overdue_alert_morning` at `0 2 * * *`, `overdue_alert_evening` at `0 10 * * *`.

**T93** `NOTIFY_SUPABASE_URL` or `NOTIFY_SERVICE_ROLE_KEY` set to NULL in settings → `run_overdue_alert()` raises `WARNING` and returns without crashing → no exception surfaces to cron log.

### Dashboard + Realtime (T94–T96)

**T94** Admin dashboard "สถานะอุปกรณ์ยืม-คืน" panel shows correct counts: active, overdue, returned-today. Counts match `SELECT count(*) FROM stock_loans WHERE status='active'` (etc).

**T95** Admin loan list open in browser → Staff completes T77 borrow in another tab → loan row appears in admin list within ~1s (Realtime).

**T96** `SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime'` → includes `stock_loans`.

### RLS + Security (T97–T99)

**T97** Employee fetches `GET /rest/v1/settings?key=eq.NOTIFY_SERVICE_ROLE_KEY` → 0 rows returned (S-1 `is_secret` policy active; inherited from Phase 2 hotfix).

**T98** Employee attempts to UPDATE `stock_loans` row with a different `borrower_username` via DevTools PATCH → `trg_loan_immutable` raises exception → 500 with Thai immutability error.

**T99** Employee attempts `INSERT` into `stock_loans` directly via REST (bypassing movement trigger path) → 0 rows affected / 403 (no INSERT RLS policy on `stock_loans` for authenticated role; trigger path only).

### Photo failure graceful (T100)

**T100** Simulate Cloudinary upload failure (disconnect network after step 3 in borrow flow, before photo upload). Verify:
- Movement INSERT succeeds.
- `stock_loans` row created with `photo_borrow_url=null`.
- Toast "ยืมสำเร็จ แต่ไม่สามารถอัปโหลดรูปถ่ายได้ — กรุณาอัปโหลดภายหลัง" shown.
- No exception or blocking error. User can proceed.

---

## 10. Out of Scope (explicit list)

| Item | Deferred to | Reason |
|---|---|---|
| Per-piece serial tracking for borrowed items | Phase 5 | Oxygen-serial model; Phase 3 uses SKU+qty |
| Equipment maintenance / service state machine | Not planned | Not in PDF |
| Borrow approval workflow | Phase 3.1 | Phase 3 is self-service; no schema change needed to add later |
| Partial return (return some of borrowed qty) | Phase 3.1 | Requires splitting loan row; deferred |
| Multiple concurrent loans same item same borrower edge case UI | Phase 3.1 | Phase 3 handles by picking most recent open loan |
| Bulk borrow (multiple items in one submission) | Phase 3.1 | Single-item scan flow only |
| Late-return penalty tracking | Not planned | Not in PDF |
| Web Push notifications | Not planned | Web-only (no PWA); Telegram only |
| QR label printing for equipment | Phase 3.1 | Read-only QR use, same as Phase 1 |
| Email / LINE notification | Not planned | Single Telegram group; single chat_id |
| `fefo_override` analog for borrow (FIFO borrow order enforcement) | Not planned | Equipment borrow does not have lot expiry logic |
| Cloudinary folder rename after loan creation (temp→loan_id path) | Phase 3.1 | Phase 3 uses `client_ref_id` as folder anchor; acceptable for Phase 3 |

---

## 11. Open Questions

Six questions for PM (user "Pex") to resolve before plan write-up. Each has options with recommendation.

### Q-Phase3-A — UI Placement: 5th Segment vs New Tab

**Context:** Phase 2 added a 4-segment Inventory tab (รายการสินค้า / รับเข้า / ล็อตยา / Timeline). Decision Q-D5 used `overflow-x: auto` for the segment row at 360px. A 5th segment for "อุปกรณ์ยืม-คืน" would make 5 segments, requiring more horizontal scroll.

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A — New top-level tab "ยืม-คืน"** (RECOMMENDED) | Add a 6th tab to the admin top nav | No segment overflow concern; loan data has its own dashboard panel + full page width | More tabs in the top nav (currently 5: Dashboard / Inventory / Locations / Ambulances / Settings — would become 6) |
| B — 5th segment inside Inventory tab | Extend the existing 4-segment row | Keeps all stock-related views in one tab | Phase 2 Q-D5 already used overflow-x; a 5th segment makes the tab crowded; loan view is large enough to deserve its own tab |
| C — Sub-tab within Inventory (nested segmented control) | Inventory tab has main segments; "อุปกรณ์ยืม-คืน" is a sub-section of "รายการสินค้า" | No extra top-nav tab | Double-nesting tabs is non-standard for mobile UX; confusing |

**Recommendation: Option A.** Borrow/return is a distinct workflow that admin staff uses independently of the medication lot view. A dedicated top-level tab avoids horizontal scroll overflow and is cleaner on mobile. Adding a 6th top-nav tab is acceptable if top nav wraps or uses icons — confirm with UX designer.

**PM Decision needed:** Which option?

---

### Q-Phase3-B — Phase 2 End Test Number

**Context:** This spec assumes Phase 2 acceptance tests end at T75, so Phase 3 starts at T76. The Phase 2 spec has not been read in this session to confirm the exact end number.

**Options:**
- A. Confirm Phase 2 ends at T75 → Phase 3 T76–T100 as written.
- B. Provide actual last Phase 2 test number → BA renumbers Phase 3 tests before plan write-up.

**Recommendation:** PM confirm before implementation starts. If Phase 2 ends at a different number (e.g., T72), BA will renumber Phase 3 tests accordingly. This does NOT block spec draft.

---

### Q-Phase3-C — Is Photo Required to Block Movement?

**Context:** The spec proposes that photo upload failure does NOT block the borrow/return movement (warning toast only). The PDF §8 says "photo proof" but does not explicitly say "required to proceed."

| Option | Behavior | Risk |
|---|---|---|
| **A — Photo advisory only (RECOMMENDED)** | Movement succeeds without photo; `photo_borrow_url=null`; warning toast | Camera failure / bad network does not prevent equipment from being tracked; trade-off: audit trail has gaps |
| B — Photo required at borrow, advisory at return | Borrow is blocked if no photo is uploaded; return is advisory | Stronger audit at borrow; but blocks staff if camera fails on shift |
| C — Photo required for both borrow and return | Hard block | Maximum audit integrity; but operationally risky if camera or Cloudinary fails |

**Recommendation: Option A.** Medical equipment tracking must be operational even when tech fails. A missing photo is logged (null URL + warning toast); admin can request photo retroactively. Aligns with Phase 0's "no-block" philosophy.

---

### Q-Phase3-D — Borrower Identity: Can Admin Borrow on Behalf of Another Staff?

**Context:** `borrower_username` is set to `app_username()` (the person who inserts the movement). In practice, an admin might process a borrow on behalf of a staff member (e.g., staff is in the field, no phone). The current design sets the borrower as the admin user.

| Option | Description |
|---|---|
| **A — Borrower = performer always (RECOMMENDED for Phase 3)** | Simplest; `borrower_username` always = `app_username()`; admin-on-behalf tracked via `notes` only |
| B — Admin can pass `borrower_username` override via dedicated field in movement note | Trigger reads a `borrower:<username>` prefix in `note` and uses that as `borrower_username` | Flexible; auditable in `notes` |
| C — Add `borrower_username` column to `stock_movements` | Client provides this column; trigger reads `NEW.borrower_username` | Cleanest schema; requires migration change to `stock_movements` (ALTER TABLE) |

**Recommendation: Option A** for Phase 3. Add the override in Phase 3.1 if operationally needed. If PM wants it in Phase 3, Option C is preferred over B (no note-parsing gymnastics).

---

### Q-Phase3-E — `due_at` Transport Mechanism

**Context:** `due_at` is not a column on `stock_movements`. The Phase 3 trigger needs to know the due date when creating the `stock_loans` row. Three options:

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| **A — Encode in `note` field as `due_at:ISO8601|rest` prefix (current spec default)** | Trigger parses with `regexp_match` | No schema change to `stock_movements` | Note parsing is fragile; note field loses its free-text nature |
| B — Add `due_at timestamptz` column to `stock_movements` | `ALTER TABLE stock_movements ADD COLUMN due_at timestamptz` | Clean; type-safe; trigger reads `NEW.due_at` directly; can be null for non-borrow movements | Schema change to Phase 1 table (additive; safe; one migration line) |
| C — Two-step client: INSERT movement first → PATCH `stock_loans.due_at` after trigger fires | Client sends movement, trigger creates loan with default `due_at` (7 days), then client immediately PATCHes the loan | No schema change at all | Race condition: client must wait for trigger response and then PATCH; fragile on bad network |

**Recommendation: Option B.** One `ALTER TABLE stock_movements ADD COLUMN due_at timestamptz` is additive and safe. Makes the trigger code clean and removes note-parsing fragility. Phase 1 movements simply leave `due_at = null`. This is a small migration change worth the clarity.

---

### Q-Phase3-F — Overdue Grouping Threshold

**Context:** The spec uses a threshold of 10 loans: if > 10 overdue, send one grouped message; if ≤ 10, send individual per-loan messages. The threshold is hard-coded in `run_overdue_alert()`.

| Option | Threshold | Considerations |
|---|---|---|
| A — Hard-code 10 | Simple | Must re-deploy trigger to change |
| **B — Store in `settings` table as `OVERDUE_GROUP_THRESHOLD` (RECOMMENDED)** | Runtime configurable | +1 row in settings; admin can tune without code change; consistent with Phase 0 `LOW_STOCK_DEDUPE_HOURS` pattern |
| C — Always individual (no grouping) | Simplest | Risk of Telegram spam with many overdue items (Telegram rate-limits to ~30 messages/sec; 10+ loans at once could trigger rate-limit) |

**Recommendation: Option B.** Add `OVERDUE_GROUP_THRESHOLD` to `settings` table with default value `10`. Reads from `settings` in `run_overdue_alert()` (consistent with how `LOW_STOCK_DEDUPE_HOURS` is used in Phase 1). Prevents Telegram spam at no extra code complexity.

**Impact on DDL:** Add one seed row in migration `20260519020000` or `20260519020400`:
```sql
INSERT INTO settings(key, value, is_secret) VALUES
  ('OVERDUE_GROUP_THRESHOLD', '10', false)
ON CONFLICT (key) DO NOTHING;
```

---

## 12. Decisions Log

| ID | Question | Decision | Source |
|---|---|---|---|
| Q-Phase3-A | UI placement | TBD — PM decision (§11 Q-Phase3-A); recommendation: new top-level tab | This spec |
| Q-Phase3-B | Phase 2 end test number | TBD — PM confirm T75 or actual end | This spec |
| Q-Phase3-C | Photo required vs advisory | TBD — recommendation: advisory only (Option A) | This spec |
| Q-Phase3-D | Borrower identity override | TBD — recommendation: borrower = performer (Option A) for Phase 3 | This spec |
| Q-Phase3-E | due_at transport | TBD — recommendation: `stock_movements.due_at` column (Option B) | This spec |
| Q-Phase3-F | Overdue grouping threshold | TBD — recommendation: settings key `OVERDUE_GROUP_THRESHOLD=10` (Option B) | This spec |
| Q-Phase3-G | Default due_at for new borrows | TBD — how many days default? (e.g., 1 day? 7 days?) | This spec |
| Q-Phase3-H | `movement_type` enum change needed? | **No** — enum values `borrow`/`return` already reserved in Phase 1 DDL (Q-Phase1-L). No migration needed for the enum itself. | Phase 1 spec §5.4 |
| Q-Phase3-I | New Edge Function needed? | **No** — trigger + pg_net + tg-notify (same pattern as Phase 1/2). | §6 |
| Q-Phase3-J | `settings` table read pattern | **settings table rows** (NOT `current_setting`). Mandatory per Project.md §8 gotcha #9. Already confirmed live in Phase 1/2. | Project.md §8 + Phase 2 decisions-locked derived #8 |

---

## 13. Requirement → Acceptance Test Coverage Self-Check

Per the "verify before done" project rule. Each PDF Phase 3 requirement must map to ≥1 acceptance test.

| PDF requirement | Phase 3 portion | Covered by |
|---|---|---|
| §3 Borrow — item scan + borrower identity | T76, T77 |
| §3 Borrow — due date | T77 (due_at stored) |
| §3 Borrow — photo proof at borrow | T78 |
| §3 Borrow — photo failure non-blocking | T100 |
| §3 Return — item scan + confirm | T83 |
| §3 Return — photo proof at return | T84 |
| §3 Return — idempotency (no double-close) | T85 |
| §7 Overdue alert — cron marks status | T89 |
| §7 Overdue alert — Telegram message | T89 |
| §7 Overdue alert — dedupe (no double send) | T90 |
| §7 Overdue alert — grouping for many overdue | T91 |
| §7 Overdue alert — cron schedule verified | T92 |
| §7 Overdue alert — graceful skip when settings missing | T93 |
| §8 Photo via Cloudinary — URL stored in loans | T78, T84 |
| §8 Photo via Cloudinary — client-side upload | T78 (Cloudinary URL in response) |
| §1 RBAC — Staff can borrow/return | T77, T83 |
| §1 RBAC — Staff cannot receive/issue Admin-only movements | T82 |
| §1 RBAC — Employee cannot read secret settings | T97 |
| §2 Dashboard — borrow/return panel live | T94, T95 |
| §9 Multi-location — qty reduced at source location | T77 (stock_item_locations) |
| §9 Multi-location — qty restored at source on return | T83 (stock_item_locations) |
| Immutable audit trail — no delete on loans | T87 |
| Immutable audit trail — no modify critical columns | T88, T98 |
| Idempotency — duplicate scan safe | T79 |

**Self-check result:** All Phase 3 requirements extracted from PDF §3, §7, and §8 have at least one acceptance test. No requirement-without-test gaps found.

**Gap note:** Q-Phase3-G (default due_at days) is not yet tested because the value is TBD pending PM decision. Once decided, add a T-test for the default value displayed in the UI.

---

## 14. Security Notes (apply S-1 patterns from Phase 2 audit)

Phase 3 introduces no new secrets to the `settings` table. The existing `NOTIFY_SERVICE_ROLE_KEY` (already `is_secret=true` per Phase 2 S-1 hotfix) is reused by `run_overdue_alert()`. No additional `is_secret` rows needed.

New security concerns introduced by Phase 3:

| ID | Concern | Severity | Mitigation |
|---|---|---|---|
| S-P3-1 | `stock_loans` UPDATE policy allows Staff to PATCH photo fields; PostgREST does not enforce column-level restriction in UPDATE policies — a Staff user could PATCH `status` or `notes` if they craft a PATCH body with those fields. | MEDIUM | `trg_loan_immutable` trigger blocks changes to the critical fields (`borrower_username`, `qty`, `movement_id_borrow`, etc.). `status` is NOT in the immutable list (it needs to change for return and overdue). A Staff user could theoretically set `status='returned'` without a return movement. Add `status` to the immutable-for-staff list: only allow status change via the trigger path (i.e., deny direct status updates from non-Admin clients). Implementation: extend `trg_loan_immutable` to block `status` changes when `app_user_role() <> 'Admin'`. |
| S-P3-2 | `run_overdue_alert()` runs as `postgres` role (SECURITY DEFINER implied by cron context). It has access to the full `public` schema, same blast-radius concern as Phase 2 S-4. | LOW | Accept risk for Phase 3 (same as Phase 2 S-4 decision). Document in migration comment. Structural fix deferred. |
| S-P3-3 | Cloudinary `upload_preset = pt-medical` is unsigned (no signing key). Anyone who knows the account + preset can upload to the folder. | LOW | Accepted by Phase 0 design (same preset reused). All uploads go to `thegood-stock/` prefix; no PHI in filenames. Cloudinary provides per-folder rate-limiting if needed. |

**Recommendation:** Implement S-P3-1 mitigation (extend `trg_loan_immutable` to block `status` changes from non-Admin) before Phase 3 ships. This is a 3-line addition to the trigger and closes a meaningful gap.

---

## 15. Effort Estimate

| Workstream | Effort |
|---|---|
| Migrations (5 new files: stock_loans, triggers, RLS, realtime, cron + optional settings seed for Q-Phase3-F) | 0.5 day |
| Frontend admin loans tab/segment (loan list, dashboard panel, admin return form) | 0.75 day |
| Frontend staff borrow flow (5-step scan flow with Cloudinary upload + due_at picker) | 0.75 day |
| Frontend staff return flow (3-step scan + confirm) | 0.5 day |
| Test pass T76–T100 | 0.5 day |
| Buffer for trigger debugging + PM review feedback | 0.5 day |
| **Total** | **~3.5 days** |

**Risk factors:**
- If Q-Phase3-E is resolved as Option B (add `due_at` column to `stock_movements`): +0.25 day for migration + trigger update, but removes note-parsing fragility — worth it.
- Cloudinary folder/URL race (pending loan_id before upload): +0.25 day if `client_ref_id`-as-folder approach has issues.
- `pg_cron` first Phase 3 run: if Phase 2 cron has verified working, minimal risk. If Phase 2 cron was never tested, cron setup adds +0.25 day.
- S-P3-1 security fix (status change protection): +0.1 day (small trigger extension).

---

## 16. Next Step

When this DRAFT is approved by PM:
1. Resolve the 6 open questions in §11 (Q-Phase3-A through Q-Phase3-F; also Q-Phase3-G default due_at days).
2. Confirm Phase 2 end test number (Q-Phase3-B) and renumber T76–T100 if needed.
3. Implement S-P3-1 security fix (extend `trg_loan_immutable` to block `status` changes from Employee role).
4. Hand off to `superpowers:writing-plans` to produce `docs/superpowers/plans/2026-05-19-phase3-borrow-return-plan.md`.
5. Execute the plan; verify all T76–T100 pass; tag `phase3-borrow-return`.

**Hand-off note:** The next agent after PM approval is either:
- `ui-ux-designer` — to produce Phase 3 UI wireframes (loan list, borrow/return scan flow, overdue badge styling) before implementation starts. Q-Phase3-A (tab vs segment) must be resolved first.
- `backend-developer` — can begin migrations and trigger functions immediately once Q-Phase3-E (due_at column) and Q-Phase3-F (grouping threshold) are decided; frontend can be done in parallel.
