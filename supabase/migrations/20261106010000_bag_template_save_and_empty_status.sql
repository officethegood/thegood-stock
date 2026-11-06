-- supabase/migrations/20261106010000_bag_template_save_and_empty_status.sql
-- Fix: saving a bag template could wipe its items, and an empty template read "สมบูรณ์".
--
-- Report 2026-11-05: BAG-ALS-001 and BAG-DUG-001 share "Emergency Bag 1", which has 0
-- items (last updated 2026-10-15). Staff saw "สมบูรณ์พร้อมใช้งาน" next to "ไม่พบรายการ
-- ในเทมเพลต".
--
-- 1) rpc_save_bag_template: js/bag-templates.js deleted every item first, then re-added
--    rows one by one, skipping invalid rows and continuing after failures. A row left
--    blank, a failed load of the form or a dropped connection lost the list for good.
--    Now one transaction: rejects an empty list, keeps a row's note, and on any failure
--    leaves the template as it was.
--
-- 2) v_bag_status: a template with no mandatory items has nothing to compare against, so
--    deficit is always 0 and the bag read 'complete'. It now reads 'no_template' (the
--    page labels it "เทมเพลตว่าง"). Expiry still comes first. Body is a VERBATIM copy of
--    20261105030000 with only that WHEN changed.
--
-- This does NOT restore lost items: there is no history of template rows.
-- Depends on: 20261105030000, 20260519040000. Idempotent.

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
    WHEN COALESCE(d.mandatory_total, 0) = 0             THEN 'no_template'
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

CREATE OR REPLACE FUNCTION rpc_save_bag_template(
  p_id          uuid,     -- NULL = create
  p_code        text,
  p_name        text,
  p_category    text,
  p_description text,
  p_items       jsonb     -- [{ "item_id", "target_qty", "mandatory", "sort_order" }]
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_save_bag_template$
DECLARE
  v_id uuid := p_id;
BEGIN
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการ';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'เทมเพลตต้องมีอย่างน้อย 1 รายการ';
  END IF;

  IF (SELECT count(*) <> count(DISTINCT value->>'item_id') FROM jsonb_array_elements(p_items)) THEN
    RAISE EXCEPTION 'มีสินค้าซ้ำในเทมเพลต';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO bag_templates (code, name, category, description)
    VALUES (p_code, p_name, COALESCE(p_category, 'ALS'), p_description)
    RETURNING id INTO v_id;
  ELSE
    UPDATE bag_templates
    SET    name = p_name, category = COALESCE(p_category, 'ALS'), description = p_description,
           updated_at = now(), updated_by = app_username()
    WHERE  id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ไม่พบเทมเพลต';
    END IF;
    DELETE FROM bag_template_items
    WHERE  bag_template_id = v_id
      AND  item_id NOT IN (SELECT (value->>'item_id')::uuid FROM jsonb_array_elements(p_items));
  END IF;

  INSERT INTO bag_template_items (bag_template_id, item_id, target_qty, mandatory, sort_order)
  SELECT v_id, (value->>'item_id')::uuid, (value->>'target_qty')::int,
         COALESCE((value->>'mandatory')::boolean, true), COALESCE((value->>'sort_order')::int, 0)
  FROM   jsonb_array_elements(p_items)
  ON CONFLICT (bag_template_id, item_id) DO UPDATE
    SET target_qty = EXCLUDED.target_qty,
        mandatory  = EXCLUDED.mandatory,
        sort_order = EXCLUDED.sort_order;

  RETURN v_id;
END;
$rpc_save_bag_template$;

REVOKE ALL ON FUNCTION rpc_save_bag_template(uuid, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_save_bag_template(uuid, text, text, text, text, jsonb) TO authenticated;

-- Verification (last statement, so the SQL Editor shows it). BAG-ALS-001 and BAG-DUG-001
-- should no longer be 'complete' while their template is empty.
SELECT bag_code, template_name, completion_pct, alert_level
FROM   v_bag_status
WHERE  bag_active
ORDER  BY bag_code;
