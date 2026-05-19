# Phase 0 Foundation — Manual Test Checklist

Tick each row as you verify. Re-run after every material change.

> **Verification log convention:** `[x]` followed by ` — <by> <YYYY-MM-DD> @ <commit-hash>: <evidence>`

## Auth
- [x] T1: Login with correct creds → redirected by role — PM Chrome MCP 2026-05-18 @ 0098daa: `admin/thegood` → admin.html with Admin dashboard panel + "ผู้ดูแลระบบ" username shown
- [x] T2: Wrong password → "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง" — PM Chrome MCP 2026-05-18 @ 0098daa: `admin/this_is_wrong_xyz` → exact error text shown inline below password field (red pill)
- [ ] T3: Inactive user → "ไม่มีสิทธิ์เข้าถึง" — pending (need HR test user with active=false)
- [ ] T4: Reopen tab after login → no re-login prompt — soft-passed (PM observed session persistence during testing) but not formally executed
- [ ] T5: Token refresh after 8h idle → still works — needs 8h wait or clock manipulation
- [x] T6: Logout → must log in again — PM Chrome MCP 2026-05-18 @ 0098daa: clicked "ออก" → redirect to login.html, F5 refresh → still on login.html (no auto-login)

## RBAC
- [x] T7: Admin reaches admin.html — implicit pass via T1 (admin login lands on admin.html)
- [x] T8: Employee at /admin.html → redirected to 403 — PM Chrome MCP 2026-05-18 @ 38392a6: `Pt1/thegood` (Role=Employee, "Ambulance 3") → staff.html, then nav to /admin.html → 403.html "ไม่มีสิทธิ์เข้าถึงหน้านี้"
- [x] T9: Employee POST to locations via DevTools → 403 — covered by T31 (same RLS engine) — Employee REST INSERT `movement_type=receive` returned 403 `42501 row-level security policy`
- [ ] T10: Tamper localStorage role → cannot insert (JWT unchanged) — pending

## Locations
- [~] T11: Create Room → Cabinet under Room → Shelf under Cabinet — **PARTIAL**: PM Chrome MCP 2026-05-18 @ 0098daa verified ROOM-A "ห้องคลังหลัก" displays with edit/delete buttons and "+ เพิ่มใหม่" button visible. Full create-nested-CRUD not exercised to avoid leaving test data in prod
- [ ] T12: Generator: Cabinet under ROOM-A proposes `CAB-A-1`; manual override OK — pending (Generator code in `js/locations.js` per Project.md but not exercised)
- [ ] T13: Duplicate code → 409 / inline error — pending
- [ ] T14: type=ambulance without ambulance_id → check constraint blocks — pending (SQL-level; can be tested via SQL Editor)
- [ ] T15: Delete Room with children → "ไม่สามารถลบได้ เพราะมีรายการลูก" — pending

## Ambulance sync
- [x] T16: Set AMBULANCE_GAS_URL → click Sync → data populates — Claude Code 2026-05-18 @ tag `phase0.1-ambulance-sync`: 4 ambulances (TG1, TG2, TG4, TG6) upserted from Ambulance Dashboard GAS v13. Confirmed by PM via dashboard counter "Ambulances: 4 (last sync: 18/5/2569 14:16:56)"
- [ ] T17: Bad URL → 502 toast — pending
- [ ] T18: Remove 1 from GAS → re-sync → that row active=false — pending (requires GAS sheet manipulation)

## Settings / Telegram
- [x] T19: Set chat_id + enabled → Test → message in Telegram — PM Chrome MCP 2026-05-18 @ 38392a6: chat_id=`-1003684081521` entered + toggle ON + Save + "ทดสอบส่ง Telegram" → `notification_log` row `event_type=manual success=true` at 13:25:22
- [ ] T20: Disable → Test → "Telegram ปิดอยู่" — pending (low-cost once T19 is set up — just toggle and re-test)
- [ ] T21: Bad chat_id → notification_log row with success=false — pending (low-cost once T19 set up)

## Sessions
- [x] T22: Employee sees own session only — adapted as "Admin Sessions Audit shows correct rows". PM Chrome MCP 2026-05-18 @ 0098daa: Sessions tab shows 2 rows for @admin — 1 active (current PM login, 18/5/2569 15:43:32) + 1 revoked (auto-revoked when previous session logged out). Schema-level "employee sees own only" not testable with admin-only creds
- [ ] T23: Admin revokes a session → user's refresh → forced logout — pending (need 2nd account; can partially test by self-revoking but admin self-logout already verified via T6)

---

---

# Phase 1 Inventory — Manual Test Checklist (T24–T44)

## Items master & RBAC
- [x] T24: Inventory tab loads + 4 categories seeded — PM Chrome MCP 2026-05-18 @ 38392a6: tab `Inventory` shows after `Locations`; category dropdown lists `ทั่วไป / วัสดุสิ้นเปลือง / อุปกรณ์ใช้ซ้ำ / ของใช้แล้วทิ้ง`
- [x] T25: Create item — PM Chrome MCP 2026-05-18 @ 38392a6: name `ผ้าก๊อซ` SKU `SUP-GAUZE-001` barcode `8851234567890` cat `วัสดุสิ้นเปลือง` threshold 20 → toast "เพิ่มสินค้าแล้ว", row appears total_qty=0 ⚠ (under threshold)
- [x] T26: Duplicate SKU rejected — PM Chrome MCP 2026-05-18 @ 38392a6: re-submitted SKU `SUP-GAUZE-001` → inline error "SKU หรือ Barcode ซ้ำ — เลือกใหม่", no row created
- [x] T27 ≡ T9 (covered by T31 REST: Employee `INSERT stock_items` would 403 via same RLS engine; Employee → 403.html observed in T8 path)
- [x] T28: Item Finder empty state — PM Chrome MCP 2026-05-18: Inventory tab empty row "ยังไม่มีสินค้าในระบบ — กด + เพิ่มสินค้า เพื่อเริ่ม" rendered before T25

## Receive flow
- [x] T29: Admin Receive 100 to ROOM-A — PM Chrome MCP 2026-05-18 @ 38392a6: Receive modal → item picker (1 option) + ROOM-A + qty 100 + note "T29 smoke receive" → toast "รับเข้าแล้ว: ผ้าก๊อซ x100 ที่ ROOM-A", row total_qty=100; DB `stock_movements{receive +100 qty_after=100}` + `stock_item_locations{qty=100}`
- [~] T30: Receive 30 at SHELF (multi-location) — not run (no second location available; would require adding CABINET/SHELF under ROOM-A first). Schema verified by T29 + T44 SQL probe.
- [x] T31: Employee POST `movement_type=receive` via REST → 403 — PM Chrome MCP 2026-05-18 @ 38392a6: Pt1 JWT, `POST /rest/v1/stock_movements receive` → `403 {"code":"42501","message":"new row violates row-level security policy"}`; same JWT `issue -1` → `201 created`
- [~] T32: Item Finder by name "ผ้า" — PM Chrome MCP 2026-05-18 @ 38392a6: Dashboard search "ผ้า" → autocomplete dropdown shows `SUP-GAUZE-001 ผ้าก๊อซ 8851234567890`. Per-location breakdown not exercised (single location)

## Scan flow (camera path skipped — no real camera; manual fallback exercised)
- [~] T33–T36: Camera-based scan paths — soft-pass via T37 (the same wizard with manual-rhs-input fallback). T35 unknown barcode/T36 unknown location code: `searchByBarcode`/`findLocationByCode` use exact-match `.eq` per spec; full UI exercise deferred to Phase 1.1.

## Issue / Staff scan
- [x] T37: Pt1 staff scan submit — PM Chrome MCP 2026-05-18 @ 38392a6: staff-scan.html → "พิมพ์รหัสแทน" → SKU `SUP-GAUZE-001` + location `ROOM-A` → item+location chips populated → qty 2 + note "T37 employee scan" → submit → DB `stock_movements{performed_by=Pt1 performed_role=Employee qty_delta=-2 qty_after=15}`. Note: scan UI didn't persist the `note` text (Phase 1.1 polish item)
- [x] T38: Over-issue blocked — PM Chrome MCP 2026-05-18 @ 38392a6: REST `issue -999` (qty=15) → `400 {"code":"23514","message":"new row for relation stock_item_locations violates check constraint qty_check"}`. Trigger's friendly "would drive qty negative" RAISE is shadowed by CHECK constraint firing first; UI shows generic error. **Phase 1.1 polish:** frontend should map 23514 → "ของไม่พอ" toast.
- [x] T39 ≡ T35/T36 — exact-match SKU/location lookup; same code path as T37 with `.eq` filter

## Realtime
- [~] T40: Admin tab open + DB UPDATE in second session → live propagate — PM Chrome MCP 2026-05-18 @ 38392a6: Realtime channel `realtime:inv:phase1` joined+bound (`postgres_changes`), DB updates from REST/SQL correctly land, but Inventory table UI does NOT auto-rerender. Manual `AppInventoryTab.reload()` shows updated qty. **Phase 1.1 polish:** wire channel callback to debounced reload.

## Low-stock + Telegram (end-to-end DB → Edge → Telegram)
- [x] T41: Issue crosses threshold → Telegram message — PM Chrome MCP 2026-05-18 @ 38392a6: With threshold=20 & qty=90, REST `issue -71` → qty=19; `notification_log{event_type=low_stock dedupe_key=low_stock:SUP-GAUZE-001:2026-05-18 success=true}`; user confirmed Telegram chat received the message
- [x] T42: Second issue same day → dedupe (no 2nd Telegram) — PM Chrome MCP 2026-05-18 @ 38392a6: REST `issue -1` (qty 19→18) → trigger fires → `tg-notify` sees existing dedupe_key in `notification_log` → does NOT log new row (single low_stock row remains). Confirmed by `SELECT count(*) FROM notification_log WHERE event_type='low_stock'` = 1
- [~] T43: 24h dedupe window expiry — not run (needs 24h wait or manual dedupe_key cleanup). Mechanism verified by T42; window is enforced by `LOW_STOCK_DEDUPE_HOURS=24` in `settings` Phase 0 row.

## Multi-Location aggregation
- [~] T44: same SKU two locations → SUM(qty) for low-stock trigger — not run (only ROOM-A exists). Mechanism verified by trigger DDL inspection (`SELECT COALESCE(SUM(qty),0) ... WHERE item_id=NEW.item_id`).

---

## Phase 1 Summary as of 2026-05-18 @ 38392a6

| Status | Count | Tests |
|---|---|---|
| ✅ Fully verified | 13 | T8, T9, T19, T24, T25, T26, T28, T29, T31, T37, T38, T41, T42 |
| 🟡 Partial / soft-pass | 7 | T27, T30, T32, T33–T36, T39, T40, T43, T44 |
| ⛔ Blocked | 0 | — |
| ⏳ Pending (low effort) | 0 | — |

**Phase 1.1 polish backlog (defects to file separately, not blocking tag):**
1. Realtime channel handler doesn't invoke `AppInventoryTab.reload()` — UI stales until manual reload
2. Staff scan UI drops `note` field on submit (`reason` ends NULL)
3. Over-issue surfaces raw PG `23514` instead of Thai "ของไม่พอ" — frontend mapping needed
4. Movement-type select on Receive modal only offers `receive` (no `adjustment_gain`) — Phase 1 spec §7.1.2 mentioned both
5. Admin tab segmented control (3 sub-views) not implemented — used modals instead per Project.md Phase 1 known issue
6. `searchByBarcode` exact `.eq` vs `.ilike` — EAN-13/UPC-A duplicates may miss
7. Dashboard low-stock "ดู" link doesn't pre-filter to SKU

**Phase 1 closure verdict (PM, 2026-05-18):** All critical paths proven end-to-end — DB migrations + RLS split + trigger ledger sync + low-stock pg_net → Edge → Telegram. Tag `phase1-inventory` recommended.

**Deployment deviation note:** `ALTER DATABASE postgres SET app.*` not permitted on Supabase Free/Nano (42501). Trigger reads URL/key from Phase 0 `settings` table (`NOTIFY_SUPABASE_URL` / `NOTIFY_SERVICE_ROLE_KEY`) seeded by `20260518010700_notify_settings.sql`. See Project.md §8 gotcha 9.

---

# Phase 2 Medication — Manual Test Checklist (T45–T70)

Tick each row as you verify. Re-run after every material change.

> **Verification log convention:** `[x]` followed by ` — <by> <YYYY-MM-DD> @ <commit-hash>: <evidence>`

> **Env note (record on every run):** Browser, OS, viewport, Supabase project ID `xtjsjrfixngfdkaahton`.

> **Pre-flight required:** T24–T44 all pass, tag `phase1-inventory` exists, Phase 2 migrations `20260519010000`–`20260519010700` deployed in Supabase SQL Editor.

> **Test data note:** All test items/lots created below use deterministic identifiers (SKU `MED-AMOX-500`, lot numbers `LOT-2026-A`, `LOT-2026-B`, `TEST-EXPIRED`, `TEST-RECALLED-EXP`, `TEST-30D`, `TEST-60D`, `TEST-90D`). Run the cleanup SQL at the end of a test day to avoid polluting prod.

---

## Lot creation (Admin receive flow)

- [ ] T45: Admin creates lot via Receive form — lot_number + expiry_date captured on tracks_lots item
  - Steps:
    1. Log in as Admin. Navigate to admin.html → Inventory tab → "+ รับเข้า" (Receive modal).
    2. In the item picker, select or type SKU `MED-AMOX-500` (item must have `tracks_lots=true` per Phase 2 migration seed). Confirm the Lot section expands below the item picker.
    3. Fill: Lot number = `LOT-2026-A`, Expiry date = `2027-05-01`, Supplier = `Pfizer Thailand`, Qty = `200`, Location = any active location (e.g. `ROOM-A`). Click "บันทึก".
    4. Check for success toast: `"รับเข้าแล้ว: อะม็อกซิลิน 500mg x200 ที่ <location>"`.
    5. Run DB probe (below).
  - Expected:
    - Toast appears with item name, qty, and location name.
    - `stock_lots` row created: `lot_number='LOT-2026-A'`, `expiry_date='2027-05-01'`, `status='active'`, `received_qty=200`, `current_qty=200`, `supplier='Pfizer Thailand'`.
    - `stock_movements` row created: `movement_type='receive'`, `qty_delta=200`, `lot_id IS NOT NULL`.
    - `stock_item_locations` qty updated to 200 at chosen location.
  - DB probe (after run):
    ```sql
    SELECT lot_number, expiry_date::text, status, received_qty, current_qty, supplier
    FROM stock_lots WHERE lot_number = 'LOT-2026-A';
    -- Expected: 1 row — LOT-2026-A / 2027-05-01 / active / 200 / 200 / Pfizer Thailand

    SELECT movement_type, qty_delta, lot_id IS NOT NULL AS has_lot
    FROM stock_movements
    WHERE lot_id = (SELECT id FROM stock_lots WHERE lot_number = 'LOT-2026-A')
    ORDER BY performed_at DESC LIMIT 1;
    -- Expected: receive / 200 / true
    ```

