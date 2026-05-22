-- supabase/migrations/20260522000000_v_item_location_lots.sql
-- Per-(item, location, lot) on-hand quantity, computed from the stock_movements
-- ledger.
--
-- Why:
--   stock_lots has no location column — a lot belongs to an item, not a place.
--   But every stock_movements row carries BOTH location_id (NOT NULL) and
--   lot_id (set for lot-tracked receive / issue / transfer / adjustment_loss).
--   So the on-hand quantity of a given lot at a given location is
--   SUM(qty_delta) over that (item, location, lot). This view surfaces that so
--   the item detail drawer can show which lot actually sits in which location,
--   instead of repeating the whole item-level lot list under every location.
--
-- Unlotted stock:
--   Movement rows with lot_id IS NULL (e.g. adjustment_gain, or pre-Phase-2
--   stock) are excluded here. The FE derives the per-location unlotted
--   remainder as stock_item_locations.qty minus the sum of this view's rows
--   for that location, and shows it as a separate "ไม่ระบุล็อต" line.
--
-- RLS: SECURITY INVOKER view (Postgres default) — inherits the caller's RLS on
--   stock_movements and stock_lots. No separate policy needed (mirrors
--   v_lots_with_remaining, 20260519010500).
--
-- Depends on:
--   stock_movements + lot_id FK (20260518010300, 20260519010200)
--   stock_lots                  (20260519010100)
--
-- Idempotent: CREATE OR REPLACE VIEW.

CREATE OR REPLACE VIEW v_item_location_lots AS
SELECT
  sm.item_id,
  sm.location_id,
  sm.lot_id,
  sl.lot_number,
  sl.expiry_date,
  sl.status                       AS lot_status,
  SUM(sm.qty_delta)               AS qty,
  (sl.expiry_date - CURRENT_DATE) AS days_until_expiry
FROM stock_movements sm
JOIN stock_lots sl ON sl.id = sm.lot_id
WHERE sm.lot_id IS NOT NULL
GROUP BY sm.item_id, sm.location_id, sm.lot_id,
         sl.lot_number, sl.expiry_date, sl.status
HAVING SUM(sm.qty_delta) > 0;

COMMENT ON VIEW v_item_location_lots IS
  'Per-(item, location, lot) on-hand qty = SUM(stock_movements.qty_delta) over '
  'rows that carry a lot_id. Lets the item drawer show which lot sits in which '
  'location. Unlotted stock (lot_id NULL) is excluded — the FE derives the '
  'per-location unlotted remainder from stock_item_locations.qty. '
  'SECURITY INVOKER — inherits caller RLS on stock_movements / stock_lots.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) View exists and is queryable:
--    SELECT count(*) FROM v_item_location_lots;
--    Expected: no error.
--
-- B) Reported case — Activated charcoal 260 mg (MED-CHA-260mg-TAB):
--    SELECT location_id, lot_number, qty
--    FROM v_item_location_lots
--    WHERE item_id = (SELECT id FROM stock_items WHERE sku = 'MED-CHA-260mg-TAB');
--    Expected: one row — the Box1 location, lot TEST001, qty 10.
--    Sparepart has no lotted movement so it does NOT appear here; its 198
--    pieces are unlotted and the FE renders them as "ไม่ระบุล็อต 198 ชิ้น".
