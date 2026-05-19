// js/loans.js
// Phase 3 — Admin "อุปกรณ์ยืม-คืน" tab controller.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase3-borrow-return-design.md §7.2
//   docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md §4 (loan list), §5.3
//   docs/superpowers/specs/2026-05-19-phase3-decisions-locked.md Q-Phase3-A, C, D, G
//
// Locked decisions enforced here:
//   Q-Phase3-A — new top-level tab "อุปกรณ์ยืม-คืน" (7th nav tab)
//   Q-Phase3-C — photo is advisory; skip always available
//   Q-Phase3-D — Admin path exposes borrower picker; Staff path auto-fills
//   Q-Phase3-G — due_at default = 3 days; presets 1/3/7/custom
//
// Realtime: subscribes to stock_loans changes via postgres_changes.
//   Pattern mirrors Phase 1.1 _scheduleRealtimeReload (debounced 300ms).
//
// Upstream APIs:
//   window.AppLoans (shared/loans.js)
//   window.AppInventory (shared/inventory.js)
//   window.PhotoCaptureModal (shared/photo-capture.js)
//   window.showToast, window.escapeHtml (shared/ui.js)
//   window.getSupabaseClient() (shared/supabase-client.js)
//
// Public namespace: window.AppLoansTab + window.initLoansTab (called by admin-shell.js)

