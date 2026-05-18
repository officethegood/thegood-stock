# Phase 3 — PM Decisions Locked

**Date locked:** 2026-05-19
**Locked by:** PM (user "Pex") via AskUserQuestion batch

Source docs:
- Spec: `docs/superpowers/specs/2026-05-19-phase3-borrow-return-design.md` (1084 lines)
- UX:   `docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md` (1310 lines)

## Decisions

| ID | Decision |
|---|---|
| **Q-Phase3-A** | UI placement = **new top-level tab "อุปกรณ์ยืม-คืน"**. Admin nav becomes 7 tabs; flex-wrap to 2 rows at 360px is acceptable (Q-O1). UX rationale: discoverability, mental-model isolation, full page width for loan list. |
| **Q-Phase3-C** | Photo proof = **advisory only** on both borrow and return. Skip button always visible; movement succeeds with `photo_*_url = null`. Mitigates one-handed/dim-storeroom UX risk. |
| **Q-Phase3-D** | Borrower identity = **Admin proxy-borrow allowed**. Add `borrower_username text` column to `stock_movements` (nullable; defaults to `app_username()` when null). UI: borrower picker on Admin path; Staff path auto-fills with their own username and hides the picker. |
| **Q-Phase3-E** | `due_at` = **dedicated nullable column on `stock_movements`** via `ALTER TABLE`. NOT encoded in `note`. Phase 1 rows have `due_at IS NULL`. Trigger on `borrow` movement_type enforces NOT NULL via BEFORE INSERT check. |
| **Q-Phase3-F** | Overdue Telegram grouping = **`settings.OVERDUE_GROUP_THRESHOLD = 10`** (configurable). When per-run overdue count > threshold, group into one Telegram message; otherwise one message per loan. |
| **Q-Phase3-G** | `due_at` default in UI = **3 days from now**. Quick presets: 1 / 3 (default) / 7 / กำหนดเอง. |

## Derived implementation constraints

1. `ALTER TABLE stock_movements ADD COLUMN due_at timestamptz` (nullable; Phase 1 rows unaffected)
2. `ALTER TABLE stock_movements ADD COLUMN borrower_username text` (nullable; default `app_username()` via BEFORE INSERT trigger when movement_type='borrow')
3. New table `stock_loans` per spec §5 with status enum (active|returned|overdue|cancelled)
4. RLS: drop+recreate `sm_insert_staff` to add `borrow`+`return` to allowed set
5. Trigger: BEFORE INSERT — when `movement_type='borrow'`, require `due_at NOT NULL`; when `movement_type='return'`, look up active loan for (item_id, performed_by) and update return-side columns
6. pg_cron job `overdue_loan_alert` runs 02:00 + 10:00 UTC (= 09:00 + 17:00 BKK)
7. Settings keys: `OVERDUE_GROUP_THRESHOLD` (default 10, seeded by migration)
8. Trigger error string (FE greps): `'ของยืมเลยกำหนด'` (when blocking double-borrow or unauthorized return)
9. Cloudinary folder: `thegood-stock/borrow/{loan_id}/`
10. shared/photo-capture.js component contract per UX §3.4 (Phase 5 will reuse)
11. Dashboard "สถานะอุปกรณ์ยืม-คืน" panel replaces Phase 1 placeholder; 3 rows (ยืมอยู่ / เกินกำหนด / คืนวันนี้)

## Out of scope (defer)
- Q-Phase3-F option C (always-individual messages)
- Proxy-return workflow (admin returning on behalf of staff) — Phase 3.1
- Multi-photo per movement — Phase 3.1
- Audit dashboard of advisory-skip rate — Phase 3.1
