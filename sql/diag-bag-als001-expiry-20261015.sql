-- ============================================================================
-- DIAGNOSE why BAG-ALS-001 shows "หมดอายุ" — is the expired lot ACTUALLY in the
-- bag, or just somewhere in main stock (false alarm from the item-level rollup)?
-- Read-only.
-- ============================================================================

-- 1) Items in BAG-ALS-001 (subtree) + every expired/soon lot of those items,
--    and WHERE each lot's stock actually sits. "in_this_bag" = the expired lot
--    is physically in the bag (real). false = false alarm (lot is elsewhere).
WITH RECURSIVE bag AS (
  SELECT id FROM locations WHERE code = 'BAG-ALS-001'
),
subtree AS (                               -- the bag + all its zones/bins
  SELECT id FROM locations WHERE id = (SELECT id FROM bag)
  UNION ALL
  SELECT c.id FROM locations c JOIN subtree s ON c.parent_id = s.id
),
bag_items AS (
  SELECT DISTINCT item_id FROM v_bag_contents
  WHERE bag_location_id = (SELECT id FROM bag)
)
SELECT si.sku, si.name,
       sl.lot_number, sl.expiry_date, sl.status, sl.current_qty AS lot_qty_global,
       (sl.expiry_date < CURRENT_DATE) AS is_expired,
       COALESCE((
         SELECT SUM(sm.qty_delta) FROM stock_movements sm
         WHERE sm.lot_id = sl.id AND sm.location_id IN (SELECT id FROM subtree)
       ), 0) AS qty_of_this_lot_in_bag
FROM bag_items bi
JOIN stock_items si ON si.id = bi.item_id
JOIN stock_lots  sl ON sl.item_id = bi.item_id AND sl.status IN ('active','expired')
WHERE sl.expiry_date < CURRENT_DATE
ORDER BY sl.expiry_date, si.sku;

-- Reading the result:
--   qty_of_this_lot_in_bag > 0  => the expired lot IS in the bag → ต้องเอาออก/เปลี่ยน (ของจริง)
--   qty_of_this_lot_in_bag = 0  => ล็อตหมดอายุอยู่ที่อื่น ไม่ได้อยู่ในกระเป๋า → badge หลอกตา (ควรแก้ view ให้แม่น)
