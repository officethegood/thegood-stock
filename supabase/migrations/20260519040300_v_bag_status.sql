-- supabase/migrations/20260519040300_v_bag_status.sql
-- Phase 4 — View v_bag_status.
--
-- Spec refs:
--   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §5.3
--   docs/superpowers/specs/2026-05-19-phase4-decisions-locked.md Q-Phase4-C (nearest expiry per bag)
--
-- What the view computes per bag-location:
--   - completion_pct     : 100 * sum(actual mandatory qty) / sum(target mandatory qty)
--   - mandatory_deficit_count : count of mandatory items where actual < target
--   - nearest_expiry     : MIN(expiry_date) across active lots at this bag-location
--   - expired_lots_count : count of active lots where expiry_date < CURRENT_DATE
--   - expiring_30d_count : count of active lots where 0 <= days-to-expiry <= 30
--   - alert_level        : expired > expiring > low_stock > complete > no_template
--
-- Alert level priority (Q-Phase4-C + spec §5.3):
--   'expired'     — any active lot at this bag has expiry_date < CURRENT_DATE
--   'expiring'    — any active lot has 0 <= (expiry_date - CURRENT_DATE) <= 30
--   'low_stock'   — any mandatory item deficit
--   'complete'    — all mandatory items at target AND no expiring/expired lots
--   'no_template' — locations.bag_template_id IS NULL (no template assigned)
--
-- Stock lot status filter: include 'active' and 'expired' lots in expiry rollup
-- (expired lots still physically present; Phase 2 cron sets status='expired' lazily).
-- Exclude 'recalled' and 'depleted' lots (depleted = legitimately used up).
--
-- CREATE OR REPLACE VIEW — always safe to re-apply.

CREATE OR REPLACE VIEW v_bag_status AS
WITH

-- ── Step 1: All bag-type locations with their template link ─────────────────
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

-- ── Step 2: Per-bag mandatory item deficit (from template vs actual qty) ─────
deficit AS (
  SELECT
    bl.location_id,
    COUNT(*) FILTER (
      WHERE bti.mandatory = true
        AND COALESCE(sil.qty, 0) < bti.target_qty
    )                                                   AS mandatory_deficit_count,
    COUNT(*) FILTER (WHERE bti.mandatory = true)        AS mandatory_total,
    SUM(bti.target_qty)
      FILTER (WHERE bti.mandatory = true)               AS total_target_mandatory,
    SUM(COALESCE(sil.qty, 0))
      FILTER (WHERE bti.mandatory = true)               AS total_actual_mandatory
  FROM   bag_locs                    bl
  LEFT   JOIN bag_template_items     bti
    ON   bti.bag_template_id = bl.bag_template_id
  LEFT   JOIN stock_item_locations   sil
    ON   sil.location_id = bl.location_id
    AND  sil.item_id     = bti.item_id
  GROUP  BY bl.location_id
),

-- ── Step 3: Per-bag expiry rollup from stock_lots ──────────────────────────
bag_expiry AS (
  SELECT
    sil.location_id,
    MIN(sl.expiry_date)                                  AS nearest_expiry,
    COUNT(*) FILTER (
      WHERE sl.expiry_date < CURRENT_DATE
        AND sl.status      IN ('active', 'expired')
    )                                                    AS expired_lots_count,
    COUNT(*) FILTER (
      WHERE sl.expiry_date >= CURRENT_DATE
        AND (sl.expiry_date - CURRENT_DATE) <= 30
        AND sl.status      IN ('active', 'expired')
    )                                                    AS expiring_30d_count
  FROM   stock_item_locations sil
  JOIN   locations            l
    ON   l.id   = sil.location_id
    AND  l.type = 'bag'
  LEFT   JOIN stock_lots      sl
    ON   sl.item_id  = sil.item_id
    AND  sl.status   IN ('active', 'expired')
  GROUP  BY sil.location_id
)

-- ── Final SELECT ────────────────────────────────────────────────────────────
SELECT
  bl.location_id,
  bl.bag_code,
  bl.bag_name,
  bl.bag_template_id,
  bl.template_code,
  bl.template_name,
  bl.bag_active,

  -- Completion % (mandatory items only; NULL when no template)
  CASE
    WHEN COALESCE(d.mandatory_total, 0) = 0
      THEN NULL   -- no template assigned → no meaningful completion %
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

  -- Alert level (priority: no_template → expired → expiring → low_stock → complete)
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
  'Phase 4. Per-bag-location aggregated status. '
  'alert_level values: complete | low_stock | expiring | expired | no_template. '
  'Priority: expired > expiring > low_stock > complete > no_template. '
  'Source for Admin ALS Bags tab and daily bag_status_alert cron.';

-- ==========================================================================
-- Verification SQL
-- ==========================================================================
-- 1) View compiles:
--    SELECT * FROM v_bag_status LIMIT 1;
--    -- Expected: 0 or more rows, no error
--
-- 2) Alert level values present:
--    SELECT DISTINCT alert_level FROM v_bag_status;
--    -- Expected: subset of {complete, low_stock, expiring, expired, no_template}
--
-- 3) Row count matches bag-type locations:
--    SELECT count(*) FROM locations WHERE type='bag';
--    SELECT count(*) FROM v_bag_status;
--    -- Expected: counts match (every bag-location has exactly one v_bag_status row)
--
-- 4) Bags without template show no_template:
--    SELECT bag_code, alert_level FROM v_bag_status WHERE bag_template_id IS NULL;
--    -- Expected: all rows have alert_level='no_template'
