// shared/inventory.js
// Phase 1 — Inventory REST + Realtime wrappers for stock_items, stock_item_locations, stock_movements.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-18-phase1-inventory-design.md
//     §3 (sync rows 6/7/13/14/15/17), §5 (data model), §5.6 (RLS), §5.7 (realtime), §7 (UI spec consumer)
//   docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md  — Task C1
//
// Locked decisions (do NOT re-debate, per PM Pex 2026-05-18):
//   Q1: NO transfer() in Phase 1 — only receive / issue / adjustment_loss / adjustment_gain
//   Q2: NO Chart.js dependency
//   Q3: NO photo capture
//   Q-Phase1-A: SKU + qty (no per-piece serial)
//   Q-Phase1-J: client_ref_id UUID UNIQUE for scan idempotency
//
// Requires (loaded BEFORE this script):
//   shared/config.js, shared/supabase-client.js, shared/auth.js, shared/ui.js
//
// Conventions:
//   * Every exported function is async and returns `{ data, error }` matching Supabase JS style.
//   * Role checks here are advisory UX guards (fail-fast on the client). The authoritative
//     check is the RLS policy on the server — see spec §5.6.
//   * All inserts that mutate stock pass a client-generated UUID `client_ref_id` so a network
//     retry returns 409 (Postgres 23505 on the UNIQUE constraint) and we treat it as success.

