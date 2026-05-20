// shared/linens.js
// Phase 6 — Linens & Laundry: REST helpers for linen workflows.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase6-linens-laundry-design.md   §4, §5, §7
//   docs/superpowers/specs/2026-05-19-phase6-decisions-locked.md        Q6-A through Q6-F
//   docs/superpowers/designs/2026-05-19-phase6-linens-ui-design.md      §3.5–§3.8
//
// Architectural constraints (REUSE, NOT DUPLICATE — spec §1.1):
//   — Linens ARE stock_items with category=LINEN. No parallel linen table.
//   — Cabinets ARE locations with type='cabinet'. No parallel cabinet table.
//   — ส่งซัก = stock_movements(movement_type='adjustment_loss', reason='laundry_out')
//   — รับคืน = stock_movements(movement_type='adjustment_gain', reason='laundry_in')
//   — นับใหม่ = INSERT INTO linen_counts (count snapshot; does NOT change stock_item_locations.qty)
//
// Photo reuse:
//   shared/photo-capture.js (Phase 3) is reused as-is. This module does NOT redefine it.
//   PhotoCaptureModal.open() is called by the UI layer (js/staff-scan.js, js/inventory.js).
//
// Requires (loaded before this script):
//   shared/supabase-client.js  — getSupabaseClient()
//   shared/auth-jwt.js         — getUserRole(), getUsername()
//   shared/ui.js               — showToast(), escapeHtml()
//
// Public namespace: window.AppLinens