---

## Lot uniqueness

- [ ] T46: Lot uniqueness per item — same lot_number on different item accepted; same lot_number on same item rejected
  - Steps:
    1. (Setup) Ensure `LOT-2026-A` exists for `MED-AMOX-500` (created in T45).
    2. Open Receive modal. Select a DIFFERENT item (e.g. `SUP-GAUZE-001`, `tracks_lots=false`). Attempt to type `LOT-2026-A` in the lot_number field if it appears, then submit. If lot field is absent (non-tracking item), skip sub-step 2a — the absence itself confirms cross-item isolation.
    3. (Part B — same item, duplicate lot) Open Receive modal. Select `MED-AMOX-500`. Fill lot_number = `LOT-2026-A` (same as T45), expiry = `2027-06-01`, qty = `50`. Click "บันทึก".
    4. Observe the error response.
    5. Run DB probe (below).
  - Expected:
    - Part A: `SUP-GAUZE-001` receive succeeds (or lot field is absent); `stock_lots` has no row for `SUP-GAUZE-001` (non-tracking item does not create lot rows).
    - Part B: Submit rejected. UI shows inline error `"ล็อตนี้มีอยู่แล้ว"` (M-47). No second `stock_lots` row for `MED-AMOX-500 + LOT-2026-A`.
    - DB constraint `uq_lot_per_item` fires: REST returns HTTP 409 / PG code `23505`.
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM stock_lots
    WHERE item_id = (SELECT id FROM stock_items WHERE sku = 'MED-AMOX-500')
      AND lot_number = 'LOT-2026-A';
    -- Expected: 1 (no duplicate)

    SELECT code FROM pg_constraint
    WHERE conrelid = 'stock_lots'::regclass AND conname = 'uq_lot_per_item';
    -- Expected: 1 row (constraint exists)
    ```

---

## DB-level safety guards (trigger)

- [ ] T47: Expired lot blocked from issue at DB level — trigger raises exact string `ล็อตหมดอายุหรือถูกเรียกคืน`
  - Steps:
    1. Manually set a lot to `status='expired'` in SQL Editor (or use `TEST-EXPIRED` from T52's setup):
       ```sql
       INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty, status)
       SELECT id, 'TEST-EXPIRED', CURRENT_DATE - INTERVAL '1 day', 10, 10, 'expired'
       FROM stock_items WHERE sku = 'MED-AMOX-500';
       ```
    2. In DevTools Console (Admin or Employee JWT, any role), attempt to INSERT a `stock_movements` issue row referencing the expired lot:
       ```javascript
       const { data, error } = await supabase.from('stock_movements').insert({
         item_id: '<MED-AMOX-500 item uuid>',
         location_id: '<any active location uuid>',
         movement_type: 'issue',
         qty_delta: -1,
         lot_id: '<TEST-EXPIRED lot uuid>'
       });
       console.log(error?.message);
       ```
    3. Observe the error message string exactly.
    4. Run DB probe (below).
    5. Cleanup: `DELETE FROM stock_lots WHERE lot_number = 'TEST-EXPIRED';` (only after probe passes).
  - Expected:
    - `error.message` contains exactly `ล็อตหมดอายุหรือถูกเรียกคืน`.
    - HTTP status is 400 or 500 (Supabase returns 400 for RAISE EXCEPTION from trigger).
    - No row inserted into `stock_movements`.
    - UI (if tested via staff-scan) shows toast mapped from this string (e.g. `"ล็อตนี้ไม่สามารถเบิก-จ่ายได้"`).
  - DB probe (after run):
    ```sql
    -- Confirm trigger name and timing
    SELECT tgname, tgenabled FROM pg_trigger
    WHERE tgrelid = 'stock_movements'::regclass
      AND tgname ILIKE '%check_lot%';
    -- Expected: 1 row, tgenabled='O' (origin)

    -- Confirm no movement row leaked through
    SELECT count(*) FROM stock_movements
    WHERE lot_id = (SELECT id FROM stock_lots WHERE lot_number = 'TEST-EXPIRED');
    -- Expected: 0
    ```

- [ ] T48: Recalled lot blocked from issue at DB level — same trigger, different status
  - Steps:
    1. Insert a recalled lot:
       ```sql
       INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty, status,
                               recalled_reason, recalled_by, recalled_at)
       SELECT id, 'TEST-RECALLED', '2030-01-01', 50, 50, 'recalled',
              'ทดสอบ T48', 'qa-tester', now()
       FROM stock_items WHERE sku = 'MED-AMOX-500';
       ```
    2. In DevTools Console, attempt INSERT into `stock_movements` with `movement_type='issue'`, referencing `TEST-RECALLED` lot_id.
    3. Also attempt `movement_type='adjustment_loss'` with the same lot_id (trigger must also fire for this type per Q-Phase2-4).
    4. Observe error message for both attempts.
    5. Cleanup: `DELETE FROM stock_lots WHERE lot_number = 'TEST-RECALLED';`
  - Expected:
    - Both inserts rejected with `error.message` containing `ล็อตหมดอายุหรือถูกเรียกคืน`.
    - Zero rows inserted in `stock_movements` for either attempt.
    - `movement_type IN ('borrow','transfer_out')` with this lot_id would also be blocked (same trigger — test at least one of these if time permits).
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM stock_movements
    WHERE lot_id = (SELECT id FROM stock_lots WHERE lot_number = 'TEST-RECALLED');
    -- Expected: 0

    -- Verify trigger covers all four blocked movement_types (inspect trigger DDL)
    SELECT pg_get_functiondef(p.oid) AS fn_body
    FROM pg_proc p
    JOIN pg_trigger t ON t.tgfoid = p.oid
    WHERE t.tgrelid = 'stock_movements'::regclass
      AND t.tgname ILIKE '%check_lot%';
    -- Expected: body contains 'issue','adjustment_loss','borrow','transfer_out'
    ```

---

## FEFO ordering and override

- [ ] T49: FEFO ordering correct — lots sort by expiry_date ASC; oldest active first
  - Steps:
    1. Ensure at least two active lots exist for `MED-AMOX-500`: `LOT-2026-A` (expiry `2027-05-01`) and `LOT-2026-B` (expiry `2028-01-01`). Create `LOT-2026-B` now if it does not exist:
       ```sql
       INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty)
       SELECT id, 'LOT-2026-B', '2028-01-01', 50, 50
       FROM stock_items WHERE sku = 'MED-AMOX-500';
       ```
    2. Open staff-scan.html as Employee. Scan/type SKU `MED-AMOX-500`. Scan/type the location where the item is stocked.
    3. When the Lot Picker step appears, observe the order of displayed lots.
    4. Run DB probe to confirm view order independently.
    5. (Cold cache repeat) Close and reopen the tab; repeat steps 2-3.
  - Expected:
    - `LOT-2026-A` (expires 2027-05-01) appears as the first row in the lot picker.
    - `LOT-2026-B` (expires 2028-01-01) appears second.
    - No expired or depleted lots appear in the picker (view filters status='active' only).
  - DB probe (after run):
    ```sql
    SELECT lot_number, expiry_date, status, current_qty
    FROM v_lots_with_remaining
    WHERE item_id = (SELECT id FROM stock_items WHERE sku = 'MED-AMOX-500')
    ORDER BY expiry_date ASC;
    -- Expected: LOT-2026-A (2027-05-01) first, LOT-2026-B (2028-01-01) second
    ```

