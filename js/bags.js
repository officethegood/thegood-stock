// js/bags.js
// Phase 4 — Admin "ALS Bags" top-level tab controller.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §7.1
//   docs/superpowers/designs/2026-05-19-phase4-als-bags-ui-design.md §4, §5, §7
//
// Screens covered by this file:
//   S-4.1 Bag list panel
//   S-4.2 Bag detail drawer (inline — replaces list on mobile, side panel on desktop)
//   S-4.3 Template management panel (delegates to js/bag-templates.js)
//   S-4.4 Restock flow (3 steps: shopping list → photo → confirm)
//
// Decisions enforced:
//   Q-Phase4-B: N individual REST INSERTs via AppBags.submitRestockItem (no bulk RPC)
//   Q-Phase4-D: Advisory photo via PhotoCaptureModal (skip always available)
//   Q-Phase4-E: Bag swap OUT OF SCOPE
//   Q-Phase4-F: Inspection tracking OUT OF SCOPE
//
// Upstream APIs:
//   window.AppBags        (shared/bags.js)
//   window.AppLots        (shared/lots.js) — FEFO lot picker
//   window.AppBagTemplates (js/bag-templates.js)
//   window.PhotoCaptureModal (shared/photo-capture.js) — advisory photo
//   window.showToast, window.escapeHtml (shared/ui.js)
//
// Public namespace: window.AppBagsTab
// Entrypoint: window.initBagsTab() — called by admin-shell.js