(function () {
  'use strict';

  // =========================================================================
  // Internal helpers
  // =========================================================================

  function _sb() { return window.getSupabaseClient(); }

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  async function _safe(run) {
    try {
      const r = await run();
      if (r && typeof r === 'object' && ('data' in r || 'error' in r)) return r;
      return { data: r, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  // =========================================================================
  // Sub-category Thai labels (spec §7.1)
  // =========================================================================

  const SUBCATEGORY_LABELS = {
    sheet:      'ผ้าปูที่นอน',
    blanket:    'ผ้าห่ม',
    towel:      'ผ้าขนหนู',
    gown:       'เสื้อกาวน์',
    wipe:       'ผ้าเช็ดเครื่องมือ',
    pillowcase: 'ปลอกหมอน',
  };

  const SUBCATEGORY_VALUES = ['sheet', 'blanket', 'towel', 'gown', 'wipe', 'pillowcase'];

  /**
   * Returns Thai display label for a linen_subcategory enum value.
   * @param {string|null} value
   * @returns {string}
   */
  function subcategoryLabel(value) {
    return SUBCATEGORY_LABELS[value] || value || '—';
  }

  // =========================================================================
  // LINEN filter helper
  // =========================================================================

  /**
   * Returns true if the given stock_items row is a LINEN item.
   * category can be code string or {code: string} object.
   * @param {{ category?: string|{code:string}, linen_subcategory?: string }} item
   * @returns {boolean}
   */
  function isLinenItem(item) {
    if (!item) return false;
    const cat = item.category;
    if (typeof cat === 'string') return cat === 'LINEN';
    if (cat && typeof cat === 'object') return cat.code === 'LINEN';
    // Fallback: check if linen_subcategory is set
    return !!item.linen_subcategory;
  }

  // =========================================================================
  // fetchLinenAudit
  // Fetches all rows from v_linen_audit.
  // Optionally filtered by subcategory (client-side after fetch).
  // Returns { data: row[], error }
  // =========================================================================

  async function fetchLinenAudit() {
    return _safe(() =>
      _sb()
        .from('v_linen_audit')
        .select('*')
        .order('location_name', { ascending: true })
        .order('item_name',     { ascending: true })
    );
  }

  // =========================================================================
  // fetchLinenByCabinet
  // For a given cabinet location_id, fetch LINEN items with audit data.
  // Returns { data: row[], error }
  // Each row: { location_id, location_code, location_name, item_id, sku, item_name,
  //             linen_subcategory, current_qty, counted_qty, counted_at, counted_by,
  //             photo_url, delta, abs_delta, is_discrepancy, threshold_pct, min_pieces }
  // =========================================================================

  async function fetchLinenByCabinet(locationId) {
    if (!locationId) return { data: null, error: new Error('locationId required') };
    return _safe(() =>
      _sb()
        .from('v_linen_audit')
        .select('*')
        .eq('location_id', locationId)
        .order('item_name', { ascending: true })
    );
  }

  // =========================================================================
  // submitLinenCount  (นับใหม่)
  // INSERT INTO linen_counts.
  // Does NOT change stock_item_locations.qty — count is a snapshot only.
  //
  // @param {{ locationId, itemId, countedQty, photoUrl?, note? }} opts
  // @returns {Promise<{ data, error }>}
  // =========================================================================

  async function submitLinenCount({ locationId, itemId, countedQty, photoUrl, note }) {
    if (!locationId || !itemId || countedQty == null) {
      return { data: null, error: new Error('locationId, itemId และ countedQty จำเป็น') };
    }
    return _safe(() =>
      _sb()
        .from('linen_counts')
        .insert({
          location_id: locationId,
          item_id:     itemId,
          counted_qty: Number(countedQty),
          photo_url:   photoUrl || null,
          note:        note     || null,
        })
        .select()
        .single()
    );
  }

  // =========================================================================
  // submitLinenMovement  (ส่งซัก + รับคืน)
  // INSERT INTO stock_movements with reason = 'laundry_out' or 'laundry_in'.
  //
  // @param {{
  //   flow:       'laundry_out' | 'laundry_in',
  //   itemId:     string,
  //   locationId: string,
  //   qty:        number,
  //   photoUrl:   string,   // required — enforced by frontend caller
  //   note?:      string,
  // }} opts
  // @returns {Promise<{ data, error }>}
  // =========================================================================

  async function submitLinenMovement({ flow, itemId, locationId, qty, photoUrl, note }) {
    if (!flow || !itemId || !locationId || !qty) {
      return { data: null, error: new Error('flow, itemId, locationId และ qty จำเป็น') };
    }
    if (!photoUrl) {
      return { data: null, error: new Error('photoUrl จำเป็นสำหรับการเคลื่อนไหวผ้า (Q6-B)') };
    }

    const isOut = flow === 'laundry_out';
    const movementType = isOut ? 'adjustment_loss' : 'adjustment_gain';
    const qtyDelta     = isOut ? -Math.abs(qty) : Math.abs(qty);

    return _safe(() =>
      _sb()
        .from('stock_movements')
        .insert({
          item_id:       itemId,
          location_id:   locationId,
          movement_type: movementType,
          qty_delta:     qtyDelta,
          reason:        flow,           // 'laundry_out' or 'laundry_in'
          note:          photoUrl + (note ? ' | ' + note : ''),
          client_ref_id: _uuid(),
        })
        .select()
        .single()
    );
  }

  // =========================================================================
  // sendToLaundry  — convenience wrapper for ส่งซัก
  // @param {{ itemId, locationId, qty, photoUrl, note? }} opts
  // =========================================================================

  function sendToLaundry({ itemId, locationId, qty, photoUrl, note }) {
    return submitLinenMovement({ flow: 'laundry_out', itemId, locationId, qty, photoUrl, note });
  }

  // =========================================================================
  // receiveFromLaundry  — convenience wrapper for รับคืน
  // @param {{ itemId, locationId, qty, photoUrl, note? }} opts
  // =========================================================================

  function receiveFromLaundry({ itemId, locationId, qty, photoUrl, note }) {
    return submitLinenMovement({ flow: 'laundry_in', itemId, locationId, qty, photoUrl, note });
  }

  // =========================================================================
  // formatDate  — Thai short date for นับล่าสุด column
  // =========================================================================

  function formatDate(isoString) {
    if (!isoString) return 'ยังไม่เคยนับ';
    const d = new Date(isoString);
    if (isNaN(d)) return '—';
    // Buddhist year: +543
    return d.toLocaleDateString('th-TH', {
      day: 'numeric', month: 'short', year: '2-digit',
      timeZone: 'Asia/Bangkok',
    });
  }

  // =========================================================================
  // discrepancyBadgeHtml
  // Returns Bootstrap badge HTML for the delta/discrepancy column.
  // =========================================================================

  function discrepancyBadgeHtml(row) {
    // No count yet
    if (row.counted_at == null) {
      return '<span class="text-muted">— ยังไม่เคยนับ</span>';
    }
    const d = row.delta ?? 0;
    const sign = d > 0 ? '+' : '';
    if (row.is_discrepancy) {
      return `<span class="badge bg-danger">${sign}${_esc(String(d))}</span>`;
    }
    if (row.abs_delta >= 1) {
      // Close to threshold (UX §3.2.4) — amber advisory
      return `<span class="badge bg-warning text-dark">${sign}${_esc(String(d))}</span>`;
    }
    return `<span class="badge bg-success">0</span>`;
  }

  // =========================================================================
  // Public namespace
  // =========================================================================

  window.AppLinens = {
    // Constants
    SUBCATEGORY_VALUES,
    SUBCATEGORY_LABELS,

    // Helpers
    subcategoryLabel,
    isLinenItem,
    formatDate,
    discrepancyBadgeHtml,

    // REST
    fetchLinenAudit,
    fetchLinenByCabinet,
    submitLinenCount,
    submitLinenMovement,
    sendToLaundry,
    receiveFromLaundry,
  };

})();
