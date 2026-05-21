# Oxygen Tank Inspection Tracking — Design

- **Date:** 2026-05-21
- **Status:** Approved (design), pending implementation plan
- **Author:** PM session (Pex / pex.elsa@gmail.com)
- **Phase tag:** Phase 5.1 — Oxygen inspection completion

## 1. Background / Problem

Phase 5 shipped the oxygen-tank module with a `next_inspection_due` date column
on `oxygen_tanks` (the hydrostatic-test compliance date). The feature was left
half-built:

1. **No explanation.** The add-tank form shows a bare field "วันตรวจสอบครั้งถัดไป"
   with no helper text. Users do not know what it means.
2. **Write-once, then frozen.** RLS on `oxygen_tanks` is `FOR UPDATE USING (false)` —
   *all* direct updates are blocked; only the `apply_oxygen_movement()` SECURITY
   DEFINER trigger may write to the table. Consequently `next_inspection_due`
   (and `tank_size`, `last_pressure_psi`, `notes`) can be set only at INSERT and
   can **never be changed afterwards**. After a tank is hydro-tested there is no
   way to push the date forward.
3. **No automated alert.** A list badge ("ตรวจด่วน" ≤30 days, "ใกล้ถึงกำหนด"
   ≤90 days) exists, but nothing notifies anyone. The Phase 5 migration comment
   explicitly deferred the alert cron to "Phase 5.1".

This spec completes the feature: make the data editable, make the field
self-explanatory, and add an automated Telegram alert.

## 2. Goals / Non-Goals

### Goals
- Admin can edit an existing tank's `tank_size`, `next_inspection_due`,
  `last_pressure_psi`, and `notes` after creation.
- The inspection-date field is self-explanatory in every form that shows it.
- A daily job sends one Telegram alert per tank when it enters the
  configurable "due soon" window.
- Overdue tanks are visually flagged in the admin list.

### Non-Goals (YAGNI — explicitly out of scope)
- No Dashboard widget / counter for upcoming inspections (list badge + Telegram
  alert is sufficient).
- No auto-calculation of the next inspection date (hydrostatic-test intervals
  vary by cylinder type and regulation — the date is entered manually).
- No separate inspection-history table (the single `next_inspection_due` value
  is the source of truth; movement to a history model is a future phase).
- Editing `serial`, `status`, and `current_location_id` stays out of the edit
  modal — serial is the immutable identity; status/location change only through
  the `oxygen_movements` ledger.

## 3. Locked Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Editability via a **SECURITY DEFINER RPC**, not loosened RLS. | Keeps `oxygen_tanks` RLS `USING(false)` intact — the "status changes only through the movement ledger" invariant stays structurally airtight. The RPC physically touches only 4 columns. Mirrors existing `apply_oxygen_movement()` / `rpc_transfer_stock` pattern. |
| D-2 | One **unified "แก้ไขถัง" modal** covering tank_size, next_inspection_due, last_pressure_psi, notes. | A focused inspection-only action would leave tank_size/notes still uneditable — another half-feature. One modal, one RPC. |
| D-3 | Alert = **one Telegram message per tank**, fired once when the tank crosses into the due-soon window. No repeats. | User choice. Avoids notification spam. Dedupe key includes the due-date, so a re-scheduled inspection produces a fresh alert next cycle. |
| D-4 | Due-soon window is **configurable** via setting `OXYGEN_INSPECTION_ALERT_DAYS`, default `30`. | Consistent with other configurable thresholds (`OXYGEN_REFILL_THRESHOLD`, expiry/overdue settings). |
| D-5 | Alert delivery is a **daily pg_cron job**, not event-driven. | A due date is reached by the passage of time — there is no DB event for a trigger to hang on. Mirrors `expiry_alert_daily`, `overdue_alert_*`, `bag_status_alert`. |

## 4. Architecture

Three independent units:

