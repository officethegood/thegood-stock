// js/oxygen.js
// Phase 5 — Admin "ถังออกซิเจน" tab.
// Sections: tank list + filter bar, add-tank modal, tank detail/history drawer,
// log-transition modal.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md §5–§8
//   docs/superpowers/designs/2026-05-19-phase5-oxygen-ui-design.md §3.1–§3.4
//   docs/superpowers/plans/2026-05-19-phase5-oxygen-plan.md Task B2
//
// Decisions:
//   Q-Phase5-1: tank sizes 0.5Q/1.5Q/4.5Q/6Q (per Layout-Stock-2026-O2)
//   Q-Phase5-3: maintenance reason = free text in note field
//   Q-Phase5-4: photo optional, uses window.PhotoCaptureModal.open() from shared/photo-capture.js (Phase 3)
//   Q-Phase5-5: NO purchase_price / acquired_at
//   Q-O1: admin nav overflow uses flex-wrap to 2nd row at 360px
//
// Dependencies:
//   shared/oxygen.js       → window.AppOxygen
//   shared/ui.js           → window.showToast, window.escapeHtml
//   shared/auth.js         → window.getUserRole, window.getUserName
//   shared/supabase-client.js → window.getSupabaseClient
//   shared/photo-capture.js → window.PhotoCaptureModal (Phase 3)
//
// Public namespace: window.AppOxygenTab + window.initOxygenTab

