-- supabase/migrations/20261026010000_v_bag_status_precise_expiry.sql
-- Fix — the bag "หมดอายุ" / "ใกล้หมด" badge counted expired lots by ITEM across
-- the whole system, so a bag flagged expired even when its own stock was fine.
--
-- Report (Chittawan 2026-10-26): BAG-ALS-001 AND BAG-DUG-001 both show "หมดอายุ"
-- even though the expired unit is only physically in one of them (they share the
-- "Emergency Bag 1" template, so they hold the same item types).
--
-- Root cause:
--   v_bag_status.bag_expiry (20260715050000) rolled up expiry like this:
--     FROM v_bag_contents vbc
--     LEFT JOIN stock_lots sl ON sl.item_id = vbc.item_id AND sl.status IN (...)
--   The join is by item_id, so EVERY lot of any item in the bag was counted —
--   including lots sitting in main stock or in OTHER bags. One expired lot of a
--   shared item anywhere → every bag holding that item reads "หมดอายุ". This was
--   the per-(location,lot) imprecision explicitly deferred in 20260715050000.
--
-- Fix:
--   Source bag_expiry from v_bag_lot_contents (20261015020000) instead — it is
--   the per-(bag, item, lot) in-bag quantity from the ledger (qty_in_bag > 0),
--   so only lots PHYSICALLY in the bag's subtree are counted. nearest_expiry,
--   expired_lots_count and expiring_30d_count now reflect the bag's own stock.
--   Everything else in v_bag_status (bag_locs, deficit via v_bag_contents, the
--   final SELECT and alert_level) is copied VERBATIM from 20260715050000.
--
-- Effect: a bag shows "หมดอายุ" ONLY when an expired lot is actually inside it
--   (e.g. BAG-ALS-001 still has the expired 50% Glucose until it is issued out);
--   a bag whose expired-lot twin lives elsewhere goes back to its true status.
--
-- Depends on: 20260715050000 (v_bag_contents + the v_bag_status this replaces),
--             20261015020000 (v_bag_lot_contents). APPLY those first.
-- Idempotent: CREATE OR REPLACE VIEW. SECURITY INVOKER (Postgres default).

CREATE OR REPLACE VIEW v_bag_status AS
WITH

bag_locs AS (
  SELECT
    l.id              AS location_id,
    l.code            AS bag_code,
    l.name            AS bag_name,
    l.bag_template_id,
    bt.code           AS template_code,
    bt.name           AS template_name,
    l.active          AS bag_active
  FROM   locations    l
  LEFT   JOIN bag_templates bt ON bt.id = l.bag_template_id
  WHERE  l.type = 'bag'
),

-- Per-bag mandatory item deficit — actual qty from the subtree aggregate
-- v_bag_contents (unchanged from 20260715050000).
deficit AS (
  SELECT
    bl.location_id,
    COUNT(*) FILTER (
      WHERE bti.mandatory = true
        AND COALESCE(vbc.qty, 0) < bti.target_qty
    )                                                   AS mandatory_deficit_count,
    COUNT(*) FILTER (WHERE bti.mandatory = true)        AS mandatory_total,
    SUM(bti.target_qty)
      FILTER (WHERE bti.mandatory = true)               AS total_target_mandatory,
    SUM(COALESCE(vbc.qty, 0))
      FILTER (WHERE bti.mandatory = true)               AS total_actual_mandatory
  FROM   bag_locs                    bl
  LEFT   JOIN bag_template_items     bti
    ON   bti.bag_template_id = bl.bag_template_id
  LEFT   JOIN v_bag_contents         vbc
    ON   vbc.bag_location_id = bl.location_id
    AND  vbc.item_id         = bti.item_id
  GROUP  BY bl.location_id
),

-- Per-bag expiry rollup — 20261026010000: now sourced from v_bag_lot_contents
-- (lots PHYSICALLY in the bag's subtree, qty_in_bag > 0), not an item-level
-- join against all stock_lots. Only active/expired lots count (recalled/depleted
-- excluded), matching the previous semantics.
bag_expiry AS (
  SELECT
    vblc.bag_location_id                                AS location_id,
    MIN(vblc.expiry_date) FILTER (
      WHERE vblc.status IN ('active', 'expired')
    )                                                   AS nearest_expiry,
    COUNT(*) FILTER (
      WHERE vblc.expiry_date < CURRENT_DATE
        AND vblc.status IN ('active', 'expired')
    )                                                   AS expired_lots_count,
    COUNT(*) FILTER (
      WHERE vblc.expiry_date >= CURRENT_DATE
        AND (vblc.expiry_date - CURRENT_DATE) <= 30
        AND vblc.status IN ('active', 'expired')
    )                                                   AS expiring_30d_count
  FROM   v_bag_lot_contents vblc
  GROUP  BY vblc.bag_location_id
)

SELECT
  bl.location_id,
  bl.bag_code,
  bl.bag_name,
  bl.bag_template_id,
  bl.template_code,
  bl.template_name,
  bl.bag_active,

  CASE
    WHEN COALESCE(d.mandatory_total, 0) = 0
      THEN NULL
    ELSE ROUND(
      100.0 * COALESCE(d.total_actual_mandatory, 0)
            / NULLIF(d.total_target_mandatory, 0)
    )
  END                                                 AS completion_pct,

  COALESCE(d.mandatory_deficit_count, 0)             AS mandatory_deficit_count,
  COALESCE(d.mandatory_total, 0)                     AS mandatory_total,

  be.nearest_expiry,
  COALESCE(be.expired_lots_count,  0)                AS expired_lots_count,
  COALESCE(be.expiring_30d_count,  0)                AS expiring_30d_count,

  CASE
    WHEN bl.bag_template_id IS NULL                     THEN 'no_template'
    WHEN COALESCE(be.expired_lots_count,  0) > 0        THEN 'expired'
    WHEN COALESCE(be.expiring_30d_count,  0) > 0        THEN 'expiring'
    WHEN COALESCE(d.mandatory_deficit_count, 0) > 0     THEN 'low_stock'
    ELSE                                                     'complete'
  END                                                 AS alert_level

FROM   bag_locs  bl
LEFT   JOIN deficit    d  ON d.location_id  = bl.location_id
LEFT   JOIN bag_expiry be ON be.location_id = bl.location_id;

COMMENT ON VIEW v_bag_status IS
  'Phase 4. Per-bag-location aggregated status. 20261026010000: expiry rollup '
  '(nearest_expiry / expired_lots_count / expiring_30d_count) now counts only '
  'lots PHYSICALLY in the bag via v_bag_lot_contents, not every lot of the item '
  'across the system. deficit still from v_bag_contents (subtree). alert_level: '
  'complete | low_stock | expiring | expired | no_template.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Compiles:
--    SELECT * FROM v_bag_status LIMIT 1;   -- no error
--
-- B) The two reported bags — alert_level now reflects their OWN stock. A bag is
--    'expired' only if an expired lot is actually inside it:
--    SELECT bag_code, nearest_expiry, expired_lots_count, expiring_30d_count, alert_level
--    FROM v_bag_status WHERE bag_code IN ('BAG-ALS-001','BAG-DUG-001');
--
-- C) For any bag still 'expired', list the actual expired lot(s) IN the bag
--    (these are real — issue them out to clear the badge):
--    SELECT b.code AS bag_code, v.sku, v.lot_number, v.expiry_date, v.qty_in_bag
--    FROM v_bag_lot_contents v
--    JOIN locations b ON b.id = v.bag_location_id
--    WHERE v.expiry_date < CURRENT_DATE AND v.status IN ('active','expired')
--    ORDER BY b.code, v.expiry_date;
