# Phase 6 — PM Decisions Locked

**Date locked:** 2026-05-19
**Source docs:** spec `2026-05-19-phase6-linens-laundry-design.md` (886 lines) + UX `2026-05-19-phase6-linens-ui-design.md` (1333 lines)

## Decisions

| ID | Decision |
|---|---|
| **Q6-A** | Count audit cadence = **daily 06:00 BKK**. Configurable via settings (`LINEN_AUDIT_CRON_HOUR`). pg_cron schedule. |
| **Q6-B** | Photo policy = **required on ส่งซัก/รับคืน laundry transitions, advisory on periodic นับใหม่ count**. Reuses `shared/photo-capture.js`; `required: true` hides Skip for laundry flows, `required: false` for periodic counts. |
| **Q6-C** | Discrepancy threshold = **combined: `max(ceil(qty * 5%), 2 ผืน)`**. Both factor and floor configurable via settings (`LINEN_DISCREPANCY_PCT=5`, `LINEN_DISCREPANCY_MIN=2`). |
| **Q6-D** | Sub-category = **enum column `linen_subcategory`**. 5 initial values: sheet / blanket / towel / gown / wipe (Thai names in UI). Migrating to enum NOT a free-text column. Supports filter + Phase 6.1 per-piece tracking. |
| **Q6-E** | ส่งซัก vs รับคืน = **independent movements** (no pair tracking). Phase 6 base. Phase 6.1 may add batch tracking with optional SLA alert if user confirms operational need. |
| **Q6-F** | Staff RBAC for รับคืน = **Staff allowed** for `adjustment_gain` with `reason='laundry_in'` ONLY. Requires Phase 1 RLS policy modification: drop+recreate `sm_insert_staff` to add `(movement_type='adjustment_gain' AND reason='laundry_in')` to allowed set. UX agent flagged HIGH-severity risk if Admin-only (night-shift gap → guaranteed false-positive audit). Mandatory photo provides sufficient audit trail. |

## Derived implementation constraints
1. Seed MEDICATION-style category: `INSERT INTO stock_categories ('LINEN','ผ้า',60)` with `is_secret=false`
2. ADD COLUMN `stock_items.linen_subcategory linen_subcategory_enum` (nullable; only set when category=LINEN)
3. New table `linen_counts` (id, location_id, item_id, counted_qty, counted_at, counted_by, photo_url)
4. Daily cron `linen_audit_alert` 23:00 UTC (= 06:00 BKK) — Pass A: compute discrepancies; Pass B: tg-notify if any
5. Trigger error string (FE greps): `'นับผ้าผิดมากกว่าเกณฑ์'`
6. RLS modification on `stock_movements`: drop+recreate `sm_insert_staff` policy adding `(movement_type='adjustment_gain' AND reason='laundry_in')` predicate (Q6-F)
7. NO new admin tab — Inventory tab + category=LINEN filter (Phase 6 reuses Phase 2 segmented control)
8. Sub-category pills (5 chips) above linen list at Inventory tab when category=LINEN selected
9. Migration timestamp namespace `20260519060000–20260519060999`

## Out of scope (defer)
- Per-piece RFID/QR tag tracking (Phase 6.1)
- Paired ส่งซัก/รับคืน batch with SLA (Q6-E)
- Maintenance/repair sub-status (Phase 6.1)
- Multi-photo per count event (Phase 6.1)
