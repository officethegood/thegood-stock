# Phase 4 — PM Decisions Locked

**Date locked:** 2026-05-19
**Source docs:** spec `2026-05-19-phase4-als-bags-design.md` (1023 lines) + UX `2026-05-19-phase4-als-bags-ui-design.md` (1283 lines)

## Decisions

| ID | Decision |
|---|---|
| **Q-Phase4-A** | Bag templates managed via **Admin UI** (no migration seed). Clinical data evolves; SQL seeds become stale. New `bag_templates` table starts empty; Admin creates templates per medical kit type. |
| **Q-Phase4-B** | Restock = **N individual client REST inserts** (idempotent via `client_ref_id`). NOT bulk RPC. Simpler; sufficient at Thegood scale. |
| **Q-Phase4-C** | Bag expiry Telegram = **nearest expiry per bag, one line per bag**. NOT enumeration per lot. Admin drills via UI. |
| **Q-Phase4-D** | Photo on restock = **advisory** (mirrors Phase 3 Q-Phase3-C). Skip button always visible. Reuses `shared/photo-capture.js`. |
| **Q-Phase4-E** | Bag swap = **OUT OF SCOPE** Phase 4. Use manual issue+receive workflow. Phase 4.1 if EMS workflow needs atomic swap. |
| **Q-Phase4-F** | Bag overdue inspection tracking = **OUT OF SCOPE** Phase 4. Restock history in `stock_movements` IS the inspection record. Phase 4.1 if EMS compliance needs `last_verified_at`. |

## Derived implementation constraints
1. `bag_templates` table + `bag_template_items` junction; `locations.bag_template_id` ADD COLUMN (nullable FK)
2. `v_bag_status` view aggregates per-bag-location current vs target qty + nearest expiry
3. Daily cron `bag_status_alert` 09:00 BKK using settings-table NOTIFY_*
4. Trigger error strings: TBD (no blocking errors; status is advisory)
5. Top-level admin tab "ALS Bags" (8th); flex-wrap nav from Q-O1
6. Reuse `shared/photo-capture.js` (Phase 3); folder `thegood-stock/bag-restock/{bag_code}/`
7. Migration timestamp namespace `20260519040000–20260519040999`
8. Shopping-list UI orders by mandatory+deficit first, then expiry, then alphabetical

## Out of scope (defer)
- Bag swap atomic action (Q-Phase4-E)
- Overdue inspection tracking (Q-Phase4-F)
- Multi-bag restock in one transaction
