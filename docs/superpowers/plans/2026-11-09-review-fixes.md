# Review Fixes (Gemini + Codex + agents, 2026-11-08/09) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** แก้ปัญหาที่รีวิวอิสระ 3 ชุด (Antigravity/Gemini 18 ข้อ, agent ยืนยัน 3 ตัว, Codex ยืนยันซ้ำ) ยืนยันแล้วว่าจริง ให้หน้างานไม่เจอข้อมูลหลอก ทางตัน หรือยอดเพี้ยนจากเส้นทางเหล่านี้อีก

**Architecture:** แบ่ง 3 ระยะตามความเสี่ยงและคนที่ต้องลงมือ — **A** แก้หน้าเว็บอย่างเดียว (push = ขึ้นจริง), **B** migration ที่ Pex ต้อง paste ใน Dashboard + FE ที่คู่กัน, **C** งานที่ต้องให้ Pex ตัดสินวิธีก่อน. ทุกการเปลี่ยน trigger/RPC สต็อกพิสูจน์ด้วย `bash tests/db/run.sh` (PG ทิ้งได้ + migration จริง) และทุกการเปลี่ยน FE พิสูจน์ใน browser pane ด้วย harness ที่ stub แค่ Supabase client

**Tech Stack:** vanilla JS + Bootstrap 5 (ไม่มี build), Supabase Postgres (Dashboard-only), PG17 local สำหรับเทสต์, GitHub Actions `.github/workflows/tests.yml`

**Spec:** ไม่มี spec แยก — แหล่งที่มาคือผลรีวิว: `agy_review_clean.md` (scratchpad session 2026-11-08), สรุปยืนยันใน memory `project-log.md` หัวข้อ 2026-11-08, และผล Codex 2026-11-09 (สรุปไว้ในตาราง "ที่มา" ด้านล่าง)

## ที่มา: ข้อไหนจริง (ใช้ตัดสินขอบเขต)

| # | เรื่อง | ผลยืนยัน | อยู่ใน Task |
|---|---|---|---|
| 1 | Restock กระเป๋าบันทึกเป็น `receive` → ยอดนับซ้ำเมื่อหยิบจากคลัง, retry ได้ client_ref ใหม่ | จริง (ออกแบบไว้ แต่ audit จับไม่ได้) | C1 |
| 2 | ผ้า 2 ช่องทาง (ตู้ = loss/gain, ปุ่มลัด = transfer) + รับคืนบางส่วนตัดเป็น "หาย" | จริงบางส่วน | C2 |
| 3 | คืนของยืมปิด loan ล่าสุด ไม่ใช่ที่เลือก | **จริง** | B1 |
| 4 | คืนเข้าล็อตที่ถูกเรียกคืน (recalled) | บางส่วน | C4 |
| 5 | ลบตำแหน่ง: FK error อังกฤษ / ลบ movement ทิ้งทำ lot ≠ ledger | จริงบางส่วน | B4 |
| 6 | ป้ายหมดอายุในตารางล็อตกระเป๋า + restock picker ไม่ขึ้น | **จริง** | A2 |
| 7 | % ครบกระเป๋า: ของเกินชดเชยของขาด, ของหมดอายุนับว่าครบ, ป้ายหมดอายุบังป้ายขาด | **จริง** | B3 |
| 8 | เทมเพลตมีแต่รายการไม่บังคับ → staff ขึ้น "ว่าง" | บางส่วน | C4 |
| 9 | ช่องค้นของแสดง 5 สินค้า ไม่บอกว่าตัด | **จริง** | A6 |
| 10 | ล้างตำแหน่งแล้วยังเหลือล็อตบวก/ลบที่หักล้างกัน | จริง (ต้องมี drift เดิม) | C3 |
| 11 | ปิดหน้าเลือกโซน / "กลับไปสแกน" → กล้องหยุด/สแกนไม่ติด | **จริง** | A3 |
| 12 | ล็อตหมดอายุแต่ status ยัง active ตอนเช้า + error 'lot_id is required' อังกฤษ | บางส่วน | A8 + P0-2 |
| 13 | ย้ายของยิงแจ้ง "ของใกล้หมด" หลอก + dedupe กลืนแจ้งจริงวันนั้น | **จริง** | B2 |
| 14 | note `laundry_out` ค้างในฟอร์มรับเข้าเมื่อสลับสินค้า | **จริง** (Low) | A7 |
| 15 | ถัง O2 เข้าซ่อม/ปลดระวางไม่ได้จากทุกหน้าจอ | **จริง (ความปลอดภัย)** | A1 |
| 16 | ตู้ที่เคยมีผ้า (แม้ยอด 0) บล็อกเบิกของอื่นใน staff-scan | **จริง** | A4 |
| 17 | ของไม่ผูกล็อตติดค้างหลังเปิด tracks_lots | จริงบางส่วน (มีทางอ้อม) | C3 |
| 18 | ปุ่มสแกน QR ใน modal ย้ายของอ่านป้ายที่พิมพ์ไม่ได้ (รับแค่ `location:<uuid>`) | **จริง** | A5 |
| T1 | Telegram "คืนกระเป๋า · BAG-ALS-004 → ?" เมื่อกระเป๋าไม่มีที่เก็บประจำ | จริง (ข้อความ) | B5 |
| T2 | Audit ทุกเช้า: IV Set `SUP-VAS-IVSET-20D @ ZN-007` ล็อต 4240701 = -1 | ข้อมูลเก่า ก่อน guard 5 พ.ย. (Codex: ไม่มีข้อไหนใน 18 ข้อสร้างใหม่ได้ผ่าน guard) | P0-1 |

