-- supabase/migrations/20261105030000_bag_status_expiry_before_template.sql
-- Fix: a bag with expired stock but no template showed only a grey "ไม่มีเทมเพลต".
--
-- Report: ALS Airway holds stock that expired in 2565, yet its badge was never red
-- and run_bag_status_alert (which filters on low_stock/expiring/expired) never sent it.
-- Expiry needs no template, and it is a safety issue, so it must win.
--
-- Change: alert_level checks expired, then expiring, then no_template.
-- Body is a VERBATIM copy of the latest view (20261026010000) with only that reorder.
-- Effect: no-template bags with expired/expiring stock now turn red/orange and enter the
-- 09:00 alert. No-template bags with nothing expiring stay "ไม่มีเทมเพลต".
-- Depends on: 20261026010000, 20261015020000. Idempotent: CREATE OR REPLACE VIEW.

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
    WHEN COALESCE(be.expired_lots_count,  0) > 0        THEN 'expired'
    WHEN COALESCE(be.expiring_30d_count,  0) > 0        THEN 'expiring'
    WHEN bl.bag_template_id IS NULL                     THEN 'no_template'
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

-- Verification (last statement, so the SQL Editor shows it):
SELECT bag_code, bag_name, nearest_expiry, expired_lots_count, expiring_30d_count, alert_level
FROM   v_bag_status
WHERE  bag_active
ORDER  BY bag_code;
