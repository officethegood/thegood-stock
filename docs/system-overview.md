# Thegood Stock — System Overview (ภาพรวมระบบ)

> อัปเดต 2026-07-12 · FE v0.20.38 · 169 commits (เริ่ม 2026-05-18)
> เอกสารนี้คือ "ความจริงปัจจุบัน" ของระบบ — Project.md/README ฉบับเดิม (18 พ.ค.) ล้าสมัยแล้ว
> รวบรวมจากการอ่าน: spec/design/plan ทุกไฟล์, migration ทั้ง 100 ไฟล์, โค้ด FE ทุกไฟล์, git log

---

## 1. ระบบนี้คืออะไร

ระบบสต็อกของ **The Good** (org `officethegood`): ยา/เวชภัณฑ์ (คุมล็อต+วันหมดอายุ), อุปกรณ์ (ยืม-คืน),
กระเป๋า ALS (จัดของ+ขึ้นรถ), ถังออกซิเจน (state machine), ผ้า (ส่งซัก/นับ) — ใช้งานจริงโดยทีมรถพยาบาล TG1–TG6

- **Frontend:** GitHub Pages `officethegood/thegood-stock` — branch `main` = production
  (push แล้วขึ้นเว็บ ~30 วิ; service worker auto-reload เครื่องผู้ใช้ภายใน ~10 นาที)
- **Backend:** Supabase `xtjsjrfixngfdkaahton` — **Dashboard-only ไม่ใช้ CLI**
  (migration = paste ทีละไฟล์ใน SQL Editor, Edge Function = paste ใน editor — **Elsa รันเองเท่านั้น**)
- **Auth:** ยืม user/password จากระบบ HR (GAS) ผ่าน Edge Function `auth-bridge` → ออก JWT เอง
- ผู้ใช้ 2 role: **Admin** (จัดการทุกอย่างผ่าน admin.html) / **Employee** (สแกนเบิก-ยืม-O₂-พิมพ์ QR)

## 2. หน้าและ flow

| หน้า | ใคร | ทำอะไร |
|---|---|---|
| `login.html` → `index.html` | ทุกคน | login → route ตาม role (Admin→admin, Employee→staff) |
| `staff.html` | Staff | home การ์ด: สแกน / ผ้า / ออกซิเจน / พิมพ์ QR |
| `staff-scan.html` | Staff+Admin | **หน้าหลักหน้างาน**: เบิก-จ่าย · ยืม-คืน · ย้ายของ · สแกนกระเป๋า/ตู้ผ้า |
| `staff-oxygen.html` | Staff+Admin | wizard 7 ขั้นเปลี่ยนสถานะถัง O₂ |
| `staff-print.html` | Staff+Admin | พิมพ์ QR sticker (สินค้า/ตำแหน่ง/กระเป๋า/ถัง) |
| `admin.html` | Admin | 5 แท็บ: Dashboard · คลัง (สินค้า/ล็อต/กระเป๋า/ผ้า/ประวัติ) · สถานที่ · ยืม-คืน · ตั้งค่า |

**Flow หน้างาน (staff-scan):**
- **เบิก-จ่าย** — สแกนสินค้า→ตำแหน่ง→(ของคุมล็อต: FEFO lot picker)→จำนวน→บันทึก
  - ล็อตหมดอายุ**เบิกได้**ผ่าน modal แดง + บังคับเหตุผล (`expired_ack`, 2026-07-12 ผ่อนจาก Q-D1 เดิม)
  - ล็อต recalled ห้ามทุกกรณี · FEFO override มีคำเตือน · หลังสแกนสินค้ามีทางแยก "ย้าย (Transfer)"
- **ยืม-คืน** — ยืม 5 ขั้น (สินค้า→ตำแหน่ง→วันคืน+จำนวน+**จุดประสงค์** 🧰ทั่วไป/🚑ขึ้นประจำรถ→รูป→ยืนยัน),
  คืน 3 ขั้น · ของคุมล็อตยืมได้ (lot กลับอัตโนมัติตอนคืน) · สแกน `BAG-…` เด้งไปหน้ากระเป๋า