## Global Constraints

- Migration: append-only, ชื่อ `supabase/migrations/2026110901xxxx_<name>.sql`, idempotent (`CREATE OR REPLACE`, `DROP ... IF EXISTS`), **บรรทัดสุดท้ายเป็น SELECT go/no-go** (SQL Editor โชว์แค่ผล statement สุดท้าย)
- **ห้าม copy body function จาก migration เก่า** — ต้องเริ่มจากเวอร์ชันล่าสุด: `close_loan_from_return` + `validate_borrow_movement` → `20260715031000`, `guard_return_qty` → `20261105040000`, `check_low_stock` → `20260518010500`, `rpc_delete_location` → `20260524000000`, `v_bag_status` → `20261106010000`, `notify_bag_move_to_tg` → `20260705010000`, `check_lot_status` → `20260715034000`
- ทุก migration ใหม่ที่ redefine function สต็อก → เพิ่มชื่อไฟล์ใน loop ที่สองของ `tests/db/run.sh` และเพิ่มเคสใน `tests/db/` (ไฟล์ใหม่ `tests/db/review_fixes_test.sql`, เรียกต่อท้าย `run.sh`)
- FE ทุกครั้ง: bump `CACHE_VERSION` ใน `sw.js` (ตอนนี้ `thegood-stock-v0.20.48` → v0.20.49 สำหรับ A, v0.20.50 สำหรับ B, …) และ `node --check` ทุกไฟล์ JS ที่แก้
- ข้อความหน้าจอเป็นภาษาไทย; error จาก DB ที่ขึ้นหน้าจอต้องเป็นไทย
- Pex เป็นคน apply SQL บน Dashboard เท่านั้น; commit/push เฉพาะเมื่อ Pex สั่ง
- ลำดับ deploy ของ B: **apply migration ก่อน แล้วค่อย push FE** (FE ใหม่ส่ง field ที่ DB เก่าไม่รู้จักได้ แต่ต้องไม่พังถ้า DB ยังเก่า — ดู B1)
- Browser verify: harness HTML ใน worktree ที่โหลด JS จริง + stub `getSupabaseClient` (แบบ `make_harness2.py` เดิม), serve ผ่าน `.claude/launch.json`, **unregister service worker + clear caches ก่อนดู**, ลบ harness/launch.json ทิ้งก่อน commit

## Review Focus

1. **เครื่อง staff ที่ยังรัน FE cache เก่า** หลัง apply migration B1 — return ที่ไม่ส่ง `source_movement_id` ต้องยังทำงานแบบเดิม (fallback loan ล่าสุด) ไม่ใช่ error → เทสต์ใน B1 Step 1 (`return_without_source_falls_back`)
2. **ยืม 2 ครั้ง ล็อตต่างกัน คืนรายการเก่า** — ล็อตที่คืนต้องเป็นล็อตของ loan ที่เลือก ไม่ใช่ของ loan ล่าสุด → เทสต์ใน B1 (`return_older_loan_uses_its_lot`)
3. **กระเป๋าที่มีของหมดอายุ *และ* ขาดของบังคับ** — staff ต้องเห็นทั้งสองเรื่อง → B3 Step 6 (browser) + เทสต์ SQL `bag_expired_and_short_reports_deficit`
4. **ตู้ storage ที่มีทั้งผ้าและของอื่น** — สแกนผ้าต้องยังเข้าหน้าผ้า (ไม่ทำ flow ผ้าพัง) → A4 Step 2 มีทั้งสองกรณี
5. **ป้าย QR รูปแบบเก่า `LOC:<code>` และรหัสเปล่า** ใน modal ย้ายของ ต้องหาเจอทั้งคู่ และ QR สินค้าต้องไม่ถูกตีความเป็นตำแหน่ง → A5 Step 1 มี 3 กรณี

---

## Phase 0 — ข้อมูล / คำถามที่ต้องได้จาก Pex (ไม่ใช่โค้ด)

