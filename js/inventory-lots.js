// js/inventory-lots.js
// Phase 2 — Admin "ล็อตยา" sub-view (4th segment in Inventory tab).
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md   Q-D1 (no force-issue), Q-D3 (badge colors)
//   docs/superpowers/plans/2026-05-19-phase2-medication-plan.md    Task B3
//   docs/superpowers/designs/2026-05-18-phase2-ui-design.md        §3.1, §3.6, §5.1, §5.3, §6.7
//
// Locked decisions:
//   Q-D1: NO force-issue override button anywhere in this file.
//         Lot detail expand shows info only — no [บังคับเบิก-จ่าย] button.
//   Q-D3: Badge colors per UX §3.1.3 (delegated to AppLots.getLotBadge).
//
// Entry point: window.initLotsView(containerEl)
// Called by js/inventory.js when the "ล็อตยา" segment is clicked.
//
// Upstream APIs consumed:
//   window.AppLots   — shared/lots.js
//   window.showToast — shared/ui.js
//   window.getUserUsername / getUserName — shared/auth.js (may be null for role check)

(function () {
  'use strict';

  // =========================================================================
  // Module-level state (per mount — re-init on each tab switch)
  // =========================================================================

  let _allLots          = [];   // last fetched rows
  let _filteredLots     = [];   // after client-side filter
  let _unsubscribeLots  = null; // realtime teardown
  let _container        = null; // DOM container passed to initLotsView

  // Active filter state
  const _filters = { window: 'all', status: 'all', search: '' };

  // =========================================================================
  // Helpers
  // =========================================================================

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _toast(type, msg) { (window.showToast || (()=>{}))(type, msg); }

  function _getUsername() {
    try { return window.getUserUsername?.() || window.getUserName?.() || 'Admin'; }
    catch { return 'Admin'; }
  }

  // =========================================================================
  // Load lots from API
  // =========================================================================

  async function _loadLots() {
    if (!window.AppLots) {
      _toast('error', 'ระบบล็อตยังไม่พร้อม — รีเฟรชหน้าใหม่');
      return;
    }

    _renderLoadingState();

    const { data, error } = await window.AppLots.fetchAllLotsForAdmin({
      status: _filters.status !== 'all' ? _filters.status : undefined,
    });

    if (error) {
      _renderErrorState(error);
      return;
    }

    _allLots = data || [];
    _applyFiltersAndRender();
  }

  // =========================================================================
  // Client-side filtering
  // =========================================================================

  function _applyFiltersAndRender() {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    let rows = [..._allLots];

    // Status filter (already partially applied server-side, but reapply for consistency)
    if (_filters.status && _filters.status !== 'all') {
      rows = rows.filter((r) => r.status === _filters.status);
    }

    // Expiry window filter
    if (_filters.window && _filters.window !== 'all') {
      rows = rows.filter((lot) => {
        const bucket = window.AppLots.getExpiryBucket(lot);
        if (_filters.window === 'overdue')  return bucket === 'overdue';
        if (_filters.window === '30')       return bucket === 'within30';
        if (_filters.window === '60')       return bucket === 'within60';
        if (_filters.window === '90')       return bucket === 'within90';
        return true;
      });
    }

    // Free-text search (item name, SKU, lot_number)
    if (_filters.search) {
      const q = _filters.search.toLowerCase();
      rows = rows.filter((lot) => {
        const item  = lot.stock_items || {};
        return (
          (lot.lot_number  || '').toLowerCase().includes(q) ||
          (item.name       || '').toLowerCase().includes(q) ||
          (item.sku        || '').toLowerCase().includes(q)
        );
      });
    }

    _filteredLots = rows;
    _renderList();
  }

  // =========================================================================
  // Render — loading / error / list
  // =========================================================================

  function _renderLoadingState() {
    const tbody = _container && _container.querySelector('#lots-tbody');
    if (tbody) {
      tbody.innerHTML = `
        <tr><td colspan="5" class="text-center text-muted py-4">
          <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลดล็อตยา…
        </td></tr>`;
    }
  }

  function _renderErrorState(error) {
    const tbody = _container && _container.querySelector('#lots-tbody');
    if (!tbody) return;
    const msg = (error && error.message) ? _esc(error.message) : 'โหลดข้อมูลไม่สำเร็จ';
    tbody.innerHTML = `
      <tr><td colspan="5" class="text-center text-danger py-4">
        <p class="mb-2">${msg}</p>
        <button type="button" class="btn btn-sm btn-outline-danger" id="lots-retry">ลองใหม่</button>
      </td></tr>`;
    const retryBtn = tbody.querySelector('#lots-retry');
    if (retryBtn) retryBtn.addEventListener('click', _loadLots);
  }

  function _renderList() {
    const tbody = _container && _container.querySelector('#lots-tbody');
    if (!tbody) return;

    if (!_allLots.length) {
      // No lots in system at all (M-23/M-24/M-25 per UX §6.7)
      tbody.innerHTML = `
        <tr><td colspan="5" class="text-center text-muted py-5">
          <div style="font-size:2rem;margin-bottom:0.5rem;">📦</div>
          <p class="mb-1 fw-semibold">ยังไม่มีล็อตยาในระบบ</p>
          <p class="small mb-0">รับเข้าล็อตแรกได้ที่แท็บ รับเข้า</p>
        </td></tr>`;
      return;
    }

    if (!_filteredLots.length) {
      // Filter produced zero results (M-26/M-27)
      tbody.innerHTML = `
        <tr><td colspan="5" class="text-center text-muted py-4">
          <p class="mb-2">ไม่มีล็อตที่ตรงกับตัวกรองที่เลือก</p>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="lots-clear-filter">
            ล้างตัวกรอง
          </button>
        </td></tr>`;
      const clearBtn = tbody.querySelector('#lots-clear-filter');
      if (clearBtn) clearBtn.addEventListener('click', _clearFilters);
      return;
    }

    tbody.innerHTML = _filteredLots.map((lot) => {
      const badge    = window.AppLots.getLotBadge(lot);
      const item     = lot.stock_items || {};
      const unit     = item.unit || 'ชิ้น';
      const isBlocked = lot.status === 'expired' || lot.status === 'recalled';
      const canRecall = lot.status === 'active' || lot.status === 'expired';

      return `
        <tr data-lot-id="${_esc(lot.id)}">
          <td>
            <div class="fw-semibold">${_esc(item.name || '—')}</div>
            <div class="small text-muted"><code>${_esc(item.sku || '—')}</code></div>
            <div class="small text-muted mt-1">ล็อต: <strong>${_esc(lot.lot_number)}</strong></div>
          </td>
          <td>
            <span class="badge ${badge.badgeClass} lot-expiry-badge">
              ${_esc(badge.label)}
            </span>
            <div class="small text-muted mt-1">${window.AppLots.formatThaiDate(lot.expiry_date)}</div>
            ${badge.daysLeft !== null && badge.daysLeft >= 0 && lot.status === 'active'
              ? `<div class="small text-muted">(${badge.daysLeft} วัน)</div>`
              : ''}
          </td>
          <td class="text-end">
            <span class="${lot.current_qty === 0 ? 'text-muted' : ''}">${lot.current_qty}</span>
            <span class="text-muted small"> ${_esc(unit)}</span>
          </td>
          <td>
            <div class="d-flex flex-wrap gap-1">
              ${canRecall
                ? `<button type="button" class="btn btn-sm btn-outline-danger lot-recall-btn"
                           data-lot-id="${_esc(lot.id)}"
                           style="min-height:36px;min-width:44px;">
                     เรียกคืน
                   </button>`
                : ''}
              <button type="button" class="btn btn-sm btn-outline-secondary lot-detail-btn"
                      data-lot-id="${_esc(lot.id)}"
                      style="min-height:36px;min-width:44px;">
                ดูรายละเอียด
              </button>
            </div>
          </td>
        </tr>
        <tr class="lot-detail-row d-none" id="lot-detail-${_esc(lot.id)}">
          <td colspan="5">
            <div class="card card-body bg-light small py-2 mb-2">
              <div class="row g-2">
                <div class="col-sm-4"><span class="text-muted">Supplier:</span> ${_esc(lot.supplier || '—')}</div>
                <div class="col-sm-4"><span class="text-muted">รับเข้าวันที่:</span>
                  ${lot.created_at ? new Date(lot.created_at).toLocaleDateString('th-TH') : '—'}
                </div>
                <div class="col-sm-4"><span class="text-muted">รับเข้าจำนวน:</span> ${lot.received_qty} ${_esc(unit)}</div>
                <div class="col-sm-4"><span class="text-muted">บันทึกโดย:</span> ${_esc(lot.created_by || '—')}</div>
                ${lot.note ? `<div class="col-12"><span class="text-muted">หมายเหตุ:</span> ${_esc(lot.note)}</div>` : ''}
                ${lot.status === 'recalled' ? `
                  <div class="col-12 text-danger">
                    <strong>เรียกคืนโดย:</strong> ${_esc(lot.recalled_by || '—')}<br>
                    <strong>เหตุผล:</strong> ${_esc(lot.recalled_reason || '—')}<br>
                    <strong>วันที่เรียกคืน:</strong>
                    ${lot.recalled_at ? new Date(lot.recalled_at).toLocaleDateString('th-TH') : '—'}
                  </div>` : ''}
              </div>
              <!-- Q-D1: NO force-issue override button here. Expired/recalled lots are permanently blocked. -->
            </div>
          </td>
        </tr>`;
    }).join('');

    // Wire recall buttons
    tbody.querySelectorAll('.lot-recall-btn').forEach((btn) => {
      btn.addEventListener('click', () => _openRecallModal(btn.dataset.lotId));
    });

    // Wire detail expand buttons
    tbody.querySelectorAll('.lot-detail-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const detailRow = tbody.querySelector(`#lot-detail-${btn.dataset.lotId}`);
        if (detailRow) {
          const isOpen = !detailRow.classList.contains('d-none');
          detailRow.classList.toggle('d-none', isOpen);
          btn.textContent = isOpen ? 'ดูรายละเอียด' : 'ซ่อน';
        }
      });
    });
  }

  // =========================================================================
  // Recall modal (UX §3.6 / §5.3)
  // Custom modal — needs a reason text field (cannot use generic showConfirm).
  // =========================================================================

  function _openRecallModal(lotId) {
    const lot = _allLots.find((l) => l.id === lotId);
    if (!lot) return;

    // Remove any prior recall modal
    const old = document.getElementById('lot-recall-modal');
    if (old) old.remove();

    const item = lot.stock_items || {};
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal fade" id="lot-recall-modal" tabindex="-1" aria-labelledby="recall-modal-title">
        <div class="modal-dialog modal-dialog-centered modal-fullscreen-sm-down">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title text-danger" id="recall-modal-title">
                <i class="bi bi-exclamation-octagon"></i> เรียกคืนล็อตยา
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body">
              <p class="mb-1"><strong>${_esc(item.name || '—')}</strong></p>
              <p class="text-muted small mb-2">ล็อต: ${_esc(lot.lot_number)}  ·  หมดอายุ: ${window.AppLots.formatThaiDate(lot.expiry_date)}</p>
              <div class="mb-3">
                <label class="form-label" for="recall-reason">เหตุผลการเรียกคืน <span class="text-danger">*</span></label>
                <textarea id="recall-reason" class="form-control" rows="3"
                          placeholder="ระบุเหตุผล เช่น ผู้ผลิตแจ้งเรียกคืน, พบปัญหาคุณภาพ…"
                          required aria-required="true"></textarea>
                <div id="recall-reason-error" class="invalid-feedback">กรุณาระบุเหตุผล (M-85)</div>
              </div>
              <div id="recall-api-error" class="alert alert-danger d-none" role="alert" aria-live="polite"></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
              <button type="button" class="btn btn-danger" id="recall-confirm-btn" style="min-height:44px;">
                ยืนยัน เรียกคืน
              </button>
            </div>
          </div>
        </div>
      </div>`;
    const modalEl = wrap.firstElementChild;
    document.body.appendChild(modalEl);

    const modal    = new bootstrap.Modal(modalEl);
    const reasonEl = modalEl.querySelector('#recall-reason');
    const errorEl  = modalEl.querySelector('#recall-api-error');
    const confirmBtn = modalEl.querySelector('#recall-confirm-btn');

    confirmBtn.addEventListener('click', async () => {
      const reason = reasonEl.value.trim();
      if (!reason) {
        reasonEl.classList.add('is-invalid');
        return;
      }
      reasonEl.classList.remove('is-invalid');
      errorEl.classList.add('d-none');
      errorEl.textContent = '';

      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';

      const { error } = await window.AppLots.recallLot(lotId, reason);

      confirmBtn.disabled = false;
      confirmBtn.innerHTML = 'ยืนยัน เรียกคืน';

      if (error) {
        errorEl.textContent = (error.message || 'บันทึกไม่สำเร็จ');
        errorEl.classList.remove('d-none');
        return;
      }

      // M-88: success toast
      _toast('success', `เรียกคืนล็อต ${_esc(lot.lot_number)} แล้ว`);
      modal.hide();

      // rpc_recall_lot also removed the lot's stock (posts adjustment_loss
      // movements) — full reload so current_qty and totals reflect it.
      _loadLots();
    });

    modalEl.addEventListener('hidden.bs.modal', () => {
      try { modalEl.remove(); } catch { /* ignore */ }
    });

    modal.show();
    setTimeout(() => { try { reasonEl.focus(); } catch {} }, 300);
  }

  // =========================================================================
  // Filter helpers
  // =========================================================================

  function _clearFilters() {
    _filters.window = 'all';
    _filters.status = 'all';
    _filters.search = '';

    if (_container) {
      const winSel    = _container.querySelector('#lots-filter-window');
      const statusSel = _container.querySelector('#lots-filter-status');
      const searchEl  = _container.querySelector('#lots-search');
      if (winSel)    winSel.value    = 'all';
      if (statusSel) statusSel.value = 'all';
      if (searchEl)  searchEl.value  = '';
    }

    _applyFiltersAndRender();
  }

  // =========================================================================
  // Shell render (called once by initLotsView)
  // =========================================================================

  function _renderShell() {
    if (!_container) return;
    _container.innerHTML = `
      <!-- Filter bar (UX §3.1.4) -->
      <div class="row g-2 mb-3">
        <div class="col-12 col-sm-4">
          <select id="lots-filter-window" class="form-select" aria-label="กรองช่วงหมดอายุ"
                  style="min-height:44px;">
            <option value="all">ช่วงหมดอายุ: ทั้งหมด</option>
            <option value="overdue">เกินกำหนดแล้ว</option>
            <option value="30">ภายใน 30 วัน</option>
            <option value="60">ภายใน 60 วัน</option>
            <option value="90">ภายใน 90 วัน</option>
          </select>
        </div>
        <div class="col-12 col-sm-4">
          <select id="lots-filter-status" class="form-select" aria-label="กรองสถานะล็อต"
                  style="min-height:44px;">
            <option value="all">สถานะ: ทุกสถานะ</option>
            <option value="active">ใช้งานอยู่</option>
            <option value="expired">หมดอายุแล้ว</option>
            <option value="recalled">ถูกเรียกคืน</option>
            <option value="depleted">ใช้หมดแล้ว</option>
          </select>
        </div>
        <div class="col-12 col-sm-4">
          <input id="lots-search" type="search" class="form-control"
                 placeholder="ค้นชื่อยา / SKU / ล็อต" autocomplete="off"
                 style="min-height:44px;">
        </div>
      </div>

      <!-- Lot list table (UX §3.1.1 / §3.1.2) -->
      <div class="card">
        <div class="card-body p-0 lot-list-table-wrapper">
          <table class="table table-striped table-hover align-middle mb-0">
            <thead class="position-sticky top-0 bg-white" style="z-index:1;">
              <tr>
                <th scope="col">ยา / ล็อต</th>
                <th scope="col">วันหมดอายุ</th>
                <th scope="col" class="text-end">คงเหลือ</th>
                <th scope="col">จัดการ</th>
              </tr>
            </thead>
            <tbody id="lots-tbody">
              <tr><td colspan="5" class="text-center text-muted py-4">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </td></tr>
            </tbody>
          </table>
        </div>
      </div>`;

    // Wire filter controls
    const winSel    = _container.querySelector('#lots-filter-window');
    const statusSel = _container.querySelector('#lots-filter-status');
    const searchEl  = _container.querySelector('#lots-search');

    winSel.addEventListener('change', (ev) => {
      _filters.window = ev.target.value;
      _applyFiltersAndRender();
    });

    statusSel.addEventListener('change', async (ev) => {
      _filters.status = ev.target.value;
      // Re-fetch from server (status filter is partially server-side)
      await _loadLots();
    });

    let searchTimer = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        _filters.search = searchEl.value.trim();
        _applyFiltersAndRender();
      }, 200);
    });
  }

  // =========================================================================
  // Pre-set filter from external caller (e.g. dashboard drill-down)
  // =========================================================================

  function _applyPresetFilter(filterWindow) {
    if (!filterWindow || filterWindow === 'all') return;
    _filters.window = filterWindow;
    if (_container) {
      const winSel = _container.querySelector('#lots-filter-window');
      if (winSel) winSel.value = filterWindow;
    }
  }

  // =========================================================================
  // Realtime update handler
  // =========================================================================

  function _handleRealtimeUpdate(table, payload) {
    if (table !== 'stock_lots') return;
    const updatedId = payload?.new?.id || payload?.old?.id;
    if (!updatedId) { _loadLots(); return; }

    // Update the affected lot in-place
    const idx = _allLots.findIndex((l) => l.id === updatedId);
    if (payload.eventType === 'INSERT') {
      // New lot — do a full reload so we get the joined item data
      _loadLots();
      return;
    }
    if (payload.eventType === 'DELETE') {
      if (idx >= 0) _allLots.splice(idx, 1);
    } else if (payload.eventType === 'UPDATE' && idx >= 0) {
      // Merge new fields (keep stock_items join)
      const existing = _allLots[idx];
      _allLots[idx] = { ...existing, ...payload.new };
    } else {
      _loadLots();
      return;
    }
    _applyFiltersAndRender();
  }

  // =========================================================================
  // Public entry point — called by js/inventory.js when "ล็อตยา" tab is clicked
  // =========================================================================

  /**
   * @param {HTMLElement} containerEl
   * @param {object}      [opts]
   * @param {string}      [opts.presetFilter]  pre-set expiry window filter ('all'|'overdue'|'30'|'60'|'90')
   */
  async function initLotsView(containerEl, opts) {
    // Teardown any previous subscription (tab may be re-opened)
    if (_unsubscribeLots) {
      try { _unsubscribeLots(); } catch { /* ignore */ }
      _unsubscribeLots = null;
    }

    _container  = containerEl;
    _allLots    = [];
    _filteredLots = [];
    Object.assign(_filters, { window: 'all', status: 'all', search: '' });

    _renderShell();

    if (opts && opts.presetFilter) {
      _applyPresetFilter(opts.presetFilter);
    }

    await _loadLots();

    // Realtime subscription for live status updates (cron auto-expire / other-session recall)
    if (window.AppLots && window.AppLots.subscribeStockLots) {
      _unsubscribeLots = window.AppLots.subscribeStockLots(_handleRealtimeUpdate);
    }
  }

  // =========================================================================
  // Public namespace
  // =========================================================================

  window.AppLotsView = {
    initLotsView,
    reload: _loadLots,
  };

  // Flat shim used by js/inventory.js
  window.initLotsView = initLotsView;

})();
