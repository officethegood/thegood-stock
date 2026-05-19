// js/bag-templates.js
// Phase 4 — Admin Template Management panel (S-4.3 + S-4.3.1).
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §7.1.3
//   docs/superpowers/designs/2026-05-19-phase4-als-bags-ui-design.md §6
//
// Decisions enforced:
//   Q-Phase4-A: No seed rows — Admin creates templates via this UI.
//
// Upstream APIs:
//   window.AppBags (shared/bags.js)
//   window.AppInventory.listItems (shared/inventory.js) — item autocomplete
//   window.showToast, window.escapeHtml (shared/ui.js)
//
// Public namespace: window.AppBagTemplates
// Entrypoint: window.AppBagTemplates.renderPanel(containerEl)

(function () {
  'use strict';

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function _toast(t, m) { (window.showToast || (()=>{}))(t, m); }

  // ==========================================================================
  // Render template list panel inside containerEl
  // ==========================================================================

  async function renderPanel(containerEl) {
    containerEl.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h5 class="mb-0"><i class="bi bi-clipboard-list me-1"></i> จัดการเทมเพลต</h5>
        <button class="btn btn-sm btn-stock-primary" id="tpl-btn-add">
          <i class="bi bi-plus-lg me-1"></i>เพิ่มเทมเพลต
        </button>
      </div>
      <div id="tpl-list-body">
        <div class="text-center text-muted py-4">
          <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
        </div>
      </div>
      <!-- Create/Edit Modal -->
      <div class="modal fade" id="tpl-modal" tabindex="-1" aria-labelledby="tpl-modal-title" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="tpl-modal-title">สร้างเทมเพลต</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body">
              <form id="tpl-form" novalidate>
                <div class="mb-3">
                  <label class="form-label fw-semibold" for="tpl-code">รหัสเทมเพลต *</label>
                  <input type="text" id="tpl-code" class="form-control"
                         placeholder="TPL-ALS-ADULT" maxlength="30" required
                         oninput="this.value=this.value.toUpperCase()">
                  <div class="invalid-feedback" id="tpl-code-err"></div>
                </div>
                <div class="mb-3">
                  <label class="form-label fw-semibold" for="tpl-name">ชื่อเทมเพลต *</label>
                  <input type="text" id="tpl-name" class="form-control"
                         placeholder="ALS ผู้ใหญ่" maxlength="100" required>
                  <div class="invalid-feedback">กรุณากรอกชื่อเทมเพลต</div>
                </div>
                <div class="mb-3">
                  <label class="form-label fw-semibold" for="tpl-category">หมวดหมู่</label>
                  <input type="text" id="tpl-category" class="form-control"
                         placeholder="ALS" maxlength="50">
                </div>
                <div class="mb-3">
                  <label class="form-label fw-semibold" for="tpl-desc">คำอธิบาย</label>
                  <textarea id="tpl-desc" class="form-control" rows="2"></textarea>
                </div>

                <hr>
                <h6>รายการของในกระเป๋า</h6>

                <div id="tpl-items-table">
                  <table class="table table-sm table-bordered align-middle" id="tpl-items-tbl">
                    <thead class="table-light">
                      <tr>
                        <th style="width:40px">#</th>
                        <th>สินค้า *</th>
                        <th style="width:90px">เป้าหมาย *</th>
                        <th style="width:90px">บังคับ</th>
                        <th style="width:44px"></th>
                      </tr>
                    </thead>
                    <tbody id="tpl-items-body"></tbody>
                  </table>
                  <button type="button" class="btn btn-sm btn-outline-secondary" id="tpl-item-add-btn">
                    <i class="bi bi-plus-lg me-1"></i>เพิ่มรายการ
                  </button>
                </div>
              </form>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">ยกเลิก</button>
              <button type="button" class="btn btn-stock-primary" id="tpl-modal-save">
                <span class="btn-text">บันทึก</span>
              </button>
            </div>
          </div>
        </div>
      </div>`;

    containerEl.querySelector('#tpl-btn-add').addEventListener('click', () => openModal(null));
    containerEl.querySelector('#tpl-item-add-btn').addEventListener('click', addItemRow);
    containerEl.querySelector('#tpl-modal-save').addEventListener('click', onSave);

    await loadList();
  }

  // ==========================================================================
  // Load and render template list
  // ==========================================================================

  async function loadList() {
    const body = document.getElementById('tpl-list-body');
    if (!body) return;

    const { data, error } = await window.AppBags.listTemplates({ activeOnly: false });
    if (error) {
      body.innerHTML = `<div class="alert alert-danger small">โหลดเทมเพลตไม่สำเร็จ</div>`;
      return;
    }

    if (!data || data.length === 0) {
      body.innerHTML = `
        <div class="text-center text-muted py-4">
          <i class="bi bi-clipboard-x" style="font-size:2rem;"></i>
          <p class="mt-2">ยังไม่มีเทมเพลต — สร้างเทมเพลตแรก</p>
        </div>`;
      return;
    }

    const rows = data.map((t) => `
      <div class="card mb-2 ${t.active ? '' : 'opacity-50'}">
        <div class="card-body py-2 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div>
            <span class="fw-semibold">${_esc(t.code)}</span>
            <span class="ms-2 text-muted">${_esc(t.name)}</span>
            ${t.category ? `<span class="badge bg-light text-dark border ms-2">${_esc(t.category)}</span>` : ''}
            ${!t.active ? '<span class="badge bg-secondary ms-2">ปิดใช้งาน</span>' : ''}
          </div>
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-outline-primary" data-tpl-edit="${_esc(t.id)}">
              <i class="bi bi-pencil"></i> แก้ไข
            </button>
            <button class="btn btn-sm ${t.active ? 'btn-outline-secondary' : 'btn-outline-success'}"
                    data-tpl-toggle="${_esc(t.id)}" data-tpl-active="${t.active}">
              ${t.active ? '<i class="bi bi-pause-circle"></i> ปิดใช้งาน' : '<i class="bi bi-play-circle"></i> เปิดใช้งาน'}
            </button>
          </div>
        </div>
      </div>`).join('');

    body.innerHTML = rows;

    body.querySelectorAll('[data-tpl-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openModal(btn.dataset.tplEdit));
    });
    body.querySelectorAll('[data-tpl-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => toggleTemplate(btn.dataset.tplToggle, btn.dataset.tplActive === 'true'));
    });
  }

  // ==========================================================================
  // Toggle template active state
  // ==========================================================================

  async function toggleTemplate(id, currentActive) {
    const { error } = await window.AppBags.updateTemplate(id, { active: !currentActive });
    if (error) { _toast('error', 'อัปเดตสถานะไม่สำเร็จ'); return; }
    _toast('success', currentActive ? 'ปิดใช้งานเทมเพลตแล้ว' : 'เปิดใช้งานเทมเพลตแล้ว');
    await loadList();
  }

  // ==========================================================================
  // Open create/edit modal
  // ==========================================================================

  let _editId    = null;      // null = create mode
  let _editItems = [];        // current item rows in modal

  async function openModal(templateId) {
    _editId    = templateId;
    _editItems = [];

    const modal = document.getElementById('tpl-modal');
    if (!modal) return;

    // Reset form
    document.getElementById('tpl-code').value     = '';
    document.getElementById('tpl-name').value     = '';
    document.getElementById('tpl-category').value = '';
    document.getElementById('tpl-desc').value     = '';
    document.getElementById('tpl-items-body').innerHTML = '';
    document.getElementById('tpl-code-err').textContent = '';
    document.getElementById('tpl-modal-title').textContent =
      templateId ? 'แก้ไขเทมเพลต' : 'สร้างเทมเพลต';

    // In edit mode: load existing data
    if (templateId) {
      // Load template header
      const { data: tplList } = await window.AppBags.listTemplates({ activeOnly: false });
      const tpl = (tplList || []).find((t) => t.id === templateId);
      if (tpl) {
        document.getElementById('tpl-code').value     = tpl.code;
        document.getElementById('tpl-name').value     = tpl.name;
        document.getElementById('tpl-category').value = tpl.category || '';
        document.getElementById('tpl-desc').value     = tpl.description || '';
        // Lock code field in edit mode to prevent duplicate issues
        document.getElementById('tpl-code').readOnly = true;
      }
      // Load existing items
      const { data: items } = await window.AppBags.getTemplateWithItems(templateId);
      (items || []).forEach((bti) => {
        addItemRow({
          bti_id:     bti.id,
          item_id:    bti.item_id,
          item_name:  bti.stock_items?.name || '',
          item_sku:   bti.stock_items?.sku  || '',
          target_qty: bti.target_qty,
          mandatory:  bti.mandatory,
          sort_order: bti.sort_order,
        });
      });
    } else {
      document.getElementById('tpl-code').readOnly = false;
    }

    const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
    bsModal.show();
  }

  // ==========================================================================
  // Item row management in modal
  // ==========================================================================

  let _itemRowIdx = 0;

  function addItemRow(prefill) {
    const tbody = document.getElementById('tpl-items-body');
    if (!tbody) return;

    const idx = _itemRowIdx++;
    const rowId = `tpl-item-${idx}`;
    const row = document.createElement('tr');
    row.id = rowId;
    row.dataset.btiId = prefill?.bti_id || '';

    row.innerHTML = `
      <td class="text-muted small">${tbody.children.length + 1}</td>
      <td>
        <input type="text" class="form-control form-control-sm tpl-item-search"
               data-idx="${idx}" placeholder="ค้นหาสินค้า…"
               value="${_esc(prefill?.item_name ? (prefill.item_sku + ' — ' + prefill.item_name) : '')}"
               autocomplete="off">
        <input type="hidden" class="tpl-item-id" value="${_esc(prefill?.item_id || '')}">
        <div class="tpl-item-dropdown list-group position-absolute z-3 shadow-sm" style="display:none;max-height:200px;overflow-y:auto;width:280px;"></div>
        <div class="invalid-feedback">กรุณาเลือกสินค้า</div>
      </td>
      <td>
        <input type="number" class="form-control form-control-sm tpl-item-qty"
               min="1" value="${prefill?.target_qty || 1}" required>
      </td>
      <td class="text-center">
        <div class="form-check form-switch d-inline-block">
          <input class="form-check-input tpl-item-mandatory" type="checkbox"
                 ${(prefill === undefined || prefill?.mandatory !== false) ? 'checked' : ''}
                 role="switch" aria-label="บังคับ">
        </div>
      </td>
      <td>
        <button type="button" class="btn btn-sm btn-outline-danger tpl-item-remove"
                aria-label="ลบรายการ"><i class="bi bi-trash3"></i></button>
      </td>`;

    tbody.appendChild(row);

    // Autocomplete for item search
    const searchInput = row.querySelector('.tpl-item-search');
    const dropdown    = row.querySelector('.tpl-item-dropdown');
    const hiddenId    = row.querySelector('.tpl-item-id');
    let _searchTimer  = null;

    searchInput.addEventListener('input', () => {
      clearTimeout(_searchTimer);
      const q = searchInput.value.trim();
      if (q.length < 1) { dropdown.style.display = 'none'; return; }
      _searchTimer = setTimeout(async () => {
        const { data } = await window.AppInventory?.listItems?.({ search: q, limit: 15 }) || {};
        const items = (data || []).slice(0, 15);
        if (!items.length) { dropdown.style.display = 'none'; return; }
        dropdown.innerHTML = items.map((it) =>
          `<a href="#" class="list-group-item list-group-item-action py-1 small"
              data-item-id="${_esc(it.id)}"
              data-item-label="${_esc(it.sku + ' — ' + it.name)}">${_esc(it.sku)} — ${_esc(it.name)}</a>`
        ).join('');
        dropdown.style.display = 'block';
        dropdown.querySelectorAll('a').forEach((a) => {
          a.addEventListener('click', (ev) => {
            ev.preventDefault();
            hiddenId.value       = a.dataset.itemId;
            searchInput.value    = a.dataset.itemLabel;
            dropdown.style.display = 'none';
          });
        });
      }, 300);
    });
    searchInput.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 200));

    // Remove row
    row.querySelector('.tpl-item-remove').addEventListener('click', () => {
      row.remove();
      // Renumber
      tbody.querySelectorAll('tr').forEach((r, i) => {
        r.querySelector('td:first-child').textContent = i + 1;
      });
    });
  }

  // ==========================================================================
  // Save (create or update)
  // ==========================================================================

  async function onSave() {
    const code     = document.getElementById('tpl-code').value.trim();
    const name     = document.getElementById('tpl-name').value.trim();
    const category = document.getElementById('tpl-category').value.trim();
    const desc     = document.getElementById('tpl-desc').value.trim();
    const codeErr  = document.getElementById('tpl-code-err');

    // Client-side validation
    if (!code) { codeErr.textContent = 'กรุณากรอกรหัสเทมเพลต'; return; }
    if (!name) { _toast('warning', 'กรุณากรอกชื่อเทมเพลต'); return; }

    const saveBtn = document.getElementById('tpl-modal-save');
    saveBtn.disabled = true;
    saveBtn.querySelector('.btn-text').textContent = 'กำลังบันทึก…';

    try {
      let templateId = _editId;

      if (!templateId) {
        // Create
        const { data, error } = await window.AppBags.createTemplate({
          code, name,
          category: category || 'ALS',
          description: desc || null,
        });
        if (error) {
          if (error.code === '23505' || (error.message && error.message.includes('code'))) {
            codeErr.textContent = 'รหัสเทมเพลตนี้มีอยู่แล้ว';
          } else {
            _toast('error', 'สร้างเทมเพลตไม่สำเร็จ: ' + (error.message || ''));
          }
          return;
        }
        templateId = data.id;
      } else {
        // Update header only (code locked in edit mode)
        const { error } = await window.AppBags.updateTemplate(templateId, {
          name,
          category: category || 'ALS',
          description: desc || null,
        });
        if (error) { _toast('error', 'อัปเดตเทมเพลตไม่สำเร็จ'); return; }

        // Delete existing items before re-inserting (simplest edit strategy)
        const { data: existing } = await window.AppBags.getTemplateWithItems(templateId);
        for (const bti of (existing || [])) {
          await window.AppBags.deleteTemplateItem(bti.id);
        }
      }

      // Insert item rows
      const rows = document.getElementById('tpl-items-body').querySelectorAll('tr');
      let hasError = false;
      for (let i = 0; i < rows.length; i++) {
        const row       = rows[i];
        const item_id   = row.querySelector('.tpl-item-id').value.trim();
        const target_qty = parseInt(row.querySelector('.tpl-item-qty').value, 10);
        const mandatory  = row.querySelector('.tpl-item-mandatory').checked;

        if (!item_id || !target_qty || target_qty < 1) {
          _toast('warning', `แถวที่ ${i + 1}: กรุณาเลือกสินค้าและกรอกจำนวน`);
          hasError = true;
          continue;
        }

        const { error: iErr } = await window.AppBags.addTemplateItem({
          bag_template_id: templateId,
          item_id,
          target_qty,
          mandatory,
          sort_order: i,
        });
        if (iErr) {
          _toast('warning', `รายการที่ ${i + 1} บันทึกไม่สำเร็จ`);
          hasError = true;
        }
      }

      bootstrap.Modal.getInstance(document.getElementById('tpl-modal'))?.hide();
      _toast(hasError ? 'warning' : 'success', hasError ? 'บันทึกบางรายการไม่สำเร็จ' : 'บันทึกเทมเพลตแล้ว');
      await loadList();
    } finally {
      saveBtn.disabled = false;
      saveBtn.querySelector('.btn-text').textContent = 'บันทึก';
    }
  }

  // ==========================================================================
  // Public namespace
  // ==========================================================================
  window.AppBagTemplates = { renderPanel };
})();