(function () {
  'use strict';

  // ==========================================================================
  // Module state
  // ==========================================================================

  let _mounted      = false;
  let _loans        = [];
  let _activeFilter = { status: 'active,overdue', search: '', overdueOnly: false };
  let _unsubscribe  = null;
  let _reloadTimer  = null;

  // ==========================================================================
  // Helpers
  // ==========================================================================

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _toast(type, msg) { (window.showToast || (()=>{}))(type, msg); }

  function _statusBadge(status, dueAt) {
    if (status === 'overdue') return '<span class="badge bg-danger">เลยกำหนด</span>';
    if (status === 'returned') return '<span class="badge bg-secondary text-white">คืนแล้ว</span>';
    // active
    return '<span class="fc-badge fc-badge-vital">กำลังยืม</span>';
  }

  function _daysOverdueBadge(dueAt) {
    const days = window.AppLoans.daysOverdue(dueAt);
    if (days <= 0) return '';
    return `<small class="text-danger ms-1">(เลย ${days} วัน)</small>`;
  }

  // ==========================================================================
  // Shell render
  // ==========================================================================

  function _renderShell() {
    const root = document.getElementById('tab-loans');
    if (!root) return;

    root.innerHTML = `
      <!-- Filter bar -->
      <div class="card mb-3">
        <div class="card-body pb-2 pt-3">
          <div class="row g-2 align-items-end">
            <div class="col-12 col-md-4">
              <label class="form-label small text-muted mb-1">สถานะ</label>
              <select id="loans-filter-status" class="form-select" style="min-height:44px;">
                <option value="active,overdue">กำลังยืม + เลยกำหนด</option>
                <option value="active">กำลังยืม</option>
                <option value="overdue">เลยกำหนดเท่านั้น</option>
                <option value="returned">คืนแล้ว</option>
                <option value="all">ทั้งหมด</option>
              </select>
            </div>
            <div class="col-12 col-md-5">
              <label class="form-label small text-muted mb-1">ค้นหา</label>
              <input id="loans-filter-search" type="search" class="form-control"
                     placeholder="ค้นชื่อสินค้า / ผู้ยืม" style="min-height:44px;"
                     autocomplete="off">
            </div>
            <div class="col-12 col-md-3 d-flex align-items-end gap-2">
              <div class="form-check mb-2">
                <input class="form-check-input" type="checkbox" id="loans-filter-overdue-only">
                <label class="form-check-label" for="loans-filter-overdue-only">
                  เฉพาะเลยกำหนด
                </label>
              </div>
              <button type="button" class="btn btn-outline-secondary btn-sm mb-2"
                      id="loans-btn-refresh" title="รีเฟรช"
                      style="min-height:36px;">
                <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Loan list -->
      <div id="loans-list-container">
        <div class="text-center text-muted py-4">
          <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
        </div>
      </div>

      <!-- Loan detail drawer (offcanvas) -->
      <div class="offcanvas offcanvas-end" tabindex="-1" id="loan-detail-drawer"
           aria-labelledby="loan-detail-drawer-label">
        <div class="offcanvas-header">
          <h5 class="offcanvas-title" id="loan-detail-drawer-label">รายละเอียดการยืม</h5>
          <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="ปิด"></button>
        </div>
        <div class="offcanvas-body" id="loan-detail-drawer-body">
          <div class="text-center text-muted py-4">เลือกรายการ</div>
        </div>
      </div>

      <!-- Admin return modal -->
      <div class="modal fade" id="admin-return-modal" tabindex="-1"
           aria-labelledby="admin-return-modal-label">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="admin-return-modal-label">บันทึกคืนอุปกรณ์</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body" id="admin-return-modal-body"></div>
            <div class="modal-footer" id="admin-return-modal-footer"></div>
          </div>
        </div>
      </div>
    `;

    // Wire filters
    document.getElementById('loans-filter-status')?.addEventListener('change', _onFilterChange);
    document.getElementById('loans-filter-search')?.addEventListener('input', _debounceFilter);
    document.getElementById('loans-filter-overdue-only')?.addEventListener('change', _onFilterChange);
    document.getElementById('loans-btn-refresh')?.addEventListener('click', () => _loadLoans());
  }

  // ==========================================================================
  // Load loans
  // ==========================================================================

  async function _loadLoans() {
    const container = document.getElementById('loans-list-container');
    if (!container) return;

    container.innerHTML = `
      <div class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
      </div>`;

    const overdueOnly = _activeFilter.overdueOnly;
    const statusVal   = _activeFilter.status;
    const statuses    = statusVal === 'all' ? undefined : statusVal.split(',');

    const r = await window.AppLoans.listLoans({
      status:      statuses,
      overdueOnly: overdueOnly || undefined,
    });

    if (r.error) {
      container.innerHTML = `
        <div class="alert alert-danger">
          โหลดรายการยืมไม่สำเร็จ — กดรีเฟรช
          <button class="btn btn-sm btn-outline-danger ms-2" onclick="window.AppLoansTab?.reload()">รีเฟรช</button>
        </div>`;
      _toast('error', 'โหลดรายการยืมไม่สำเร็จ — กดรีเฟรช');
      return;
    }

    _loans = r.data || [];

    // Client-side text filter
    const q = _activeFilter.search.toLowerCase().trim();
    const filtered = q
      ? _loans.filter((l) => {
          const name = (l.stock_items?.name || '').toLowerCase();
          const sku  = (l.stock_items?.sku  || '').toLowerCase();
          const who  = (l.borrower_username || '').toLowerCase();
          return name.includes(q) || sku.includes(q) || who.includes(q);
        })
      : _loans;

    _renderLoanList(filtered);
  }

  // ==========================================================================
  // Render loan list
  // ==========================================================================

  function _renderLoanList(loans) {
    const container = document.getElementById('loans-list-container');
    if (!container) return;

    if (!loans.length) {
      container.innerHTML = `
        <div class="text-center text-muted py-5">
          <i class="bi bi-inbox fs-3 d-block mb-2" aria-hidden="true"></i>
          ${_activeFilter.search || _activeFilter.overdueOnly
            ? 'ไม่พบรายการที่ตรงกับตัวกรอง'
            : 'ไม่มีรายการยืม — เมื่อมีการยืมอุปกรณ์ รายการจะแสดงที่นี่'}
        </div>`;
      return;
    }

    const rows = loans.map((loan) => {
      const item     = loan.stock_items || {};
      const loc      = loan.locations   || {};
      const due      = loan.due_at ? window.AppLoans.formatThaiDate(loan.due_at) : '—';
      const borrowed = loan.borrowed_at ? window.AppLoans.formatThaiDate(loan.borrowed_at) : '—';
      const overBadge = loan.status === 'overdue' ? _daysOverdueBadge(loan.due_at) : '';
      const photoBorrowIcon = loan.photo_borrow_url
        ? `<i class="bi bi-image-fill text-success ms-1" title="มีรูปก่อนยืม" aria-label="มีรูปก่อนยืม"></i>`
        : `<i class="bi bi-image text-muted ms-1" title="ไม่มีรูปก่อนยืม" aria-label="ไม่มีรูปก่อนยืม"></i>`;

      return `
        <div class="card mb-2 loan-row" data-loan-id="${_esc(loan.id)}"
             role="button" tabindex="0"
             aria-label="รายละเอียดการยืม ${_esc(item.name || '')} โดย ${_esc(loan.borrower_username)}"
             style="cursor:pointer; min-height:64px;">
          <div class="card-body py-2 px-3">
            <div class="d-flex flex-wrap justify-content-between align-items-start gap-1">
              <div class="flex-grow-1" style="min-width:160px;">
                <div class="fw-semibold">
                  ${_esc(item.name || '—')}
                  <code class="small text-muted">${_esc(item.sku || '')}</code>
                  ${photoBorrowIcon}
                </div>
                <div class="small text-muted">
                  ผู้ยืม: <strong>${_esc(loan.borrower_username || '—')}</strong>
                  · ตำแหน่ง: ${_esc(loc.code || loc.name || '—')}
                  · จำนวน: ${_esc(String(loan.qty || 1))}
                </div>
                <div class="small text-muted">
                  ยืมเมื่อ: ${borrowed}
                  · ครบกำหนด: ${due}${overBadge}
                </div>
              </div>
              <div class="d-flex flex-column align-items-end gap-1">
                ${_statusBadge(loan.status, loan.due_at)}
                ${loan.status !== 'returned'
                  ? `<button type="button" class="btn btn-sm btn-outline-secondary"
                             data-act="admin-return" data-loan-id="${_esc(loan.id)}"
                             style="min-height:36px; min-width:80px;"
                             onclick="event.stopPropagation()">บันทึกคืน</button>`
                  : ''}
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="loan-list">${rows}</div>`;

    // Wire row clicks → detail drawer
    container.querySelectorAll('.loan-row').forEach((row) => {
      const id = row.dataset.loanId;
      row.addEventListener('click', () => _openDetailDrawer(id));
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          _openDetailDrawer(id);
        }
      });
    });

    // Wire admin-return buttons
    container.querySelectorAll('[data-act="admin-return"]').forEach((btn) => {
      btn.addEventListener('click', () => _openAdminReturnModal(btn.dataset.loanId));
    });
  }

  // ==========================================================================
  // Loan detail drawer
  // ==========================================================================

  async function _openDetailDrawer(loanId) {
    const body = document.getElementById('loan-detail-drawer-body');
    if (!body) return;

    body.innerHTML = `<div class="text-center py-4"><span class="spinner-border spinner-border-sm"></span></div>`;

    const drawerEl = document.getElementById('loan-detail-drawer');
    if (drawerEl && typeof bootstrap !== 'undefined') {
      bootstrap.Offcanvas.getOrCreateInstance(drawerEl).show();
    }

    const r = await window.AppLoans.fetchLoan(loanId);
    if (r.error || !r.data) {
      body.innerHTML = `<div class="alert alert-danger small">โหลดรายละเอียดไม่สำเร็จ</div>`;
      return;
    }

    const loan = r.data;
    const item = loan.stock_items || {};
    const loc  = loan.locations   || {};

    const borrowPhotoHtml = loan.photo_borrow_url
      ? `<a href="${_esc(loan.photo_borrow_url)}" target="_blank" rel="noopener">
           <img src="${_esc(loan.photo_borrow_url)}" class="img-thumbnail"
                style="max-width:120px; height:90px; object-fit:cover;"
                alt="รูปก่อนยืม">
         </a>`
      : `<span class="text-muted small">ไม่มีรูปถ่ายก่อนยืม</span>`;

    const returnPhotoHtml = loan.photo_return_url
      ? `<a href="${_esc(loan.photo_return_url)}" target="_blank" rel="noopener">
           <img src="${_esc(loan.photo_return_url)}" class="img-thumbnail"
                style="max-width:120px; height:90px; object-fit:cover;"
                alt="รูปเมื่อคืน">
         </a>`
      : `<span class="text-muted small">ยังไม่มีรูปถ่ายเมื่อคืน</span>`;

    body.innerHTML = `
      <dl class="mb-3">
        <dt class="small text-muted">สินค้า</dt>
        <dd>${_esc(item.name || '—')} <code class="small">${_esc(item.sku || '')}</code></dd>
        <dt class="small text-muted">ผู้ยืม</dt>
        <dd>${_esc(loan.borrower_username || '—')}</dd>
        <dt class="small text-muted">ตำแหน่งเดิม</dt>
        <dd>${_esc(loc.code || loc.name || '—')}</dd>
        <dt class="small text-muted">จำนวน</dt>
        <dd>${_esc(String(loan.qty || 1))} ชิ้น</dd>
        <dt class="small text-muted">ยืมเมื่อ</dt>
        <dd>${loan.borrowed_at ? window.AppLoans.formatThaiDate(loan.borrowed_at) : '—'}</dd>
        <dt class="small text-muted">ครบกำหนด</dt>
        <dd>${loan.due_at ? window.AppLoans.formatThaiDate(loan.due_at) : '—'}
            ${loan.status === 'overdue' ? _daysOverdueBadge(loan.due_at) : ''}</dd>
        <dt class="small text-muted">สถานะ</dt>
        <dd>${_statusBadge(loan.status, loan.due_at)}</dd>
        ${loan.returned_at
          ? `<dt class="small text-muted">คืนเมื่อ</dt>
             <dd>${window.AppLoans.formatThaiDate(loan.returned_at)}</dd>` : ''}
        ${loan.notes ? `<dt class="small text-muted">หมายเหตุ</dt><dd>${_esc(loan.notes)}</dd>` : ''}
      </dl>
      <hr>
      <div class="mb-3">
        <div class="small text-muted mb-1">รูปถ่ายก่อนยืม</div>
        ${borrowPhotoHtml}
      </div>
      <div class="mb-3">
        <div class="small text-muted mb-1">รูปถ่ายเมื่อคืน</div>
        ${returnPhotoHtml}
      </div>
      ${loan.status !== 'returned'
        ? `<button type="button" class="btn btn-stock-primary w-100 mt-2"
                   id="drawer-btn-admin-return" style="min-height:48px;">
             บันทึกคืน
           </button>`
        : ''}
    `;

    document.getElementById('drawer-btn-admin-return')?.addEventListener('click', () => {
      _openAdminReturnModal(loanId);
    });
  }

  // ==========================================================================
  // Admin return modal
  // ==========================================================================

  function _openAdminReturnModal(loanId) {
    const modalBody   = document.getElementById('admin-return-modal-body');
    const modalFooter = document.getElementById('admin-return-modal-footer');
    if (!modalBody || !modalFooter) return;

    const loan = _loans.find((l) => l.id === loanId);
    const item = loan?.stock_items || {};

    modalBody.innerHTML = `
      <p class="mb-2">
        บันทึกคืน <strong>${_esc(item.name || '—')}</strong>
        โดย <strong>${_esc(loan?.borrower_username || '—')}</strong>
      </p>
      <div id="admin-return-photo-preview" class="mb-2"></div>
      <div class="mb-3">
        <label class="form-label small">หมายเหตุ (ไม่บังคับ)</label>
        <textarea id="admin-return-note" class="form-control" rows="2"
                  placeholder="หมายเหตุ (ไม่บังคับ)"
                  style="min-height:60px;"></textarea>
      </div>
    `;

    modalFooter.innerHTML = `
      <button type="button" class="btn btn-outline-secondary" id="admin-return-btn-photo"
              style="min-height:44px;">
        <i class="bi bi-camera me-1" aria-hidden="true"></i>ถ่ายรูปเมื่อคืน (ไม่บังคับ)
      </button>
      <button type="button" class="btn btn-stock-primary" id="admin-return-btn-confirm"
              style="min-height:48px;">ยืนยันการคืน</button>
      <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal"
              style="min-height:44px;">ยกเลิก</button>
    `;

    let _returnPhotoUrl = null;

    document.getElementById('admin-return-btn-photo')?.addEventListener('click', () => {
      if (!window.PhotoCaptureModal) return;
      window.PhotoCaptureModal.open({
        folder:   'thegood-stock/borrow/' + loanId + '/return',
        label:    'ถ่ายรูปอุปกรณ์เมื่อคืน',
        optional: true,
        entityId: loanId,
        onUploaded: (url) => {
          _returnPhotoUrl = url;
          const preview = document.getElementById('admin-return-photo-preview');
          if (preview) {
            preview.innerHTML = `
              <img src="${_esc(url)}" class="img-thumbnail"
                   style="max-width:100px; height:75px; object-fit:cover;"
                   alt="รูปเมื่อคืน">`;
          }
        },
        onSkipped: () => {},
        onError:   (msg) => _toast('warning', 'อัปโหลดรูปไม่สำเร็จ — ยังดำเนินการต่อได้'),
      });
    });

    document.getElementById('admin-return-btn-confirm')?.addEventListener('click', async () => {
      const btn  = document.getElementById('admin-return-btn-confirm');
      const note = (document.getElementById('admin-return-note')?.value || '').trim();

      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก…'; }

      const loan = _loans.find((l) => l.id === loanId);
      if (!loan) { _toast('error', 'ไม่พบรายการยืม'); if (btn) { btn.disabled = false; btn.textContent = 'ยืนยันการคืน'; } return; }

      const loc = loan.locations || {};
      const r = await window.AppLoans.createReturn({
        itemId:           loan.stock_items?.id || loan.item_id,
        locationId:       loc.id || loan.location_id_from,
        qty:              loan.qty,
        borrowerUsername: loan.borrower_username,
        note:             note || null,
      });

      if (r.error) {
        const msg = window.AppLoans.mapTriggerErrorToToast(r.error);
        _toast('error', msg);
        if (btn) { btn.disabled = false; btn.textContent = 'ยืนยันการคืน'; }
        return;
      }

      // PATCH photo if captured
      if (_returnPhotoUrl && r.data?.id) {
        // Find loan by movement_id_return
        const loanRes = await window.AppLoans.fetchLoanByBorrowMovement(loan.movement_id_borrow);
        if (loanRes.data?.id) {
          await window.AppLoans.patchLoanPhoto(loanRes.data.id, 'return', _returnPhotoUrl);
        }
      }

      // Close modal
      const modalEl = document.getElementById('admin-return-modal');
      if (modalEl && typeof bootstrap !== 'undefined') {
        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      }

      _toast('success', 'บันทึกการคืนสำเร็จ');
      _loadLoans();
    });

    const modalEl = document.getElementById('admin-return-modal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  }

  // ==========================================================================
  // Filter handlers
  // ==========================================================================

  let _filterDebounce = null;

  function _debounceFilter() {
    if (_filterDebounce) clearTimeout(_filterDebounce);
    _filterDebounce = setTimeout(_onFilterChange, 300);
  }

  function _onFilterChange() {
    _activeFilter.status      = document.getElementById('loans-filter-status')?.value || 'active,overdue';
    _activeFilter.search      = document.getElementById('loans-filter-search')?.value || '';
    _activeFilter.overdueOnly = document.getElementById('loans-filter-overdue-only')?.checked || false;
    _loadLoans();
  }

  /**
   * Pre-apply a status filter and activate this tab (called from dashboard.js borrow panel).
   * @param {'active'|'overdue'|'returned_today'|string} statusFilter
   */
  function setFilter(statusFilter) {
    _activeFilter.overdueOnly = false;
    _activeFilter.search      = '';
    if (statusFilter === 'overdue') {
      _activeFilter.status      = 'overdue';
      _activeFilter.overdueOnly = true;
    } else if (statusFilter === 'returned_today') {
      _activeFilter.status = 'returned';
    } else {
      _activeFilter.status = statusFilter || 'active,overdue';
    }

    const statusEl   = document.getElementById('loans-filter-status');
    const overdueEl  = document.getElementById('loans-filter-overdue-only');
    const searchEl   = document.getElementById('loans-filter-search');
    if (statusEl)  statusEl.value   = _activeFilter.status;
    if (overdueEl) overdueEl.checked = _activeFilter.overdueOnly;
    if (searchEl)  searchEl.value   = '';

    _loadLoans();
  }

  // ==========================================================================
  // Realtime (Phase 3 pattern mirrors Phase 1.1 _scheduleRealtimeReload)
  // ==========================================================================

  function _scheduleRealtimeReload() {
    if (_reloadTimer) return;
    _reloadTimer = setTimeout(() => {
      _reloadTimer = null;
      _loadLoans();
    }, 300);
  }

  function _subscribeRealtime() {
    if (_unsubscribe) return;
    try {
      const sb = window.getSupabaseClient();
      const channel = sb
        .channel('realtime:loans:phase3')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'stock_loans' },
          () => _scheduleRealtimeReload()
        )
        .subscribe();
      _unsubscribe = () => { try { sb.removeChannel(channel); } catch {} };
    } catch (e) {
      console.warn('[loans] realtime subscribe failed', e);
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async function init() {
    if (_mounted) return;
    _mounted = true;

    _renderShell();
    await _loadLoans();
    _subscribeRealtime();

    window.addEventListener('beforeunload', teardown);
  }

  function teardown() {
    if (_unsubscribe) { try { _unsubscribe(); } catch {} _unsubscribe = null; }
    if (_reloadTimer) { clearTimeout(_reloadTimer); _reloadTimer = null; }
    _mounted = false;
  }

  function reload() { _loadLoans(); }

  // ==========================================================================
  // Public namespace
  // ==========================================================================
  window.AppLoansTab = { init, teardown, reload, setFilter };
  window.initLoansTab = init;

})();
