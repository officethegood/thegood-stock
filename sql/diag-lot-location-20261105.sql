-- diag-lot-location-20261105.sql — READ-ONLY. One query, run the whole file.
-- A = (location, lot) spots whose ledger is negative right now (needs a physical count to repair)
-- B = stock on lot-tracked items with no lot (cannot be taken out once the guard is on)
-- C = movement history of Miracid + Strong-K since 2026-10-20 (how they got this way)
WITH lot_net AS (
  SELECT item_id, location_id, lot_id, SUM(qty_delta) AS net
  FROM   stock_movements
  WHERE  lot_id IS NOT NULL
  GROUP  BY item_id, location_id, lot_id
),
neg_spots AS (
  SELECT DISTINCT item_id, location_id FROM lot_net WHERE net < 0
),
no_lot AS (
  SELECT sm.item_id, sm.location_id, SUM(sm.qty_delta) AS net
  FROM   stock_movements sm
  JOIN   stock_items si ON si.id = sm.item_id AND si.tracks_lots
  WHERE  sm.lot_id IS NULL
  GROUP  BY sm.item_id, sm.location_id
  HAVING SUM(sm.qty_delta) > 0
)
SELECT 'A' AS section, si.sku, l.code AS location, l.name AS location_name,
       sl.lot_number, ln.net AS qty, sil.qty AS location_qty,
       NULL::text AS movement, NULL::timestamptz AS at, NULL::text AS by_user
FROM   neg_spots ns
JOIN   lot_net ln ON ln.item_id = ns.item_id AND ln.location_id = ns.location_id AND ln.net <> 0
JOIN   stock_items si ON si.id = ns.item_id
JOIN   locations   l  ON l.id  = ns.location_id
JOIN   stock_lots  sl ON sl.id = ln.lot_id
LEFT   JOIN stock_item_locations sil ON sil.item_id = ns.item_id AND sil.location_id = ns.location_id
UNION ALL
SELECT 'B', si.sku, l.code, l.name, '(ไม่มีล็อต)', nl.net, sil.qty, NULL, NULL, NULL
FROM   no_lot nl
JOIN   stock_items si ON si.id = nl.item_id
JOIN   locations   l  ON l.id  = nl.location_id
JOIN   stock_item_locations sil ON sil.item_id = nl.item_id AND sil.location_id = nl.location_id AND sil.qty > 0
UNION ALL
SELECT 'C', si.sku, l.code, l.name, sl.lot_number, sm.qty_delta, sm.qty_after,
       sm.movement_type::text, sm.performed_at, sm.performed_by
FROM   stock_movements sm
JOIN   stock_items si ON si.id = sm.item_id
JOIN   locations   l  ON l.id  = sm.location_id
LEFT   JOIN stock_lots sl ON sl.id = sm.lot_id
WHERE  si.sku IN ('MED-MIR-20mg-TAB', 'MED-STK-25gm-SA')
  AND  sm.performed_at >= '2026-10-20'
ORDER  BY section, sku, at NULLS FIRST, location, lot_number;