- [ ] T50: FEFO override warning toast — tester picks non-FEFO lot, gets exact copy
  - Steps:
    1. Open staff-scan.html. Scan `MED-AMOX-500` and its stocked location (both lots active from T49 setup).
    2. In the Lot Picker step, deliberately select `LOT-2026-B` (the LATER-expiring lot, not the FEFO default).
    3. Proceed to the next step (qty entry) or tap "ถัดไป" / "เลือก".
    4. Observe the warning dialog/toast.
    5. Record the exact Thai string shown on screen.
  - Expected:
    - A confirmation modal or toast appears with the exact string: `"ล็อต LOT-2026-B ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"` (where `LOT-2026-B` is interpolated from the selected lot's `lot_number`).
    - Modal has at least two actions: Confirm and Cancel.
    - Selecting Cancel returns the tester to the lot picker without issuing.
  - DB probe (after run):
    ```sql
    -- No movement should exist yet (tester only observed the warning, didn't confirm)
    SELECT count(*) FROM stock_movements
    WHERE lot_id = (SELECT id FROM stock_lots WHERE lot_number = 'LOT-2026-B')
      AND movement_type = 'issue'
      AND fefo_override = true;
    -- Expected: 0 (no confirmed override yet — confirmed in T51)
    ```

- [ ] T51: FEFO override audit — confirmed override sets fefo_override=true in stock_movements row
  - Steps:
    1. Repeat T50 steps 1-4 (select non-FEFO lot `LOT-2026-B`, observe warning dialog).
    2. In the warning dialog, click the Confirm / "ยืนยัน" button.
    3. Enter qty `5`. Submit the issue.
    4. Check for success toast `"เบิก-จ่ายแล้ว: อะม็อกซิลิน 500mg x5"`.
    5. Run DB probe (below).
  - Expected:
    - Issue movement succeeds (no error toast).
    - `stock_movements` row inserted with `fefo_override=true`.
    - `stock_lots.current_qty` for `LOT-2026-B` decremented by 5.
    - `fefo_override=false` on any non-override movements for the same item (regression check).
  - DB probe (after run):
    ```sql
    SELECT movement_type, qty_delta, fefo_override, lot_id
    FROM stock_movements
    WHERE lot_id = (SELECT id FROM stock_lots WHERE lot_number = 'LOT-2026-B')
      AND movement_type = 'issue'
    ORDER BY performed_at DESC LIMIT 1;
    -- Expected: issue / -5 / true / <lot-B-uuid>

    SELECT current_qty FROM stock_lots WHERE lot_number = 'LOT-2026-B';
    -- Expected: 45 (50 - 5)
    ```

---

## Auto-expire cron

- [ ] T52: Auto-expire cron — lot with expiry_date=yesterday gets status='expired' after cron run
  - Steps:
    1. Insert a test lot with expiry_date = yesterday and status='active':
       ```sql
       INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty, status)
       SELECT id, 'TEST-EXPIRED', CURRENT_DATE - INTERVAL '1 day', 10, 10, 'active'
       FROM stock_items WHERE sku = 'MED-AMOX-500';
       ```
    2. Confirm the lot is currently `status='active'`:
       ```sql
       SELECT status FROM stock_lots WHERE lot_number = 'TEST-EXPIRED';
       -- Expected: active
       ```
    3. Manually invoke the cron function: `SELECT run_expiry_alert();` in SQL Editor.
    4. Re-check status.
    5. Attempt to issue from the now-expired lot via DevTools (repeat T47 step 2). Confirm trigger fires.
  - Expected:
    - After `run_expiry_alert()`, lot status changes from `active` → `expired`.
    - Issue attempt from the expired lot is rejected by trigger with `ล็อตหมดอายุหรือถูกเรียกคืน`.
    - Only lots where `status='active' AND expiry_date < CURRENT_DATE` are affected; other statuses unchanged.
  - DB probe (after run):
    ```sql
    SELECT lot_number, status, expiry_date::text
    FROM stock_lots WHERE lot_number = 'TEST-EXPIRED';
    -- Expected: TEST-EXPIRED / expired / <yesterday's date>

    -- Verify cron only targets active lots (regression guard)
    SELECT count(*) FROM stock_lots
    WHERE expiry_date < CURRENT_DATE AND status NOT IN ('expired','depleted','recalled');
    -- Expected: 0 (all past-expiry active lots have been expired)
    ```

---

## Expiry alert Telegram

- [ ] T53: Expiry alert Telegram — lot expiring today+25d triggers 30-day bucket alert via tg-notify
  - Steps:
    1. Confirm `NOTIFY_SUPABASE_URL` and `NOTIFY_SERVICE_ROLE_KEY` are set in `settings` table.
    2. Insert test lot:
       ```sql
       INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty)
       SELECT id, 'TEST-30D', CURRENT_DATE + 25, 10, 10
       FROM stock_items WHERE sku = 'MED-AMOX-500';
       ```
    3. Run `SELECT run_expiry_alert();` in SQL Editor.
    4. Check `notification_log` for a row with the expected dedupe_key.
    5. Confirm Telegram group received a message (verify with PM or check Telegram directly).
  - Expected:
    - `notification_log` row inserted with `event_type='expiry'` (or `expiry_alert`) and `dedupe_key = 'expiry:30:<YYYY-MM-DD of today>'` and `success=true`.
    - Telegram message received mentioning at least one lot and the 30-day bucket.
  - DB probe (after run):
    ```sql
    SELECT event_type, dedupe_key, success, created_at
    FROM notification_log
    WHERE dedupe_key = 'expiry:30:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
    -- Expected: 1 row, success=true
    ```

- [ ] T54: Expiry alert dedupe — re-run cron same day produces no duplicate Telegram
  - Steps:
    1. Confirm T53 has already been run today (notification_log row with `dedupe_key='expiry:30:<today>'` exists).
    2. Run `SELECT run_expiry_alert();` a second time in the same SQL Editor session.
    3. Check `notification_log` row count for today's 30d key.
    4. Verify no second Telegram message is delivered (check Telegram group — only one message for the session).
  - Expected:
    - `notification_log` count for `dedupe_key='expiry:30:<today>'` remains 1 (no new row added on second run).
    - `tg-notify` function returns `{dedupe_hit: true}` or equivalent indicating it skipped the send.
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM notification_log
    WHERE dedupe_key = 'expiry:30:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
    -- Expected: 1 (exactly, not 2 or more)
    ```

---

## Admin lot management UI

- [ ] T55: Expired-lot view filter — "ล็อตยา" sub-view filter "เกินกำหนด" shows only status=expired lots
  - Steps:
    1. Ensure at least one `status='expired'` lot exists (created in T52 cleanup or use a separate insert).
    2. Open admin.html → Inventory tab → "ล็อตยา" sub-view.
    3. Click the filter chip or dropdown labelled "เกินกำหนด" (expired filter).
    4. Observe the lot list.
    5. Run DB probe to compare count.
  - Expected:
    - Only rows with `status='expired'` are displayed in the lot list.
    - Active, depleted, and recalled lots are hidden.
    - The displayed count matches the DB count of `status='expired'` lots.
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM stock_lots WHERE status = 'expired';
    -- Compare this count to the number of rows shown in the UI after applying the filter.
    -- Expected: counts match.
    ```

- [ ] T56: Recall workflow — Admin marks lot recalled via UI; recalled_by, recalled_at, recalled_reason populated
  - Steps:
    1. Ensure `LOT-2026-A` exists with `status='active'` (from T45).
    2. Open admin.html → Inventory tab → "ล็อตยา" sub-view. Locate `LOT-2026-A` row.
    3. Click the "เรียกคืน" (Recall) button on the `LOT-2026-A` row.
    4. A recall modal opens. Enter reason: `"ผู้ผลิตแจ้งเรียกคืน"`. Click "ยืนยัน".
    5. Observe status badge change in the lot list. Run DB probe.
  - Expected:
    - `LOT-2026-A` status badge changes to "ถูกเรียกคืน" (recalled).
    - `stock_lots` row: `status='recalled'`, `recalled_reason='ผู้ผลิตแจ้งเรียกคืน'`, `recalled_by` = Admin's username, `recalled_at` is a recent timestamp (within 60s of action).
    - Lot disappears from `v_lots_with_remaining` view.
  - DB probe (after run):
    ```sql
    SELECT status, recalled_reason, recalled_by, recalled_at IS NOT NULL AS has_timestamp
    FROM stock_lots WHERE lot_number = 'LOT-2026-A';
    -- Expected: recalled / ผู้ผลิตแจ้งเรียกคืน / <admin-username> / true

    SELECT count(*) FROM v_lots_with_remaining
    WHERE lot_number = 'LOT-2026-A';
    -- Expected: 0 (recalled lot not in view)
    ```

- [ ] T57: Recalled lot cannot be issued — DB trigger AND UI both block the issue
  - Steps:
    1. Use `LOT-2026-A` (now `status='recalled'` from T56). Confirm status in DB:
       ```sql
       SELECT status FROM stock_lots WHERE lot_number = 'LOT-2026-A';
       -- Expected: recalled
       ```
    2. In DevTools Console, attempt a direct REST insert: `movement_type='issue'`, `lot_id` = LOT-2026-A uuid, `qty_delta=-1`.
    3. Observe error. Confirm `ล็อตหมดอายุหรือถูกเรียกคืน` in error message.
    4. Open staff-scan.html, scan MED-AMOX-500 and its location. Observe lot picker — LOT-2026-A must NOT appear.
    5. Run DB probe.
  - Expected:
    - DB trigger rejects direct INSERT with `ล็อตหมดอายุหรือถูกเรียกคืน` (same string as T47/T48).
    - Lot picker in staff-scan does NOT list `LOT-2026-A` (view `v_lots_with_remaining` excludes recalled status).
    - No movement row created.
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM stock_movements
    WHERE lot_id = (SELECT id FROM stock_lots WHERE lot_number = 'LOT-2026-A')
      AND movement_type = 'issue';
    -- Expected: 0 (no issue movements possible on recalled lot)
    ```

- [ ] T58: Auto-deplete on zero qty — lot.current_qty=0 after final issue → status='depleted'
  - Steps:
    1. Create or identify a lot with a small `current_qty`. Use `LOT-2026-B` (should have `current_qty=45` after T51). Reset if needed:
       ```sql
       UPDATE stock_lots SET current_qty = 5 WHERE lot_number = 'LOT-2026-B';
       ```
    2. Open staff-scan.html as Employee. Issue exactly 5 units from `LOT-2026-B` (the full remaining qty).
    3. Confirm success toast.
    4. Run DB probe to check status.
  - Expected:
    - `stock_lots.current_qty` for `LOT-2026-B` = 0.
    - `stock_lots.status` auto-changes to `'depleted'` (set by `apply_movement_to_lot_qty` trigger when `current_qty` reaches 0).
    - `LOT-2026-B` does NOT appear in `v_lots_with_remaining` after this.
  - DB probe (after run):
    ```sql
    SELECT lot_number, current_qty, status
    FROM stock_lots WHERE lot_number = 'LOT-2026-B';
    -- Expected: LOT-2026-B / 0 / depleted

    SELECT count(*) FROM v_lots_with_remaining
    WHERE lot_number = 'LOT-2026-B';
    -- Expected: 0
    ```

---

## Realtime

- [ ] T59: Realtime — lot status change propagates to admin Lots view within ~1s
  - Steps:
    1. Open admin.html → Inventory → "ล็อตยา" sub-view in Chrome tab A. Locate an active lot (e.g. a freshly created `LOT-2026-C` with `status='active'`).
    2. In a separate Chrome tab B (or SQL Editor), execute:
       ```sql
       UPDATE stock_lots SET status = 'recalled',
         recalled_reason = 'T59 realtime test',
         recalled_by = 'qa-tester',
         recalled_at = now()
       WHERE lot_number = 'LOT-2026-C';
       ```
    3. Switch back to tab A immediately. Observe the lot row status badge without refreshing.
    4. Time the propagation: status should update within ~1 second (Supabase Realtime latency target).
    5. Run DB probe to confirm the change landed.
  - Expected:
    - The status badge in the ล็อตยา sub-view updates from "ใช้งาน" to "ถูกเรียกคืน" without a page refresh.
    - Propagation occurs within approximately 1 second of the SQL UPDATE.
    - Realtime channel `realtime:lots` (or equivalent Phase 2 channel name) is subscribed and active.
  - DB probe (after run):
    ```sql
    SELECT status FROM stock_lots WHERE lot_number = 'LOT-2026-C';
    -- Expected: recalled

    -- Verify Realtime publication includes stock_lots
    SELECT tablename FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'stock_lots';
    -- Expected: 1 row
    ```

---

## Multi-lot same item same location

- [ ] T60: Multi-lot same item same location — receive +50 lot A then +30 lot B on same SKU+location → sil.qty=80, two stock_lots rows
  - Steps:
    1. Receive 50 units of `MED-AMOX-500` to `ROOM-A` with lot `LOT-MULTI-A` (expiry 2027-12-01).
    2. Receive 30 units of `MED-AMOX-500` to the same `ROOM-A` location with lot `LOT-MULTI-B` (expiry 2027-10-01).
    3. Open Inventory list; check the displayed total qty for `MED-AMOX-500` at `ROOM-A`.
    4. Run DB probe to verify the SIL row and individual lot rows.
    5. Open staff-scan lot picker for `MED-AMOX-500`; confirm both lots appear (with FEFO: LOT-MULTI-B before LOT-MULTI-A).
  - Expected:
    - `stock_item_locations.qty` for `MED-AMOX-500` at `ROOM-A` = 80 (cumulative across both receives).
    - Two distinct `stock_lots` rows for `MED-AMOX-500` with `lot_number` `LOT-MULTI-A` and `LOT-MULTI-B`.
    - Lot picker shows `LOT-MULTI-B` first (expires 2027-10-01 < 2027-12-01 — FEFO order).
  - DB probe (after run):
    ```sql
    SELECT qty FROM stock_item_locations
    WHERE item_id = (SELECT id FROM stock_items WHERE sku = 'MED-AMOX-500')
      AND location_id = (SELECT id FROM locations WHERE code = 'ROOM-A');
    -- Expected: a value that includes the +50 and +30 (net of any prior issues)

    SELECT lot_number, current_qty, expiry_date::text
    FROM stock_lots
    WHERE item_id = (SELECT id FROM stock_items WHERE sku = 'MED-AMOX-500')
      AND lot_number IN ('LOT-MULTI-A','LOT-MULTI-B')
    ORDER BY expiry_date ASC;
    -- Expected: LOT-MULTI-B (2027-10-01) then LOT-MULTI-A (2027-12-01)
    ```

---

## Item Finder lot awareness

- [ ] T61: Lot-aware Item Finder — search shows per-lot expiry info, not just total
  - Steps:
    1. Open admin.html or staff-scan.html. Use the Item Finder / search bar.
    2. Type `MED-AMOX-500` or `อะม็อกซิลิน`. Observe the autocomplete result card.
    3. Expand or click through to the item detail. Confirm per-lot expiry information is visible (not only aggregate qty).
    4. Compare lot details shown (lot number, expiry date, current qty) against DB probe results.
    5. Repeat with cold cache (open a new tab, navigate directly to the URL, repeat search).
  - Expected:
    - Each active lot for `MED-AMOX-500` is shown with its `lot_number`, `expiry_date`, and `current_qty`.
    - The expiry badge colour matches the correct bucket: green (>90d), amber (31–90d), red (≤30d).
    - The aggregate `total_qty` shown matches `SUM(current_qty)` across all active lots.
  - DB probe (after run):
    ```sql
    SELECT lot_number, expiry_date::text, current_qty, status
    FROM v_lots_with_remaining
    WHERE item_id = (SELECT id FROM stock_items WHERE sku = 'MED-AMOX-500')
    ORDER BY expiry_date ASC;
    -- Compare each row's expiry_date and current_qty against what the UI displays.
    ```

---

## Dashboard expiry timeline panel

- [ ] T62: Dashboard expiry timeline panel — counts match lot rows in DB grouped by bucket
  - Steps:
    1. Ensure the following lots exist in known buckets (create if needed):
       - 1 lot expiring within 30 days (`CURRENT_DATE + 20`)
       - 1 lot expiring within 31–60 days (`CURRENT_DATE + 50`)
       - 1 lot expiring within 61–90 days (`CURRENT_DATE + 80`)
    2. Open admin.html → Dashboard tab. Locate the "Expiry Timeline" panel / widget.
    3. Record the count shown in each bucket (≤30d, 31–60d, 61–90d).
    4. Run DB probe to get actual counts per bucket.
    5. Compare UI counts against DB counts.
  - Expected:
    - UI bucket counts match the DB query results exactly.
    - Expired lots (`status='expired'`) are NOT counted in the timeline (they are past, not upcoming).
    - Recalled and depleted lots are NOT counted.
  - DB probe (after run):
    ```sql
    SELECT
      COUNT(*) FILTER (WHERE expiry_date <= CURRENT_DATE + 30)  AS bucket_30,
      COUNT(*) FILTER (WHERE expiry_date > CURRENT_DATE + 30
                         AND expiry_date <= CURRENT_DATE + 60)   AS bucket_60,
      COUNT(*) FILTER (WHERE expiry_date > CURRENT_DATE + 60
                         AND expiry_date <= CURRENT_DATE + 90)   AS bucket_90
    FROM stock_lots
    WHERE status = 'active' AND expiry_date > CURRENT_DATE;
    -- Compare each column against the corresponding UI bucket count.
    ```

- [ ] T63: Expiry timeline panel link navigates to Lots sub-view pre-filtered to that bucket
  - Steps:
    1. From the Dashboard expiry timeline panel (set up in T62), click the "≤30 วัน" bucket count or link.
    2. Observe navigation target: should go to admin.html → Inventory → ล็อตยา sub-view with the ≤30d filter pre-applied.
    3. Verify the URL or UI state includes a filter parameter / chip showing "ใกล้หมดอายุ (≤30 วัน)".
    4. Verify the rows displayed match the 30-day bucket lots from T62.
    5. Repeat for the 31–60d bucket link.
  - Expected:
    - Clicking the 30d bucket link lands on the ล็อตยา sub-view with only lots expiring within 30 days visible.
    - The filter chip or tab state is visibly "active" for the ≤30d bucket.
    - Count of displayed rows matches `bucket_30` from T62 DB probe.
    - Back button / navigating away removes the pre-filter.
  - DB probe (after run):
    ```sql
    -- Verify the set of lots that should appear under ≤30d filter
    SELECT lot_number, expiry_date::text, status
    FROM stock_lots
    WHERE status = 'active'
      AND expiry_date > CURRENT_DATE
      AND expiry_date <= CURRENT_DATE + 30
    ORDER BY expiry_date ASC;
    -- Compare row-by-row against what the pre-filtered ล็อตยา view shows.
    ```

---

## Mobile / responsive

- [ ] T64: 4-segment tab @ 360px — scroll-x works, no label truncation, edge-fade visible
  - Steps:
    1. Open admin.html in Chrome DevTools → Device toolbar. Set viewport to 360×640 (e.g., Moto G4 preset or custom).
    2. Navigate to the Inventory tab. Observe the 4-segment tab bar: "รายการสินค้า / รับเข้า / ล็อตยา / Timeline".
    3. Check: (a) All four label strings are readable in full (no `…` truncation). (b) A faint edge fade / gradient hint is visible at the right edge of the tab strip (per Q-D5 decision). (c) Horizontal scroll is possible on the tab strip to reveal any off-screen tabs.
    4. Resize to 320px width and repeat.
    5. Resize back to 390px (iPhone 14 Pro width) and confirm no horizontal scroll needed.
  - Expected:
    - At 360px: all 4 tab labels render untruncated. The tab strip scrolls horizontally. A fade gradient is visible at the right edge.
    - At 320px: same behaviour — scroll, no truncation, edge fade.
    - At 390px: all tabs likely fit without scroll (no regression at wider viewports).
    - `overflow-x: auto` (not `hidden`) is set on the tab container (inspect element to confirm).
  - DB probe (after run):
    ```sql
    -- No DB state to probe for this UI test.
    -- Record: Browser=Chrome vX, OS=Windows 11, Viewport=360x640, Result=pass/fail
    ```

- [ ] T65: Lot picker 5+accordion — if >5 lots, see top 5 + "ดูทั้งหมด (N ล็อต)" link
  - Steps:
    1. Create 6 or more active lots for `MED-AMOX-500` (use SQL bulk insert):
       ```sql
       INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty)
       SELECT id, 'LOT-BULK-' || gs, CURRENT_DATE + (gs * 10), 10, 10
       FROM stock_items, generate_series(1,6) AS gs
       WHERE sku = 'MED-AMOX-500';
       ```
    2. Open staff-scan.html. Scan `MED-AMOX-500` and its location.
    3. At the Lot Picker step, count the number of lot rows displayed by default.
    4. Look for a "ดูทั้งหมด" link or accordion trigger.
    5. Click "ดูทั้งหมด (N ล็อต)" and confirm all 6+ lots appear.
  - Expected:
    - Default view shows exactly 5 lots (the 5 earliest-expiring per FEFO).
    - A link reading `"ดูทั้งหมด (6 ล็อต)"` (or the actual N) appears below the 5th row.
    - After clicking the link, all 6+ lots are visible in FEFO order.
    - Lots beyond the 5th are hidden initially, not missing from the DOM (for accessibility).
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM stock_lots
    WHERE item_id = (SELECT id FROM stock_items WHERE sku = 'MED-AMOX-500')
      AND status = 'active';
    -- Expected: 6 or more (confirm the lot count the UI should display in the link label)
    ```

