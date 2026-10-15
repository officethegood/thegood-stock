-- ============================================================================
-- Reconcile per-location-lot drift — HARDENED v2 (after Codex adversarial review)
-- ============================================================================
-- Problem: 11 (item_id, location_id) spots each have one lot whose per-location
-- ledger SUM(qty_delta) < 0 (physically impossible — a leftover from historical
-- lot-LESS outflows, before check_lot_status started requiring lot_id on every
-- outgoing movement). The per-location ledger still sums to sil (the real,
-- user-confirmed physical total). v_item_location_lots hides the negative lot
-- (HAVING SUM>0), so the per-lot view over-states stock.
--
-- Fix per spot (sil-preserving): raise the negative lot to 0 (adjustment_gain),
-- and reduce the LARGEST positive lot at that spot by the same amount
-- (adjustment_loss). Net sil change per spot = 0 — real stock is NOT touched.
--
-- IMPORTANT — triggers that fire on these INSERTs (verified in migrations):
--   * apply_movement_to_lot_qty: SINGLE owner of stock_lots.current_qty. Its
--     negative guard is GLOBAL (current_qty is summed across ALL locations).
--     => A loss on a donor lot, or a gain on a negative lot, must keep that
--        lot's GLOBAL current_qty >= 0. STEP 1 (preflight) proves this first.
--   * notify_stock_movement_to_tg: fires on adjustment_gain/loss. If
--     NOTIFY_TELEGRAM_ENABLED='true', the COMMIT run sends ~1 Telegram line per
--     movement (wrapped in EXCEPTION, so it never aborts). To avoid the noise,
--     optionally set it 'false' for the commit run (see STEP 3 note). On the
--     rollback trial NOTHING is sent (pg_net enqueue is rolled back too).
--   * check_low_stock: fires on the adjustment_loss rows; may enqueue a
--     (deduped) low-stock alert. Harmless.
--   * fk_movements_lot_item is DEFERRABLE INITIALLY DEFERRED — STEP 2 forces
--     SET CONSTRAINTS ALL IMMEDIATE before declaring the trial good.
--
-- RUN ORDER:
--   STEP 1 — run alone. Expect 0 rows. Any row => stop, tell Claude.
--   STEP 2 — run as-is (ends in ROLLBACK). Read the 3 verify outputs.
--   STEP 3 — only if STEP 1 = 0 rows AND STEP 2 output is correct: change the
--            final ROLLBACK to COMMIT and run once.
-- ============================================================================


-- ========================= STEP 1 — PREFLIGHT (read-only) ===================
-- Safe to run anytime. Returns ONLY problems. 0 rows = the plan is safe to apply.
WITH lot_net AS (
  SELECT item_id, location_id, lot_id, SUM(qty_delta) AS net
  FROM   stock_movements WHERE lot_id IS NOT NULL
  GROUP  BY item_id, location_id, lot_id
),
negs AS (SELECT * FROM lot_net WHERE net < 0),
spot_reduce AS (
  SELECT item_id, location_id, SUM(-net) AS reduce_by
  FROM   negs GROUP BY item_id, location_id
),
biggest_pos AS (
  SELECT DISTINCT ON (item_id, location_id) item_id, location_id, lot_id, net
  FROM   lot_net WHERE net > 0
  ORDER  BY item_id, location_id, net DESC
),
lot_delta AS (                                   -- net change to each lot's GLOBAL current_qty
  SELECT lot_id, SUM(-net)::int AS delta FROM negs GROUP BY lot_id        -- gains (+)
  UNION ALL
  SELECT bp.lot_id, SUM(-sr.reduce_by)::int AS delta                      -- losses (-)
  FROM spot_reduce sr JOIN biggest_pos bp USING (item_id, location_id)
  GROUP BY bp.lot_id
),
lot_delta_agg AS (SELECT lot_id, SUM(delta)::int AS delta FROM lot_delta GROUP BY lot_id)
SELECT 'A) global current_qty would go negative'::text AS problem,
       sl.lot_number::text AS subject, sl.current_qty, lda.delta,
       (sl.current_qty + lda.delta)::int AS result
FROM   lot_delta_agg lda JOIN stock_lots sl ON sl.id = lda.lot_id
WHERE  sl.current_qty + lda.delta < 0
UNION ALL
SELECT 'B) donor positive lot < spot total (needs split across lots)'::text,
       (si.sku || ' @ ' || l.code)::text, bp.net, sr.reduce_by, NULL::int
