// js/inventory.js
// Phase 1 + Phase 2 + Phase 6 — Admin Inventory tab controller.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-18-phase1-inventory-design.md  §7.1 (Admin Inventory tab)
//   docs/superpowers/designs/2026-05-18-phase1-ui-design.md       §2 Area 1 (wireframes, microcopy)
//   docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md    Phase D
//   docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md  Q-D5 (scroll-x + edge-fade), derived #10 (tracks_lots)
//   docs/superpowers/plans/2026-05-19-phase2-medication-plan.md   Task B2
//   docs/superpowers/designs/2026-05-18-phase2-ui-design.md       §3.2, §3.3
//   docs/superpowers/specs/2026-05-19-phase6-linens-laundry-design.md §7.1 (Admin inventory extension)
//   docs/superpowers/designs/2026-05-19-phase6-linens-ui-design.md    §3.1–§3.5
//
// Phase 6 changes (additive only — all existing Phase 1/2 code unchanged):
//   — "ผ้า" option added to category dropdown (LINEN code detected via data-code attribute)
//   — When category=LINEN active in สินค้า subview: swap to v_linen_audit table
//     + sub-category pills + discrepancy banner
//   — Receive modal: LINEN item pre-fills reason field (laundry_in/laundry_out)
//   — New Phase 6 functions: _loadLinenAudit, _renderLinenAudit, _renderLinenSubcatPills
//
// Locked decisions (PM Pex 2026-05-18/19 — DO NOT re-debate):
//   Q1: NO Transfer modal in Phase 1 — only receive / issue / adjustment_loss / adjustment_gain
//   Q2: NO Chart.js — plain HTML/text for any breakdown
//   Q3: NO photo upload / camera-photo capture
//   Q-D5: 4-segment tab uses overflow-x:auto + .inventory-tabs-scroll edge-fade (CSS in shared/styles.css)
//         NO label shortening.
//
// Upstream APIs consumed (all via window.AppInventory — never direct Supabase):
//   AppInventory.listCategories, listItems, getItem, searchByBarcode, findLocationByCode,
//                getLowStock, createItem, updateItem, deactivateItem,
//                receive, adjustmentLoss, adjustmentGain, subscribeInventory
//   AppLots (window.AppLots from shared/lots.js — Phase 2): createLot, fetchAllLots
//   AppLotsView (window.initLotsView from js/inventory-lots.js — Phase 2): initLotsView
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

  // Phase 2 — active sub-view ('items'|'receive'|'lots'|'search')
  let _activeSubview = 'items';

  // Phase 6 — LINEN mode state
  let _linenMode          = false;   // true when category=LINEN + subview=items
  let _linens             = [];      // merged rows for linen view (stock_items + audit overlay)
  let _activeSubcat       = 'all';   // linen sub-category filter (client-side)
  let _linenCategoryId    = null;    // cached UUID for LINEN category

  // Phase 0.5 — QR print selection
  let _invSelected     = new Set();  // Set of item IDs selected for bulk print

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

  /** Phase 0.5: update visibility + count of the inventory bulk-print bar. */
  function _updateInvBulkBar() {
    const bar   = document.getElementById('inv-bulk-bar');
    const cnt   = document.getElementById('inv-bulk-count');
    const chkAll = document.getElementById('inv-chk-all');
    if (!bar || !cnt) return;
    const n = _invSelected.size;
    cnt.textContent = String(n);
    bar.classList.toggle('d-none', n === 0);
    if (chkAll) {
      chkAll.indeterminate = n > 0 && n < _items.length;
      chkAll.checked       = n > 0 && n === _items.length;
    }
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
      <!-- Phase 2: 4-segment navigation + action buttons -->
      <div class="d-flex flex-wrap align-items-center mb-3 gap-2">
        <h5 class="mb-0 me-auto"><i class="bi bi-box-seam"></i> คลังสินค้า</h5>
        <button class="btn btn-stock-primary" id="inv-btn-add" style="min-height:44px;">
          <i class="bi bi-plus-lg"></i> เพิ่มสินค้า
        </button>
        <button class="btn btn-outline-stock-accent" id="inv-btn-receive" style="min-height:44px;">
          <i class="bi bi-box-arrow-in-down"></i> รับเข้า
        </button>
      </div>

      <!-- Phase 2 Q-D5: 4 segments, overflow-x auto, edge-fade hint via .inventory-tabs-scroll -->
      <div class="inventory-tabs-scroll mb-3">
        <ul class="nav nav-pills flex-nowrap" id="inv-subview-tabs" role="tablist"
            style="white-space:nowrap;">
          <li class="nav-item" role="presentation">
            <button class="nav-link active" id="inv-tab-items" type="button"
                    role="tab" data-subview="items" aria-selected="true"
                    style="min-height:44px; white-space:nowrap;">
              รายการสินค้า
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="inv-tab-receive" type="button"
                    role="tab" data-subview="receive" aria-selected="false"
                    style="min-height:44px; white-space:nowrap;">
              รับเข้า
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="inv-tab-lots" type="button"
                    role="tab" data-subview="lots" aria-selected="false"
                    style="min-height:44px; white-space:nowrap;">
              ล็อตยา
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="inv-tab-search" type="button"
                    role="tab" data-subview="search" aria-selected="false"
                    style="min-height:44px; white-space:nowrap;">
              ค้นของ
            </button>
          </li>
        </ul>
      </div>

      <!-- Sub-view: รายการสินค้า (default visible) -->
      <div id="inv-subview-items">
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

        <!-- Phase 0.5: bulk-print bar (hidden until at least 1 row selected) -->
        <div id="inv-bulk-bar" class="d-none alert alert-info d-flex align-items-center gap-2 mb-2 py-2">
          <span id="inv-bulk-count" class="fw-bold">0</span> รายการที่เลือก
          <button type="button" class="btn btn-sm btn-stock-primary ms-2" id="inv-btn-bulk-print">
            <i class="bi bi-printer me-1"></i>บันทึก PNG ที่เลือก
          </button>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="inv-btn-bulk-desel">
            ยกเลิกทั้งหมด
          </button>
        </div>

        <div class="card">
          <div class="card-body p-0">
            <div class="table-responsive">
              <table class="table table-striped table-hover align-middle mb-0">
                <thead class="position-sticky top-0 bg-white" style="z-index:1;">
                  <tr>
                    <th scope="col" style="width:36px;">
                      <input type="checkbox" class="form-check-input" id="inv-chk-all"
                             aria-label="เลือกทั้งหมด" title="เลือกทั้งหมด">
                    </th>
                    <th scope="col" class="d-none d-sm-table-cell">SKU</th>
                    <th scope="col">ชื่อ</th>
                    <th scope="col" class="d-none d-md-table-cell">หมวด</th>
                    <th scope="col" class="d-none d-md-table-cell">หน่วย</th>
                    <th scope="col" class="text-end">คงเหลือรวม</th>
                    <th scope="col" class="d-none d-sm-table-cell text-end" title="ระดับขั้นต่ำ — ถ้าคงเหลือถึงเกณฑ์นี้ ระบบจะแจ้ง Telegram">เกณฑ์เตือน</th>
                    <th scope="col" class="d-none d-sm-table-cell" title="สถานะการใช้งานในระบบ (ใช้งาน / เลิกใช้)">การใช้งาน</th>
                    <th scope="col" class="text-end" style="width:44px;"></th>
                  </tr>
                </thead>
                <tbody id="inv-tbody">
                  <tr><td colspan="9" class="text-center text-muted py-4">
                    <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
                  </td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Sub-view: รับเข้า (Phase 2 extension: shown when segment clicked) -->
      <div id="inv-subview-receive" class="d-none">
        <div class="card">
          <div class="card-body">
            <p class="text-muted mb-3">กด "รับเข้า" เพื่อเปิดหน้าต่างรับสินค้า</p>
            <button type="button" class="btn btn-outline-stock-accent" id="inv-subview-receive-btn"
                    style="min-height:44px;">
              <i class="bi bi-box-arrow-in-down"></i> รับเข้า
            </button>
          </div>
        </div>
      </div>

      <!-- Sub-view: ล็อตยา (Phase 2 — rendered by js/inventory-lots.js) -->
      <div id="inv-subview-lots" class="d-none">
        <!-- initLotsView() will render into this container -->
      </div>

      <!-- Sub-view: ค้นของ (search panel — same as items list for now) -->
      <div id="inv-subview-search" class="d-none">
        <div class="card mb-3">
          <div class="card-body py-3">
            <label class="form-label" for="inv-search-q">ค้นหาสินค้า</label>
            <input id="inv-search-q" type="search" class="form-control"
                   placeholder="พิมพ์ชื่อ / SKU / Barcode" autocomplete="off"
                   style="min-height:44px;">
          </div>
        </div>
        <div id="inv-search-results" class="text-muted text-center py-3">พิมพ์เพื่อค้นหา</div>
      </div>
    `;

    document.getElementById('inv-btn-add').onclick     = () => openItemModal(null);
    document.getElementById('inv-btn-receive').onclick = () => openReceiveModal(null);

    // Phase 0.5: bulk-print bar wiring
    document.getElementById('inv-btn-bulk-print').addEventListener('click', () => {
      const rows = _items
        .filter((it) => _invSelected.has(it.id))
        .map((it) => ({ code: it.sku, label: it.sku, subtitle: it.name }));
      if (!rows.length) return;
      if (window.QRPrint) {
        window.QRPrint.bulk(rows, {});
      } else {
        _toast('error', 'โมดูล QR ยังไม่โหลด — รีเฟรชหน้าใหม่');
      }
    });
    document.getElementById('inv-btn-bulk-desel').addEventListener('click', () => {
      _invSelected.clear();
      _updateInvBulkBar();
      _renderRows();
    });

    // Phase 2: sub-view segment tab switching (Q-D5)
    document.getElementById('inv-subview-tabs').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-subview]');
      if (!btn) return;
      _activateSubview(btn.dataset.subview);
    });

    // Receive sub-view quick-launch button
    const subviewReceiveBtn = document.getElementById('inv-subview-receive-btn');
    if (subviewReceiveBtn) subviewReceiveBtn.addEventListener('click', () => openReceiveModal(null));

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
      // Phase 6: LINEN mode toggle
      _linenMode   = _selectedCatIsLinen();
      _activeSubcat = 'all';
      _toggleLinenUI(_linenMode);
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
    // Phase 6: add data-code attribute so we can detect LINEN selection by code, not UUID
    sel.innerHTML = '<option value="">หมวด: ทั้งหมด</option>' +
      _categories.map((c) => `<option value="${_esc(c.id)}" data-code="${_esc(c.code)}">${_esc(c.name)}</option>`).join('');
    if (current) sel.value = current;
  }

  // Phase 6 — detect if the selected category option has code='LINEN'
  function _selectedCatIsLinen() {
    const sel = document.getElementById('inv-category');
    if (!sel || !sel.value) return false;
    const opt = sel.options[sel.selectedIndex];
    return opt && opt.dataset.code === 'LINEN';
  }

  // =========================================================================
  // Phase 2 — Sub-view switching (Q-D5: 4 segments, overflow-x)
  // =========================================================================

  /**
   * Activate a sub-view by name.
   * Sub-views: 'items' | 'receive' | 'lots' | 'search'
   *
   * @param {string} name
   * @param {object} [opts]           passed to initLotsView when name='lots'
   * @param {string} [opts.lotsFilter]  pre-set expiry window filter for lot list
   */
  function _activateSubview(name, opts) {
    _activeSubview = name;

    // Toggle segment button active state
    document.querySelectorAll('#inv-subview-tabs [data-subview]').forEach((btn) => {
      const isActive = btn.dataset.subview === name;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    // Toggle sub-view pane visibility
    ['items', 'receive', 'lots', 'search'].forEach((sv) => {
      const el = document.getElementById(`inv-subview-${sv}`);
      if (el) el.classList.toggle('d-none', sv !== name);
    });

    // Phase 2: lazy-init the lots view when switching to it
    if (name === 'lots') {
      const container = document.getElementById('inv-subview-lots');
      if (container) {
        // Load shared/lots.js module and inventory-lots.js if not yet loaded, then init.
        _ensureLotsScripts().then(() => {
          if (typeof window.initLotsView === 'function') {
            window.initLotsView(container, { presetFilter: opts && opts.lotsFilter });
          } else {
            container.innerHTML = `<div class="text-danger p-3">โหลดโมดูลล็อตยาไม่สำเร็จ — รีเฟรชหน้าใหม่</div>`;
          }
        }).catch((e) => {
          const container2 = document.getElementById('inv-subview-lots');
          if (container2) container2.innerHTML = `<div class="text-danger p-3">โหลดโมดูลล็อตยาไม่สำเร็จ: ${_esc(e.message || '')}</div>`;
        });
      }
    }

    if (name === 'search') {
      // Wire search-q input on first activation
      const qEl = document.getElementById('inv-search-q');
      if (qEl && !qEl.dataset.wired) {
        qEl.dataset.wired = '1';
        let timer = null;
        qEl.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => _runSubviewSearch(qEl.value.trim()), 250);
        });
      }
    }
  }

  /**
   * Ensure shared/lots.js and js/inventory-lots.js are loaded.
   * Idempotent — resolves immediately if already loaded.
   */
  async function _ensureLotsScripts() {
    // Check if already loaded
    if (window.AppLots && typeof window.initLotsView === 'function') return;

    // Dynamically inject script tags (no-build-step constraint)
    async function _loadScript(src) {
      return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s   = document.createElement('script');
        s.src     = src;
        s.onload  = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
      });
    }
    // Paths relative to the HTML root (admin.html is at root)
    await _loadScript('./shared/lots.js');
    await _loadScript('./js/inventory-lots.js');
  }

  /**
   * Run free-text search in the "ค้นของ" sub-view.
   */
  async function _runSubviewSearch(q) {
    const resultsEl = document.getElementById('inv-search-results');
    if (!resultsEl) return;

    if (!q) {
      resultsEl.innerHTML = '<span class="text-muted">พิมพ์เพื่อค้นหา</span>';
      return;
    }
    resultsEl.innerHTML = '<span class="text-muted"><span class="spinner-border spinner-border-sm me-1"></span>กำลังค้นหา…</span>';

    const { data, error } = await window.AppInventory.listItems({ search: q, limit: 20 });
    if (error) {
      resultsEl.innerHTML = `<div class="text-danger">${_esc(error.message || 'ค้นหาไม่สำเร็จ')}</div>`;
      return;
    }
    if (!data || !data.length) {
      resultsEl.innerHTML = '<span class="text-muted">ไม่พบสินค้าที่ตรงกัน</span>';
      return;
    }
    resultsEl.className = '';
    resultsEl.innerHTML = `
      <div class="card">
        <div class="card-body p-0">
          <ul class="list-group list-group-flush">
            ${data.map((it) => `
              <li class="list-group-item list-group-item-action"
                  data-id="${_esc(it.id)}" role="button" tabindex="0"
                  style="cursor:pointer; min-height:48px;">
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <div class="fw-semibold">${_esc(it.name)}</div>
                    <div class="small text-muted"><code>${_esc(it.sku)}</code>
                      ${it.tracks_lots ? ' · <span class="fc-badge fc-badge-vital">ล็อต</span>' : ''}</div>
                  </div>
                  <span class="fc-badge fc-badge-vital">${it.total_qty || 0} ${_esc(it.unit || 'ชิ้น')}</span>
                </div>
              </li>`).join('')}
          </ul>
        </div>
      </div>`;

    resultsEl.querySelectorAll('[data-id]').forEach((li) => {
      li.addEventListener('click', () => openItemDetailDrawer(li.dataset.id));
    });
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
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">${_esc(msg)}</td></tr>`;
      _updateInvBulkBar();
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
        ? '<span class="fc-badge fc-badge-ok">ใช้งาน</span>'
        : '<span class="fc-badge fc-badge-neutral">เลิกใช้</span>';
      const checked = _invSelected.has(it.id) ? 'checked' : '';
      return `
        <tr data-id="${_esc(it.id)}" role="button" tabindex="0" style="cursor:pointer;">
          <td>
            <input type="checkbox" class="form-check-input inv-row-chk" data-id="${_esc(it.id)}"
                   aria-label="เลือก ${_esc(it.sku)}" ${checked}
                   style="min-width:20px;min-height:20px;">
          </td>
          <td class="d-none d-sm-table-cell"><code class="small">${_esc(it.sku)}</code></td>
          <td>
            <div>${_esc(it.name)}</div>
            <div class="d-sm-none small text-muted">${_esc(it.sku)}</div>
          </td>
          <td class="d-none d-md-table-cell small">${_esc(_catName(it.category_id))}</td>
          <td class="d-none d-md-table-cell small">${_esc(it.unit || 'ชิ้น')}</td>
          <td class="text-end"><span class="fc-mono">${totalCell}</span> <span class="text-muted small">${_esc(it.unit || 'ชิ้น')}</span></td>
          <td class="d-none d-sm-table-cell text-end small">${threshold > 0 ? `<span class="text-muted">≤</span> <span class="fc-mono">${threshold}</span> ${_esc(it.unit || 'ชิ้น')}` : '<span class="text-muted">ไม่แจ้ง</span>'}</td>
          <td class="d-none d-sm-table-cell">${statusBadge}</td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-link p-1" data-act="print-single"
                    data-id="${_esc(it.id)}"
                    aria-label="บันทึก QR ${_esc(it.sku)}" title="บันทึก QR เป็น PNG"
                    style="min-width:44px;min-height:44px;">
              <i class="bi bi-qr-code"></i>
            </button>
            <button type="button" class="btn btn-sm btn-link p-1" data-act="menu"
                    aria-label="เมนู" style="min-width:44px;min-height:44px;">
              <i class="bi bi-three-dots-vertical"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    // Phase 0.5: select-all header checkbox
    const chkAll = document.getElementById('inv-chk-all');
    if (chkAll) {
      chkAll.indeterminate = _invSelected.size > 0 && _invSelected.size < _items.length;
      chkAll.checked       = _invSelected.size > 0 && _invSelected.size === _items.length;
      chkAll.onchange = () => {
        if (chkAll.checked) { _items.forEach((it) => _invSelected.add(it.id)); }
        else                { _invSelected.clear(); }
        _updateInvBulkBar();
        _renderRows();
      };
    }

    // Row click → detail drawer (design §2.4). The 3-dots column dispatches row-action menu.
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.addEventListener('click', (ev) => {
        // Phase 0.5: print-single button
        const printBtn = ev.target.closest('[data-act="print-single"]');
        if (printBtn) {
          ev.stopPropagation();
          const item = _items.find((x) => x.id === printBtn.dataset.id);
          if (item && window.QRPrint) {
            window.QRPrint.single(item.sku, {
              size:       '50x30',
              label:      item.sku,
              subtitle:   item.name,
              entityType: 'item',
            });
          } else if (!window.QRPrint) {
            _toast('error', 'โมดูล QR ยังไม่โหลด — รีเฟรชหน้าใหม่');
          }
          return;
        }
        // Phase 0.5: row checkbox toggle (stop row-level click from opening drawer)
        const chkBox = ev.target.closest('.inv-row-chk');
        if (chkBox) {
          ev.stopPropagation();
          const cid = chkBox.dataset.id;
          if (chkBox.checked) _invSelected.add(cid);
          else                _invSelected.delete(cid);
          _updateInvBulkBar();
          return;
        }
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

    _updateInvBulkBar();
  }

  // -------------------------------------------------------------------------
  // Data loaders
  // -------------------------------------------------------------------------
  async function reload() {
    // Phase 6: branch to linen audit path when LINEN category is active in สินค้า subview
    if (_linenMode && _activeSubview === 'items') {
      await _loadLinenAudit();
      return;
    }

    const tbody = document.getElementById('inv-tbody');
    if (tbody && !_items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">
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
      if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="text-center text-danger py-4">
        ${_esc(_friendly(r.error, 'โหลดสินค้าไม่สำเร็จ'))}
      </td></tr>`;
      _toast('error', _friendly(r.error, 'โหลดสินค้าไม่สำเร็จ'));
      return;
    }
    _items = r.data || [];
    // Phase 0.5: clear selection on each full reload so stale selections don't linger
    _invSelected.clear();
    _renderRows();
  }

  // -------------------------------------------------------------------------
  // Realtime — debounce reloads (spec §5.7, design 300ms)
  // Phase 1.1 B1: cancels previous timer so bursts of events collapse into
  // one reload 300ms after the LAST event (true debounce, not throttle).
  // -------------------------------------------------------------------------
  /** Debounced realtime reload — 300ms window, cancels prior timer on each call. */
  function _scheduleRealtimeReload() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => {
      _refreshTimer = null;
      reload().catch(() => {});
    }, 300);
  }

  // =========================================================================
  // Phase 6 — LINEN audit view (spec §7.1, design §3.1–§3.3)
  // =========================================================================

  /**
   * Show or hide the LINEN-specific UI elements (subcat pills, discrepancy banner).
   * Swaps the main table header to linen columns when active.
   * @param {boolean} active
   */
  function _toggleLinenUI(active) {
    // Sub-category pills row (injected lazily in the items-subview card)
    let pillsRow = document.getElementById('inv-linen-subcat-row');
    if (!pillsRow && active) {
      // Inject pills row and banner above the items table card
      const itemsSubview = document.getElementById('inv-subview-items');
      if (itemsSubview) {
        // Banner
        const banner = document.createElement('div');
        banner.id = 'inv-linen-banner';
        banner.className = 'alert alert-warning d-none mb-2 py-2 px-3 small';
        banner.setAttribute('role', 'alert');
        banner.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-1"></i>' +
          '<span id="inv-linen-banner-text"></span>' +
          '<span class="ms-2 text-muted">(คลาดเคลื่อนเกินเกณฑ์ &gt;5% หรือ &gt;2 ผืน)</span>';
        itemsSubview.insertAdjacentElement('afterbegin', banner);

        // Subcat pills
        const pills = document.createElement('div');
        pills.id = 'inv-linen-subcat-row';
        pills.className = 'mb-2 overflow-auto d-none';
        pills.innerHTML = `<div class="d-flex gap-2 flex-nowrap pb-1" id="inv-subcat-pills" style="min-width:max-content;">
          <button class="btn btn-stock-primary rounded-pill btn-sm" data-subcat="all">ทั้งหมด</button>
          <button class="btn btn-outline-secondary rounded-pill btn-sm" data-subcat="sheet">ผ้าปูที่นอน</button>
          <button class="btn btn-outline-secondary rounded-pill btn-sm" data-subcat="blanket">ผ้าห่ม</button>
          <button class="btn btn-outline-secondary rounded-pill btn-sm" data-subcat="towel">ผ้าขนหนู</button>
          <button class="btn btn-outline-secondary rounded-pill btn-sm" data-subcat="gown">เสื้อกาวน์</button>
          <button class="btn btn-outline-secondary rounded-pill btn-sm" data-subcat="wipe">ผ้าเช็ดเครื่องมือ</button>
        </div>`;
        banner.after(pills);
        pills.addEventListener('click', (ev) => {
          const btn = ev.target.closest('[data-subcat]');
          if (!btn) return;
          _activeSubcat = btn.dataset.subcat;
          pills.querySelectorAll('[data-subcat]').forEach((b) => {
            b.classList.toggle('btn-stock-primary', b === btn);
            b.classList.toggle('btn-outline-secondary', b !== btn);
          });
          _renderLinenAudit(_linens);
        });

        pillsRow = pills;
      }
    }
    if (pillsRow) pillsRow.classList.toggle('d-none', !active);
    const banner = document.getElementById('inv-linen-banner');
    if (banner && !active) banner.classList.add('d-none');

    // Swap thead columns
    const thead = document.querySelector('#inv-subview-items table thead tr');
    if (thead) {
      if (active) {
        thead.innerHTML = `
          <th scope="col">ชื่อผ้า</th>
          <th scope="col" class="d-none d-md-table-cell">หมวดย่อย</th>
          <th scope="col" class="d-none d-md-table-cell">ตู้</th>
          <th scope="col" class="text-end">คงเหลือ</th>
          <th scope="col" class="d-none d-md-table-cell">นับล่าสุด</th>
          <th scope="col" class="d-none d-md-table-cell text-end">จำนวนนับ</th>
          <th scope="col" class="text-end">ต่างจากระบบ</th>
          <th scope="col" style="width:44px;"></th>
        `;
      } else {
        // Phase 0.5: restore checkbox column when leaving linen mode
        thead.innerHTML = `
          <th scope="col" style="width:36px;">
            <input type="checkbox" class="form-check-input" id="inv-chk-all"
                   aria-label="เลือกทั้งหมด" title="เลือกทั้งหมด">
          </th>
          <th scope="col" class="d-none d-sm-table-cell">SKU</th>
          <th scope="col">ชื่อ</th>
          <th scope="col" class="d-none d-md-table-cell">หมวด</th>
          <th scope="col" class="d-none d-md-table-cell">หน่วย</th>
          <th scope="col" class="text-end">คงเหลือรวม</th>
          <th scope="col" class="d-none d-sm-table-cell text-end" title="ระดับขั้นต่ำ — ถ้าคงเหลือถึงเกณฑ์นี้ ระบบจะแจ้ง Telegram">เกณฑ์เตือน</th>
          <th scope="col" class="d-none d-sm-table-cell" title="สถานะการใช้งานในระบบ (ใช้งาน / เลิกใช้)">การใช้งาน</th>
          <th scope="col" class="text-end" style="width:44px;"></th>
        `;
      }
    }
  }

  /**
   * Resolve (and cache) the UUID for the LINEN stock_category.
   * @returns {Promise<string|null>}
   */
  async function _getLinenCategoryId() {
    if (_linenCategoryId) return _linenCategoryId;
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from('stock_categories').select('id').eq('code', 'LINEN').single();
    if (error || !data) return null;
    _linenCategoryId = data.id;
    return _linenCategoryId;
  }

  /**
   * Load linen view (Option A):
   *   1. Fetch ALL stock_items where category_id = LINEN (zero-stock included).
   *   2. Fetch v_linen_audit to get count/discrepancy data.
   *   3. Merge by item_id — items with no audit data show "—" for count columns.
   *
   * This ensures newly-created linen items (never received) always appear.
   */
  async function _loadLinenAudit() {
    const tbody = document.getElementById('inv-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลดข้อมูลผ้า…
      </td></tr>`;
    }

    if (!window.AppLinens) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">
        โมดูล AppLinens ไม่พร้อม — ตรวจสอบ shared/linens.js
      </td></tr>`;
      return;
    }

    // Step 1: base item list (all linen items, stocked or not)
    const linenCatId = await _getLinenCategoryId();
    if (!linenCatId) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">
        ไม่พบหมวด LINEN — ตรวจสอบตาราง stock_categories
      </td></tr>`;
      return;
    }
    const sb = getSupabaseClient();
    const { data: itemRows, error: itemErr } = await sb
      .from('stock_items')
      .select('id,sku,name,linen_subcategory,active,stock_item_locations(qty)')
      .eq('category_id', linenCatId)
      .order('name');
    if (itemErr) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">
        โหลดรายการผ้าไม่สำเร็จ — กรุณาลองใหม่
      </td></tr>`;
      _toast('error', 'โหลดรายการผ้าไม่สำเร็จ');
      return;
    }

    // Step 2: audit overlay (may be empty if v_linen_audit returns nothing yet)
    const { data: auditRows } = await window.AppLinens.fetchLinenAudit();
    // Build lookup: item_id → best audit row (pick highest qty if multiple locations)
    const auditMap = {};
    (auditRows || []).forEach((r) => {
      const prev = auditMap[r.item_id];
      if (!prev || (r.current_qty ?? 0) > (prev.current_qty ?? 0)) {
        auditMap[r.item_id] = r;
      }
    });

    // Step 3: merge
    _linens = (itemRows || []).map((item) => {
      const totalQty = (item.stock_item_locations || []).reduce((s, sil) => s + (sil.qty || 0), 0);
      const audit    = auditMap[item.id];
      return {
        // base fields (always present)
        item_id:           item.id,
        sku:               item.sku,
        item_name:         item.name,
        linen_subcategory: item.linen_subcategory,
        active:            item.active,
        current_qty:       totalQty,
        // audit overlay (null when no audit row exists)
        location_name:     audit ? audit.location_name  : null,
        counted_at:        audit ? audit.counted_at     : null,
        counted_qty:       audit ? audit.counted_qty    : null,
        delta:             audit ? audit.delta          : null,
        abs_delta:         audit ? audit.abs_delta      : null,
        is_discrepancy:    audit ? audit.is_discrepancy : false,
      };
    });
    _renderLinenAudit(_linens);
  }

  /** Render v_linen_audit rows into the items tbody, applying sub-category filter. */
  function _renderLinenAudit(rows) {
    const tbody  = document.getElementById('inv-tbody');
    const banner = document.getElementById('inv-linen-banner');
    const bannerText = document.getElementById('inv-linen-banner-text');
    if (!tbody) return;

    // Discrepancy banner
    const discrepancyCount = rows.filter((r) => r.is_discrepancy).length;
    if (banner && bannerText) {
      if (discrepancyCount > 0) {
        bannerText.textContent = `ผ้าที่มีความคลาดเคลื่อน: ${discrepancyCount} รายการ`;
        banner.classList.remove('d-none');
      } else {
        banner.classList.add('d-none');
      }
    }

    // Apply sub-category filter (client-side per spec §7.1)
    let filtered = rows;
    if (_activeSubcat !== 'all') {
      filtered = rows.filter((r) => r.linen_subcategory === _activeSubcat);
    }

    if (filtered.length === 0) {
      const subcatLabel = window.AppLinens
        ? window.AppLinens.subcategoryLabel(_activeSubcat)
        : _activeSubcat;
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">
        ${_esc(_activeSubcat !== 'all'
          ? `ไม่พบผ้าหมวด ${subcatLabel} ในระบบ`
          : 'ยังไม่มีสินค้าหมวดผ้าในระบบ — เพิ่มสินค้าใน รับเข้า')}
      </td></tr>`;
      return;
    }

    const L = window.AppLinens;
    tbody.innerHTML = filtered.map((row) => {
      const lastDate    = L ? L.formatDate(row.counted_at) : (row.counted_at ? row.counted_at.slice(0, 10) : 'ยังไม่เคยนับ');
      const subcatLabel = L ? _esc(L.subcategoryLabel(row.linen_subcategory)) : _esc(row.linen_subcategory || '—');
      const badge       = L ? L.discrepancyBadgeHtml(row) : _esc(String(row.delta ?? '—'));
      const qty         = row.current_qty ?? 0;
      const mobileSubrow = `<div class="text-muted small d-md-none">
        ตู้ ${_esc(row.location_name || '—')} • นับ: ${row.counted_qty ?? '—'} ผืน • ${_esc(lastDate)}
      </div>`;
      // Row is clickable → opens the same item drawer as regular items
      // (so linen items get รับเข้า / ปรับยอด / ย้าย / แก้ไข / ปิดใช้งาน too).
      return `<tr data-id="${_esc(row.item_id)}" class="inv-linen-row" style="cursor:pointer">
        <td>${_esc(row.item_name)}${mobileSubrow}</td>
        <td class="d-none d-md-table-cell">${subcatLabel}</td>
        <td class="d-none d-md-table-cell small text-muted">${_esc(row.location_name || '—')}</td>
        <td class="text-end">${qty}</td>
        <td class="d-none d-md-table-cell small text-muted">${_esc(lastDate)}</td>
        <td class="d-none d-md-table-cell text-end">${row.counted_qty ?? '—'}</td>
        <td class="text-end">${badge}</td>
        <td class="text-end"><i class="bi bi-chevron-right text-muted small"></i></td>
      </tr>`;
    }).join('');

    // Wire row clicks → item drawer (same actions as the normal item list)
    tbody.querySelectorAll('.inv-linen-row').forEach((tr) => {
      tr.addEventListener('click', () => {
        const id = tr.dataset.id;
        if (id) openItemDetailDrawer(id);
      });
    });
  }

  // =========================================================================
  // Item detail drawer (design §2.4 — implemented as centered modal)
  // =========================================================================

  // D12: Location type badge label (Phase 0.7)
  function _locTypeBadge(type) {
    const MAP = {
      room: 'ห้อง', storage: 'ตู้', cabinet: 'ตู้', shelf: 'ชั้น',
      bin: 'ตะกร้า', ambulance: 'รถ', bag: 'กระเป๋า', zone: 'โซน',
    };
    return MAP[type] || type || '';
  }

  // D12: Fetch breakdown rows from stock_item_locations + v_location_path (Phase 0.7)
  async function _fetchLocationBreakdown(itemId) {
    const sb = getSupabaseClient();

    // Primary: join stock_item_locations with locations
    const { data: silRows, error: silErr } = await sb
      .from('stock_item_locations')
      .select('location_id, qty, last_movement_at, locations(id,code,name,type,parent_id)')
      .eq('item_id', itemId)
      .gt('qty', 0)
      .order('qty', { ascending: false });

    if (silErr || !silRows) return { rows: [], pathMap: {} };

    const locationIds = silRows.map((r) => r.location_id);

    // Fetch breadcrumb paths for these location ids
    let pathMap = {};
    if (locationIds.length > 0) {
      const { data: pathRows } = await sb
        .from('v_location_path')
        .select('id, path_display')
        .in('id', locationIds);
      if (pathRows) {
        pathRows.forEach((p) => { pathMap[p.id] = p.path_display; });
      }
    }

    // Sort: qty DESC already from DB; secondary sort by code ASC client-side
    silRows.sort((a, b) => {
      if (b.qty !== a.qty) return b.qty - a.qty;
      const ca = (a.locations?.code || '');
      const cb = (b.locations?.code || '');
      return ca.localeCompare(cb);
    });

    return { rows: silRows, pathMap };
  }

  // D12: Fetch lots for a lot-tracked item (FEFO display — expiry ASC)
  async function _fetchLotsForItem(itemId) {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from('v_lots_with_remaining')
      .select('id, lot_number, expiry_date, current_qty, days_until_expiry')
      .eq('item_id', itemId)
      .order('expiry_date', { ascending: true, nullsFirst: false });
    if (error || !data) return [];
    return data;
  }

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
    const { item, total_qty } = r.data;
    const low = (item.reorder_threshold || 0) > 0 && total_qty <= item.reorder_threshold;

    // D12: Fetch multi-location breakdown + (if lot-tracked) lots
    const [{ rows: silRows, pathMap }, lots] = await Promise.all([
      _fetchLocationBreakdown(item.id),
      item.tracks_lots ? _fetchLotsForItem(item.id) : Promise.resolve([]),
    ]);

    // D12: Build location breakdown HTML
    let locBreakdownHtml;
    if (silRows.length === 0) {
      locBreakdownHtml = `
        <div class="fc-empty">
          <span class="fc-empty-label text-muted fst-italic small">// ไม่มีสต็อกในระบบ</span>
        </div>`;
    } else {
      const locCount = silRows.length;
      const totalQtySum = silRows.reduce((s, r) => s + (r.qty || 0), 0);

      const rowsHtml = silRows.map((sil) => {
        const loc = sil.locations || {};
        const path = pathMap[sil.location_id]
          || (loc.code ? `${loc.code} · ${loc.name}` : (loc.name || sil.location_id));
        const badge = _locTypeBadge(loc.type);
        const movAt = sil.last_movement_at
          ? new Date(sil.last_movement_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
          : '';

        // D12: lot sub-list for lot-tracked items (all lots shown at item level, FEFO)
        let lotSubHtml = '';
        if (item.tracks_lots && lots.length > 0) {
          const lotItems = lots.map((lot) => {
            const expLabel = lot.expiry_date
              ? new Date(lot.expiry_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
              : 'ไม่มีวันหมดอายุ';
            const urgentClass = (lot.days_until_expiry !== null && lot.days_until_expiry <= 30) ? 'text-danger' : 'text-muted';
            return `<li class="py-0 ${urgentClass}">
              <code class="fc-mono small">${_esc(lot.lot_number)}</code>
              <span class="ms-1 small">${lot.current_qty} ชิ้น</span>
              <span class="ms-1 small">· หมดอายุ ${_esc(expLabel)}</span>
            </li>`;
          }).join('');
          lotSubHtml = `<ul class="list-unstyled ms-3 mb-0 mt-1">${lotItems}</ul>`;
        }

        return `
          <li class="py-2 border-bottom">
            <div class="d-flex align-items-start justify-content-between gap-2">
              <div class="flex-grow-1 min-w-0">
                <span class="fw-bold me-2">${sil.qty}</span>
                <span class="badge bg-secondary text-white small me-1">${_esc(badge)}</span>
                <span class="fc-mono small text-break">${_esc(path)}</span>
                ${movAt ? `<span class="text-muted small ms-2">· ${movAt}</span>` : ''}
              </div>
              <button type="button" class="btn btn-sm btn-outline-primary flex-shrink-0 drawer-loc-transfer"
                      data-location-id="${_esc(sil.location_id)}"
                      title="ย้ายของออกจากตำแหน่งนี้">
                ย้าย →
              </button>
            </div>
            ${lotSubHtml}
          </li>`;
      }).join('');

      locBreakdownHtml = `
        <p class="text-muted small mb-2">รวม <strong>${totalQtySum}</strong> ชิ้น ใน <strong>${locCount}</strong> สถานที่</p>
        <ul class="list-unstyled mb-2">${rowsHtml}</ul>`;
    }

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
          <div class="col-6"><span class="text-muted">เกณฑ์เตือน:</span> ${item.reorder_threshold > 0 ? `≤ ${item.reorder_threshold} ${_esc(item.unit || 'ชิ้น')}` : 'ไม่แจ้ง'}</div>
          <div class="col-6"><span class="text-muted">สถานะ:</span> ${item.active
            ? '<span class="fc-badge fc-badge-ok">ใช้งาน</span>'
            : '<span class="fc-badge fc-badge-neutral">เลิกใช้</span>'}</div>
        </div>

        <!-- D12: Multi-location breakdown (Phase 0.7 — T220, T221) -->
        <h6 class="mt-3">อยู่ที่ไหน</h6>
        <div id="drawer-loc-breakdown">
          ${locBreakdownHtml}
        </div>

        <div class="d-flex justify-content-end fw-bold border-top pt-2 mt-2"
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
        <button type="button" class="btn btn-outline-primary" id="drawer-transfer">
          <i class="bi bi-arrows-move"></i> ย้าย
        </button>
        <button type="button" class="btn btn-outline-secondary" id="drawer-edit">
          <i class="bi bi-pencil"></i> แก้ไข
        </button>
        ${item.active
          ? `<button type="button" class="btn btn-outline-danger" id="drawer-deactivate">ปิดใช้งาน</button>`
          : `<button type="button" class="btn btn-outline-success" id="drawer-reactivate">เปิดใช้งาน</button>`
        }
        ${_isAdmin()
          ? `<button type="button" class="btn btn-danger" id="drawer-delete" title="ลบถาวร — ใช้ได้เฉพาะสินค้าที่ยังไม่มีประวัติ">
               <i class="bi bi-trash"></i> ลบถาวร
             </button>`
          : ''
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
    // Phase 0.7: Transfer button (footer) — calls Transfer.openModal
    const transferBtn = document.getElementById('drawer-transfer');
    if (transferBtn) {
      transferBtn.onclick = () => {
        close();
        if (window.Transfer && typeof window.Transfer.openModal === 'function') {
          window.Transfer.openModal({ itemId: item.id });
        } else {
          _toast('error', 'โมดูล Transfer ยังไม่พร้อม — กรุณารีเฟรชหน้า');
        }
      };
    }
    // D12 (T221): Per-row "ย้าย →" buttons in breakdown — pre-fill source location
    modalEl.querySelectorAll('.drawer-loc-transfer').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sourceId = btn.dataset.locationId;
        close();
        if (window.Transfer && typeof window.Transfer.openModal === 'function') {
          window.Transfer.openModal({ itemId: item.id, prefilledSourceId: sourceId });
        } else {
          _toast('error', 'โมดูล Transfer ยังไม่พร้อม — กรุณารีเฟรชหน้า');
        }
      });
    });
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

    // Hard delete (Admin only) — guarded: only items with zero history.
    const delBtn = document.getElementById('drawer-delete');
    if (delBtn) delBtn.onclick = async () => {
      const counts = await _checkItemDeletable(item.id);
      const blocked = counts.movements > 0 || counts.locations > 0 || counts.lots > 0;
      if (blocked) {
        const parts = [];
        if (counts.movements) parts.push(`ประวัติเคลื่อนไหว ${counts.movements} รายการ`);
        if (counts.locations) parts.push(`สต็อกในตำแหน่ง ${counts.locations} แห่ง`);
        if (counts.lots)      parts.push(`ล็อต ${counts.lots} รายการ`);
        await _confirm(
          `ลบถาวร "${item.name}" ไม่ได้ — สินค้านี้มี ${parts.join(' · ')}. ` +
          `การลบถาวรจะทำลายประวัติ audit ระบบจึงอนุญาตเฉพาะสินค้าที่ยังไม่เคยใช้งาน. ` +
          `กรุณาใช้ปุ่ม "ปิดใช้งาน" แทน`
        );
        return;
      }
      const ok = await _confirm(
        `ลบถาวร "${item.name}" ? สินค้านี้ยังไม่มีประวัติการใช้งาน — ` +
        `ลบได้ แต่การลบถาวรกู้คืนไม่ได้`
      );
      if (!ok) return;
      const sb = getSupabaseClient();
      const { error } = await sb.from('stock_items').delete().eq('id', item.id);
      if (error) {
        // 23503 = FK violation (a movement/lot was created in a race) → fall back to soft-delete advice
        _toast('error', _friendly(error, 'ลบไม่สำเร็จ — อาจมีประวัติเกิดขึ้นใหม่ ลองปิดใช้งานแทน'));
        return;
      }
      _toast('success', `ลบ "${item.name}" ถาวรแล้ว`);
      close();
      reload();
    };
  }

  // Count history references for an item — used to decide if hard-delete is safe.
  async function _checkItemDeletable(itemId) {
    const sb = getSupabaseClient();
    const headCount = (tbl, col) =>
      sb.from(tbl).select(col, { count: 'exact', head: true }).eq('item_id', itemId);
    try {
      const [mv, sil, lots] = await Promise.all([
        headCount('stock_movements', 'id'),
        headCount('stock_item_locations', 'item_id'),
        headCount('stock_lots', 'id'),
      ]);
      return {
        movements: mv.count || 0,
        locations: sil.count || 0,
        lots:      lots.count || 0,
      };
    } catch (_) {
      // On any query failure, be conservative — report as "has history" so delete is blocked.
      return { movements: 1, locations: 0, lots: 0 };
    }
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
  // D13: SKU change confirmation modal (Phase 0.7 — T222, T223)
  // Returns a Promise<boolean> — resolves true if user confirms, false on cancel.
  // =========================================================================
  function _confirmSkuChange(oldSku, newSku) {
    return new Promise((resolve) => {
      const confirmEl = _createModalShell('inv-sku-confirm', '', `
        <div class="modal-header">
          <h5 class="modal-title">
            <i class="bi bi-exclamation-triangle-fill text-warning me-2"></i>ยืนยันการเปลี่ยน SKU?
          </h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
        </div>
        <div class="modal-body">
          <div class="mb-3 small">
            <div><span class="text-muted">เดิม:</span> <code class="fc-mono">${_esc(oldSku)}</code></div>
            <div><span class="text-muted">ใหม่:</span> <code class="fc-mono text-warning">${_esc(newSku)}</code></div>
          </div>
          <p class="small fw-semibold mb-1">ผลกระทบ:</p>
          <ol class="small mb-0">
            <li>QR sticker ที่พิมพ์ไว้ก่อนหน้านี้ ถ้าใช้ SKU เป็น payload จะ scan ไม่ติด (item_id-based QR ยัง OK)</li>
            <li>Audit history (stock_movements) อ้าง item_id ไม่ใช่ SKU — เก็บไว้ครบ ไม่หาย</li>
            <li>SKU ต้องไม่ซ้ำกับ item อื่นในระบบ</li>
          </ol>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="sku-confirm-cancel">ยกเลิก</button>
          <button type="button" class="btn btn-warning" id="sku-confirm-ok">ยืนยันเปลี่ยน</button>
        </div>
      `);
      const confirmModal = new bootstrap.Modal(confirmEl, { backdrop: 'static' });
      confirmEl.querySelector('#sku-confirm-cancel').onclick = () => {
        confirmModal.hide();
        resolve(false);
      };
      confirmEl.querySelector('#sku-confirm-ok').onclick = () => {
        confirmModal.hide();
        resolve(true);
      };
      confirmEl.addEventListener('hidden.bs.modal', () => resolve(false), { once: true });
      confirmModal.show();
    });
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
                     inputmode="latin" autocomplete="off">
              ${isEdit ? `
              <small class="text-warning d-block mt-1" id="if-sku-warn">
                <i class="bi bi-exclamation-triangle-fill"></i>
                การเปลี่ยน SKU จะมีผลต่อ QR ที่พิมพ์แล้ว — ระบบจะถามยืนยันก่อนบันทึก
              </small>` : ''}
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
              <label class="form-label" for="if-threshold">เกณฑ์เตือน (ตั้ง 0 = ปิดแจ้งเตือน)</label>
              <input id="if-threshold" type="number" min="0" step="1" class="form-control" value="0"
                     inputmode="numeric">
              <small class="text-muted">แจ้งเตือน Telegram เมื่อคงเหลือรวม ≤ ค่านี้ (0 = ไม่แจ้ง)</small>
            </div>
          </div>
          <!-- Phase 2: tracks_lots toggle (derived constraint #10) -->
          <div class="form-check form-switch mb-3 mt-3">
            <input class="form-check-input" type="checkbox" id="if-tracks-lots" name="tracks_lots"
                   role="switch">
            <label class="form-check-label" for="if-tracks-lots">
              ติดตามล็อต / วันหมดอายุ
              <small class="d-block text-muted">ใช้สำหรับยาและเวชภัณฑ์ที่ต้องระบุล็อต</small>
            </label>
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
      modalEl.querySelector('#if-name').value       = existing.name || '';
      modalEl.querySelector('#if-sku').value        = existing.sku || '';
      modalEl.querySelector('#if-barcode').value    = existing.barcode || '';
      modalEl.querySelector('#if-category').value   = existing.category_id || '';
      modalEl.querySelector('#if-unit').value       = existing.unit || 'ชิ้น';
      modalEl.querySelector('#if-threshold').value  = existing.reorder_threshold || 0;
      modalEl.querySelector('#if-active').checked   = !!existing.active;
      // Phase 2: tracks_lots toggle
      modalEl.querySelector('#if-tracks-lots').checked = !!existing.tracks_lots;
    }

    // Phase 2: warn when enabling tracks_lots on an item that already has stock (non-blocking)
    modalEl.querySelector('#if-tracks-lots').addEventListener('change', (ev) => {
      if (isEdit && ev.target.checked && existing && (existing.total_qty || 0) > 0) {
        // M-53: non-blocking warning toast
        _toast('warning', 'สินค้านี้มีสต็อกอยู่แล้ว — ล็อตจะต้องถูกระบุในการรับเข้าครั้งถัดไป');
      }
    });

    const errEl    = modalEl.querySelector('#if-error');
    const submitEl = modalEl.querySelector('#if-submit');

    modalEl.querySelector('#inv-item-form').onsubmit = async (ev) => {
      ev.preventDefault();
      errEl.classList.add('d-none'); errEl.textContent = '';

      const name = modalEl.querySelector('#if-name').value.trim();
      const sku  = modalEl.querySelector('#if-sku').value.trim();
      if (!name) { errEl.textContent = 'กรอกชื่อสินค้า'; errEl.classList.remove('d-none'); return; }
      if (!sku)  { errEl.textContent = 'กรอก SKU';      errEl.classList.remove('d-none'); return; }

      // D13 (T222, T223): SKU change confirmation in edit mode
      const skuChanged = isEdit && existing && sku !== (existing.sku || '');
      if (skuChanged) {
        const confirmed = await _confirmSkuChange(existing.sku, sku);
        if (!confirmed) return;
      }

      const payload = {
        name,
        sku,
        barcode:           modalEl.querySelector('#if-barcode').value.trim() || null,
        category_id:       modalEl.querySelector('#if-category').value || null,
        unit:              modalEl.querySelector('#if-unit').value.trim() || 'ชิ้น',
        reorder_threshold: Math.max(0, parseInt(modalEl.querySelector('#if-threshold').value, 10) || 0),
        active:            modalEl.querySelector('#if-active').checked,
        // Phase 2: tracks_lots — defaults to false for new items
        tracks_lots:       !!(modalEl.querySelector('#if-tracks-lots').checked),
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
        // D13 (T223): 23505 on edit with SKU changed → friendly duplicate message
        if (res.error.code === '23505' && skuChanged) {
          errEl.textContent = `SKU '${sku}' มีอยู่แล้วในระบบ — กรุณาใช้ค่าอื่น`;
        } else {
          errEl.textContent = res.error.code === '23505'
            ? 'SKU หรือ Barcode ซ้ำ — เลือกใหม่'
            : _friendly(res.error, 'บันทึกไม่สำเร็จ');
        }
        errEl.classList.remove('d-none');
        return;
      }
      modal.hide();
      _toast('success', isEdit
        ? (skuChanged ? 'เปลี่ยน SKU สำเร็จ' : 'อัปเดตแล้ว')
        : 'เพิ่มสินค้าแล้ว');
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
            <!-- Phase 1.1 B4: movement-type selector (Admin only; hidden for tracks_lots items
                 since those always use raw insert with movement_type='receive'). -->
            <div class="col-12 mb-2" id="rf-move-type-wrap">
              <label class="form-label" for="rf-move-type">ประเภทการรับ</label>
              <select id="rf-move-type" class="form-select" style="min-height:44px;">
                <option value="receive" selected>รับเข้า (receive)</option>
                <option value="adjustment_gain">ปรับยอดเพิ่ม (adjustment_gain)</option>
              </select>
            </div>
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

    // -------------------------------------------------------------------------
    // Phase 2: tracks_lots — show/hide lot section when item selection changes
    // -------------------------------------------------------------------------

    // Lot details section HTML (injected into modal body before rf-error)
    const LOT_SECTION_HTML = `
      <div id="rf-lot-section" class="border rounded p-3 mb-3 bg-light d-none">
        <p class="mb-2 fw-semibold text-stock-accent">
          <i class="bi bi-capsule"></i> ยาชนิดนี้ต้องระบุข้อมูลล็อต
        </p>
        <ul class="nav nav-tabs mb-3" id="rf-lot-tab-toggle" role="tablist">
          <li class="nav-item" role="presentation">
            <button class="nav-link active" type="button" data-lot-tab="new" role="tab">ล็อตใหม่</button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" type="button" data-lot-tab="existing" role="tab">เพิ่มให้ล็อตเดิม</button>
          </li>
        </ul>
        <div id="rf-lot-tab-new">
          <div class="mb-2">
            <label class="form-label" for="rf-lot-number">หมายเลขล็อต <span class="text-danger">*</span></label>
            <input type="text" id="rf-lot-number" class="form-control"
                   placeholder="เช่น LOT-2026-A" autocomplete="off">
          </div>
          <div class="mb-2">
            <label class="form-label" for="rf-lot-expiry">วันหมดอายุ <span class="text-danger">*</span></label>
            <input type="date" id="rf-lot-expiry" class="form-control">
          </div>
          <div class="mb-2">
            <label class="form-label" for="rf-lot-supplier">Supplier / ผู้จัดจำหน่าย</label>
            <input type="text" id="rf-lot-supplier" class="form-control"
                   placeholder="ไม่บังคับ" autocomplete="off">
          </div>
          <div class="mb-0">
            <label class="form-label" for="rf-lot-note">หมายเหตุ</label>
            <input type="text" id="rf-lot-note" class="form-control" placeholder="ไม่บังคับ">
          </div>
        </div>
        <div id="rf-lot-tab-existing" class="d-none">
          <label class="form-label" for="rf-lot-select">เลือกล็อตที่มีอยู่</label>
          <select id="rf-lot-select" class="form-select mb-2">
            <option value="">กำลังโหลด…</option>
          </select>
          <p class="small text-muted mb-0">เลือกล็อตที่มีอยู่เพื่อเพิ่มจำนวนเข้าล็อตเดิม</p>
        </div>
        <div id="rf-lot-inline-error" class="alert alert-danger mt-2 d-none" role="alert" aria-live="polite"></div>
      </div>`;

    // Inject lot section before rf-error
    const rfError = $('rf-error');
    rfError.insertAdjacentHTML('beforebegin', LOT_SECTION_HTML);

    // Track selected item's tracks_lots status and the active lot tab
    let _currentItemTracksLots = prefillItem ? !!prefillItem.tracks_lots : false;
    let _activeLotTab = 'new';   // 'new' | 'existing'

    function _showLotSection(tracksLots) {
      const sec = $('rf-lot-section');
      if (!sec) return;
      sec.classList.toggle('d-none', !tracksLots);
      // Phase 1.1 B4: hide movement-type selector for tracks_lots items —
      // those always insert movement_type='receive' via the raw lot path.
      const moveWrap = $('rf-move-type-wrap');
      if (moveWrap) moveWrap.classList.toggle('d-none', !!tracksLots);
    }

    function _switchLotTab(tab) {
      _activeLotTab = tab;
      modalEl.querySelectorAll('[data-lot-tab]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lotTab === tab);
      });
      $('rf-lot-tab-new')      && $('rf-lot-tab-new').classList.toggle('d-none',      tab !== 'new');
      $('rf-lot-tab-existing') && $('rf-lot-tab-existing').classList.toggle('d-none', tab !== 'existing');
    }

    // Wire lot tab toggle buttons
    modalEl.querySelectorAll('[data-lot-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _switchLotTab(btn.dataset.lotTab);
        if (btn.dataset.lotTab === 'existing') {
          _loadExistingLotOptions($('rf-item').value);
        }
      });
    });

    async function _loadExistingLotOptions(itemId) {
      const sel = $('rf-lot-select');
      if (!sel || !itemId) return;
      sel.innerHTML = '<option value="">กำลังโหลด…</option>';
      if (!window.AppLots) {
        sel.innerHTML = '<option value="">ระบบล็อตยังไม่พร้อม</option>';
        return;
      }
      const { data, error } = await window.AppLots.fetchAllLots(itemId);
      if (error || !data || !data.length) {
        sel.innerHTML = '<option value="">ยังไม่มีล็อต — สร้างล็อตใหม่</option>';
        return;
      }
      sel.innerHTML = '<option value="">— เลือกล็อต —</option>' +
        data.map((lot) => {
          const badge = window.AppLots.getLotBadge(lot);
          return `<option value="${_esc(lot.id)}">${_esc(lot.lot_number)} — หมดอายุ ${window.AppLots.formatThaiDate(lot.expiry_date)} (${badge.label})</option>`;
        }).join('');
    }

    // Phase 6: LINEN receive modal pre-fill (design §3.4)
    // When a LINEN item is selected, pre-fill reason = laundry_in/laundry_out based on movement type.
    function _onReceiveItemLinenPreFill(itemSelectEl) {
      if (!itemSelectEl || !itemSelectEl.value) return;
      // Check items cache for category
      const cached = _items.find((x) => x.id === itemSelectEl.value);
      const isLinen = cached
        ? (_categories.find((c) => c.id === cached.category_id) || {}).code === 'LINEN'
        : false;

      const noteEl     = $('rf-note');
      const moveTypeEl = $('rf-move-type');
      const hintId     = 'rf-linen-reason-hint';
      let hintEl = modalEl.querySelector('#' + hintId);

      if (isLinen && noteEl && moveTypeEl) {
        const t = moveTypeEl.value;
        if (t === 'adjustment_gain') noteEl.value = 'laundry_in';
        else if (t === 'adjustment_loss' || t === 'receive') noteEl.value = 'laundry_out';

        if (!hintEl) {
          hintEl = document.createElement('div');
          hintEl.id = hintId;
          hintEl.className = 'form-text text-info small mt-1';
          hintEl.innerHTML = '<i class="bi bi-info-circle me-1"></i>กรณีรับผ้าคืนจากซักรีด — แก้ไขได้';
          noteEl.after(hintEl);
        }
        hintEl.classList.remove('d-none');
      } else {
        if (hintEl) hintEl.classList.add('d-none');
      }
    }

    // When item changes, detect tracks_lots and show/hide lot section
    async function _onItemChange(itemId) {
      if (!itemId) {
        _currentItemTracksLots = false;
        _showLotSection(false);
        return;
      }
      // Check from _items cache first, then fall back to API
      const cached = _items.find((x) => x.id === itemId);
      if (cached) {
        _currentItemTracksLots = !!cached.tracks_lots;
      } else {
        const r = await window.AppInventory.getItem(itemId);
        _currentItemTracksLots = r.data ? !!r.data.item.tracks_lots : false;
      }
      _showLotSection(_currentItemTracksLots);
      // Ensure AppLots is available if tracks_lots=true
      if (_currentItemTracksLots) await _ensureLotsScripts();
    }

    $('rf-item').addEventListener('change', (ev) => {
      _onItemChange(ev.target.value);
      // Phase 6: LINEN pre-fill reason field in receive modal
      _onReceiveItemLinenPreFill(ev.target);
    });

    // Phase 6: listen for movement-type change to update reason pre-fill
    const rfMoveType = $('rf-move-type');
    if (rfMoveType) rfMoveType.addEventListener('change', () => {
      _onReceiveItemLinenPreFill($('rf-item'));
    });

    if (prefillItem) {
      _showLotSection(!!prefillItem.tracks_lots);
      _currentItemTracksLots = !!prefillItem.tracks_lots;
    }

    // Submit
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

      // -----------------------------------------------------------------------
      // Phase 2: lot validation for tracks_lots items
      // -----------------------------------------------------------------------
      let lotId = null;
      if (_currentItemTracksLots) {
        await _ensureLotsScripts();
        const lotInlineErr = $('rf-lot-inline-error');
        if (lotInlineErr) { lotInlineErr.classList.add('d-none'); lotInlineErr.textContent = ''; }

        if (_activeLotTab === 'new') {
          const lotNumber  = ($('rf-lot-number')  ? $('rf-lot-number').value.trim()  : '');
          const lotExpiry  = ($('rf-lot-expiry')   ? $('rf-lot-expiry').value         : '');
          const lotSupplier= ($('rf-lot-supplier') ? $('rf-lot-supplier').value.trim(): '');
          const lotNote    = ($('rf-lot-note')     ? $('rf-lot-note').value.trim()    : '');

          if (!lotNumber) {
            if (lotInlineErr) { lotInlineErr.textContent = 'กรุณาระบุหมายเลขล็อต'; lotInlineErr.classList.remove('d-none'); }
            errEl.textContent = 'กรุณาระบุหมายเลขล็อต (M-44)';
            errEl.classList.remove('d-none');
            return;
          }
          if (!lotExpiry) {
            if (lotInlineErr) { lotInlineErr.textContent = 'กรุณาระบุวันหมดอายุ'; lotInlineErr.classList.remove('d-none'); }
            errEl.textContent = 'กรุณาระบุวันหมดอายุ';
            errEl.classList.remove('d-none');
            return;
          }
          // Create lot first
          const createRes = await window.AppLots.createLot({
            item_id:      itemId,
            lot_number:   lotNumber,
            expiry_date:  lotExpiry,
            received_qty: qty,
            supplier:     lotSupplier || null,
            note:         lotNote || null,
          });
          if (createRes.error) {
            const isDupe = createRes.error.code === '23505';
            const lotErrMsg = isDupe
              ? 'ล็อตนี้มีอยู่แล้วสำหรับสินค้านี้ — ใช้แท็บ "เพิ่มให้ล็อตเดิม" หรือเปลี่ยนหมายเลขล็อต (M-47)'
              : _friendly(createRes.error, 'สร้างล็อตไม่สำเร็จ');
            if (lotInlineErr) { lotInlineErr.textContent = lotErrMsg; lotInlineErr.classList.remove('d-none'); }
            errEl.textContent = lotErrMsg;
            errEl.classList.remove('d-none');
            return;
          }
          lotId = createRes.data.id;
        } else {
          // 'existing' tab
          lotId = $('rf-lot-select') ? $('rf-lot-select').value : '';
          if (!lotId) {
            errEl.textContent = 'กรุณาเลือกล็อต';
            errEl.classList.remove('d-none');
            return;
          }
        }
      }

      const submitEl = $('rf-submit');
      submitEl.disabled = true;
      submitEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';

      const clientRefId = (crypto.randomUUID ? crypto.randomUUID() : window.AppInventory._uuid());

      // Build raw movement insert (lot_id extension requires raw insert, not the helper)
      let r;
      if (lotId) {
        // Insert movement directly with lot_id (AppInventory.receive doesn't carry lot_id yet)
        const sb = getSupabaseClient();
        const rawRes = await sb.from('stock_movements').insert({
          client_ref_id:  clientRefId,
          item_id:        itemId,
          location_id:    locId,
          movement_type:  'receive',
          qty_delta:      qty,
          lot_id:         lotId,
          note:           note || null,
        }).select().single();
        r = rawRes.error
          ? rawRes
          : { data: { movement: rawRes.data, replay: false, client_ref_id: clientRefId }, error: null };
      } else {
        // Phase 1.1 B4: read movement-type selector (falls back to 'receive' if absent).
        const mvType = ($('rf-move-type') ? $('rf-move-type').value : 'receive') || 'receive';
        r = mvType === 'adjustment_gain'
          ? await window.AppInventory.adjustmentGain(itemId, locId, qty, note, clientRefId)
          : await window.AppInventory.receive(itemId, locId, qty, note, clientRefId);
      }

      submitEl.disabled = false;
      submitEl.textContent = 'บันทึก';

      if (r.error) {
        // Handle idempotent replay
        if (r.error.code === '23505' && /client_ref_id/.test(r.error.message || '')) {
          _toast('info', 'รายการนี้บันทึกแล้ว (M-48)');
          stopScan();
          modal.hide();
          reload();
          return;
        }
        errEl.textContent = _friendly(r.error, 'บันทึกไม่สำเร็จ');
        errEl.classList.remove('d-none');
        return;
      }
      const itemRow = _items.find((x) => x.id === itemId) || { name: '?', unit: 'ชิ้น' };
      const locRow  = _locations.find((x) => x.id === locId) || { code: '?' };

      // Phase 1.1 B4: verb matches the selected movement type.
      const _mvTypeNow = ($('rf-move-type') ? $('rf-move-type').value : 'receive') || 'receive';
      const _verb = _mvTypeNow === 'adjustment_gain' ? 'ปรับยอดเพิ่มแล้ว' : 'รับเข้าแล้ว';

      if (r.data && r.data.replay) {
        _toast('info', 'รายการนี้บันทึกแล้ว (M-48)');
      } else {
        _toast('success', `${_verb}: ${itemRow.name} x${qty} ที่ ${locRow.code}`);
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
    // Phase 2: sub-view activation (used by dashboard drill-down)
    activateSubview: _activateSubview,
    openLotsSubview: (filter) => _activateSubview('lots', { lotsFilter: filter }),
  };

  // admin-shell.js expects window.initInventoryTab — shim wrapper.
  window.initInventoryTab = init;
})();
