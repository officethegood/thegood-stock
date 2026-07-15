-- sql/audit-preflight-remediation.sql
-- Pre-flight audit (READ-ONLY) for the Tier-B guard migrations.
--
-- วิธีใช้: paste ทั้งไฟล์ใน Supabase Dashboard › SQL Editor › Run — *ก่อน* apply
--   migration Tier-B ชุดถัดไป. ทั้ง 4 เช็คควรคืน 0 rows (ideal).
--   ถ้าเช็คไหนคืนแถว → มีข้อมูลเก่าที่ guard ใหม่จะ reject/ผิดสัญญา ต้องเคลียร์/
--   ตัดสินใจก่อน ไม่ใช่รีบ apply.
--
-- ไฟล์นี้ SELECT-รายงานอย่างเดียว ไม่แก้ข้อมูลใด ๆ (ไม่มี INSERT/UPDATE/DELETE/DDL).
-- เป็นสคริปต์ตรวจ ไม่ใช่ migration — จึงอยู่ใน sql/ ไม่ใช่ supabase/migrations/.
--
-- Assumptions (verified against migrations 2026-05-18 → 2026-07-12):
--   * stock_movements(item_id, lot_id, movement_type, reason, note, expired_ack, qty_delta)
--   * stock_lots(id, item_id)
--   * stock_items(id, category_id) → stock_categories(id, code); LINEN code seeded
--     20260519060000. Canonical linen join used across the repo:
--       JOIN stock_categories sc ON sc.id = si.category_id AND sc.code = 'LINEN'
--   * stock_loans(id, qty, movement_id_borrow, movement_id_return) — a return
--     movement closes exactly one loan via stock_loans.movement_id_return
--     (close_loan_from_return, 20260519030300). Loan qty = ABS(borrow qty_delta).
--   Postgres 15. No extensions required (pure SELECT).

-- ==========================================================================
-- (a) lot/item mismatch — a movement points at a lot that belongs to a
--     DIFFERENT item than the movement's own item_id.
--     Non-zero ⇒ historic rows would violate a Tier-B "lot.item_id must equal
--     movement.item_id" guard. These are genuine data errors — the lot qty and
--     the item-location qty were moved for two different items. Investigate each
--     before applying the guard (the guard would start rejecting new inserts,
--     but these existing rows are already in the ledger).
-- ==========================================================================
SELECT
  m.id            AS movement_id,
  m.item_id       AS movement_item_id,
  sl.item_id      AS lot_item_id,
  m.lot_id,
  m.movement_type,
  m.qty_delta,
  m.performed_at
FROM stock_movements m
JOIN stock_lots sl ON sl.id = m.lot_id
WHERE m.lot_id IS NOT NULL
  AND sl.item_id <> m.item_id
ORDER BY m.performed_at;

-- ==========================================================================
-- (b) expired issue with no reason — expired_ack=true but note is blank.
--     Policy (20260712020000): เบิกของหมดอายุได้เฉพาะเมื่อ FE ตั้ง expired_ack=true
--     และผู้ใช้พิมพ์เหตุผล (เหตุผลถูก prefix ลง note). แถวที่ ack=true แต่ note ว่าง
--     คือการ ack ที่ไม่มีเหตุผลบันทึกไว้.
--     Non-zero ⇒ historic acked-but-unexplained issues exist; a Tier-B guard that
--     requires a non-empty note whenever expired_ack=true would reject them.
--     Decide whether to backfill a note or exempt pre-guard rows before applying.
-- ==========================================================================
SELECT
  m.id            AS movement_id,
  m.item_id,
  m.lot_id,
  m.movement_type,
  m.expired_ack,
  m.note,
  m.performed_by,
  m.performed_at
FROM stock_movements m
WHERE m.expired_ack = true
  AND btrim(coalesce(m.note, '')) = ''
ORDER BY m.performed_at;

-- ==========================================================================
-- (c) laundry_in on a non-LINEN item — an adjustment_gain carrying
--     reason='laundry_in' whose item is NOT in the LINEN category.
--     The Staff RLS gain path (20260519060600) only *permits* the combination
--     (adjustment_gain AND reason='laundry_in'); it does NOT check the item is a
--     linen. A Tier-B guard tightening laundry_in to LINEN items only would
--     reject these historic rows.
--     Non-zero ⇒ laundry returns were booked against non-linen items (or items
--     with NULL category). Reclassify the items or correct the movements first.
--     NOTE: if the LINEN category or its items were never seeded, every laundry_in
--     row surfaces here — confirm LINEN membership before treating as errors.
-- ==========================================================================
SELECT
  m.id            AS movement_id,
  m.item_id,
  si.sku,
  si.name,
  sc.code         AS category_code,
  m.reason,
  m.qty_delta,
  m.performed_at
FROM stock_movements m
JOIN stock_items si       ON si.id = m.item_id
LEFT JOIN stock_categories sc ON sc.id = si.category_id
WHERE m.movement_type = 'adjustment_gain'
  AND m.reason = 'laundry_in'
  AND si.category_id IS DISTINCT FROM (SELECT id FROM stock_categories WHERE code = 'LINEN')
ORDER BY m.performed_at;

-- ==========================================================================
-- (d) duplicate / partial returns.
--     A loan is closed by exactly one return movement (stock_loans.movement_id_return,
--     close_loan_from_return 20260519030300) and the returned qty should equal the
--     loan qty. A Tier-B guard enforcing "one return per loan, matching qty" would
--     reject historic violations of either shape. Two sub-checks:
--
--   (d-1) partial / over return — the return movement that closed a loan moved a
--         qty different from the loan's qty. Non-zero ⇒ a loan was closed with the
--         wrong quantity (stock_lots / stock_item_locations may be off for it).
-- ==========================================================================
SELECT
  l.id                AS loan_id,
  l.item_id,
  l.borrower_username,
  l.qty               AS loan_qty,
  m.id                AS return_movement_id,
  ABS(m.qty_delta)    AS return_qty,
  l.status,
  l.returned_at
FROM stock_loans l
JOIN stock_movements m ON m.id = l.movement_id_return
WHERE ABS(m.qty_delta) <> l.qty
ORDER BY l.returned_at;

--   (d-2) duplicate return linkage — a single return movement recorded as the
--         closing return of MORE THAN ONE loan. Structurally each return closes
--         one loan, so any group here is a data anomaly (a return double-counted
--         across loans). Non-zero ⇒ investigate the shared movement_id_return.
SELECT
  l.movement_id_return,
  count(*)                              AS loans_closed_by_this_return,
  array_agg(l.id ORDER BY l.borrowed_at) AS loan_ids
FROM stock_loans l
WHERE l.movement_id_return IS NOT NULL
GROUP BY l.movement_id_return
HAVING count(*) > 1;

-- ==========================================================================
-- End of pre-flight audit. Ideal result: all five result sets return 0 rows.
-- Any non-zero result set must be reconciled (or explicitly exempted) BEFORE
-- applying the Tier-B guard migrations.
-- ==========================================================================