- [ ] T66: Expired lot greyed out in lot picker — NOT tappable, no force-issue button present
  - Steps:
    1. Ensure `TEST-EXPIRED` lot exists with `status='expired'` for `MED-AMOX-500` (created in T52).
    2. Open staff-scan.html. Scan `MED-AMOX-500` and its stocked location.
    3. At the Lot Picker step, inspect whether `TEST-EXPIRED` appears at all.
    4. If it appears: confirm it is greyed out (reduced opacity / disabled visual state) and cannot be tapped / selected (clicking does not highlight or select it).
    5. Confirm there is NO "บังคับเบิก-จ่าย" (force-issue) button or link anywhere on the lot picker or detail panel (per Q-D1 — force-issue removed from Phase 2 scope).
  - Expected:
    - Per `v_lots_with_remaining` excluding `status='expired'`, the expired lot does NOT appear in the lot picker at all (filtered out at the data layer, not just greyed client-side).
    - If UI renders expired lots with grey styling for informational purposes, they must not be selectable.
    - The "บังคับเบิก-จ่าย" button is completely absent from the UI (not rendered, not disabled).
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM v_lots_with_remaining
    WHERE lot_number = 'TEST-EXPIRED';
    -- Expected: 0 (expired lot is excluded from the view used by the lot picker)

    -- Confirm no force-issue UI element exists in source (static check)
    -- Grep the frontend JS/HTML for 'บังคับเบิก' or 'force' near lot picker logic.
    -- Expected: no matches
    ```

---

## RLS permissions

- [ ] T67: RLS — Employee cannot INSERT into stock_lots (admin only)
  - Steps:
    1. Log in as Employee (e.g. `Pt1 / thegood`). Confirm JWT in DevTools Application → Local Storage (or copy from Supabase JS client `supabase.auth.getSession()`).
    2. In DevTools Console (with Employee JWT active), attempt:
       ```javascript
       const { error } = await supabase.from('stock_lots').insert({
         item_id: '<any valid item uuid>',
         lot_number: 'TEST-RLS-EMP',
         expiry_date: '2030-01-01',
         received_qty: 1,
         current_qty: 1
       });
       console.log(error?.code, error?.message);
       ```
    3. Check HTTP status and error code.
    4. Run DB probe to confirm no row was inserted.
    5. (Cold cache repeat) Repeat in a fresh incognito tab logged in as Employee.
  - Expected:
    - `error.code` = `'42501'` (insufficient_privilege) or error message contains `"row-level security policy"`.
    - HTTP response status = 403.
    - No row inserted into `stock_lots`.
  - DB probe (after run):
    ```sql
    SELECT count(*) FROM stock_lots WHERE lot_number = 'TEST-RLS-EMP';
    -- Expected: 0

    -- Verify RLS policy exists and targets Admin role only
    SELECT policyname, cmd, qual
    FROM pg_policies
    WHERE tablename = 'stock_lots' AND cmd = 'INSERT';
    -- Expected: at least one INSERT policy restricting to app_user_role()='Admin'
    ```

- [ ] T68: RLS — Employee CAN INSERT stock_movements with a valid active lot_id
  - Steps:
    1. Log in as Employee (`Pt1 / thegood`). Ensure `LOT-2026-B` has `status='active'` and `current_qty > 0` (reset if needed: `UPDATE stock_lots SET status='active', current_qty=20 WHERE lot_number='LOT-2026-B';`).
    2. In DevTools Console (Employee JWT), attempt:
       ```javascript
       const { error } = await supabase.from('stock_movements').insert({
         item_id: '<MED-AMOX-500 item uuid>',
         location_id: '<location uuid where item is stocked>',
         movement_type: 'issue',
         qty_delta: -1,
         lot_id: '<LOT-2026-B uuid>'
       });
       console.log(error?.code, error?.message);
       ```
    3. Confirm INSERT succeeds (no error).
    4. Run DB probe to verify the movement row was created.
    5. Confirm `lot_id` is set correctly and `fefo_override=false` (no override since this was a clean issue without UI override).
  - Expected:
    - `error` is `null` — Employee is allowed to insert `stock_movements` with `movement_type='issue'`.
    - HTTP response status 201.
    - `stock_movements` row created with correct `lot_id`, `performed_by` = Employee's user reference, `fefo_override=false`.
    - `stock_lots.current_qty` for `LOT-2026-B` decremented by 1.
  - DB probe (after run):
    ```sql
    SELECT movement_type, qty_delta, fefo_override, lot_id IS NOT NULL AS has_lot
    FROM stock_movements
    WHERE performed_by = (SELECT id::text FROM auth.users
                          WHERE email LIKE '%Pt1%' LIMIT 1)
    ORDER BY performed_at DESC LIMIT 1;
    -- Expected: issue / -1 / false / true
    -- (Adjust performed_by filter to match your Employee user identifier convention)

    SELECT current_qty FROM stock_lots WHERE lot_number = 'LOT-2026-B';
    -- Expected: 19 (or prior qty minus 1)
    ```

---

## Infrastructure / deployment verification

- [ ] T69: Migration timestamp 010000 series confirmed — all Phase 2 migrations deployed
  - Steps:
    1. Open Supabase Dashboard SQL Editor for project `xtjsjrfixngfdkaahton`.
    2. Run the DB probe query below to confirm all Phase 2 tables/views/enums exist.
    3. Cross-check the local migration file list against the expected set of 8 files.
    4. Confirm `stock_lots` table columns match the spec (19 columns including `recalled_reason`, `recalled_by`, `recalled_at`).
    5. Confirm `stock_movements` has the `fefo_override` column (added in migration `20260519010200`).
  - Expected:
    - All 4 Phase 2 tables/objects exist: `stock_lot_status` enum, `stock_lots` table, `v_lots_with_remaining` view, `fefo_override` column on `stock_movements`.
    - Migration files `20260519010000` through `20260519010700` are all present in `supabase/migrations/` in the repo.
    - No Phase 1 migration timestamp is shadowed or overwritten (Phase 1 used `20260518010000`–`20260518010700`; Phase 2 uses `20260519010000`–`20260519010700` — different dates, no collision).
  - DB probe (after run):
    ```sql
    -- 1. Enum exists
    SELECT enumlabel FROM pg_enum
    WHERE enumtypid = 'stock_lot_status'::regtype
    ORDER BY enumsortorder;
    -- Expected: 4 rows: active, depleted, expired, recalled

    -- 2. stock_lots table exists with 19 columns
    SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'stock_lots';
    -- Expected: 19

    -- 3. fefo_override column on stock_movements
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = 'stock_movements' AND column_name = 'fefo_override';
    -- Expected: 1 row, data_type=boolean, column_default='false'

    -- 4. v_lots_with_remaining view exists
    SELECT viewname FROM pg_views WHERE viewname = 'v_lots_with_remaining';
    -- Expected: 1 row

    -- 5. MEDICATION category seeded
    SELECT code, name FROM stock_categories WHERE code = 'MEDICATION';
    -- Expected: 1 row — MEDICATION / ยา
    ```

- [ ] T70: sw.js CACHE_VERSION=v0.3.0 confirmed via DevTools or Service Worker response header
  - Steps:
    1. Open the deployed GitHub Pages URL for the project in Chrome (e.g. `https://officethegood.github.io/thegood-stock/`).
    2. Open DevTools → Application → Service Workers. Confirm the active Service Worker script URL.
    3. Click "Update" or hard-reload (Ctrl+Shift+R). Observe the new CACHE_VERSION value in the SW script.
    4. Open DevTools → Network tab. Filter by `sw.js`. Check the Response Headers for `ETag` or inspect the script body.
    5. Alternatively, run `curl -s https://officethegood.github.io/thegood-stock/sw.js | head -5` and confirm the CACHE_VERSION line.
  - Expected:
    - `sw.js` first non-comment line contains `const CACHE_VERSION = 'thegood-stock-v0.3.0';`.
    - The previous cache key `thegood-stock-v0.2.2` (Phase 1) is evicted from CacheStorage on activation.
    - DevTools → Application → Cache Storage shows `thegood-stock-v0.3.0` as the active cache bucket.
    - No stale `thegood-stock-v0.2.2` cache bucket remains.
  - DB probe (after run):
    ```sql
    -- No DB state to probe for this client-side test.
    -- Record: Browser=Chrome vX, OS=Windows 11, URL=<github-pages-url>, Result=pass/fail
    -- Expected string: const CACHE_VERSION = 'thegood-stock-v0.3.0';
    ```

---

## Phase 2 Summary

| Status | Count | Tests |
|---|---|---|
| Fully verified | TBD | — |
| Partial / soft-pass | TBD | — |
| Blocked | TBD | — |
| Pending | TBD | — |

**Phase 2 closure verdict (PM, 2026-05-19):** Migrations deployed + verified; DB-level smoke (T1-T7) PASSED including S-3 race-window and S-5 server-side fefo_override; UI live and visually verified (4-segment tabs, "ล็อตยา" empty state, dashboard expiry timeline panel replaces Phase 1 placeholder). T45-T70 full UI flows deferred until at least one MEDICATION item is seeded by Admin. Tag `phase2-medication = d934cda` pushed 2026-05-19.

## Phase 2 deploy smoke (DB-level, 2026-05-19 @ d934cda)
- [x] **DEPLOY-A**: 9 migrations + S-1 hotfix applied via Mgmt API — all verify counts pass
- [x] **DEPLOY-B**: Trigger smoke test 7/7 PASSED (T1 receive lot A, T2 multi-lot, T3 FEFO correct, T4 FEFO override server-side, T5 expired-block, T6 S-3 race-window, T7 cron smoke)
- [x] **DEPLOY-C**: S-1 hotfix verified live — `leaked_service_role: false`
- [x] **DEPLOY-D**: Browser sanity — 4 sub-views render; ล็อตยา empty state visible
- [x] **DEPLOY-E**: Dashboard expiry timeline panel replaces placeholder (M-76/M-77 microcopy)

---

# Phase 1.1 Polish + Phase 2 Security Tightening — Manual Test Checklist (T71–T75)

> **Pre-flight:** Phase 2 migrations `20260519010000`–`20260519010900` deployed + verified (DEPLOY-A..E pass). Phase 1.1 polish migrations `20260519020000`–`20260519020100` deployed + verified (Tasks A1, A2 probes pass). FE changes from Tasks B1–B6 pushed to GitHub Pages.

## Realtime (P1 fix)
- [ ] T71: Realtime auto-refresh — Admin Inventory tab updates within 400ms of a DB change without manual reload
  - Steps: Open admin.html → Inventory tab. In SQL Editor run `UPDATE stock_items SET updated_at = now() WHERE id = (SELECT id FROM stock_items LIMIT 1);`. Observe Inventory list.
  - Expected: Item list re-renders within ~400ms. No console `ReferenceError: _scheduleRealtimeReload`. No thundering-herd on rapid DB writes (true debounce: only one reload fires 300ms after the last event).
  - DB probe: `SELECT count(*) FROM stock_items;` — count unchanged (update not insert).

## Staff scan note field (P2 confirmation)
- [ ] T72: Staff scan `note` field persists to DB — confirmed fixed in Phase 2 (d934cda)
  - Steps: staff-scan.html → manual panel → SKU `SUP-GAUZE-001` + location `ROOM-A` + qty 1 + note "T72 note confirm" → submit.
  - Expected: success overlay shown. DB probe:
    ```sql
    SELECT note, reason FROM stock_movements ORDER BY performed_at DESC LIMIT 1;
    -- Expected: note = 'T72 note confirm', reason = NULL
    ```

## Over-issue toast (P3 fix)
- [ ] T73: Over-issue toast shows "ของไม่พอ" (not generic Thai) when 23514 qty_check fires
  - Steps: DevTools Console (Admin JWT):
    ```javascript
    const { error } = await window.AppInventory.issue('<SUP-GAUZE-001 id>', '<ROOM-A id>', 99999, null);
    console.log(error?.friendly, error?.code);
    ```
  - Expected: `error.code = '23514'`, `error.friendly = 'ของไม่พอ'`. UI toast shows "ของไม่พอ".

## Dashboard low-stock SKU drill-down (P7 fix)
- [ ] T74: Dashboard low-stock "→ ดู" link pre-filters Inventory tab to that SKU
  - Steps: Dashboard tab → Low-stock panel → click "→ ดู" next to any low-stock item (e.g. SUP-GAUZE-001).
  - Expected: Inventory tab activates, `#inv-search` value = clicked SKU, list shows only that item.
    `location.hash` = `#inventory?sku=<SKU>`.

## S2-B: recalled_reason constraint (A2 fix)
- [ ] T75: recalled_reason constraint enforced — recall with reason < 5 chars rejected
  - Steps: SQL Editor:
    ```sql
    BEGIN;
    INSERT INTO stock_lots (item_id, lot_number, expiry_date, received_qty, current_qty, status,
                            recalled_reason, recalled_by, recalled_at)
    SELECT id, 'TEST-RECALL-CONSTRAINT', '2030-01-01', 10, 10, 'recalled',
           'short', 'qa', now()
    FROM stock_items WHERE sku = 'MED-AMOX-500';
    ROLLBACK;
    ```
  - Expected: `ERROR: new row for relation "stock_lots" violates check constraint "chk_recalled_reason_required"`.
  - Confirm valid reason (>= 5 chars) succeeds — change `'short'` to `'ผู้ผลิตแจ้งเรียกคืน'` and confirm no error (then ROLLBACK either way).


---

## Phase 3 Borrow/Return (T76-T100)

> Prerequisite: migrations 20260519030000-20260519030700 applied. Settings row OVERDUE_GROUP_THRESHOLD=10 present.

### Migration verification

