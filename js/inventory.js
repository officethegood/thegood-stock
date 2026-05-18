// js/inventory.js
// Phase 1 — Admin Inventory tab controller (Phase D).
//
// Spec refs:
//   docs/superpowers/specs/2026-05-18-phase1-inventory-design.md  §7.1 (Admin Inventory tab)
//   docs/superpowers/designs/2026-05-18-phase1-ui-design.md       §2 Area 1 (wireframes, microcopy)
//   docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md    Phase D
//
// Locked decisions (PM Pex 2026-05-18 — DO NOT re-debate):
//   Q1: NO Transfer modal in Phase 1 — only receive / issue / adjustment_loss / adjustment_gain
//   Q2: NO Chart.js — plain HTML/text for any breakdown
//   Q3: NO photo upload / camera-photo capture
//
// Upstream APIs consumed (all via window.AppInventory — never direct Supabase):
//   AppInventory.listCategories, listItems, getItem, searchByBarcode, findLocationByCode,
//                getLowStock, createItem, updateItem, deactivateItem,
//                receive, adjustmentLoss, adjustmentGain, subscribeInventory
//   AppScanner.isSupported, startScanning, stopScanning, parseScanResult
//   AppUi: showToast, showConfirm, escapeHtml (globals)
//
// Public namespace: window.AppInventoryTab + the lazy-init shim window.initInventoryTab
// (registered by admin-shell.js via the inits map).