### P0-1: ซ่อม IV Set @ ZN-007 (audit เตือนทุกเช้า)
- [ ] รอคุณ Chittawan นับ IV Set ใน ZN-007 (ALS Bag 1) **แยกตามเลขล็อต** (คาด 4260101 / 4260501) + ยืนยันว่าล็อต 4240701 อยู่ที่ ALS Box 1 ชั้น 2 กี่ชิ้น
- [ ] เขียน `sql/repair-ivset-zn007-2026110x.sql` แบบเดียวกับ `sql/repair-lot-drift-20261105.sql` (movement คู่ชดเชย `adjustment_gain`/`adjustment_loss` พร้อม note, หยุดเองถ้ารันซ้ำ, จบด้วย SELECT จาก `v_stock_audit_issues` ที่ต้องได้ 0 แถว) — ทดสอบบน replay ใน PG ทิ้งได้ก่อนส่ง
- [ ] ส่งไฟล์ด้วย SendUserFile ให้ Pex รัน; หลังรัน เช้าถัดไป audit ต้องเงียบ

### P0-2: timezone ของ DB (ข้อ 12)
- [ ] ขอ Pex รัน `SHOW timezone;` — ถ้า `UTC`: เพิ่ม Task B6 (เลื่อน cron อัปเดตสถานะล็อตหมดอายุให้รันหลัง 00:00 BKK = `5 17 * * *` UTC) — ถ้าเป็น `Asia/Bangkok` ข้ามได้

---

## Phase A — แก้หน้าเว็บอย่างเดียว (FE v0.20.49)

### Task A1: ถัง O2 ส่งซ่อม / ปลดระวางได้ (ข้อ 15)

**Files:**
- Modify: `shared/oxygen.js:31-39` (`ALLOWED_TRANSITIONS`), `shared/oxygen.js:~391` (`getAllowedTransitions`)
- Check: `js/oxygen.js:864-928` (modal เปลี่ยนสถานะ + คำเตือนปลดระวางที่มีอยู่แล้ว), `js/staff-oxygen.js:312`

**Interfaces:**
- Produces: `AppOxygen.getAllowedTransitions(status: string|null, role: 'Admin'|'Employee') -> string[]` — Admin ได้ `maintenance` และ `retired` เพิ่มจากทุกสถานะที่ไม่ใช่ `retired`; Employee ไม่ได้

- [ ] **Step 1:** เปิด harness ฝั่ง admin O2 (stub ถังสถานะ `ready` ที่มีประวัติ) → ยืนยันว่าตอนนี้ dropdown ไม่มี "ส่งซ่อม"/"ปลดระวาง" (สภาพก่อนแก้)
- [ ] **Step 2:** ให้ `getAllowedTransitions` ต่อท้าย `['maintenance','retired']` เมื่อ role = Admin และ status ≠ `retired` (ไม่แตะตาราง staff); trigger ล่าสุด `20261105050000:77-83` อนุญาตอยู่แล้ว ไม่ต้องมี migration
- [ ] **Step 3:** browser: Admin เห็น 2 ตัวเลือกใหม่, เลือก "ปลดระวาง" ขึ้นคำเตือนเดิมที่ `js/oxygen.js:914-928`, stub rpc ถูกเรียกด้วย `to_status='retired'`; staff-oxygen ในบทบาท Employee ไม่เห็น
- [ ] **Step 4:** `node --check shared/oxygen.js` → commit `fix(oxygen): admin can send a tank to maintenance or retire it`

### Task A2: ป้ายหมดอายุในตารางล็อตกระเป๋า + restock (ข้อ 6)

**Files:** Modify `js/bags.js:564-572`, `js/bags.js:751-762`

**Interfaces:**
- Consumes: `AppLots.getLotBadge(lot: {expiry_date, status, current_qty}) -> {badgeClass, label, daysLeft}` (`shared/lots.js:308`)

- [ ] **Step 1:** browser harness admin bags: stub `v_bag_lot_contents` 3 แถว (หมดแล้ว / หมดใน 10 วัน / ไกล) → ก่อนแก้ ป้ายว่าง/ไม่มีสี
- [ ] **Step 2:** ส่ง object ล็อต (ไม่ใช่ string) และใช้ `.badgeClass`; ใน `v_bag_lot_contents` ไม่มี `current_qty` → ส่ง `{ expiry_date, status, current_qty: l.qty_in_bag }`; fallback เมื่อไม่มี AppLots คืน `{badgeClass:'bg-secondary', label:''}`
- [ ] **Step 3:** browser: 3 แถวได้ "หมดอายุแล้ว"(แดง) / "ใกล้หมดอายุ"(เหลือง) / ป้ายตามช่วง; restock picker ก็ขึ้นเหมือนกัน; ไม่มี console error
- [ ] **Step 4:** commit `fix(bags): lot expiry badges show in bag lot table and restock picker`