- **กระเป๋า** — สแกน QR กระเป๋า → เห็น**ของจริงข้างใน** + เช็คลิสต์ (ถ้ามีเทมเพลต) + ปุ่ม
  "เอากระเป๋าขึ้นรถ / คืนกระเป๋า" (ของตามไปทั้งใบ, ไม่มีกำหนดคืน, ลง `bag_moves` + Telegram)
- **ย้ายของ** — Transfer modal: ต้นทาง→ปลายทาง (เลือกกระเป๋าได้) → RPC `transfer_stock`

## 3. โครงสร้างข้อมูล (หลัง migration ทั้งหมด — 100 ไฟล์)

**หัวใจ: `stock_movements` = ledger append-only (ห้าม UPDATE/DELETE) — ความจริงหนึ่งเดียว**
ยอดทุกตัวเป็น cache ที่ trigger คำนวณจาก ledger:

| ตาราง | หน้าที่ | ผู้เขียน |
|---|---|---|
| `stock_movements` | ledger ทุกการเคลื่อนไหว (8 types) | client INSERT (RLS คุม) |
| `stock_item_locations` | ยอดต่อ (สินค้า, ตำแหน่ง) CHECK≥0 | trigger `apply_movement_to_sil` **เท่านั้น** |
| `stock_lots` | ล็อตยา + `current_qty` + status | trigger `apply_movement_to_lot_qty` **เท่านั้น** (เจ้าของเดี่ยว) |
| `stock_loans` | วงจรยืม (active/overdue/returned) | triggers create/close loan |
| `stock_items` / `stock_categories` | แม่แบบสินค้า / หมวด (MEDICATION=คุมล็อต, LINEN=ผ้า) | Admin |
| `locations` | ต้นไม้สถานที่ (room/storage/shelf/bin/zone/ambulance/**bag**) + `bag_template_id` + `laundry_role` | Admin (+RPC deploy/return bag) |
| `bag_templates` + `bag_template_items` | เทมเพลต "ของที่ควรมี" ในกระเป๋า | Admin |
| `bag_moves` | audit กระเป๋าขึ้นรถ/คืน | RPC เท่านั้น |
| `oxygen_tanks` + `oxygen_movements` | ถัง O₂ state machine 6 สถานะ (UPDATE ถังตรง ๆ ถูกบล็อก — เปลี่ยนผ่าน movement เท่านั้น) | trigger/RPC |
| `linen_counts` | snapshot นับผ้า (ไม่แตะยอด) | Staff+Admin |
| `lookup_lists` / `settings` / `notification_log` / `user_sessions` / `ambulances` | taxonomy / config / dedupe แจ้งเตือน / session JWT / รถ (sync จาก GAS) | Admin/ระบบ |

**Movement types:** บวก = `receive, adjustment_gain, return, transfer_in` · ลบ = `issue, adjustment_loss, borrow, transfer_out` (trigger บังคับเครื่องหมาย) · `client_ref_id` UNIQUE = idempotency (retry ซ้ำได้)

**Views:** `v_stock_items_with_total` (รวมยอด) · `v_lots_with_remaining` (FEFO picker — active เท่านั้น; หน้าเบิกใช้ `fetchIssuableLots` เพิ่ม expired) · `v_item_location_lots` (ยอดล็อตต่อตำแหน่ง**จาก ledger**) · `v_bag_status` (สถานะกระเป๋า) · `v_location_path` · `v_linen_state_summary` / `v_linen_audit`

**Trigger บน stock_movements (ลำดับ):**
BEFORE: `check_lot_status` (กติกาล็อต+expired_ack, ล่าสุด 20260712020000) → `enforce_movement_sign` → `validate_borrow_movement` (due_at, backfill lot ตอนคืน)
AFTER: `apply_movement_to_sil` (SIL เท่านั้น, ล่าสุด 20260712010000) → `apply_movement_to_lot_qty` (lot เท่านั้น + auto-deplete/reactivate) → `check_low_stock` → create/close loan → notify Telegram

**RPCs:** `transfer_stock` · `rpc_deploy_bag`/`rpc_return_bag` (Staff ได้) · `rpc_recall_lot` (capped write-off) · `rpc_update/delete_oxygen_tank` · `rpc_delete_location` (Admin) · cron RPCs 5 ตัว

**pg_cron (เวลาไทย):** 09:00 = expiry alert + overdue + bag status + O₂ inspection · 17:00 = overdue ซ้ำ · 06:00 = linen audit

**RLS:** อ่าน = ทุกคน (ยกเว้น settings ที่ `is_secret`) · เขียน = Admin; Staff insert movement ได้เฉพาะ issue/adjustment_loss/borrow/return + adjustment_gain(laundry_in) · ยอดทุกตาราง cache เขียนผ่าน trigger SECURITY DEFINER เท่านั้น

## 4. Frontend architecture

- **ไม่มี framework** — vanilla JS + Bootstrap 5.3.3, ไทยทั้งระบบ, tap target ≥44px, theme teal `#0d9488`
- `shared/` = โมดูล API (`window.App*`): inventory, lots, loans, bags, oxygen, linens, laundry, transfer, locations, scanner, qr-print, photo-capture, cloudinary, realtime, settings, notify, ui, icons + auth 3 ไฟล์
- `js/` = controller ต่อหน้า/แท็บ; ตัวใหญ่สุด `staff-scan.js` (~3,100 บรรทัด: state machine เบิก + IIFE ยืม-คืน + bag/linen overlay)
- **Auth chain:** login → `auth-bridge` (ตรวจกับ HR GAS) → JWT HS256 (claims: user_role/name/username, access 8 ชม. + refresh 30 วัน, refresh อัตโนมัติก่อนหมด 5 นาที) → เก็บ `stock_access_token` ฯลฯ + cache `pt_user_meta` (แชร์กับ V.5; ถ้า cache หาย derive จาก JWT — ห้ามลด role)
- **Service worker:** cache-first สำหรับ static / network สำหรับ API; **แก้ไฟล์ FE ต้อง bump `CACHE_VERSION` ใน sw.js ทุกครั้ง** (+เขียน changelog ใน comment); ทุกหน้า auto-reload 1 ครั้งเมื่อ SW ใหม่คุม
- **Scanner (`AppScanner`):** native BarcodeDetector → fallback html5-qrcode (iOS)
  ⚠ **iOS gotcha:** ขนาด `<video>` ต้องกำหนดด้วย CSS descendant rule (`.scan-stage video`) ห้ามใช้ inline style — html5-qrcode แทนที่ element แล้ว style หาย ทำให้ iOS ไม่ decode (พังมาแล้ว 2 หน้า)

## 5. Edge Functions + จุดเชื่อมภายนอก

| ตัว | หน้าที่ | Auth |
|---|---|---|
| `auth-bridge` | login/refresh/logout/verify — คุยกับ HR GAS, ออก JWT, จัดการ `user_sessions` | public (ตรวจ credential) |
| `sync-ambulances` | ดึงรายชื่อรถจาก Ambulance GAS (`settings.AMBULANCE_GAS_URL`) → upsert | Admin JWT |
| `tg-notify` | ส่ง Telegram ผ่าน CF Worker + dedupe (`notification_log`) | Admin JWT หรือ service_role+X-Internal |

ภายนอก: **HR GAS** (auth กลาง — แก้แล้วกระทบทุกระบบ The Good) · **Ambulance GAS** (รายชื่อรถ) · **Cloudinary** `ddummbyql`/preset `pt-medical` (รูป ยืม-คืน/O₂/ผ้า, unsigned จาก client) · **CF Worker** `thegood-ocr-proxy` (ทางผ่าน Telegram — แชร์กับ V.5) · Telegram แจ้ง: ทุก movement, low-stock, ล็อตใกล้หมดอายุ, ยืมเกินกำหนด, กระเป๋าขึ้นรถ, O₂

## 6. กฎเหล็ก (เรียนรู้จากเหตุการณ์จริง)

1. **Ledger = ความจริงเดียว** — สงสัยยอดเพี้ยนเมื่อไหร่ รัน `sql/audit-stock-consistency.sql` (read-only, 6 เช็ค, ผลดี = 0 rows) · แก้ข้อมูลด้วย movement คู่ชดเชย ห้ามแก้ ledger/cache ตรง ๆ
2. **ห้าม copy trigger body จาก migration เก่า** — ต้อง copy จากเวอร์ชันล่าสุดเสมอ (`apply_movement_to_sil` โดนทับด้วย body เก่ามาแล้ว 2 ครั้ง → บั๊กยอดบวกซ้ำ 20260712)
3. เวอร์ชันล่าสุดของ function ที่ถูกทับหลายรอบ: `check_lot_status`→20260712020000 · `apply_movement_to_sil`→20260712010000 · `apply_movement_to_lot_qty`→20260703010000 · `enforce_oxygen_state_machine`→20260529010100
4. migration ทุกไฟล์ต้อง idempotent + มี Verification SQL ท้ายไฟล์ · ห้ามแก้ไฟล์ migration ที่ apply แล้ว (เขียนไฟล์ใหม่ทับ)
5. เปิด `tracks_lots` ให้สินค้าที่มีประวัติอยู่แล้ว → รัน audit ก่อน/หลังเสมอ (เคส DTX มีหนี้ไม่ระบุล็อต)
6. cron/trigger อ่าน secrets จากตาราง `settings` (ไม่ใช้ `current_setting` — Free tier บล็อก `ALTER DATABASE SET`)

## 7. Locked decisions ที่ยังบังคับใช้ (คัดเฉพาะที่เจอบ่อย)

- lot_number unique ต่อ item · recall = soft flag terminal · FEFO override เตือน+บันทึก · lot picker โชว์ 5+accordion
- ยืม: รูป advisory ข้ามได้ · due_at default 3 วัน · Admin proxy-borrow ได้
- กระเป๋า: template ไม่ seed (สร้างผ่าน UI/จากของจริง) · restock = N inserts idempotent
- O₂: 6 สถานะ (ready/on_board/awaiting_refill/refilling/maintenance/retired) · refill threshold=5 · จอแยก staff-oxygen
- ผ้า: location = state (`laundry_role`) ไม่มีตาราง batch · discrepancy = max(5%, 2 ผืน)
- **ถูกผ่อนแล้ว:** Q-D1 "ห้ามเบิดล็อตหมดอายุเด็ดขาด" → เบิดได้เมื่อ `expired_ack`+เหตุผล (2026-07-12, คำขอ Chittawan)

## 8. เอกสาร + ทดสอบ

- Flow ผู้ใช้ภาษาไทย (ส่งทีมได้): `docs/flow-issue-borrow.md`
- Spec/design/plan ราย phase: `docs/superpowers/` (0→6 + 0.5 QR + 0.7 hierarchy + oxygen awaiting_refill)
- ทดสอบ = manual checklist `docs/test-checklist.md` (T-numbers + DB probe) + ชุดทีมเทสไทย `test-checklist-2026-06-01.md` · ไม่มี test runner — ทุกไฟล์ JS ต้องผ่าน `node --check` ก่อน push
- Smoke หลัง deploy: `tools/smoke-test.sh`
- ⚠ **เอกสารล้าสมัยที่รู้ตัวแล้ว:** `Project.md`/`README.md` (สถานะ phase ยังเป็นของ 18 พ.ค.), test-checklist T45–T70 ยังไม่ติ๊ก, docs/bugs 4 ไฟล์ status Open ทั้งที่แก้แล้ว, จำนวน secrets ใน env-setup vs Project.md ไม่ตรงกัน