(function () {
  'use strict';

  // =========================================================================
  // Module state (singleton — tab is mounted once, lazy)
  // =========================================================================
  let _items        = [];        // last fetched item rows (with total_qty)
  let _categories   = [];        // categories cache for dropdowns
  let _locations    = [];        // locations cache for receive/adjust modals
  let _unsubscribe  = null;      // realtime teardown
  let _refreshTimer = null;      // debounce for realtime → reload
  let _filters      = { search: '', category: '', lowStockOnly: false };
  let _mounted      = false;

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Mirror of escapeHtml from shared/ui.js — defensive in case load order shifts. */
  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _toast(type, msg)  { (window.showToast || (()=>{}))(type, msg); }
  function _confirm(msg)      { return (window.showConfirm || (()=> Promise.resolve(window.confirm(msg))))(msg); }
  function _isAdmin()         { try { return window.getUserRole?.() === 'Admin'; } catch { return false; } }

  /** Friendly Thai error mapper — falls back to error.friendly when present (AppInventory attaches). */
  function _friendly(err, fallback) {
    if (!err) return fallback || 'เกิดข้อผิดพลาด';
    if (err.friendly)  return err.friendly;
    if (err.code === '23505') return 'รหัสซ้ำ';
    if (err.code === '42501') return 'ไม่มีสิทธิ์ทำรายการนี้';
    if (err.code === 'BAD_QTY') return 'จำนวนต้องเป็นเลขจำนวนเต็มบวก';
    return err.message || fallback || 'เกิดข้อผิดพลาด';
  }

  /** Load helper categories (cached for the tab's lifetime). */
  async function _ensureCategories() {
    if (_categories.length) return _categories;
    const r = await window.AppInventory.listCategories();
    if (r.error) { _toast('error', 'โหลดหมวดไม่สำเร็จ'); return []; }
    _categories = r.data || [];
    return _categories;
  }

  /** Active locations for receive/adjust dropdowns. (Phase 0 RLS: any authenticated user can read.) */
  async function _ensureLocations() {
    if (_locations.length) return _locations;
    const sb = getSupabaseClient();
    const r = await sb.from('locations')
      .select('id,code,name,type,parent_id,active')
      .eq('active', true)
      .order('type').order('code');
    if (r.error) { _toast('error', 'โหลดสถานที่ไม่สำเร็จ'); return []; }
    _locations = r.data || [];
    return _locations;
  }

  function _catName(id) {
    const c = _categories.find((x) => x.id === id);
    return c ? c.name : '—';
  }

  function _locLabel(loc) {
    return `${loc.code} — ${loc.name}`;
  }

  // =========================================================================
  // Main render — Items list (spec §7.1.1; design §2.3)
  // =========================================================================

  function _renderShell() {
    // Spec §7.1 — tab pane container is pre-allocated in admin.html as #tab-inventory.
    const root = document.getElementById('tab-inventory');
    if (!root) return;
    root.innerHTML = `
      <div class="d-flex flex-wrap align-items-center mb-3 gap-2">
        <h5 class="mb-0 me-auto"><i class="bi bi-box-seam"></i> คลังสินค้า</h5>
        <button class="btn btn-stock-primary" id="inv-btn-add" style="min-height:44px;">
          <i class="bi bi-plus-lg"></i> เพิ่มสินค้า
        </button>
        <button class="btn btn-outline-stock-accent" id="inv-btn-receive" style="min-height:44px;">
          <i class="bi bi-box-arrow-in-down"></i> รับเข้า
        </button>
      </div>

      <div class="card mb-3">
        <div class="card-body py-3">
          <div class="row g-2 align-items-center">
            <div class="col-12 col-md-5">
              <input id="inv-search" type="search" class="form-control"
                     placeholder="ค้นชื่อ / SKU / Barcode" autocomplete="off"
                     style="min-height:44px;">
            </div>
            <div class="col-7 col-md-4">
              <select id="inv-category" class="form-select" style="min-height:44px;">
                <option value="">หมวด: ทั้งหมด</option>
              </select>
            </div>
            <div class="col-5 col-md-3">
              <div class="form-check mt-1">
                <input type="checkbox" class="form-check-input" id="inv-low-only">
                <label class="form-check-label small" for="inv-low-only">เฉพาะของใกล้หมด</label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-striped table-hover align-middle mb-0">
              <thead class="position-sticky top-0 bg-white" style="z-index:1;">
                <tr>
                  <th scope="col" class="d-none d-sm-table-cell">SKU</th>
                  <th scope="col">ชื่อ</th>
                  <th scope="col" class="d-none d-md-table-cell">หมวด</th>
                  <th scope="col" class="d-none d-md-table-cell">หน่วย</th>
                  <th scope="col" class="text-end">คงเหลือรวม</th>
                  <th scope="col" class="d-none d-sm-table-cell text-end">เกณฑ์</th>
                  <th scope="col" class="d-none d-sm-table-cell">สถานะ</th>
                  <th scope="col" class="text-end" style="width:44px;"></th>
                </tr>
              </thead>
              <tbody id="inv-tbody">
                <tr><td colspan="8" class="text-center text-muted py-4">
                  <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
                </td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    document.getElementById('inv-btn-add').onclick     = () => openItemModal(null);
    document.getElementById('inv-btn-receive').onclick = () => openReceiveModal(null);

    const searchEl = document.getElementById('inv-search');
    let searchTimer = null;
    searchEl.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        _filters.search = searchEl.value.trim();
        reload();
      }, 250);
    });

    document.getElementById('inv-category').addEventListener('change', (e) => {
      _filters.category = e.target.value;
      reload();
    });
    document.getElementById('inv-low-only').addEventListener('change', (e) => {
      _filters.lowStockOnly = !!e.target.checked;
      reload();
    });
  }

  function _renderCategoryDropdown() {
    const sel = document.getElementById('inv-category');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">หมวด: ทั้งหมด</option>' +
      _categories.map((c) => `<option value="${_esc(c.id)}">${_esc(c.name)}</option>`).join('');
    if (current) sel.value = current;
  }

  // -------------------------------------------------------------------------
  // Table render (design §2.A.1 / §2.A.2)
  // -------------------------------------------------------------------------
  function _renderRows() {
    const tbody = document.getElementById('inv-tbody');
    if (!tbody) return;

    if (!_items.length) {
      // Spec §7.1.1 empty state — distinguish "0 active items in system" vs "filtered to zero".
      const noFilter = !_filters.search && !_filters.category && !_filters.lowStockOnly;
      const msg = noFilter
        ? 'ยังไม่มีสินค้าในระบบ — กด ➕ เพิ่มสินค้า เพื่อเริ่ม'
        : '— ไม่มีรายการตรงเงื่อนไข —';
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">${_esc(msg)}</td></tr>`;
      return;
    }

    tbody.innerHTML = _items.map((it) => {
      const total = it.total_qty || 0;
      const threshold = it.reorder_threshold || 0;
      const low = threshold > 0 && total <= threshold;
      const totalCell = low
        ? `<span class="text-danger fw-bold" aria-label="ใกล้หมด">${total} <i class="bi bi-exclamation-triangle"></i></span>`
        : String(total);
      const statusBadge = it.active
        ? '<span class="badge bg-success-subtle text-success">ใช้งาน</span>'
        : '<span class="badge bg-secondary">ปิด</span>';
      return `
        <tr data-id="${_esc(it.id)}" role="button" tabindex="0" style="cursor:pointer;">
          <td class="d-none d-sm-table-cell"><code class="small">${_esc(it.sku)}</code></td>
          <td>
            <div>${_esc(it.name)}</div>
            <div class="d-sm-none small text-muted">${_esc(it.sku)}</div>
          </td>
          <td class="d-none d-md-table-cell small">${_esc(_catName(it.category_id))}</td>
          <td class="d-none d-md-table-cell small">${_esc(it.unit || 'ชิ้น')}</td>
          <td class="text-end">${totalCell}</td>
          <td class="d-none d-sm-table-cell text-end small">${threshold || '—'}</td>
          <td class="d-none d-sm-table-cell">${statusBadge}</td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-link p-1" data-act="menu"
                    aria-label="เมนู" style="min-width:44px;min-height:44px;">
              <i class="bi bi-three-dots-vertical"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    // Row click → detail drawer (design §2.4). The 3-dots column dispatches row-action menu.
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.addEventListener('click', (ev) => {
        const actBtn = ev.target.closest('[data-act="menu"]');
        if (actBtn) {
          ev.stopPropagation();
          openRowActionMenu(id, actBtn);
          return;
        }
        openItemDetailDrawer(id);
      });
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openItemDetailDrawer(id);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Data loaders
  // -------------------------------------------------------------------------
  async function reload() {
    const tbody = document.getElementById('inv-tbody');
    if (tbody && !_items.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
      </td></tr>`;
    }
    const r = await window.AppInventory.listItems({
      search:       _filters.search,
      category:     _filters.category || undefined,
      lowStockOnly: _filters.lowStockOnly,
      activeOnly:   false, // show inactive too so admin can re-activate
    });
    if (r.error) {
      _items = [];
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">
        ${_esc(_friendly(r.error, 'โหลดสินค้าไม่สำเร็จ'))}
      </td></tr>`;
      _toast('error', _friendly(r.error, 'โหลดสินค้าไม่สำเร็จ'));
      return;
    }
    _items = r.data || [];
    _renderRows();
  }

  // -------------------------------------------------------------------------
  // Realtime — debounce reloads (spec §5.7, design 300ms)
  // -------------------------------------------------------------------------
  function _scheduleRealtimeReload() {
    if (_refreshTimer) return;
    _refreshTimer = setTimeout(() => {
      _refreshTimer = null;
      reload();
    }, 300);
  }

  // =========================================================================
  // Item detail drawer (design §2.4 — implemented as centered modal)
  // =========================================================================
  async function openItemDetailDrawer(itemId) {
    const modalEl = _createModalShell('inv-drawer', 'modal-lg', `
      <div class="modal-body">
        <div class="text-center text-muted py-4">
          <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
        </div>
      </div>
    `);
    const modal = new bootstrap.Modal(modalEl);
    modal.show();

    const r = await window.AppInventory.getItem(itemId);
    if (r.error || !r.data) {
      modalEl.querySelector('.modal-body').innerHTML =
        `<p class="text-danger">${_esc(_friendly(r.error, 'โหลดข้อมูลไม่สำเร็จ'))}</p>`;
      return;
    }
    const { item, locations, total_qty } = r.data;
    const low = (item.reorder_threshold || 0) > 0 && total_qty <= item.reorder_threshold;

    const locRows = locations.length
      ? locations.map((l) => {
          const loc = l.locations || {};
          return `
            <li class="d-flex justify-content-between align-items-center py-1 border-bottom">
              <div>
                <code class="small">${_esc(loc.code || '')}</code>
                <span class="ms-1">${_esc(loc.name || '')}</span>
              </div>
              <div class="fw-bold">${l.qty}</div>
            </li>`;
        }).join('')
      : `<li class="text-muted py-2">ไม่มีในคลัง — กด "รับเข้า" เพื่อเริ่ม</li>`;

    modalEl.querySelector('.modal-content').innerHTML = `
      <div class="modal-header">
        <div>
          <h5 class="modal-title mb-0" id="drawer-title">${_esc(item.name)}</h5>
          <small class="text-muted"><code>${_esc(item.sku)}</code>${item.barcode ? ' · ' + _esc(item.barcode) : ''}</small>
        </div>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
      </div>
      <div class="modal-body">
        <div class="row g-2 small mb-3">
          <div class="col-6"><span class="text-muted">หมวด:</span> ${_esc(_catName(item.category_id))}</div>
          <div class="col-6"><span class="text-muted">หน่วย:</span> ${_esc(item.unit || 'ชิ้น')}</div>
          <div class="col-6"><span class="text-muted">เกณฑ์เตือน:</span> ${item.reorder_threshold || 0}</div>
          <div class="col-6"><span class="text-muted">สถานะ:</span> ${item.active
            ? '<span class="badge bg-success-subtle text-success">ใช้งาน</span>'
            : '<span class="badge bg-secondary">ปิด</span>'}</div>
        </div>
        <h6 class="mt-3">คงเหลือต่อสถานที่</h6>
        <ul class="list-unstyled mb-2">${locRows}</ul>
        <div class="d-flex justify-content-end fw-bold border-top pt-2"
             aria-label="คงเหลือรวมทุกสถานที่">
          รวม: ${low
            ? `<span class="text-danger ms-2">${total_qty} <i class="bi bi-exclamation-triangle"></i></span>`
            : `<span class="ms-2">${total_qty}</span>`}
        </div>
      </div>
      <div class="modal-footer flex-wrap gap-1">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">ปิด</button>
        <button type="button" class="btn btn-outline-stock-accent" id="drawer-receive">
          <i class="bi bi-box-arrow-in-down"></i> รับเข้า
        </button>
        <button type="button" class="btn btn-outline-warning" id="drawer-loss">
          <i class="bi bi-exclamation-triangle"></i> ของหาย/ชำรุด
        </button>
        ${_isAdmin() ? `
          <button type="button" class="btn btn-outline-info" id="drawer-gain">
            <i class="bi bi-plus-circle"></i> ปรับยอด+
          </button>
        ` : ''}
        <button type="button" class="btn btn-outline-secondary" id="drawer-edit">
          <i class="bi bi-pencil"></i> แก้ไข
        </button>
        ${item.active
          ? `<button type="button" class="btn btn-outline-danger" id="drawer-deactivate">ปิดใช้งาน</button>`
          : `<button type="button" class="btn btn-outline-success" id="drawer-reactivate">เปิดใช้งาน</button>`
        }
      </div>
    `;

    const close = () => modal.hide();
    document.getElementById('drawer-edit').onclick = () => { close(); openItemModal(item); };
    document.getElementById('drawer-receive').onclick = () => { close(); openReceiveModal(item); };
    document.getElementById('drawer-loss').onclick = () => { close(); openAdjustModal('loss', item); };
    if (_isAdmin()) {
      document.getElementById('drawer-gain').onclick = () => { close(); openAdjustModal('gain', item); };
    }
    const deact = document.getElementById('drawer-deactivate');
    if (deact) deact.onclick = async () => {
      const ok = await _confirm(`ปิดใช้งานสินค้า "${item.name}" ?`);
      if (!ok) return;
      const dr = await window.AppInventory.deactivateItem(item.id);
      if (dr.error) { _toast('error', _friendly(dr.error, 'อัปเดตไม่สำเร็จ')); return; }
      _toast('success', 'ปิดใช้งานแล้ว');
      close();
      reload();
    };
    const react = document.getElementById('drawer-reactivate');
    if (react) react.onclick = async () => {
      const rr = await window.AppInventory.updateItem(item.id, { active: true });
      if (rr.error) { _toast('error', _friendly(rr.error, 'อัปเดตไม่สำเร็จ')); return; }
      _toast('success', 'เปิดใช้งานแล้ว');
      close();
      reload();
    };
  }

  // =========================================================================
  // Row action menu (small popover via Bootstrap dropdown imperatively built)
  // =========================================================================
  function openRowActionMenu(itemId, anchorBtn) {
    const item = _items.find((x) => x.id === itemId);
    if (!item) return;
    // Simplified: just open the detail drawer where action buttons live.
    openItemDetailDrawer(itemId);
  }

  // =========================================================================
  // Add / Edit Item modal (design §2.5)
  // =========================================================================
  function openItemModal(existing) {
    const isEdit = !!existing;
    const modalEl = _createModalShell('inv-item-modal', '', `
      <form id="inv-item-form">
        <div class="modal-header">
          <h5 class="modal-title">${isEdit ? 'แก้ไขสินค้า' : 'เพิ่มสินค้าใหม่'}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
        </div>
        <div class="modal-body">
          <div class="mb-2">
            <label class="form-label" for="if-name">ชื่อ *</label>
            <input id="if-name" class="form-control" required aria-required="true" autofocus>
          </div>
          <div class="row g-2">
            <div class="col-12 col-sm-6 mb-2">
              <label class="form-label" for="if-sku">SKU *</label>
              <input id="if-sku" class="form-control" required aria-required="true"
                     inputmode="latin" autocomplete="off"
                     ${isEdit ? 'disabled' : ''}>
            </div>
            <div class="col-12 col-sm-6 mb-2">
              <label class="form-label" for="if-barcode">Barcode</label>
              <input id="if-barcode" class="form-control" autocomplete="off">
            </div>
          </div>
          <div class="row g-2">
            <div class="col-12 col-sm-5 mb-2">
              <label class="form-label" for="if-category">หมวด</label>
              <select id="if-category" class="form-select">
                <option value="">— เลือก —</option>
                ${_categories.map((c) => `<option value="${_esc(c.id)}">${_esc(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="col-6 col-sm-3 mb-2">
              <label class="form-label" for="if-unit">หน่วย</label>
              <input id="if-unit" class="form-control" value="ชิ้น">
            </div>
            <div class="col-6 col-sm-4 mb-2">
              <label class="form-label" for="if-threshold">เกณฑ์เตือน</label>
              <input id="if-threshold" type="number" min="0" step="1" class="form-control" value="0"
                     inputmode="numeric">
              <small class="text-muted">แจ้งเตือน Telegram เมื่อคงเหลือรวม ≤ ค่านี้ (0 = ไม่แจ้ง)</small>
            </div>
          </div>
          <div class="form-check mt-2">
            <input type="checkbox" class="form-check-input" id="if-active" checked>
            <label class="form-check-label" for="if-active">ใช้งานอยู่</label>
          </div>
          <div id="if-error" class="alert alert-danger mt-3 d-none" role="alert" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
          <button type="submit" class="btn btn-stock-primary" id="if-submit"
                  style="min-height:44px;">บันทึก</button>
        </div>
      </form>
    `);
    const modal = new bootstrap.Modal(modalEl);

    if (isEdit) {
      modalEl.querySelector('#if-name').value      = existing.name || '';
      modalEl.querySelector('#if-sku').value       = existing.sku || '';
      modalEl.querySelector('#if-barcode').value   = existing.barcode || '';
      modalEl.querySelector('#if-category').value  = existing.category_id || '';
      modalEl.querySelector('#if-unit').value      = existing.unit || 'ชิ้น';
      modalEl.querySelector('#if-threshold').value = existing.reorder_threshold || 0;
      modalEl.querySelector('#if-active').checked  = !!existing.active;
    }

    const errEl    = modalEl.querySelector('#if-error');
    const submitEl = modalEl.querySelector('#if-submit');

    modalEl.querySelector('#inv-item-form').onsubmit = async (ev) => {
      ev.preventDefault();
      errEl.classList.add('d-none'); errEl.textContent = '';

      const name = modalEl.querySelector('#if-name').value.trim();
      const sku  = modalEl.querySelector('#if-sku').value.trim();
      if (!name) { errEl.textContent = 'กรอกชื่อสินค้า'; errEl.classList.remove('d-none'); return; }
      if (!sku)  { errEl.textContent = 'กรอก SKU';      errEl.classList.remove('d-none'); return; }

      const payload = {
        name,
        sku,
        barcode:           modalEl.querySelector('#if-barcode').value.trim() || null,
        category_id:       modalEl.querySelector('#if-category').value || null,
        unit:              modalEl.querySelector('#if-unit').value.trim() || 'ชิ้น',
        reorder_threshold: Math.max(0, parseInt(modalEl.querySelector('#if-threshold').value, 10) || 0),
        active:            modalEl.querySelector('#if-active').checked,
      };

      submitEl.disabled = true;
      submitEl.setAttribute('aria-busy', 'true');
      submitEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';

      let res;
      if (isEdit) {
        res = await window.AppInventory.updateItem(existing.id, payload);
      } else {
        res = await window.AppInventory.createItem(payload);
      }

      submitEl.disabled = false;
      submitEl.removeAttribute('aria-busy');
      submitEl.textContent = 'บันทึก';

      if (res.error) {
        const msg = res.error.code === '23505'
          ? 'SKU หรือ Barcode ซ้ำ — เลือกใหม่'
          : _friendly(res.error, 'บันทึกไม่สำเร็จ');
        errEl.textContent = msg;
        errEl.classList.remove('d-none');
        return;
      }
      modal.hide();
      _toast('success', isEdit ? 'อัปเดตแล้ว' : 'เพิ่มสินค้าแล้ว');
      reload();
    };

    modal.show();
  }

  // =========================================================================
  // Receive modal (design §2.6 / §2.E — without full overlay; uses scan helpers)
  // =========================================================================
  async function openReceiveModal(prefillItem) {
    if (!_isAdmin()) { _toast('error', 'เฉพาะ Admin เท่านั้น'); return; }
    await Promise.all([_ensureCategories(), _ensureLocations()]);

    const modalEl = _createModalShell('inv-receive-modal', 'modal-lg', `
      <form id="inv-receive-form">
        <div class="modal-header">
          <h5 class="modal-title"><i class="bi bi-box-arrow-in-down"></i> รับเข้า</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
        </div>
        <div class="modal-body">
          <div class="mb-2">
            <label class="form-label" for="rf-item">สินค้า *</label>
            <div class="input-group">
              <input id="rf-item-search" class="form-control" placeholder="พิมพ์ชื่อ / SKU / Barcode" autocomplete="off">
              <button type="button" class="btn btn-outline-stock-accent" id="rf-scan-item" title="สแกนบาร์โค้ด">
                <i class="bi bi-upc-scan"></i> สแกน
              </button>
            </div>
            <select id="rf-item" class="form-select mt-2" required aria-required="true">
              <option value="">— เลือก —</option>
            </select>
          </div>

          <div class="mb-2">
            <label class="form-label" for="rf-location">สถานที่ *</label>
            <div class="input-group">
              <select id="rf-location" class="form-select" required aria-required="true">
                <option value="">— เลือก —</option>
                ${_locations.map((l) => `<option value="${_esc(l.id)}">${_esc(_locLabel(l))}</option>`).join('')}
              </select>
              <button type="button" class="btn btn-outline-stock-accent" id="rf-scan-loc" title="สแกน QR ของสถานที่">
                <i class="bi bi-qr-code-scan"></i> สแกน
              </button>
            </div>
          </div>

          <div class="row g-2">
            <div class="col-12 col-sm-4 mb-2">
              <label class="form-label" for="rf-qty">จำนวน *</label>
              <input id="rf-qty" type="number" min="1" step="1" class="form-control"
                     inputmode="numeric" pattern="[0-9]*" required>
            </div>
            <div class="col-12 col-sm-8 mb-2">
              <label class="form-label" for="rf-note">เหตุผล / Note</label>
              <input id="rf-note" class="form-control" autocomplete="off">
            </div>
          </div>

          <div id="rf-scan-area" class="d-none mt-2 text-center">
            <video id="rf-video" playsinline muted style="width:100%;max-width:420px;border-radius:8px;background:#000;"></video>
            <div class="mt-1"><button type="button" class="btn btn-sm btn-outline-secondary" id="rf-scan-stop">หยุดสแกน</button></div>
          </div>

          <div id="rf-error" class="alert alert-danger mt-2 d-none" role="alert" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
          <button type="submit" class="btn btn-stock-primary" id="rf-submit" style="min-height:44px;">บันทึก</button>
        </div>
      </form>
    `);
    const modal = new bootstrap.Modal(modalEl);

    const $ = (id) => modalEl.querySelector('#' + id);

    // Item search → populate <select>
    let itemTimer = null;
    async function refreshItemOptions(query, autoSelectId) {
      const r = await window.AppInventory.listItems({ search: query, activeOnly: true, limit: 50 });
      if (r.error) return;
      const opts = (r.data || []).map((it) => {
        const total = it.total_qty || 0;
        return `<option value="${_esc(it.id)}">${_esc(it.sku)} — ${_esc(it.name)} (คงเหลือ ${total})</option>`;
      });
      $('rf-item').innerHTML = '<option value="">— เลือก —</option>' + opts.join('');
      if (autoSelectId) $('rf-item').value = autoSelectId;
    }
    $('rf-item-search').addEventListener('input', () => {
      if (itemTimer) clearTimeout(itemTimer);
      itemTimer = setTimeout(() => refreshItemOptions($('rf-item-search').value.trim()), 250);
    });
    await refreshItemOptions('', prefillItem ? prefillItem.id : null);
    if (prefillItem) $('rf-item-search').value = prefillItem.name;

    // Scanner glue
    let scannerActive = false;
    async function startScan(mode) {
      if (!window.AppScanner || !window.AppScanner.isSupported()) {
        _toast('error', 'อุปกรณ์นี้ไม่รองรับการสแกน'); return;
      }
      if (scannerActive) await window.AppScanner.stopScanning();
      $('rf-scan-area').classList.remove('d-none');
      scannerActive = true;
      await window.AppScanner.startScanning({
        videoElement: $('rf-video'),
        onScan: async (text) => {
          if (!scannerActive) return;
          const parsed = window.AppScanner.parseScanResult(text);
          if (mode === 'item') {
            // Even if classified as location-qr, accept item-barcode value too.
            const code = parsed.type === 'location-qr' ? parsed.value : parsed.value;
            const r = await window.AppInventory.searchByBarcode(code);
            if (r.error || !r.data) {
              _toast('warning', `ไม่พบสินค้า: ${code}`);
              return;
            }
            $('rf-item-search').value = r.data.name;
            await refreshItemOptions(r.data.sku, r.data.id);
            _toast('success', `เลือกสินค้า: ${r.data.name}`);
            await stopScan();
          } else if (mode === 'loc') {
            const code = parsed.value;
            const r = await window.AppInventory.findLocationByCode(code);
            if (r.error || !r.data) {
              _toast('warning', `ไม่พบสถานที่: ${code}`);
              return;
            }
            // Ensure option exists, then select
            if (!_locations.find((x) => x.id === r.data.id)) {
              _locations.push(r.data);
              const sel = $('rf-location');
              sel.insertAdjacentHTML('beforeend',
                `<option value="${_esc(r.data.id)}">${_esc(_locLabel(r.data))}</option>`);
            }
            $('rf-location').value = r.data.id;
            _toast('success', `เลือกสถานที่: ${r.data.code}`);
            await stopScan();
          }
        },
        onError: (msg) => { _toast('error', msg || 'สแกนล้มเหลว'); },
      });
    }
    async function stopScan() {
      if (!scannerActive) return;
      scannerActive = false;
      try { await window.AppScanner.stopScanning(); } catch {}
      $('rf-scan-area').classList.add('d-none');
    }

    $('rf-scan-item').onclick = () => startScan('item');
    $('rf-scan-loc').onclick  = () => startScan('loc');
    $('rf-scan-stop').onclick = () => stopScan();
    modalEl.addEventListener('hidden.bs.modal', () => { stopScan(); });

    // Submit
    $('inv-receive-form'); // no-op (just locate by form id below)
    modalEl.querySelector('#inv-receive-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const errEl = $('rf-error');
      errEl.classList.add('d-none'); errEl.textContent = '';

      const itemId = $('rf-item').value;
      const locId  = $('rf-location').value;
      const qty    = parseInt($('rf-qty').value, 10);
      const note   = $('rf-note').value.trim() || null;
      if (!itemId || !locId || !Number.isFinite(qty) || qty <= 0) {
        errEl.textContent = 'กรอกข้อมูลไม่ครบ';
        errEl.classList.remove('d-none');
        return;
      }
      const submitEl = $('rf-submit');
      submitEl.disabled = true;
      submitEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';

      const clientRefId = (crypto.randomUUID ? crypto.randomUUID() : window.AppInventory._uuid());
      const r = await window.AppInventory.receive(itemId, locId, qty, note, clientRefId);

      submitEl.disabled = false;
      submitEl.textContent = 'บันทึก';

      if (r.error) {
        errEl.textContent = _friendly(r.error, 'บันทึกไม่สำเร็จ');
        errEl.classList.remove('d-none');
        return;
      }
      const itemRow = _items.find((x) => x.id === itemId) || { name: '?', unit: 'ชิ้น' };
      const locRow  = _locations.find((x) => x.id === locId) || { code: '?' };

      if (r.data && r.data.replay) {
        _toast('info', 'รายการนี้บันทึกแล้ว');
      } else {
        _toast('success', `รับเข้าแล้ว: ${itemRow.name} x${qty} ที่ ${locRow.code}`);
      }
      stopScan();
      modal.hide();
      reload();
    };

    modal.show();
  }

  // =========================================================================
  // Adjustment Loss / Gain modal (shared shape)
  // =========================================================================
  async function openAdjustModal(kind, prefillItem) {
    // kind: 'loss' (any role) | 'gain' (Admin only)
    if (kind === 'gain' && !_isAdmin()) { _toast('error', 'เฉพาะ Admin เท่านั้น'); return; }
    await _ensureLocations();

    const title = kind === 'loss' ? 'ของหาย / ชำรุด' : 'ปรับยอด +';
    const iconCls = kind === 'loss' ? 'bi-exclamation-triangle' : 'bi-plus-circle';
    const btnCls  = kind === 'loss' ? 'btn-warning' : 'btn-stock-primary';

    const modalEl = _createModalShell('inv-adjust-modal', '', `
      <form id="inv-adjust-form">
        <div class="modal-header">
          <h5 class="modal-title"><i class="bi ${iconCls}"></i> ${_esc(title)}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
        </div>
        <div class="modal-body">
          <div class="mb-2">
            <label class="form-label">สินค้า</label>
            <div class="form-control-plaintext">
              <code>${_esc(prefillItem.sku)}</code> — ${_esc(prefillItem.name)}
            </div>
          </div>
          <div class="mb-2">
            <label class="form-label" for="af-location">สถานที่ *</label>
            <select id="af-location" class="form-select" required>
              <option value="">— เลือก —</option>
              ${_locations.map((l) => `<option value="${_esc(l.id)}">${_esc(_locLabel(l))}</option>`).join('')}
            </select>
          </div>
          <div class="row g-2">
            <div class="col-12 col-sm-4 mb-2">
              <label class="form-label" for="af-qty">จำนวน *</label>
              <input id="af-qty" type="number" min="1" step="1" class="form-control"
                     inputmode="numeric" required>
            </div>
            <div class="col-12 col-sm-8 mb-2">
              <label class="form-label" for="af-note">เหตุผล *</label>
              <input id="af-note" class="form-control" required>
            </div>
          </div>
          <div id="af-error" class="alert alert-danger mt-2 d-none" role="alert" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
          <button type="submit" class="btn ${btnCls}" id="af-submit" style="min-height:44px;">บันทึก</button>
        </div>
      </form>
    `);
    const modal = new bootstrap.Modal(modalEl);

    modalEl.querySelector('#inv-adjust-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const errEl = modalEl.querySelector('#af-error');
      errEl.classList.add('d-none'); errEl.textContent = '';

      const locId = modalEl.querySelector('#af-location').value;
      const qty   = parseInt(modalEl.querySelector('#af-qty').value, 10);
      const note  = modalEl.querySelector('#af-note').value.trim();
      if (!locId || !Number.isFinite(qty) || qty <= 0 || !note) {
        errEl.textContent = 'กรอกข้อมูลไม่ครบ';
        errEl.classList.remove('d-none');
        return;
      }

      const submitEl = modalEl.querySelector('#af-submit');
      submitEl.disabled = true;
      submitEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';

      const clientRefId = crypto.randomUUID ? crypto.randomUUID() : window.AppInventory._uuid();
      const r = kind === 'loss'
        ? await window.AppInventory.adjustmentLoss(prefillItem.id, locId, qty, note, clientRefId)
        : await window.AppInventory.adjustmentGain(prefillItem.id, locId, qty, note, clientRefId);

      submitEl.disabled = false;
      submitEl.textContent = 'บันทึก';

      if (r.error) {
        errEl.textContent = _friendly(r.error, 'บันทึกไม่สำเร็จ');
        errEl.classList.remove('d-none');
        return;
      }
      if (r.data && r.data.replay) {
        _toast('info', 'รายการนี้บันทึกแล้ว');
      } else {
        _toast('success', kind === 'loss' ? 'บันทึกของหายแล้ว' : 'ปรับยอดแล้ว');
      }
      modal.hide();
      reload();
    };

    modal.show();
  }

  // =========================================================================
  // Modal scaffold
  // =========================================================================
  function _createModalShell(id, sizeCls, innerHtml) {
    // Strip any prior modal with the same id (defensive — Bootstrap leaves backdrops sometimes).
    const old = document.getElementById(id);
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal fade" id="${id}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog ${sizeCls} modal-dialog-centered modal-dialog-scrollable modal-fullscreen-sm-down">
          <div class="modal-content">
            ${innerHtml}
          </div>
        </div>
      </div>
    `.trim();
    const el = wrap.firstChild;
    document.body.appendChild(el);
    el.addEventListener('hidden.bs.modal', () => { try { el.remove(); } catch {} });
    return el;
  }

  // =========================================================================
  // Lazy init (called once by admin-shell on first tab open)
  // =========================================================================
  async function init() {
    if (_mounted) return; // safety: idempotent
    _mounted = true;
    _renderShell();
    await _ensureCategories();
    _renderCategoryDropdown();
    await reload();

    // Realtime — subscribe AFTER the first load so we don't double-trigger.
    if (window.AppInventory.subscribeInventory) {
      _unsubscribe = window.AppInventory.subscribeInventory(() => {
        _scheduleRealtimeReload();
      });
    }

    // Tab teardown — page unload + tab pane hide.
    window.addEventListener('beforeunload', teardown);
    // visibilitychange: free socket on hidden tabs (no hard guarantee but easy win).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && _unsubscribe) {
        // Keep the subscription — admin-shell users expect live data when they come back.
        // We do NOT unsubscribe here on purpose.
      }
    });
  }

  function teardown() {
    if (_unsubscribe) { try { _unsubscribe(); } catch {} _unsubscribe = null; }
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    _mounted = false;
  }

  // =========================================================================
  // Public namespace
  // =========================================================================
  window.AppInventoryTab = {
    init,
    teardown,
    reload,
    openItemModal,
    openReceiveModal,
    openAdjustModal,
    openItemDetailDrawer,
  };

  // admin-shell.js expects window.initInventoryTab — shim wrapper.
  window.initInventoryTab = init;
})();