```
┌─────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ A. Edit RPC (DB)     │   │ B. Alert cron (DB)   │   │ C. Frontend (JS)    │
│ rpc_update_oxygen_   │   │ check_oxygen_        │   │ edit modal +        │
│ tank() SEC. DEFINER  │   │ inspection_due()     │   │ form clarity +      │
│ Admin-gated,         │   │ daily cron → tg-     │   │ overdue badge       │
│ 4 columns only       │   │ notify, 1 msg/tank   │   │ calls the RPC       │
└─────────────────────┘   └──────────────────────┘   └─────────────────────┘
```

## 5. Component Detail

### 5.1 Edit RPC — migration `20260521010000_rpc_update_oxygen_tank.sql`

```
FUNCTION rpc_update_oxygen_tank(
  p_tank_id             uuid,
  p_tank_size           text,
  p_next_inspection_due date,   -- nullable; NULL clears the date
  p_last_pressure_psi   int,    -- nullable
  p_notes               text    -- nullable
) RETURNS oxygen_tanks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
```

Behaviour:
1. Raise a Thai exception unless `app_user_role() = 'Admin'`.
2. Validate `p_tank_size` exists in `lookup_lists` WHERE `kind='tank_size'` AND
   `active = true`; else raise.
3. Validate `p_last_pressure_psi IS NULL OR p_last_pressure_psi > 0`; else raise.
4. `UPDATE oxygen_tanks SET tank_size, next_inspection_due, last_pressure_psi,
   notes, updated_at = now(), updated_by = app_username() WHERE id = p_tank_id`.
5. If no row matched, raise "ไม่พบถัง".
6. Return the updated row.

`GRANT EXECUTE ... TO authenticated`. SECURITY DEFINER bypasses the
`USING(false)` RLS so the UPDATE succeeds; the RLS policy itself is unchanged.
The function never references `status`, `current_location_id`, or
`last_refill_*` — those columns cannot be altered through this path.

### 5.2 Setting

Seed `OXYGEN_INSPECTION_ALERT_DAYS = '30'` into `settings`
(`INSERT ... ON CONFLICT (key) DO NOTHING`). Editable in the ตั้งค่า tab like
other numeric settings.

### 5.3 Alert cron — migration `20260521010100_oxygen_inspection_cron.sql`

`FUNCTION check_oxygen_inspection_due() RETURNS void` — SECURITY DEFINER,
`search_path = public, net, pg_temp`.

1. Read `NOTIFY_SUPABASE_URL`, `NOTIFY_SERVICE_ROLE_KEY`,
   `NOTIFY_TELEGRAM_ENABLED`, `NOTIFY_TELEGRAM_CHAT_ID`,
   `OXYGEN_INSPECTION_ALERT_DAYS` from the `settings` table (NOT
   `current_setting` — Project.md §8 gotcha 9).
2. Guard: skip silently if notify URL/key missing or Telegram disabled.
3. Select tanks WHERE `next_inspection_due IS NOT NULL`
   AND `next_inspection_due <= (now() AT TIME ZONE 'Asia/Bangkok')::date + alert_days`
   AND `status <> 'retired'`. (This window covers both due-soon and
   already-overdue tanks.)
4. For each such tank, compute
   `dedupe_key = 'oxygen_inspection_due:' || tank_id || ':' || next_inspection_due`.
   Skip the tank if a `notification_log` row with that `dedupe_key` and
   `success = true` already exists.
5. For each not-yet-alerted tank, POST one message to the existing `tg-notify`
   Edge Function via `pg_net`, passing `event_type='oxygen_inspection_due'`,
   the `dedupe_key`, and `chat_id`. Message body (Thai), e.g.:
   `[Stock] ถังออกซิเจน OXY-0001 (1.5Q) ครบกำหนดทดสอบถัง 2026-06-10 (อีก 20 วัน)`
   or `... (เกินกำหนด 5 วัน)` when the date has passed.

**Assumption (verify at implementation):** `tg-notify` writes a
`notification_log` row keyed by the payload's `dedupe_key` on success — this is
the same mechanism `check_oxygen_refill_batch()` relies on. If `tg-notify` does
not do this, the cron function must insert the `notification_log` row itself.

