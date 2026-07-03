// shared/laundry.js
// Phase 0.7+ — Laundry quick-action modals (5 actions; fold_back deferred).
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase0.7-location-hierarchy-design.md  D11 + §5
//
// Requires (loaded before this script):
//   shared/supabase-client.js  — window.getSupabaseClient()
//   shared/ui.js               — window.showToast(), window.escapeHtml()
//   Bootstrap 5 (modal JS)
//
// Public namespace: window.Laundry
//   Laundry.openModal(action, opts?)
//   action ∈ {'fill_vehicle','mark_dirty','send_wash','receive_back'}
//   fold_back deferred — usually combined with receive_back step

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
  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  async function _safe(fn) {
    try {
      const r = await fn();
      if (r && r.error) return { data: null, error: r.error };
      return { data: r.data ?? r ?? null, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  function _errMsg(err) {
    if (!err) return 'เกิดข้อผิดพลาด';
    if (err.message) return err.message;
    return String(err);
  }

  // =========================================================================
  // Data fetchers
  // =========================================================================

  /** Cache the LINEN category UUID (Phase 6 schema uses category_id FK
   *  to stock_categories, not a is_linen boolean column). */
  let _linenCategoryId = null;
  async function _getLinenCategoryId() {
    if (_linenCategoryId) return _linenCategoryId;
    const { data, error } = await _sb()
      .from('stock_categories').select('id').eq('code', 'LINEN').single();
    if (error || !data) return null;
    _linenCategoryId = data.id;
    return _linenCategoryId;
  }

  /** Fetch all linen stock items (category_id matches LINEN). */
  async function _fetchLinenItems() {
    const linenCatId = await _getLinenCategoryId();
    if (!linenCatId) return { data: [], error: null };
    return _safe(() =>
      _sb().from('stock_items')
        .select('id,sku,name,linen_subcategory,category_id')
        .eq('category_id', linenCatId)
        .eq('active', true)
        .order('name')
    );
  }

  /** Fetch locations by laundry_role. */
  async function _fetchLocsByRole(role) {
    return _safe(() =>
      _sb().from('locations')
        .select('id,code,name,type,laundry_role')
        .eq('laundry_role', role)
        .eq('active', true)
        .order('name')
    );
  }

  /**
   * For fill_vehicle: find best "clean" source for a given item —
   * highest qty among stock_item_locations at laundry_role='clean' locations.
   * Returns { location_id, location_name, qty } or null.
   */
  async function _bestCleanSource(itemId) {
    const { data, error } = await _safe(() =>
      _sb().from('stock_item_locations')
        .select('location_id, qty, locations(id,name,laundry_role)')
        .eq('item_id', itemId)
        .gt('qty', 0)
    );
    if (error || !data) return null;
    const clean = data.filter((r) => r.locations?.laundry_role === 'clean');
    if (!clean.length) return null;
    clean.sort((a, b) => b.qty - a.qty);
    return { location_id: clean[0].location_id, location_name: clean[0].locations.name, qty: clean[0].qty };
  }

  /**
   * For receive_back: fetch items currently at external location with qty > 0.
   * Returns [{ item_id, item_name, sku, qty }]
   */
  async function _fetchExternalStock(extLocId) {
    return _safe(() =>
      _sb().from('stock_item_locations')
        .select('item_id, qty, stock_items(id,name,sku,category_id)')
        .eq('location_id', extLocId)
        .gt('qty', 0)
    );
  }

  // =========================================================================
  // RPC call wrappers
  // =========================================================================

  async function _transfer(itemId, sourceLoc, destLoc, qty, note) {
    return _safe(() =>
      _sb().rpc('transfer_stock', {
        p_item_id:        itemId,
        p_lot_id:         null,
        p_source_loc_id:  sourceLoc,
        p_dest_loc_id:    destLoc,
        p_qty:            qty,
        p_source_scanned: false,
        p_dest_scanned:   false,
        p_note:           note,
        p_client_ref_id:  _uuid(),
      })
    );
  }

  async function _insertLoss(itemId, locId, lossQty, note) {
    return _safe(() =>
      _sb().from('stock_movements').insert({
        item_id:       itemId,
        location_id:   locId,
        movement_type: 'adjustment_loss',
        qty_delta:     -Math.abs(lossQty),
        reason:        'laundry lost',
        note:          note,
        performed_by:  null, // RLS will set from JWT
      })
    );
  }

  // =========================================================================
  // Modal scaffold helpers
  // =========================================================================

  const MODAL_ID = 'laundry-modal';

  function _ensureModalShell() {
    let el = document.getElementById(MODAL_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = MODAL_ID;
      el.className = 'modal fade';
      el.tabIndex = -1;
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('role', 'dialog');
      el.innerHTML = `
        <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="laundry-modal-title"></h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body" id="laundry-modal-body"></div>
            <div class="modal-footer" id="laundry-modal-footer"></div>
          </div>
        </div>`;
      document.body.appendChild(el);
    }
    return el;
  }

  function _showModal(title, bodyHtml, footerHtml) {
    const el = _ensureModalShell();
    document.getElementById('laundry-modal-title').textContent = title;
    document.getElementById('laundry-modal-body').innerHTML    = bodyHtml;
    document.getElementById('laundry-modal-footer').innerHTML  = footerHtml;
    const m = bootstrap.Modal.getOrCreateInstance(el);
    m.show();
    return { el, modal: m };
  }

  function _closeModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) bootstrap.Modal.getOrCreateInstance(el).hide();
  }

  /** Render a progress bar inside modal-body (for batch ops). */
  function _renderProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return `
      <div class="mb-3">
        <div class="d-flex justify-content-between small mb-1">
          <span>กำลังดำเนินการ…</span><span>${done}/${total}</span>
        </div>
        <div class="progress" style="height:10px">
          <div class="progress-bar bg-success" style="width:${pct}%" role="progressbar"
               aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div>
        </div>
      </div>`;
  }

  /** Simple select HTML helper. */
  function _selectHtml(id, opts, placeholder) {
    const optHtml = opts.map((o) =>
      `<option value="${_esc(o.value)}">${_esc(o.label)}</option>`
    ).join('');
    return `
      <select id="${id}" class="form-select">
        <option value="">${_esc(placeholder)}</option>
        ${optHtml}
      </select>`;
  }

  // =========================================================================
  // Action: fill_vehicle — เติมรถ
  // =========================================================================

  async function _openFillVehicle() {
    _showModal('เติมรถ (fill_vehicle)', '<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> กำลังโหลด…</div>', '');

    const [itemsRes, vehiclesRes] = await Promise.all([
      _fetchLinenItems(),
      _fetchLocsByRole('vehicle'),
    ]);

    if (itemsRes.error || !itemsRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบสินค้าผ้า (category=LINEN) ในระบบ</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }
    if (vehiclesRes.error || !vehiclesRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบ location laundry_role='vehicle'</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }

    const items    = itemsRes.data;
    const vehicles = vehiclesRes.data;

    document.getElementById('laundry-modal-body').innerHTML = `
      <div class="mb-3">
        <label class="form-label">สินค้าผ้า</label>
        ${_selectHtml('lnd-fv-item', items.map((i) => ({ value: i.id, label: `${i.name} (${i.sku})` })), '— เลือกสินค้า —')}
      </div>
      <div class="mb-3">
        <label class="form-label">ปลายทาง (รถ)</label>
        ${_selectHtml('lnd-fv-vehicle', vehicles.map((v) => ({ value: v.id, label: v.name })), '— เลือกรถ —')}
      </div>
      <div class="mb-3">
        <label class="form-label">จำนวน</label>
        <input id="lnd-fv-qty" type="number" min="1" class="form-control" placeholder="ระบุจำนวน">
      </div>
      <div id="lnd-fv-src-info" class="small text-muted"></div>`;

    document.getElementById('laundry-modal-footer').innerHTML = `
      <button class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
      <button class="btn btn-primary" id="lnd-fv-submit">เติมรถ</button>`;

    // Show best source hint when item changes
    document.getElementById('lnd-fv-item').addEventListener('change', async (e) => {
      const info = document.getElementById('lnd-fv-src-info');
      if (!e.target.value) { info.textContent = ''; return; }
      info.textContent = 'กำลังค้นหาต้นทาง…';
      const src = await _bestCleanSource(e.target.value);
      if (src) {
        info.textContent = `ต้นทางอัตโนมัติ: ${src.location_name} (มีอยู่ ${src.qty} ชิ้น)`;
      } else {
        info.innerHTML = '<span class="text-danger">ไม่พบผ้าสะอาด (laundry_role=\'clean\') สำหรับสินค้านี้</span>';
      }
    });

    document.getElementById('lnd-fv-submit').addEventListener('click', async () => {
      const itemId    = document.getElementById('lnd-fv-item').value;
      const vehicleId = document.getElementById('lnd-fv-vehicle').value;
      const qty       = parseInt(document.getElementById('lnd-fv-qty').value, 10);

      if (!itemId || !vehicleId || !(qty > 0)) {
        _toast('warning', 'กรุณาเลือกสินค้า รถ และระบุจำนวน'); return;
      }
      const src = await _bestCleanSource(itemId);
      if (!src) { _toast('error', 'ไม่พบผ้าสะอาดสำหรับสินค้านี้'); return; }

      document.getElementById('lnd-fv-submit').disabled = true;
      document.getElementById('lnd-fv-submit').textContent = 'กำลังดำเนินการ…';

      const { error } = await _transfer(itemId, src.location_id, vehicleId, qty, 'stock vehicle');
      if (error) {
        _toast('error', _errMsg(error));
        document.getElementById('lnd-fv-submit').disabled = false;
        document.getElementById('lnd-fv-submit').textContent = 'เติมรถ';
      } else {
        _toast('success', 'เติมรถ สำเร็จ 1 รายการ');
        _closeModal();
      }
    });
  }

  // =========================================================================
  // Action: mark_dirty — ใช้/เปื้อน +N
  // =========================================================================

  async function _openMarkDirty(opts) {
    _showModal('ใช้/เปื้อน +N (mark_dirty)', '<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> กำลังโหลด…</div>', '');

    const [itemsRes, dirtyLocsRes] = await Promise.all([
      _fetchLinenItems(),
      _fetchLocsByRole('dirty'),
    ]);

    if (itemsRes.error || !itemsRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบสินค้าผ้า</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }
    if (dirtyLocsRes.error || !dirtyLocsRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบ location laundry_role='dirty'</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }

    const items     = itemsRes.data;
    const dirtyLocs = dirtyLocsRes.data;

    // Pre-select from opts if provided
    const preItemId = opts?.itemId  || '';
    const preVehId  = opts?.vehicleId || '';

    // For vehicle source: need vehicle locations
    const vehiclesRes = await _fetchLocsByRole('vehicle');
    const vehicles = vehiclesRes.data || [];

    let dirtyLocSection;
    if (dirtyLocs.length === 1) {
      dirtyLocSection = `<input type="hidden" id="lnd-md-dirty" value="${_esc(dirtyLocs[0].id)}">
        <div class="mb-3 small text-muted">ปลายทาง: ${_esc(dirtyLocs[0].name)}</div>`;
    } else {
      dirtyLocSection = `
        <div class="mb-3">
          <label class="form-label">ที่เก็บผ้าสกปรก (dirty)</label>
          ${_selectHtml('lnd-md-dirty', dirtyLocs.map((l) => ({ value: l.id, label: l.name })), '— เลือก dirty location —')}
        </div>`;
    }

    document.getElementById('laundry-modal-body').innerHTML = `
      <div class="mb-3">
        <label class="form-label">สินค้าผ้า</label>
        ${_selectHtml('lnd-md-item', items.map((i) => ({ value: i.id, label: `${i.name} (${i.sku})` })), '— เลือกสินค้า —')}
      </div>
      <div class="mb-3">
        <label class="form-label">รถ (ต้นทาง)</label>
        ${_selectHtml('lnd-md-vehicle', vehicles.map((v) => ({ value: v.id, label: v.name })), '— เลือกรถ —')}
      </div>
      ${dirtyLocSection}
      <div class="mb-3">
        <label class="form-label">+ จำนวนที่เปื้อน</label>
        <input id="lnd-md-qty" type="number" min="1" class="form-control" placeholder="ระบุจำนวน">
      </div>`;

    document.getElementById('laundry-modal-footer').innerHTML = `
      <button class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
      <button class="btn btn-warning" id="lnd-md-submit">บันทึกผ้าเปื้อน</button>`;

    // Pre-fill from opts
    if (preItemId) document.getElementById('lnd-md-item').value = preItemId;
    if (preVehId)  { const el = document.getElementById('lnd-md-vehicle'); if (el) el.value = preVehId; }

    document.getElementById('lnd-md-submit').addEventListener('click', async () => {
      const itemId   = document.getElementById('lnd-md-item').value;
      const vehicleId = document.getElementById('lnd-md-vehicle').value;
      const dirtyId  = document.getElementById('lnd-md-dirty').value;
      const qty      = parseInt(document.getElementById('lnd-md-qty').value, 10);

      if (!itemId || !vehicleId || !dirtyId || !(qty > 0)) {
        _toast('warning', 'กรุณาเลือกสินค้า รถ ที่เก็บผ้าสกปรก และระบุจำนวน'); return;
      }

      document.getElementById('lnd-md-submit').disabled = true;
      document.getElementById('lnd-md-submit').textContent = 'กำลังดำเนินการ…';

      const { error } = await _transfer(itemId, vehicleId, dirtyId, qty, 'used/soiled');
      if (error) {
        _toast('error', _errMsg(error));
        document.getElementById('lnd-md-submit').disabled = false;
        document.getElementById('lnd-md-submit').textContent = 'บันทึกผ้าเปื้อน';
      } else {
        _toast('success', 'ใช้/เปื้อน สำเร็จ 1 รายการ');
        _closeModal();
      }
    });
  }

  // =========================================================================
  // Action: send_wash — ส่งซัก (batch)
  // =========================================================================

  async function _openSendWash() {
    _showModal('ส่งซัก (send_wash)', '<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> กำลังโหลด…</div>', '');

    // Need: dirty locs, external locs, items in dirty locs
    const [dirtyLocsRes, extLocsRes] = await Promise.all([
      _fetchLocsByRole('dirty'),
      _fetchLocsByRole('external'),
    ]);

    if (dirtyLocsRes.error || !dirtyLocsRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบ location laundry_role='dirty'</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }
    if (extLocsRes.error || !extLocsRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบ location laundry_role='external' (ร้านซัก)</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }

    const dirtyLocs = dirtyLocsRes.data;
    const extLocs   = extLocsRes.data;

    // Fetch all dirty-location stock for linen items
    const linenCatId = await _getLinenCategoryId();
    const dirtyStockRes = await _safe(() =>
      _sb().from('stock_item_locations')
        .select('item_id, location_id, qty, stock_items(id,name,sku,category_id)')
        .in('location_id', dirtyLocs.map((l) => l.id))
        .gt('qty', 0)
    );

    const dirtyStock = (dirtyStockRes.data || []).filter((r) => r.stock_items?.category_id === linenCatId);
    if (!dirtyStock.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-info">ไม่มีผ้าสกปรกในระบบขณะนี้</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }

    const dirtyLocMap = Object.fromEntries(dirtyLocs.map((l) => [l.id, l.name]));

    const rowsHtml = dirtyStock.map((r, ix) => `
      <tr>
        <td>${_esc(r.stock_items.name)}<br><small class="text-muted">${_esc(dirtyLocMap[r.location_id] || r.location_id)}</small></td>
        <td class="text-center">${_esc(String(r.qty))}</td>
        <td>
          <input type="number" min="0" max="${_esc(String(r.qty))}" value="${_esc(String(r.qty))}"
                 class="form-control form-control-sm lnd-sw-qty"
                 data-item="${_esc(r.item_id)}" data-srcloc="${_esc(r.location_id)}" data-max="${_esc(String(r.qty))}"
                 style="width:80px">
        </td>
      </tr>`).join('');

    let extLocSection;
    if (extLocs.length === 1) {
      extLocSection = `<input type="hidden" id="lnd-sw-ext" value="${_esc(extLocs[0].id)}">
        <div class="small text-muted mb-2">ส่งไปที่: ${_esc(extLocs[0].name)}</div>`;
    } else {
      extLocSection = `
        <div class="mb-3">
          <label class="form-label">ร้านซัก (external location)</label>
          ${_selectHtml('lnd-sw-ext', extLocs.map((l) => ({ value: l.id, label: l.name })), '— เลือกร้านซัก —')}
        </div>`;
    }

    document.getElementById('laundry-modal-body').innerHTML = `
      ${extLocSection}
      <div class="row g-2 mb-3">
        <div class="col-6"><label class="form-label small">วันที่ส่ง</label>
          <input id="lnd-sw-date" type="date" class="form-control form-control-sm"
                 value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="col-6"><label class="form-label small">ชื่อร้าน/Vendor</label>
          <input id="lnd-sw-vendor" type="text" class="form-control form-control-sm" placeholder="ชื่อร้านซัก"></div>
      </div>
      <div id="lnd-sw-progress"></div>
      <div class="table-responsive">
        <table class="table table-sm align-middle">
          <thead><tr><th>สินค้า</th><th>มีอยู่</th><th>ส่งซัก</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

    document.getElementById('laundry-modal-footer').innerHTML = `
      <button class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
      <button class="btn btn-primary" id="lnd-sw-submit">ส่งซัก</button>`;

    document.getElementById('lnd-sw-submit').addEventListener('click', async () => {
      const extLocId = document.getElementById('lnd-sw-ext').value;
      const date     = document.getElementById('lnd-sw-date').value;
      const vendor   = document.getElementById('lnd-sw-vendor').value.trim();
      if (!extLocId) { _toast('warning', 'กรุณาเลือกร้านซัก'); return; }

      const note = `send to wash: vendor=${vendor || '—'} date=${date || '—'}`;

      const rows = Array.from(document.querySelectorAll('.lnd-sw-qty'))
        .map((el) => ({
          itemId:  el.dataset.item,
          srcLoc:  el.dataset.srcloc,
          qty:     parseInt(el.value, 10),
        }))
        .filter((r) => r.qty > 0);

      if (!rows.length) { _toast('warning', 'ระบุจำนวนอย่างน้อย 1 รายการ'); return; }

      const btn = document.getElementById('lnd-sw-submit');
      btn.disabled = true;
      const progressEl = document.getElementById('lnd-sw-progress');

      let done = 0, failCount = 0;
      const total = rows.length;

      for (const row of rows) {
        if (total > 3) progressEl.innerHTML = _renderProgress(done, total);
        const { error } = await _transfer(row.itemId, row.srcLoc, extLocId, row.qty, note);
        if (error) { failCount++; console.error('send_wash transfer error', error); }
        done++;
      }

      if (total > 3) progressEl.innerHTML = _renderProgress(done, total);

      if (failCount === 0) {
        _toast('success', `ส่งซัก สำเร็จ ${done} รายการ`);
        _closeModal();
      } else {
        _toast('warning', `ส่งซัก: สำเร็จ ${done - failCount}/${done} รายการ (ล้มเหลว ${failCount})`);
        btn.disabled = false;
      }
    });
  }

  // =========================================================================
  // Action: receive_back — รับคืน + loss tracking
  // =========================================================================

  async function _openReceiveBack() {
    _showModal('รับคืนจากร้านซัก (receive_back)', '<div class="text-center py-3"><span class="spinner-border spinner-border-sm"></span> กำลังโหลด…</div>', '');

    const [extLocsRes, cleanLocsRes] = await Promise.all([
      _fetchLocsByRole('external'),
      _fetchLocsByRole('clean'),
    ]);

    if (extLocsRes.error || !extLocsRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบ location laundry_role='external'</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }
    if (cleanLocsRes.error || !cleanLocsRes.data?.length) {
      document.getElementById('laundry-modal-body').innerHTML =
        `<div class="alert alert-warning">ไม่พบ location laundry_role='clean'</div>`;
      document.getElementById('laundry-modal-footer').innerHTML =
        `<button class="btn btn-secondary" data-bs-dismiss="modal">ปิด</button>`;
      return;
    }

    const extLocs   = extLocsRes.data;
    const cleanLocs = cleanLocsRes.data;

    // Show external loc selector first, then load its stock
    let extLocSection;
    if (extLocs.length === 1) {
      extLocSection = `<input type="hidden" id="lnd-rb-ext" value="${_esc(extLocs[0].id)}">
        <div class="small text-muted mb-2">ร้านซัก: ${_esc(extLocs[0].name)}</div>`;
    } else {
      extLocSection = `
        <div class="mb-3">
          <label class="form-label">ร้านซัก (external location)</label>
          ${_selectHtml('lnd-rb-ext', extLocs.map((l) => ({ value: l.id, label: l.name })), '— เลือกร้านซัก —')}
        </div>`;
    }

    // clean location is chosen per-row (each linen type goes to its own box)

    document.getElementById('laundry-modal-body').innerHTML = `
      ${extLocSection}
      <div class="small text-muted mb-2">เลือกกล่องที่เก็บผ้าสะอาดได้ทีละรายการ (default = กล่องที่ผ้านั้นเก็บอยู่ตอนนี้)</div>
      <div id="lnd-rb-load-btn-wrap" class="mb-3">
        <button class="btn btn-outline-secondary btn-sm" id="lnd-rb-load">โหลดรายการที่ส่งซัก</button>
      </div>
      <div id="lnd-rb-progress"></div>
      <div id="lnd-rb-rows"></div>`;

    document.getElementById('laundry-modal-footer').innerHTML = `
      <button class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
      <button class="btn btn-success d-none" id="lnd-rb-submit">รับคืน</button>`;

    document.getElementById('lnd-rb-load').addEventListener('click', async () => {
      const extLocId = document.getElementById('lnd-rb-ext').value;
      if (!extLocId) { _toast('warning', 'กรุณาเลือกร้านซัก'); return; }

      document.getElementById('lnd-rb-load').disabled = true;
      document.getElementById('lnd-rb-load').textContent = 'กำลังโหลด…';

      const { data, error } = await _fetchExternalStock(extLocId);
      if (error || !data?.length) {
        document.getElementById('lnd-rb-rows').innerHTML =
          `<div class="alert alert-info">ไม่มีผ้าค้างที่ร้านซักขณะนี้</div>`;
        document.getElementById('lnd-rb-load').disabled = false;
        document.getElementById('lnd-rb-load').textContent = 'โหลดรายการที่ส่งซัก';
        return;
      }

      // Per-item default clean box = where this linen currently sits the most
      const homeBoxes = await Promise.all(data.map((r) => _bestCleanSource(r.item_id)));

      const cleanOptsHtml = (selId) =>
        `<option value="">— เลือกกล่อง —</option>` +
        cleanLocs.map((l) =>
          `<option value="${_esc(l.id)}" ${l.id === selId ? 'selected' : ''}>${_esc(l.name)}</option>`
        ).join('');

      const rowsHtml = data.map((r, i) => {
        const defId = homeBoxes[i]?.location_id || '';
        return `
        <tr>
          <td>${_esc(r.stock_items?.name || r.item_id)}</td>
          <td class="text-center">${_esc(String(r.qty))}</td>
          <td>
            <input type="number" min="0" max="${_esc(String(r.qty))}" value="${_esc(String(r.qty))}"
                   class="form-control form-control-sm lnd-rb-qty"
                   data-item="${_esc(r.item_id)}" data-sent="${_esc(String(r.qty))}"
                   style="width:80px">
          </td>
          <td>
            <select class="form-select form-select-sm lnd-rb-clean-row"
                    data-item="${_esc(r.item_id)}" style="min-width:140px">
              ${cleanOptsHtml(defId)}
            </select>
          </td>
          <td class="text-center text-danger lnd-rb-loss" data-item="${_esc(r.item_id)}">0</td>
        </tr>`;
      }).join('');

      document.getElementById('lnd-rb-rows').innerHTML = `
        <div class="table-responsive">
          <table class="table table-sm align-middle">
            <thead><tr><th>สินค้า</th><th>ที่ส่งไป</th><th>รับคืน</th><th>เก็บเข้ากล่อง</th><th>หาย</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`;

      document.getElementById('lnd-rb-load-btn-wrap').classList.add('d-none');
      document.getElementById('lnd-rb-submit').classList.remove('d-none');

      // Live-update loss column
      document.getElementById('lnd-rb-rows').addEventListener('input', (e) => {
        if (!e.target.classList.contains('lnd-rb-qty')) return;
        const sent  = parseInt(e.target.dataset.sent, 10);
        const recv  = parseInt(e.target.value, 10) || 0;
        const loss  = Math.max(0, sent - recv);
        const lossEl = document.querySelector(`.lnd-rb-loss[data-item="${e.target.dataset.item}"]`);
        if (lossEl) lossEl.textContent = loss;
      });
    });

    document.getElementById('lnd-rb-submit').addEventListener('click', async () => {
      const extLocId = document.getElementById('lnd-rb-ext').value;
      if (!extLocId) { _toast('warning', 'กรุณาเลือกร้านซัก'); return; }

      const rows = Array.from(document.querySelectorAll('.lnd-rb-qty')).map((el) => {
        const cleanSel = document.querySelector(`.lnd-rb-clean-row[data-item="${el.dataset.item}"]`);
        return {
          itemId:     el.dataset.item,
          sent:       parseInt(el.dataset.sent, 10),
          recv:       parseInt(el.value, 10) || 0,
          cleanLocId: cleanSel ? cleanSel.value : '',
        };
      });

      if (!rows.length) return;

      // Every row we actually receive back must have its own clean box chosen
      const missing = rows.filter((r) => r.recv > 0 && !r.cleanLocId);
      if (missing.length) { _toast('warning', 'กรุณาเลือกกล่องให้ครบทุกรายการที่รับคืน'); return; }

      const btn = document.getElementById('lnd-rb-submit');
      btn.disabled = true;
      const progressEl = document.getElementById('lnd-rb-progress');
      const total = rows.reduce((n, r) => n + (r.recv > 0 ? 1 : 0) + (r.sent - r.recv > 0 ? 1 : 0), 0);
      let done = 0, failCount = 0;

      for (const row of rows) {
        const loss = row.sent - row.recv;

        if (loss > 0) {
          if (total > 3) progressEl.innerHTML = _renderProgress(done, total);
          const note = `returned ${row.recv} of ${row.sent} sent`;
          const { error } = await _insertLoss(row.itemId, extLocId, loss, note);
          if (error) { failCount++; console.error('receive_back loss error', error); }
          done++;
        }

        if (row.recv > 0) {
          if (total > 3) progressEl.innerHTML = _renderProgress(done, total);
          const { error } = await _transfer(
            row.itemId, extLocId, row.cleanLocId, row.recv, 'returned from wash'
          );
          if (error) { failCount++; console.error('receive_back transfer error', error); }
          done++;
        }
      }

      if (total > 3) progressEl.innerHTML = _renderProgress(done, total);

      if (failCount === 0) {
        _toast('success', `รับคืน สำเร็จ ${rows.filter((r) => r.recv > 0).length} รายการ`);
        _closeModal();
      } else {
        _toast('warning', `รับคืน: ล้มเหลว ${failCount} รายการ`);
        btn.disabled = false;
      }
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Open a laundry quick-action modal.
   * @param {'fill_vehicle'|'mark_dirty'|'send_wash'|'receive_back'} action
   * @param {{ itemId?: string, vehicleId?: string }} [opts]  context hints (mark_dirty)
   */
  function openModal(action, opts) {
    switch (action) {
      case 'fill_vehicle':  _openFillVehicle();    break;
      case 'mark_dirty':    _openMarkDirty(opts);  break;
      case 'send_wash':     _openSendWash();        break;
      case 'receive_back':  _openReceiveBack();     break;
      // fold_back deferred — usually combined with receive_back step
      default:
        console.warn('[Laundry] unknown action:', action);
    }
  }

  window.Laundry = { openModal };

})();