### Task A3: กล้องกลับมาทำงานหลังยกเลิก (ข้อ 11)

**Files:** Modify `js/staff-scan.js:927-965` (`_pickBagZone` / ผู้เรียก `_resolveBagIssueLocation`), `js/staff-scan.js:194-200` (`btnManualCancel`)

- [ ] **Step 1:** browser harness staff-scan: (ก) เลือกสินค้า → สแกนกระเป๋าที่มีหลายโซน → ปิด modal โดยไม่เลือก → ยิง scan สินค้าอื่นผ่าน hook ของ harness → ก่อนแก้ ไม่มีอะไรเกิด; (ข) เปิดกรอกเอง → "กลับไปสแกน" → ยิง scan → ก่อนแก้ ไม่ติด
- [ ] **Step 2:** เมื่อ `_resolveBagIssueLocation` คืน `null` (ผู้ใช้ยกเลิก) ให้ restart scan loop ถ้า `state.cameraStartedEver && !state.scanning` และคง state `ITEM_SCANNED` (สินค้าที่เลือกยังอยู่); `btnManualCancel` ให้ `setState` กลับเป็น state ก่อนเปิด manual (เก็บไว้ใน `state.ctx.beforeManual`, default `IDLE`)
- [ ] **Step 3:** browser: ทั้ง (ก) และ (ข) สแกนต่อได้ทันที ไม่ต้องรีเฟรช
- [ ] **Step 4:** commit `fix(scan): camera resumes after cancelling zone picker or manual entry`

### Task A4: ตู้ที่มีผ้า ไม่บล็อกการเบิกของอื่น (ข้อ 16)

**Files:** Modify `js/staff-scan.js:987-1001` (`handleLocationScan`), `js/staff-scan.js:1071-1078` (`onManualConfirm`)

**Interfaces:**
- Consumes: `AppLinens.isLinenItem(item) -> boolean` (`shared/linens.js:94`) — ถ้า `state.ctx.item` ไม่มี `category` ให้ตรวจ select ใน `AppInventory.findItemByCode` ว่าดึง `category:stock_categories(code)` มาด้วย ถ้าไม่ ให้เพิ่ม

- [ ] **Step 1:** browser harness: ตู้ `storage` ที่ `fetchLinenByCabinet` คืน 1 แถว — (ก) สินค้าที่เลือก = ถุงมือ (ไม่ใช่ผ้า) → ก่อนแก้ เด้งหน้าผ้า; (ข) สินค้า = ผ้าปูเตียง → เข้าหน้าผ้า
- [ ] **Step 2:** เปลี่ยนเงื่อนไขเป็น "ไปหน้าผ้าเฉพาะเมื่อ**ไม่มีสินค้าที่เลือก** หรือสินค้าที่เลือกเป็นผ้า" ทั้งสองจุด
- [ ] **Step 3:** browser: (ก) เข้าฟอร์มเบิกตามปกติ, (ข) ยังเข้าหน้าผ้า
- [ ] **Step 4:** commit `fix(scan): linen cabinet view only for linen items`

### Task A5: ปุ่มสแกน QR ในหน้าย้ายของอ่านป้ายจริงได้ (ข้อ 18)

**Files:** Modify `shared/scanner.js:574-581` (`_parseLocationQR`) และผู้เรียกที่ `shared/scanner.js:~517-520, ~640`

**Interfaces:**
- Produces: การสแกนในโหมดตำแหน่งรับ `location:<uuid>`, `LOC:<code>`, และรหัสเปล่า (ค่าเดียวกับที่ `shared/qr-print.js:20` พิมพ์) → lookup ด้วย `AppInventory.findLocationByCode(code)` เมื่อไม่ใช่ uuid

- [ ] **Step 1:** browser harness modal ย้ายของ: feed ค่า `ROOM-C`, `LOC:ROOM-C`, `location:<uuid>`, และ SKU สินค้า `NSS` → ก่อนแก้ 3 ค่าแรกมีแค่ uuid ที่ติด
- [ ] **Step 2:** แก้ให้ค่าที่ไม่ใช่ uuid ไป lookup ตาม code; ถ้าไม่พบ → toast "ไม่พบตำแหน่งนี้" แล้วสแกนต่อ (ไม่เงียบ)
- [ ] **Step 3:** browser: 3 รูปแบบเลือกตำแหน่งได้; `NSS` ขึ้น "ไม่พบตำแหน่งนี้"
- [ ] **Step 4:** commit `fix(transfer): QR button reads printed location labels`

### Task A6: ช่องค้นของไม่ตัดผลเงียบๆ (ข้อ 9)

**Files:** Modify `js/staff-scan.js:1283-1316`