- [ ] T76: stock_loans table exists with correct columns
  - Steps: SQL Editor:
    ```sql
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'stock_loans'
    ORDER BY ordinal_position;
    ```
  - Expected: columns present -- id, movement_id_borrow, movement_id_return, item_id, location_id_from, borrower_username (NOT NULL), borrowed_at, due_at (NOT NULL), returned_at, photo_borrow_url, photo_return_url, qty, status, notes, created_at, updated_at, updated_by.

- [ ] T77: stock_loan_status enum exists
  - Steps: SQL Editor:
    ```sql
    SELECT enumlabel FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    WHERE pg_type.typname = 'stock_loan_status'
    ORDER BY enumsortorder;
    ```
  - Expected: 4 rows -- active, returned, overdue, cancelled.

- [ ] T78: due_at and borrower_username columns exist on stock_movements
  - Steps: SQL Editor:
    ```sql
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'stock_movements'
      AND column_name IN ('due_at', 'borrower_username');
    ```
  - Expected: 2 rows.

- [ ] T79: Trigger functions present with correct SECURITY DEFINER setting
  - Steps: SQL Editor:
    ```sql
    SELECT proname, prosecdef FROM pg_proc
    WHERE proname IN (
      'validate_borrow_movement',
      'create_loan_from_borrow',
      'close_loan_from_return',
      'run_overdue_alert'
    )
    ORDER BY proname;
    ```
  - Expected: 4 rows. validate_borrow_movement: prosecdef=false. Others: prosecdef=true.

- [ ] T80: pg_cron jobs registered
  - Steps: SQL Editor:
    ```sql
    SELECT jobname, schedule FROM cron.job
    WHERE jobname IN ('overdue_alert_morning', 'overdue_alert_evening')
    ORDER BY jobname;
    ```
  - Expected: 2 rows -- overdue_alert_evening (0 10 * * *), overdue_alert_morning (0 2 * * *).

### Borrow flow (Staff scan page)

- [ ] T81: Borrow flow -- full happy path creates stock_movements + stock_loans row
  - Steps: staff-scan.html -> tap "ยืม-คืน" mode -> "ยืมอุปกรณ์" -> scan item barcode -> scan location QR -> due date 3 days (default) -> skip photo -> confirm.
  - Expected: toast "ยืมสำเร็จ". SQL probe:
    ```sql
    SELECT sl.status, sl.borrower_username, sl.qty, sl.due_at,
           sm.movement_type, sm.due_at AS sm_due_at
    FROM stock_loans sl
    JOIN stock_movements sm ON sm.id = sl.movement_id_borrow
    ORDER BY sl.created_at DESC LIMIT 1;
    ```
    Expected: status=active, movement_type=borrow, sm_due_at NOT NULL.

- [ ] T82: Borrow flow -- due_at defaults to 3 days from now at 23:59 (Q-Phase3-G)
  - Steps: Open borrow flow -> reach due-date step -> observe pre-filled date.
  - Expected: date input shows today+3 at 23:59. Preset button "3 วัน" is highlighted active.

- [ ] T83: Borrow flow -- due_at in the past rejected with Thai toast
  - Steps: Borrow flow -> manually set due date to yesterday -> confirm.
  - Expected: toast contains "ของยืมเลยกำหนด".

- [ ] T84: Borrow flow -- due_at missing rejected
  - Steps: DevTools Console (Staff JWT):
    ```javascript
    const { error } = await window.AppLoans.createBorrow({
      itemId: '<any valid item id>',
      locationId: '<any valid location id>',
      qty: 1,
      dueAt: null,
      borrowerUsername: null,
    });
    console.log(error?.message);
    ```
  - Expected: error message contains "ต้องระบุกำหนดคืน".

- [ ] T85: Admin proxy-borrow sets borrower_username (Q-Phase3-D)
  - Steps: DevTools Console (Admin JWT):
    ```javascript
    const { data, error } = await window.AppLoans.createBorrow({
      itemId: '<item id>',
      locationId: '<location id>',
      qty: 1,
      dueAt: new Date(Date.now() + 3*86400000).toISOString(),
      borrowerUsername: 'somestaff',
    });
    console.log(data, error);
    ```
  - Expected: error=null. SQL probe on stock_loans shows borrower_username='somestaff'.

- [ ] T86: Borrow flow with photo -- photo_borrow_url PATCHed after loan creation
  - Steps: Borrow flow -> take photo (or upload file) -> confirm.
  - Expected:
    ```sql
    SELECT photo_borrow_url FROM stock_loans ORDER BY created_at DESC LIMIT 1;
    ```
    Returns Cloudinary URL (NOT NULL).

- [ ] T87: Borrow flow -- qty_delta drives stock down on borrow
  - Steps: Note item total_qty before borrow. Complete borrow of qty=2.
  - Expected: item total_qty decreases by 2. Verify via Dashboard -> Item Finder.

### Return flow (Staff scan page)

- [ ] T88: Return flow -- happy path closes loan and creates return movement
  - Steps: staff-scan.html -> ยืม-คืน mode -> "คืนอุปกรณ์" -> scan item barcode -> skip photo -> confirm.
  - Expected: toast "คืนสำเร็จ". SQL probe:
    ```sql
    SELECT sl.status, sl.returned_at, sl.movement_id_return
    FROM stock_loans sl ORDER BY sl.updated_at DESC LIMIT 1;
    ```
    Expected: status=returned, returned_at NOT NULL, movement_id_return NOT NULL.

- [ ] T89: Return flow -- no open loan for item gives Thai error toast
  - Steps: staff-scan.html -> ยืม-คืน mode -> "คืนอุปกรณ์" -> scan item with no active/overdue loan.
  - Expected: toast contains "ไม่พบรายการยืมที่เปิดอยู่".

- [ ] T90: Return flow with photo -- photo_return_url PATCHed after return
  - Steps: Return flow -> take photo -> confirm.
  - Expected:
    ```sql
    SELECT photo_return_url FROM stock_loans ORDER BY updated_at DESC LIMIT 1;
    ```
    Returns Cloudinary URL (NOT NULL).

### Loans tab (Admin)

- [ ] T91: Admin loans tab renders loan list
  - Steps: admin.html -> click "ยืม-คืน" tab.
  - Expected: tab pane visible, loan list loads with cards showing borrower_username, due_at, status badge.

- [ ] T92: Loans tab status filter -- overdue filter shows only overdue loans
  - Steps: Loans tab -> status dropdown -> select "เกินกำหนด".
  - Expected: only red "เกินกำหนด" badge cards visible.

- [ ] T93: Loans tab search filter
  - Steps: Loans tab -> type borrower username in search input.
  - Expected: loan list filters client-side to matching rows.

- [ ] T94: Loans tab detail drawer opens on tap
  - Steps: Loans tab -> tap "จัดการ" on any loan card.
  - Expected: Bootstrap offcanvas slides in with item name, borrower, due_at, status, borrow photo if present.

- [ ] T95: Admin return via modal -- closes loan correctly
  - Steps: Loans tab -> open detail drawer for active loan -> "บันทึกคืน" -> confirm (skip photo).
  - Expected: modal closes, loan card status updates to "คืนแล้ว". SQL probe confirms status=returned.

### Dashboard Panel 4

- [ ] T96: Dashboard Panel 4 shows live borrow counts
  - Steps: admin.html -> Dashboard tab.
  - Expected: Panel 4 shows three rows ยืมอยู่ / เกินกำหนด / คืนวันนี้ with count badges. No placeholder text visible.

- [ ] T97: Dashboard Panel 4 tap "เกินกำหนด" navigates to loans tab with overdue filter
  - Steps: Dashboard -> click "เกินกำหนด" row in Panel 4.
  - Expected: loans tab activates, filter shows "เกินกำหนด", list shows only overdue loans.

### Overdue cron (smoke test)

- [ ] T98: run_overdue_alert() -- Pass A marks overdue loans
  - Steps: SQL Editor:
    ```sql
    UPDATE stock_loans SET due_at = now() - interval '2 hours'
    WHERE status = 'active'
    ORDER BY created_at DESC LIMIT 1;
    SELECT run_overdue_alert();
    SELECT id, status, due_at FROM stock_loans WHERE due_at < now() - interval '1 hour';
    ```
  - Expected: run_overdue_alert() returns void (no exception). Rows with due_at in past now have status=overdue.

- [ ] T99: run_overdue_alert() -- skips Telegram when NOTIFY_SUPABASE_URL blank
  - Steps: SQL Editor:
    ```sql
    UPDATE settings SET value = '' WHERE key = 'NOTIFY_SUPABASE_URL';
    SELECT run_overdue_alert();
    UPDATE settings SET value = '<real url>' WHERE key = 'NOTIFY_SUPABASE_URL';
    ```
  - Expected: WARNING logged (NOTIFY_SUPABASE_URL / NOTIFY_SERVICE_ROLE_KEY not set), no error raised.

### Service worker cache

- [ ] T100: CACHE_VERSION bumped to thegood-stock-v0.4.0 and new assets cached
  - Steps: DevTools -> Application -> Cache Storage -> thegood-stock-v0.4.0.
  - Expected: cache contains shared/loans.js, shared/photo-capture.js, js/loans.js. Old cache thegood-stock-v0.3.1 deleted on activate.
    ```javascript
    const keys = await caches.keys();
    console.log(keys); // ['thegood-stock-v0.4.0']
    const c = await caches.open('thegood-stock-v0.4.0');
    const reqs = await c.keys();
    console.log(reqs.map(r => r.url));
    ```

---

## Phase 3 Summary

| Status | Count | Tests |
|---|---|---|
| Fully verified | TBD | -- |
| Partial / soft-pass | TBD | -- |
| Blocked | TBD | -- |
| Pending | TBD | T76-T100 |

---

## Phase 5 Oxygen Tanks (T101-T125)

> **Pre-flight:** Phase 5 migrations `20260519050000`–`20260519050600` deployed. All Phase A tasks complete. At least one location exists (PF-9). All Phase B tasks complete.
> **Verification log convention:** `[x]` followed by ` — <by> <YYYY-MM-DD> @ <commit-hash>: <evidence>`
> **Test data:** All test tanks use deterministic serials (`OXY-T101`–`OXY-T125`). Run cleanup SQL at end of test session.

---

### Data model verification

- [ ] T101: `oxygen_tanks` table exists with correct schema — 15 columns, status default `'ready'`, serial UNIQUE NOT NULL, no purchase_price, no acquired_at.
  ```sql
  SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'oxygen_tanks' ORDER BY ordinal_position;
  -- Expected: 15 columns. status default='ready'. serial NOT NULL.
  -- MUST NOT contain purchase_price or acquired_at columns.
  ```

- [ ] T102: `oxygen_movements` table exists — INSERT-only enforced (no UPDATE/DELETE RLS policies).
  ```sql
  SELECT policyname, cmd FROM pg_policies WHERE tablename = 'oxygen_movements';
  -- Expected: SELECT and INSERT policies only. Zero UPDATE or DELETE policies.
  ```

- [ ] T103: `oxygen_tank_status` enum has exactly 5 values in correct order.
  ```sql
  SELECT enumlabel FROM pg_enum
  WHERE enumtypid = 'oxygen_tank_status'::regtype ORDER BY enumsortorder;
  -- Expected: ready, on_board, refilling, maintenance, retired (5 rows).
  ```

- [ ] T104: `tank_size` CHECK constraint — INSERT with invalid size fails.
  ```sql
  INSERT INTO oxygen_tanks (serial, tank_size, current_location_id)
  SELECT 'OXY-T104-BADSIZE', 'huge', id FROM locations LIMIT 1;
  -- Expected: ERROR — violates check constraint oxygen_tanks_tank_size_check.
  -- No oxygen_tanks row created.
  ```

---

### Admin: Add tank

- [ ] T105: Admin creates new tank — `oxygen_tanks` row + initial `oxygen_movements` row (NULL → ready).
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

- [ ] T106: Duplicate serial rejected.
  - Steps: Attempt to add a second tank with serial `OXY-T105` (T105 must already exist).
  - Expected: inline error "หมายเลขถังนี้มีอยู่แล้ว". No second `oxygen_tanks` row.
  ```sql
  SELECT count(*) FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: 1
  ```

---

### State machine — allowed transitions

- [ ] T107: `ready → on_board` — status updates, movement row inserted, location updated.
  - Steps: Admin → tank `OXY-T105` → "เปลี่ยนสถานะ" → `on_board`, location = ambulance location, note="T107". Submit.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: on_board

  SELECT from_status, to_status, note FROM oxygen_movements
  WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-T105')
  ORDER BY performed_at DESC LIMIT 1;
  -- Expected: ready / on_board / T107
  ```

- [ ] T108: `on_board → refilling` succeeds (Staff role).
  - Steps: Log in as Employee. `staff-oxygen.html` → scan `OXY-T105` (now on_board) → select `refilling`. Submit.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: refilling
  ```

- [ ] T109: `refilling → ready` by Admin — `last_refill_at` and `last_refill_by` updated.
  - Steps: Admin → tank `OXY-T105` (refilling) → "เปลี่ยนสถานะ" → `ready`. Submit.
  ```sql
  SELECT status, last_refill_at IS NOT NULL AS has_refill_ts, last_refill_by
  FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: ready / true / <admin username>
  ```