(function () {
  'use strict';

  let _mounted       = false;
  let _unsubscribe   = null;
  let _filterStatus  = '';
  let _filterSearch  = '';
  let _locations     = [];
  let _currentTankId = null;   // drawer: which tank is open

  // =========================================================================
  // Helpers
  // =========================================================================

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _toast(type, msg) { (window.showToast || (()=>{}))(type, msg); }

  function _isAdmin() { return window.getUserRole?.() === 'Admin'; }

  function _fmtDate(val) {
    if (!val) return '—';
    try { return new Date(val).toLocaleDateString('th-TH'); } catch { return String(val); }
  }

  function _fmtDateTime(val) {
    if (!val) return '—';
    try { return new Date(val).toLocaleString('th-TH'); } catch { return String(val); }
  }

  function _statusBadge(status) {
    const cls   = window.AppOxygen.STATUS_BADGE_CLASS[status] || 'badge bg-secondary';
    const label = window.AppOxygen.STATUS_LABELS[status] || status;
    return `<span class="${_esc(cls)}">${_esc(label)}</span>`;
  }

  function _sizeBadge(size) {
    const label = window.AppOxygen.SIZE_LABELS[size] || size;
    return `<span class="badge bg-light text-dark border">${_esc(label)}</span>`;
  }

  function _inspectionWarning(dateStr) {
    if (!dateStr) return '';
    const days = Math.floor((new Date(dateStr) - new Date()) / 86400000);
    if (days < 0)   return ' <span class="badge bg-danger ms-1">เกินกำหนด</span>';
    if (days <= 30) return ' <span class="badge bg-danger ms-1">ตรวจด่วน</span>';
    if (days <= 90) return ' <span class="badge bg-warning text-dark ms-1">ใกล้ถึงกำหนด</span>';
    return '';
  }

  // =========================================================================
  // D14: populate a <select> from lookup_lists
  // Uses window.LookupLists.fetchByKind when available, falls back to direct query.
  // Graceful fallback: if table missing keeps existing placeholder option.
  // currentValue that is no longer active is appended with "(ปิดใช้งาน)".
  // =========================================================================
  // Hardcoded defaults — used when lookup_lists is empty/missing.
  const _LOOKUP_FALLBACK = {
    tank_size: [
      { code: '0.5Q', name: '0.5Q' },
      { code: '1.5Q', name: '1.5Q' },
      { code: '4.5Q', name: '4.5Q' },
      { code: '6Q',   name: '6Q'   },
    ],
  };

  async function _fillLookupSelect(selectEl, kind, currentValue) {
    let rows = [];
    try {
      if (window.LookupLists?.fetchByKind) {
        const r = await window.LookupLists.fetchByKind(kind);
        rows = (r && r.data) || [];
      } else {
        const r = await window.getSupabaseClient()
          .from('lookup_lists')
          .select('code,name,sort_order,active')
          .eq('kind', kind)
          .eq('active', true)
          .order('sort_order');
        rows = r.data || [];
      }
    } catch (e) {
      console.warn('[D14] lookup_lists fetch failed for kind=' + kind + ' — using fallback', e);
      rows = [];
    }
    if (!rows.length) rows = _LOOKUP_FALLBACK[kind] || [];
    if (!rows.length) return;

    const placeholder = selectEl.options[0];
    selectEl.innerHTML = '';
    if (placeholder) selectEl.appendChild(placeholder);

    const codes = new Set(rows.map((r) => r.code));
    rows.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.code;
      opt.textContent = r.name;
      selectEl.appendChild(opt);
    });

    if (currentValue && !codes.has(currentValue)) {
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.textContent = currentValue + ' (ปิดใช้งาน)';
      selectEl.appendChild(opt);
    }

    if (currentValue) selectEl.value = currentValue;
  }

  // =========================================================================
  // Load locations (needed by add-tank and log-transition modals)
  // =========================================================================

  async function _loadLocations() {
    try {
      const sb = window.getSupabaseClient();
      const { data } = await sb.from('locations').select('id, name, code, type')
        .eq('active', true).order('type').order('name');
      _locations = data || [];
    } catch { _locations = []; }
  }

  function _locationOptions(selectedId) {
    return _locations.map((loc) => `
      <option value="${_esc(loc.id)}" ${loc.id === selectedId ? 'selected' : ''}>
        ${_esc(loc.name)} (${_esc(loc.code)})
      </option>
    `).join('');
  }

  // =========================================================================
  // Shell render
  // =========================================================================

  function _renderShell() {
    const root = document.getElementById('tab-oxygen');
    if (!root) return;

    root.innerHTML = `
      <!-- Filter toolbar -->
      <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
        <select id="oxy-filter-status" class="form-select form-select-sm" style="max-width:160px;"
                aria-label="กรองตามสถานะ">
          <option value="">ทุกสถานะ</option>
          ${Object.entries(window.AppOxygen.STATUS_LABELS).map(([v, l]) =>
            `<option value="${_esc(v)}">${_esc(l)}</option>`
          ).join('')}
        </select>
        <input id="oxy-filter-search" type="search" class="form-control form-control-sm"
               placeholder="ค้นหาหมายเลขถัง" style="max-width:220px;"
               aria-label="ค้นหาหมายเลขถัง">
        <div class="ms-auto">
          ${_isAdmin() ? `
            <button type="button" id="oxy-btn-add" class="btn btn-sm btn-stock-primary"
                    style="min-height:36px;">
              <i class="bi bi-plus-lg me-1"></i>+ เพิ่มถัง
            </button>
          ` : ''}
        </div>
      </div>

      <!-- Tank list -->
      <div id="oxy-list-wrap">
        <div class="text-center text-muted py-4">
          <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
        </div>
      </div>

      <!-- Add tank modal -->
      <div class="modal fade" id="oxy-add-modal" tabindex="-1"
           aria-labelledby="oxy-add-modal-label">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="oxy-add-modal-label">เพิ่มถังออกซิเจน</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body">
              <div id="oxy-add-error" class="alert alert-danger d-none" role="alert"></div>
              <div class="mb-3">
                <label class="form-label" for="oxy-add-serial">หมายเลขถัง (Serial) <span class="text-danger">*</span></label>
                <input type="text" id="oxy-add-serial" class="form-control"
                       placeholder="เช่น OXY-0001" required autocomplete="off">
              </div>
              <!-- D14: options populated at runtime from lookup_lists (kind='tank_size') -->
              <div class="mb-3">
                <label class="form-label" for="oxy-add-size">ขนาดถัง <span class="text-danger">*</span></label>
                <select id="oxy-add-size" class="form-select" required>
                  <option value="">— เลือกขนาด —</option>
                </select>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-add-location">สถานที่จัดเก็บ <span class="text-danger">*</span></label>
                <select id="oxy-add-location" class="form-select" required>
                  <option value="">— เลือกสถานที่ —</option>
                  ${_locationOptions('')}
                </select>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-add-pressure">ค่าแรงดันล่าสุด (PSI)</label>
                <input type="number" id="oxy-add-pressure" class="form-control"
                       min="1" placeholder="เช่น 2000" autocomplete="off">
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-add-inspection">วันครบกำหนดทดสอบถัง (ครั้งถัดไป)</label>
                <input type="date" id="oxy-add-inspection" class="form-control">
                <div class="form-text">วันครบกำหนดส่งทดสอบสภาพ/แรงดันถังครั้งถัดไป — เว้นว่างได้</div>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-add-notes">หมายเหตุ</label>
                <textarea id="oxy-add-notes" class="form-control" rows="2" maxlength="500"></textarea>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">ยกเลิก</button>
              <button type="button" id="oxy-add-save" class="btn btn-stock-primary" style="min-height:40px;">
                บันทึก
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Edit tank modal (Admin only) -->
      <div class="modal fade" id="oxy-edit-modal" tabindex="-1"
           aria-labelledby="oxy-edit-modal-label">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="oxy-edit-modal-label">แก้ไขข้อมูลถัง</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body">
              <div id="oxy-edit-error" class="alert alert-danger d-none" role="alert"></div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-serial">หมายเลขถัง (Serial)</label>
                <input type="text" id="oxy-edit-serial" class="form-control" readonly disabled>
                <div class="form-text">หมายเลขถังแก้ไขไม่ได้</div>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-size">ขนาดถัง <span class="text-danger">*</span></label>
                <select id="oxy-edit-size" class="form-select" required>
                  <option value="">— เลือกขนาด —</option>
                </select>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-pressure">ค่าแรงดันล่าสุด (PSI)</label>
                <input type="number" id="oxy-edit-pressure" class="form-control"
                       min="1" placeholder="เช่น 2000" autocomplete="off">
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-inspection">วันครบกำหนดทดสอบถัง (ครั้งถัดไป)</label>
                <input type="date" id="oxy-edit-inspection" class="form-control">
                <div class="form-text">วันครบกำหนดส่งทดสอบสภาพ/แรงดันถังครั้งถัดไป — เว้นว่างได้</div>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-notes">หมายเหตุ</label>
                <textarea id="oxy-edit-notes" class="form-control" rows="2" maxlength="500"></textarea>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">ยกเลิก</button>
              <button type="button" id="oxy-edit-save" class="btn btn-stock-primary"
                      style="min-height:40px;">บันทึก</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tank detail / history drawer (offcanvas) -->
      <div class="offcanvas offcanvas-end" tabindex="-1" id="oxy-detail-drawer"
           aria-labelledby="oxy-detail-label"
           style="width: min(100vw, 520px);">
        <div class="offcanvas-header border-bottom">
          <h5 class="offcanvas-title" id="oxy-detail-label">รายละเอียดถัง</h5>
          <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="ปิด"></button>
        </div>
        <div class="offcanvas-body p-0" id="oxy-detail-body">
          <div class="text-center text-muted py-5">
            <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
          </div>
        </div>
        ${_isAdmin() ? `
          <div class="p-3 border-top d-grid gap-2">
            <button type="button" id="oxy-btn-edit" class="btn btn-outline-secondary"
                    style="min-height:44px;">
              <i class="bi bi-pencil-square me-1"></i>แก้ไขข้อมูลถัง
            </button>
            <button type="button" id="oxy-btn-transition" class="btn btn-stock-primary"
                    style="min-height:44px;">
              <i class="bi bi-arrow-repeat me-1"></i>เปลี่ยนสถานะ
            </button>
          </div>
        ` : ''}
      </div>

      <!-- Log transition modal (Admin only) -->
      <div class="modal fade" id="oxy-transition-modal" tabindex="-1"
           aria-labelledby="oxy-transition-label">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="oxy-transition-label">เปลี่ยนสถานะถัง</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body" id="oxy-transition-body">
              <div class="text-center text-muted py-3">กำลังโหลด…</div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">ยกเลิก</button>
              <button type="button" id="oxy-transition-save" class="btn btn-stock-primary d-none"
                      style="min-height:40px;">
                ยืนยัน
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire filter events
    document.getElementById('oxy-filter-status')?.addEventListener('change', (e) => {
      _filterStatus = e.target.value;
      _loadList();
    });
    let _searchTimer = null;
    document.getElementById('oxy-filter-search')?.addEventListener('input', (e) => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        _filterSearch = e.target.value.trim();
        _loadList();
      }, 300);
    });

    // Wire add-tank button
    if (_isAdmin()) {
      document.getElementById('oxy-btn-add')?.addEventListener('click', _openAddModal);
    }
  }

  // =========================================================================
  // Tank list
  // =========================================================================

  async function _loadList() {
    const wrap = document.getElementById('oxy-list-wrap');
    if (!wrap) return;

    const r = await window.AppOxygen.listTanks({
      status: _filterStatus || undefined,
      search: _filterSearch || undefined,
    });
    if (r.error) {
      wrap.innerHTML = `<div class="alert alert-danger">${_esc(r.error.message)}</div>`;
      return;
    }
    const tanks = r.data || [];
    if (!tanks.length) {
      wrap.innerHTML = `
        <div class="text-center text-muted py-5">
          <i class="bi bi-cylinder text-muted" style="font-size:2.5rem; opacity:.3;"></i>
          <div class="mt-2">ไม่พบถัง${_filterStatus || _filterSearch ? 'ที่ตรงเงื่อนไข' : 'ในระบบ'}</div>
          ${_isAdmin() && !_filterStatus && !_filterSearch
            ? '<div class="small">เพิ่มถังแรกด้วยปุ่ม "+ เพิ่มถัง"</div>' : ''}
        </div>
      `;
      return;
    }

    wrap.innerHTML = `
      <div class="table-responsive">
        <table class="table table-hover table-sm align-middle" id="oxy-table">
          <thead class="table-light">
            <tr>
              <th>หมายเลขถัง</th>
              <th>ขนาด</th>
              <th>สถานะ</th>
              <th>สถานที่</th>
              <th>เติมล่าสุด</th>
              <th>ตรวจสอบ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${tanks.map((t) => `
              <tr data-tank-id="${_esc(t.id)}"
                  class="oxy-tank-row ${t.status === 'retired' ? 'text-muted' : ''}"
                  style="cursor:pointer;"
                  aria-label="ถัง ${_esc(t.serial)}">
                <td><code>${_esc(t.serial)}</code></td>
                <td>${_sizeBadge(t.tank_size)}</td>
                <td>${_statusBadge(t.status)}</td>
                <td class="small">${_esc(t.locations?.name || '—')}</td>
                <td class="small">${_fmtDate(t.last_refill_at)}</td>
                <td class="small">
                  ${_esc(_fmtDate(t.next_inspection_due))}
                  ${_inspectionWarning(t.next_inspection_due)}
                </td>
                <td>
                  <button class="btn btn-sm btn-link text-stock-accent oxy-print-btn"
                          data-serial="${_esc(t.serial)}"
                          data-tank-size="${_esc(t.tank_size)}"
                          data-loc-code="${_esc(t.locations?.code || '')}"
                          aria-label="บันทึก QR ${_esc(t.serial)}" title="บันทึก QR เป็น PNG"
                          style="min-width:44px;min-height:44px;">🖨️</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="text-muted small px-1">${tanks.length} ถัง</div>
    `;

    // Wire row clicks → detail drawer
    wrap.querySelectorAll('.oxy-tank-row').forEach((row) => {
      row.addEventListener('click', () => _openDetailDrawer(row.dataset.tankId));
    });

    // Row-level print buttons — stop propagation so the row click does not fire.
    wrap.querySelectorAll('.oxy-print-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const serial  = btn.dataset.serial;
        const size    = btn.dataset.tankSize;
        const locCode = btn.dataset.locCode;
        if (window.QRPrint) {
          window.QRPrint.single(serial, {
            size:       '50x50',
            label:      serial,
            subtitle:   size + (locCode ? ' • ' + locCode : ''),
            entityType: 'tank',
          });
        } else {
          alert('โมดูล QR ยังไม่โหลด — รีเฟรชหน้าใหม่');
        }
      });
    });
  }

  /**
   * Update a single row in the tank list table after a realtime event.
   * Falls back to full reload if row not in DOM.
   */
  async function _updateListRow(tankId) {
    const row = document.querySelector(`[data-tank-id="${tankId}"]`);
    if (!row) { _loadList(); return; }
    const { data: t } = await window.AppOxygen.getTankBySerial('');
    // Re-fetch this specific tank by id
    const sb = window.getSupabaseClient();
    const { data: tank } = await sb.from('oxygen_tanks')
      .select(`id, serial, tank_size, status, last_refill_at, next_inspection_due,
               locations ( id, name, code )`)
      .eq('id', tankId).maybeSingle();
    if (!tank) return;

    row.className = `oxy-tank-row ${tank.status === 'retired' ? 'text-muted' : ''}`;
    const cells = row.querySelectorAll('td');
    if (cells.length >= 6) {
      cells[0].innerHTML = `<code>${_esc(tank.serial)}</code>`;
      cells[1].innerHTML = _sizeBadge(tank.tank_size);
      cells[2].innerHTML = _statusBadge(tank.status);
      cells[3].textContent = tank.locations?.name || '—';
      cells[4].textContent = _fmtDate(tank.last_refill_at);
      cells[5].innerHTML = `${_esc(_fmtDate(tank.next_inspection_due))}${_inspectionWarning(tank.next_inspection_due)}`;
    }
  }

  // =========================================================================
  // Add-tank modal (Admin only)
  // =========================================================================

  function _openAddModal() {
    // Refresh location options in case locations changed
    const locSelect = document.getElementById('oxy-add-location');
    if (locSelect) {
      locSelect.innerHTML = `<option value="">— เลือกสถานที่ —</option>${_locationOptions('')}`;
    }
    const errEl = document.getElementById('oxy-add-error');
    if (errEl) { errEl.classList.add('d-none'); errEl.textContent = ''; }
    ['oxy-add-serial','oxy-add-size','oxy-add-location','oxy-add-inspection','oxy-add-notes','oxy-add-pressure']
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });

    const modalEl = document.getElementById('oxy-add-modal');
    if (!modalEl) return;
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    // Wire save button (re-wire each time to avoid duplicate listeners)
    const saveBtn = document.getElementById('oxy-add-save');
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener('click', _saveNewTank);
  }

  async function _saveNewTank() {
    const serial    = document.getElementById('oxy-add-serial')?.value.trim();
    const size      = document.getElementById('oxy-add-size')?.value;
    const locationId = document.getElementById('oxy-add-location')?.value;
    const inspection = document.getElementById('oxy-add-inspection')?.value || null;
    const notes     = document.getElementById('oxy-add-notes')?.value.trim() || null;
    const pressureRaw = document.getElementById('oxy-add-pressure')?.value;
    const errEl     = document.getElementById('oxy-add-error');

    function _showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('d-none'); }
    }

    if (!serial) { _showErr('กรุณาระบุหมายเลขถัง'); return; }
    if (!size)   { _showErr('กรุณาเลือกขนาดถัง'); return; }
    if (!locationId) { _showErr('กรุณาเลือกสถานที่จัดเก็บ'); return; }
    const pressure = pressureRaw ? parseInt(pressureRaw, 10) : null;
    if (pressure !== null && (!Number.isFinite(pressure) || pressure <= 0)) {
      _showErr('ค่าแรงดันต้องเป็นตัวเลขมากกว่า 0'); return;
    }
    if (errEl) errEl.classList.add('d-none');

    const saveBtn = document.getElementById('oxy-add-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'กำลังบันทึก…'; }

    try {
      const sb = window.getSupabaseClient();

      // 1. Insert oxygen_tanks row
      const { data: tankData, error: tankErr } = await sb.from('oxygen_tanks').insert({
        serial,
        tank_size:           size,
        current_location_id: locationId,
        next_inspection_due: inspection,
        last_pressure_psi:   pressure,
        notes,
      }).select().single();

      if (tankErr) {
        const msg = window.AppOxygen._mapError
          ? (window.AppOxygen._mapError(tankErr) || tankErr.message)
          : tankErr.message;
        const friendly = msg.includes('unique') || msg.includes('23505')
          ? 'หมายเลขถังนี้มีอยู่แล้ว'
          : msg;
        _showErr(friendly);
        return;
      }

      // 2. Insert initial movement (NULL → ready)
      const { error: moveErr } = await window.AppOxygen.logTransition({
        tankId:      tankData.id,
        fromStatus:  null,
        toStatus:    'ready',
        toLocationId: locationId,
        note:        'เพิ่มถังใหม่เข้าระบบ',
        photoUrl:    null,
      });
      if (moveErr) {
        _showErr(moveErr.message || 'บันทึกสถานะเริ่มต้นไม่สำเร็จ');
        return;
      }

      // Success
      bootstrap.Modal.getOrCreateInstance(document.getElementById('oxy-add-modal')).hide();
      _toast('success', 'เพิ่มถังแล้ว');
      _loadList();

    } catch (e) {
      _showErr(e.message || 'บันทึกไม่สำเร็จ');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'บันทึก'; }
    }
  }

  // =========================================================================
  // Edit-tank modal (Admin only)
  // =========================================================================

  async function _openEditModal(tankId) {
    const sb = window.getSupabaseClient();
    const { data: tank, error } = await sb.from('oxygen_tanks')
      .select('id, serial, tank_size, last_pressure_psi, next_inspection_due, notes')
      .eq('id', tankId).maybeSingle();
    if (error || !tank) { _toast('error', 'โหลดข้อมูลถังไม่สำเร็จ'); return; }

    document.getElementById('oxy-edit-serial').value     = tank.serial || '';
    document.getElementById('oxy-edit-pressure').value   = tank.last_pressure_psi ?? '';
    document.getElementById('oxy-edit-inspection').value = tank.next_inspection_due || '';
    document.getElementById('oxy-edit-notes').value      = tank.notes || '';

    const sizeEl = document.getElementById('oxy-edit-size');
    if (sizeEl) await _fillLookupSelect(sizeEl, 'tank_size', tank.tank_size);

    const errEl = document.getElementById('oxy-edit-error');
    if (errEl) { errEl.classList.add('d-none'); errEl.textContent = ''; }

    const modalEl = document.getElementById('oxy-edit-modal');
    if (!modalEl) return;
    bootstrap.Modal.getOrCreateInstance(modalEl).show();

    // Re-wire save button each open to avoid duplicate listeners.
    const saveBtn = document.getElementById('oxy-edit-save');
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener('click', () => _saveEditTank(tankId));
  }

  async function _saveEditTank(tankId) {
    const errEl = document.getElementById('oxy-edit-error');
    function _showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('d-none'); }
    }

    const size       = document.getElementById('oxy-edit-size')?.value;
    const psiRaw     = document.getElementById('oxy-edit-pressure')?.value;
    const inspection = document.getElementById('oxy-edit-inspection')?.value || null;
    const notes      = document.getElementById('oxy-edit-notes')?.value.trim() || null;

    if (!size) { _showErr('กรุณาเลือกขนาดถัง'); return; }
    const psi = psiRaw ? parseInt(psiRaw, 10) : null;
    if (psi !== null && (!Number.isFinite(psi) || psi <= 0)) {
      _showErr('ค่าแรงดันต้องเป็นตัวเลขมากกว่า 0'); return;
    }
    if (errEl) errEl.classList.add('d-none');

    const saveBtn = document.getElementById('oxy-edit-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'กำลังบันทึก…'; }

    try {
      await window.AppOxygen.updateTank({
        tankId,
        tankSize:          size,
        nextInspectionDue: inspection,
        lastPressurePsi:   psi,
        notes,
      });
      bootstrap.Modal.getOrCreateInstance(document.getElementById('oxy-edit-modal')).hide();
      _toast('success', 'บันทึกการแก้ไขแล้ว');
      if (_currentTankId === tankId) _renderDetailDrawer(tankId);
      _updateListRow(tankId);
    } catch (e) {
      _showErr(e.message || 'บันทึกไม่สำเร็จ');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'บันทึก'; }
    }
  }

  // =========================================================================
  // Tank detail / history drawer
  // =========================================================================

  async function _openDetailDrawer(tankId) {
    _currentTankId = tankId;
    const body = document.getElementById('oxy-detail-body');
    if (!body) return;

    body.innerHTML = `
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
      </div>
    `;

    const drawer = document.getElementById('oxy-detail-drawer');
    const oc = bootstrap.Offcanvas.getOrCreateInstance(drawer);
    oc.show();

    // Wire transition button
    const transBtn = document.getElementById('oxy-btn-transition');
    if (transBtn) {
      const newBtn = transBtn.cloneNode(true);
      transBtn.parentNode.replaceChild(newBtn, transBtn);
      newBtn.addEventListener('click', () => _openTransitionModal(tankId));
    }

    // Wire edit button
    const editBtn = document.getElementById('oxy-btn-edit');
    if (editBtn) {
      const newEdit = editBtn.cloneNode(true);
      editBtn.parentNode.replaceChild(newEdit, editBtn);
      newEdit.addEventListener('click', () => _openEditModal(tankId));
    }

    await _renderDetailDrawer(tankId);
  }

  async function _renderDetailDrawer(tankId) {
    const body = document.getElementById('oxy-detail-body');
    if (!body) return;

    try {
      const sb = window.getSupabaseClient();
      const [tankRes, histRes] = await Promise.all([
        sb.from('oxygen_tanks').select(`
          id, serial, tank_size, status,
          current_location_id, last_refill_at, last_refill_by,
          last_pressure_psi, next_inspection_due, notes, updated_at,
          locations ( id, name, code )
        `).eq('id', tankId).maybeSingle(),
        window.AppOxygen.getTankHistory(tankId),
      ]);

      const tank = tankRes.data;
      if (!tank) { body.innerHTML = '<div class="p-3 text-muted">ไม่พบข้อมูลถัง</div>'; return; }
      const history = histRes.data || [];

      const histRows = history.map((m) => {
        const fromLabel = m.from_status ? (window.AppOxygen.STATUS_LABELS[m.from_status] || m.from_status) : 'เริ่มต้น';
        const toLabel   = window.AppOxygen.STATUS_LABELS[m.to_status] || m.to_status;
        const noteText  = m.note ? (m.note.length > 50 ? m.note.slice(0, 50) + '…' : m.note) : '—';
        return `
          <tr>
            <td class="small">${_esc(_fmtDateTime(m.performed_at))}</td>
            <td class="small">${_esc(fromLabel)} → ${_esc(toLabel)}</td>
            <td class="small">${_esc(m.performed_by || '—')}</td>
            <td class="small" title="${_esc(m.note || '')}">${_esc(noteText)}</td>
            <td class="small">
              ${m.photo_url
                ? `<a href="${_esc(m.photo_url)}" target="_blank" rel="noopener noreferrer"
                     aria-label="ดูรูปถ่าย">
                     <img src="${_esc(m.photo_url)}" alt="รูปถ่าย"
                          style="width:40px;height:30px;object-fit:cover;border-radius:3px;">
                   </a>`
                : '—'}
            </td>
          </tr>
        `;
      }).join('');

      body.innerHTML = `
        <!-- Header card -->
        <div class="p-3 border-bottom">
          <div class="d-flex align-items-center gap-2 mb-2">
            <h6 class="mb-0"><code>${_esc(tank.serial)}</code></h6>
            ${_statusBadge(tank.status)}
            ${_sizeBadge(tank.tank_size)}
          </div>
          <div class="small text-muted mb-1">
            <i class="bi bi-geo-alt"></i> ${_esc(tank.locations?.name || '—')}
          </div>
          <div class="small text-muted mb-1">
            <i class="bi bi-arrow-repeat"></i> เติมล่าสุด: ${_esc(_fmtDate(tank.last_refill_at))}
            ${tank.last_refill_by ? `โดย ${_esc(tank.last_refill_by)}` : ''}
          </div>
          <div class="small text-muted">
            <i class="bi bi-calendar-check"></i> ตรวจสอบถัดไป:
            ${_esc(_fmtDate(tank.next_inspection_due))}
            ${_inspectionWarning(tank.next_inspection_due)}
          </div>
          ${tank.notes ? `<div class="small text-muted mt-1"><i class="bi bi-sticky"></i> ${_esc(tank.notes)}</div>` : ''}
        </div>

        <!-- History table -->
        <div class="p-3">
          <h6 class="small text-muted mb-2">ประวัติการเปลี่ยนสถานะ (${history.length} รายการ)</h6>
          ${history.length ? `
            <div class="table-responsive">
              <table class="table table-sm table-bordered mb-0" style="font-size:.82rem;">
                <thead class="table-light">
                  <tr>
                    <th>วันที่/เวลา</th>
                    <th>การเปลี่ยนแปลง</th>
                    <th>บันทึกโดย</th>
                    <th>หมายเหตุ</th>
                    <th>รูป</th>
                  </tr>
                </thead>
                <tbody>${histRows}</tbody>
              </table>
            </div>
          ` : '<div class="text-muted small">ยังไม่มีประวัติ</div>'}
        </div>
      `;
    } catch (e) {
      body.innerHTML = `<div class="p-3 text-danger small">โหลดข้อมูลไม่สำเร็จ: ${_esc(e.message)}</div>`;
    }
  }

  // =========================================================================
  // Log-transition modal (Admin only)
  // =========================================================================

  async function _openTransitionModal(tankId) {
    const modalEl = document.getElementById('oxy-transition-modal');
    if (!modalEl) return;

    const body    = document.getElementById('oxy-transition-body');
    const saveBtn = document.getElementById('oxy-transition-save');

    if (body) body.innerHTML = '<div class="text-center text-muted py-3">กำลังโหลด…</div>';
    if (saveBtn) saveBtn.classList.add('d-none');

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    // Fetch current tank state
    const sb = window.getSupabaseClient();
    const { data: tank } = await sb.from('oxygen_tanks')
      .select('id, serial, status, current_location_id, locations(id, name, code)')
      .eq('id', tankId).maybeSingle();

    if (!tank) {
      if (body) body.innerHTML = '<div class="text-muted">ไม่พบข้อมูลถัง</div>';
      return;
    }

    const allowedToStatuses = window.AppOxygen.getAllowedTransitions(tank.status, true);
    const photoUrl = { value: null };  // captured photo URL

    if (body) {
      body.innerHTML = `
        <div class="mb-2 small text-muted">ถัง: <strong><code>${_esc(tank.serial)}</code></strong>
          สถานะปัจจุบัน: ${_statusBadge(tank.status)}
        </div>
        <div id="oxy-trans-error" class="alert alert-danger d-none" role="alert"></div>

        <div class="mb-3">
          <label class="form-label" for="oxy-trans-to-status">สถานะใหม่ <span class="text-danger">*</span></label>
          <select id="oxy-trans-to-status" class="form-select" required>
            <option value="">— เลือกสถานะ —</option>
            ${allowedToStatuses.map((s) => `
              <option value="${_esc(s)}">${_esc(window.AppOxygen.STATUS_LABELS[s] || s)}</option>
            `).join('')}
          </select>
        </div>

        <div class="mb-3 d-none" id="oxy-trans-location-wrap">
          <label class="form-label" for="oxy-trans-location">สถานที่ใหม่</label>
          <select id="oxy-trans-location" class="form-select">
            <option value="">— ไม่เปลี่ยนสถานที่ —</option>
            ${_locationOptions(tank.current_location_id)}
          </select>
        </div>

        <div class="mb-3">
          <label class="form-label" for="oxy-trans-note">เหตุผล / บันทึก (ไม่บังคับ)</label>
          <textarea id="oxy-trans-note" class="form-control" rows="2" maxlength="500"></textarea>
        </div>

        <!-- Photo upload (optional, Q-Phase5-4) -->
        <div class="mb-3">
          <div class="d-flex align-items-center justify-content-between mb-1">
            <label class="form-label mb-0">รูปถ่าย (ไม่บังคับ)</label>
            ${window.PhotoCaptureModal
              ? `<button type="button" id="oxy-trans-photo-btn" class="btn btn-sm btn-outline-secondary"
                         style="min-height:36px;">
                   <i class="bi bi-camera me-1"></i>ถ่ายรูป
                 </button>`
              : `<span class="small text-muted">ยังไม่รองรับการอัปโหลดรูป (Phase 3 pending)</span>`}
          </div>
          <div id="oxy-trans-photo-preview" class="text-muted small">— ไม่มีรูปถ่าย —</div>
        </div>

        <!-- Retire warning (shown conditionally) -->
        <div id="oxy-trans-retire-warn" class="alert alert-danger d-none" role="alert">
          <i class="bi bi-exclamation-triangle-fill me-1"></i>
          <strong>การปลดระวางเป็นการถาวร</strong> ไม่สามารถเปลี่ยนแปลงได้ หลังจากนี้จะไม่สามารถเปลี่ยนสถานะถังนี้ได้อีก
        </div>
      `;
    }

    // Show/hide location picker and retire warning based on to_status
    document.getElementById('oxy-trans-to-status')?.addEventListener('change', (e) => {
      const toStatus = e.target.value;
      const locWrap   = document.getElementById('oxy-trans-location-wrap');
      const retireWarn = document.getElementById('oxy-trans-retire-warn');
      const needsLoc = ['on_board', 'ready', 'maintenance'].includes(toStatus);
      locWrap?.classList.toggle('d-none', !needsLoc);
      retireWarn?.classList.toggle('d-none', toStatus !== 'retired');
      if (saveBtn) saveBtn.classList.toggle('d-none', !toStatus);
    });

    // Wire photo capture button
    if (window.PhotoCaptureModal) {
      document.getElementById('oxy-trans-photo-btn')?.addEventListener('click', () => {
        window.PhotoCaptureModal.open({
          folder:     `thegood-stock/oxygen/${tank.serial}`,
          label:      `ถ่ายรูปถัง ${tank.serial}`,
          optional:   true,
          onUploaded: (url) => {
            photoUrl.value = url;
            const preview = document.getElementById('oxy-trans-photo-preview');
            if (preview) {
              preview.innerHTML = `
                <img src="${_esc(url)}" alt="รูปถ่าย"
                     style="max-width:80px;height:60px;object-fit:cover;border-radius:4px;">
                <a href="${_esc(url)}" target="_blank" rel="noopener noreferrer" class="ms-2 small">ดูรูปเต็ม</a>
              `;
            }
          },
          onSkipped: () => {
            photoUrl.value = null;
          },
          onError: (msg) => {
            _toast('error', `อัปโหลดรูปไม่สำเร็จ: ${msg}`);
          },
        });
      });
    }

    // Wire save button
    if (saveBtn) {
      const newSave = saveBtn.cloneNode(true);
      saveBtn.parentNode.replaceChild(newSave, saveBtn);
      newSave.addEventListener('click', async () => {
        const toStatus  = document.getElementById('oxy-trans-to-status')?.value;
        const toLocId   = document.getElementById('oxy-trans-location')?.value || null;
        const note      = document.getElementById('oxy-trans-note')?.value.trim() || null;
        const errEl     = document.getElementById('oxy-trans-error');

        if (!toStatus) {
          if (errEl) { errEl.textContent = 'กรุณาเลือกสถานะใหม่'; errEl.classList.remove('d-none'); }
          return;
        }
        if (errEl) errEl.classList.add('d-none');

        newSave.disabled = true;
        newSave.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังบันทึก…';

        try {
          await window.AppOxygen.logTransition({
            tankId:      tank.id,
            fromStatus:  tank.status,
            toStatus,
            toLocationId: toLocId,
            note,
            photoUrl:    photoUrl.value,
          });

          bootstrap.Modal.getOrCreateInstance(document.getElementById('oxy-transition-modal')).hide();
          _toast('success', 'เปลี่ยนสถานะแล้ว');
          _loadList();
          // Refresh the drawer if it is still open for the same tank
          if (_currentTankId === tank.id) {
            setTimeout(() => _renderDetailDrawer(tank.id), 300);
          }
        } catch (e) {
          const msg = e.message || 'เปลี่ยนสถานะไม่สำเร็จ';
          if (errEl) { errEl.textContent = msg; errEl.classList.remove('d-none'); }
          _toast('error', msg);
        } finally {
          newSave.disabled = false;
          newSave.textContent = 'ยืนยัน';
        }
      });
    }
  }

  // =========================================================================
  // Realtime
  // =========================================================================

  function _startRealtime() {
    _unsubscribe = window.AppOxygen.subscribeOxygenTanks((payload) => {
      const tankId = payload?.new?.id || payload?.old?.id;
      if (tankId) _updateListRow(tankId);
      // Also refresh the open drawer
      if (_currentTankId && tankId === _currentTankId) {
        const drawer = document.getElementById('oxy-detail-drawer');
        if (drawer && drawer.classList.contains('show')) {
          _renderDetailDrawer(_currentTankId);
        }
      }
    });
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async function init() {
    if (_mounted) return;
    _mounted = true;

    _renderShell();
    // Relocate every modal out of the tab pane to <body>. Bootstrap modals
    // must not live inside a transformed ancestor (.fc-reveal animation) —
    // the transform creates a stacking context that traps the modal behind
    // the body-level .modal-backdrop. (Other tabs append modals to body
    // directly; the oxygen shell renders them inline, so move them here.)
    document.querySelectorAll('#tab-oxygen .modal').forEach((m) => {
      document.body.appendChild(m);
    });
    // D14: populate tank_size dropdown from lookup_lists
    const sizeEl = document.getElementById('oxy-add-size');
    if (sizeEl) _fillLookupSelect(sizeEl, 'tank_size', null);

    await _loadLocations();
    await _loadList();
    _startRealtime();

    window.addEventListener('beforeunload', teardown);
  }

  function teardown() {
    if (_unsubscribe) { try { _unsubscribe(); } catch {} _unsubscribe = null; }
    _mounted = false;
  }

  // =========================================================================
  // Public namespace
  // =========================================================================
  window.AppOxygenTab = { init, teardown };
  window.initOxygenTab = init;

})();
