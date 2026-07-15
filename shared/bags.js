// shared/bags.js
// Phase 4 — ALS Bags REST helpers + FEFO-sorted shopping list builder.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §3, §5, §7
//   docs/superpowers/specs/2026-05-19-phase4-decisions-locked.md (all decisions)
//
// Decisions enforced here:
//   Q-Phase4-A: No seed data — templates start empty; Admin creates via UI.
//   Q-Phase4-B: Restock = N individual REST INSERTs from caller (this module
//               provides helpers; does NOT do bulk RPC).
//   Q-Phase4-C: Nearest expiry per bag (v_bag_status column).
//
// Shopping list ordering (UX §7.2 + decisions derived #8):
//   1. Mandatory items with deficit (most urgent)
//   2. Mandatory items already complete
//   3. Non-mandatory items with deficit
//   4. Non-mandatory items complete
//   Within each group: sort_order ASC, then alphabetical by item name.
//
// Requires (loaded before this script):
//   shared/supabase-client.js — window.getSupabaseClient()
//
// Public namespace: window.AppBags

(function () {
  'use strict';

  function _sb() { return window.getSupabaseClient(); }

  /** Wrap Supabase call to { data, error } envelope. */
  async function _safe(run) {
    try {
      const r = await run();
      if (r && typeof r === 'object' && ('data' in r || 'error' in r)) return r;
      return { data: r, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  // ==========================================================================
  // Template REST helpers
  // ==========================================================================

  /**
   * List bag templates (active by default).
   * @param {{ activeOnly?: boolean }} [opts]
   */
  async function listTemplates({ activeOnly = true } = {}) {
    let q = _sb().from('bag_templates').select('*').order('name');
    if (activeOnly) q = q.eq('active', true);
    return _safe(() => q);
  }

  /**
   * Get a single template with its items (joined to stock_items for names).
   * @param {string} templateId
   */
  async function getTemplateWithItems(templateId) {
    return _safe(() =>
      _sb()
        .from('bag_template_items')
        .select('*, stock_items(id, sku, name, tracks_lots, unit)')
        .eq('bag_template_id', templateId)
        .order('sort_order')
        .order('id')
    );
  }

  /**
   * Create a bag template.
   * @param {{ code: string, name: string, category?: string, description?: string }} tpl
   */
  async function createTemplate(tpl) {
    return _safe(() =>
      _sb().from('bag_templates').insert([tpl]).select().single()
    );
  }

  /**
   * Update a bag template header (code/name/category/description/active).
   * @param {string} id
   * @param {object} patch
   */
  async function updateTemplate(id, patch) {
    return _safe(() =>
      _sb().from('bag_templates').update({ ...patch, updated_by: window.getUserName?.() || 'admin' })
        .eq('id', id).select().single()
    );
  }

  /**
   * Add an item to a template.
   * @param {{ bag_template_id, item_id, target_qty, mandatory?, sort_order?, note? }} row
   */
  async function addTemplateItem(row) {
    return _safe(() =>
      _sb().from('bag_template_items').insert([row]).select().single()
    );
  }

  /**
   * Update a template item (target_qty, mandatory, sort_order, note).
   * @param {string} id  bag_template_items.id
   * @param {object} patch
   */
  async function updateTemplateItem(id, patch) {
    return _safe(() =>
      _sb().from('bag_template_items').update(patch).eq('id', id).select().single()
    );
  }

  /**
   * Delete a template item row.
   * @param {string} id  bag_template_items.id
   */
  async function deleteTemplateItem(id) {
    return _safe(() =>
      _sb().from('bag_template_items').delete().eq('id', id)
    );
  }

  // ==========================================================================
  // Bag status REST helpers
  // ==========================================================================

  /**
   * List all bag-type locations with v_bag_status data.
   * Filters to active bags by default.
   * @param {{ activeOnly?: boolean }} [opts]
   */
  async function listBagStatus({ activeOnly = true } = {}) {
    let q = _sb().from('v_bag_status').select('*').order('bag_code');
    if (activeOnly) q = q.eq('bag_active', true);
    return _safe(() => q);
  }

  /**
   * Get v_bag_status for a single bag-location by location_id.
   * @param {string} locationId
   */
  async function getBagStatus(locationId) {
    return _safe(() =>
      _sb().from('v_bag_status').select('*').eq('location_id', locationId).maybeSingle()
    );
  }

  /**
   * Get v_bag_status for a bag-location by bag code (locations.code).
   * @param {string} bagCode  e.g. 'BAG-ALS-001'
   */
  async function getBagStatusByCode(bagCode) {
    return _safe(() =>
      _sb().from('v_bag_status').select('*').eq('bag_code', bagCode).maybeSingle()
    );
  }

  /**
   * Get counts by alert_level for the dashboard panel.
   * Returns { complete, low_stock, expiring, expired, no_template }.
   */
  async function getBagCounts() {
    const { data, error } = await _safe(() =>
      _sb().from('v_bag_status').select('alert_level').eq('bag_active', true)
    );
    if (error || !data) return { data: null, error };

    const counts = { complete: 0, low_stock: 0, expiring: 0, expired: 0, no_template: 0 };
    data.forEach((row) => {
      if (row.alert_level in counts) counts[row.alert_level]++;
    });
    return { data: counts, error: null };
  }

  // ==========================================================================
  // Detail: template composition vs actual qty per bag
  // ==========================================================================

  /**
   * Fetch the template composition for a bag with actual quantities.
   * Returns an array of rows with: item info, target_qty, actual_qty, deficit, mandatory, sort_order.
   *
   * @param {string} locationId   bag-location UUID
   * @param {string} templateId   bag_templates.id
   */
  async function getBagComposition(locationId, templateId) {
    // Fetch template items + stock_items
    const { data: tplItems, error: tplErr } = await getTemplateWithItems(templateId);
    if (tplErr) return { data: null, error: tplErr };

    // Actual quantities — from v_bag_contents so stock in zones/sub-locations
    // INSIDE the bag counts too (20260715050000). Querying stock_item_locations
    // at the bag location alone missed items a user moved into a child zone.
    const { data: silRows, error: silErr } = await _safe(() =>
      _sb()
        .from('v_bag_contents')
        .select('item_id, qty')
        .eq('bag_location_id', locationId)
    );
    if (silErr) return { data: null, error: silErr };

    const qtyMap = {};
    (silRows || []).forEach((r) => { qtyMap[r.item_id] = r.qty; });

    // Merge and compute deficit
    const rows = (tplItems || []).map((bti) => {
      const item       = bti.stock_items;
      const actual_qty = qtyMap[bti.item_id] || 0;
      const deficit    = Math.max(0, bti.target_qty - actual_qty);
      return {
        bti_id:         bti.id,
        item_id:        bti.item_id,
        sku:            item?.sku  || '',
        name:           item?.name || '',
        unit:           item?.unit || 'ชิ้น',
        tracks_lots:    item?.tracks_lots || false,
        target_qty:     bti.target_qty,
        actual_qty,
        deficit,
        mandatory:      bti.mandatory,
        sort_order:     bti.sort_order,
        note:           bti.note,
      };
    });

    return { data: rows, error: null };
  }

  // ==========================================================================
  // Actual contents — what is physically inside the bag right now, counting the
  // bag location AND every zone/sub-location inside it (v_bag_contents subtree,
  // 20260715050000). Template NOT required.
  // Added 2026-07-12: bags without a template showed nothing even when items
  // had been moved in — the bag view must always show reality.
  // ==========================================================================

  /**
   * List items currently inside a bag (qty > 0), summed across the bag subtree,
   * shaped to preserve the existing consumer contract
   * ({ item_id, qty, stock_items: { sku, name, unit, tracks_lots } }).
   * @param {string} locationId  bag-location UUID
   */
  async function getBagActualContents(locationId) {
    const res = await _safe(() =>
      _sb()
        .from('v_bag_contents')
        .select('item_id, qty, sku, name, unit, tracks_lots')
        .eq('bag_location_id', locationId)
        .order('qty', { ascending: false })
    );
    if (res.error) return res;
    // Re-shape flat view columns into the { stock_items: {...} } shape callers expect.
    const data = (res.data || []).map((r) => ({
      item_id: r.item_id,
      qty:     r.qty,
      stock_items: { sku: r.sku, name: r.name, unit: r.unit, tracks_lots: r.tracks_lots },
    }));
    return { data, error: null };
  }

  /**
   * Link a template to a bag-location (locations.bag_template_id).
   * RLS: Admin-only in practice (locations update policy).
   * @param {string} locationId
   * @param {string|null} templateId  null = unlink
   */
  async function assignTemplateToBag(locationId, templateId) {
    return _safe(() =>
      _sb()
        .from('locations')
        .update({ bag_template_id: templateId })
        .eq('id', locationId)
        .select('id, bag_template_id')
        .single()
    );
  }

  // ==========================================================================
  // Lot-tracked items in a bag (for the lots expandable section)
  // ==========================================================================

  /**
   * Fetch active stock_lots at this bag-location for lot-tracked items.
   * @param {string} locationId
   */
  async function getBagLots(locationId) {
    return _safe(() =>
      _sb()
        .from('stock_lots')
        .select('id, lot_number, expiry_date, current_qty, status, item_id, stock_items(name,sku)')
        .eq('status', 'active')
        .order('expiry_date')
    );
    // Note: stock_lots doesn't have a direct location_id column.
    // Location linkage is via stock_movements. For Phase 4 we use a simpler approach:
    // show all active lots for items present at the bag location.
  }

  /**
   * Fetch active lots for items at a bag-location via stock_movements.
   * Groups by lot_id, sums last known qty at location.
   * @param {string} locationId
   */
  async function getBagLotsAtLocation(locationId) {
    // Get item_ids at this location first
    const { data: silRows, error: silErr } = await _safe(() =>
      _sb().from('stock_item_locations').select('item_id').eq('location_id', locationId)
    );
    if (silErr || !silRows || silRows.length === 0) return { data: [], error: silErr };

    const itemIds = silRows.map((r) => r.item_id);

    return _safe(() =>
      _sb()
        .from('stock_lots')
        .select('id, lot_number, expiry_date, current_qty, status, item_id, stock_items(name,sku,tracks_lots)')
        .in('item_id', itemIds)
        .in('status', ['active', 'expired'])
        .order('expiry_date')
    );
  }

  // ==========================================================================
  // Restock helpers
  // ==========================================================================

  /**
   * Build the sorted shopping list for a restock flow.
   * Ordering per UX decisions:
   *   1. Mandatory + deficit
   *   2. Mandatory + complete
   *   3. Non-mandatory + deficit
   *   4. Non-mandatory + complete
   *   Within group: sort_order ASC, then name ASC.
   *
   * @param {Array} compositionRows   from getBagComposition()
   * @returns {Array}   same rows, with added `restock_qty` default and `group` label
   */
  function buildShoppingList(compositionRows) {
    function groupKey(row) {
      if (row.mandatory && row.deficit > 0)  return 0;  // mandatory deficit — top priority
      if (row.mandatory && row.deficit === 0) return 1;  // mandatory complete
      if (!row.mandatory && row.deficit > 0) return 2;  // optional deficit
      return 3;                                           // optional complete
    }

    return compositionRows
      .map((row) => ({
        ...row,
        restock_qty: row.deficit,   // default = fill the deficit
        skipped:     false,
        selected_lot_id: null,
        group:       groupKey(row),
      }))
      .sort((a, b) => {
        if (a.group !== b.group)       return a.group      - b.group;
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.name.localeCompare(b.name, 'th');
      });
  }

  /**
   * Submit a single restock movement (one item in the shopping list).
   * Caller loops over N items and calls this for each.
   * Idempotent via client_ref_id: 409 on duplicate = treat as success.
   *
   * @param {{
   *   location_id:    string,
   *   item_id:        string,
   *   qty_delta:      number,
   *   lot_id?:        string|null,
   *   bag_code:       string,
   *   restock_ref_id: string,
   *   client_ref_id:  string,
   *   note?:          string,
   * }} params
   */
  async function submitRestockItem(params) {
    const {
      location_id, item_id, qty_delta, lot_id = null,
      bag_code, restock_ref_id, client_ref_id, note,
    } = params;

    const movement = {
      movement_type: 'receive',
      location_id,
      item_id,
      qty_delta,
      lot_id:        lot_id || null,
      reason:        'bag_restock',
      note:          note || ('bag:' + bag_code + ':restock:' + restock_ref_id),
      client_ref_id,
    };

    const result = await _safe(() =>
      _sb().from('stock_movements').insert([movement]).select().single()
    );

    // 409 (duplicate client_ref_id) = already posted → treat as success
    if (result.error) {
      const code = result.error.code || (result.error.details && result.error.details.code);
      if (code === '23505' || (result.error.message && result.error.message.includes('client_ref_id'))) {
        return { data: movement, error: null, alreadyPosted: true };
      }
    }
    return result;
  }

  /**
   * Generate a UUID (for restock_ref_id and per-item client_ref_id).
   */
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for older environments
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ==========================================================================
  // Alert level helpers (UI badge rendering)
  // ==========================================================================

  /**
   * Returns { cssClass, label } for an alert_level value.
   * Mirrors spec §5.3 and UX §4.3.
   * @param {string} level  'complete'|'low_stock'|'expiring'|'expired'|'no_template'
   */
  function getAlertBadge(level) {
    switch (level) {
      case 'complete':    return { cssClass: 'bg-success text-white',               label: 'สมบูรณ์'       };
      case 'low_stock':   return { cssClass: 'bg-warning text-dark',                label: 'ของไม่ครบ'     };
      case 'expiring':    return { cssClass: 'badge-stock-expiring',                label: 'ใกล้หมดอายุ'   };
      case 'expired':     return { cssClass: 'bg-danger text-white',                label: 'หมดอายุ'       };
      case 'no_template': return { cssClass: 'bg-secondary text-white',             label: 'ไม่มีเทมเพลต'  };
      default:            return { cssClass: 'bg-secondary text-white',             label: level           };
    }
  }

  /**
   * Format a date as Thai short date (DD Mon YYYY, Buddhist era month).
   * Mirrors shared/lots.js formatThaiDate pattern.
   * @param {string|null} dateStr  ISO date string
   */
  function formatThaiDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('th-TH', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
    } catch { return dateStr; }
  }

  // ==========================================================================
  // กระเป๋าขึ้นรถ / คืนกระเป๋า (bag deploy & return — no due date)
  // Backed by rpc_deploy_bag / rpc_return_bag (20260705010000). A bag is a
  // locations row; deploying re-parents it under an ambulance and logs a
  // bag_moves row whose from_parent_id is the "home" the return restores.
  // ==========================================================================

  /** Active ambulance locations for the deploy picker. */
  async function listVehicleLocations() {
    return _safe(() =>
      _sb().from('locations')
        .select('id,code,name')
        .eq('type', 'ambulance')
        .eq('active', true)
        .order('name')
    );
  }

  /** Fetch a location row (used to inspect the bag's current parent). */
  async function getLocationBrief(locId) {
    if (!locId) return { data: null, error: null };
    return _safe(() =>
      _sb().from('locations')
        .select('id,code,name,type,parent_id')
        .eq('id', locId)
        .maybeSingle()
    );
  }

  /** กระเป๋าขึ้นรถ. Returns { ok, bag_code, dest_name } on success. */
  async function deployBag(bagLocationId, destLocationId) {
    return _safe(() =>
      _sb().rpc('rpc_deploy_bag', { p_bag_id: bagLocationId, p_dest_id: destLocationId })
    );
  }

  /** คืนกระเป๋า to the home recorded by the latest deploy. */
  async function returnBag(bagLocationId) {
    return _safe(() =>
      _sb().rpc('rpc_return_bag', { p_bag_id: bagLocationId })
    );
  }

  // ==========================================================================
  // Public namespace
  // ==========================================================================

  window.AppBags = {
    // Templates
    listTemplates,
    getTemplateWithItems,
    createTemplate,
    updateTemplate,
    addTemplateItem,
    updateTemplateItem,
    deleteTemplateItem,
    // Bag status
    listBagStatus,
    getBagStatus,
    getBagStatusByCode,
    getBagCounts,
    // Detail
    getBagComposition,
    getBagLotsAtLocation,
    getBagActualContents,
    assignTemplateToBag,
    // Restock
    buildShoppingList,
    submitRestockItem,
    generateUUID,
    // Deploy / return (กระเป๋าขึ้นรถ)
    listVehicleLocations,
    getLocationBrief,
    deployBag,
    returnBag,
    // UI helpers
    getAlertBadge,
    formatThaiDate,
  };
})();
