# Phase 0 Foundation — Manual Test Checklist

Tick each row as you verify. Re-run after every material change.

## Auth
- [ ] T1: Login with correct creds → redirected by role
- [ ] T2: Wrong password → "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง"
- [ ] T3: Inactive user → "ไม่มีสิทธิ์เข้าถึง"
- [ ] T4: Reopen tab after login → no re-login prompt
- [ ] T5: Token refresh after 8h idle → still works
- [ ] T6: Logout → must log in again

## RBAC
- [ ] T7: Admin reaches admin.html
- [ ] T8: Employee at /admin.html → redirected to 403
- [ ] T9: Employee POST to locations via DevTools → 403
- [ ] T10: Tamper localStorage role → cannot insert (JWT unchanged)

## Locations
- [ ] T11: Create Room → Cabinet under Room → Shelf under Cabinet
- [ ] T12: Generator: Cabinet under ROOM-A proposes `CAB-A-1`; manual override OK
- [ ] T13: Duplicate code → 409 / inline error
- [ ] T14: type=ambulance without ambulance_id → check constraint blocks
- [ ] T15: Delete Room with children → "ไม่สามารถลบได้ เพราะมีรายการลูก"

## Ambulance sync
- [ ] T16: Set AMBULANCE_GAS_URL → click Sync → data populates
- [ ] T17: Bad URL → 502 toast
- [ ] T18: Remove 1 from GAS → re-sync → that row active=false

## Settings / Telegram
- [ ] T19: Set chat_id + enabled → Test → message in Telegram
- [ ] T20: Disable → Test → "Telegram ปิดอยู่"
- [ ] T21: Bad chat_id → notification_log row with success=false

## Sessions
- [ ] T22: Employee sees own session only
- [ ] T23: Admin revokes a session → user's refresh → forced logout
