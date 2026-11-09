-- repair-ivset-zn007-20261109.sql — one-off data repair. Trial by default (ends in ROLLBACK).
-- Change the last ROLLBACK to COMMIT to save. Stops without changes if the data moved.
--
-- Audit alert every morning since 2026-11-06:
--   SUP-VAS-IVSET-20D @ ZN-007  lot 4240701 = -1   (location 8, other lots 9)
-- Physical count in ZN-007 by Chittawan 2026-11-09:
--   4260501 x7   4260101 x2   4240701 x0      → total 9 (system says 8)
--
-- The script sets each lot in ZN-007 to the counted number with compensating adjustments.
-- Gains run before losses so the lot guard never sees a shortfall.
-- After COMMIT: ZN-007 = 9, and the audit should no longer list this spot.
-- The result below also lists lot 4240701 in every other location, so it can be compared
-- with what is physically there (ALS Box 1 ชั้น 2).

BEGIN;

CREATE TEMP TABLE ivset_target (lot text PRIMARY KEY, want int) ON COMMIT DROP;
INSERT INTO ivset_target VALUES ('4240701', 0), ('4260101', 2), ('4260501', 7);

-- Stop if anything moved since the 2026-11-09 alert, or a lot is missing.
DO $$
DECLARE
  v_item uuid;
  v_loc  uuid;
  v_sil  int;
  v_bad  bigint;
  v_missing text;
BEGIN
  SELECT id INTO v_item FROM stock_items WHERE sku = 'SUP-VAS-IVSET-20D';
  SELECT id INTO v_loc  FROM locations   WHERE code = 'ZN-007';
  IF v_item IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'ไม่พบสินค้า SUP-VAS-IVSET-20D หรือตำแหน่ง ZN-007 — ยังไม่ได้แก้อะไร';
  END IF;

  SELECT string_agg(t.lot, ', ') INTO v_missing
  FROM ivset_target t
  WHERE NOT EXISTS (SELECT 1 FROM stock_lots sl WHERE sl.item_id = v_item AND sl.lot_number = t.lot);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ไม่พบล็อต % ของ IV Set — ยังไม่ได้แก้อะไร', v_missing;
  END IF;

  SELECT qty INTO v_sil FROM stock_item_locations WHERE item_id = v_item AND location_id = v_loc;
  SELECT COALESCE(SUM(sm.qty_delta), 0) INTO v_bad
  FROM stock_movements sm JOIN stock_lots sl ON sl.id = sm.lot_id
  WHERE sm.item_id = v_item AND sm.location_id = v_loc AND sl.lot_number = '4240701';
  IF COALESCE(v_sil, 0) <> 8 OR v_bad <> -1 THEN
    RAISE EXCEPTION 'ยอดเปลี่ยนไปแล้ว ยังไม่ได้แก้อะไร: ZN-007 มี % ชิ้น, ล็อต 4240701 = % (คาดว่า 8 และ -1)',
      COALESCE(v_sil, 0), v_bad;
  END IF;
END $$;

-- Difference per lot: counted minus what the ledger says is in ZN-007.
CREATE TEMP TABLE ivset_fix ON COMMIT DROP AS
SELECT si.id AS item_id, l.id AS location_id, sl.id AS lot_id, t.lot,
       t.want - COALESCE((SELECT SUM(sm.qty_delta) FROM stock_movements sm
                          WHERE sm.item_id = si.id AND sm.location_id = l.id
                            AND sm.lot_id = sl.id), 0) AS diff
FROM ivset_target t
JOIN stock_items si ON si.sku = 'SUP-VAS-IVSET-20D'
JOIN locations   l  ON l.code = 'ZN-007'
JOIN stock_lots  sl ON sl.item_id = si.id AND sl.lot_number = t.lot;

INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), item_id, location_id, 'adjustment_gain', diff, lot_id,
       'reconcile_lot', 'ซ่อมล็อต IV Set ZN-007 ตามนับจริง 2026-11-09 (audit lot -1)', 'admin'
FROM ivset_fix WHERE diff > 0;

INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), item_id, location_id, 'adjustment_loss', diff, lot_id,
       'reconcile_lot', 'ซ่อมล็อต IV Set ZN-007 ตามนับจริง 2026-11-09 (audit lot -1)', 'admin'
FROM ivset_fix WHERE diff < 0;

SET CONSTRAINTS ALL IMMEDIATE;

-- Result. ZN-007 rows must read: location 9, lots 4260101 x2 + 4260501 x7.
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
WHERE l.code = 'ZN-007' OR sl.lot_number = '4240701'
GROUP BY l.code, sil.qty, sl.lot_number
HAVING SUM(sm.qty_delta) <> 0 OR l.code = 'ZN-007'
ORDER BY (l.code = 'ZN-007') DESC, l.code, sl.lot_number;

ROLLBACK;   -- trial. Change this word to COMMIT to save.
