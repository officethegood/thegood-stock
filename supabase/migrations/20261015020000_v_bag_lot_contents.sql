-- supabase/migrations/20261015020000_v_bag_lot_contents.sql
-- Fix — "ล็อตยาในกระเป๋านี้" showed each lot's GLOBAL current_qty, not the qty
-- actually inside the bag.
--
-- Report (Chittawan 2026-10-15): the ALS Bag 1 detail listed NSS 0.9% 1000ml
-- lot 3J927 as "คงเหลือ 6" while the bag physically holds 1 (the other 5 are at
-- Stock/BIN-113 and other bags/zones). 3J927's stock_lots.current_qty is 6
-- (global, all locations), which is exactly what the bag list printed.
--
-- Root cause:
--   shared/bags.js getBagLotsAtLocation() took the item_ids at the bag location,
--   then selected those items' rows from stock_lots and showed current_qty —
--   a GLOBAL per-lot balance with no bag filter at all. It was also not
--   subtree-aware (item_ids came only from stock at the bag location itself).
--
-- Fix (this view + the matching shared/bags.js change):
--   v_bag_lot_contents aggregates the LEDGER per (bag, item, lot) over the bag's
--   WHOLE subtree (bag location + every descendant zone/bin), so qty_in_bag is
--   the real in-bag quantity of each lot. HAVING SUM(qty_delta) > 0 mirrors
--   v_item_location_lots (lots that net to <= 0 at/under the bag are omitted).
--   Carries lot_number/expiry/status + item name/sku/tracks_lots so the FE needs
--   one query.
--
-- Depends on: stock_movements ledger, stock_lots, stock_items, locations hierarchy.
-- Idempotent: CREATE OR REPLACE VIEW. SECURITY INVOKER (Postgres default) —
--   inherits caller RLS, like v_bag_contents / v_item_location_lots.

CREATE OR REPLACE VIEW v_bag_lot_contents AS
WITH RECURSIVE bag_subtree AS (
  SELECT l.id AS bag_location_id, l.id AS descendant_id
  FROM   locations l
  WHERE  l.type = 'bag'
  UNION ALL
  SELECT bs.bag_location_id, c.id
  FROM   bag_subtree bs
  JOIN   locations   c ON c.parent_id = bs.descendant_id
)
SELECT
  bs.bag_location_id,
  sm.item_id,
  sm.lot_id,
  sl.lot_number,
  sl.expiry_date,
  sl.status,
  si.name,
  si.sku,
  si.tracks_lots,
  SUM(sm.qty_delta) AS qty_in_bag
FROM   bag_subtree          bs
JOIN   stock_movements      sm ON sm.location_id = bs.descendant_id
                              AND sm.lot_id IS NOT NULL
JOIN   stock_lots           sl ON sl.id = sm.lot_id
JOIN   stock_items          si ON si.id = sm.item_id
GROUP  BY bs.bag_location_id, sm.item_id, sm.lot_id,
          sl.lot_number, sl.expiry_date, sl.status,
          si.name, si.sku, si.tracks_lots
HAVING SUM(sm.qty_delta) > 0;

COMMENT ON VIEW v_bag_lot_contents IS
  'Per (bag_location_id, item_id, lot_id) on-hand qty (qty_in_bag) summed from '
  'the ledger over the bag''s WHOLE subtree. Source for "ล็อตยาในกระเป๋านี้" so '
  'it shows the in-bag lot qty, not stock_lots.current_qty (global). '
  'HAVING SUM>0 (hides lots that net to <=0, like v_item_location_lots). '
  'SECURITY INVOKER. 20261015020000.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Compiles:
--    SELECT * FROM v_bag_lot_contents LIMIT 1;   -- no error
--
-- B) The reported bag — 3J927 should now read 1 (in-bag), not 6 (global):
--    SELECT sku, lot_number, qty_in_bag
--    FROM v_bag_lot_contents
--    WHERE bag_location_id = (SELECT id FROM locations WHERE code='BAG-ALS-001')
--    ORDER BY sku, expiry_date;
--
-- C) Cross-check one lot vs its global current_qty (they differ when the lot is
--    also stocked elsewhere):
--    SELECT v.lot_number, v.qty_in_bag, sl.current_qty AS global_qty
--    FROM v_bag_lot_contents v JOIN stock_lots sl ON sl.id = v.lot_id
--    WHERE v.bag_location_id = (SELECT id FROM locations WHERE code='BAG-ALS-001')
--      AND v.lot_number = '3J927';