(function () {
  'use strict';

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function _toast(t, m) { (window.showToast || (()=>{}))(t, m); }

  // =========================================================================
  // Module state
  // =========================================================================
  let _mounted       = false;
  let _bags          = [];       // current v_bag_status rows
  let _filterLevel   = null;     // 'complete'|'low_stock'|'expiring'|'expired'|'no_template'|null
  let _filterTpl     = null;     // template_code or null
  let _filterSearch  = '';       // text search
  let _selectedBag   = null;     // selected v_bag_status row
  let _view          = 'list';   // 'list' | 'detail' | 'restock' | 'templates'
  let _detailContents = [];      // actual contents of the bag shown in detail (2026-07-12)

  // Restock flow state
  let _restockBag    = null;     // selected bag row for restock
  let _shoppingList  = [];       // AppBags.buildShoppingList() result
  let _restockRefId  = null;     // single UUID per restock session (shared across items)
  let _restockPhoto  = null;     // Cloudinary URL from advisory photo (null = skipped)

  // =========================================================================
  // Init (called once by admin-shell lazy init)
  // =========================================================================
  async function initBagsTab() {
    if (_mounted) { await _loadBagList(); return; }
    _mounted = true;

    const root = document.getElementById('tab-bags');
    if (!root) return;

    _renderShell(root);
    await _loadBagList();
  }

  // =========================================================================
  // Shell HTML
  // =========================================================================
  function _renderShell(root) {
    root.innerHTML = `
      <style>
        .badge-stock-expiring { background-color: #fd7e14; color: #fff; }
        .bag-card { cursor: pointer; transition: box-shadow .15s; }
        .bag-card:hover { box-shadow: 0 0 0 2px var(--bs-primary); }
        .progress-bar-bag { transition: width .4s; }
      </style>

      <!-- Summary strip -->
      <div class="row g-2 mb-3" id="bags-summary-strip">
        ${['complete','low_stock','expiring','expired'].map((lvl) => {
          const badge = window.AppBags?.getAlertBadge(lvl) || { cssClass:'bg-secondary text-white', label: lvl };
          return `<div class="col-3">
            <button class="btn w-100 p-2 border summary-filter-btn" data-level="${lvl}" style="min-height:64px">
              <span class="badge ${badge.cssClass} d-block mb-1" id="bags-count-${lvl}">…</span>
              <small class="d-block text-muted" style="font-size:11px">${badge.label}</small>
            </button>
          </div>`;
        }).join('')}
      </div>

      <!-- Filter bar -->
      <div class="row g-2 mb-3 align-items-center">
        <div class="col-auto">
          <select class="form-select form-select-sm" id="bags-filter-level">
            <option value="">สถานะ: ทั้งหมด</option>
            <option value="complete">สมบูรณ์</option>
            <option value="low_stock">ของไม่ครบ</option>
            <option value="expiring">ใกล้หมดอายุ</option>
            <option value="expired">หมดอายุ</option>
            <option value="no_template">ไม่มีเทมเพลต</option>
          </select>
        </div>
        <div class="col">
          <input type="search" class="form-control form-control-sm" id="bags-search"
                 placeholder="🔍 ค้นรหัส / ชื่อกระเป๋า">
        </div>
        <div class="col-auto">
          <button class="btn btn-sm btn-outline-secondary" id="bags-refresh-btn">
            <i class="bi bi-arrow-clockwise"></i>
          </button>
        </div>
      </div>

      <!-- Action buttons -->
      <div class="d-flex gap-2 mb-3 flex-wrap">
        <button class="btn btn-sm btn-stock-primary" id="bags-btn-add">
          <i class="bi bi-plus-lg me-1"></i>เพิ่มกระเป๋ายา
        </button>
        <button class="btn btn-sm btn-outline-secondary" id="bags-btn-templates">
          <i class="bi bi-clipboard-list me-1"></i>จัดการเทมเพลต
        </button>
      </div>

      <!-- Main content area: list | detail | restock | templates -->
      <div id="bags-content-area"></div>`;

    // Wire summary strip filter buttons
    root.querySelectorAll('.summary-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lvl = btn.dataset.level;
        _filterLevel = (_filterLevel === lvl) ? null : lvl;
        document.getElementById('bags-filter-level').value = _filterLevel || '';
        _applyFilter();
      });
    });

    root.querySelector('#bags-filter-level').addEventListener('change', (ev) => {
      _filterLevel = ev.target.value || null;
      _applyFilter();
    });

    let _searchTimer;
    root.querySelector('#bags-search').addEventListener('input', (ev) => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => { _filterSearch = ev.target.value.trim(); _applyFilter(); }, 250);
    });

    root.querySelector('#bags-refresh-btn').addEventListener('click', () => _loadBagList());

    root.querySelector('#bags-btn-add').addEventListener('click', _openAddBagModal);
    root.querySelector('#bags-btn-templates').addEventListener('click', _showTemplatesView);
  }

  // =========================================================================
  // Load + render bag list
  // =========================================================================
  async function _loadBagList() {
    // Update summary counts
    const { data: counts } = await window.AppBags.getBagCounts();
    if (counts) {
      ['complete','low_stock','expiring','expired'].forEach((lvl) => {
        const el = document.getElementById('bags-count-' + lvl);
        if (el) el.textContent = counts[lvl] ?? 0;
      });
    }

    const { data, error } = await window.AppBags.listBagStatus({ activeOnly: true });
    if (error) {
      _toast('error', 'โหลดข้อมูลกระเป๋ายาไม่สำเร็จ');
      return;
    }
    _bags = data || [];
    _showListView();
  }

  // =========================================================================
  // View: Bag list
  // =========================================================================
  function _showListView() {
    _view = 'list';
    _applyFilter();
  }

  function _applyFilter() {
    const filtered = _bags.filter((bag) => {
      if (_filterLevel && bag.alert_level !== _filterLevel) return false;
      if (_filterSearch) {
        const q = _filterSearch.toLowerCase();
        if (!bag.bag_code.toLowerCase().includes(q) &&
            !(bag.bag_name || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
    _renderBagList(filtered);
  }

  function _renderBagList(bags) {
    const area = document.getElementById('bags-content-area');
    if (!area) return;

    if (!bags.length) {
      area.innerHTML = `
        <div class="text-center text-muted py-5">
          <i class="bi bi-bag-x" style="font-size:2.5rem;"></i>
          <p class="mt-2">${_filterLevel || _filterSearch ? 'ไม่มีกระเป๋าตามเงื่อนไขที่เลือก' : 'ยังไม่มีกระเป๋ายา — เพิ่มกระเป๋าแรกได้เลย'}</p>
          ${(_filterLevel || _filterSearch) ? `<button class="btn btn-sm btn-link" id="bags-clear-filter">ล้างตัวกรอง</button>` : ''}
        </div>`;
      area.querySelector('#bags-clear-filter')?.addEventListener('click', () => {
        _filterLevel = null; _filterSearch = '';
        document.getElementById('bags-filter-level').value = '';
        document.getElementById('bags-search').value = '';
        _applyFilter();
      });
      return;
    }

    area.innerHTML = `<div class="row g-3" id="bags-card-list">` +
      bags.map((bag) => _renderBagCard(bag)).join('') +
      `</div>`;

    area.querySelectorAll('[data-bag-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const bag = _bags.find((b) => b.location_id === el.dataset.bagId);
        if (bag) _showDetailView(bag);
      });
    });

    // Row-level print buttons — stop propagation so the card click does not fire.
    area.querySelectorAll('.bag-print-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const code = btn.dataset.bagCode;
        const name = btn.dataset.bagName;
        if (window.QRPrint) {
          window.QRPrint.single(code, {
            size:       '50x50',
            label:      code,
            subtitle:   name,
            entityType: 'bag',
          });
        } else {
          alert('โมดูล QR ยังไม่โหลด — รีเฟรชหน้าใหม่');
        }
      });
    });
  }

  function _renderBagCard(bag) {
    const badge  = window.AppBags.getAlertBadge(bag.alert_level);
    const pct    = bag.completion_pct ?? null;
    const barCls = pct === null ? 'bg-secondary' : pct === 100 ? 'bg-success' : pct >= 70 ? 'bg-warning' : 'bg-danger';
    const expiry = window.AppBags.formatThaiDate(bag.nearest_expiry);

    return `
      <div class="col-12 col-md-6 col-lg-4">
        <div class="card bag-card h-100" data-bag-id="${_esc(bag.location_id)}" tabindex="0"
             role="button" aria-label="กระเป๋า ${_esc(bag.bag_code)}">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-start mb-1">
              <span class="fw-bold">${_esc(bag.bag_code)}</span>
              <span class="badge ${badge.cssClass}">${badge.label}</span>
            </div>
            <p class="text-muted small mb-2">${_esc(bag.bag_name || '')}</p>
            ${bag.template_name
              ? `<p class="small mb-2">เทมเพลต: <span class="text-muted">${_esc(bag.template_name)}</span></p>`
              : `<p class="small text-muted mb-2">ไม่มีเทมเพลต</p>`}
            ${pct !== null ? `
              <div class="progress mb-1" style="height:8px;"
                   role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
                   aria-label="ความสมบูรณ์ ${pct}%">
                <div class="progress-bar progress-bar-bag ${barCls}" style="width:${pct}%"></div>
              </div>
              <small class="text-muted">${pct}% สมบูรณ์${bag.mandatory_deficit_count > 0 ? ` — ขาด ${bag.mandatory_deficit_count} รายการบังคับ` : ''}</small>
            ` : ''}
            ${bag.nearest_expiry ? `<p class="small text-muted mt-1 mb-0">หมดอายุใกล้สุด: ${expiry}</p>` : ''}
            <div class="d-flex justify-content-between align-items-center mt-2">
              <button class="btn btn-sm btn-link text-stock-accent bag-print-btn"
                      data-bag-code="${_esc(bag.bag_code)}"
                      data-bag-name="${_esc(bag.bag_name || bag.template_name || '')}"
                      aria-label="บันทึก QR ${_esc(bag.bag_code)}" title="บันทึก QR เป็น PNG"
                      style="min-width:44px;min-height:44px;">🖨️</button>
              <span class="text-primary small">ดูรายละเอียด →</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  // =========================================================================
  // View: Bag detail drawer
  // =========================================================================
  async function _showDetailView(bag) {
    _view       = 'detail';
    _selectedBag = bag;
    const area  = document.getElementById('bags-content-area');
    if (!area) return;

    const badge = window.AppBags.getAlertBadge(bag.alert_level);

    area.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button class="btn btn-sm btn-outline-secondary me-2" id="bags-detail-back">
          <i class="bi bi-arrow-left"></i> กลับ
        </button>
        <h5 class="mb-0 me-2">${_esc(bag.bag_code)}</h5>
        <span class="badge ${badge.cssClass}">${badge.label}</span>
      </div>
      <p class="text-muted">${_esc(bag.bag_name || '')}</p>
      ${bag.template_name
        ? `<p class="small">เทมเพลต: <strong>${_esc(bag.template_name)}</strong> (${_esc(bag.template_code || '')})</p>`
        : `<div class="alert alert-warning small" id="bags-no-tpl-box">
             กระเป๋านี้ยังไม่มีเทมเพลต — เทมเพลตคือรายการ "ของที่ควรมี" ไว้เช็คครบ/ขาด
             (ของที่อยู่ในกระเป๋าจริงแสดงด้านล่างเสมอ)
             <div class="d-flex gap-2 mt-2 flex-wrap align-items-center">
               <select id="bags-assign-tpl-select" class="form-select form-select-sm" style="max-width:230px;">
                 <option value="">— เลือกเทมเพลตที่มีอยู่ —</option>
               </select>
               <button class="btn btn-sm btn-stock-primary" id="bags-assign-tpl-btn">ใช้เทมเพลตนี้</button>
               <button class="btn btn-sm btn-outline-secondary" id="bags-create-tpl-btn">
                 <i class="bi bi-magic me-1"></i>สร้างเทมเพลตจากของในกระเป๋า
               </button>
             </div>
           </div>`}

      ${bag.completion_pct !== null ? `
      <div class="mb-3">
        <div class="d-flex justify-content-between mb-1">
          <small class="fw-semibold">ความสมบูรณ์</small>
          <small>${bag.completion_pct}%${bag.mandatory_deficit_count > 0 ? ` (ขาด ${bag.mandatory_deficit_count} รายการบังคับ)` : ''}</small>
        </div>
        <div class="progress" style="height:10px;">
          <div class="progress-bar ${bag.completion_pct === 100 ? 'bg-success' : bag.completion_pct >= 70 ? 'bg-warning' : 'bg-danger'}"
               style="width:${bag.completion_pct}%"></div>
        </div>
      </div>` : ''}

      <div id="bags-detail-composition">
        <div class="text-center text-muted py-3"><span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…</div>
      </div>

      <div id="bags-detail-actual" class="mt-3"></div>

      <div id="bags-detail-lots" class="mt-3"></div>

      <div class="mt-3">
        <button class="btn btn-stock-primary w-100" id="bags-btn-restock" style="min-height:52px;">
          <i class="bi bi-plus-circle me-1"></i> เติมของ (Restock)
        </button>
      </div>`;

    area.querySelector('#bags-detail-back').addEventListener('click', () => _showListView());
    area.querySelector('#bags-btn-restock').addEventListener('click', () => _startRestockFlow(bag));

    // Load composition (template checklist)
    let compItemIds = null;
    if (bag.bag_template_id) {
      const { data: comp, error } = await window.AppBags.getBagComposition(bag.location_id, bag.bag_template_id);
      if (error) {
        document.getElementById('bags-detail-composition').innerHTML =
          `<div class="alert alert-danger small">โหลดรายการไม่สำเร็จ</div>`;
      } else {
        _renderComposition(comp || []);
        compItemIds = new Set((comp || []).map((r) => r.item_id));
        await _loadBagLotsSection(bag.location_id);
      }
    } else {
      document.getElementById('bags-detail-composition').innerHTML = '';
      _initNoTemplateActions(bag);
    }

    // Actual contents — always shown, template or not (2026-07-12: items moved
    // into a template-less bag were invisible in this view).
    await _loadActualContents(bag, compItemIds);
  }

  /**
   * "ของในกระเป๋าตอนนี้" — the physical truth from stock_item_locations.
   * No template → full list. With template → only the EXTRA items that are
   * not part of the checklist (the checklist table already shows the rest).
   */
  async function _loadActualContents(bag, compItemIds) {
    const el = document.getElementById('bags-detail-actual');
    if (!el) return;

    const { data, error } = await window.AppBags.getBagActualContents(bag.location_id);
    if (error) { el.innerHTML = ''; return; }   // fail-soft: section is additive

    // Cache for the "สร้างเทมเพลตจากของในกระเป๋า" shortcut (even when empty).
    _detailContents = data || [];

    let rows = data || [];
    let heading = '🎒 ของในกระเป๋าตอนนี้';
    if (compItemIds) {
      rows = rows.filter((r) => !compItemIds.has(r.item_id));
      if (!rows.length) { el.innerHTML = ''; return; }
      heading = '➕ ของอื่นในกระเป๋า (นอกเทมเพลต)';
    } else if (!rows.length) {
      el.innerHTML = `<h6>🎒 ของในกระเป๋าตอนนี้</h6>
        <p class="text-muted small">กระเป๋าว่าง — ยังไม่มีของข้างใน
        (ย้ายของเข้ากระเป๋าได้จากหน้าสแกน: สแกนสินค้า → ย้าย → ปลายทางเป็นกระเป๋านี้)</p>`;
      return;
    }

    el.innerHTML = `
      <h6>${heading} <span class="text-muted small fw-normal">(${rows.length} รายการ)</span></h6>
      <div class="table-responsive">
        <table class="table table-sm table-bordered align-middle">
          <thead class="table-light"><tr><th>สินค้า</th><th class="text-center" style="width:110px">จำนวน</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td><small><code>${_esc(r.stock_items?.sku || '')}</code> ${_esc(r.stock_items?.name || '')}</small></td>
                <td class="text-center"><small>${_esc(String(r.qty))} ${_esc(r.stock_items?.unit || 'ชิ้น')}</small></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  /**
   * No-template actions in the detail view (2026-07-12): assign an existing
   * template, or create one prefilled from the bag's actual contents — then
   * auto-link it to this bag. Ends the "กดเพิ่มเทมเพลตแล้วไปต่อไม่ถูก" dead end.
   */
  async function _initNoTemplateActions(bag) {
    const sel = document.getElementById('bags-assign-tpl-select');
    const assignBtn = document.getElementById('bags-assign-tpl-btn');
    const createBtn = document.getElementById('bags-create-tpl-btn');
    if (!sel || !assignBtn || !createBtn) return;

    const { data: tpls } = await window.AppBags.listTemplates({ activeOnly: true });
    (tpls || []).forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.code} — ${t.name}`;
      sel.appendChild(opt);
    });

    async function _assignAndRefresh(templateId) {
      const { error } = await window.AppBags.assignTemplateToBag(bag.location_id, templateId);
      if (error) {
        _toast('error', 'ผูกเทมเพลตไม่สำเร็จ: ' + (error.message || ''));
        return;
      }
      _toast('success', 'ผูกเทมเพลตกับกระเป๋าแล้ว');
      // Re-read v_bag_status so the detail view reflects the new checklist.
      const fresh = await window.AppBags.getBagStatus(bag.location_id);
      if (fresh?.data) {
        const i = _bags.findIndex((b) => b.location_id === bag.location_id);
        if (i >= 0) _bags[i] = fresh.data;
        _showDetailView(fresh.data);
      } else {
        _loadBagList();
      }
    }

    assignBtn.addEventListener('click', () => {
      if (!sel.value) { _toast('warning', 'เลือกเทมเพลตก่อน'); return; }
      _assignAndRefresh(sel.value);
    });

    createBtn.addEventListener('click', () => {
      if (!window.AppBagTemplates?.openCreateForBag) {
        _toast('error', 'โมดูลเทมเพลตไม่ถูกโหลด — รีเฟรชหน้าใหม่');
        return;
      }
      window.AppBagTemplates.openCreateForBag(
        { bag_code: bag.bag_code, bag_name: bag.bag_name },
        _detailContents || [],
        (templateId) => _assignAndRefresh(templateId)
      );
    });
  }

  function _renderComposition(rows) {
    const el = document.getElementById('bags-detail-composition');
    if (!el) return;

    if (!rows.length) {
      el.innerHTML = `<p class="text-muted small">เทมเพลตนี้ยังไม่มีรายการของ</p>`;
      return;
    }

    const rowsHtml = rows.map((r) => {
      let resultHtml;
      if (r.actual_qty >= r.target_qty) {
        resultHtml = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> ครบ</span>`;
      } else if (r.mandatory) {
        const lack = r.target_qty - r.actual_qty;
        resultHtml = `<span class="text-danger fw-bold"><i class="bi bi-x-circle-fill"></i> ขาด ${lack}</span>`;
      } else {
        resultHtml = `<span class="text-secondary"><i class="bi bi-dash"></i> ไม่บังคับ</span>`;
      }
      return `
        <tr class="${r.mandatory && r.deficit > 0 ? 'table-danger' : ''}">
          <td><small>${r.mandatory ? '★' : '○'} ${_esc(r.name)}</small><br><small class="text-muted">${_esc(r.sku)}</small></td>
          <td class="text-center"><small>${r.target_qty}</small></td>
          <td class="text-center"><small>${r.actual_qty}</small></td>
          <td>${resultHtml}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
      <h6>รายการของในกระเป๋า</h6>
      <div class="table-responsive">
        <table class="table table-sm table-bordered align-middle">
          <thead class="table-light">
            <tr><th>ชื่อสินค้า</th><th class="text-center">เป้าหมาย</th><th class="text-center">ปัจจุบัน</th><th>ผล</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
  }

  async function _loadBagLotsSection(locationId) {
    const el = document.getElementById('bags-detail-lots');
    if (!el) return;

    const { data, error } = await window.AppBags.getBagLotsAtLocation(locationId);
    if (error || !data || data.length === 0) {
      el.innerHTML = '';
      return;
    }

    const lotRows = data.filter((l) => l.stock_items?.tracks_lots);
    if (!lotRows.length) { el.innerHTML = ''; return; }

    const getLotBadge = window.AppLots?.getLotBadge || (() => ({ cls: 'bg-secondary', label: '' }));
    const rowsHtml = lotRows.map((l) => {
      const expBadge = getLotBadge(l.expiry_date);
      return `
        <tr>
          <td><small>${_esc(l.stock_items?.name || '')}</small></td>
          <td><small>${_esc(l.lot_number || '')}</small></td>
          <td><small>${window.AppBags.formatThaiDate(l.expiry_date)}<br>
            <span class="badge ${expBadge.cls}">${expBadge.label}</span>
          </small></td>
          <td class="text-center"><small>${l.current_qty}</small></td>
        </tr>`;
    }).join('');

    el.innerHTML = `
      <details>
        <summary class="fw-semibold small text-muted" style="cursor:pointer;">
          ล็อตยาในกระเป๋านี้ (${lotRows.length} ล็อต)
        </summary>
        <div class="table-responsive mt-2">
          <table class="table table-sm table-bordered align-middle">
            <thead class="table-light">
              <tr><th>ชื่อยา</th><th>ล็อต</th><th>วันหมดอายุ</th><th class="text-center">คงเหลือ</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </details>`;
  }

  // =========================================================================
  // View: Restock flow (3 steps)
  // =========================================================================
  async function _startRestockFlow(bag) {
    _restockBag    = bag;
    _restockRefId  = window.AppBags.generateUUID();
    _restockPhoto  = null;

    if (!bag.bag_template_id) {
      _toast('warning', 'กระเป๋านี้ยังไม่มีเทมเพลต — ไม่สามารถเริ่มเติมของได้');
      return;
    }

    const { data: comp, error } = await window.AppBags.getBagComposition(bag.location_id, bag.bag_template_id);
    if (error) { _toast('error', 'โหลดรายการไม่สำเร็จ'); return; }

    _shoppingList = window.AppBags.buildShoppingList(comp || []);

    const noDeficit = _shoppingList.every((r) => r.deficit === 0 && r.mandatory);
    if (_shoppingList.length === 0 || noDeficit) {
      _toast('info', 'กระเป๋านี้สมบูรณ์แล้ว — ไม่จำเป็นต้องเติมของ');
    }

    _renderRestockStep1();
  }

  function _renderRestockStep1() {
    _view = 'restock';
    const area = document.getElementById('bags-content-area');
    if (!area) return;

    const badge = window.AppBags.getAlertBadge(_restockBag.alert_level);

    area.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button class="btn btn-sm btn-outline-secondary me-2" id="restock-cancel-btn">
          <i class="bi bi-x-lg"></i> ยกเลิก
        </button>
        <div>
          <span class="fw-semibold">①รายการ</span>
          <span class="text-muted mx-2">───</span>
          <span class="text-muted">②รูปถ่าย</span>
          <span class="text-muted mx-2">───</span>
          <span class="text-muted">③ยืนยัน</span>
        </div>
      </div>
      <h5>เติมของ: ${_esc(_restockBag.bag_code)}</h5>
      <p class="text-muted mb-3">${_esc(_restockBag.bag_name || '')} <span class="badge ${badge.cssClass}">${badge.label}</span></p>

      <h6>รายการที่ต้องเติม</h6>
      <div id="restock-items-form"></div>

      <div class="mt-3">
        <button class="btn btn-stock-primary w-100" id="restock-next-btn" style="min-height:52px;">
          ถัดไป: ถ่ายรูป →
        </button>
      </div>`;

    area.querySelector('#restock-cancel-btn').addEventListener('click', () => _showDetailView(_restockBag));
    area.querySelector('#restock-next-btn').addEventListener('click', _proceedToStep2);

    _renderRestockItems();
  }

  function _renderRestockItems() {
    const container = document.getElementById('restock-items-form');
    if (!container) return;

    if (!_shoppingList.length) {
      container.innerHTML = `<p class="text-muted">ไม่มีรายการในเทมเพลต</p>`;
      return;
    }

    const html = _shoppingList.map((item, idx) => {
      const deficitLabel = item.deficit > 0 ? `ขาด ${item.deficit}` : 'ครบแล้ว';
      const rowClass     = item.mandatory && item.deficit > 0 ? 'border-danger' : '';

      return `
        <div class="card mb-2 ${rowClass}" id="restock-item-${idx}">
          <div class="card-body py-2">
            <div class="d-flex justify-content-between align-items-start">
              <div>
                <span class="fw-semibold small">${item.mandatory ? '★' : '○'} ${_esc(item.name)}</span>
                <span class="text-muted small ms-1">(${_esc(item.sku)})</span>
              </div>
              <small class="text-muted">${item.actual_qty}/${item.target_qty} — ${deficitLabel}</small>
            </div>

            <div class="row g-2 mt-1 align-items-center">
              <div class="col-auto">
                <label class="form-label small mb-0">จำนวนที่จะเติม</label>
              </div>
              <div class="col" style="max-width:100px;">
                <input type="number" class="form-control form-control-sm restock-qty-input"
                       data-idx="${idx}" min="0" value="${item.restock_qty}"
                       inputmode="numeric" aria-label="จำนวนที่จะเติม">
              </div>
              <div class="col-auto">
                <span class="text-muted small">${_esc(item.unit)}</span>
              </div>
              <div class="col-auto">
                <button class="btn btn-sm btn-outline-secondary restock-skip-btn" data-idx="${idx}">
                  ข้าม
                </button>
              </div>
            </div>

            ${item.tracks_lots ? `
            <div class="mt-2" id="restock-lot-${idx}">
              <label class="form-label small fw-semibold">เลือกล็อต (FEFO)</label>
              <div class="restock-lot-picker" data-idx="${idx}">
                <div class="text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>กำลังโหลดล็อต…</div>
              </div>
            </div>` : ''}

            ${item.skipped ? `<div class="badge bg-secondary mt-1">ข้าม</div>` : ''}
          </div>
        </div>`;
    }).join('');

    container.innerHTML = html;

    // Wire qty inputs
    container.querySelectorAll('.restock-qty-input').forEach((input) => {
      input.addEventListener('input', () => {
        const idx = parseInt(input.dataset.idx, 10);
        _shoppingList[idx].restock_qty = Math.max(0, parseInt(input.value || '0', 10));
        _shoppingList[idx].skipped     = false;
      });
    });

    // Wire skip buttons
    container.querySelectorAll('.restock-skip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        _shoppingList[idx].restock_qty = 0;
        _shoppingList[idx].skipped     = true;
        const qtyInput = container.querySelector(`.restock-qty-input[data-idx="${idx}"]`);
        if (qtyInput) qtyInput.value = 0;
        btn.textContent = 'ข้ามแล้ว';
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-secondary');
      });
    });

    // Load lot pickers for tracks_lots items
    _shoppingList.forEach((item, idx) => {
      if (!item.tracks_lots) return;
      const pickerEl = container.querySelector(`.restock-lot-picker[data-idx="${idx}"]`);
      if (!pickerEl) return;
      window.AppLots?.fetchAvailableLots(item.item_id).then(({ data: lots, error }) => {
        if (error || !lots || lots.length === 0) {
          pickerEl.innerHTML = `<p class="text-muted small">ไม่มีล็อตที่ใช้ได้ — ต้องรับเข้าคลังก่อน</p>`;
          return;
        }
        // Render radio group (FEFO — first lot is pre-selected)
        const lotHtml = lots.map((lot, li) => {
          const expBadge = window.AppLots?.getLotBadge(lot.expiry_date) || { cls: '', label: '' };
          const checked  = li === 0 ? 'checked' : '';
          return `
            <div class="form-check">
              <input class="form-check-input restock-lot-radio" type="radio"
                     name="lot-${idx}" id="lot-${idx}-${li}" value="${_esc(lot.id)}"
                     data-idx="${idx}" ${checked}>
              <label class="form-check-label small" for="lot-${idx}-${li}">
                ${_esc(lot.lot_number || '')}
                วันหมดอายุ ${window.AppBags.formatThaiDate(lot.expiry_date)}
                เหลือ ${lot.current_qty}
                <span class="badge ${expBadge.cls}">${expBadge.label}</span>
              </label>
            </div>`;
        }).join('');
        pickerEl.innerHTML = lotHtml;
        // Pre-select FEFO lot
        if (lots[0]) _shoppingList[idx].selected_lot_id = lots[0].id;

        pickerEl.querySelectorAll('.restock-lot-radio').forEach((radio) => {
          radio.addEventListener('change', () => {
            _shoppingList[parseInt(radio.dataset.idx, 10)].selected_lot_id = radio.value;
          });
        });
      });
    });
  }

  function _proceedToStep2() {
    // Check if at least one item has restock_qty > 0
    const hasItems = _shoppingList.some((r) => r.restock_qty > 0);
    if (!hasItems) {
      _toast('warning', 'กรุณากรอกจำนวนสำหรับอย่างน้อยหนึ่งรายการ หรือข้ามทั้งหมด');
      return;
    }
    _renderRestockStep2();
  }

  function _renderRestockStep2() {
    const area = document.getElementById('bags-content-area');
    if (!area) return;

    area.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button class="btn btn-sm btn-outline-secondary me-2" id="restock-step2-back">
          <i class="bi bi-arrow-left"></i> กลับ
        </button>
        <div>
          <span class="text-muted">①รายการ ✓</span>
          <span class="text-muted mx-2">───</span>
          <span class="fw-semibold">②รูปถ่าย</span>
          <span class="text-muted mx-2">───</span>
          <span class="text-muted">③ยืนยัน</span>
        </div>
      </div>
      <h5>ถ่ายรูปกระเป๋าหลังเติมของ (ไม่บังคับ)</h5>
      <p class="text-muted small">ถ่ายรูปเป็นหลักฐานการเติมของ หรือกด "ข้าม" เพื่อดำเนินการต่อ</p>

      <div class="d-flex gap-2 mt-3">
        <button class="btn btn-outline-primary" id="restock-photo-btn">
          <i class="bi bi-camera me-1"></i>เปิดกล้องถ่ายรูป
        </button>
        <button class="btn btn-outline-secondary" id="restock-photo-skip">
          ข้าม — ไม่ถ่ายรูป
        </button>
      </div>

      <div id="restock-photo-preview" class="mt-3"></div>`;

    area.querySelector('#restock-step2-back').addEventListener('click', _renderRestockStep1);

    // Advisory photo via PhotoCaptureModal (Q-Phase4-D)
    area.querySelector('#restock-photo-btn').addEventListener('click', () => {
      if (!window.PhotoCaptureModal) {
        _toast('warning', 'ไม่สามารถเปิดกล้องได้ในขณะนี้');
        _renderRestockStep3();
        return;
      }
      window.PhotoCaptureModal.open({
        folder:    'thegood-stock/bag-restock/' + _restockBag.bag_code + '/' + _restockRefId,
        label:     'ถ่ายรูปกระเป๋าหลังเติมของ',
        optional:  true,
        entityId:  _restockRefId,
        onUploaded: (url) => {
          _restockPhoto = url;
          const prev = document.getElementById('restock-photo-preview');
          if (prev) prev.innerHTML = `<img src="${_esc(url)}" class="img-thumbnail" style="max-width:200px;" alt="รูปกระเป๋า">`;
          _toast('success', 'อัปโหลดรูปสำเร็จ');
          _renderRestockStep3();
        },
        onSkipped: () => {
          _restockPhoto = null;
          _renderRestockStep3();
        },
        onError: (msg) => {
          _toast('warning', 'อัปโหลดรูปไม่สำเร็จ — ดำเนินการต่อโดยไม่มีรูป');
          _restockPhoto = null;
          _renderRestockStep3();
        },
      });
    });

    area.querySelector('#restock-photo-skip').addEventListener('click', () => {
      _restockPhoto = null;
      _renderRestockStep3();
    });
  }

  function _renderRestockStep3() {
    const area = document.getElementById('bags-content-area');
    if (!area) return;

    const toRestock = _shoppingList.filter((r) => r.restock_qty > 0);
    const toSkip    = _shoppingList.filter((r) => r.restock_qty === 0 || r.skipped);

    area.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button class="btn btn-sm btn-outline-secondary me-2" id="restock-step3-back">
          <i class="bi bi-arrow-left"></i> แก้ไขรายการ
        </button>
        <div>
          <span class="text-muted">①รายการ ✓</span>
          <span class="text-muted mx-2">───</span>
          <span class="text-muted">②รูปถ่าย ✓</span>
          <span class="text-muted mx-2">───</span>
          <span class="fw-semibold">③ยืนยัน</span>
        </div>
      </div>
      <h5>สรุปการเติมของ</h5>
      <p class="text-muted small">กระเป๋า: <strong>${_esc(_restockBag.bag_code)}</strong> — ${_esc(_restockBag.bag_name || '')}</p>
      ${_restockPhoto ? `<img src="${_esc(_restockPhoto)}" class="img-thumbnail mb-2" style="max-width:160px;" alt="รูปกระเป๋า">` : '<p class="text-muted small">ไม่มีรูปถ่าย</p>'}

      <h6>รายการที่จะเติม (${toRestock.length} รายการ)</h6>
      <ul class="list-group list-group-flush mb-3">
        ${toRestock.map((r) => `
          <li class="list-group-item py-2 d-flex justify-content-between align-items-center">
            <span class="small">${r.mandatory ? '★' : '○'} ${_esc(r.name)}</span>
            <span>
              <span class="badge bg-primary">+${r.restock_qty} ${_esc(r.unit)}</span>
              ${r.selected_lot_id ? `<span class="badge bg-secondary ms-1">ล็อต</span>` : ''}
            </span>
          </li>`).join('')}
      </ul>

      ${toSkip.length ? `
      <h6>รายการข้าม (${toSkip.length} รายการ)</h6>
      <ul class="list-group list-group-flush mb-3">
        ${toSkip.map((r) => `
          <li class="list-group-item py-1 text-muted small">
            ○ ${_esc(r.name)} — [ข้าม]
          </li>`).join('')}
      </ul>` : ''}

      <button class="btn btn-stock-primary w-100 mt-2" id="restock-confirm-btn" style="min-height:52px;">
        <i class="bi bi-check2-circle me-1"></i>ยืนยันการเติมของ
      </button>
      <p class="text-muted small text-center mt-1" id="restock-progress-text"></p>

      <div id="restock-result-list" class="mt-3"></div>`;

    area.querySelector('#restock-step3-back').addEventListener('click', _renderRestockStep2);
    area.querySelector('#restock-confirm-btn').addEventListener('click', _submitRestock);
  }

  async function _submitRestock() {
    const btn       = document.getElementById('restock-confirm-btn');
    const progText  = document.getElementById('restock-progress-text');
    const resultEl  = document.getElementById('restock-result-list');

    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก…';

    const toRestock = _shoppingList.filter((r) => r.restock_qty > 0);
    let successCount = 0;
    let failCount    = 0;
    const failures   = [];

    for (let i = 0; i < toRestock.length; i++) {
      const item = toRestock[i];
      if (progText) progText.textContent = `กำลังบันทึก ${i + 1}/${toRestock.length}…`;

      const { error, alreadyPosted } = await window.AppBags.submitRestockItem({
        location_id:    _restockBag.location_id,
        item_id:        item.item_id,
        qty_delta:      item.restock_qty,
        lot_id:         item.selected_lot_id || null,
        bag_code:       _restockBag.bag_code,
        restock_ref_id: _restockRefId,
        client_ref_id:  window.AppBags.generateUUID(),
        note:           'bag:' + _restockBag.bag_code + ':restock:' + _restockRefId +
                        (_restockPhoto ? ':photo:' + _restockPhoto : ''),
      });

      if (error && !alreadyPosted) {
        failCount++;
        failures.push({ name: item.name, error: error.message || 'ไม่ทราบสาเหตุ' });
      } else {
        successCount++;
      }
    }

    if (progText) progText.textContent = '';

    if (failCount === 0) {
      _toast('success', `เติมของเสร็จสิ้น — ${successCount} รายการ`);
      // Reload bag status and return to detail
      const { data: refreshed } = await window.AppBags.getBagStatus(_restockBag.location_id);
      if (refreshed) _restockBag = refreshed;
      setTimeout(() => _showDetailView(_restockBag), 1000);
    } else {
      _toast('warning', `เติมของบางส่วน — สำเร็จ ${successCount}, ล้มเหลว ${failCount}`);
      if (resultEl) {
        resultEl.innerHTML = `
          <div class="alert alert-warning small">
            <strong>รายการที่ล้มเหลว:</strong><br>
            ${failures.map((f) => `${_esc(f.name)}: ${_esc(f.error)}`).join('<br>')}
          </div>
          <button class="btn btn-sm btn-outline-primary" id="restock-retry-btn">
            ลองใหม่สำหรับรายการที่ล้มเหลว
          </button>`;
        resultEl.querySelector('#restock-retry-btn')?.addEventListener('click', () => {
          // Re-filter shopping list to only failed items and re-submit
          _shoppingList = _shoppingList.filter((r) =>
            failures.some((f) => f.name === r.name) && r.restock_qty > 0
          );
          _submitRestock();
        });
      }
      btn.disabled = false;
      btn.innerHTML = `<i class="bi bi-check2-circle me-1"></i>ยืนยันการเติมของ`;
    }

    // Refresh bag list in background
    await _loadBagList();
  }

  // =========================================================================
  // View: Template management panel
  // =========================================================================
  function _showTemplatesView() {
    _view = 'templates';
    const area = document.getElementById('bags-content-area');
    if (!area) return;

    area.innerHTML = `
      <button class="btn btn-sm btn-outline-secondary mb-3" id="tpl-back-btn">
        <i class="bi bi-arrow-left"></i> กลับ (ALS Bags)
      </button>
      <div id="tpl-panel-root"></div>`;

    area.querySelector('#tpl-back-btn').addEventListener('click', _showListView);

    if (window.AppBagTemplates?.renderPanel) {
      window.AppBagTemplates.renderPanel(area.querySelector('#tpl-panel-root'));
    } else {
      area.querySelector('#tpl-panel-root').innerHTML =
        `<div class="alert alert-danger">bag-templates.js ไม่ถูกโหลด</div>`;
    }
  }

  // =========================================================================
  // Add bag location modal (reuses existing Locations tab pattern)
  // =========================================================================
  function _openAddBagModal() {
    // Delegate to the Locations tab if it exposes a create modal
    if (window.AppLocationsTab?.openCreateModal) {
      window.AppLocationsTab.openCreateModal({ preset_type: 'bag' });
    } else {
      _toast('info', 'ไปที่แท็บ Locations เพื่อเพิ่มกระเป๋ายาใหม่ (type=bag)');
    }
  }

  // =========================================================================
  // Public namespace
  // =========================================================================
  /**
   * Pre-apply a filter (called from dashboard panel tap — §9.2).
   * @param {string} level  alert_level value
   */
  function setFilter(level) {
    _filterLevel = level || null;
    const sel = document.getElementById('bags-filter-level');
    if (sel) sel.value = _filterLevel || '';
    _applyFilter();
  }

  window.AppBagsTab   = { initBagsTab, reload: _loadBagList, setFilter };
  window.initBagsTab  = initBagsTab;
})();
