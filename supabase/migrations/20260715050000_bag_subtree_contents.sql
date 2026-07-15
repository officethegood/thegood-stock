-- supabase/migrations/20260715050000_bag_subtree_contents.sql
-- Fix — a bag's checklist counted only stock pinned DIRECTLY at the bag
-- location, ignoring stock in zones/sub-locations INSIDE the bag.
--
-- Report (Chittawan 2026-07-15): BAG-DUG-001 shows SSCOR + Kingon O2 as
-- "ขาด 1" (0/1) even though each item's detail says "รวม 1 ชิ้น ใน โซน
-- Emergency Bag 1 › ในกระเป๋า" — i.e. the items ARE inside the bag, but in a
-- child zone ("ในกระเป๋า", type=zone under the bag, D3 "โซนใน bag").
--
-- Root cause:
--   v_bag_status.deficit (20260519040300) joins stock_item_locations on
--   sil.location_id = <bag location id> ONLY. A location hierarchy lets a bag
--   hold zones/bins (D3/D10 auto-migrate re-homes a bag's direct stock into a
--   new sub-location). Stock in those children has sil.location_id = <child>,
--   so the flat join misses it → COALESCE(qty,0)=0 → the item reads as missing.
--   Same flat assumption in shared/bags.js getBagComposition / getBagActualContents.
--
-- Fix (this migration + the matching shared/bags.js change):
--   Count a bag's contents across its WHOLE subtree — the bag location plus
--   every descendant. A new view v_bag_contents aggregates SUM(qty) per
--   (bag_location_id, item_id) over the recursive subtree; v_bag_status is
--   rewritten to source its deficit and expiry rollups from it. "อยู่ในโซน
--   ข้างในกระเป๋า" now correctly counts as "อยู่ในกระเป๋า".
--   Bags with no sub-locations are unaffected (subtree = just the bag).
--
-- NOT changed (out of scope): the per-(location,lot) expiry precision issue
--   (a bag's nearest_expiry still rolls up lots by item across the system, same
--   as the original view) and the transfer picker's leaf-only rule.
--
-- Depends on: 20260519040300_v_bag_status.sql (the view this replaces),
--             locations parent hierarchy (Phase 0.7).
-- Idempotent: CREATE OR REPLACE VIEW ×2. SECURITY INVOKER (Postgres default) —
--   both views inherit the caller's RLS on locations / stock_item_locations /
--   stock_items / stock_lots, mirroring the other v_* views.

-- ==========================================================================
-- 1) v_bag_contents — per (bag, item) on-hand qty across the bag's subtree
-- ==========================================================================

CREATE OR REPLACE VIEW v_bag_contents AS
WITH RECURSIVE bag_subtree AS (
  -- anchor: every bag maps to itself
  SELECT l.id AS bag_location_id, l.id AS descendant_id
  FROM   locations l
  WHERE  l.type = 'bag'
  UNION ALL
  -- walk down: any location whose parent is already in the subtree
  SELECT bs.bag_location_id, c.id
  FROM   bag_subtree bs
  JOIN   locations   c ON c.parent_id = bs.descendant_id
)
SELECT
  bs.bag_location_id,
  sil.item_id,
  SUM(sil.qty)      AS qty,
  si.sku,
  si.name,
  si.unit,
  si.tracks_lots
FROM   bag_subtree           bs
JOIN   stock_item_locations  sil ON sil.location_id = bs.descendant_id
JOIN   stock_items           si  ON si.id           = sil.item_id
GROUP  BY bs.bag_location_id, sil.item_id, si.sku, si.name, si.unit, si.tracks_lots
HAVING SUM(sil.qty) > 0;

COMMENT ON VIEW v_bag_contents IS
  'Per (bag_location_id, item_id) on-hand qty summed over the bag''s WHOLE '
  'subtree (the bag location + every descendant zone/bin), not just stock '
  'pinned at the bag location. Source of truth for "what is in the bag" — used '
  'by v_bag_status and shared/bags.js. SECURITY INVOKER (inherits caller RLS). '
  '20260715050000.';

-- ==========================================================================
-- 2) v_bag_status — rewrite deficit + expiry to use v_bag_contents (subtree)
--    Verbatim structure of 20260519040300 with ONLY the sil joins swapped for
--    v_bag_contents so counting is subtree-aware.
-- ==========================================================================

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

-- Per-bag mandatory item deficit — actual qty now comes from the subtree
-- aggregate v_bag_contents instead of a flat sil.location_id = bag join.
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

-- Per-bag expiry rollup — lots for items present anywhere in the subtree.
-- (Same item-level lot rollup as the original view, now subtree-sourced.)
bag_expiry AS (
  SELECT
    vbc.bag_location_id                                 AS location_id,
    MIN(sl.expiry_date)                                 AS nearest_expiry,
    COUNT(*) FILTER (
      WHERE sl.expiry_date < CURRENT_DATE
        AND sl.status      IN ('active', 'expired')
    )                                                   AS expired_lots_count,
    COUNT(*) FILTER (
      WHERE sl.expiry_date >= CURRENT_DATE
        AND (sl.expiry_date - CURRENT_DATE) <= 30
        AND sl.status      IN ('active', 'expired')
    )                                                   AS expiring_30d_count
  FROM   v_bag_contents vbc
  LEFT   JOIN stock_lots sl
    ON   sl.item_id  = vbc.item_id
    AND  sl.status   IN ('active', 'expired')
  GROUP  BY vbc.bag_location_id
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
  'Phase 4. Per-bag-location aggregated status. 20260715050000: deficit and '
  'expiry now count stock across the bag''s whole subtree (via v_bag_contents) '
  'so items in a zone/sub-location inside the bag count as being in the bag. '
  'alert_level: complete | low_stock | expiring | expired | no_template. '
  'Source for Admin ALS Bags tab and the daily bag_status_alert cron.';

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Both views compile:
--    SELECT * FROM v_bag_contents LIMIT 1;   -- no error
--    SELECT * FROM v_bag_status  LIMIT 1;    -- no error
--
-- B) Reported bag — items in the zone now count. BAG-DUG-001 should no longer
--    show SSCOR / Kingon as ขาด if they sit in the "ในกระเป๋า" zone:
--    SELECT bag_code, completion_pct, mandatory_deficit_count, alert_level
--    FROM v_bag_status WHERE bag_code = 'BAG-DUG-001';
--
--    -- and see exactly what the bag now counts (bag + zones):
--    SELECT sku, name, qty FROM v_bag_contents
--    WHERE bag_location_id = (SELECT id FROM locations WHERE code = 'BAG-DUG-001');
--
-- C) Over-stock check — a bag whose subtree qty for a template item exceeds the
--    target (e.g. the item was BOTH left in a zone AND restocked at the bag
--    root, so it now counts twice). These are real duplicate stock to reconcile,
--    not a view bug:
--    SELECT l.code AS bag_code, si.sku, si.name,
--           bti.target_qty, vbc.qty AS actual_qty, (vbc.qty - bti.target_qty) AS over
--    FROM v_bag_contents vbc
--    JOIN locations l           ON l.id  = vbc.bag_location_id
--    JOIN bag_template_items bti ON bti.bag_template_id = l.bag_template_id
--                               AND bti.item_id = vbc.item_id
--    JOIN stock_items si         ON si.id = vbc.item_id
--    WHERE vbc.qty > bti.target_qty
--    ORDER BY over DESC;
--    -- Expected ideally: 0 rows. Non-zero ⇒ move/issue the extra out of the bag.
