// js/settings-ui.js

(function () {
  function v(key, fallback) {
    const x = settingsGet(key);
    return x == null ? (fallback ?? '') : x;
  }

  // Sub-tab persistence: 'system' (default) | 'ambulances' | 'lists'
  let _subTab = (typeof localStorage !== 'undefined' && localStorage.getItem('settings_subtab')) || 'system';

  // Track whether the lists pane has been initialised
  let _listsInited = false;

  function _renderShell(activeSub) {
    return `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-gear me-2"></i>ตั้งค่า</h5>
        <div role="tablist" aria-label="settings section" style="display:inline-flex;border:1.5px solid var(--fc-vital,#00B8A9);border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,184,169,0.15)">
          <button id="btn-set-sub-system"     class="fc-btn fc-btn-${activeSub==='system'?'primary':'ghost'}"     style="border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em"><i class="bi bi-gear me-1"></i>ระบบ</button>
          <button id="btn-set-sub-ambulances" class="fc-btn fc-btn-${activeSub==='ambulances'?'primary':'ghost'}" style="border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em"><i class="bi bi-truck me-1"></i>รถพยาบาล</button>
          <button id="btn-set-sub-lists"      class="fc-btn fc-btn-${activeSub==='lists'?'primary':'ghost'}"      style="border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em"><i class="bi bi-list-ul me-1"></i>จัดการรายการ</button>
        </div>
      </div>

      <!-- System settings pane -->
      <div id="settings-pane-system" class="${activeSub==='system'?'':'d-none'}"></div>

      <!-- Ambulances pane — the ambulances.js render() targets #tab-ambulances. -->
      <div id="tab-ambulances" class="${activeSub==='ambulances'?'':'d-none'}"></div>

      <!-- Lists (taxonomy) pane -->
      <div id="settings-pane-lists" class="${activeSub==='lists'?'':'d-none'}"></div>
    `;
  }

  function _renderSystemPane() {
    const host = document.getElementById('settings-pane-system');
    if (!host) return;
    host.innerHTML = `
      <div class="card mb-3"><div class="card-body">
        <h6>การแจ้งเตือน Telegram</h6>
        <div class="form-check form-switch mb-2">
          <input class="form-check-input" type="checkbox" id="s-tg-enabled" ${v('NOTIFY_TELEGRAM_ENABLED') === 'true' ? 'checked' : ''}>
          <label class="form-check-label" for="s-tg-enabled">เปิดใช้งานการแจ้งเตือน</label>
        </div>
        <div class="row g-2 mb-2">
          <div class="col-md-6"><label class="form-label small">Chat ID</label>
            <input class="form-control" id="s-tg-chat" value="${escapeHtml(v('NOTIFY_TELEGRAM_CHAT_ID'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">เวลาสรุปประจำวัน (HH)</label>
            <input class="form-control" id="s-tg-hour" type="number" min="0" max="23" value="${escapeHtml(v('NOTIFY_CRON_HOUR'))}">
          </div>
        </div>
        <button class="btn btn-outline-stock-accent btn-sm" id="btn-test-tg">ทดสอบส่ง Telegram</button>
      </div></div>

      <div class="card mb-3"><div class="card-body">
        <h6>เกณฑ์การแจ้งเตือน</h6>
        <div class="row g-2">
          <div class="col-md-3"><label class="form-label small">Dedupe window (ชม.)</label>
            <input class="form-control" id="s-dedupe" type="number" value="${escapeHtml(v('LOW_STOCK_DEDUPE_HOURS'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">Expiry alert (วัน)</label>
            <input class="form-control" id="s-expiry" value="${escapeHtml(v('EXPIRY_ALERT_DAYS'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">Oxygen refill threshold</label>
            <input class="form-control" id="s-o2" type="number" value="${escapeHtml(v('OXYGEN_REFILL_THRESHOLD'))}">
          </div>
        </div>
      </div></div>

      <div class="card mb-3"><div class="card-body">
        <h6>ภายนอกระบบ</h6>
        <label class="form-label small">Ambulance GAS URL</label>
        <input class="form-control" id="s-amb-url" value="${escapeHtml(v('AMBULANCE_GAS_URL'))}">
      </div></div>

      <button class="btn btn-stock-primary" id="btn-save-settings">บันทึกการตั้งค่า</button>
    `;
  }

  function _wireSystemHandlers() {
    document.getElementById('btn-save-settings').onclick = async () => {
      try {
        await settingsSet({
          NOTIFY_TELEGRAM_ENABLED: document.getElementById('s-tg-enabled').checked ? 'true' : 'false',
          NOTIFY_TELEGRAM_CHAT_ID: document.getElementById('s-tg-chat').value.trim(),
          NOTIFY_CRON_HOUR:        document.getElementById('s-tg-hour').value.trim(),
          LOW_STOCK_DEDUPE_HOURS:  document.getElementById('s-dedupe').value.trim(),
          EXPIRY_ALERT_DAYS:       document.getElementById('s-expiry').value.trim(),
          OXYGEN_REFILL_THRESHOLD: document.getElementById('s-o2').value.trim(),
          AMBULANCE_GAS_URL:       document.getElementById('s-amb-url').value.trim(),
        });
        showToast('success', 'บันทึกการตั้งค่าแล้ว');
      } catch (e) { showToast('error', e.message); }
    };

    document.getElementById('btn-test-tg').onclick = async () => {
      const res = await notifyManualTest('ทดสอบส่งจาก Thegood Stock — ' + new Date().toLocaleString('th-TH'));
      if (res?.sent)              showToast('success', 'ส่งสำเร็จ ตรวจ Telegram chat');
      else if (res?.reason === 'disabled') showToast('warning', 'Telegram ปิดอยู่ — เปิดและบันทึกก่อน');
      else                        showToast('error', 'ส่งไม่สำเร็จ: ' + (res?.error || 'unknown'));
    };
  }

  function _switchSubTab(name) {
    _subTab = name;
    try { localStorage.setItem('settings_subtab', name); } catch {}
    document.getElementById('settings-pane-system').classList.toggle('d-none', name !== 'system');
    document.getElementById('tab-ambulances').classList.toggle('d-none', name !== 'ambulances');
    document.getElementById('settings-pane-lists').classList.toggle('d-none', name !== 'lists');
    // Update sub-nav button visuals
    const btnStyle = 'border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em';
    ['system', 'ambulances', 'lists'].forEach(tab => {
      const idMap = { system: 'btn-set-sub-system', ambulances: 'btn-set-sub-ambulances', lists: 'btn-set-sub-lists' };
      const btn = document.getElementById(idMap[tab]);
      if (!btn) return;
      btn.className  = `fc-btn fc-btn-${name === tab ? 'primary' : 'ghost'}`;
      btn.style.cssText = btnStyle;
    });
    if (name === 'ambulances') {
      if (window.initAmbulancesTab) {
        try { window.initAmbulancesTab(); } catch (e) { showToast('error', e.message || 'โหลด ambulances ไม่สำเร็จ'); }
      }
    }
    if (name === 'lists' && !_listsInited) {
      _listsInited = true;
      _initListsPane();
    }
  }

  window.initSettingsTab = function () {
    _listsInited = false;
    const root = document.getElementById('tab-settings');
    root.innerHTML = _renderShell(_subTab);
    _renderSystemPane();
    _wireSystemHandlers();
    document.getElementById('btn-set-sub-system').onclick     = () => _switchSubTab('system');
    document.getElementById('btn-set-sub-ambulances').onclick = () => _switchSubTab('ambulances');
    document.getElementById('btn-set-sub-lists').onclick      = () => _switchSubTab('lists');
    if (_subTab === 'ambulances' && window.initAmbulancesTab) {
      try { window.initAmbulancesTab(); } catch (e) { showToast('error', e.message || 'โหลด ambulances ไม่สำเร็จ'); }
    }
    if (_subTab === 'lists') {
      _listsInited = true;
      _initListsPane();
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // MANAGE LISTS PANE — D14
  // ══════════════════════════════════════════════════════════════════════════

  const _SECTIONS = [
    { id: 'cat',   title: 'หมวดสินค้า',           icon: 'bi-tag',          kind: 'category' },
    { id: 'linen', title: 'หมวดย่อยผ้า',           icon: 'bi-layers',       kind: 'linen_subcategory' },
    { id: 'style', title: 'รูปแบบตู้',             icon: 'bi-box',          kind: 'storage_style' },
    { id: 'tank',  title: 'ขนาดถังออกซิเจน',       icon: 'bi-circle-square', kind: 'tank_size' },
  ];

  function _initListsPane() {
    const host = document.getElementById('settings-pane-lists');
    if (!host) return;
    host.innerHTML = `
      <div class="mb-2 text-muted" style="font-size:13px">
        ค่าในรายการนี้จะแสดงเป็นตัวเลือกใน dropdown ทั่วระบบ — เพิ่ม/แก้ไข/ปิดได้ตามต้องการ
      </div>
      ${_SECTIONS.map(s => `
        <div class="fc-card mb-3" id="ll-section-${s.id}">
          <div class="card-body">
            <div class="d-flex align-items-center mb-3 gap-2">
              <i class="bi ${s.icon} me-1" style="color:var(--fc-vital)"></i>
              <span class="fc-display fw-semibold" style="font-size:15px">${escapeHtml(s.title)}</span>
              <button class="btn btn-sm btn-outline-success ms-auto" id="ll-add-${s.id}">
                <i class="bi bi-plus-lg me-1"></i>เพิ่ม
              </button>
            </div>
            <div id="ll-table-${s.id}">
              <div class="text-muted small">กำลังโหลด…</div>
            </div>
          </div>
        </div>
      `).join('')}
    `;
    _SECTIONS.forEach(s => _loadSection(s));
  }

  async function _loadSection(s) {
    const tableHost = document.getElementById(`ll-table-${s.id}`);
    if (!tableHost) return;

    let rows, error;
    if (s.kind === 'category') {
      ({ data: rows, error } = await LookupLists.fetchCategories());
    } else {
      ({ data: rows, error } = await LookupLists.fetchByKind(s.kind));
    }

    if (error) {
      // Graceful degradation: lookup_lists table might not exist yet
      const msg = (error.message || '').toLowerCase();
      const tableNotExist = msg.includes('does not exist') || msg.includes('undefined') || error.code === '42P01';
      if (s.kind !== 'category' && tableNotExist) {
        tableHost.innerHTML = `<div class="alert alert-warning py-2 mb-0" style="font-size:13px">
          <i class="bi bi-exclamation-triangle me-1"></i>
          ตาราง <span class="fc-mono">lookup_lists</span> ยังไม่ถูกสร้าง — รอ migration
        </div>`;
        document.getElementById(`ll-add-${s.id}`).disabled = true;
      } else {
        tableHost.innerHTML = `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
      }
      return;
    }

    _renderTable(s, rows || []);
    document.getElementById(`ll-add-${s.id}`).onclick = () => _openModal(s, null);
  }

  function _renderTable(s, rows) {
    const tableHost = document.getElementById(`ll-table-${s.id}`);
    if (!tableHost) return;
    if (!rows.length) {
      tableHost.innerHTML = `<p class="text-muted small mb-0">// ยังไม่มีรายการ</p>`;
      return;
    }
    tableHost.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm mb-0" style="font-size:13px">
          <thead><tr>
            <th style="width:110px">Code</th>
            <th>ชื่อ</th>
            <th style="width:70px;text-align:center">ลำดับ</th>
            <th style="width:80px;text-align:center">สถานะ</th>
            <th style="width:90px"></th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr id="ll-row-${s.id}-${r.id}">
                <td><span class="fc-mono" style="font-size:12px">${escapeHtml(r.code)}</span></td>
                <td>${escapeHtml(r.name)}</td>
                <td style="text-align:center">${r.sort_order ?? 0}</td>
                <td style="text-align:center">
                  ${r.active
                    ? '<span class="fc-badge fc-badge-success" style="font-size:11px">ใช้งาน</span>'
                    : '<span class="fc-badge fc-badge-neutral" style="font-size:11px">ปิด</span>'}
                </td>
                <td style="text-align:right">
                  <button class="btn btn-sm btn-outline-secondary me-1 py-0"
                    data-ll-edit="${s.id}" data-id="${r.id}">แก้ไข</button>
                  <button class="btn btn-sm btn-outline-danger py-0"
                    data-ll-del="${s.id}" data-id="${r.id}" data-code="${escapeHtml(r.code)}">ลบ</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    // Wire row actions
    rows.forEach(r => {
      const editBtn = tableHost.querySelector(`[data-ll-edit="${s.id}"][data-id="${r.id}"]`);
      const delBtn  = tableHost.querySelector(`[data-ll-del="${s.id}"][data-id="${r.id}"]`);
      if (editBtn) editBtn.onclick = () => _openModal(s, r);
      if (delBtn)  delBtn.onclick  = () => _confirmDelete(s, r);
    });
  }

  // ── Modal ─────────────────────────────────────────────────────────────────

  function _openModal(s, row) {
    const isEdit = !!row;
    const modalId = 'll-modal-' + s.id;
    // Remove stale modal if any
    document.getElementById(modalId)?.remove();

    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header" style="border-bottom:1px solid var(--fc-line,#e8e3da)">
              <h6 class="modal-title fc-display mb-0">
                ${isEdit ? 'แก้ไข' : 'เพิ่มรายการ'} — ${escapeHtml(s.title)}
              </h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-3">
                <label class="form-label small fw-semibold">Code <span class="text-danger">*</span></label>
                ${isEdit
                  ? `<div class="fc-mono p-2 rounded" style="background:var(--fc-surface,#f5f1ea);font-size:13px">${escapeHtml(row.code)}</div>
                     <div class="text-muted mt-1" style="font-size:11px">Code ไม่สามารถเปลี่ยนได้ เพราะรายการอื่นอ้างอิงค่านี้อยู่</div>`
                  : `<input class="form-control" id="ll-input-code" placeholder="ตัวอักษร/ตัวเลข ไม่มีช่องว่าง" required>
                     <div class="text-muted mt-1" style="font-size:11px">กำหนดครั้งเดียว ไม่สามารถเปลี่ยนได้ภายหลัง</div>`}
              </div>
              <div class="mb-3">
                <label class="form-label small fw-semibold">ชื่อ <span class="text-danger">*</span></label>
                <input class="form-control" id="ll-input-name" value="${isEdit ? escapeHtml(row.name) : ''}" placeholder="ชื่อที่แสดงใน dropdown">
              </div>
              <div class="mb-3">
                <label class="form-label small fw-semibold">ลำดับ</label>
                <input class="form-control" id="ll-input-order" type="number" value="${isEdit ? (row.sort_order ?? 0) : 0}">
              </div>
              ${isEdit ? `
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="ll-input-active" ${row.active ? 'checked' : ''}>
                <label class="form-check-label small" for="ll-input-active">ใช้งาน (active)</label>
              </div>` : ''}
              <div id="ll-modal-err" class="text-danger small mt-2 d-none"></div>
            </div>
            <div class="modal-footer" style="border-top:1px solid var(--fc-line,#e8e3da)">
              <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">ยกเลิก</button>
              <button type="button" class="fc-btn fc-btn-primary btn-sm" id="ll-modal-save" style="padding:8px 20px">บันทึก</button>
            </div>
          </div>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    const modalEl = document.getElementById(modalId);
    const bsModal = new bootstrap.Modal(modalEl);
    bsModal.show();
    modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());

    document.getElementById('ll-modal-save').onclick = async () => {
      const nameVal  = (document.getElementById('ll-input-name')?.value || '').trim();
      const codeVal  = isEdit ? row.code : (document.getElementById('ll-input-code')?.value || '').trim();
      const orderVal = parseInt(document.getElementById('ll-input-order')?.value || '0', 10);
      const activeVal = isEdit ? document.getElementById('ll-input-active')?.checked : true;
      const errEl    = document.getElementById('ll-modal-err');

      errEl.classList.add('d-none');
      if (!nameVal) { errEl.textContent = 'กรุณากรอกชื่อ'; errEl.classList.remove('d-none'); return; }
      if (!codeVal) { errEl.textContent = 'กรุณากรอก code'; errEl.classList.remove('d-none'); return; }
      if (/\s/.test(codeVal)) { errEl.textContent = 'Code ต้องไม่มีช่องว่าง'; errEl.classList.remove('d-none'); return; }

      const saveBtn = document.getElementById('ll-modal-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'กำลังบันทึก…';

      let result;
      if (isEdit) {
        if (s.kind === 'category') {
          result = await LookupLists.updateCategory(row.id, { name: nameVal, sort_order: orderVal, active: activeVal });
        } else {
          result = await LookupLists.update(row.id, { name: nameVal, sort_order: orderVal, active: activeVal });
        }
      } else {
        if (s.kind === 'category') {
          result = await LookupLists.createCategory({ code: codeVal, name: nameVal, sort_order: orderVal });
        } else {
          result = await LookupLists.create(s.kind, { code: codeVal, name: nameVal, sort_order: orderVal });
        }
      }

      if (result.error) {
        const msg = result.error.message || '';
        errEl.textContent = msg.includes('23505') ? `Code "${codeVal}" มีอยู่แล้ว` : msg;
        errEl.classList.remove('d-none');
        saveBtn.disabled = false;
        saveBtn.textContent = 'บันทึก';
        return;
      }

      bsModal.hide();
      showToast('success', isEdit ? 'แก้ไขแล้ว' : 'เพิ่มรายการแล้ว');
      _loadSection(s);
    };
  }

  // ── Delete guard ──────────────────────────────────────────────────────────

  async function _confirmDelete(s, row) {
    const { count, error: cntErr } = await LookupLists.countUsage(
      s.kind,
      s.kind === 'category' ? row.id : row.code
    );

    if (cntErr) { showToast('error', 'ตรวจสอบการใช้งานไม่สำเร็จ: ' + cntErr.message); return; }

    if (count > 0) {
      showToast('warning', `ลบไม่ได้ — มี ${count} รายการใช้ค่านี้อยู่ ให้เปลี่ยนเป็น 'ปิดใช้งาน' แทน`, { delay: 6000 });
      return;
    }

    const ok = await showConfirm(`ลบ "${row.name}" (${row.code}) ออกจากรายการ?`);
    if (!ok) return;

    let result;
    if (s.kind === 'category') {
      result = await LookupLists.removeCategory(row.id);
    } else {
      result = await LookupLists.remove(row.id);
    }

    if (result.error) { showToast('error', result.error.message); return; }
    showToast('success', 'ลบแล้ว');
    _loadSection(s);
  }
})();