- [ ] **Step 1:** แสดงทั้ง 10 ที่ query มา (เอา `.slice(0, 5)` ออก) และถ้า `data.length === 10` แสดงบรรทัด "แสดง 10 รายการแรก — พิมพ์ให้เจาะจงขึ้น"
- [ ] **Step 2:** browser stub 12 สินค้า → เห็น 10 แถว + บรรทัดเตือน; stub 3 สินค้า → ไม่มีบรรทัดเตือน
- [ ] **Step 3:** commit `fix(scan): finder shows all hits and says when the list is cut`

### Task A7: note `laundry_out` ไม่ค้าง (ข้อ 14)

**Files:** Modify `js/inventory.js:1903-1931`

- [ ] **Step 1:** ใน `else` (สินค้าไม่ใช่ผ้า) ล้าง `rf-note` **เฉพาะเมื่อค่าเป็น `'laundry_out'`** (ไม่ลบ note ที่ผู้ใช้พิมพ์เอง)
- [ ] **Step 2:** browser: เลือกผ้า → note = laundry_out → เปลี่ยนเป็นก๊อซ → note ว่าง; พิมพ์ "ซื้อใหม่" แล้วสลับสินค้า → ยังอยู่
- [ ] **Step 3:** commit `fix(inventory): stale laundry note no longer sticks to other receipts`

### Task A8: ข้อความ error เป็นไทย (ข้อ 5 ส่วน FE, ข้อ 12 ส่วน FE)

**Files:** Modify `js/locations.js:1215-1231` (error ลบตำแหน่ง), `js/staff-scan.js:2501-2517` (fallback เมื่อโหลดล็อตไม่ได้)

- [ ] **Step 1:** ลบตำแหน่ง: ถ้า error code `23503` → "ลบไม่ได้ — ตำแหน่งนี้มีประวัติการเคลื่อนไหว ใช้ "ปิดใช้งาน" แทน"
- [ ] **Step 2:** staff-scan: เมื่อโหลดล็อตล้มเหลวสำหรับสินค้า tracks_lots → ปิดปุ่มบันทึก + ข้อความ "โหลดล็อตไม่สำเร็จ ลองใหม่" แทนการให้กดแล้วเจอ `lot_id is required`
- [ ] **Step 3:** browser ทั้งสองกรณีด้วย stub error → commit `fix(ui): Thai messages for delete-location and lot-load failures`

### Task A9: ปิดงาน Phase A
- [ ] bump `sw.js` → `thegood-stock-v0.20.49`, `node --check` ทุกไฟล์ที่แก้, `bash tests/db/run.sh` ยังเขียว
- [ ] ดู mobile 375px ทุกหน้าที่แก้ ไม่มี overflow/console error; ลบ harness
- [ ] อัปเดต `project-log.md` แล้วรอ Pex สั่ง push

---

## Phase B — migration + FE คู่กัน (Pex apply ก่อน push)

### Task B1: คืนของยืมตรงรายการที่เลือก (ข้อ 3)

**Files:**
- Create: `supabase/migrations/20261109010000_return_targets_selected_loan.sql`
- Modify: `shared/loans.js:356-376` (`createReturn`), `js/staff-scan.js:~3305`, `js/loans.js:~443`
- Test: `tests/db/review_fixes_test.sql` (ใหม่), `tests/db/run.sh`

**Interfaces:**
- Produces: `AppLoans.createReturn({ itemId, locationId, qty, borrowerUsername, note, clientRefId, borrowMovementId })` — ส่ง `source_movement_id: borrowMovementId` (= `loan.movement_id_borrow`) เมื่อมีค่า
- DB: เมื่อ return มี `source_movement_id` ทั้ง 3 function ใช้ `WHERE movement_id_borrow = NEW.source_movement_id AND status IN ('active','overdue')` (+ borrower ตรงกัน); เมื่อเป็น NULL ใช้ลอจิกเดิม (loan ล่าสุด)

- [ ] **Step 1: เขียนเทสต์ (ต้อง FAIL ก่อน)** ใน `review_fixes_test.sql`, ทุกบล็อก `BEGIN … ROLLBACK`:
  - `return_older_loan_closes_that_loan`: ยืม A (lot L1, qty 1) แล้วยืม B (lot L2, qty 2) → return qty 1 พร้อม `source_movement_id = A.movement_id_borrow` → A.status='returned', B.status='active', movement return มี `lot_id = L1`
  - `return_older_loan_uses_its_lot`: ยอด L1 ณ location ปลายทางเพิ่ม 1, L2 ไม่เปลี่ยน
  - `return_qty_checked_against_selected_loan`: return qty 2 กับ A → raise 'จำนวนคืนต้องเท่ากับจำนวนที่ยืม'
  - `return_without_source_falls_back`: return ไม่ส่ง source → ปิด B (ล่าสุด) เหมือนเดิม
  - `return_source_of_other_borrower_rejected`: source เป็น loan ของคนอื่น → raise 'ไม่พบรายการยืมที่เปิดอยู่'
