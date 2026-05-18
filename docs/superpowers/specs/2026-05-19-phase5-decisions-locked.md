# Phase 5 — PM Decisions Locked

**Date locked:** 2026-05-19
**Locked by:** PM (user "Pex") via AskUserQuestion batch

Source docs:
- Spec: `docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md` (1026 lines)
- UX:   `docs/superpowers/designs/2026-05-19-phase5-oxygen-ui-design.md` (1077 lines)

## Decisions

| ID | Decision |
|---|---|
| **Q-Phase5-1** | `tank_size` enum = **3 sizes: small / medium / large** (matches PDF + common pre-hospital sizes). |
| **Q-Phase5-2** | `OXYGEN_REFILL_THRESHOLD` = **5** (Phase 0 default unchanged). Configurable via `settings`. |
| **Q-Phase5-3** | Maintenance reason = **free text in `oxygen_movements.note`**. No sub-reason enum. Revisit Phase 5.1 if compliance reporting needs structured reasons. |
| **Q-Phase5-4** | Photo on status transitions = **optional on all transitions**. Reuses `shared/photo-capture.js` component defined by Phase 3 (advisory pattern). Cloudinary folder `thegood-stock/oxygen/{tank_serial}/`. |
| **Q-Phase5-5** | Asset cost tracking = **defer entirely**. No `purchase_price` or `acquired_at` column in Phase 5. Phase 5.1 may add when finance/insurance need it. |
| **Q-Phase5-6** | Staff flow = **dedicated `staff-oxygen.html` page**. Separate bookmark + separate mental model from staff-scan.html. No mode toggle. |
| **Q-O1** | Admin nav overflow @ 360px = **flex-wrap to 2 rows**. Existing pattern; visual cost minimal. Revisit a "more" dropdown only if nav grows past 10 tabs. |

## Derived implementation constraints

1. `oxygen_tanks` table per spec §5.1:
   - PK uuid, serial text UNIQUE NOT NULL, tank_size enum NOT NULL, current_location_id FK locations, status oxygen_tank_status NOT NULL DEFAULT 'ready', last_refill_at/by, last_pressure_psi nullable, next_inspection_due date, notes text, audit cols
2. `oxygen_tank_status` enum: `'ready' | 'on_board' | 'refilling' | 'maintenance' | 'retired'`
3. `oxygen_tank_size` enum: `'small' | 'medium' | 'large'`
4. `oxygen_movements` ledger (state-machine transitions): tank_id FK, from_status, to_status, from_location_id, to_location_id, performed_by, performed_at, note, photo_url
5. BEFORE INSERT trigger on `oxygen_movements` enforces valid state-machine transitions. Error string (FE greps): `'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง'`
6. AFTER INSERT trigger on `oxygen_movements` with `to_status='refilling'` → check refill count vs `OXYGEN_REFILL_THRESHOLD` → maybe pg_net to tg-notify (dedupe `oxygen_refill_batch:YYYY-MM-DD`)
7. RLS read-all authenticated; write Admin only on `oxygen_tanks`; INSERT on `oxygen_movements` allowed for Staff (with state-machine check enforcing valid transitions)
8. Realtime publication adds `oxygen_tanks` (live status changes propagate)
9. New page `staff-oxygen.html` (mirrors staff-scan.html shell + oxygen scan UX)
10. New admin tab "ถังออกซิเจน" (top-level; wraps to row 2 at 360px)
11. Cloudinary folder `thegood-stock/oxygen/{tank_serial}/` (Phase 3 photo-capture.js reused)
12. Dashboard panel "สถานะถังออกซิเจน" — counts per status; CTA when refill batch ready

## Out of scope (defer)
- Pressure history (Phase 5.1)
- Hydrostatic test reminders (Phase 5.1)
- Tank cost/value (Q-Phase5-5)
- Maintenance sub-reason enum (Q-Phase5-3)
- Multi-photo per transition (Phase 5.1)
- "Retire" 5-minute soft-delete window (UX risk #2 — Phase 5.1)
