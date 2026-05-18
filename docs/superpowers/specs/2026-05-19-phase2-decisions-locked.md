# Phase 2 — PM Decisions Locked

**Date locked:** 2026-05-19
**Locked by:** PM (user "Pex") via AskUserQuestion batch
**Source docs:**
- Spec: `docs/superpowers/specs/2026-05-18-phase2-medication-design.md` (BA, 968 lines)
- UX:   `docs/superpowers/designs/2026-05-18-phase2-ui-design.md` (UX, 1574 lines)

All 9 open questions resolved. Implementation can proceed. Plan-writer (BA)
and implementers (BE/FE) must treat these as binding.

---

## Data model (spec)

| ID | Decision | Source |
|---|---|---|
| **Q-Phase2-1** | `stock_lots`: `UNIQUE(item_id, lot_number)` — lot numbers unique **per item**, NOT global. Vendors can reuse same lot string across SKUs. | BA recommended |
| **Q-Phase2-2** | Recall workflow: **soft flag** (`status='recalled'`). Lot stays in `stock_item_locations` qty; UI + RLS block issue. NO quarantine-location move. | BA recommended |
| **Q-Phase2-3** | Auto-expire: **always-on**. Daily 09:00 Asia/Bangkok cron sets `status='expired'` for any lot whose `expiry_date < CURRENT_DATE` and `status='active'`. | BA recommended |
| **Q-Phase2-4** | **BEFORE INSERT trigger** on `stock_movements`: when `movement_type IN ('issue','adjustment_loss','borrow','transfer_out')` and `lot_id` is provided, look up `stock_lots.status`; if status in (`expired`,`recalled`) → `RAISE EXCEPTION 'ล็อตหมดอายุหรือถูกเรียกคืน'`. Belt-and-braces guards the race between 00:00 and 09:00 cron on expiry day. | BA recommended (Option A) |

## Patient safety / UX (design)

| ID | Decision | Source |
|---|---|---|
| **Q-D1** | **No force-issue override** in Phase 2. The 2-tap admin override designed in UX §3.7 (S-2.5) is **removed** from scope. Any future need for override goes to Phase 2.1 with a supervisor-PIN gate. | UX flagged as #1 patient-safety risk; PM concurs |
| **Q-D2** | **FEFO override warning toast** before submit when staff picks a non-FEFO lot. Copy: `"ล็อต {lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"` Modal confirm pattern. Audited in `stock_movements.reason` or new `fefo_override_confirmed=true` column. | UX recommended |

## Visual / layout (design)

| ID | Decision | Source |
|---|---|---|
| **Q-D3** | Badge `≤0 days (expired)` uses **`bg-stock-accent-subtle`** (teal-tinted neutral). Aligns with Phase 0 teal accent palette; distinguishes from green safe. | UX recommended |
| **Q-D4** | Lot picker shows **5 lots** by default (ordered FEFO), with `"ดูทั้งหมด ({n} ล็อต)"` accordion link to expand. Phone screen real-estate constraint; 99% of FEFO cases covered by top 5. | UX recommended |
| **Q-D5** | 4-segment tab (รายการสินค้า / รับเข้า / ล็อตยา / Timeline) at 360 px: **`overflow-x: auto` with edge-fade hint**, NO label shortening. Discoverability traded against unambiguous labels. | UX recommended |

---

## Derived implementation constraints

These follow from the above; implementers don't need to re-derive:

1. **Migration 1 (`stock_lots`):** PK `id uuid`, FK `item_id → stock_items` (RESTRICT), `lot_number text NOT NULL`, `expiry_date date NOT NULL`, `received_at timestamptz`, `received_qty int NOT NULL CHECK >0`, `current_qty int NOT NULL CHECK >=0`, `supplier text`, `note text`, `status stock_lot_status NOT NULL DEFAULT 'active'`, `recalled_reason text`, `recalled_by text`, `recalled_at timestamptz`, `created_at timestamptz`, `updated_at timestamptz`, `created_by text`, `updated_by text`. UNIQUE `(item_id, lot_number)`.

2. **Enum `stock_lot_status`:** `'active' | 'depleted' | 'expired' | 'recalled'`.

3. **`stock_movements.lot_id`** becomes a real FK to `stock_lots(id)` — was placeholder uuid in Phase 1. Add `ALTER TABLE stock_movements ADD CONSTRAINT fk_movements_lot ...` (DEFERRABLE INITIALLY DEFERRED to allow lot CREATE → movement INSERT in same transaction during receive).

4. **Required-when-tracks_lots check:** add `CHECK ((SELECT tracks_lots FROM stock_items WHERE id=item_id) IS FALSE OR lot_id IS NOT NULL OR movement_type NOT IN ('issue','adjustment_loss','borrow','transfer_out'))` — OR enforce via BEFORE INSERT trigger (cleaner; CHECK can't subquery in Postgres without immutable function). **Use trigger.**

5. **`apply_movement_to_sil` trigger from Phase 1 must be extended** to also update `stock_lots.current_qty` when `lot_id` is set. Wrap in same SECURITY DEFINER function.

6. **New trigger `check_lot_status` (BEFORE INSERT)** implements Q-Phase2-4 — see decisions table.

7. **`pg_cron` job `expiry_alert_daily`** runs at 09:00 Asia/Bangkok. Two-pass:
   - Pass A: `UPDATE stock_lots SET status='expired' WHERE status='active' AND expiry_date < CURRENT_DATE` (auto-expire per Q-Phase2-3).
   - Pass B: SELECT lots in [today, today+90d) grouped into 30/60/90 buckets, POST to `tg-notify` via `pg_net` — same pattern as Phase 1 low-stock trigger.

8. **`settings` table reads** for `NOTIFY_SUPABASE_URL` / `NOTIFY_SERVICE_ROLE_KEY` — match Phase 1 deviation per Project.md §8 gotcha 9.

9. **Categories seed extends:** `INSERT INTO stock_categories(code, name, sort_order) VALUES ('MEDICATION','ยา',50) ON CONFLICT (code) DO NOTHING`.

10. **Items master form:** add toggle `tracks_lots`. Edit-time warning when enabling on item with existing qty.

11. **FEFO override audit:** add `fefo_override boolean NOT NULL DEFAULT false` to `stock_movements`. UI confirm sets to true. Reportable via `SELECT count(*) WHERE fefo_override` for compliance.

---

## What's NOT in Phase 2 (deferred)

- Force-issue expired override (per Q-D1 — punted to Phase 2.1 with supervisor PIN)
- Quarantine-location workflow (per Q-Phase2-2 — soft flag only)
- Per-lot photo proof (Phase 3 borrow/return covers Cloudinary first)
- Per-vendor supplier table (Phase 2 uses free-text `supplier`)
- Lot label printing (read-only barcode use only, matches Phase 1)
- Bulk migration tool to flip `tracks_lots=true` for existing items (Admin sets per-item; one-time SQL snippet in plan if needed)

---

## Open questions reopened ONLY if implementation surfaces a blocker

If during BE/FE work an implementer discovers a contradiction or impossibility, escalate to PM with: (a) the decision number above, (b) the specific blocker, (c) two options + recommendation. Do NOT silently deviate.