Schedule: `cron.schedule('oxygen_inspection_alert', '0 2 * * *',
$$SELECT check_oxygen_inspection_due()$$)` — 02:00 UTC = 09:00 Asia/Bangkok,
the same slot as `expiry_alert_daily` / `bag_status_alert`. Idempotent
`cron.unschedule` guard before `cron.schedule`.

### 5.4 Frontend — `js/oxygen.js` + `shared/oxygen.js`

**Edit modal.** A new "แก้ไขข้อมูลถัง" button (Admin only) in the tank detail
drawer footer, beside the existing "เปลี่ยนสถานะ" button. It opens an edit
modal with: Serial (read-only display), ขนาดถัง (select populated from
`lookup_lists` kind=`tank_size`), วันครบกำหนดทดสอบถัง (date), ค่าแรงดันล่าสุด
(PSI, number), หมายเหตุ (textarea) — all pre-filled from the current row. Save
calls a new `AppOxygen.updateTank()` helper in `shared/oxygen.js` which wraps
`supabase.rpc('rpc_update_oxygen_tank', ...)`. The existing realtime
subscription refreshes the list row automatically.

**Form clarity.** In both the add-tank modal and the new edit modal:
- Relabel the field to "วันครบกำหนดทดสอบถัง (ครั้งถัดไป)".
- Add helper text: "วันครบกำหนดส่งทดสอบสภาพ/แรงดันถังครั้งถัดไป — เว้นว่างได้".
- Add a `last_pressure_psi` (PSI) input to the add-tank modal so the add and
  edit forms are consistent (the column already exists; today nothing sets it).

**Overdue badge.** Extend `_inspectionWarning()`:
- `next_inspection_due` in the past → red badge "เกินกำหนด".
- ≤30 days → "ตรวจด่วน" (existing). ≤90 days → "ใกล้ถึงกำหนด" (existing).
This is the safety net for tanks that miss their single alert.

## 6. Data Flow

- **Edit:** Admin opens drawer → "แก้ไขข้อมูลถัง" → edits → Save →
  `AppOxygen.updateTank()` → `rpc_update_oxygen_tank` (SECURITY DEFINER) →
  `oxygen_tanks` row updated → realtime event → list row refreshes.
- **Alert:** daily 09:00 Bangkok → `check_oxygen_inspection_due()` → finds tanks
  in window not yet alerted → one `pg_net` POST per tank → `tg-notify` → Telegram
  message + `notification_log` row → next run skips that tank+date.

## 7. Error Handling

- RPC raises Thai exceptions (non-Admin, bad size, bad PSI, tank not found). The
  FE surfaces them through the existing `_mapError` / `_throw` pattern in
  `shared/oxygen.js`; add mappings for the new messages as needed.
- Cron: missing NOTIFY config → `RAISE WARNING` and return; Telegram disabled →
  return silently. Identical to `check_oxygen_refill_batch()`.

## 8. Testing (manual T-tests — project has no automated runner)

1. Admin edits a tank's inspection date / size / PSI / notes → persists; list
   row updates via realtime.
2. Non-Admin (or a crafted RPC call attempting `status`) cannot change status or
   location through `rpc_update_oxygen_tank` — verified by the column-explicit
   UPDATE and the in-function Admin gate.
3. A tank with `next_inspection_due` within the alert window is picked up by
   `check_oxygen_inspection_due()` and produces exactly one Telegram message.
4. A second cron run does NOT re-alert the same tank (dedupe).
5. After Admin pushes the date forward, the next-cycle window crossing alerts
   again (new dedupe key).
6. A tank with a past `next_inspection_due` shows the "เกินกำหนด" badge.

## 9. Files Touched

- **New:** `supabase/migrations/20260521010000_rpc_update_oxygen_tank.sql`
- **New:** `supabase/migrations/20260521010100_oxygen_inspection_cron.sql`
- **Edit:** `js/oxygen.js` — edit modal, edit button, form clarity, badge.
- **Edit:** `shared/oxygen.js` — `updateTank()` helper, error mappings.
- **Edit:** `sw.js` — bump `CACHE_VERSION`.

Both migrations are applied to Supabase via the web Dashboard SQL Editor (no
CLI), consistent with project practice.
