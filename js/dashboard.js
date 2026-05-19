// js/dashboard.js
// Phase 1 + Phase 2 — Admin Dashboard tab controller.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-18-phase1-inventory-design.md   §1 (dashboard line), §7.3, §3 row 7
//   docs/superpowers/designs/2026-05-18-phase1-ui-design.md        §4 Area 3 (4.3 wireframes, 4.4 states, 4.5 microcopy)
//   docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md     Phase F → Task F2
//   docs/superpowers/plans/2026-05-19-phase2-medication-plan.md    Task B4b
//   docs/superpowers/designs/2026-05-18-phase2-ui-design.md        §3.5, §6.7 (M-67..M-79)
//
// Locked decisions (PM Pex 2026-05-18/19 — DO NOT re-debate):
//   Q1: NO Transfer modal — irrelevant here anyway
//   Q2: NO Chart.js — category breakdown is plain text/badge list (design §4.4.3 fallback)
//   Q3: NO photo upload — irrelevant here anyway
//
// Upstream APIs consumed:
//   AppInventory.listItems, listCategories, getLowStock, getItem, subscribeInventory (via window.AppInventory)
//   Phase 2 — reads stock_lots directly via getSupabaseClient() for the expiry timeline panel.
//   AppUi: showToast, escapeHtml (globals from shared/ui.js)
//   AppLots.getExpiryBucket (window.AppLots from shared/lots.js — Phase 2, lazy-loaded)
//
// Public namespace: window.AppDashboardTab + window.initDashboardTab (called by admin-shell.js)