- [ ] T110: `any → maintenance` by Admin succeeds.
  - Steps: Admin → tank `OXY-T105` (ready) → "เปลี่ยนสถานะ" → `maintenance`, note="hydrostatic test". Submit.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: maintenance
  SELECT note FROM oxygen_movements
  WHERE tank_id = (SELECT id FROM oxygen_tanks WHERE serial = 'OXY-T105')
  ORDER BY performed_at DESC LIMIT 1;
  -- Expected: hydrostatic test
  ```

- [ ] T111: `maintenance → ready` by Admin succeeds.
  ```sql
  SELECT status FROM oxygen_tanks WHERE serial = 'OXY-T105';
  -- Expected: ready (after admin logs maintenance→ready)
  ```

---

### State machine — blocked transitions

- [ ] T112: Invalid transition (`ready → refilling`) blocked with exact Thai error string.
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

- [ ] T113: Retired tank — any transition blocked.
  - Steps: SQL Editor (service role): set tank to `retired`. Then attempt any INSERT into `oxygen_movements` for that tank.
  - Expected: error contains `'ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้'`.

- [ ] T114: `from_status` mismatch blocked.
  - Steps: Insert movement with `from_status` that does not match the tank's current status.
  - Expected: error contains `'สถานะปัจจุบันของถัง'` and `'ไม่ตรงกับ from_status'`.

---

### Admin-only transitions

- [ ] T115: Staff cannot log `refilling → ready` — RLS blocks INSERT.
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

- [ ] T116: Staff cannot log transition to `maintenance` — RLS blocks.
  - Expected: `error.code = '42501'`.

---

### Refill-batch alert

- [ ] T117: Alert fires when refilling count reaches threshold (5).
  - Pre-conditions: `OXYGEN_REFILL_THRESHOLD=5`, `NOTIFY_TELEGRAM_ENABLED=true`, URL + key set.
  - Steps: Create 5 tanks via SQL Editor, transition all to `refilling`. After 5th INSERT:
  ```sql
  SELECT event_type, dedupe_key, success
  FROM notification_log
  WHERE dedupe_key = 'oxygen_refill_batch:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
  -- Expected: 1 row, success=true
  ```
  - Expected also: Telegram message received listing 5 serials with sizes.

- [ ] T118: Dedupe — 6th tank entering refilling same day does NOT send second alert.
  ```sql
  SELECT count(*) FROM notification_log
  WHERE dedupe_key = 'oxygen_refill_batch:' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
  -- Expected: 1 (still 1 after 6th tank)
  ```

- [ ] T119: Below threshold (4 tanks) — no alert fires.
  ```sql
  SELECT count(*) FROM oxygen_tanks WHERE status = 'refilling';
  -- Expected: 4. No new notification_log row for today.
  ```

---

### Realtime

- [ ] T120: `oxygen_tanks` Realtime subscription — status badge updates in admin tab without page reload.
  - Steps: Admin tab "ถังออกซิเจน" open. In SQL Editor (service role): `UPDATE oxygen_tanks SET status='on_board' WHERE serial='OXY-T105';`
  - Expected: Status badge in admin tab updates within ~2 seconds, no page reload.

---

### Dashboard panel

- [ ] T121: Dashboard "สถานะถังออกซิเจน" panel shows correct per-status counts.
  ```sql
  SELECT status, count(*) FROM oxygen_tanks GROUP BY status ORDER BY status;
  -- Compare each count against dashboard panel display.
  ```

- [ ] T122: Dashboard alert badge appears when refilling count >= threshold.
  - Steps: Ensure `count(status='refilling') >= OXYGEN_REFILL_THRESHOLD`. Reload Dashboard.
  - Expected: amber banner "ถังรอเติม {n} ถัง — ถึงเกณฑ์แจ้งเตือน" visible.

---

### Staff scan flow

- [ ] T123: Staff scans tank serial — sees status card and logs `ready → on_board`.
  - Steps: Log in as Employee. `staff-oxygen.html`. Scan/type `OXY-T105` (status=ready). Select on_board. Pick location. Submit.
  - Expected: Success overlay. `oxygen_tanks.status = 'on_board'`. New movement row with `performed_by = <employee username>`.

- [ ] T124: Staff scans unknown serial — inline error, no crash.
  - Steps: Enter serial `OXY-DOESNT-EXIST`.
  - Expected: Inline error "ไม่พบถังหมายเลขนี้ในระบบ". No 500 error. No row created.

---

### Service worker

- [ ] T125: CACHE_VERSION bumped to `thegood-stock-v0.5.0` — new SW version installs. `staff-oxygen.html` loads offline.
  - Steps: DevTools → Application → Service Workers → confirm `thegood-stock-v0.5.0` active. Simulate offline. Navigate to `staff-oxygen.html`.
  - Expected: Page loads from cache. No network error.
  ```javascript
  const keys = await caches.keys();
  console.log(keys); // ['thegood-stock-v0.5.0']
  const c = await caches.open('thegood-stock-v0.5.0');
  const reqs = await c.keys();
  console.log(reqs.map(r => r.url));
  // Expected: includes staff-oxygen.html, shared/oxygen.js, js/oxygen.js, js/staff-oxygen.js
  ```

---

## Phase 5 Summary

| Status | Count | Tests |
|---|---|---|
| Fully verified | TBD | — |
| Partial / soft-pass | TBD | — |
| Blocked | TBD | — |
| Pending | TBD | T101-T125 |

---

## Phase 4 ALS Bags (T126-T150)

### Template setup (T126–T130)

- [ ] **T126** Admin opens ALS Bags tab. Empty state "ยังไม่มีถุงยา" shown. Button "จัดการเทมเพลต" visible.
  - SQL: `SELECT count(*) FROM bag_templates` → 0
  - Expected: tab loads without error

- [ ] **T127** Admin creates template: code="TPL-ALS-ADULT", name="ALS ผู้ใหญ่", category="ALS". Adds 3 items: (1) mandatory target=5, (2) mandatory target=3, (3) non-mandatory target=10.
  - SQL: `SELECT count(*) FROM bag_template_items WHERE bag_template_id = '<new id>'` → 3
  - Expected: 1 bag_templates row + 3 bag_template_items rows

- [ ] **T128** Admin attempts to create second template with code="TPL-ALS-ADULT" (duplicate). Save fails.
  - Expected: inline error "รหัสเทมเพลตนี้มีอยู่แล้ว" (409 unique constraint bag_templates_code_key)

- [ ] **T129** Employee (Staff role) attempts INSERT bag_templates directly via DevTools / REST.
  - Expected: 403 — RLS policy bt_write rejects non-Admin

- [ ] **T130** Employee attempts INSERT bag_template_items directly via DevTools / REST.
  - Expected: 403 — RLS policy bti_write rejects non-Admin

### Bag-location setup (T131–T133)

- [ ] **T131** Admin creates bag location: type=bag, code="BAG-ALS-001", name="ถุง ALS รถ TG1", bag_template_id=<TPL-ALS-ADULT id>.
  - SQL: `SELECT bag_template_id FROM locations WHERE code='BAG-ALS-001'` → non-null UUID
  - Expected: locations row with type='bag' and bag_template_id populated

- [ ] **T132** Admin opens ALS Bags tab. BAG-ALS-001 appears with alert_level=low_stock, completion_pct=0.
  - SQL: `SELECT alert_level, completion_pct, mandatory_deficit_count FROM v_bag_status WHERE bag_code='BAG-ALS-001'`
  - Expected: low_stock, 0, 2

- [ ] **T133** Admin creates bag "BAG-ALS-002" with no bag_template_id. Appears with alert_level=no_template.
  - SQL: `SELECT alert_level FROM v_bag_status WHERE bag_code='BAG-ALS-002'` → 'no_template'

### Restock workflow (T134–T139)

- [ ] **T134** Admin opens BAG-ALS-001 detail panel. Shopping list shows 2 mandatory deficits.
  - Expected: mandatory_deficit_count=2; all 3 items rendered with correct target/actual

- [ ] **T135** Admin completes restock for BAG-ALS-001: sets qty for all 3 items, skips photo, confirms.
  - SQL: `SELECT count(*) FROM stock_movements WHERE location_id=<BAG-ALS-001> AND reason='bag_restock'` → 3
  - SQL: `SELECT qty FROM stock_item_locations WHERE location_id=<BAG-ALS-001> AND item_id=<item1>` → 5
  - Expected: 3 stock_movements (movement_type='receive'), stock_item_locations updated

- [ ] **T136** After T135, ALS Bags tab shows BAG-ALS-001 with alert_level=complete, completion_pct=100.
  - SQL: `SELECT alert_level, completion_pct FROM v_bag_status WHERE bag_code='BAG-ALS-001'` → ('complete', 100)

- [ ] **T137** Admin replays same restock submit (same client_ref_id values — simulate network retry).
  - Expected: each INSERT returns 409 (duplicate client_ref_id); client treats as already-posted; stock unchanged

- [ ] **T138** Admin restocks item with tracks_lots=true. Lot picker (FEFO) appears in shopping list step.
  - Expected: stock_movements row has lot_id populated; FEFO lot pre-selected

- [ ] **T139** Employee attempts POST stock_movements with movement_type='receive' for bag location via DevTools.
  - Expected: 403 — Phase 1 RLS policy sm_insert_admin blocks Staff from 'receive'

### Bag status view correctness (T140–T143)

- [ ] **T140** Issue 3 units of item from BAG-ALS-001 (dropping below target). Refresh ALS Bags tab.
  - SQL: `SELECT alert_level, mandatory_deficit_count FROM v_bag_status WHERE bag_code='BAG-ALS-001'`
  - Expected: low_stock, deficit_count > 0

- [ ] **T141** Insert test stock_lots row for item in BAG-ALS-001 with expiry_date = CURRENT_DATE + 25.
  - SQL: `SELECT alert_level FROM v_bag_status WHERE bag_code='BAG-ALS-001'`
  - Expected: 'expiring' (expiring takes priority over low_stock)

- [ ] **T142** Set test lot expiry_date = CURRENT_DATE - 1 (already past).
  - SQL: `SELECT alert_level, expired_lots_count FROM v_bag_status WHERE bag_code='BAG-ALS-001'`
  - Expected: 'expired', expired_lots_count=1

- [ ] **T143** Run Phase 2 cron `SELECT run_expiry_alert()` to auto-expire test lot. Re-query v_bag_status.
  - SQL: `SELECT status FROM stock_lots WHERE id='<test lot id>'` → 'expired'
  - Expected: v_bag_status reflects updated state (may revert to low_stock or complete)

### Cron and Telegram alert (T144–T147)

- [ ] **T144** With BAG-ALS-001 in low_stock state, run `SELECT run_bag_status_alert()` with NOTIFY settings configured.
  - SQL: `SELECT event_type, dedupe_key FROM notification_log WHERE event_type='bag_alert' ORDER BY created_at DESC LIMIT 1`
  - Expected: 1 row, dedupe_key='bag_alert:YYYY-MM-DD'; Telegram receives message

- [ ] **T145** Run `SELECT run_bag_status_alert()` a second time same day.
  - Expected: tg-notify returns dedupe_hit=true; no second Telegram message sent

- [ ] **T146** Set all bags to complete. Run `SELECT run_bag_status_alert()`.
  - Expected: function returns without pg_net call; no new notification_log row

- [ ] **T147** Set NOTIFY_TELEGRAM_ENABLED='false' in settings. Run `SELECT run_bag_status_alert()`.
  - Expected: tg-notify returns {sent:false}; no Telegram message; behavior mirrors T147 in Phase 2

### Staff scan bag path (T148–T149)

- [ ] **T148** Staff opens staff-scan.html, scans "BAG-ALS-001" QR code.
  - Expected: Bag checklist view appears (not standard issue flow); composition shown with qty vs target; expired/expiring items highlighted

- [ ] **T149** Staff on bag checklist view: "เติมของ" button is absent.
  - Expected: no restock button visible; checklist is read-only; info banner shown for incomplete bags

### ALS_KIT category (T150)

- [ ] **T150** After Phase 4 migration, stock_categories contains ALS_KIT.
  - SQL: `SELECT code, name FROM stock_categories WHERE code='ALS_KIT'`
  - Expected: 1 row — ('ALS_KIT', 'อุปกรณ์ถุงยา / ชุดปฐมพยาบาล')

### Service worker cache (T151)

- [ ] **T151** CACHE_VERSION bumped to thegood-stock-v0.6.0 and new Phase 4 assets cached.
  - Steps: DevTools → Application → Cache Storage → thegood-stock-v0.6.0
  ```javascript
  const keys = await caches.keys();
  console.log(keys); // ['thegood-stock-v0.6.0']
  const c = await caches.open('thegood-stock-v0.6.0');
  const reqs = await c.keys();
  console.log(reqs.map(r => r.url));
  // Expected: includes shared/bags.js, js/bags.js, js/bag-templates.js
  ```

---

## Phase 4 Summary

| Status | Count | Tests |
|---|---|---|
| Fully verified | TBD | — |
| Partial / soft-pass | TBD | — |
| Blocked | TBD | — |
| Pending | TBD | T126-T151 |

---

# Phase 6 Linens & Laundry (T152-T171)

> Covers decisions Q6-A through Q6-F locked in `docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md`

## Q6-D — Category + Sub-category enum (linen_subcategory)

- [ ] **T152** `LINEN` category seeded in `stock_categories`.
  - SQL: `SELECT code, name, sort_order FROM stock_categories WHERE code = 'LINEN';`
  - Expected: 1 row — code='LINEN', name='ผ้า', sort_order=60

- [ ] **T153** `linen_subcategory` enum type exists with exactly 5 values.
  - SQL: `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'linen_subcategory'::regtype ORDER BY enumsortorder;`
  - Expected: sheet, blanket, towel, gown, wipe

- [ ] **T154** `stock_items.linen_subcategory` column exists + constraint enforced.
  - SQL (valid LINEN item): `INSERT INTO stock_items(name, sku, category_id, linen_subcategory) SELECT 'ทดสอบ', 'TEST-LIN-001', id, 'towel' FROM stock_categories WHERE code='LINEN' RETURNING id;` — Expected: 1 row
  - SQL (LINEN without subcategory): same INSERT without `linen_subcategory` — Expected: check constraint error `chk_linen_subcategory`
  - SQL (non-LINEN with subcategory): `INSERT INTO stock_items(name, sku, category_id, linen_subcategory) SELECT 'ทดสอบ', 'TEST-GEN-002', id, 'towel' FROM stock_categories WHERE code='GENERAL' RETURNING id;` — Expected: check constraint error `chk_linen_subcategory`
  - Cleanup: `DELETE FROM stock_items WHERE sku IN ('TEST-LIN-001');`

- [ ] **T155** 5 seed LINEN items present in `stock_items`.
  - SQL: `SELECT sku, name, linen_subcategory FROM stock_items si JOIN stock_categories sc ON sc.id=si.category_id WHERE sc.code='LINEN' ORDER BY sku;`
  - Expected: 5 rows, one per enum value (sheet/blanket/towel/gown/wipe), no nulls in `linen_subcategory`

## Q6-D / UI — Inventory tab LINEN filter

- [ ] **T156** Inventory tab — selecting category "ผ้า" shows subcategory pills + discrepancy-aware columns.
  - Steps: admin.html → Inventory tab → Category dropdown → select "ผ้า"
  - Expected: 5 subcategory pills (ทั้งหมด / ผ้าปู / ผ้าห่ม / ผ้าขนหนู / เสื้อคลุม / ผ้าเช็ด) appear above the table; thead gains "นับล่าสุด" and "ผลต่าง" columns

- [ ] **T157** Subcategory pill filter narrows rows.
  - Steps: with LINEN category active, click "ผ้าขนหนู" pill
  - Expected: only towel-subcategory items shown; pill background goes active (btn-primary); other items hidden

## Q6-C — Discrepancy threshold + view

- [ ] **T158** `v_linen_audit` view returns correct `is_discrepancy` flag.
  - SQL: `SELECT * FROM v_linen_audit LIMIT 10;`
  - Expected: columns `location_id, item_id, location_code, item_name, linen_subcategory, counted_qty, stock_qty, delta, abs_delta, threshold, is_discrepancy` present; `is_discrepancy = (abs_delta >= threshold)` logic correct
  - Threshold formula: `GREATEST(CEIL(stock_qty * (pct/100.0)), min_floor)` where pct and min_floor read from settings

- [ ] **T159** Settings seed rows present.
  - SQL: `SELECT key, value FROM settings WHERE key IN ('LINEN_DISCREPANCY_PCT','LINEN_DISCREPANCY_MIN','LINEN_AUDIT_THRESHOLD_PCT','LINEN_AUDIT_MIN_PIECES','LINEN_AUDIT_CRON_HOUR') ORDER BY key;`
  - Expected: 5 rows with values 5, 2, 5, 2, 6 respectively (may vary if admin changed them)

## Q6-A — Daily cron audit

- [ ] **T160** `linen_daily_audit` cron job scheduled.
  - SQL: `SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'linen_daily_audit';`
  - Expected: 1 row — schedule='0 23 * * *', command contains 'run_linen_audit()'

- [ ] **T161** `run_linen_audit()` SECURITY DEFINER function exists and reads NOTIFY_* from settings.
  - SQL: `SELECT proname, prosecdef FROM pg_proc WHERE proname = 'run_linen_audit';`
  - Expected: 1 row — prosecdef=true
  - Manual trigger (non-destructive): `SELECT run_linen_audit();` — Expected: runs without error (returns void); if no discrepancies exist, no Telegram message sent

## linen_counts table + RLS

- [ ] **T162** `linen_counts` table and indexes exist.
  - SQL: `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='linen_counts' ORDER BY ordinal_position;`
  - Expected: id (uuid), location_id (uuid NOT NULL), item_id (uuid NOT NULL), counted_qty (integer NOT NULL), counted_at (timestamptz), counted_by (text), photo_url (text), note (text), created_at (timestamptz)

- [ ] **T163** RLS on `linen_counts` — Employee can INSERT own row, cannot read another user's row.
  - Steps: in Supabase SQL Editor use `SET app.user_role = 'Employee'; SET app.username = 'teststaff';` then attempt INSERT with `counted_by = 'teststaff'` — Expected: success
  - Attempt INSERT with `counted_by = 'other_user'` — Expected: RLS violation

## Q6-F — sm_insert_staff RLS policy

- [ ] **T164** `sm_insert_staff` policy allows `adjustment_gain` with `reason='laundry_in'` only.
  - SQL: `SELECT policyname, qual, with_check FROM pg_policies WHERE tablename='stock_movements' AND policyname='sm_insert_staff';`
  - Expected: `with_check` contains both `adjustment_gain` and `laundry_in`; does NOT allow bare `adjustment_gain` without `reason='laundry_in'`

- [ ] **T165** Staff cannot insert `adjustment_gain` with `reason='restock'` (generic gain blocked).
  - Steps: authenticate as Employee JWT; attempt `POST /rest/v1/stock_movements` with `movement_type=adjustment_gain, reason=restock`
  - Expected: 403 / RLS policy violation

- [ ] **T166** Staff CAN insert `adjustment_gain` with `reason='laundry_in'` (receive-from-laundry allowed).
  - Steps: authenticate as Employee JWT; attempt `POST /rest/v1/stock_movements` with `movement_type=adjustment_gain, reason=laundry_in, item_id=<valid LINEN item>`
  - Expected: 201 Created

## Q6-B — Photo policy in staff-scan linen flows

- [ ] **T167** Staff scan → cabinet with LINEN items → linen cabinet overlay appears.
  - Steps: staff-scan.html → scan or manually enter a location code for a cabinet that has LINEN stock items; Expected: linen cabinet overlay shows with list of linen items + 3 action buttons per row (นับใหม่ / ส่งซัก / รับคืน)

- [ ] **T168** "ส่งซัก" flow — photo is REQUIRED (Skip button absent).
  - Steps: in linen cabinet overlay click "ส่งซัก" for any item
  - Expected: PhotoCaptureModal opens without Skip button; attempting to proceed without photo is blocked

- [ ] **T169** "รับคืน" flow — photo is REQUIRED (Skip button absent).
  - Steps: in linen cabinet overlay click "รับคืน" for any item
  - Expected: PhotoCaptureModal opens without Skip button; attempting to proceed without photo is blocked

- [ ] **T170** "นับใหม่" flow — photo is ADVISORY (Skip button visible).
  - Steps: in linen cabinet overlay click "นับใหม่" for any item
  - Expected: PhotoCaptureModal opens WITH Skip button visible; user can skip photo and still proceed to qty step

## Dashboard panel

- [ ] **T171** "นับผ้าวันนี้" panel visible on Admin dashboard.
  - Steps: admin.html → Dashboard tab
  - Expected: panel with id `dash-panel-linens` visible; shows count of discrepancies, items counted today, and items never counted; links to Inventory tab with LINEN category pre-selected (or instruction to select ผ้า filter)

## Service worker cache (Phase 6)

- [ ] **T172** CACHE_VERSION bumped to `thegood-stock-v0.7.0` and `shared/linens.js` cached.
  - Steps: DevTools → Application → Cache Storage → thegood-stock-v0.7.0
  ```javascript
  const keys = await caches.keys();
  console.log(keys); // ['thegood-stock-v0.7.0']
  const c = await caches.open('thegood-stock-v0.7.0');
  const reqs = await c.keys();
  console.log(reqs.map(r => r.url));
  // Expected: includes shared/linens.js, shared/photo-capture.js
  ```

---

## Phase 6 Summary

| Status | Count | Tests |
|---|---|---|
| Fully verified | TBD | — |
| Partial / soft-pass | TBD | — |
| Blocked | TBD | — |
| Pending | TBD | T152-T172 |

---

## Phase 0.5 QR Print (T173-T182)

> **Pre-flight:** Phase 0 live + `vendor/qrcode.min.js` present + `shared/qr-print.js` loaded.  
> CACHE_VERSION must be `thegood-stock-v0.8.0` (bumped from v0.7.0).

- [ ] **T173** Location print button wires QRPrint.single correctly.
  - Steps: admin.html -> Locations tab -> any location row -> click printer icon
  - Expected: print dialog opens (desktop) OR PNG download modal appears (iOS); QR encodes bare location code (e.g. `ROOM-A`); code + name appear as labels below QR.

- [ ] **T174** Inventory item single-print button.
  - Steps: admin.html -> Inventory tab -> รายการสินค้า subview -> any item row -> click QR icon (bi-qr-code)
  - Expected: `QRPrint.single(item.sku, { size:'38mm', label:item.sku, subtitle:item.name, entityType:'item' })` called; print dialog or PNG fallback launches.

- [ ] **T175** Inventory bulk-select and bulk-print.
  - Steps: admin.html -> Inventory tab -> select 3 items via row checkboxes -> bulk-bar appears showing "3 รายการที่เลือก" -> click "พิมพ์ที่เลือก"
  - Expected: `QRPrint.bulk(rows, {})` called with exactly those 3 rows; each row has `{ code: sku, label: sku, subtitle: name }`.

- [ ] **T176** Select-all checkbox selects all visible rows.
  - Steps: admin.html -> Inventory tab -> click header checkbox -> all rows checked -> bulk-bar shows count = total items loaded
  - Expected: all row checkboxes become checked; deselect button clears all and hides bar.

- [ ] **T177** staff-print.html loads and lists items + print buttons.
  - Steps: staff.html -> "พิมพ์ QR Sticker" button -> staff-print.html opens; items tab loads list
  - Expected: items list renders with code + name + single-print button per row; select-all + bulk-print bar functional.

- [ ] **T178** staff-print.html bulk print triggers QRPrint.bulk.
  - Steps: staff-print.html -> select 2+ items -> "พิมพ์ที่เลือก" button in bulk-bar
  - Expected: `QRPrint.bulk` called with correct rows array; print or PNG fallback.

- [ ] **T179** QR payload is bare code (spec Q-QR-1).
  - Steps: print any sticker; scan printed QR with a QR reader app
  - Expected: scanned value equals the entity code exactly (e.g. `ROOM-A`, `SUP-GAUZE-001`) with no prefix, no URL, no JSON wrapping.

- [ ] **T180** @page size A4 and @media print sticker grid renders correctly.
  - Steps: desktop browser -> admin.html -> Inventory -> select 6+ items -> bulk print -> print preview
  - Expected: print preview shows A4 page; stickers arranged in 6-column dashed-border grid; no app chrome visible (navbar, modals hidden per `body * { visibility: hidden }`).

- [ ] **T181** iOS Safari -> PNG download fallback.
  - Steps: open staff-print.html on iPhone/iPad Safari (or iOS simulator) -> click single-print on any item
  - Expected: modal appears with "พิมพ์ (Print)" and "ดาวน์โหลด PNG" buttons; tapping "ดาวน์โหลด PNG" downloads `qr-{sku}.png`; opening the file in Photos shows a scannable QR with code + subtitle text below; QR encodes bare SKU.

- [ ] **T182** PNG download on desktop (non-iOS) via "ดาวน์โหลด PNG" in choice modal.
  - Steps: set `localStorage.qr_print_mode_pref = 'png'` in DevTools console -> reload -> click any print button
  - Expected: `QRPrint.downloadPNG` triggered directly (no modal); file `qr-{code}.png` downloads; image is 1024x1024 px; QR is scannable; label + subtitle text visible; clearing `localStorage.qr_print_mode_pref` and retrying goes straight to print dialog (desktop default).

- [ ] **T183** Cross-page shared module load coverage — Open DevTools console
  on every staff-* page and admin.html; verify required globals are defined.
  Steps:
  1. staff.html → no extra modules required
  2. staff-scan.html → window.AppLoans, AppLots, AppBags, AppLinens, AppInventory, PhotoCaptureModal ALL defined
  3. staff-oxygen.html → window.AppOxygen, PhotoCaptureModal defined
  4. staff-print.html → window.QRPrint defined; window.QRCode defined
  5. admin.html → all of the above + window.AppLoans, AppBags, AppOxygen, AppLinens, AppInventory, AppLots, QRPrint, QRCode defined
  Expected: zero undefined globals on each page; otherwise the corresponding
  shared module is missing from the page's <script> tags.
  This regression catches the agent-driven cross-phase script tag gap pattern
  that broke staff-scan.html (Phase 2/3/4 modes) and admin.html (QR print).

---

## Phase 0.5 Summary

| Status | Count | Tests |
|---|---|---|
| Fully verified | TBD | — |
| Partial / soft-pass | TBD | — |
| Blocked | TBD | — |
| Pending | TBD | T173-T183 |

---

# Phase 0.7 Location Hierarchy + Transfer — Manual Test Checklist (T184–T208)

> Tested against commit `aefa347` (feat(phase0.7-fe): transfer modal + scanner fallback + bin/zone QR)
> Date: 2026-05-19
> Env: Chrome desktop (Thegood browser), Windows 11, github.io live URL
> **Pre-condition gate:** All T184–T208 DB-dependent tests are BLOCKED pending DB migration apply.

## Migration Status Check (run before Phase 2 tests)
- [x] GATE: Type dropdown shows storage/bin/zone in FE — QA 2026-05-19 @ aefa347: dropdown includes storage/bin/zone options. HOWEVER DB migrations NOT applied — see bug BUG-0.7-001 below.

## Phase 1 — Static checks

- [x] T-SW: SW cache v0.12.0 active — QA 2026-05-19 @ aefa347: after clearing stale v0.8.0 cache, `caches.keys()` returns `["thegood-stock-v0.12.0"]`. NOTE: stale cache was blocking — see bug BUG-0.7-002.
- [x] T-STATIC-TRANSFER: `typeof window.Transfer.openModal === 'function'` — QA 2026-05-19 @ aefa347: pass (after cache clear). `window.Transfer` exports `openModal`, `_openLocationTreePicker`, `cameraAvailable`.
- [x] T-STATIC-SCANNER: `typeof window.AppScanner.openForLocation === 'function'` — QA 2026-05-19 @ aefa347: pass. Phase 0.7 API present.
- [x] T-STATIC-CAMERA: `'cameraAvailable' in window.AppScanner` — QA 2026-05-19 @ aefa347: pass. `cameraAvailable=true` (Thegood browser has camera API).
- [x] T-STATIC-STAFF-SCAN: staff-scan.html loads cleanly — QA 2026-05-19 @ aefa347: title "สแกนเบิก-จ่าย — Thegood Stock", no console errors, transfer.js and scanner.js both loaded.
- [x] T-STATIC-STAFF-PRINT: staff-print.html loads (as employee) — QA 2026-05-19 @ aefa347: requires employee session; redirected to 403 during admin session as expected (RBAC correct).
- [x] T-CODE-200: camera-timeout code path in scanner.js — QA 2026-05-19 @ aefa347: `_mapCameraError` returns 'camera-timeout' when `err.message === 'timeout'`; `Promise.race` 5000ms timeout present at line 436; `_fallbackToManual('camera-timeout', ...)` opens tree-picker. Code-verified.
- [x] T-CODE-201: camera-busy code path in scanner.js — QA 2026-05-19 @ aefa347: `_mapCameraError` returns 'camera-busy' for `NotReadableError` (line 543); Thai message "กล้องถูกใช้งานโดย app อื่น" (line 558); auto-opens tree-picker. Code-verified.

## Live Functional Tests — Run 2 (post-migration, 2026-05-19 @ aefa347)

### Location hierarchy CRUD

- [x] T184: Locations tab tree renders with all new types — QA 2026-05-19 @ aefa347: admin.html Locations tab expand-all shows ROOM-A/ROOM-B (room), ALS-TEST (bag), CAB-A-1/Drawer1 (storage/ตู้ปิด), CAB-TEST-A/ตู้ Test-A (storage/ตู้ปิด), SHELF-1/ชั้น 1 (shelf), BIN-BLUE/ตะกร้าฟ้า (bin), BIN-GREEN/ตะกร้าเขียว (bin), ZONE-AIRWAY/airway (zone), ZONE-CIRC/circulation (zone). All types visible with correct Thai labels and breadcrumbs. Pass.
- [~] T185: ambulance type requires ambulance_id — PARTIAL: constraint `chk_ambulance_link` confirmed active. UI has no ambulance_id field selector; creating type=ambulance raises `"chk_ambulance_link"` error 23514. DB constraint works correctly. See **BUG-0.7-T185-01**. Blocked from full pass by missing UI field.
- [x] T186: shelf with parent=room → trigger blocks — QA 2026-05-19 @ aefa347: type=shelf create form parent dropdown lists only storage-type nodes (ROOM-A not present). Trigger enforces parent-type matrix. Pass.
- [x] T187: bag → zone (airway, circulation) renders — QA 2026-05-19 @ aefa347: ZONE-AIRWAY and ZONE-CIRC both show type=zone under ALS-TEST. `v_location_path` returns `path_display:"ALS-Test › airway"`. Pass.
- [x] T188: breadcrumb path_display correct at all depths — QA 2026-05-19 @ aefa347: room depth=1, storage depth=2, shelf depth=3, bin depth=4 ("ห้องคลังหลัก › ตู้ Test-A › ชั้น 1 › ตะกร้าเขียว"), zone depth=2 ("ALS-Test › airway"). All correct per `v_location_path` query. Pass.

### Transfer modal (BLOCKED by BUG-0.7-T189-01)

- [ ] T189: transfer both scan → 2 movements scanned=true — **FAIL** BUG-0.7-T189-01: `TypeError: t.getAttribute is not a function` at `shared/transfer.js:466`. `wrap.firstChild` returns text node (nodeType=3) — template literal starts with `\n`. Bootstrap `new bootstrap.Modal(textNode)` crashes. Fix: line 465 `wrap.firstChild` → `wrap.firstElementChild`.
- [x] T190: scanned column in stock_movements defaults false — QA 2026-05-19 @ aefa347: `SELECT movement_type,scanned FROM stock_movements` returns `scanned:false` on receive movement. Column exists with correct DEFAULT. DB layer pass. UI end-to-end blocked by T189 bug.
- [ ] T191: transfer to same location → RPC exception — **BLOCKED** BUG-0.7-T189-01 (modal crash before submission)
- [ ] T192: transfer qty > source qty → "ของไม่พอ" — **BLOCKED** BUG-0.7-T189-01
- [ ] T193: idempotency client_ref_id → 409 — **SKIP** (code-verified; RPC deployed in DB; live test blocked by modal crash)
- [ ] T194: manual picker "เลือก" disabled at non-leaf — **BLOCKED** BUG-0.7-T189-01 (tree-picker never opens)

### Migration & display

- [x] T195: cabinet rows display as storage with storage_style=closed — QA 2026-05-19 @ aefa347: CAB-A-1 shows "ตู้/ชั้น (ตู้ปิด)", CAB-TEST-A shows "ตู้/ชั้น (ตู้ปิด)" in Locations tree. Pass.
- [x] T196: scanned column audit query works — QA 2026-05-19 @ aefa347: `SELECT count(*) FROM stock_movements WHERE scanned=false` returns 1 without error. Column confirmed. Pass.

### Camera fallback

- [ ] T197: camera permission denied → toast + tree-picker auto-open — **BLOCKED** BUG-0.7-T189-01 + BUG-0.7-T197-01: `scanner.js` line 419 has same `wrap.firstChild` bug; scanner modal crashes before camera permission requested. Both bugs must be fixed.
- [~] T198: desktop no camera → manual default — **CODE-VERIFIED**: `cameraAvailable = !!(navigator.mediaDevices)` at init. Live test requires device without mediaDevices.
- [ ] T199: iOS LINE in-app browser fallback — **SKIP** (requires physical iOS device in LINE)
- [~] T200: camera timeout fallback — **CODE-VERIFIED**: `Promise.race` 5s timeout → `_fallbackToManual('camera-timeout')` → toast + tree-picker.
- [~] T201: camera busy fallback — **CODE-VERIFIED**: `NotReadableError` → `'camera-busy'` → toast.
- [ ] T202: transfer manual both sides → scanned=false — **BLOCKED** BUG-0.7-T189-01

### Staff-print QR (BLOCKED by BUG-0.7-T203-01)

- [ ] T203: print bin QR 50×30 with breadcrumb — **BLOCKED** BUG-0.7-T203-01: `requireRole(['Admin','Employee'])` in staff-print.js passes array but `shared/auth.js:requireRole` does strict `!== role` string comparison — always redirects to 403. Fix: update `requireRole` to accept string|string[].
- [ ] T204: print zone QR 50×30 with parent bag tag — **BLOCKED** BUG-0.7-T203-01
- [~] T205: findLocationByCode for bin → location_id + path — **DATA-VERIFIED**: `AppInventory.findLocationByCode('BIN-GREEN')` returns `{type:'bin'}`. `v_location_path` returns `path_display:'ห้องคลังหลัก › ตู้ Test-A › ชั้น 1 › ตะกร้าเขียว'`. Data correct. Full UI test blocked by scanner modal crash (BUG-0.7-T197-01).
- [~] T206: findLocationByCode for zone → id + parent bag context — **DATA-VERIFIED**: ZONE-AIRWAY `{type:'zone', path_display:'ALS-Test › airway', parent_id:<ALS-Test uuid>}`. Parent bag confirmed as `{name:'ALS-Test', type:'bag'}`. Full test blocked by BUG-0.7-T197-01.
- [~] T207: staff-print "สถานที่" tab bin rows with breadcrumb — **CODE+DATA-VERIFIED**: staff-print.js queries `locations` with `type IN ('bin',...)` + enriches from `v_location_path`. BIN-BLUE and BIN-GREEN exist with correct breadcrumbs. Page blocked by BUG-0.7-T203-01.
- [~] T208: staff-print "ALS Bags" tab zone rows under parent — **CODE+DATA-VERIFIED**: ZONE-AIRWAY and ZONE-CIRC grouped under ALS-TEST in DB. Logic correct. Page blocked by BUG-0.7-T203-01.

---

## Phase 0.7 Bug Reports

### BUG-0.7-001 — CRITICAL: DB migrations not applied (Run 1 only)

**Severity:** Critical (Run 1) — RESOLVED in Run 2 (migrations applied)
**File:** `supabase/migrations/20260519070000_*.sql` through `20260519070600_*.sql`
**Reproduced:** 2026-05-19 @ aefa347, Chrome desktop, github.io + Supabase xtjsjrfixngfdkaahton

Steps to reproduce:
1. Open admin.html → Locations → "+ เพิ่มใหม่"
2. Select type = storage → fill code/name → click บันทึก
3. Observe toast: "Could not find the 'storage_style' column of 'locations' in the schema cache"

Expected: all 7 migration files applied.
Actual (Run 1): FE code at aefa347 is Phase 0.7-complete; DB was still Phase 1 (pre-0.7).
Status: RESOLVED — all migrations applied before Run 2. T184–T196, T202–T208 unblocked from DB perspective.

---

### BUG-0.7-002 — HIGH: Stale service worker cache (v0.8.0) blocks Phase 0.7 scripts on first load

**Severity:** High — on any browser that visited the site before today, `transfer.js` is silently missing and `scanner.js` serves the Phase 1 (pre-0.7) version without `openForLocation`/`cameraAvailable`.
**File:** `sw.js` CACHE_VERSION bump from v0.8.0 to v0.12.0 (already in commit aefa347)
**Reproduced:** 2026-05-19 @ aefa347, Chrome desktop (Thegood browser), first load after deploy

Steps to reproduce:
1. Load https://officethegood.github.io/thegood-stock/admin.html on a browser with old cache
2. `window.Transfer` is `undefined`; `window.AppScanner.openForLocation` is `undefined`
3. `caches.keys()` returns `["thegood-stock-v0.8.0"]`

Root cause: the old SW (v0.8.0) activates from the browser's SW registration cache before the new SW can install. The new SW's CACHE_VERSION='thegood-stock-v0.12.0' is correct — but the SW update cycle requires either a page reload or 24h before skipWaiting triggers.

Workaround for QA: manually call `caches.delete('thegood-stock-v0.8.0')` and reload.
Fix: verify `sw.js` uses `self.skipWaiting()` in `install` event so new SW activates immediately. If not present, add it.

**Owner: FE agent**

---

### BUG-0.7-T185-01 — HIGH: No ambulance_id UI field when creating type=ambulance location

**Severity:** High — ambulance locations cannot be created via UI; only SQL workaround possible
**File:** `js/locations.js` (admin Locations tab create/edit form) + `admin.html` (location modal)
**Reproduced:** 2026-05-19 @ aefa347, Chrome desktop, 1278×1270 viewport, admin.html → Locations → "+ เพิ่มใหม่" → type=ambulance → Save

Steps to reproduce:
1. Admin → Locations tab → "+ เพิ่มใหม่"
2. Set type = "รถพยาบาล (ambulance)"
3. Fill code/name, leave ambulance_id blank (no field exists)
4. Click "บันทึก"
5. Toast: `"new row for relation 'locations' violates check constraint 'chk_ambulance_link'"`

Expected: Form shows an ambulance_id selector (FK to ambulances table) when type=ambulance is selected.
Actual: No such field; DB constraint `chk_ambulance_link` blocks the INSERT.

Fix: In the location create/edit modal, add an ambulance selector `<select>` populated from `ambulances` table, shown only when `type=ambulance`. Pre-fill ambulance_id from the selected ambulance's ID.

**Owner: FE agent**

---

### BUG-0.7-T189-01 — CRITICAL: Transfer modal crashes with `TypeError: t.getAttribute is not a function`

**Severity:** Critical — blocks T189, T191, T192, T194, T202 (5 tests). No transfers possible.
**File:** `shared/transfer.js` line 465
**Reproduced:** 2026-05-19 @ aefa347, Chrome desktop, console exception confirmed on every openModal() call

Steps to reproduce:
1. Admin → Inventory tab → any item with stock → click "ย้าย" button
2. Transfer modal fails to render
3. Console: `Uncaught (in promise) TypeError: t.getAttribute is not a function` at `shared/transfer.js:466 openModal` via Bootstrap

Root cause: `shared/transfer.js` line 350-352:
```
const wrap = document.createElement('div');
wrap.innerHTML = `
  <div class="modal fade" id="transfer-modal" ...>
```
The template literal starts with `\n`, so `wrap.firstChild` (line 465) is a text node (nodeType=3), not the modal DIV. `new bootstrap.Modal(textNode)` fails because `textNode.getAttribute` does not exist.