- [ ] **Step 2:** เพิ่มไฟล์ migration ใน `run.sh` loop ที่สอง + เรียก `review_fixes_test.sql` ท้ายไฟล์ → `bash tests/db/run.sh` → FAIL ที่ `return_older_loan_closes_that_loan`
- [ ] **Step 3:** migration: `CREATE OR REPLACE` `validate_borrow_movement` (lot backfill), `close_loan_from_return`, `guard_return_qty` จาก body ล่าสุด แก้เฉพาะ SELECT หา loan ให้เป็น `(NEW.source_movement_id IS NOT NULL AND movement_id_borrow = NEW.source_movement_id) OR (NEW.source_movement_id IS NULL AND <เงื่อนไขเดิม>)` คง `ORDER BY borrowed_at DESC LIMIT 1 FOR UPDATE` และข้อความ error เดิมทุกตัว; ท้ายไฟล์ SELECT ตรวจว่า 3 function มี `source_movement_id` ใน `prosrc`
- [ ] **Step 4:** `bash tests/db/run.sh` → PASS ทั้งหมด (รวมเทสต์เดิม)
- [ ] **Step 5:** FE ส่ง `borrowMovementId` จากทั้งสองจุดที่เรียก; browser stub: ยืม 2 รายการ คืนรายการแรก → payload insert มี `source_movement_id` ของรายการแรก
- [ ] **Step 6:** commit `fix(loans): a return closes the loan the user picked`

> หมายเหตุ B4: การเพิ่ม `source_movement_id` ทำให้ FK อ้างข้ามตำแหน่งมากขึ้น — B4 ต้องเสร็จในรอบ deploy เดียวกัน

### Task B2: ย้ายของไม่ยิงแจ้ง "ของใกล้หมด" (ข้อ 13)

**Files:** Create `supabase/migrations/20261109020000_lowstock_skip_transfer.sql`; Test `tests/db/review_fixes_test.sql`; `run.sh` (เพิ่ม `20260518010500_stock_triggers` ก่อน migration ใหม่ ถ้าโหลดใน stub ได้ — ถ้าไม่ได้ ให้โหลดเฉพาะ function ผ่านไฟล์ใหม่)

- [ ] **Step 1: เทสต์** (ใช้ `http_log` stub + ตั้ง settings `NOTIFY_SUPABASE_URL`/`NOTIFY_SERVICE_ROLE_KEY` ในบล็อก):
  - `transfer_does_not_alert_low_stock`: item threshold 10, ยอดรวม 20, `transfer_stock` 12 → `http_log` ไม่มีแถว `low_stock`
  - `issue_still_alerts_low_stock`: issue 12 → มี 1 แถว
- [ ] **Step 2:** run → FAIL ที่ transfer
- [ ] **Step 3:** `CREATE OR REPLACE check_low_stock` จาก `20260518010500` เพิ่ม `IF NEW.movement_type = 'transfer_out' THEN RETURN NEW; END IF;` ต่อจากเช็ค `qty_delta >= 0`; go/no-go SELECT ตรวจ prosrc
- [ ] **Step 4:** run → PASS → commit `fix(notify): moving stock no longer fires a false low-stock alert`

### Task B3: % ครบกระเป๋านับเฉพาะของที่ใช้ได้ และไม่ให้ของเกินชดเชยของขาด (ข้อ 7)

**Files:** Create `supabase/migrations/20261109030000_bag_status_usable_completion.sql`; Modify `js/staff-scan.js:1396-1484` (overlay), `js/bags.js:522-526`; Test `review_fixes_test.sql`

**Interfaces:**
- `v_bag_status` คอลัมน์เดิมทุกตัว ชื่อ/ชนิดเดิม (FE + `run_bag_status_alert` ใช้อยู่); ความหมายใหม่:
  - usable qty ต่อรายการ = ถ้า `tracks_lots`: `SUM(qty_in_bag)` จาก `v_bag_lot_contents` ที่ `expiry_date >= CURRENT_DATE AND status = 'active'`; ไม่ใช่: `v_bag_contents.qty`
  - `mandatory_deficit_count` นับจาก usable qty
  - `completion_pct = ROUND(100 * SUM(LEAST(usable, target)) / SUM(target))` เฉพาะ mandatory
  - ลำดับ `alert_level` เดิม (expired → expiring → no_template → low_stock → complete)

