// shared/transfer.js
// Phase 0.7 — Transfer modal + location tree-picker + openForLocation scanner bridge.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase0.7-location-hierarchy-design.md  §5, §5.2, §5.2.1, §5.2.2
//
// Requires (loaded BEFORE this script):
//   shared/supabase-client.js  — window.getSupabaseClient()
//   shared/ui.js               — window.showToast(), window.escapeHtml()
//   shared/scanner.js          — window.AppScanner (extended in Phase 0.7)
//
// Public API: window.Transfer
//   Transfer.openModal({ itemId, lotId?, prefilledSourceId? })
//
// Internal helpers also used by scanner.js:
//   window.Transfer._openLocationTreePicker(opts)  — { resolve(locationRow), reject() }
//
// Locked decisions (PM Pex 2026-05-19):
//   D6: Manual location picker must reach leaf level — "เลือก" disabled until leaf.
//   §5.3: source depth !== destination depth is allowed.
//   §5.2.1: Camera failure → auto-open tree-picker + Thai toast per reason.
//   §5.2.2: navigator.mediaDevices undefined → scanner button hidden, manual is primary.

(function () {
  'use strict';

  // =========================================================================
  // Helpers
  // =========================================================================

  function _sb()   { return window.getSupabaseClient(); }
  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function _toast(type, msg) { (window.showToast || (()=>{}))(type, msg); }

  /** Wrap a Supabase query into { data, error }. */
  async function _safe(fn) {
    try {
      const result = await fn();
      if (result && result.error) return { data: null, error: result.error };
      return { data: result.data ?? null, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  /** Map a Supabase/RPC error to a Thai message. */
  function _thaiError(err) {
    if (!err) return 'เกิดข้อผิดพลาด';
    const msg = err.message || String(err);
    // RPC error messages are already in Thai per spec §5.1
    if (/ตำแหน่งต้นทาง/.test(msg)) return msg;
    if (/จำนวนที่ย้าย/.test(msg))   return msg;
    if (/ของไม่พอ/.test(msg))       return msg;
    if (err.code === '42501')        return 'ไม่มีสิทธิ์ทำรายการนี้';
    if (err.code === '23505')        return 'รายการซ้ำ — ดำเนินการแล้ว';
    return msg;
  }

  // =========================================================================
  // Camera availability (§5.2.2)
  // =========================================================================

  const _cameraAvailable = !!(navigator.mediaDevices);
  // Expose for scanner.js to read.

  // =========================================================================
  // Location data helpers
  // =========================================================================

  /**
   * Fetch a location row joined with v_location_path for breadcrumb + type.
   * @param {string} id  UUID
   * @returns {Promise<{id,code,name,type,path_display}|null>}
   */
  async function _fetchLocationById(id) {
    const sb = _sb();
    const r = await sb.from('v_location_path')
      .select('id,name,type,path_display')
      .eq('id', id)
      .single();
    if (r.error || !r.data) return null;
    // Also grab code from locations table
    const cr = await sb.from('locations').select('code').eq('id', id).single();
    return { ...r.data, code: cr.data?.code ?? '' };
  }

  /**
   * Fetch current qty for item at a location from stock_item_locations.
   * @returns {Promise<number>}
   */
  async function _fetchSourceQty(itemId, locationId) {
    const sb = _sb();
    const r = await sb.from('stock_item_locations')
      .select('qty')
      .eq('item_id', itemId)
      .eq('location_id', locationId)
      .maybeSingle();
    if (r.error || !r.data) return 0;
    return r.data.qty ?? 0;
  }

  /**
   * Fetch available lots for an item.
   * @returns {Promise<Array>}
   */
  async function _fetchLots(itemId) {
    const sb = _sb();
    const r = await sb.from('stock_lots')
      .select('id,lot_number,expiry_date')
      .eq('item_id', itemId)
      .gt('remaining_qty', 0)
      .order('expiry_date', { ascending: true, nullsFirst: false });
    if (r.error) return [];
    return r.data || [];
  }

  // =========================================================================
  // Location Tree Picker modal
  // =========================================================================

  /**
   * Open a full-screen Bootstrap modal showing the location hierarchy as a
   * cascading drill-down.  Resolves with the selected location row when the
   * user taps "เลือก", rejects when they tap "ยกเลิก" / close.
   *
   * opts.prefilledId — if provided the picker pre-selects that node.
   *
   * @param {{ prefilledId?: string }} [opts]
   * @returns {Promise<{id,code,name,type,path_display,scanned:false}>}
   */
  function _openLocationTreePicker(opts = {}) {
    return new Promise((resolve, reject) => {
      _buildTreePickerModal(opts, resolve, reject);
    });
  }

  async function _buildTreePickerModal(opts, resolve, reject) {
    // Load all active locations once
    const sb = _sb();
    const r = await sb.from('locations')
      .select('id,code,name,type,parent_id,active')
      .eq('active', true)
      .order('type').order('name');
    const allLocs = r.data || [];

    // Build child-map
    const childrenOf = {};
    allLocs.forEach((loc) => {
      const pid = loc.parent_id || '__root__';
      if (!childrenOf[pid]) childrenOf[pid] = [];
      childrenOf[pid].push(loc);
    });

    // Root nodes: no parent_id (rooms + ambulances)
    const roots = childrenOf['__root__'] || [];

    // State: breadcrumb trail and current selection
    let trail = [];       // [{loc}] selected ancestors
    let currentLevel = roots;
    let selectedLeaf = null;

    // Remove any previous picker
    const old = document.getElementById('transfer-tree-picker-modal');
    if (old) try { old.remove(); } catch { /* ignore */ }

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal fade" id="transfer-tree-picker-modal" tabindex="-1"
           aria-labelledby="tree-picker-title">
        <div class="modal-dialog modal-dialog-centered modal-fullscreen-sm-down modal-lg">
          <div class="modal-content" style="max-height:90vh;display:flex;flex-direction:column;">
            <div class="modal-header py-2">
              <div class="flex-grow-1">
                <h5 class="modal-title mb-0" id="tree-picker-title">เลือกตำแหน่ง</h5>
                <div id="tree-picker-breadcrumb" class="text-muted small mt-1">ระดับบนสุด</div>
              </div>
              <button type="button" class="btn-close ms-2" data-bs-dismiss="modal"
                      aria-label="ปิด"></button>
            </div>
            <div class="modal-body p-2" style="overflow-y:auto;flex:1 1 auto;">
              <div id="tree-picker-list"></div>
            </div>
            <div class="modal-footer py-2 gap-2">
              <button type="button" class="btn btn-outline-secondary" id="tree-picker-back"
                      style="min-height:44px;" disabled>
                <i class="bi bi-arrow-left"></i> ย้อนกลับ
              </button>
              <button type="button" class="btn btn-outline-secondary flex-grow-1" id="tree-picker-cancel"
                      data-bs-dismiss="modal" style="min-height:44px;">ยกเลิก</button>
              <button type="button" class="btn btn-stock-primary" id="tree-picker-select"
                      style="min-height:44px;" disabled>
                เลือก
              </button>
            </div>
          </div>
        </div>
      </div>`;
    const modalEl = wrap.firstChild;
    document.body.appendChild(modalEl);
    const bsModal = new bootstrap.Modal(modalEl, { backdrop: 'static' });

    const listEl        = modalEl.querySelector('#tree-picker-list');
    const breadcrumbEl  = modalEl.querySelector('#tree-picker-breadcrumb');
    const backBtn       = modalEl.querySelector('#tree-picker-back');
    const selectBtn     = modalEl.querySelector('#tree-picker-select');

    function _renderLevel() {
      listEl.innerHTML = '';
      currentLevel.forEach((loc) => {
        const children = childrenOf[loc.id] || [];
        const hasChildren = children.length > 0;
        const isLeaf = !hasChildren;
        const selected = selectedLeaf && selectedLeaf.id === loc.id;
        const typeLabel = _locTypeLabel(loc.type);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `d-flex w-100 align-items-center gap-2 text-start border rounded mb-1 p-2
          ${selected ? 'btn-stock-primary text-white' : 'btn btn-outline-secondary'}`;
        btn.style.minHeight = '48px';
        btn.innerHTML = `
          <span class="badge bg-secondary text-white" style="min-width:52px;font-size:0.7rem;">${_esc(typeLabel)}</span>
          <span class="flex-grow-1">
            <strong>${_esc(loc.code || loc.name)}</strong>
            ${loc.code ? `<span class="ms-1 opacity-75">${_esc(loc.name)}</span>` : ''}
          </span>
          ${hasChildren ? '<i class="bi bi-chevron-right opacity-50"></i>' : ''}
        `;
        btn.addEventListener('click', () => {
          if (hasChildren) {
            // Drill down
            trail.push({ loc, level: currentLevel });
            currentLevel = children;
            selectedLeaf = null;
            _renderLevel();
          } else {
            // Leaf — mark selected
            selectedLeaf = loc;
            _renderLevel();
          }
          _updateControls();
        });
        listEl.appendChild(btn);
      });

      // Breadcrumb
      if (trail.length === 0) {
        breadcrumbEl.textContent = 'ระดับบนสุด';
      } else {
        breadcrumbEl.textContent = trail.map((t) => t.loc.name).join(' › ');
      }
    }

    function _updateControls() {
      backBtn.disabled   = trail.length === 0;
      // D6: "เลือก" disabled until a leaf is selected
      selectBtn.disabled = !selectedLeaf;
    }

    backBtn.addEventListener('click', () => {
      if (trail.length === 0) return;
      const prev = trail.pop();
      currentLevel = prev.level;
      selectedLeaf = null;
      _renderLevel();
      _updateControls();
    });

    selectBtn.addEventListener('click', async () => {
      if (!selectedLeaf) return;
      selectBtn.disabled = true;
      selectBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังโหลด…';
      // Fetch path_display from view
      const loc = await _fetchLocationById(selectedLeaf.id);
      bsModal.hide();
      resolve(loc ? { ...loc, scanned: false } : { ...selectedLeaf, path_display: selectedLeaf.name, scanned: false });
    });

    modalEl.addEventListener('hidden.bs.modal', () => {
      if (!selectedLeaf) reject(new Error('cancelled'));
      try { modalEl.remove(); } catch { /* ignore */ }
    });

    _renderLevel();
    _updateControls();
    bsModal.show();
  }

  function _locTypeLabel(type) {
    return {
      room: 'ห้อง', storage: 'ตู้/ชั้น', cabinet: 'ตู้', shelf: 'ชั้น',
      bin: 'ตะกร้า', ambulance: 'รถ', bag: 'กระเป๋า', zone: 'โซน',
    }[type] || type;
  }

  // =========================================================================
  // Transfer modal
  // =========================================================================

  /**
   * Open the transfer modal.
   * @param {{ itemId: string, lotId?: string|null, prefilledSourceId?: string }} opts
   */
  async function openModal(opts = {}) {
    const { itemId, lotId = null, prefilledSourceId = null } = opts;
    if (!itemId) { _toast('error', 'ไม่ระบุ itemId'); return; }

    // Load item info
    const sb = _sb();
    const itemR = await sb.from('stock_items')
      .select('id,sku,name,unit,tracks_lots,active')
      .eq('id', itemId)
      .single();
    if (itemR.error || !itemR.data) {
      _toast('error', 'โหลดข้อมูลสินค้าไม่สำเร็จ');
      return;
    }
    const item = itemR.data;

    // Modal state
    const s = {
      sourceLoc:    null,   // { id, name, code, type, path_display, scanned }
      destLoc:      null,
      sourceQty:    0,      // current qty at source location
      selectedLotId: lotId,
      lots:         [],
      qty:          0,
      note:         '',
    };

    // Pre-fill source if provided
    if (prefilledSourceId) {
      const srcLoc = await _fetchLocationById(prefilledSourceId);
      if (srcLoc) {
        s.sourceLoc = { ...srcLoc, scanned: false };
        s.sourceQty = await _fetchSourceQty(itemId, prefilledSourceId);
      }
    }

    // Fetch lots if needed
    if (item.tracks_lots) {
      s.lots = await _fetchLots(itemId);
      if (!s.selectedLotId && s.lots.length > 0) s.selectedLotId = s.lots[0].id;
    }

    // Remove stale modal if any
    const oldM = document.getElementById('transfer-modal');
    if (oldM) try { oldM.remove(); } catch { /* ignore */ }

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal fade" id="transfer-modal" tabindex="-1" aria-labelledby="transfer-modal-title">
        <div class="modal-dialog modal-dialog-centered modal-fullscreen-sm-down modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <div>
                <h5 class="modal-title mb-0" id="transfer-modal-title">
                  <i class="bi bi-arrows-move me-1"></i> ย้ายของ
                </h5>
                <small class="text-muted">
                  <code>${_esc(item.sku)}</code> ${_esc(item.name)}
                </small>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body">

              ${item.tracks_lots ? `
              <!-- Lot dropdown -->
              <div class="mb-3">
                <label class="form-label fw-semibold" for="tf-lot">ล็อต</label>
                <select id="tf-lot" class="form-select" style="min-height:44px;">
                  ${s.lots.length === 0
                    ? '<option value="">— ไม่มีล็อต —</option>'
                    : s.lots.map((l) =>
                        `<option value="${_esc(l.id)}" ${l.id === s.selectedLotId ? 'selected' : ''}>
                          ${_esc(l.lot_number)}${l.expiry_date ? ' · หมดอายุ ' + _esc(l.expiry_date) : ''}
                        </option>`
                      ).join('')}
                </select>
              </div>` : ''}

              <!-- Source location -->
              <div class="mb-3">
                <label class="form-label fw-semibold">จากตำแหน่ง</label>
                <div id="tf-source-display"
                     class="rounded border p-2 text-muted small"
                     style="min-height:44px;background:var(--fc-paper,#f8f5ef);">
                  ${s.sourceLoc
                    ? `<div class="fw-semibold text-dark">${_esc(s.sourceLoc.path_display)}</div>
                       <div class="text-muted" id="tf-source-qty-display">จำนวนปัจจุบัน: ${s.sourceQty} ${_esc(item.unit || 'ชิ้น')}</div>`
                    : '(ยังไม่ได้เลือก)'}
                </div>
                <div class="d-flex gap-2 mt-1">
                  ${_cameraAvailable
                    ? `<button type="button" class="btn btn-outline-secondary flex-fill btn-loc-scan"
                               data-role="source" style="min-height:44px;">
                         <i class="bi bi-camera me-1"></i> สแกน QR
                       </button>`
                    : ''}
                  <button type="button" class="btn btn-outline-secondary flex-fill btn-loc-pick"
                          data-role="source" style="min-height:44px;">
                    <i class="bi bi-list-ul me-1"></i> เลือกจากรายการ
                  </button>
                </div>
              </div>

              <!-- Destination location -->
              <div class="mb-3">
                <label class="form-label fw-semibold">ไปตำแหน่ง</label>
                <div id="tf-dest-display"
                     class="rounded border p-2 text-muted small"
                     style="min-height:44px;background:var(--fc-paper,#f8f5ef);">
                  (ยังไม่ได้เลือก)
                </div>
                <div class="d-flex gap-2 mt-1">
                  ${_cameraAvailable
                    ? `<button type="button" class="btn btn-outline-secondary flex-fill btn-loc-scan"
                               data-role="dest" style="min-height:44px;">
                         <i class="bi bi-camera me-1"></i> สแกน QR
                       </button>`
                    : ''}
                  <button type="button" class="btn btn-outline-secondary flex-fill btn-loc-pick"
                          data-role="dest" style="min-height:44px;">
                    <i class="bi bi-list-ul me-1"></i> เลือกจากรายการ
                  </button>
                </div>
              </div>

              <!-- Qty + note -->
              <div class="row g-2">
                <div class="col-6">
                  <label class="form-label fw-semibold" for="tf-qty">
                    จำนวน ${s.sourceLoc ? `(สูงสุด ${s.sourceQty})` : ''}
                  </label>
                  <input type="number" id="tf-qty" class="form-control"
                         min="1" max="${s.sourceQty || 99999}" step="1"
                         inputmode="numeric" pattern="[0-9]*"
                         style="min-height:44px;" placeholder="0"
                         value="${s.qty > 0 ? s.qty : ''}">
                </div>
                <div class="col-12">
                  <label class="form-label fw-semibold" for="tf-note">หมายเหตุ</label>
                  <textarea id="tf-note" class="form-control" rows="2"
                            maxlength="200" placeholder="(ไม่บังคับ)"></textarea>
                </div>
              </div>
            </div><!-- /.modal-body -->

            <div class="modal-footer flex-wrap gap-2">
              <button type="button" class="btn btn-outline-secondary"
                      data-bs-dismiss="modal" style="min-height:44px;">ยกเลิก</button>
              <button type="button" id="tf-submit"
                      class="btn btn-stock-primary flex-grow-1" style="min-height:44px;">
                <i class="bi bi-arrows-move me-1"></i> ยืนยันการย้าย
              </button>
            </div>
          </div>
        </div>
      </div>`;
    const modalEl = wrap.firstChild;
    document.body.appendChild(modalEl);
    const bsModal = new bootstrap.Modal(modalEl);

    // ---- Refs ----
    const sourceDisplay    = modalEl.querySelector('#tf-source-display');
    const destDisplay      = modalEl.querySelector('#tf-dest-display');
    const qtyInput         = modalEl.querySelector('#tf-qty');
    const noteInput        = modalEl.querySelector('#tf-note');
    const submitBtn        = modalEl.querySelector('#tf-submit');
    const lotSel           = modalEl.querySelector('#tf-lot');

    // Sync lot selector to state
    if (lotSel) {
      lotSel.addEventListener('change', () => { s.selectedLotId = lotSel.value || null; });
    }
    qtyInput.addEventListener('input', () => {
      s.qty = Math.max(0, parseInt(qtyInput.value || '0', 10));
    });
    noteInput.addEventListener('input', () => { s.note = noteInput.value.trim(); });

    // ---- Location display helpers ----
    function _renderSourceDisplay() {
      if (!s.sourceLoc) {
        sourceDisplay.innerHTML = '(ยังไม่ได้เลือก)';
      } else {
        sourceDisplay.innerHTML = `
          <div class="fw-semibold text-dark">${_esc(s.sourceLoc.path_display || s.sourceLoc.name)}</div>
          <div class="text-muted">จำนวนปัจจุบัน: ${s.sourceQty} ${_esc(item.unit || 'ชิ้น')}</div>`;
        // Update qty max
        qtyInput.max = String(s.sourceQty);
        const qtyLabel = modalEl.querySelector('label[for="tf-qty"]');
        if (qtyLabel) qtyLabel.textContent = `จำนวน (สูงสุด ${s.sourceQty})`;
      }
    }
    function _renderDestDisplay() {
      if (!s.destLoc) {
        destDisplay.innerHTML = '(ยังไม่ได้เลือก)';
      } else {
        destDisplay.innerHTML = `
          <div class="fw-semibold text-dark">${_esc(s.destLoc.path_display || s.destLoc.name)}</div>`;
      }
    }

    // ---- Scan / pick buttons ----
    modalEl.querySelectorAll('.btn-loc-scan').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const role = btn.dataset.role; // 'source' | 'dest'
        btn.disabled = true;
        try {
          const loc = await window.AppScanner.openForLocation();
          _applyLocation(role, loc);
        } catch (e) {
          if (e && e.message !== 'cancelled') {
            _toast('error', e.message || 'สแกนล้มเหลว');
          }
        } finally {
          btn.disabled = false;
        }
      });
    });

    modalEl.querySelectorAll('.btn-loc-pick').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const role = btn.dataset.role;
        btn.disabled = true;
        try {
          const loc = await _openLocationTreePicker({});
          _applyLocation(role, loc);
        } catch (e) {
          // user cancelled — do nothing
        } finally {
          btn.disabled = false;
        }
      });
    });

    async function _applyLocation(role, loc) {
      if (!loc) return;
      if (role === 'source') {
        s.sourceLoc  = loc;
        s.sourceQty  = await _fetchSourceQty(itemId, loc.id);
        _renderSourceDisplay();
      } else {
        s.destLoc = loc;
        _renderDestDisplay();
      }
    }

    // ---- Submit ----
    submitBtn.addEventListener('click', async () => {
      // Client-side validation
      if (!s.sourceLoc) { _toast('warning', 'กรุณาเลือกตำแหน่งต้นทาง'); return; }
      if (!s.destLoc)   { _toast('warning', 'กรุณาเลือกตำแหน่งปลายทาง'); return; }
      if (s.sourceLoc.id === s.destLoc.id) {
        _toast('warning', 'ตำแหน่งต้นทางและปลายทางต้องไม่เหมือนกัน'); return;
      }
      const qty = parseInt(qtyInput.value || '0', 10);
      if (!qty || qty <= 0) { _toast('warning', 'กรุณาระบุจำนวนที่ต้องการย้าย'); return; }
      if (qty > s.sourceQty) {
        _toast('warning', `ของไม่พอ (มี ${s.sourceQty} ต้องการ ${qty})`); return;
      }
      if (item.tracks_lots && !s.selectedLotId) {
        _toast('warning', 'สินค้านี้ต้องเลือกล็อตก่อนย้าย'); return;
      }

      // Disable while submitting
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';

      const clientRefId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : _uuid4();

      try {
        const sb2 = _sb();
        const rpc = await sb2.rpc('transfer_stock', {
          p_item_id:       itemId,
          p_lot_id:        s.selectedLotId || null,
          p_source_loc_id: s.sourceLoc.id,
          p_dest_loc_id:   s.destLoc.id,
          p_qty:           qty,
          p_source_scanned: !!(s.sourceLoc.scanned),
          p_dest_scanned:   !!(s.destLoc.scanned),
          p_note:          noteInput.value.trim() || null,
          p_client_ref_id: clientRefId,
        });

        if (rpc.error) {
          // 409 / unique-violation = idempotent duplicate → treat as success
          if (rpc.error.code === '23505' || (rpc.error.message || '').includes('unique')) {
            _toast('success', 'ย้ายของสำเร็จ (รายการเดิม)');
            bsModal.hide();
            _dispatchRefresh(itemId);
            return;
          }
          _toast('error', _thaiError(rpc.error));
          return;
        }

        _toast('success', `ย้าย ${qty} ${item.unit || 'ชิ้น'} สำเร็จ`);
        bsModal.hide();
        _dispatchRefresh(itemId);
      } catch (e) {
        _toast('error', _thaiError(e));
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="bi bi-arrows-move me-1"></i> ยืนยันการย้าย';
      }
    });

    // Clean up DOM after modal closes
    modalEl.addEventListener('hidden.bs.modal', () => {
      try { modalEl.remove(); } catch { /* ignore */ }
    });

    // Pre-render existing source if filled
    _renderSourceDisplay();
    _renderDestDisplay();

    bsModal.show();
    // Focus qty if source already known
    if (s.sourceLoc) setTimeout(() => { try { qtyInput.focus(); } catch {} }, 200);
  }

  // =========================================================================
  // Custom event to signal UI refresh after transfer
  // =========================================================================

  function _dispatchRefresh(itemId) {
    try {
      window.dispatchEvent(new CustomEvent('transfer:done', { detail: { itemId } }));
    } catch { /* ignore */ }
  }

  // =========================================================================
  // Fallback UUID (used when crypto.randomUUID unavailable)
  // =========================================================================

  function _uuid4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  window.Transfer = {
    openModal,
    // Exposed for scanner.js fallback path
    _openLocationTreePicker,
    cameraAvailable: _cameraAvailable,
  };
})();
