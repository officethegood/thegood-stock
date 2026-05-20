-- supabase/scripts/2026-05-20-reset-to-clean-slate.sql
-- ONE-TIME DATA RESET — run manually via Supabase Dashboard SQL Editor.
-- NOT a migration: must NOT run on every deploy. Kept here for the record.
--
-- Authorized by: Pex (project owner), 2026-05-20, scope confirmed in chat:
--   "ล้าง location + สต็อก (เก็บรายการสินค้า)"
--
-- PURPOSE: wipe all test/mock structural + transactional data so the
-- customer's real data can be set up fresh.
--
-- ───────────────────────────────────────────────────────────────────────
-- DELETES (permanent, unrecoverable):
--   • locations            — every ROOM / storage / shelf / bin / ambulance
--                            / bag / zone row
--   • stock_movements      — the entire stock ledger
--   • stock_item_locations — all per-location quantities
--   • stock_lots           — all lot instances
--   • linen_counts         — all linen count history
--   • stock_loans          — all loan/borrow records
--   • oxygen_movements     — all O2 tank movement history
--
-- KEEPS (untouched):
--   • stock_items          — the item catalogue (names / SKUs / attributes)
--   • stock_categories     — categories
--   • lookup_lists         — taxonomy (linen_subcategory / storage_style / tank_size)
--   • ambulances           — vehicle list (synced from GAS)
--   • oxygen_tanks         — the cylinder list is KEPT (treated like stock_items);
--                            only current_location_id is nulled + history cleared
--   • bag_templates / bag_template_items — bag setup templates
--   • users / settings / sessions
-- ───────────────────────────────────────────────────────────────────────
--
-- FK note: locations is referenced by 7 columns across 6 tables, all
-- ON DELETE RESTRICT. They must all be cleared (or nulled) before the
-- locations DELETE. Order below respects that. Wrapped in a transaction —
-- if any statement fails, nothing is deleted.

BEGIN;

-- 1) Movement / history ledgers (reference locations + items + lots + tanks)
DELETE FROM stock_movements;
DELETE FROM oxygen_movements;
DELETE FROM linen_counts;
DELETE FROM stock_loans;

-- 2) Stock quantities + lot instances
DELETE FROM stock_item_locations;
DELETE FROM stock_lots;

-- 3) Detach oxygen tanks from locations — keep the tank rows themselves
--    (current_location_id is nullable). Tanks are treated like the item
--    catalogue: the list stays, the location/history data is reset.
UPDATE oxygen_tanks SET current_location_id = NULL;

-- 4) Finally, every location row
DELETE FROM locations;

COMMIT;

-- ============================================================
-- Verification SQL — run AFTER commit. All counts must be 0
-- except the KEEP tables.
-- ============================================================
-- SELECT
--   (SELECT count(*) FROM locations)            AS locations,            -- 0
--   (SELECT count(*) FROM stock_movements)      AS stock_movements,      -- 0
--   (SELECT count(*) FROM stock_item_locations) AS stock_item_locations, -- 0
--   (SELECT count(*) FROM stock_lots)           AS stock_lots,           -- 0
--   (SELECT count(*) FROM linen_counts)         AS linen_counts,         -- 0
--   (SELECT count(*) FROM stock_loans)          AS stock_loans,          -- 0
--   (SELECT count(*) FROM oxygen_movements)     AS oxygen_movements,     -- 0
--   (SELECT count(*) FROM stock_items)          AS stock_items_KEPT,     -- > 0
--   (SELECT count(*) FROM stock_categories)     AS categories_KEPT,      -- > 0
--   (SELECT count(*) FROM oxygen_tanks)         AS oxygen_tanks_KEPT,    -- unchanged
--   (SELECT count(*) FROM ambulances)           AS ambulances_KEPT;      -- unchanged
--
-- SELECT count(*) FROM oxygen_tanks WHERE current_location_id IS NOT NULL;  -- 0
