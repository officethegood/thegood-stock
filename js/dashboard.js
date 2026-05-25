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

      <!-- G. Phase 4 — ALS Bags status panel (S-4.6) -->
      <div class="row g-3 mt-1">
        <div class="col-12 col-md-6">
          <div class="card h-100" id="dash-panel-bags" aria-busy="true">
            <div class="card-header d-flex justify-content-between align-items-center">
              <span><i class="bi bi-bag-heart"></i> สถานะ ALS Bags</span>
              <a href="#" class="text-muted small" id="dash-bags-all-link" aria-label="ดูทั้งหมด">→</a>
            </div>
            <div id="dash-bags-body" class="card-body p-0">
              <div class="text-center text-muted py-4">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>
        <!-- H. Oxygen — paired with bags so both stay above the fold (col-md-6 + col-md-6 fills the row). -->
        <div class="col-12 col-md-6">
          <div class="card h-100" id="dash-panel-oxygen" aria-busy="true">
            <div class="card-header d-flex justify-content-between align-items-center">
              <span><i class="bi bi-circle-square"></i> สถานะถังออกซิเจน</span>
              <small class="text-muted" id="dash-oxygen-updated">—</small>
            </div>
            <div id="dash-oxygen-body" class="card-body p-0">
              <div class="text-center text-muted py-4">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- I+J. Linen panels paired — "นับผ้าวันนี้" (left) and "สถานะผ้า" (right) so both stay above the fold. -->
      <div class="row g-3 mt-1">
        <div class="col-12 col-md-6">
          <div class="card h-100" id="dash-panel-linens" aria-busy="true">
            <div class="card-header d-flex justify-content-between align-items-center">
              <span>🧺 นับผ้าวันนี้</span>
              <a href="#" class="text-muted small" id="dash-linens-all-link"
                 aria-label="ดูรายละเอียด ผ้า">ดูทั้งหมด →</a>
            </div>
            <div id="dash-linens-body" class="card-body p-0">
              <div class="text-center text-muted py-4">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>
        <!-- id "dash-linen-state-row" lives on this col now (was on the row) so hiding it on empty data only collapses the linen-state side, not "นับผ้าวันนี้" too. -->
        <div class="col-12 col-md-6" id="dash-linen-state-row">
          <div class="card h-100" id="dash-panel-linen-state" aria-busy="true">
            <div class="card-header">
              <span><i class="bi bi-basket"></i> สถานะผ้า</span>
            </div>
            <div id="dash-linen-state-body" class="card-body">
              <div class="text-center text-muted py-3">
                <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- K. Phase 0.7+ — Laundry quick-action buttons (admin) — moved below the linen status row -->
      ${window.Laundry ? `
      <div class="row g-3 mt-1">
        <div class="col-12">
          <div class="card">
            <div class="card-body py-3">
              <p class="mb-2 fw-semibold"><i class="bi bi-basket2"></i> ผ้าและของซัก</p>
              <div class="d-flex flex-wrap gap-2">
                <button class="btn btn-outline-secondary btn-sm" onclick="Laundry.openModal('fill_vehicle')">
                  <i class="bi bi-truck"></i> เติมรถ
                </button>
                <button class="btn btn-outline-secondary btn-sm" onclick="Laundry.openModal('mark_dirty')">
                  <i class="bi bi-droplet-half"></i> ใช้/เปื้อน +N
                </button>
                <button class="btn btn-outline-secondary btn-sm" onclick="Laundry.openModal('send_wash')">
                  <i class="bi bi-send"></i> ส่งซัก
                </button>
                <button class="btn btn-outline-secondary btn-sm" onclick="Laundry.openModal('receive_back')">
                  <i class="bi bi-box-arrow-in-down"></i> รับคืน
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>` : ''}

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
  // Panel 4b — ALS Bags status (Phase 4, S-4.6)
  //
  // UX: docs/superpowers/designs/2026-05-19-phase4-als-bags-ui-design.md §9
  //
  // Data: AppBags.getBagCounts() → { complete, low_stock, expiring, expired, no_template }
  // Four tappable count badges: สมบูรณ์ / ของไม่ครบ / ใกล้หมดอายุ / หมดอายุ
  // Tap any badge → switch to ALS Bags tab with that alert_level filter pre-applied.
  // "→" header link → ALS Bags tab no filter.
  // =========================================================================

  async function _loadPanelBags() {
    const body    = document.getElementById('dash-bags-body');
    const card    = document.getElementById('dash-panel-bags');
    const allLink = document.getElementById('dash-bags-all-link');
    if (!body) return;

    if (!window.AppBags) {
      body.innerHTML = `<div class="text-center text-muted py-3 small">shared/bags.js ยังไม่ถูกโหลด</div>`;
      card?.setAttribute('aria-busy', 'false');
      return;
    }

    // Wire "all" link to switch to ALS Bags tab
    if (allLink) {
      allLink.addEventListener('click', (ev) => {
        ev.preventDefault();
        document.querySelector('[data-tab="bags"]')?.click();
      });
    }

    try {
      const { data: counts, error } = await window.AppBags.getBagCounts();
      if (error || !counts) {
        body.innerHTML = `<div class="text-danger small p-3">โหลดข้อมูลไม่สำเร็จ</div>`;
        card?.setAttribute('aria-busy', 'false');
        return;
      }

      const totalIssues = counts.low_stock + counts.expiring + counts.expired;

      // Attention state: blink if expired > 0 (per UX §9.4)
      if (counts.expired > 0) {
        card?.classList.add('border-danger');
      } else if (totalIssues > 0) {
        card?.classList.remove('border-danger');
      }

      if (counts.complete === 0 && totalIssues === 0 && counts.no_template === 0) {
        body.innerHTML = `
          <div class="text-center text-muted py-3 small">
            <i class="bi bi-check-circle-fill text-success me-1"></i>ยังไม่มีกระเป๋ายาในระบบ
          </div>`;
        card?.setAttribute('aria-busy', 'false');
        return;
      }

      const levels = [
        { key: 'complete',    label: 'สมบูรณ์',      cls: 'bg-success text-white'  },
        { key: 'low_stock',   label: 'ของไม่ครบ',    cls: 'bg-warning text-dark'   },
        { key: 'expiring',    label: 'ใกล้หมดอายุ',  cls: 'badge-stock-expiring'   },
        { key: 'expired',     label: 'หมดอายุ',      cls: 'bg-danger text-white'   },
      ];

      const badgesHtml = levels.map((lvl) => `
        <div class="col text-center">
          <a href="#" class="text-decoration-none dash-bags-filter-link" data-level="${_esc(lvl.key)}">
            <span class="badge ${lvl.cls} d-block mb-1 fs-6">${counts[lvl.key] ?? 0}</span>
            <small class="text-muted" style="font-size:11px">${lvl.label}</small>
          </a>
        </div>`).join('');

      body.innerHTML = `
        <style>.badge-stock-expiring{background-color:#fd7e14;color:#fff;}</style>
        <div class="row g-0 p-2">${badgesHtml}</div>
        ${totalIssues === 0 ? `
          <div class="px-3 pb-2 text-center">
            <small class="text-success"><i class="bi bi-check-circle-fill me-1"></i>กระเป๋าทั้งหมดสมบูรณ์</small>
          </div>` : ''}`;

      // Wire badge tap → switch to bags tab with filter
      body.querySelectorAll('.dash-bags-filter-link').forEach((a) => {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const tabBtn = document.querySelector('[data-tab="bags"]');
          tabBtn?.click();
          // Pass filter after tab init (may be async)
          setTimeout(() => window.AppBagsTab?.setFilter?.(a.dataset.level), 200);
        });
      });

      card?.setAttribute('aria-busy', 'false');
    } catch (e) {
      body.innerHTML = `<div class="text-danger small p-3">โหลดข้อมูลกระเป๋ายาไม่สำเร็จ</div>`;
      console.error('[dashboard] _loadPanelBags error', e);
    }
  }

  // =========================================================================
  // Panel 5 — Oxygen tank status (Phase 5)
  //
  // Data: AppOxygen.getTankStatusCounts() → { ready, on_board, refilling, maintenance, retired }
  // Shows per-status count badges.
  // Amber banner when refilling count >= OXYGEN_REFILL_THRESHOLD (default 5).
  // "ดูทั้งหมด →" link switches to the oxygen admin tab.
  // =========================================================================

  async function _loadPanelOxygen() {
    const body    = document.getElementById('dash-oxygen-body');
    const updated = document.getElementById('dash-oxygen-updated');
    const card    = document.getElementById('dash-panel-oxygen');
    if (!body) return;

    if (!window.AppOxygen || typeof window.AppOxygen.getTankStatusCounts !== 'function') {
      body.innerHTML = `
        <div class="text-center text-muted py-4 small">
          ไม่พบ AppOxygen — โหลดหน้าใหม่
        </div>`;
      card?.setAttribute('aria-busy', 'false');
      return;
    }

    try {
      const counts = await window.AppOxygen.getTankStatusCounts();

      if (updated) {
        const now = new Date();
        updated.textContent = `อัปเดต: ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      }

      // Read threshold from settings cache (window.appSettings populated by loadSettings())
      const threshold = parseInt(
        (window.appSettings && window.appSettings['OXYGEN_REFILL_THRESHOLD']) || '5',
        10
      ) || 5;

      const statusRows = [
        { key: 'ready',       label: window.AppOxygen.STATUS_LABELS.ready,       badgeCls: 'bg-success' },
        { key: 'on_board',    label: window.AppOxygen.STATUS_LABELS.on_board,     badgeCls: 'bg-primary' },
        { key: 'refilling',   label: window.AppOxygen.STATUS_LABELS.refilling,    badgeCls: 'bg-warning text-dark' },
        { key: 'maintenance', label: window.AppOxygen.STATUS_LABELS.maintenance,  badgeCls: 'bg-orange text-white' },
        { key: 'retired',     label: window.AppOxygen.STATUS_LABELS.retired,      badgeCls: 'bg-secondary' },
      ];

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const refillingCount = counts.refilling || 0;
      const showAlert = refillingCount >= threshold;

      const badgesHtml = statusRows.map((r) => `
        <div class="col-auto">
          <div class="text-center px-2">
            <div class="badge ${r.badgeCls} fs-6 px-3 py-2">${counts[r.key] || 0}</div>
            <div class="small text-muted mt-1">${_esc(r.label)}</div>
          </div>
        </div>
      `).join('');

      body.innerHTML = `
        ${showAlert ? `
          <div class="alert alert-warning m-3 py-2 mb-0 d-flex align-items-center gap-2" role="alert">
            <i class="bi bi-exclamation-triangle-fill"></i>
            <span>ถังรอเติม <strong>${refillingCount}</strong> ถัง — ถึงเกณฑ์แจ้งเตือน (≥${threshold} ถัง)</span>
          </div>
        ` : ''}
        <div class="p-3">
          ${total === 0
            ? '<div class="text-center text-muted small py-2">ยังไม่มีถังออกซิเจนในระบบ</div>'
            : `<div class="row g-2 justify-content-center mb-2">${badgesHtml}</div>`}
          <div class="text-end">
            <a href="#" id="dash-oxygen-goto" class="small text-stock-accent">ดูทั้งหมด →</a>
          </div>
        </div>
      `;

      // Wire "ดูทั้งหมด →" to switch to the oxygen tab
      document.getElementById('dash-oxygen-goto')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        const oxyBtn = document.querySelector('[data-tab="oxygen"]');
        if (oxyBtn) oxyBtn.click();
      });

      card?.setAttribute('aria-busy', 'false');
    } catch (e) {
      const body2 = document.getElementById('dash-oxygen-body');
      if (body2) body2.innerHTML = `<div class="text-danger small p-3">โหลดข้อมูลถังออกซิเจนไม่สำเร็จ</div>`;
      console.error('[dashboard] _loadPanelOxygen error', e);
    }
  }

  // =========================================================================
  // I. Phase 6 — "นับผ้าวันนี้" linen summary panel (S-6.16)
  //
  // Spec:  docs/superpowers/specs/2026-05-19-phase6-linens-laundry-design.md §7 (low priority)
  // UX:    docs/superpowers/designs/2026-05-19-phase6-linens-ui-design.md §3.9
  //
  // Shows: discrepancy count, items counted today, items never counted.
  // Tap → Inventory tab filtered to LINEN.
  // Low priority: if AppLinens not loaded, silently hides the panel.
  // =========================================================================
  async function _loadPanelLinens() {
    const body = document.getElementById('dash-linens-body');
    const card = document.getElementById('dash-panel-linens');
    if (!body) return;

    if (!window.AppLinens) {
      // Phase 6 module not loaded — hide panel gracefully
      if (card) card.classList.add('d-none');
      return;
    }

    try {
      const { data, error } = await window.AppLinens.fetchLinenAudit();
      card?.setAttribute('aria-busy', 'false');

      if (error || !data) {
        body.innerHTML = `<div class="text-muted small p-3 text-center">โหลดข้อมูลผ้าไม่สำเร็จ</div>`;
        return;
      }

      const todayBkk = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Bangkok' });
      const discrepancyCount = data.filter((r) => r.is_discrepancy).length;
      const countedToday     = data.filter((r) => {
        if (!r.counted_at) return false;
        return new Date(r.counted_at).toLocaleDateString('sv', { timeZone: 'Asia/Bangkok' }) === todayBkk;
      }).length;
      const neverCounted = data.filter((r) => !r.counted_at).length;

      body.innerHTML = `
        ${discrepancyCount > 0
          ? `<div class="alert alert-warning m-3 py-2 mb-0 d-flex align-items-center gap-2 small" role="alert">
               <i class="bi bi-exclamation-triangle-fill"></i>
               <span>ผ้าที่มีความคลาดเคลื่อน <strong>${discrepancyCount}</strong> รายการ</span>
             </div>`
          : ''}
        <div class="p-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="small text-muted">ผ้าที่มีความคลาดเคลื่อน</span>
            <span class="badge ${discrepancyCount > 0 ? 'bg-danger' : 'bg-success'}">${discrepancyCount} รายการ</span>
          </div>
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="small text-muted">ผ้าที่นับแล้ววันนี้</span>
            <span class="badge bg-secondary">${countedToday} รายการ</span>
          </div>
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="small text-muted">ผ้าที่ยังไม่เคยนับ</span>
            <span class="badge ${neverCounted > 0 ? 'bg-warning text-dark' : 'bg-secondary'}">${neverCounted} รายการ</span>
          </div>
          <div class="text-end mt-2">
            <a href="#" id="dash-linens-goto" class="small text-stock-accent">ดูรายละเอียด → ผ้า</a>
          </div>
        </div>`;

      // Wire "ดูรายละเอียด" link → navigate to Inventory tab + LINEN filter
      document.getElementById('dash-linens-goto')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        const invBtn = document.querySelector('[data-tab="inventory"]');
        if (invBtn) invBtn.click();
      });

      // Wire header link
      document.getElementById('dash-linens-all-link')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        const invBtn = document.querySelector('[data-tab="inventory"]');
        if (invBtn) invBtn.click();
      });

    } catch (e) {
      if (body) body.innerHTML = `<div class="text-muted small p-3 text-center">โหลดข้อมูลผ้าไม่สำเร็จ</div>`;
      console.error('[dashboard] _loadPanelLinens error', e);
    }
  }

  // =========================================================================
  // J. Phase 0.7+ — Linen state summary widget (v_linen_state_summary)
  //
  // Spec: docs/superpowers/specs/2026-05-19-phase0.7-location-hierarchy-design.md §D11
  //
  // Queries v_linen_state_summary (only is_linen=true rows).
  // Shows one progress-stack bar per SKU: green=clean, blue=vehicle, amber=dirty, grey=external.
  // Graceful fallback: if view missing (migration not yet applied) → shows empty state message.
  // Empty state: no rows with qty_total > 0 → hides entire panel row.
  // =========================================================================
  async function _loadPanelLinenState() {
    const body     = document.getElementById('dash-linen-state-body');
    const panelRow = document.getElementById('dash-linen-state-row');
    const card     = document.getElementById('dash-panel-linen-state');
    if (!body) return;

    try {
      const sb = getSupabaseClient();
      const { data: rows, error } = await sb
        .from('v_linen_state_summary')
        .select('*')
        .gt('qty_total', 0);

      card?.setAttribute('aria-busy', 'false');

      if (error) {
        // View may not exist yet (migration pending) — show soft empty state
        body.innerHTML = `
          <div class="text-center text-muted py-3 small">
            <i class="bi bi-basket me-1"></i>ยังไม่มีข้อมูลผ้า
          </div>`;
        return;
      }

      if (!rows || rows.length === 0) {
        // No linen items configured → hide entire panel row
        if (panelRow) panelRow.classList.add('d-none');
        return;
      }

      const cardsHtml = rows.map((r) => {
        const total    = r.qty_total || 0;
        const clean    = r.qty_clean    || 0;
        const vehicle  = r.qty_vehicle  || 0;
        const dirty    = r.qty_dirty    || 0;
        const external = r.qty_external || 0;

        // Guard against division by zero
        const pct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;
        const pClean    = pct(clean);
        const pVehicle  = pct(vehicle);
        const pDirty    = pct(dirty);
        // External fills remainder to avoid rounding gaps
        const pExternal = Math.max(0, 100 - pClean - pVehicle - pDirty);

        return `
          <div class="fc-card mb-2 p-3" style="border:1px solid var(--fc-paper-sub);border-radius:8px;">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <strong>${_esc(r.name)}</strong>
              <span class="fc-mono small text-muted">${_esc(r.sku)}</span>
            </div>
            <div class="small text-muted mb-2">รวม ${total} ผืน</div>
            <div style="height:24px; display:flex; border-radius:6px; overflow:hidden;">
              ${pClean    > 0 ? `<div title="พร้อมใช้ ${clean}"    style="background:#10b981;width:${pClean}%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;overflow:hidden;">${clean > 0 ? clean : ''}</div>` : ''}
              ${pVehicle  > 0 ? `<div title="ในรถ ${vehicle}"       style="background:#3b82f6;width:${pVehicle}%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;overflow:hidden;">${vehicle > 0 ? vehicle : ''}</div>` : ''}
              ${pDirty    > 0 ? `<div title="รอซัก ${dirty}"        style="background:#f59e0b;width:${pDirty}%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;overflow:hidden;">${dirty > 0 ? dirty : ''}</div>` : ''}
              ${pExternal > 0 ? `<div title="กำลังซัก ${external}" style="background:#9ca3af;width:${pExternal}%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;overflow:hidden;">${external > 0 ? external : ''}</div>` : ''}
              ${total === 0   ? `<div style="background:var(--fc-paper-sub);width:100%;"></div>` : ''}
            </div>
            <div class="d-flex gap-3 small mt-2 flex-wrap">
              <span style="color:#10b981;">&#9679; พร้อมใช้ ${clean}</span>
              <span style="color:#3b82f6;">&#9679; ในรถ ${vehicle}</span>
              <span style="color:#f59e0b;">&#9679; รอซัก ${dirty}</span>
              <span style="color:#9ca3af;">&#9679; กำลังซัก ${external}</span>
            </div>
          </div>`;
      }).join('');

      body.innerHTML = cardsHtml;

    } catch (e) {
      const body2 = document.getElementById('dash-linen-state-body');
      if (body2) body2.innerHTML = `
        <div class="text-center text-muted py-3 small">
          <i class="bi bi-basket me-1"></i>ยังไม่มีข้อมูลผ้า
        </div>`;
      console.warn('[dashboard] _loadPanelLinenState error', e);
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
      _loadPanelExpiry();      // Phase 2: also refresh expiry timeline on stock changes
      _loadPanelLoans();       // Phase 3: also refresh borrow/return counts
      _loadPanelBags();        // Phase 4: also refresh ALS Bags status
      _loadPanelOxygen();      // Phase 5: also refresh oxygen status counts
      _loadPanelLinenState();  // Phase 0.7+: linen state summary
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

    // Parallel first load — nine independent panels + legacy status
    await Promise.all([
      _loadPanelStock(),
      _loadPanelLow(),
      _loadPanelExpiry(),      // Phase 2 — expiry timeline
      _loadPanelLoans(),       // Phase 3 — borrow/return counts
      _loadPanelBags(),        // Phase 4 — ALS Bags status (S-4.6)
      _loadPanelOxygen(),      // Phase 5 — oxygen tank status
      _loadPanelLinens(),      // Phase 6 — linen "นับผ้าวันนี้" summary (S-6.16)
      _loadPanelLinenState(),  // Phase 0.7+ — linen state summary (D11)
      _loadLegacyStatus(),
    ]);

    // Realtime — subscribe AFTER first load so we don't double-trigger
    if (window.AppInventory.subscribeInventory) {
      _unsubscribe = window.AppInventory.subscribeInventory(() => {
        _scheduleRealtimeReload();
      });
    }

    // Phase 5 — subscribe to oxygen_tanks for live panel updates
    if (window.AppOxygen && typeof window.AppOxygen.subscribeOxygenTanks === 'function') {
      const _unsubOxy = window.AppOxygen.subscribeOxygenTanks(() => {
        // Debounce: reuse the existing 300ms timer
        _scheduleRealtimeReload();
      });
      // Store for teardown
      const _teardownOrig = teardown;
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
    reloadPanels: () => { _loadPanelStock(); _loadPanelLow(); _loadPanelExpiry(); _loadPanelLoans(); _loadPanelBags(); _loadPanelOxygen(); _loadPanelLinens(); _loadPanelLinenState(); },
  };

  // admin-shell.js expects window.initDashboardTab — shim (matches Phase 0 contract)
  window.initDashboardTab = init;
})();