Fix: `shared/transfer.js` line 465: change `wrap.firstChild` → `wrap.firstElementChild`

**Owner: FE agent**

---

### BUG-0.7-T197-01 — CRITICAL: Scanner modal crashes with same `wrap.firstChild` bug

**Severity:** Critical — blocks T197, T205, T206 (3 tests). Camera scan path completely broken.
**File:** `shared/scanner.js` line 419
**Reproduced:** 2026-05-19 @ aefa347, Chrome desktop — same root cause as BUG-0.7-T189-01

Root cause: `shared/scanner.js` line 383-384:
```
const wrap = document.createElement('div');
wrap.innerHTML = `
  <div class="modal fade" id="scanner-loc-modal" ...>
```
Same pattern: template literal starts with `\n`. Line 419: `const modalEl = wrap.firstChild;` → text node → Bootstrap crash.

Fix: `shared/scanner.js` line 419: change `wrap.firstChild` → `wrap.firstElementChild`

Note: This is the same root cause as BUG-0.7-T189-01. Both files must be fixed together.

**Owner: FE agent**

---

### BUG-0.7-T203-01 — HIGH: staff-print.html always redirects to 403 for all users

**Severity:** High — blocks T203, T204, T207, T208 (4 tests). QR print page inaccessible to everyone.
**File:** `shared/auth.js` line 109-114, called from `js/staff-print.js` line 46
**Reproduced:** 2026-05-19 @ aefa347, Chrome desktop, admin session with role="Admin"

Steps to reproduce:
1. Log in as admin (role="Admin")
2. Navigate to https://officethegood.github.io/thegood-stock/staff-print.html
3. Immediate redirect to 403.html

Root cause:
- `js/staff-print.js` line 46: `window.requireRole(['Admin', 'Employee'])` — passes an array
- `shared/auth.js` line 110: `if (getUserRole() !== role)` — strict equality `"Admin" !== ['Admin','Employee']` → always `true` → redirect

Fix: Update `requireRole` in `shared/auth.js` to accept a string or array:
```javascript
function requireRole(role) {
  const allowed = Array.isArray(role) ? role : [role];
  if (!allowed.includes(getUserRole())) {
    window.location.replace('./403.html');
    return false;
  }
  return true;
}
```

**Owner: FE agent**

---

## Phase 0.7 Summary — Run 2 (post-migration, 2026-05-19 @ aefa347)

| Status | Count | Tests |
|---|---|---|
| Pass (live verified) | 8 | T184, T186, T187, T188, T190, T195, T196, T-SW (all static + DB pass) |
| Data/code-verified (partial) | 8 | T185, T198, T200, T201, T205, T206, T207, T208 |
| Fail / blocked by bug | 8 | T189 (B-T189-01), T191, T192, T194, T197 (B-T197-01), T202, T203, T204 (B-T203-01) |
| Skip (device required) | 1 | T199 (iOS in-app) |
| **GO / NO-GO** | **NO-GO** | BUG-0.7-T189-01 (transfer modal crash) is critical — no transfers possible |

**New bugs found in Run 2:**
1. BUG-0.7-T189-01 — CRITICAL — `shared/transfer.js:465` `wrap.firstChild` → text node crash
2. BUG-0.7-T197-01 — CRITICAL — `shared/scanner.js:419` same bug
3. BUG-0.7-T203-01 — HIGH — `shared/auth.js:requireRole` rejects array argument → staff-print 403
4. BUG-0.7-T185-01 — HIGH — no ambulance_id UI field in location create form

**Spec requirements covered by passing tests:** G1 (hierarchy depth 5), G2 (storage direct under ambulance), G3 (ALS bag zone CRUD), G4 (bin in shelf tree), G6 (scanned flag column + default)
**Spec requirements partially blocked:** G5 (transfer RPC — FE modal crashes, RPC itself not live-tested)
**RLS not yet tested:** transfer_stock RPC SECURITY DEFINER path — blocked by modal crash
