-- repair-lot-drift-20261105.sql — one-off data repair. Trial by default (ends in ROLLBACK).
-- Run ONLY after the physical count confirms the expected end state below.
-- Change the last ROLLBACK to COMMIT to save. Stops without changes if the data moved.
--
-- Expected end state (ledger 2026-11-05 + physical count confirmed by Chittawan):
--   Miracid   กล่อง 3  2640077 x21   qty 6 → 21: restores the 09:11 write-off of 15 phantom units
--   Strong-K  กล่อง 1  2610243 x11   lot-only fix, qty stays 11
--   Ponstan   ROOM-C   nothing        lot-only fix, qty stays 0; Lot A global becomes 42 (22+20)
--
-- Only Miracid กล่อง 3 changes a location total (total Miracid 45 → 60).
-- Miracid กล่อง 1 is NOT touched: counted 15 of lot 2440429, as the system shows.
-- IV set ZN-007 is NOT here: waiting for a count per lot.
-- Gains run before losses so a location never dips below zero.

BEGIN;

CREATE TEMP TABLE repair_plan (ord int, sku text, loc text, lot text, mtype stock_movement_type, qd int) ON COMMIT DROP;
INSERT INTO repair_plan VALUES
  (1,'MED-MIR-20mg-TAB', 'BAG-ALS-006','2440429','adjustment_gain', 15),
  (1,'MED-STK-25gm-SA',  'BAG-ALS-004','1301263','adjustment_gain', 11),
  (1,'MED-PON-500mg-TAB','ROOM-C',     'Lot A',  'adjustment_gain', 20),
  (2,'MED-STK-25gm-SA',  'BAG-ALS-004','2610243','adjustment_loss',-11),
  (2,'MED-PON-500mg-TAB','ROOM-C',     '2607015','adjustment_loss',-20);

-- Stop if anything moved since the diagnostic (values from 2026-11-05).
DO $$
DECLARE
  r record;
  v bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('MED-MIR-20mg-TAB', 'BAG-ALS-006','2440429',-15),
    ('MED-MIR-20mg-TAB', 'BAG-ALS-006','2640077', 21),
    ('MED-MIR-20mg-TAB', 'BAG-ALS-004','2440429', 15),
    ('MED-STK-25gm-SA',  'BAG-ALS-004','1301263',-11),
    ('MED-STK-25gm-SA',  'BAG-ALS-004','2610243', 22),
    ('MED-PON-500mg-TAB','ROOM-C',     'Lot A',  -20),
    ('MED-PON-500mg-TAB','ROOM-C',     '2607015', 20)
  ) AS t(sku, loc, lot, want) LOOP
    SELECT COALESCE(SUM(sm.qty_delta), 0) INTO v
    FROM stock_movements sm
    JOIN stock_items si ON si.id = sm.item_id AND si.sku = r.sku
    JOIN locations   l  ON l.id  = sm.location_id AND l.code = r.loc
    JOIN stock_lots  sl ON sl.id = sm.lot_id AND sl.lot_number = r.lot AND sl.item_id = si.id;
    IF v <> r.want THEN
      RAISE EXCEPTION 'ยอดเปลี่ยนไปแล้ว ยังไม่ได้แก้อะไร: % % ล็อต % มี % (คาดว่า %)', r.sku, r.loc, r.lot, v, r.want;
    END IF;
  END LOOP;
END $$;

INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), si.id, l.id, p.mtype, p.qd, sl.id,
       'reconcile_lot', 'ซ่อมล็อตผิดจากการย้ายข้ามตำแหน่ง (audit 2026-11-05)', 'admin'
FROM repair_plan p
JOIN stock_items si ON si.sku = p.sku
JOIN locations   l  ON l.code = p.loc
JOIN stock_lots  sl ON sl.lot_number = p.lot AND sl.item_id = si.id
WHERE p.ord = 1;

INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), si.id, l.id, p.mtype, p.qd, sl.id,
       'reconcile_lot', 'ซ่อมล็อตผิดจากการย้ายข้ามตำแหน่ง (audit 2026-11-05)', 'admin'
FROM repair_plan p
JOIN stock_items si ON si.sku = p.sku
JOIN locations   l  ON l.code = p.loc
JOIN stock_lots  sl ON sl.lot_number = p.lot AND sl.item_id = si.id
WHERE p.ord = 2;

SET CONSTRAINTS ALL IMMEDIATE;

-- Result: compare with the expected end state above. location_qty must equal lots_sum on every row.
SELECT si.sku, l.code AS location, sil.qty AS location_qty,
       COALESCE(SUM(n.net), 0) AS lots_sum,
       string_agg(sl.lot_number || ' x' || n.net, ', ' ORDER BY sl.lot_number) AS lots
FROM (SELECT DISTINCT sku, loc FROM repair_plan) p
JOIN stock_items si ON si.sku = p.sku
JOIN locations   l  ON l.code = p.loc
JOIN stock_item_locations sil ON sil.item_id = si.id AND sil.location_id = l.id
LEFT JOIN LATERAL (
  SELECT lot_id, SUM(qty_delta) AS net FROM stock_movements
  WHERE item_id = si.id AND location_id = l.id AND lot_id IS NOT NULL
  GROUP BY lot_id HAVING SUM(qty_delta) <> 0
) n ON true
LEFT JOIN stock_lots sl ON sl.id = n.lot_id
GROUP BY si.sku, l.code, sil.qty
ORDER BY si.sku, l.code;

ROLLBACK;   -- trial. Change this word to COMMIT to save, after the count is confirmed.
