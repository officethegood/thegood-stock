-- diag-ivset-trail-20261109.sql — read-only. Answers: did IV Set lot 4240701 go negative in
-- ZN-007 BEFORE or AFTER the lot guard (applied 2026-11-05)? If after, the guard has a hole.
-- Also counts historic movements whose lot belongs to a different item (could hide drift
-- from the guard). Only the last SELECT shows in the SQL Editor, so this is one query.

WITH iv AS (SELECT id FROM stock_items WHERE sku = 'SUP-VAS-IVSET-20D'),
trail AS (
  SELECT sm.performed_at AT TIME ZONE 'Asia/Bangkok' AS when_bkk,
         l.code AS location, sm.movement_type::text AS type, sl.lot_number AS lot,
         sm.qty_delta,
         SUM(sm.qty_delta) OVER (PARTITION BY sm.location_id, sm.lot_id
                                 ORDER BY sm.performed_at, sm.id) AS lot_here_after,
         sm.performed_by AS who, left(COALESCE(sm.note, sm.reason, ''), 60) AS note
  FROM stock_movements sm
  JOIN iv ON iv.id = sm.item_id
  JOIN locations l ON l.id = sm.location_id
  LEFT JOIN stock_lots sl ON sl.id = sm.lot_id
  WHERE l.code IN ('ZN-007', 'ZN-016') OR sl.lot_number = '4240701'
)
SELECT t.*,
       (SELECT count(*) FROM stock_movements m JOIN stock_lots x ON x.id = m.lot_id
         WHERE x.item_id <> m.item_id) AS wrong_item_lot_rows_all_items
FROM trail t
ORDER BY t.when_bkk;
