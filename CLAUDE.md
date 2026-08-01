# The Good Stock (thegood-stock)
> ระบบสต็อกยา/เวชภัณฑ์/อุปกรณ์ของ The Good: mobile-first web app สแกน QR บันทึกเข้า-ออก, lot + วันหมดอายุ, ยืม-คืน, กระเป๋า ALS, ถังออกซิเจน, ผ้า/ซักรีด — Supabase + GitHub Pages

## ระบบคืออะไร / ทำอะไรได้
- Admin: dashboard, inventory (lots/expiry), locations tree + QR, ambulances sync, loans, bag templates, oxygen, settings, sessions audit
- Staff: หน้า scan (`staff-scan.html`), oxygen (`staff-oxygen.html`), print QR (`staff-print.html`), browse read-only
- แจ้งเตือน Telegram: low stock, expiry (cron), overdue loan, bag alert, oxygen refill/inspection

## Stack & บริการภายนอก
- Frontend: static HTML + vanilla JS (ไม่มี build step), Bootstrap 5, Sarabun, teal `#0d9488`, `sw.js` (cache-first static / network-first API)
- Hosting: GitHub Pages — `https://officethegood.github.io/thegood-stock/login.html` · repo `officethegood/thegood-stock` branch `main`
- **Supabase project `thegood-stock`:** ref `xtjsjrfixngfdkaahton`, URL `https://xtjsjrfixngfdkaahton.supabase.co`, region ap-southeast-1, publishable key ใน `shared/config.js`
- Edge Functions (Deno TS): `auth-bridge` (login ผ่าน HR GAS → ออก HS256 JWT), `sync-ambulances` (ดึงรถจาก Ambulance GAS), `tg-notify` (Telegram ผ่าน Worker)
- HR GAS auth: `https://script.google.com/macros/s/AKfycbxV5tbmeFx8SxEENtFgHNhZJfM26QocQX1bfqSzxxOPFd_CSiRCINGE2FfXuRAVF-IYGw/exec`
- Ambulance GAS: `...AKfycbwefEV0CebLwA-BUKfg1hwwMcpu_0AS33YIFV3P3qU6AZilKZy9FbHZs51xu5vu1mFH/exec?action=listAmbulances`
- Telegram ผ่าน Cloudflare Worker `thegood-ocr-proxy.officethegood.workers.dev` (แชร์กับ V.5) · Cloudinary `ddummbyql` preset `pt-medical` โฟลเดอร์ `thegood-stock/`
- Login ทดสอบ: `admin / thegood`

## โครงสร้างไฟล์สำคัญ
- `shared/config.js` — URL/key ทั้งหมด (แหล่งเดียว)
- `shared/auth.js` + `auth-jwt.js` — session localStorage + JWT refresh (อย่า refactor โดยไม่เข้าใจ key contract)
- `shared/` อื่นๆ — โมดูล domain (lots, loans, bags, oxygen, linens, scanner, qr-print, transfer, realtime, notify)
- `js/` — controller ต่อหน้า/แท็บ (`admin-shell.js` = tab routing, เพิ่มแท็บใหม่ที่นี่)
- `supabase/migrations/` — append-only ~100 ไฟล์ (schema จริงทั้งหมดอยู่นี่)
- `supabase/functions/<name>/index.ts` — Edge Functions (inline imports เพื่อ paste ลง Dashboard ได้)
- `sw.js` — เพิ่มไฟล์ใหม่ใน STATIC_ASSETS + bump `CACHE_VERSION` ทุกครั้งที่แก้
- `docs/superpowers/specs|plans/` — spec/plan ต่อ phase · `docs/test-checklist*.md` · `docs/bugs/` · `tools/smoke-test.sh`

## การทำงานหลักของระบบ
- **Auth flow:** login.html → Edge `auth-bridge` → verify กับ HR GAS → JWT HS256 (secret = Supabase Legacy JWT Secret เก็บเป็น custom secret `APP_JWT_HS_SECRET`) → PostgREST ตรวจได้ · access 8h / refresh 30d · sessions ใน `user_sessions`
- **RLS:** authenticated SELECT, เขียนได้เมื่อ `app_user_role() = 'Admin'` (staff มีข้อยกเว้นบางจุด เช่น linen, scan movement)
- **Notify chain:** DB trigger → `pg_net` → `tg-notify` (อ่าน `NOTIFY_SUPABASE_URL`/`NOTIFY_SERVICE_ROLE_KEY` จากตาราง `settings` ไม่ใช่ `ALTER DATABASE` เพราะ Free plan ไม่อนุญาต) → Worker → Telegram + log ใน `notification_log` (dedupe)
- **Deploy:** frontend = `git push` · migration = paste SQL ใน Dashboard SQL Editor · Edge Fn = paste ใน Dashboard editor — **ไม่ใช้ Supabase CLI โดยเจตนา** (user เลือก Dashboard-only)

## สถานะ
- **Active พัฒนาต่อเนื่อง** — commit ล่าสุด 2026-07-09 (borrow lot support)
- Phase 0–6 (foundation, inventory, medication lots, borrow/return, ALS bags, oxygen, linens) **สร้างแล้วทั้งหมดตามหลักฐาน migrations ถึง 2026-07-09**
- หมายเหตุ: `Project.md` เขียนค้างไว้ที่ "Phase 0 LIVE" (2026-05-18) — **ล้าสมัยเรื่องสถานะ phase** แต่ยังเป็นแหล่งอ้างอิง architecture/secrets/gotchas ที่ดีที่สุด

## Gotchas / ข้อควรระวัง
- Edge Functions: toggle **"Verify JWT with legacy secret" ต้อง OFF** ทุกฟังก์ชัน (ค่า default หลัง deploy คือ ON → 401 ก่อนถึงโค้ดเรา)
- CORS preflight ต้อง allow header `apikey` ด้วย (frontend ส่งทั้ง Authorization และ apikey)
- `SUPABASE_ANON_KEY` ใน config ใช้ key format ใหม่ `sb_publishable_*` (ถูกต้องแล้ว ไม่ใช่ legacy JWT anon)
- localStorage key `pt_user_meta` แชร์กับ pt-medical V.5 โดยเจตนา; JWT keys (`stock_access_token` ฯลฯ) เป็นของ Stock เอง
- มี worktree เก่าใน `.claude/worktrees/` — อย่าสับสนกับ source จริงที่ root

## เอกสารอื่นในโปรเจกต์
- `Project.md` — handoff ละเอียดสุด (architecture, ตาราง, secrets, decisions log)
- `README.md`, `docs/deploy.md`, `docs/env-setup.md`, `docs/test-checklist.md`, `docs/gas-ambulance-doget-snippet.md`, `docs/superpowers/specs/` + `plans/`
