-- repair-ivset-zn007-20261109.sql — one-off data repair. Trial by default (ends in ROLLBACK).
-- Change the last ROLLBACK to COMMIT to save. Stops without changes if the data moved.
--
-- Audit alert every morning since 2026-11-06:
--   SUP-VAS-IVSET-20D @ ZN-007  lot 4240701 = -1   (location 8, other lots 9)
--
-- What happened (ledger, sql/diag-ivset-trail-20261109.sql):
--   Lot 4240701 had 2 in ZN-007 (both issued 15 Oct) and 1 that moved ZN-023 → ZN-016 on 14 Oct.
--   16 Oct and 3 Nov: issues recorded as "ZN-007, lot 4240701" while ZN-007 had none of that lot
--   (the old form listed lots from every location; blocked since the 2026-11-05 guard).
--   16 Oct was evened out on 28 Oct. 3 Nov is this alert.
--
-- Physical count (Chittawan 2026-11-09):
--   ZN-007: 4260501 x7, 4260101 x2, 4240701 x0   → 9 (system 8)
--   ZN-016: 4240701 x1 (reported as "4240101"), 4260108 x3, 4260501 x2 → 6 = system 6, NOT touched.
--   So the 3 Nov issue did not take a unit out of ZN-007 or ZN-016; where it came from is
--   unknown (only a count of the other IV Set locations would show it).
--
-- The script sets each listed (location, lot) to the counted number with compensating
-- adjustments; gains run before losses so the lot guard never sees a shortfall.
-- After COMMIT: ZN-007 = 9 (as counted), ZN-016 unchanged, audit silent.

BEGIN;

CREATE TEMP TABLE ivset_target (loc text, lot text, want int, PRIMARY KEY (loc, lot)) ON COMMIT DROP;
INSERT INTO ivset_target VALUES
  ('ZN-007', '4240701', 0),
  ('ZN-007', '4260101', 2),
  ('ZN-007', '4260501', 7);

-- Stop if anything moved since the 2026-11-09 diag, or a lot/location is missing.
DO $$
DECLARE
  v_item uuid;
  v_missing text;
  r record;
  v bigint;
BEGIN
  SELECT id INTO v_item FROM stock_items WHERE sku = 'SUP-VAS-IVSET-20D';
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'ไม่พบสินค้า SUP-VAS-IVSET-20D — ยังไม่ได้แก้อะไร';
  END IF;

  SELECT string_agg(t.loc || '/' || t.lot, ', ') INTO v_missing
  FROM ivset_target t
  WHERE NOT EXISTS (SELECT 1 FROM stock_lots sl WHERE sl.item_id = v_item AND sl.lot_number = t.lot)
     OR NOT EXISTS (SELECT 1 FROM locations l WHERE l.code = t.loc);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ไม่พบ % — ยังไม่ได้แก้อะไร', v_missing;
  END IF;

  -- Ledger values seen in the diag (2026-11-09).
  FOR r IN SELECT * FROM (VALUES
    ('ZN-007','4240701',-1), ('ZN-007','4260101',2), ('ZN-007','4260501',7), ('ZN-016','4240701',1)  -- ZN-016 checked, not changed
  ) AS t(loc, lot, was) LOOP
    SELECT COALESCE(SUM(sm.qty_delta), 0) INTO v
    FROM stock_movements sm
    JOIN locations  l  ON l.id  = sm.location_id AND l.code = r.loc
    JOIN stock_lots sl ON sl.id = sm.lot_id AND sl.lot_number = r.lot AND sl.item_id = v_item
    WHERE sm.item_id = v_item;
    IF v <> r.was THEN
      RAISE EXCEPTION 'ยอดเปลี่ยนไปแล้ว ยังไม่ได้แก้อะไร: % ล็อต % มี % (คาดว่า %)', r.loc, r.lot, v, r.was;
    END IF;
  END LOOP;
END $$;

-- Difference per (location, lot): counted minus ledger.
CREATE TEMP TABLE ivset_fix ON COMMIT DROP AS
SELECT si.id AS item_id, l.id AS location_id, sl.id AS lot_id, t.loc, t.lot,
       t.want - COALESCE((SELECT SUM(sm.qty_delta) FROM stock_movements sm
                          WHERE sm.item_id = si.id AND sm.location_id = l.id
                            AND sm.lot_id = sl.id), 0) AS diff
FROM ivset_target t
JOIN stock_items si ON si.sku = 'SUP-VAS-IVSET-20D'
JOIN locations   l  ON l.code = t.loc
JOIN stock_lots  sl ON sl.item_id = si.id AND sl.lot_number = t.lot;

INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), item_id, location_id, 'adjustment_gain', diff, lot_id,
       'reconcile_lot', 'ซ่อมล็อต IV Set ตามนับจริง 2026-11-09 (เบิก 3 พ.ย. คีย์ล็อต/ตำแหน่งผิด)', 'admin'
FROM ivset_fix WHERE diff > 0;

INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), item_id, location_id, 'adjustment_loss', diff, lot_id,
       'reconcile_lot', 'ซ่อมล็อต IV Set ตามนับจริง 2026-11-09 (เบิก 3 พ.ย. คีย์ล็อต/ตำแหน่งผิด)', 'admin'
FROM ivset_fix WHERE diff < 0;

SET CONSTRAINTS ALL IMMEDIATE;

-- Result. ZN-007: location 9, lots 4260101 x2 + 4260501 x7. ZN-016: 6 = 4240701 x1 + 4260108 x3 + 4260501 x2.
-- audit_issues_for_ivset must be 0 on every row.
SELECT l.code AS location,
       sil.qty AS location_qty,
       sl.lot_number AS lot,
       SUM(sm.qty_delta) AS lot_qty_here,
       (SELECT count(*) FROM v_stock_audit_issues a
         WHERE a.sku = 'SUP-VAS-IVSET-20D') AS audit_issues_for_ivset
FROM stock_movements sm
JOIN stock_items si ON si.id = sm.item_id AND si.sku = 'SUP-VAS-IVSET-20D'
JOIN locations   l  ON l.id  = sm.location_id
JOIN stock_lots  sl ON sl.id = sm.lot_id
LEFT JOIN stock_item_locations sil ON sil.item_id = si.id AND sil.location_id = l.id
WHERE l.code IN ('ZN-007', 'ZN-016')
GROUP BY l.code, sil.qty, sl.lot_number
HAVING SUM(sm.qty_delta) <> 0
ORDER BY l.code, sl.lot_number;

ROLLBACK;   -- trial. Change this word to COMMIT to save.