(function () {
  'use strict';

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /** @returns {string} 'Admin' | 'Employee' | something else */
  function _role() {
    try { return (typeof getUserRole === 'function') ? getUserRole() : 'Employee'; }
    catch { return 'Employee'; }
  }

  /** @returns {boolean} */
  function _isAdmin() { return _role() === 'Admin'; }

  /**
   * Wrap an arbitrary async DB call into the `{ data, error }` envelope.
   * Swallows thrown exceptions and surfaces them in `.error`.
   * @template T
   * @param {() => Promise<{ data: T, error: any }>} run
   * @returns {Promise<{ data: T|null, error: any }>}
   */
  async function _safe(run) {
    try {
      const r = await run();
      // Supabase JS returns { data, error } already.
      if (r && typeof r === 'object' && ('data' in r || 'error' in r)) return r;
      return { data: r, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  /** @returns {string} UUID v4 for idempotency keys. */
  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // RFC4122-ish fallback (very old browsers); cryptographically weaker.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /** Escape a value for PostgREST `.or()` filter expressions (no commas, no parens). */
  function _orSafe(v) { return String(v ?? '').replace(/[,()]/g, ''); }

  /**
   * Translate Supabase error codes to friendly Thai strings for UI consumers.
   * Returns a `{ ok, replay }` shape only for the idempotency case so callers can branch.
   * @param {{ code?: string, message?: string } | null} err
   * @returns {{ replay: boolean, friendly: string | null }}
   */
  function _classifyError(err) {
    if (!err) return { replay: false, friendly: null };
    const msg = String(err.message || '');
    if (err.code === '23505' && /client_ref_id/.test(msg)) {
      return { replay: true, friendly: null };  // idempotent retry — treat as success
    }
    if (err.code === '23505') return { replay: false, friendly: 'รหัสซ้ำ' };
    if (err.code === '23514') {
      // Phase 1.1 B3: qty_check constraint on stock_item_locations fires when issue would go negative.
      // Map to Thai "ของไม่พอ" per backlog item #3 (T38 evidence). Other CHECK violations keep generic text.
      if (/qty_check|stock_item_locations/.test(msg)) {
        return { replay: false, friendly: 'ของไม่พอ' };
      }
      return { replay: false, friendly: 'ค่าไม่ถูกต้องตามเงื่อนไข' };
    }
    if (err.code === '42501') return { replay: false, friendly: 'ไม่มีสิทธิ์ทำรายการนี้' };
    if (/would drive qty negative/i.test(msg)) return { replay: false, friendly: 'ของไม่พอ' };
    return { replay: false, friendly: null };
  }

  // =========================================================================
  // Categories
  // =========================================================================

  /**
   * List active stock categories (sorted by sort_order).
   * RLS: scat_read — all authenticated users.
   * @returns {Promise<{ data: Array<{id:string,code:string,name:string,sort_order:number,active:boolean}>|null, error: any }>}
   */
  async function listCategories() {
    return _safe(async () => {
      const sb = getSupabaseClient();
      return sb.from('stock_categories')
        .select('id,code,name,sort_order,active')
        .eq('active', true)
        .order('sort_order');
    });
  }

  // =========================================================================
  // Items — read
  // =========================================================================

  /**
   * List items with denormalized total qty.
   * Uses view `v_stock_items_with_total` when available (BE Phase A creates it per spec §7.1.1);
   * falls back to client-side aggregation over stock_item_locations otherwise.
   *
   * RLS: si_read + sil_read — all authenticated users.
   *
   * @param {object} [opts]
   * @param {string} [opts.search]        Substring against name / sku / barcode.
   * @param {string} [opts.category]      stock_categories.id filter.
   * @param {boolean} [opts.lowStockOnly] Keep only rows where reorder_threshold > 0 AND total_qty <= reorder_threshold.
   * @param {boolean} [opts.activeOnly=true]
   * @param {number}  [opts.limit=200]
   * @returns {Promise<{ data: Array<object>|null, error: any }>}
   */
  async function listItems(opts = {}) {
    return _safe(async () => {
      const sb = getSupabaseClient();
      const search   = (opts.search || '').trim();
      const activeOnly = opts.activeOnly !== false;
      const limit    = opts.limit ?? 200;

      // Try the view first (cheap path).
      let viewRes = await _queryItemsView(sb, { search, category: opts.category, activeOnly, limit });

      if (viewRes.error && _viewMissing(viewRes.error)) {
        // Fallback: read stock_items + per-location qty rows, aggregate client-side.
        viewRes = await _queryItemsFallback(sb, { search, category: opts.category, activeOnly, limit });
      }
      if (viewRes.error) return viewRes;

      let rows = viewRes.data || [];
      if (opts.lowStockOnly) {
        rows = rows.filter((r) => (r.reorder_threshold || 0) > 0 && (r.total_qty || 0) <= r.reorder_threshold);
      }
      return { data: rows, error: null };
    });
  }

  function _viewMissing(err) {
    // Postgres "relation does not exist" or PostgREST PGRST205 (table not found in schema cache).
    return err?.code === '42P01' || err?.code === 'PGRST205' || /v_stock_items_with_total/.test(err?.message || '');
  }

  // Apply a free-text search as an AND of per-word ilikes, each OR-ed across
  // name / name_en / sku / barcode. Tokenising on whitespace means:
  //   - word order doesn't matter ("Sterile 1000" == "1000 Sterile")
  //   - "1000 ml" matches a stored "...1000ml" (each token is a substring) and
  //     vice-versa, fixing the spacing mismatches users hit
  //   - name_en is now searched (e.g. "Perskindol" stored only in the EN name)
  // The old single `ilike '%<whole string incl. spaces>%'` only matched a
  // contiguous run, so any spacing/word-order/extra-token difference returned 0.
  // Each supabase-js .or() group is combined with AND, which is exactly the
  // "every word must appear somewhere" semantics we want.
  function _applySearch(q, search) {
    const tokens = String(search).split(/\s+/).map(_orSafe).filter(Boolean);
    for (const t of tokens) {
      const like = `%${t}%`;
      q = q.or(`name.ilike.${like},name_en.ilike.${like},sku.ilike.${like},barcode.ilike.${like}`);
    }
    return q;
  }

  async function _queryItemsView(sb, { search, category, activeOnly, limit }) {
    // NOTE: v_stock_items_with_total was created pre-Phase-6 with `si.*` which
    // froze its column list — it does NOT expose linen_subcategory. Do not add
    // that column here or the query 42703-fails. The edit modal prefills
    // linen_subcategory from getItem() (direct stock_items query) instead.
    let q = sb.from('v_stock_items_with_total')
      .select('id,sku,barcode,name,name_en,category_id,unit,reorder_threshold,tracks_lots,image_url,note,active,total_qty,created_at,updated_at');
    if (activeOnly) q = q.eq('active', true);
    if (category)   q = q.eq('category_id', category);
    if (search) q = _applySearch(q, search);
    return q.order('name').limit(limit);
  }

  async function _queryItemsFallback(sb, { search, category, activeOnly, limit }) {
    let q = sb.from('stock_items')
      .select('id,sku,barcode,name,name_en,category_id,unit,reorder_threshold,tracks_lots,linen_subcategory,image_url,note,active,created_at,updated_at,stock_item_locations(qty)');
    if (activeOnly) q = q.eq('active', true);
    if (category)   q = q.eq('category_id', category);
    if (search) q = _applySearch(q, search);
    const r = await q.order('name').limit(limit);
    if (r.error) return r;
    const data = (r.data || []).map((row) => {
      const total = (row.stock_item_locations || []).reduce((acc, x) => acc + (x.qty || 0), 0);
      const { stock_item_locations, ...rest } = row;
      return { ...rest, total_qty: total };
    });
    return { data, error: null };
  }

  /**
   * Get a single item with its per-location qty breakdown (locations with qty > 0).
   * RLS: si_read + sil_read — all authenticated users.
   * @param {string} itemId
   * @returns {Promise<{ data: { item: object, locations: Array<object>, total_qty: number }|null, error: any }>}
   */
  async function getItem(itemId) {
    return _safe(async () => {
      const sb = getSupabaseClient();
      const itemRes = await sb.from('stock_items')
        .select('id,sku,barcode,name,name_en,category_id,unit,reorder_threshold,tracks_lots,tracks_serial,linen_subcategory,image_url,note,active,created_at,updated_at,created_by,updated_by')
        .eq('id', itemId).maybeSingle();
      if (itemRes.error) return itemRes;
      if (!itemRes.data) return { data: null, error: null };

      const locRes = await sb.from('stock_item_locations')
        .select('id,location_id,qty,last_movement_at,updated_at,locations(code,name,type,parent_id,qr_payload,active)')
        .eq('item_id', itemId)
        .gt('qty', 0)
        .order('qty', { ascending: false });
      if (locRes.error) return locRes;

      const locations = locRes.data || [];
      const total_qty = locations.reduce((a, x) => a + (x.qty || 0), 0);
      return { data: { item: itemRes.data, locations, total_qty }, error: null };
    });
  }

  /**
   * Quick lookup by scanned barcode or typed SKU. Returns the FIRST active match (barcode or sku).
   * RLS: si_read.
   * Used by scanner step "scan item".
   * @param {string} barcodeOrSku
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function searchByBarcode(barcodeOrSku) {
    return _safe(async () => {
      const sb = getSupabaseClient();
      const v = _orSafe(barcodeOrSku);
      if (!v) return { data: null, error: null };
      // Phase 1.1 B5: use ilike for partial barcode/SKU matching (EAN-13 variants, partial scan).
      const like = `%${v}%`;
      // Embed per-location qty and sum it into total_qty (same pattern as
      // _queryItemsFallback). The borrow flow gates on item.total_qty — the
      // base stock_items table has NO such column, so without this every
      // borrow attempt read undefined → "ของไม่เหลือในคลัง" for every item.
      const r = await sb.from('stock_items')
        .select('id,sku,barcode,name,name_en,category_id,unit,reorder_threshold,tracks_lots,active,stock_item_locations(qty)')
        .or(`barcode.ilike.${like},sku.ilike.${like}`)
        .eq('active', true)
        .limit(1);
      if (r.error) return r;
      const row = r.data?.[0] || null;
      if (!row) return { data: null, error: null };
      const total = (row.stock_item_locations || []).reduce((acc, x) => acc + (x.qty || 0), 0);
      const { stock_item_locations, ...rest } = row;
      return { data: { ...rest, total_qty: total }, error: null };
    });
  }

  /**
   * Resolve a scanned location (QR payload OR location code) to a `locations` row.
   * RLS: loc_read (Phase 0).
   * @param {string} qrOrCode
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function findLocationByCode(qrOrCode) {
    return _safe(async () => {
      const sb = getSupabaseClient();
      const v = _orSafe(qrOrCode);
      if (!v) return { data: null, error: null };
      const r = await sb.from('locations')
        .select('id,code,name,type,parent_id,qr_payload,active')
        .or(`qr_payload.eq.${v},code.eq.${v}`)
        .eq('active', true)
        .limit(1);
      if (r.error) return r;
      return { data: r.data?.[0] || null, error: null };
    });
  }

  /**
   * Low-stock items (total_qty <= reorder_threshold AND reorder_threshold > 0).
   * Used by Dashboard panel and the Items list "low-stock-only" toggle.
   * RLS: si_read + sil_read.
   * @returns {Promise<{ data: Array<object>|null, error: any }>}
   */
  async function getLowStock() {
    return listItems({ lowStockOnly: true, activeOnly: true, limit: 500 });
  }

  // =========================================================================
  // Items — write (Admin only on server via RLS si_write)
  // =========================================================================

  /**
   * Create a new stock item.
   * RLS: si_write — Admin only.
   * @param {object} itemData            { sku, barcode?, name, name_en?, category_id?, unit?, reorder_threshold?, image_url?, note? }
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function createItem(itemData) {
    if (!_isAdmin()) return { data: null, error: { code: '42501', message: 'admin_only' } };
    return _safe(async () => {
      const sb = getSupabaseClient();
      const payload = {
        sku:               String(itemData.sku || '').trim(),
        barcode:           itemData.barcode ? String(itemData.barcode).trim() : null,
        name:              String(itemData.name || '').trim(),
        name_en:           itemData.name_en ? String(itemData.name_en).trim() : null,
        category_id:       itemData.category_id || null,
        unit:              itemData.unit || 'ชิ้น',
        reorder_threshold: Number.isFinite(+itemData.reorder_threshold) ? +itemData.reorder_threshold : 0,
        image_url:         itemData.image_url || null,
        note:              itemData.note || null,
        active:            itemData.active !== false,
        // Phase 2: lot tracking — was missing from the whitelist (latent bug:
        // new medication items created via the modal always got tracks_lots=false)
        tracks_lots:       !!itemData.tracks_lots,
        // Phase 6: linen sub-category — required by DB trigger for LINEN items
        linen_subcategory: itemData.linen_subcategory || null,
      };
      return sb.from('stock_items').insert(payload).select().single();
    });
  }

  /**
   * Update an existing item.
   * RLS: si_write — Admin only.
   * @param {string} itemId
   * @param {object} patch
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function updateItem(itemId, patch) {
    if (!_isAdmin()) return { data: null, error: { code: '42501', message: 'admin_only' } };
    return _safe(async () => {
      const sb = getSupabaseClient();
      const body = { ...patch };
      try { body.updated_by = getUserUsername(); } catch { /* ignore */ }
      return sb.from('stock_items').update(body).eq('id', itemId).select().single();
    });
  }

  /**
   * Soft-delete: flip active=false. Never hard-deletes (movement history must remain joinable).
   * RLS: si_write — Admin only.
   * @param {string} itemId
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function deactivateItem(itemId) {
    return updateItem(itemId, { active: false });
  }

  // =========================================================================
  // Movements — write
  //
  // All four functions converge on _postMovement(). They differ only in:
  //   * which movement_type the row carries
  //   * the sign of qty_delta (the DB trigger enforce_movement_sign() also verifies)
  //   * the role allowed (server-side RLS sm_insert_admin / sm_insert_staff is authoritative)
  //
  // PHASE 1 NOTE (Q1): transfer() is intentionally NOT exposed.
  // =========================================================================

  /**
   * @internal
   * @param {object} args
   * @param {string} args.itemId
   * @param {string} args.locationId
   * @param {'receive'|'issue'|'adjustment_loss'|'adjustment_gain'} args.movement_type
   * @param {number} args.qty                        positive integer; sign applied based on movement_type
   * @param {string} [args.note]
   * @param {string} [args.reason]
   * @param {string} [args.clientRefId]              UUID for idempotency; auto-generated if omitted
   * @param {string} [args.lotId]                    stock_lots.id — required by the DB trigger for
   *                                                 tracks_lots items; null for non-lot items
   * @returns {Promise<{ data: { movement: object|null, replay: boolean, client_ref_id: string }|null, error: any }>}
   */
  async function _postMovement({ itemId, locationId, movement_type, qty, note, reason, clientRefId, lotId }) {
    return _safe(async () => {
      const sb = getSupabaseClient();
      const refId = clientRefId || _uuid();

      const q = Math.abs(Number(qty));
      if (!Number.isFinite(q) || q <= 0) {
        return { data: null, error: { code: 'BAD_QTY', message: 'qty must be a positive integer' } };
      }
      const POSITIVE = new Set(['receive', 'adjustment_gain']);
      const qty_delta = POSITIVE.has(movement_type) ? q : -q;

      const row = {
        client_ref_id: refId,
        item_id:       itemId,
        location_id:   locationId,
        movement_type,
        qty_delta,
        reason:        reason || null,
        note:          note   || null,
        lot_id:        lotId  || null,
      };

      const r = await sb.from('stock_movements').insert(row).select().single();
      if (r.error) {
        const klass = _classifyError(r.error);
        if (klass.replay) {
          return { data: { movement: null, replay: true, client_ref_id: refId }, error: null };
        }
        // Attach friendly translation for callers that want to surface a toast directly.
        if (klass.friendly) r.error.friendly = klass.friendly;
        return r;
      }
      return { data: { movement: r.data, replay: false, client_ref_id: refId }, error: null };
    });
  }

  /**
   * Record incoming stock (รับเข้า). Admin-only on server via RLS sm_insert_admin.
   * @param {string} itemId
   * @param {string} locationId
   * @param {number} qty                  positive integer
   * @param {string} [note]
   * @param {string} [clientRefId]
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function receive(itemId, locationId, qty, note, clientRefId) {
    if (!_isAdmin()) return { data: null, error: { code: '42501', message: 'admin_only' } };
    return _postMovement({ itemId, locationId, movement_type: 'receive', qty, note, clientRefId });
  }

  /**
   * Record outgoing stock (เบิก-จ่าย). Admin OR staff on server via RLS sm_insert_staff.
   * @param {string} itemId
   * @param {string} locationId
   * @param {number} qty                  positive integer (sign flipped to negative internally)
   * @param {string} [note]
   * @param {string} [clientRefId]
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function issue(itemId, locationId, qty, note, clientRefId) {
    return _postMovement({ itemId, locationId, movement_type: 'issue', qty, note, clientRefId });
  }

  /**
   * Record damaged / lost stock. Admin OR staff on server via RLS sm_insert_staff.
   * @param {string} itemId
   * @param {string} locationId
   * @param {number} qty                  positive integer (sign flipped to negative internally)
   * @param {string} [note]
   * @param {string} [clientRefId]
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function adjustmentLoss(itemId, locationId, qty, note, clientRefId, lotId) {
    return _postMovement({ itemId, locationId, movement_type: 'adjustment_loss', qty, note, clientRefId, lotId });
  }

  /**
   * Record a stock-take overage. Admin-only on server via RLS sm_insert_admin.
   * @param {string} itemId
   * @param {string} locationId
   * @param {number} qty                  positive integer
   * @param {string} [note]
   * @param {string} [clientRefId]
   * @returns {Promise<{ data: object|null, error: any }>}
   */
  async function adjustmentGain(itemId, locationId, qty, note, clientRefId, lotId) {
    if (!_isAdmin()) return { data: null, error: { code: '42501', message: 'admin_only' } };
    return _postMovement({ itemId, locationId, movement_type: 'adjustment_gain', qty, note, clientRefId, lotId });
  }

  // PHASE 1 — transfer() intentionally omitted (Q1, PM Pex 2026-05-18).

  // =========================================================================
  // Movements — read (audit panel)
  // =========================================================================

  /**
   * Recent stock movements joined to item + location for display.
   * RLS: sm_read — all authenticated users.
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {string} [opts.itemId]
   * @param {string} [opts.locationId]
   * @returns {Promise<{ data: Array<object>|null, error: any }>}
   */
  async function listRecentMovements(opts = {}) {
    return _safe(async () => {
      const sb = getSupabaseClient();
      let q = sb.from('stock_movements')
        .select('id,movement_type,qty_delta,qty_after,reason,note,performed_at,performed_by,performed_role,client_ref_id,stock_items(sku,name,unit),locations(code,name,type)')
        .order('performed_at', { ascending: false })
        .limit(opts.limit ?? 50);
      if (opts.itemId)       q = q.eq('item_id',       opts.itemId);
      if (opts.locationId)   q = q.eq('location_id',   opts.locationId);
      if (opts.movementType) q = q.eq('movement_type', opts.movementType);
      // dateFrom/dateTo are 'YYYY-MM-DD' (Bangkok calendar dates). Compare on
      // performed_at; dateTo is inclusive of the whole day.
      if (opts.dateFrom)     q = q.gte('performed_at', opts.dateFrom + 'T00:00:00+07:00');
      if (opts.dateTo)       q = q.lte('performed_at', opts.dateTo   + 'T23:59:59.999999+07:00');
      return q;
    });
  }

  // =========================================================================
  // Realtime
  // =========================================================================

  /**
   * Subscribe to live changes on stock_items + stock_item_locations.
   * Returns an unsubscribe function. Call it on tab teardown.
   * Spec §3 rows 6/7 + §5.7.
   * @param {(table: string, payload: object) => void} onChange
   * @returns {() => void} unsubscribe
   */
  function subscribeInventory(onChange) {
    const sb = getSupabaseClient();
    // Defensive: drop any stale channel of the same name first. Supabase
    // returns the EXISTING channel for a repeated channel(name) call, and
    // calling .on() on an already-subscribed channel throws
    // "cannot add postgres_changes callbacks ... after subscribe()".
    try {
      (sb.getChannels() || [])
        .filter((c) => c && c.topic === 'realtime:inv:phase1')
        .forEach((c) => sb.removeChannel(c));
    } catch { /* ignore */ }
    const ch = sb.channel('inv:phase1')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_items' },          (p) => onChange('stock_items', p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_item_locations' }, (p) => onChange('stock_item_locations', p))
      .subscribe();
    return () => { try { sb.removeChannel(ch); } catch { /* ignore */ } };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** @namespace AppInventory */
  const AppInventory = {
    // Categories
    listCategories,
    // Items — read
    listItems,
    getItem,
    searchByBarcode,
    findLocationByCode,
    getLowStock,
    // Items — write (Admin)
    createItem,
    updateItem,
    deactivateItem,
    // Movements — write
    receive,
    issue,
    adjustmentLoss,
    adjustmentGain,
    // (NO transfer — Phase 1 Q1)
    // Movements — read
    listRecentMovements,
    // Realtime
    subscribeInventory,
    // Utilities (exported for tests / future modules)
    _uuid,
    _classifyError,
  };

  window.AppInventory = AppInventory;

  // -------------------------------------------------------------------------
  // Backward-compatibility shims so any code already written against the
  // plan's flat helper names (Task C1 reference code, Phase D inventory.js)
  // keeps working without modification.
  // -------------------------------------------------------------------------
  window.invListCategories      = listCategories;
  window.invListItems           = listItems;
  window.invGetItem             = getItem;
  window.invCreateItem          = createItem;
  window.invUpdateItem          = updateItem;
  window.invFindItemByCode      = searchByBarcode;
  window.invFindLocationByCode  = findLocationByCode;
  window.invFindItemLocations   = async (itemId) => {
    const r = await getItem(itemId);
    if (r.error) throw r.error;
    return r.data ? r.data.locations : [];
  };
  window.invPostMovement        = async (args) => {
    // Map plan-style call ({ item_id, location_id, movement_type, qty_delta, ... }) to new API.
    const itemId       = args.item_id;
    const locationId   = args.location_id;
    const note         = args.note;
    const reason       = args.reason;
    const clientRefId  = args.client_ref_id;
    const qty          = Math.abs(Number(args.qty_delta || 0));
    const type         = args.movement_type;
    let res;
    if (type === 'receive')             res = await receive(itemId, locationId, qty, note, clientRefId);
    else if (type === 'issue')          res = await issue(itemId, locationId, qty, note, clientRefId);
    else if (type === 'adjustment_loss')res = await adjustmentLoss(itemId, locationId, qty, note, clientRefId);
    else if (type === 'adjustment_gain')res = await adjustmentGain(itemId, locationId, qty, note, clientRefId);
    else return { ok: false, error: { message: `unsupported movement_type in Phase 1: ${type}` } };
    if (res.error) {
      if (res.error.code === '42501') return { ok: false, error: res.error };
      throw res.error;
    }
    return {
      ok: true,
      idempotent_replay: !!(res.data && res.data.replay),
      client_ref_id:      res.data?.client_ref_id,
      movement:           res.data?.movement || null,
    };
  };
  window.invListRecentMovements = (limit) => listRecentMovements({ limit });
  window.invSubscribe           = subscribeInventory;
})();