(function () {
  'use strict';

  // =========================================================================
  // Module state (singleton — tab is mounted once, lazy by admin-shell)
  // =========================================================================
  let _categories     = [];        // categories cache for Panel 1 breakdown lookup
  let _unsubscribe    = null;      // realtime teardown handle
  let _refreshTimer   = null;      // debounce for realtime → reload (300ms per task)
  let _finderTimer    = null;      // debounce for Item Finder input (250ms)
  let _finderActiveIx = -1;        // keyboard nav index inside finder dropdown
  let _finderRequest  = 0;         // monotonic counter to drop stale finder responses
  let _mounted        = false;

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Defensive escapeHtml — mirrors shared/ui.js so render is safe even if load order shifts. */
  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _toast(type, msg) { (window.showToast || (()=>{}))(type, msg); }

  function _catName(id) {
    const c = _categories.find((x) => x.id === id);
    return c ? c.name : '— ไม่ระบุหมวด —';
  }

  // =========================================================================
  // Shell render — spec §1 (dashboard) + design §4.3
  // Layout per design §4.3.2: Item Finder at top, KPI row, then 2x2 panels.
  // =========================================================================
  function _renderShell() {
    const root = document.getElementById('tab-dashboard');
    if (!root) return;

    root.innerHTML = `
      <!-- A. Item Finder (design §4.3.1 first block, always visible) -->
      <div class="card mb-3" id="dash-finder-card">
        <div class="card-body py-3">
          <label class="form-label small text-muted mb-1" for="dash-finder-input">
            <i class="bi bi-search"></i> ค้นหาสินค้า
          </label>
          <div class="position-relative">
            <input id="dash-finder-input" type="search" class="form-control form-control-lg"
                   placeholder="🔍 ค้นหาสินค้า (พิมพ์ชื่อ/SKU/Barcode)..."
                   autocomplete="off" aria-autocomplete="list" aria-controls="dash-finder-results"
                   aria-expanded="false" style="min-height:48px;">
            <div id="dash-finder-spinner" class="position-absolute top-50 end-0 translate-middle-y me-3 d-none"
                 aria-hidden="true">
              <span class="spinner-border spinner-border-sm text-stock-accent"></span>
            </div>
            <!-- Dropdown overlay (design §4.4.1) -->
            <div id="dash-finder-results" class="dropdown-menu w-100 mt-1 shadow"
                 role="listbox" style="max-height:340px; overflow-y:auto; display:none;"></div>
          </div>
        </div>
      </div>

      <!-- B+C. Panel 1 (Current Stock) + Panel 2 (Low Stock) — top row on desktop -->
      <div class="row g-3">
        <!-- Panel 1 — Current Stock (live) — design §4.4.2 + §4.4.3 fallback list -->
        <div class="col-12 col-md-6">
          <div class="card h-100" id="dash-panel-stock" aria-busy="true">
            <div class="card-body">
              <h6 class="card-title text-muted mb-3">
                <i class="bi bi-box-seam"></i> สต็อกคงเหลือทั้งหมด
              </h6>
              <div id="dash-stock-body" class="text-center text-muted py-3">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>

        <!-- Panel 2 — Low Stock (live) — design §4.4.4 -->
        <div class="col-12 col-md-6">
          <div class="card h-100 border-warning" id="dash-panel-low" aria-busy="true">
            <div class="card-body d-flex flex-column">
              <h6 class="card-title text-muted mb-3 d-flex align-items-center">
                <span class="me-auto"><i class="bi bi-exclamation-triangle text-warning"></i> สินค้าใกล้หมด</span>
                <span id="dash-low-count" class="badge bg-warning text-dark" aria-live="polite">…</span>
              </h6>
              <div id="dash-low-body" class="flex-grow-1 text-center text-muted py-3"
                   style="max-height:300px; overflow-y:auto;">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- D+E. Panel 3 + Panel 4 placeholders — design §4.4.5 -->
      <div class="row g-3 mt-1">
        <!-- Panel 3 — Expiry timeline (Phase 2 — replaces "เปิดใช้งานใน Phase 2" placeholder) -->
        <div class="col-12 col-md-6">
          <div class="card h-100" id="dash-panel-expiry" aria-busy="true">
            <div class="card-header d-flex justify-content-between align-items-center">
              <span><i class="bi bi-clock-history"></i> ภาพรวมวันหมดอายุ</span>
              <small class="text-muted" id="dash-expiry-updated">—</small>
            </div>
            <div id="dash-expiry-body" class="card-body p-0">
              <div class="text-center text-muted py-4">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>

        <!-- Panel 4 — Borrow/Return status (Phase 3 live) -->
        <div class="col-12 col-md-6">
          <div class="card h-100" id="dash-panel-loans" aria-busy="true">
            <div class="card-header d-flex justify-content-between align-items-center">
              <span><i class="bi bi-arrow-left-right"></i> สถานะอุปกรณ์ยืม-คืน</span>
              <small class="text-muted" id="dash-loans-updated">—</small>
            </div>
            <div id="dash-loans-body" class="card-body p-0">
              <div class="text-center text-muted py-4">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- F. Legacy Phase 0 status block, collapsed by default (ops continuity per task brief option) -->
      <div class="card mt-3 border-stock-accent">
        <div class="card-body py-2">
          <button class="btn btn-link p-0 text-decoration-none text-stock-accent w-100 text-start"
                  type="button" data-bs-toggle="collapse" data-bs-target="#dash-sysstatus"
                  aria-expanded="false" aria-controls="dash-sysstatus">
            <i class="bi bi-chevron-right"></i> 📋 System status (Phase 0 foundation)
          </button>
          <div id="dash-sysstatus" class="collapse mt-2">
            <ul class="list-unstyled small mb-0" id="dash-status-list">
              <li class="text-muted">กำลังตรวจสอบ…</li>
            </ul>
          </div>
        </div>
      </div>
    `;

    // Wire Item Finder
    const input = document.getElementById('dash-finder-input');
    input.addEventListener('input', _onFinderInput);
    input.addEventListener('keydown', _onFinderKeyDown);
    input.addEventListener('blur', () => {
      // Defer close so a result click still fires
      setTimeout(_closeFinderDropdown, 150);
    });
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 1) _onFinderInput();
    });

    // Wire collapse chevron rotation (cosmetic)
    const collapseEl = document.getElementById('dash-sysstatus');
    collapseEl.addEventListener('shown.bs.collapse', () => {
      const i = collapseEl.parentElement.querySelector('.bi-chevron-right, .bi-chevron-down');
      if (i) i.className = i.className.replace('bi-chevron-right', 'bi-chevron-down');
    });
    collapseEl.addEventListener('hidden.bs.collapse', () => {
      const i = collapseEl.parentElement.querySelector('.bi-chevron-down, .bi-chevron-right');
      if (i) i.className = i.className.replace('bi-chevron-down', 'bi-chevron-right');
    });
  }

  // =========================================================================
  // Panel 1 — Current Stock (live) — design §4.4.2 + §4.4.3 fallback list
  //
  // Renders:
  //   • Large total active items count
  //   • Total qty across all locations (sum of stock_item_locations.qty for active items,
  //     surfaced as `total_qty` on each item row from AppInventory.listItems)
  //   • Category breakdown — plain badge list (NO chart, Q2 locked)
  // =========================================================================
  async function _loadPanelStock() {
    const body = document.getElementById('dash-stock-body');
    const card = document.getElementById('dash-panel-stock');
    if (!body) return;

    const r = await window.AppInventory.listItems({ activeOnly: true, limit: 500 });
    if (r.error) {
      body.innerHTML = `<div class="text-danger small">โหลดข้อมูลไม่สำเร็จ</div>`;
      card?.setAttribute('aria-busy', 'false');
      _toast('error', 'โหลดสต็อกไม่สำเร็จ');
      return;
    }
    const items = r.data || [];

    if (!items.length) {
      // Empty state copy from design §4.5
      body.innerHTML = `
        <div class="text-muted py-2">ยังไม่มีสินค้า — เริ่มที่แท็บ Inventory</div>
      `;
      card?.setAttribute('aria-busy', 'false');
      return;
    }

    const totalItems = items.length;
    const totalQty   = items.reduce((acc, it) => acc + (it.total_qty || 0), 0);

    // Aggregate qty + item count by category_id (null = ไม่ระบุหมวด)
    const byCat = new Map();
    for (const it of items) {
      const key = it.category_id || '__none__';
      if (!byCat.has(key)) byCat.set(key, { count: 0, qty: 0 });
      const agg = byCat.get(key);
      agg.count += 1;
      agg.qty   += (it.total_qty || 0);
    }

    // Order categories by sort_order (cached), then any unknowns at the end.
    const ordered = [];
    for (const c of _categories) {
      if (byCat.has(c.id)) {
        ordered.push({ id: c.id, name: c.name, ...byCat.get(c.id) });
        byCat.delete(c.id);
      }
    }
    // Anything still in byCat = uncategorized or unknown category
    for (const [key, agg] of byCat.entries()) {
      ordered.push({
        id: key,
        name: key === '__none__' ? 'ไม่ระบุหมวด' : _catName(key),
        ...agg,
      });
    }

    const catList = ordered.map((row) => `
      <li class="d-flex justify-content-between align-items-center py-1 small border-bottom">
        <span class="badge bg-stock-accent-subtle me-2">${_esc(row.name)}</span>
        <span class="text-muted">
          <span class="fw-semibold text-body">${row.count}</span> รายการ
          · รวม <span class="fw-semibold text-body">${row.qty}</span>
        </span>
      </li>
    `).join('');

    body.innerHTML = `
      <div class="row g-2 mb-3 text-center">
        <div class="col-6">
          <div class="text-muted small">สินค้าทั้งหมด</div>
          <h3 class="mb-0 text-stock-accent" aria-label="สินค้าทั้งหมด ${totalItems} รายการ">${totalItems}</h3>
          <div class="small text-muted">รายการ (active)</div>
        </div>
        <div class="col-6">
          <div class="text-muted small">คงเหลือรวม</div>
          <h3 class="mb-0" aria-label="คงเหลือรวมทั้งหมด ${totalQty}">${totalQty}</h3>
          <div class="small text-muted">หน่วยทุกสถานที่</div>
        </div>
      </div>
      <h6 class="small text-muted mb-2">สินค้าตามหมวด</h6>
      <ul class="list-unstyled mb-0">${catList}</ul>
    `;
    card?.setAttribute('aria-busy', 'false');
  }

  // =========================================================================
  // Panel 2 — Low Stock (live) — design §4.4.4
  //
  // Each row: SKU + name + current total qty + threshold + "→ ดู" link
  // Click "→ ดู" → switch to Inventory tab + toggle the low-stock-only filter.
  // =========================================================================
  async function _loadPanelLow() {
    const body  = document.getElementById('dash-low-body');
    const count = document.getElementById('dash-low-count');
    const card  = document.getElementById('dash-panel-low');
    if (!body) return;

    const r = await window.AppInventory.getLowStock();
    if (r.error) {
      body.innerHTML = `<div class="text-danger small">โหลดรายการไม่สำเร็จ</div>`;
      if (count) count.textContent = '!';
      card?.setAttribute('aria-busy', 'false');
      _toast('error', 'โหลดรายการใกล้หมดไม่สำเร็จ');
      return;
    }
    const items = (r.data || []).slice().sort((a, b) => (a.total_qty || 0) - (b.total_qty || 0));
    if (count) count.textContent = `${items.length} รายการ`;

    if (!items.length) {
      // Success empty-state copy (design §4.4.4 / §4.5)
      body.innerHTML = `
        <div class="text-success py-3">
          <i class="bi bi-check-circle-fill" style="font-size:2rem;"></i>
          <div class="mt-2">ไม่มีสินค้าใกล้หมด ✓</div>
          <div class="small text-muted">ทุกอย่างเพียงพอ</div>
        </div>
      `;
      card?.setAttribute('aria-busy', 'false');
      return;
    }

    body.classList.remove('text-center', 'text-muted', 'py-3');
    body.innerHTML = `
      <ul class="list-unstyled mb-0 text-start" aria-label="${items.length} รายการที่ต้องสั่งเพิ่ม">
        ${items.map((it) => {
          const total = it.total_qty || 0;
          const t     = it.reorder_threshold || 0;
          return `
            <li class="py-2 border-bottom d-flex flex-wrap align-items-center gap-2">
              <div class="flex-grow-1" style="min-width:160px;">
                <div class="fw-semibold">${_esc(it.name)}</div>
                <div class="small text-muted">
                  <code>${_esc(it.sku)}</code> · คงเหลือ
                  <span class="text-danger fw-bold">${total}</span>
                  / เกณฑ์ ${t}
                </div>
              </div>
              <button type="button" class="btn btn-sm btn-outline-stock-accent"
                      data-act="goto-inv" data-sku="${_esc(it.sku)}"
                      style="min-height:36px;">
                → ดู
              </button>
            </li>
          `;
        }).join('')}
      </ul>
    `;
    card?.setAttribute('aria-busy', 'false');

    // Wire "→ ดู" click — switch to Inventory tab and pre-filter to clicked SKU (P7 B6).
    body.querySelectorAll('[data-act="goto-inv"]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const sku = btn.dataset.sku || '';
        _gotoInventoryItem(sku);
      });
    });
  }

  // =========================================================================
  // Panel 3 — Expiry timeline (Phase 2 — replaces placeholder)
  //
  // Data: reads stock_lots directly. Buckets client-side into overdue / 30 / 60 / 90 / normal.
  // Click row → open Inventory > ล็อตยา sub-view with pre-filter (via AppInventoryTab.openLotsSubview).
  // UX: §3.5, M-67..M-79.
  // =========================================================================

  async function _loadPanelExpiry() {
    const body    = document.getElementById('dash-expiry-body');
    const updated = document.getElementById('dash-expiry-updated');
    const card    = document.getElementById('dash-panel-expiry');
    if (!body) return;

    try {
      const sb = getSupabaseClient();
      const { data: lots, error } = await sb
        .from('stock_lots')
        .select('id,expiry_date,status,current_qty')
        .neq('status', 'depleted');

      if (error) {
        body.innerHTML = `<div class="text-danger small p-3">โหลดข้อมูลไม่สำเร็จ (M-79)</div>`;
        card?.setAttribute('aria-busy', 'false');
        return;
      }

      // Lazy-load AppLots for bucket helper (may not be loaded if Inventory tab not opened yet)
      let bucketFn = null;
      if (window.AppLots) {
        bucketFn = window.AppLots.getExpiryBucket;
      } else {
        // Inline fallback bucket (mirrors shared/lots.js getExpiryBucket)
        bucketFn = function (lot) {
          if (lot.status === 'expired') return 'overdue';
          if (!lot.expiry_date) return 'normal';
          const today = new Date(); today.setHours(0,0,0,0);
          const exp   = new Date(lot.expiry_date); exp.setHours(0,0,0,0);
          const days  = Math.floor((exp - today) / 86400000);
          if (days < 0)   return 'overdue';
          if (days <= 30) return 'within30';
          if (days <= 60) return 'within60';
          if (days <= 90) return 'within90';
          return 'normal';
        };
      }

      const counts = { overdue: 0, within30: 0, within60: 0, within90: 0, normal: 0 };
      for (const lot of (lots || [])) {
        const bucket = bucketFn(lot);
        if (counts[bucket] !== undefined) counts[bucket]++;
      }

      // Update timestamp
      if (updated) {
        const now = new Date();
        updated.textContent = `อัปเดต: ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      }

      // M-76: no lots at all
      if (!lots || lots.length === 0) {
        body.innerHTML = `
          <div class="text-center text-muted py-4">
            <p class="mb-1 fw-semibold">ยังไม่มีล็อตยาในระบบ (M-76)</p>
            <p class="small mb-0">รับเข้าล็อตแรกได้ที่ Inventory → รับเข้า (M-77)</p>
          </div>`;
        card?.setAttribute('aria-busy', 'false');
        return;
      }

      // M-78: all clear (no concerning lots)
      const urgentCount = counts.overdue + counts.within30 + counts.within60 + counts.within90;
      if (urgentCount === 0) {
        body.innerHTML = `
          <div class="text-center text-success py-4">
            <i class="bi bi-check-circle-fill" style="font-size:2rem;"></i>
            <div class="mt-2 fw-semibold">ล็อตยาทั้งหมดสถานะปกติ ✓ (M-78)</div>
            <div class="small text-muted mt-1">ปกติ (> 90 วัน): ${counts.normal} ล็อต</div>
          </div>`;
        card?.setAttribute('aria-busy', 'false');
        return;
      }

      // Normal: 4-row expiry timeline
      const rows = [
        {
          key: 'overdue', label: 'เกินกำหนดแล้ว', count: counts.overdue,
          badgeCls: 'bg-danger', borderCls: 'border-danger', filter: 'overdue',
        },
        {
          key: 'within30', label: 'ภายใน 30 วัน', count: counts.within30,
          badgeCls: 'bg-warning text-dark', borderCls: 'border-warning', filter: '30',
        },
        {
          key: 'within60', label: 'ภายใน 31–60 วัน', count: counts.within60,
          badgeCls: 'bg-warning text-dark opacity-75', borderCls: 'border-warning', filter: '60',
        },
        {
          key: 'within90', label: 'ภายใน 61–90 วัน', count: counts.within90,
          badgeCls: 'bg-stock-accent-subtle text-stock-accent-dark', borderCls: 'border-stock-accent', filter: '90',
        },
      ];

      const rowsHtml = rows.map((r) => `
        <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center
                  py-3 ${r.count === 0 ? 'text-muted' : ''}"
           href="#" data-expiry-filter="${_esc(r.filter)}"
           aria-label="${_esc(r.label)}: ${r.count} ล็อต">
          <span class="border-start ${r.borderCls} border-3 ps-2">
            ${_esc(r.label)}
          </span>
          <span class="d-flex align-items-center gap-2">
            <span class="badge ${r.badgeCls}">${r.count} ล็อต</span>
            <span class="small text-muted">ดูล็อต →</span>
          </span>
        </a>`).join('');

      body.innerHTML = `
        <div class="list-group list-group-flush">
          ${rowsHtml}
        </div>
        <div class="px-3 py-2 text-muted small border-top">
          · ปกติ (> 90 วัน): ${counts.normal} ล็อต
        </div>`;

      // Wire click handlers — switch to Inventory > ล็อตยา sub-view with pre-filter
      body.querySelectorAll('[data-expiry-filter]').forEach((link) => {
        link.addEventListener('click', (ev) => {
          ev.preventDefault();
          _gotoInventoryLots(link.dataset.expiryFilter);
        });
      });

      card?.setAttribute('aria-busy', 'false');
    } catch (e) {
      const body2 = document.getElementById('dash-expiry-body');
      if (body2) body2.innerHTML = `<div class="text-danger small p-3">โหลดข้อมูลไม่สำเร็จ (M-79)</div>`;
      console.error('[dashboard] _loadPanelExpiry error', e);
    }
  }

  // =========================================================================
  // Panel 4 — Borrow/Return status (Phase 3 live)
  //
  // Data: AppLoans.getBorrowCounts() → { active, overdue, returnedToday }
  // Three tappable rows: ยืมอยู่ / เกินกำหนด / คืนวันนี้
  // Tap row → switch to loans tab with pre-applied filter via AppLoansTab.setFilter()
  // =========================================================================
  async function _loadPanelLoans() {
    const body    = document.getElementById('dash-loans-body');
    const updated = document.getElementById('dash-loans-updated');
    const card    = document.getElementById('dash-panel-loans');
    if (!body) return;

    // AppLoans is loaded by shared/loans.js — may not be available if tab never opened.
    if (!window.AppLoans || typeof window.AppLoans.getBorrowCounts !== 'function') {
      body.innerHTML = `
        <div class="text-center text-muted py-4 small">
          ไม่พบ AppLoans — โหลดหน้าใหม่
        </div>`;
      card?.setAttribute('aria-busy', 'false');
      return;
    }

    try {
      const counts = await window.AppLoans.getBorrowCounts();

      if (updated) {
        const now = new Date();
        updated.textContent = `อัปเดต: ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      }

      const rows = [
        {
          label:    'ยืมอยู่',
          count:    counts.active,
          badgeCls: 'bg-stock-accent-subtle text-stock-accent-dark',
          filter:   'active',
          icon:     'bi-arrow-right-circle',
        },
        {
          label:    'เกินกำหนด',
          count:    counts.overdue,
          badgeCls: counts.overdue > 0 ? 'bg-danger' : 'bg-secondary',
          filter:   'overdue',
          icon:     'bi-exclamation-circle',
        },
        {
          label:    'คืนวันนี้',
          count:    counts.returnedToday,
          badgeCls: 'bg-success',
          filter:   'returned',
          icon:     'bi-check-circle',
        },
      ];

      const rowsHtml = rows.map((r) => `
        <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center py-3"
           href="#" data-loans-filter="${_esc(r.filter)}"
           aria-label="${_esc(r.label)}: ${r.count} รายการ">
          <span class="d-flex align-items-center gap-2">
            <i class="bi ${_esc(r.icon)} text-muted"></i>
            ${_esc(r.label)}
          </span>
          <span class="badge ${r.badgeCls}">${r.count} รายการ</span>
        </a>`).join('');

      body.innerHTML = `<div class="list-group list-group-flush">${rowsHtml}</div>`;

      body.querySelectorAll('[data-loans-filter]').forEach((link) => {
        link.addEventListener('click', (ev) => {
          ev.preventDefault();
          _gotoLoansTab(link.dataset.loansFilter);
        });
      });

      card?.setAttribute('aria-busy', 'false');
    } catch (e) {
      const body2 = document.getElementById('dash-loans-body');
      if (body2) body2.innerHTML = `<div class="text-danger small p-3">โหลดข้อมูลยืม-คืนไม่สำเร็จ</div>`;
      console.error('[dashboard] _loadPanelLoans error', e);
    }
  }

  /**
   * Switch to loans tab and pre-apply a status filter.
   * Polls for AppLoansTab.setFilter (lazy-init tab).
   *
   * @param {string} filter  'active'|'overdue'|'returned'
   */
  function _gotoLoansTab(filter) {
    try { location.hash = `#loans?filter=${filter}`; } catch { /* ignore */ }

    const loansBtn = document.querySelector('[data-tab="loans"]');
    if (loansBtn) loansBtn.click();

    let tries = 0;
    const tick = () => {
      if (window.AppLoansTab && typeof window.AppLoansTab.setFilter === 'function') {
        window.AppLoansTab.setFilter(filter);
        return;
      }
      if (typeof window.initLoansTab === 'function' && tries === 0) {
        Promise.resolve(window.initLoansTab()).catch(() => {});
      }
      if (++tries < 15) setTimeout(tick, 80);
    };
    tick();
  }

  /**
   * Switch to Inventory tab → ล็อตยา sub-view with the given expiry filter.
   * Phase 2 extension (mirrors _gotoInventoryLowStock pattern).
   *
   * @param {string} filter  'overdue'|'30'|'60'|'90'|'all'
   */
  function _gotoInventoryLots(filter) {
    try { location.hash = `#inventory?lotsFilter=${filter}`; } catch { /* ignore */ }

    const invBtn = document.querySelector('[data-tab="inventory"]');
    if (invBtn) invBtn.click();

    // Poll for AppInventoryTab to be ready (lazy-init tab)
    let tries = 0;
    const tick = () => {
      if (window.AppInventoryTab && typeof window.AppInventoryTab.openLotsSubview === 'function') {
        window.AppInventoryTab.openLotsSubview(filter);
        return;
      }
      if (typeof window.initInventoryTab === 'function' && tries === 0) {
        Promise.resolve(window.initInventoryTab()).catch(() => {});
      }
      if (++tries < 15) setTimeout(tick, 80);
    };
    tick();
  }

  /**
   * Switch to admin Inventory tab and toggle low-stock-only filter on.
   *
   * Strategy (per task constraint "DO NOT modify js/* other than dashboard.js"):
   *   1. Click the [data-tab="inventory"] nav-pill — admin-shell.js handles tab activation.
   *   2. After tab init runs, find #inv-low-only checkbox (set by js/inventory.js _renderShell)
   *      and toggle it on if not already. Use a polling retry up to 600ms because the
   *      Inventory tab is lazy-init and async (_ensureCategories + reload).
   *   3. Also set location.hash so a deep-link share works in the future when admin-shell
   *      gains hash routing.
   */
  function _gotoInventoryLowStock() {
    try { location.hash = '#inventory?lowStockOnly=1'; } catch { /* ignore */ }

    const invBtn = document.querySelector('[data-tab="inventory"]');
    if (invBtn) invBtn.click();

    // Poll for the inventory checkbox up to ~600ms (10 × 60ms)
    let tries = 0;
    const tick = () => {
      const cb = document.getElementById('inv-low-only');
      if (cb) {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
      if (++tries < 10) setTimeout(tick, 60);
    };
    tick();
  }

  /**
   * Switch to Inventory tab and pre-filter search to a specific SKU.
   * Used by the low-stock panel "→ ดู" per-item buttons (Phase 1.1 P7 polish).
   * Pattern mirrors _gotoInventoryLowStock() — polls for lazy-init DOM elements.
   *
   * @param {string} sku  The SKU to pre-fill into the inventory search input.
   */
  function _gotoInventoryItem(sku) {
    try { location.hash = `#inventory?sku=${encodeURIComponent(sku)}`; } catch { /* ignore */ }

    const invBtn = document.querySelector('[data-tab="inventory"]');
    if (invBtn) invBtn.click();

    if (!sku) return;

    // Poll for #inv-search up to ~600ms (10 × 60ms) — Inventory tab is lazy-init.
    let tries = 0;
    const tick = () => {
      const searchEl = document.getElementById('inv-search');
      if (searchEl) {
        searchEl.value = sku;
        // Dispatch input event to trigger AppInventoryTab's debounced search listener.
        searchEl.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (++tries < 10) setTimeout(tick, 60);
    };
    tick();
  }

  // =========================================================================
  // Item Finder (top of dashboard) — design §4.4.1
  //
  // Single text input → debounced 250ms → AppInventory.listItems({ search, limit: 8 })
  // → dropdown overlay. Click result → open Item Detail Drawer (we delegate to
  // AppInventoryTab.openItemDetailDrawer which lives in js/inventory.js so behavior
  // matches the Inventory tab exactly).
  // =========================================================================
  function _onFinderInput() {
    const input = document.getElementById('dash-finder-input');
    if (!input) return;
    const q = input.value.trim();
    if (_finderTimer) clearTimeout(_finderTimer);

    if (!q) {
      _closeFinderDropdown();
      _toggleFinderSpinner(false);
      return;
    }
    _toggleFinderSpinner(true);
    _finderTimer = setTimeout(() => _runFinder(q), 250);
  }

  function _toggleFinderSpinner(on) {
    const el = document.getElementById('dash-finder-spinner');
    if (!el) return;
    el.classList.toggle('d-none', !on);
  }

  async function _runFinder(q) {
    const reqId = ++_finderRequest;
    const r = await window.AppInventory.listItems({ search: q, activeOnly: true, limit: 8 });
    if (reqId !== _finderRequest) return;  // stale — drop
    _toggleFinderSpinner(false);

    if (r.error) {
      _toast('error', 'โหลดข้อมูลค้นหาไม่สำเร็จ');
      _closeFinderDropdown();
      return;
    }
    _renderFinderResults(r.data || []);
  }

  function _renderFinderResults(rows) {
    const list  = document.getElementById('dash-finder-results');
    const input = document.getElementById('dash-finder-input');
    if (!list || !input) return;

    if (!rows.length) {
      list.innerHTML = `
        <div class="dropdown-item-text text-muted small py-3 text-center">
          ไม่พบสินค้านี้
        </div>
      `;
      list.style.display = 'block';
      input.setAttribute('aria-expanded', 'true');
      _finderActiveIx = -1;
      return;
    }

    list.innerHTML = rows.map((it, ix) => {
      const total = it.total_qty || 0;
      // We don't have per-location count cheaply here; we surface total only.
      // Click handler will fetch full location breakdown via getItem().
      return `
        <button type="button" class="dropdown-item d-flex justify-content-between align-items-center"
                data-id="${_esc(it.id)}" data-ix="${ix}" role="option"
                style="min-height:44px; white-space:normal;">
          <div class="flex-grow-1 text-start">
            <div><code class="small">${_esc(it.sku)}</code> ${_esc(it.name)}</div>
            ${it.barcode ? `<div class="small text-muted">${_esc(it.barcode)}</div>` : ''}
          </div>
          <div class="ms-2 text-end small">
            <span class="badge bg-stock-accent-subtle">${total}</span>
          </div>
        </button>
      `;
    }).join('');

    list.querySelectorAll('[data-id]').forEach((btn) => {
      // Use mousedown so the click fires before the input's blur-driven close.
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        _onFinderPick(btn.dataset.id);
      });
    });

    list.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    _finderActiveIx = -1;
  }

  function _closeFinderDropdown() {
    const list  = document.getElementById('dash-finder-results');
    const input = document.getElementById('dash-finder-input');
    if (list)  list.style.display = 'none';
    if (input) input.setAttribute('aria-expanded', 'false');
    _finderActiveIx = -1;
  }

  function _onFinderKeyDown(ev) {
    const list = document.getElementById('dash-finder-results');
    if (!list || list.style.display !== 'block') return;
    const opts = Array.from(list.querySelectorAll('[data-id]'));
    if (!opts.length) return;

    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      _finderActiveIx = Math.min(opts.length - 1, _finderActiveIx + 1);
      _highlightFinderOption(opts);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      _finderActiveIx = Math.max(0, _finderActiveIx - 1);
      _highlightFinderOption(opts);
    } else if (ev.key === 'Enter') {
      if (_finderActiveIx >= 0 && opts[_finderActiveIx]) {
        ev.preventDefault();
        _onFinderPick(opts[_finderActiveIx].dataset.id);
      }
    } else if (ev.key === 'Escape') {
      _closeFinderDropdown();
    }
  }

  function _highlightFinderOption(opts) {
    opts.forEach((o, i) => o.classList.toggle('active', i === _finderActiveIx));
    if (_finderActiveIx >= 0 && opts[_finderActiveIx]) {
      opts[_finderActiveIx].scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Click a finder result → open the Item Detail Drawer.
   * Reuses js/inventory.js's openItemDetailDrawer so the UI is identical to the
   * Inventory tab's "click a row" behavior (design §4.4.1: "click → opens Item Detail Drawer (reuses 2.B)").
   */
  function _onFinderPick(itemId) {
    _closeFinderDropdown();
    const input = document.getElementById('dash-finder-input');
    if (input) input.value = '';

    // Try the shared drawer in AppInventoryTab; if Inventory tab hasn't been
    // initialized yet, init it first (lazy) then call.
    const open = () => {
      try { window.AppInventoryTab?.openItemDetailDrawer?.(itemId); } catch (e) { console.error(e); }
    };
    if (window.AppInventoryTab && typeof window.AppInventoryTab.openItemDetailDrawer === 'function') {
      open();
    } else if (typeof window.initInventoryTab === 'function') {
      // initInventoryTab() is async (returns a Promise). Fire it then open the drawer
      // — the drawer call is itself defensive (fetches own data).
      Promise.resolve(window.initInventoryTab()).then(open).catch(open);
    } else {
      _toast('error', 'ไม่สามารถเปิดรายละเอียดสินค้าได้');
    }
  }

  // =========================================================================
  // F. Legacy Phase 0 system-status block (collapsed by default)
  //
  // This preserves the Phase 0 dashboard's purpose (ops sanity check: auth, DB,
  // locations, ambulances, Telegram). We keep it because it's the only place an
  // Admin sees Telegram-on/off + ambulance count at a glance, and it's cheap.
  // Direct Supabase reads here are acceptable because they target Phase 0 tables
  // (locations, ambulances, settings) NOT the inventory data — and the task brief
  // explicitly allows this content (moved/collapsed at PM's discretion).
  // =========================================================================
  async function _loadLegacyStatus() {
    const ul = document.getElementById('dash-status-list');
    if (!ul) return;
    try {
      const sb = getSupabaseClient();
      const [locRes, ambRes, ambSyncRes, tgRes] = await Promise.all([
        sb.from('locations').select('id', { count: 'exact', head: true }),
        sb.from('ambulances').select('id', { count: 'exact', head: true }),
        sb.from('ambulances').select('last_synced_at').order('last_synced_at', { ascending: false }).limit(1).maybeSingle(),
        sb.from('settings').select('value').eq('key', 'NOTIFY_TELEGRAM_ENABLED').maybeSingle(),
      ]);
      const lastSync = ambSyncRes?.data?.last_synced_at;
      const tgOn     = tgRes?.data?.value === 'true';
      ul.innerHTML = `
        <li>✓ Auth พร้อม</li>
        <li>✓ DB เชื่อมต่อ <code>thegood-stock</code></li>
        <li>${(locRes.count ?? 0) > 0 ? '✓' : '⚠'} Locations: <strong>${locRes.count ?? 0}</strong></li>
        <li>${(ambRes.count ?? 0) > 0 ? '✓' : '⚠'} Ambulances: <strong>${ambRes.count ?? 0}</strong> ${lastSync ? `(last sync: ${_esc(new Date(lastSync).toLocaleString('th-TH'))})` : ''}</li>
        <li>${tgOn ? '✓' : '⚠'} Telegram: <strong>${tgOn ? 'เปิด' : 'ปิดอยู่'}</strong> — ตั้งค่าได้ที่แท็บ Settings</li>
      `;
    } catch (e) {
      ul.innerHTML = `<li class="text-muted">โหลดสถานะระบบไม่สำเร็จ</li>`;
    }
  }

  // =========================================================================
  // Realtime (spec §3 row 7 + §5.7) — subscribe to stock_items + stock_item_locations
  //
  // On any change, debounce 300ms (per task) then refresh Panels 1 + 2.
  // We deliberately DO NOT refresh the legacy status block on inventory events.
  // =========================================================================
  function _scheduleRealtimeReload() {
    if (_refreshTimer) return;
    _refreshTimer = setTimeout(() => {
      _refreshTimer = null;
      _loadPanelStock();
      _loadPanelLow();
      _loadPanelExpiry();   // Phase 2: also refresh expiry timeline on stock changes
      _loadPanelLoans();    // Phase 3: also refresh borrow/return counts
    }, 300);
  }

  // =========================================================================
  // Lifecycle (called by admin-shell.js inits['dashboard'] on first tab open)
  // =========================================================================
  async function init() {
    if (_mounted) return; // idempotent
    _mounted = true;

    _renderShell();

    // Categories cache for the Panel 1 breakdown (load before panels so names render)
    try {
      const r = await window.AppInventory.listCategories();
      _categories = r.error ? [] : (r.data || []);
    } catch { _categories = []; }

    // Parallel first load — five independent panels + legacy status
    await Promise.all([
      _loadPanelStock(),
      _loadPanelLow(),
      _loadPanelExpiry(),   // Phase 2 — expiry timeline
      _loadPanelLoans(),    // Phase 3 — borrow/return counts
      _loadLegacyStatus(),
    ]);

    // Realtime — subscribe AFTER first load so we don't double-trigger
    if (window.AppInventory.subscribeInventory) {
      _unsubscribe = window.AppInventory.subscribeInventory(() => {
        _scheduleRealtimeReload();
      });
    }

    // Teardown on page unload (spec §5.7: "free socket on tab unload")
    window.addEventListener('beforeunload', teardown);

    // If admin-shell ever fires a custom tab-leave event, we'd hook it here.
    // For Phase 1 it doesn't, so the subscription stays alive while the page lives.
  }

  function teardown() {
    if (_unsubscribe)   { try { _unsubscribe(); } catch {} _unsubscribe = null; }
    if (_refreshTimer)  { clearTimeout(_refreshTimer); _refreshTimer = null; }
    if (_finderTimer)   { clearTimeout(_finderTimer);  _finderTimer = null; }
    _mounted = false;
  }

  // =========================================================================
  // Public namespace
  // =========================================================================
  window.AppDashboardTab = {
    init,
    teardown,
    reloadPanels: () => { _loadPanelStock(); _loadPanelLow(); _loadPanelExpiry(); _loadPanelLoans(); },
  };

  // admin-shell.js expects window.initDashboardTab — shim (matches Phase 0 contract)
  window.initDashboardTab = init;
})();
