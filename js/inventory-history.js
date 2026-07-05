// js/inventory-history.js
// "ประวัติ" sub-tab under คลัง — a filterable log of stock_movements.
//
// Data: AppInventory.listRecentMovements({ movementType, locationId,
//       dateFrom, dateTo, limit }). Server-side filters except the free-text
//       item search, which is applied client-side over the loaded page.
//
// Public: window.initInventoryHistory()  (called by warehouse-shell.js)
// Renders into #tab-history.

(function () {
  'use strict';

  const PAGE = 50;   // rows per "load more" step

  // Movement-type display (mirrors notify_stock_movement_to_tg vocab).
  const TYPES = [
    { v: 'receive',         emoji: '📥', label: 'รับเข้า' },
    { v: 'issue',           emoji: '📤', label: 'เบิก' },
    { v: 'adjustment_gain', emoji: '➕', label: 'ปรับยอดเพิ่ม' },
    { v: 'adjustment_loss', emoji: '➖', label: 'ของหาย/ปรับลด' },
    { v: 'borrow',          emoji: '🤝', label: 'ยืม' },
    { v: 'return',          emoji: '↩️', label: 'คืน' },
    { v: 'transfer_out',    emoji: '→',  label: 'ย้ายออก' },
    { v: 'transfer_in',     emoji: '←',  label: 'ย้ายเข้า' },
  ];
  const TYPE_MAP = Object.fromEntries(TYPES.map((t) => [t.v, t]));

  let _mounted    = false;
  let _limit      = PAGE;
  let _rows       = [];     // last fetched page (pre client-search)
  const _filters  = { movementType: '', locationId: '', dateFrom: '', dateTo: '', search: '' };
  let _locations  = [];

  // ประวัติกระเป๋า (bag_moves) — second view on this page.
  let _view       = 'stock';   // 'stock' | 'bags'
  let _bagLimit   = PAGE;
  let _bagRows    = [];

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function _sb() {
    if (typeof window.getSupabaseClient === 'function') return window.getSupabaseClient();
    throw new Error('[history] getSupabaseClient() not found');
  }

  function _fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('th-TH', {
      day: 'numeric', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function _typeCell(mt) {
    const t = TYPE_MAP[mt];
    return t ? `${t.emoji} ${_esc(t.label)}` : _esc(mt);
  }

  function _qtyCell(delta) {
    const n = Number(delta) || 0;
    const cls = n > 0 ? 'text-success' : (n < 0 ? 'text-danger' : 'text-muted');
    const sign = n > 0 ? '+' : '';
    return `<span class="${cls} fw-semibold">${sign}${n}</span>`;
  }

  function _locName(loc) {
    if (!loc) return '?';
    const nm = (loc.name || '').trim();
    return _esc(nm || loc.code || '?');
  }

  // -------------------------------------------------------------------------

  async function _loadLocations() {
    if (_locations.length) return;
    try {
      const { data } = await _sb()
        .from('locations')
        .select('id,name,code,type')
        .eq('active', true)
        .order('name');
      _locations = data || [];
    } catch { _locations = []; }
  }

  async function _fetch() {
    const tbody = document.getElementById('hist-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…</td></tr>`;
    }
    const { data, error } = await window.AppInventory.listRecentMovements({
      movementType: _filters.movementType || undefined,
      locationId:   _filters.locationId   || undefined,
      dateFrom:     _filters.dateFrom      || undefined,
      dateTo:       _filters.dateTo        || undefined,
      limit:        _limit,
    });
    if (error) {
      _rows = [];
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-4">
        โหลดประวัติไม่สำเร็จ</td></tr>`;
      return;
    }
    _rows = data || [];
    _renderRows();
  }

  function _renderRows() {
    const tbody = document.getElementById('hist-tbody');
    if (!tbody) return;

    const term = _filters.search.trim().toLowerCase();
    const rows = term
      ? _rows.filter((r) => {
          const it = r.stock_items || {};
          return (it.sku || '').toLowerCase().includes(term)
              || (it.name || '').toLowerCase().includes(term);
        })
      : _rows;

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">
        ไม่พบรายการ${term ? 'ที่ตรงกับคำค้น' : ''}</td></tr>`;
      _updateCount(0);
      return;
    }

    tbody.innerHTML = rows.map((r) => {
      const it  = r.stock_items || {};
      const sku = _esc(it.sku || '');
      const nm  = _esc(it.name || '');
      const reason = (r.reason || '').trim();
      return `
        <tr>
          <td class="small text-muted text-nowrap">${_esc(_fmtTime(r.performed_at))}</td>
          <td class="small text-nowrap">${_typeCell(r.movement_type)}</td>
          <td class="small"><code>${sku}</code>${nm ? ` <span class="text-muted">${nm}</span>` : ''}</td>
          <td class="text-end small">${_qtyCell(r.qty_delta)}</td>
          <td class="small d-none d-md-table-cell">${_locName(r.locations)}</td>
          <td class="small d-none d-sm-table-cell">${_esc(r.performed_by || '')}</td>
          <td class="small d-none d-lg-table-cell text-muted">${_esc(reason)}</td>
        </tr>`;
    }).join('');

    _updateCount(rows.length);
  }

  function _updateCount(shown) {
    const el = document.getElementById('hist-count');
    if (el) el.textContent = `แสดง ${shown} รายการ`;
    // Show "load more" only when the server page is full (more may exist).
    const more = document.getElementById('hist-load-more');
    if (more) more.classList.toggle('d-none', _rows.length < _limit);
  }

  // -------------------------------------------------------------------------
  // ประวัติกระเป๋า — bag_moves log (deploy/return, migration 20260705010000)
  // -------------------------------------------------------------------------

  async function _fetchBags() {
    const tbody = document.getElementById('hist-bags-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…</td></tr>`;
    }
    let r;
    try {
      // Three FKs point at locations — disambiguate each embed by FK column.
      r = await _sb().from('bag_moves')
        .select(`id, action, moved_by, moved_at,
                 bag:locations!bag_location_id(id,code,name),
                 from_loc:locations!from_parent_id(id,code,name),
                 to_loc:locations!to_parent_id(id,code,name)`)
        .order('moved_at', { ascending: false })
        .limit(_bagLimit);
    } catch (e) { r = { data: null, error: e }; }

    if (r.error || !r.data) {
      _bagRows = [];
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">
        โหลดประวัติกระเป๋าไม่สำเร็จ</td></tr>`;
      return;
    }
    _bagRows = r.data;
    _renderBagRows();
  }

  function _renderBagRows() {
    const tbody = document.getElementById('hist-bags-tbody');
    if (!tbody) return;

    if (!_bagRows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">
        ยังไม่มีประวัติกระเป๋าขึ้นรถ/คืน</td></tr>`;
      _updateBagCount(0);
      return;
    }

    tbody.innerHTML = _bagRows.map((r) => {
      const isDeploy = r.action === 'deploy';
      const actHtml  = isDeploy
        ? '🚑 <span class="fw-semibold">ขึ้นรถ</span>'
        : '↩️ คืนเข้าที่เก็บ';
      const bag = r.bag || {};
      return `
        <tr>
          <td class="small text-muted text-nowrap">${_esc(_fmtTime(r.moved_at))}</td>
          <td class="small text-nowrap">${actHtml}</td>
          <td class="small"><code>${_esc(bag.code || '')}</code>
            ${bag.name ? ` <span class="text-muted">${_esc(bag.name)}</span>` : ''}</td>
          <td class="small d-none d-md-table-cell">
            ${_locName(r.from_loc)} <i class="bi bi-arrow-right mx-1 text-muted"></i> ${_locName(r.to_loc)}</td>
          <td class="small">${_esc(r.moved_by || '')}</td>
        </tr>`;
    }).join('');

    _updateBagCount(_bagRows.length);
  }

  function _updateBagCount(shown) {
    const el = document.getElementById('hist-count');
    if (el) el.textContent = `แสดง ${shown} รายการ`;
    const more = document.getElementById('hist-bags-load-more');
    if (more) more.classList.toggle('d-none', _bagRows.length < _bagLimit);
  }

  // -------------------------------------------------------------------------

  function _render(root) {
    const typeOpts = TYPES.map((t) =>
      `<option value="${t.v}">${t.emoji} ${_esc(t.label)}</option>`).join('');
    const locOpts = _locations.map((l) =>
      `<option value="${_esc(l.id)}">${_esc((l.name || l.code || '').trim())}</option>`).join('');

    root.innerHTML = `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-clock-history me-2"></i>ประวัติการเคลื่อนไหว</h5>
        <div class="btn-group btn-group-sm" role="group" aria-label="เลือกมุมมองประวัติ">
          <button type="button" id="hist-view-stock" class="btn btn-stock-primary">
            <i class="bi bi-box-seam me-1"></i>สต็อก</button>
          <button type="button" id="hist-view-bags" class="btn btn-outline-secondary">
            <i class="bi bi-bag-heart me-1"></i>กระเป๋า</button>
        </div>
        <span id="hist-count" class="small text-muted"></span>
      </div>

      <div id="hist-bags-view" class="d-none">
        <div class="card">
          <div class="table-responsive">
            <table class="table table-sm table-hover mb-0 align-middle">
              <thead class="table-light">
                <tr>
                  <th scope="col">เวลา</th>
                  <th scope="col">การกระทำ</th>
                  <th scope="col">กระเป๋า</th>
                  <th scope="col" class="d-none d-md-table-cell">จาก → ไป</th>
                  <th scope="col">ผู้ทำ</th>
                </tr>
              </thead>
              <tbody id="hist-bags-tbody">
                <tr><td colspan="5" class="text-center text-muted py-4">
                  <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="text-center mt-3">
          <button type="button" id="hist-bags-load-more" class="btn btn-outline-secondary btn-sm d-none">
            โหลดเพิ่ม
          </button>
        </div>
      </div>

      <div id="hist-stock-view">
      <div class="card mb-3">
        <div class="card-body py-3">
          <div class="row g-2">
            <div class="col-6 col-md-3">
              <label class="form-label small mb-1">ชนิด</label>
              <select id="hist-type" class="form-select form-select-sm">
                <option value="">ทั้งหมด</option>${typeOpts}
              </select>
            </div>
            <div class="col-6 col-md-3">
              <label class="form-label small mb-1">สถานที่</label>
              <select id="hist-loc" class="form-select form-select-sm">
                <option value="">ทั้งหมด</option>${locOpts}
              </select>
            </div>
            <div class="col-6 col-md-2">
              <label class="form-label small mb-1">ตั้งแต่</label>
              <input id="hist-from" type="date" class="form-control form-control-sm">
            </div>
            <div class="col-6 col-md-2">
              <label class="form-label small mb-1">ถึง</label>
              <input id="hist-to" type="date" class="form-control form-control-sm">
            </div>
            <div class="col-12 col-md-2">
              <label class="form-label small mb-1">ค้นหาสินค้า</label>
              <input id="hist-search" type="search" class="form-control form-control-sm"
                     placeholder="SKU / ชื่อ" autocomplete="off">
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="table-responsive">
          <table class="table table-sm table-hover mb-0 align-middle">
            <thead class="table-light">
              <tr>
                <th scope="col">เวลา</th>
                <th scope="col">ชนิด</th>
                <th scope="col">สินค้า</th>
                <th scope="col" class="text-end">จำนวน</th>
                <th scope="col" class="d-none d-md-table-cell">สถานที่</th>
                <th scope="col" class="d-none d-sm-table-cell">ผู้ทำ</th>
                <th scope="col" class="d-none d-lg-table-cell">เหตุผล</th>
              </tr>
            </thead>
            <tbody id="hist-tbody">
              <tr><td colspan="7" class="text-center text-muted py-4">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="text-center mt-3">
        <button type="button" id="hist-load-more" class="btn btn-outline-secondary btn-sm d-none">
          โหลดเพิ่ม
        </button>
      </div>
      </div><!-- /#hist-stock-view -->
    `;

    // View switch: สต็อก (stock_movements) ↔ กระเป๋า (bag_moves)
    const _applyView = () => {
      const isBags = _view === 'bags';
      document.getElementById('hist-stock-view')?.classList.toggle('d-none', isBags);
      document.getElementById('hist-bags-view')?.classList.toggle('d-none', !isBags);
      const bStock = document.getElementById('hist-view-stock');
      const bBags  = document.getElementById('hist-view-bags');
      bStock?.classList.toggle('btn-stock-primary', !isBags);
      bStock?.classList.toggle('btn-outline-secondary', isBags);
      bBags?.classList.toggle('btn-stock-primary', isBags);
      bBags?.classList.toggle('btn-outline-secondary', !isBags);
    };
    document.getElementById('hist-view-stock').addEventListener('click', () => {
      _view = 'stock'; _applyView(); _renderRows();
    });
    document.getElementById('hist-view-bags').addEventListener('click', () => {
      _view = 'bags'; _applyView(); _fetchBags();
    });
    document.getElementById('hist-bags-load-more').addEventListener('click', () => {
      _bagLimit += PAGE; _fetchBags();
    });

    // Wire filters — server-side ones re-query, search is client-side.
    let _searchTimer = null;
    document.getElementById('hist-type').addEventListener('change', (e) => {
      _filters.movementType = e.target.value; _limit = PAGE; _fetch();
    });
    document.getElementById('hist-loc').addEventListener('change', (e) => {
      _filters.locationId = e.target.value; _limit = PAGE; _fetch();
    });
    document.getElementById('hist-from').addEventListener('change', (e) => {
      _filters.dateFrom = e.target.value; _limit = PAGE; _fetch();
    });
    document.getElementById('hist-to').addEventListener('change', (e) => {
      _filters.dateTo = e.target.value; _limit = PAGE; _fetch();
    });
    document.getElementById('hist-search').addEventListener('input', (e) => {
      _filters.search = e.target.value;
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(_renderRows, 200);
    });
    document.getElementById('hist-load-more').addEventListener('click', () => {
      _limit += PAGE; _fetch();
    });
  }

  // -------------------------------------------------------------------------

  window.initInventoryHistory = async function () {
    const root = document.getElementById('tab-history');
    if (!root) return;
    if (_mounted) { _fetch(); return; }   // re-entry: just refresh
    _mounted = true;
    await _loadLocations();
    _render(root);
    await _fetch();
  };
})();