- [ ] **Step 1: เทสต์:**
  - `bag_surplus_does_not_hide_shortage`: เทมเพลต A×2, B×2 (บังคับ); ในกระเป๋า A×4, B×0 → `completion_pct = 50`, `mandatory_deficit_count = 1`
  - `bag_expired_stock_not_counted`: A×2 แต่ทั้งสองชิ้นหมดอายุ → deficit 1, `alert_level='expired'`
  - `bag_expired_and_short_reports_deficit`: เคสข้างบน `mandatory_deficit_count > 0` แม้ alert เป็น expired
  - `bag_complete_stays_complete`: ครบและไม่ใกล้หมด → 100, complete
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** migration `CREATE OR REPLACE VIEW v_bag_status` จาก body `20261106010000` แก้ CTE `deficit` ตาม Interfaces; go/no-go SELECT `bag_code, completion_pct, mandatory_deficit_count, alert_level FROM v_bag_status ORDER BY bag_code`
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** FE: overlay staff แสดงบรรทัด "ขาดของบังคับ N รายการ" เมื่อ `mandatory_deficit_count > 0` **ไม่ว่า** alert_level จะเป็นอะไร; การ์ด admin เหมือนกัน
- [ ] **Step 6:** browser: stub กระเป๋า expired + deficit 2 → เห็นทั้งป้ายหมดอายุและบรรทัดขาดของ
- [ ] **Step 7:** commit `fix(bags): completeness counts usable stock per item`

### Task B4: ลบตำแหน่งที่มีประวัติ → บอกให้ปิดใช้งาน (ข้อ 5)

**Files:** Create `supabase/migrations/20261109040000_delete_location_keeps_history.sql`; Test `review_fixes_test.sql`

- [ ] **Step 1: เทสต์:** `delete_location_with_movements_blocked`: ตำแหน่งที่มี movement (แม้ยอด 0) → raise 'ใช้ "ปิดใช้งาน" แทน'; `delete_empty_location_ok`: ไม่มีประวัติ → ลบได้
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** `CREATE OR REPLACE rpc_delete_location` จาก `20260524000000` เพิ่ม block ก่อนขั้น 7: ถ้ามี `stock_movements` หรือ `oxygen_movements` อ้างตำแหน่งนี้ → `RAISE 'ลบไม่ได้ — ตำแหน่งนี้มีประวัติการเคลื่อนไหว % รายการ (ใช้ "ปิดใช้งาน" แทน)'`; ลบ `DELETE FROM stock_movements`/`oxygen_movements` ในขั้น 7 ออก (ไม่มีอะไรให้ลบแล้ว) → ledger ไม่ถูกลบอีก
- [ ] **Step 4:** run → PASS → commit `fix(locations): never delete stock history with a location`

### Task B5: Telegram คืนกระเป๋าไม่ขึ้น "→ ?" (T1)

**Files:** Create `supabase/migrations/20261109050000_bag_return_notify_text.sql`

- [ ] **Step 1:** `CREATE OR REPLACE notify_bag_move_to_tg` จาก `20260705010000` เปลี่ยนเฉพาะ branch return: dest NULL → `'ที่เก็บหลัก (ไม่ได้ตั้งที่เก็บประจำ)'`; go/no-go SELECT prosrc
- [ ] **Step 2:** เทสต์: insert `bag_moves` action return `to_parent_id NULL` → `http_log` ข้อความไม่มี `→ ?` (ถ้าตาราง `bag_moves` ยังไม่มีใน stub ให้เพิ่มใน `schema_stub.sql`)
- [ ] **Step 3:** commit `fix(notify): readable bag-return message when the bag has no home`

### Task B6 (เฉพาะถ้า P0-2 = UTC): cron สถานะหมดอายุหลังเที่ยงคืนไทย
- [ ] หา job ที่เรียก updater ใน `20260715010000_alert_messages_detail.sql:185-195` / `20260519010800_expiry_cron.sql:222-225` แล้ว reschedule เป็น `5 17 * * *`; go/no-go SELECT จาก `cron.job`

### Task B7: ปิดงาน Phase B
- [ ] รวม migration B1–B5(+B6) ส่ง Pex ด้วย SendUserFile ตามลำดับ; รอภาพผล go/no-go ทุกไฟล์
- [ ] bump `sw.js` → v0.20.50, push FE **หลัง** Pex ยืนยัน apply; ตรวจ CI main เขียว + ไฟล์บนเว็บจริงเป็นเวอร์ชันใหม่
- [ ] ขอหน้างานทดสอบ: ยืม 2 ครั้ง คืนรายการเก่า; ย้ายของ ไม่มีแจ้งหลอก; หน้ากระเป๋า ALS-001
- [ ] อัปเดต `project-log.md` + `docs/system-overview.md` (กฎ return ใช้ source_movement_id)

---

## Phase C — รอ Pex ตัดสินวิธี (ยังไม่ลงรายละเอียด step จนกว่าจะเลือก)

