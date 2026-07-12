-- sql/audit-stock-consistency.sql
-- ตรวจความสอดคล้องของยอดสต็อกทั้งระบบในครั้งเดียว (read-only, ปลอดภัย 100%)
--
-- วิธีใช้: paste ทั้งไฟล์ใน Supabase Dashboard › SQL Editor › Run
-- ผลที่ถูกต้อง: ไม่มีแถวเลย (0 rows) — ยกเว้นเช็คข้อ 6 ซึ่งเป็นระดับ "ข้อมูล"
-- (ของไม่ระบุล็อตจากข้อมูลยุคก่อนระบบล็อต — ไม่ใช่ความผิดพลาดเสมอไป)
--
-- หลักการ: ledger (stock_movements) คือความจริงหนึ่งเดียว ทุกยอดแคช
-- (stock_lots.current_qty, stock_item_locations.qty) ต้องตรงกับผลรวม ledger
--
-- เขียนขึ้นหลังเหตุการณ์ double-apply (แก้โดย 20260712010000) เพื่อตรวจว่า
-- reconcile เก็บครบทุกตัวจริง และใช้ตรวจสุขภาพประจำได้ตลอด

WITH lot_ledger AS (
  -- ยอดจริงของแต่ละล็อตจาก ledger
  SELECT lot_id, SUM(qty_delta) AS qty
  FROM stock_movements
  WHERE lot_id IS NOT NULL
  GROUP BY lot_id
),
sil_ledger AS (
  -- ยอดจริงของแต่ละ (สินค้า, ตำแหน่ง) จาก ledger
  SELECT item_id, location_id, SUM(qty_delta) AS qty
  FROM stock_movements
  GROUP BY item_id, location_id
),
loc_lot_ledger AS (
  -- ยอดเฉพาะส่วนที่ระบุล็อต ของแต่ละ (สินค้า, ตำแหน่ง)
  SELECT item_id, location_id, SUM(qty_delta) AS qty
  FROM stock_movements
  WHERE lot_id IS NOT NULL
  GROUP BY item_id, location_id
)

-- 1) ยอดล็อต (current_qty) ไม่ตรง ledger  ← อาการของบั๊ก double-apply
SELECT '1. ยอดล็อตไม่ตรง ledger'        AS "ปัญหา",
       si.sku                            AS "SKU",
       si.name                           AS "สินค้า",
       NULL::text                        AS "ตำแหน่ง",
       sl.lot_number                     AS "ล็อต",
       sl.current_qty::text              AS "ยอดในระบบ",
       COALESCE(ll.qty, 0)::text         AS "ยอดที่ถูกต้อง",
       (sl.current_qty - COALESCE(ll.qty, 0))::text AS "ส่วนต่าง"
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
LEFT JOIN lot_ledger ll ON ll.lot_id = sl.id
WHERE sl.status <> 'recalled'
  AND sl.current_qty <> COALESCE(ll.qty, 0)

UNION ALL

-- 2) ล็อตถูกเรียกคืนแล้วแต่ยอดไม่เป็น 0 (recall ต้อง zero เสมอ)
SELECT '2. ล็อต recalled แต่ยอดไม่เป็น 0',
       si.sku, si.name, NULL, sl.lot_number,
       sl.current_qty::text, '0', sl.current_qty::text
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
WHERE sl.status = 'recalled'
  AND sl.current_qty <> 0

UNION ALL

-- 3) ยอดตามตำแหน่ง (stock_item_locations) ไม่ตรง ledger
SELECT '3. ยอดตำแหน่งไม่ตรง ledger',
       si.sku, si.name,
       COALESCE(loc.code, loc.name),
       NULL,
       COALESCE(s.qty, 0)::text,
       COALESCE(l.qty, 0)::text,
       (COALESCE(s.qty, 0) - COALESCE(l.qty, 0))::text
FROM sil_ledger l
FULL OUTER JOIN stock_item_locations s
  ON s.item_id = l.item_id AND s.location_id = l.location_id
JOIN stock_items si ON si.id = COALESCE(s.item_id, l.item_id)
JOIN locations  loc ON loc.id = COALESCE(s.location_id, l.location_id)
WHERE COALESCE(s.qty, 0) <> COALESCE(l.qty, 0)

UNION ALL

-- 4) สถานะล็อตขัดกับยอด: depleted แต่ยังมีของ / active แต่หมดแล้ว
SELECT '4. ล็อต depleted แต่ยังมียอดเหลือ',
       si.sku, si.name, NULL, sl.lot_number,
       ('qty=' || sl.current_qty || ', status=depleted'),
       'status ควรเป็น active/expired', ''
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
WHERE sl.status = 'depleted' AND sl.current_qty > 0

UNION ALL

SELECT '4. ล็อต active แต่ยอดเป็น 0 (เคยมีของออก)',
       si.sku, si.name, NULL, sl.lot_number,
       'qty=0, status=active',
       'status ควรเป็น depleted', ''
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
WHERE sl.status = 'active' AND sl.current_qty = 0
  AND EXISTS (SELECT 1 FROM stock_movements sm
              WHERE sm.lot_id = sl.id AND sm.qty_delta < 0)

UNION ALL

-- 5) ล็อต active ที่เลยวันหมดอายุ (cron 09:00 จะปรับเอง — ถ้าเกิน 1 วันถือว่าผิดปกติ)
SELECT '5. ล็อต active แต่เลยวันหมดอายุ',
       si.sku, si.name, NULL, sl.lot_number,
       ('หมดอายุ ' || sl.expiry_date || ', status=active'),
       'status ควรเป็น expired (cron จะปรับ)', ''
FROM stock_lots sl
JOIN stock_items si ON si.id = sl.item_id
WHERE sl.status = 'active'
  AND sl.expiry_date < CURRENT_DATE

UNION ALL

-- 6) [ข้อมูล ไม่ใช่ error] สินค้าคุมล็อตที่มีของ "ไม่ระบุล็อต" ค้างในตำแหน่ง
--    (ยอดตำแหน่งมากกว่าผลรวมล็อตที่ตำแหน่งนั้น — มักเป็นของรับเข้าก่อนยุคระบบล็อต
--     หรือย้ายโดยไม่เลือกล็อต) — ถ้ายอมรับได้ก็ปล่อยไว้ได้
SELECT '6. (ข้อมูล) ของไม่ระบุล็อตในตำแหน่ง',
       si.sku, si.name,
       COALESCE(loc.code, loc.name),
       NULL,
       s.qty::text,
       ('ระบุล็อตแล้ว ' || COALESCE(lll.qty, 0)),
       (s.qty - COALESCE(lll.qty, 0))::text
FROM stock_item_locations s
JOIN stock_items si ON si.id = s.item_id AND si.tracks_lots = true
JOIN locations  loc ON loc.id = s.location_id
LEFT JOIN loc_lot_ledger lll
  ON lll.item_id = s.item_id AND lll.location_id = s.location_id
WHERE s.qty <> COALESCE(lll.qty, 0)

ORDER BY 1, 2, 4;
