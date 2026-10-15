-- ============================================================================
-- DIAGNOSE: bag stuck on a vehicle (can't return) + items can't be issued
-- Read-only. Run all 4 blocks, paste results back.
-- ============================================================================

-- 1) Every bag whose parent is currently an ambulance, and whether it has a
--    usable return-home in bag_moves. "home_ok=false" = the stuck case.
SELECT b.code AS bag_code, b.name AS bag_name, b.id AS bag_id,
       amb.code AS on_vehicle, b.parent_id AS parent_id,
       dep.from_parent_id AS recorded_home_id,
       home.code AS recorded_home_code,
       (dep.from_parent_id IS NOT NULL) AS home_ok,
       dep.moved_at AS last_deploy_at
FROM locations b
JOIN locations amb ON amb.id = b.parent_id AND amb.type = 'ambulance'
LEFT JOIN LATERAL (
  SELECT from_parent_id, moved_at FROM bag_moves
  WHERE bag_location_id = b.id AND action = 'deploy'
  ORDER BY moved_at DESC LIMIT 1
) dep ON true
LEFT JOIN locations home ON home.id = dep.from_parent_id
WHERE b.type = 'bag'
ORDER BY b.code;

-- 2) Full bag_moves history for bags named like "bag 1" / AIS / ALS (adjust ILIKE
--    if the bag has a different name).
SELECT bm.moved_at, b.code AS bag_code, b.name AS bag_name,
       bm.action, fp.code AS from_code, tp.code AS to_code, bm.moved_by
FROM bag_moves bm
JOIN locations b  ON b.id  = bm.bag_location_id
LEFT JOIN locations fp ON fp.id = bm.from_parent_id
LEFT JOIN locations tp ON tp.id = bm.to_parent_id
WHERE b.name ILIKE '%bag%' OR b.name ILIKE '%ALS%' OR b.name ILIKE '%AIS%'
ORDER BY b.code, bm.moved_at DESC;

-- 3) Contents of the stuck bag(s) (subtree-aware). Replace :BAG_ID with the
--    bag_id from block 1, OR run as-is to see all bags on a vehicle.
SELECT b.code AS bag_code, vbc.sku, si.name, vbc.qty
FROM v_bag_contents vbc
JOIN locations b     ON b.id = vbc.bag_location_id
JOIN stock_items si  ON si.id = vbc.item_id
WHERE b.type = 'bag'
  AND b.parent_id IN (SELECT id FROM locations WHERE type = 'ambulance')
ORDER BY b.code, vbc.sku;

-- 4) NSS 1000ml — real sil per location + per-location-lot net (is it phantom?)
--    "ผิดนะ เป็น nss injection 1000 ml" — check what the bag actually holds vs lots.
SELECT si.sku, si.name, l.code AS location, sil.qty AS sil_qty,
       lot.lot_number, lot.net AS lot_net
FROM stock_items si
JOIN stock_item_locations sil ON sil.item_id = si.id
JOIN locations l ON l.id = sil.location_id
LEFT JOIN LATERAL (
  SELECT sl.lot_number, SUM(sm.qty_delta) AS net
  FROM stock_movements sm JOIN stock_lots sl ON sl.id = sm.lot_id
  WHERE sm.item_id = si.id AND sm.location_id = sil.location_id AND sm.lot_id IS NOT NULL
  GROUP BY sl.lot_number
) lot ON true
WHERE si.sku ILIKE '%NSS%' OR si.name ILIKE '%NSS%' OR si.name ILIKE '%normal salin%'
ORDER BY si.sku, l.code, lot.lot_number;