FROM   spot_reduce sr JOIN biggest_pos bp USING (item_id, location_id)
JOIN   stock_items si ON si.id = sr.item_id
JOIN   locations   l  ON l.id  = sr.location_id
WHERE  bp.net < sr.reduce_by
UNION ALL
SELECT 'C) spot has a negative lot but NO positive donor'::text,
       (si.sku || ' @ ' || l.code)::text, sr.reduce_by, NULL::int, NULL::int
FROM   spot_reduce sr
LEFT   JOIN biggest_pos bp USING (item_id, location_id)
JOIN   stock_items si ON si.id = sr.item_id
JOIN   locations   l  ON l.id  = sr.location_id
WHERE  bp.lot_id IS NULL;


-- ========================= STEP 2 — RECONCILE (rollback trial) ==============
BEGIN;

CREATE TEMP TABLE recon_plan ON COMMIT DROP AS
WITH lot_net AS (
  SELECT item_id, location_id, lot_id, SUM(qty_delta) AS net
  FROM   stock_movements WHERE lot_id IS NOT NULL
  GROUP  BY item_id, location_id, lot_id
),
negs AS (SELECT * FROM lot_net WHERE net < 0),
spot_reduce AS (
  SELECT item_id, location_id, SUM(-net) AS reduce_by
  FROM   negs GROUP BY item_id, location_id
),
biggest_pos AS (
  SELECT DISTINCT ON (item_id, location_id) item_id, location_id, lot_id, net
  FROM   lot_net WHERE net > 0
  ORDER  BY item_id, location_id, net DESC
)
SELECT n.item_id, n.location_id, n.lot_id,
       'adjustment_gain'::stock_movement_type AS mtype, (-n.net) AS qd, 1 AS ord
FROM   negs n
UNION ALL
SELECT bp.item_id, bp.location_id, bp.lot_id,
       'adjustment_loss'::stock_movement_type AS mtype, (-sr.reduce_by) AS qd, 2 AS ord
FROM   spot_reduce sr
JOIN   biggest_pos bp ON bp.item_id = sr.item_id AND bp.location_id = sr.location_id;

-- Pass 1: raise negatives to 0 FIRST (bumps sil up so sil=0 spots never go negative)
INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), item_id, location_id, mtype, qd, lot_id,
       'reconcile_lot', 'เกลี่ยล็อตติดลบ->0 (audit 2026-10-14)', 'admin'
FROM   recon_plan WHERE ord = 1;

-- Pass 2: reduce the over-stated positive lot per spot by the same total
INSERT INTO stock_movements
  (client_ref_id, item_id, location_id, movement_type, qty_delta, lot_id, reason, note, performed_by)
SELECT gen_random_uuid(), item_id, location_id, mtype, qd, lot_id,
       'reconcile_lot', 'เกลี่ยล็อตที่เกินลง (audit 2026-10-14)', 'admin'
FROM   recon_plan WHERE ord = 2;

-- Force the DEFERRABLE lot/item FK to check NOW (not at COMMIT) so the trial is honest.
SET CONSTRAINTS ALL IMMEDIATE;

-- (optional eyeball) the plan that was applied — the 11 spots (gain +N / loss -N)
SELECT si.sku, l.code AS location, sl.lot_number, rp.mtype, rp.qd
FROM recon_plan rp
JOIN stock_items si ON si.id = rp.item_id
JOIN locations   l  ON l.id  = rp.location_id
JOIN stock_lots  sl ON sl.id = rp.lot_id
ORDER BY si.sku, l.code, rp.ord;

-- FINAL GO/NO-GO — this is the LAST query, so Supabase shows IT.
--   BOTH numbers must be 0. If so → safe to COMMIT (change ROLLBACK below to COMMIT).
SELECT
  (SELECT count(*) FROM (
     SELECT 1 FROM stock_movements WHERE lot_id IS NOT NULL
     GROUP BY item_id, location_id, lot_id HAVING SUM(qty_delta) < 0) x
  ) AS negative_lots_remaining,          -- expect 0
  (SELECT count(*) FROM stock_lots WHERE current_qty < 0
  ) AS lots_with_negative_current_qty;   -- expect 0

ROLLBACK;   -- ← STEP 3: when the GO/NO-GO row is 0 | 0, change ONLY this word to COMMIT and run STEP 2 again


-- ========================= STEP 3 — COMMIT run (notes) ======================
-- To suppress the one-off Telegram movement notifications during the commit run:
--   UPDATE settings SET value='false' WHERE key='NOTIFY_TELEGRAM_ENABLED';   -- before
--   ... run STEP 2 with COMMIT ...
--   UPDATE settings SET value='true'  WHERE key='NOTIFY_TELEGRAM_ENABLED';   -- after
-- (Optional — the notifications are harmless, just noisy. Skip if Telegram is off.)
