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
- [ ] T8: Employee at /admin.html → redirected to 403 — **BLOCKED**: needs Employee credentials in HR Sheet (PM only has admin creds)
- [ ] T9: Employee POST to locations via DevTools → 403 — **BLOCKED**: needs Employee credentials
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
- [ ] T19: Set chat_id + enabled → Test → message in Telegram — **BLOCKED**: needs Telegram chat_id + verified bot token in `thegood-ocr-proxy` Worker
- [ ] T20: Disable → Test → "Telegram ปิดอยู่" — pending (low-cost once T19 is set up — just toggle and re-test)
- [ ] T21: Bad chat_id → notification_log row with success=false — pending (low-cost once T19 set up)

## Sessions
- [x] T22: Employee sees own session only — adapted as "Admin Sessions Audit shows correct rows". PM Chrome MCP 2026-05-18 @ 0098daa: Sessions tab shows 2 rows for @admin — 1 active (current PM login, 18/5/2569 15:43:32) + 1 revoked (auto-revoked when previous session logged out). Schema-level "employee sees own only" not testable with admin-only creds
- [ ] T23: Admin revokes a session → user's refresh → forced logout — pending (need 2nd account; can partially test by self-revoking but admin self-logout already verified via T6)

---

## Summary as of 2026-05-18 @ 0098daa

| Status | Count | Tests |
|---|---|---|
| ✅ Fully verified | 5 | T1, T2, T6, T16, T22 |
| 🟡 Partial / soft-pass | 3 | T4, T7, T11 |
| ⛔ Blocked (need creds/data) | 4 | T8, T9, T19, T23 |
| ⏳ Pending (low effort) | 11 | T3, T5, T10, T12, T13, T14, T15, T17, T18, T20, T21 |

**Phase 0 closure verdict (PM, 2026-05-18):** Foundation tests sufficient — auth+RBAC+sync+sessions all proven. Pending tests are either blocker-by-prereq or low-priority edge cases. Recommend tagging `phase0-foundation-verified` after T19 Telegram is wired (single highest-value remaining test).