### C1: Restock กระเป๋า (ข้อ 1) — ต้องเลือก
- **ทางที่แนะนำ:** wizard ถามแหล่งของต่อบรรทัด: "จากคลัง (เลือกตำแหน่ง)" = transfer, "ของเข้าใหม่จากผู้ขาย" = receive; ทั้งชุดบันทึกผ่าน RPC atomic ใหม่ `rpc_restock_bag(p_bag_id uuid, p_client_ref uuid, p_lines jsonb)` โดย `p_lines = [{item_id, lot_id, qty, from_location_id|null}]`, client_ref คงที่ต่อการเปิด wizard 1 ครั้ง (กดซ้ำไม่ซ้ำ), ref ต่อบรรทัด `md5(ref||':'||i)::uuid` แบบ `rpc_laundry_batch`
- **ตอบแล้ว (Chittawan 2026-11-09):** มีทั้งสองแบบ — ปกติรับเข้าคลังก่อนแล้วหยิบไปเติม แต่บางตัว (เช่นยากินบางชนิด) ไม่เก็บในคลัง เข้ากล่องยาเลย → ใช้ทางที่แนะนำ (เลือกแหล่งต่อบรรทัด) ได้ตรง; ค่าเริ่มต้นของบรรทัด = "จากคลัง"
- หลังแก้: ต้องตรวจย้อนหลังว่าเคย restock แบบ receive ไปแล้วกี่ครั้ง (ยอดคลังอาจสูงเกินจริง) → SQL diag แยก

### C2: ผ้า 2 ช่องทาง (ข้อ 2) — ต้องเลือก
- **ทางที่แนะนำ:** ให้ปุ่มลัดส่งซัก/รับคืน (`shared/laundry.js`, transfer ระหว่างตำแหน่งผ้า) เป็นทางเดียวสำหรับซัก; หน้าตู้ผ้าใช้แค่นับ/ปรับยอด; รับคืนบางส่วนให้เลือกต่อบรรทัด "ยังอยู่ร้านซัก" (ไม่ทำอะไร) หรือ "หายจริง" (loss)
- คำถามถึง Pex: หน้างานใช้ช่องทางไหนจริง (Telegram 2026-11-09 เห็นการย้ายผ้าปูเตียงระหว่าง TG1/TG2/ตะกร้ารอซัก)

### C3: ของไม่ผูกล็อต + ล้างตำแหน่งที่มี drift (ข้อ 10, 17)
- กันต้นเหตุ: FE + trigger บน `stock_items` ห้ามเปิด `tracks_lots` เมื่อสินค้ามียอด > 0 ที่ไม่ผูกล็อต (บอกให้ "ผูกล็อตก่อน")
- ทางแก้ของค้าง: RPC Admin `rpc_assign_lot_to_unlotted(p_item_id, p_location_id, p_lot_id, p_qty)` ที่ย้ายยอดไม่ผูกล็อตเข้าล็อตใน transaction เดียว — ต้องแก้ `check_lot_status` (body ล่าสุด `20260715034000`) ให้ยอมรับ outgoing ไม่มีล็อตเฉพาะเมื่อ RPC นี้ตั้ง `set_config('app.assign_unlotted','on',true)`
- `rpc_clear_location`: ถ้าหลังล้างยังมีล็อตบวก/ลบค้าง ให้ raise แทนการรายงานสำเร็จ
- ตอนนี้ prod: diag ส่วน B (5 พ.ย.) = 0 แถวไม่ผูกล็อต → ไม่เร่ง

### C4: ข้อย่อยความสำคัญต่ำ
- ข้อ 4: return เข้าล็อต recalled → ให้ปลายทางเป็นตำแหน่งกักกัน หรือเตือน Admin
- ข้อ 8: เทมเพลตที่มีแต่รายการไม่บังคับ → staff ใช้ข้อความ "ไม่มีรายการบังคับ" แบบฝั่ง admin
- ข้อ 13 ส่วน 2: `rpc_laundry_batch` ตรวจหมวด LINEN (ไม่ได้เพิ่มสิทธิ์ใหม่ แต่ควรปิด)
- ข้อที่ Codex พบเพิ่ม: guard รวมยอดตาม (location, lot) แต่ audit จัดกลุ่ม (item, location, lot) — แถวล็อตผิดสินค้าในอดีต (FK `NOT VALID` ใน `20260715033000`) อาจบังยอดติดลบ → เขียน diag หาแถว `stock_movements` ที่ `lot.item_id ≠ item_id` ก่อนตัดสินว่าต้องแก้หรือไม่

---

## ลำดับทำงานที่แนะนำ
1. P0-1 (เมื่อได้ตัวเลขนับ) + P0-2 (ถาม timezone) — ขนานกับข้ออื่น
2. Phase A ทั้งหมด → push เดียว (v0.20.49)
3. Phase B1–B5 → Pex apply → push FE (v0.20.50)
4. Phase C ตามที่ Pex เลือก
