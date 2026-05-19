// js/staff-print.js — Phase 0.5 + Phase 0.7 bin/zone extension
// Page logic for staff-print.html
//
// Access: Employee + Admin (requireRole(['Admin','Employee']) via shared/auth.js)
// Data: Supabase REST, read-only. Displays code + name ONLY (no qty/threshold/sensitive fields).
// Four entity tabs: items (stock_items), locations (incl. bin), bags (locations type='bag'|'zone'), tanks (oxygen_tanks)
//
// Phase 0.7 additions:
//   - Locations tab: includes type='bin'; shows breadcrumb from v_location_path view.
//   - ALS Bags tab: includes type='zone'; zones grouped under their parent bag, indented display.
//   - Bin/zone single-print defaults hintSize='50x30'.
//
// Calls QRPrint.single / QRPrint.bulk from shared/qr-print.js.

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module state
  // -------------------------------------------------------------------------
  let _activeTab    = 'items';    // 'items' | 'locations' | 'bags' | 'tanks'
  let _activeSize   = '50x50';    // '50x50' | '50x30' | 'a4-50x50' | 'a4-50x30'

  // Map _activeSize → (singleSize, isBulkA4) for QRPrint API
  function _resolveSize() {
    if (_activeSize === 'a4-50x30') return { single: '50x30', bulkA4: true };
    if (_activeSize === 'a4-50x50') return { single: '50x50', bulkA4: true };
    return { single: _activeSize, bulkA4: false };
  }
  let _allRows      = [];         // full fetched list for current tab
  let _filtered     = [];         // after search filter
  let _selected     = new Set();  // selected codes (strings)
  let _searchTimer  = null;

  // Phase 0.7: path_display map for bin rows: code → path_display string
  let _pathMap      = {};         // key = location id, value = path_display
  // Phase 0.7: parent bag map for zone rows: parent_id → { code, name }
  let _bagMap       = {};         // key = bag id, value = { code, name }

  // -------------------------------------------------------------------------
  // Auth + boot
  // -------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    // BUG-0.7-R3-03 fix: ensure JWT is loaded into supabase client before queries
    // (without this, direct-URL navigation falls back to anon key → RLS returns 0 rows)
    if (typeof window.ensureLoggedIn === 'function') {
      const ok = await window.ensureLoggedIn();
      if (!ok) return;
    }

    // requireRole throws / redirects if not allowed
    if (typeof window.requireRole === 'function') {
      window.requireRole(['Admin', 'Employee']);
    }

    // Populate user name in navbar
    if (typeof window.getUserName === 'function') {
      const nm = document.getElementById('user-name');
      if (nm) nm.textContent = window.getUserName() || '—';
    }

    // Logout
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        if (typeof window.logout === 'function') window.logout();
        else window.location.href = './login.html';
      });
    }

    _initSizeSelector();
    _initTabNav();
    _initSearch();
    _initBulkBar();

    // Load first tab
    _loadTab(_activeTab);
  });

  // -------------------------------------------------------------------------
  // Size selector
  // -------------------------------------------------------------------------
  function _initSizeSelector() {
    const seg = document.getElementById('size-seg');
    if (!seg) return;
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-size]');
      if (!btn) return;
      _activeSize = btn.dataset.size;
      seg.querySelectorAll('[data-size]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('btn-stock-primary', active);
        b.classList.toggle('btn-outline-secondary', !active);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Tab navigation
  // -------------------------------------------------------------------------
  function _initTabNav() {
    const nav = document.getElementById('print-subtabs');
    if (!nav) return;
    nav.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === _activeTab) return;
      _activeTab = tab;

      // Update active state
      nav.querySelectorAll('[data-tab]').forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', String(isActive));
      });

      // Reset selection + search
      _selected.clear();
      _updateBulkBar();
      const searchEl = document.getElementById('print-search');
      if (searchEl) searchEl.value = '';

      _loadTab(tab);
    });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  function _initSearch() {
    const el = document.getElementById('print-search');
    if (!el) return;
    el.addEventListener('input', () => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        _selected.clear();
        _updateBulkBar();
        _applyFilter(el.value.trim().toLowerCase());
        _renderList();
      }, 200);
    });
  }

  // -------------------------------------------------------------------------
  // Bulk bar
  // -------------------------------------------------------------------------
  function _initBulkBar() {
    const btnBulk = document.getElementById('btn-bulk-print');
    if (btnBulk) {
      btnBulk.addEventListener('click', () => {
        const rows = _filtered.filter((r) => _selected.has(_rowCode(r)));
        if (!rows.length) return;
        const sz = _resolveSize();
        const printRows = rows.map((r) => {
          let subtitle = _rowName(r);
          // Phase 0.7: enrich subtitle for bin/zone rows
          if (r.type === 'bin' && _pathMap[r.id]) {
            subtitle = (r.name || '') + ' • ' + _pathMap[r.id];
          } else if (r.type === 'zone' && r.parent_id && _bagMap[r.parent_id]) {
            const pb = _bagMap[r.parent_id];
            subtitle = (r.name || '') + ' • ' + (pb.name || pb.code);
          }
          return {
            code: _rowCode(r),
            label: _rowCode(r),
            subtitle,
            entityType: (_activeTab || '').toUpperCase(),
          };
        });
        if (sz.bulkA4) {
          window.QRPrint.bulk(printRows, { size: sz.single });
        } else {
          // Single-row size selected; download each as separate PNG via bulk-as-grid mode
          window.QRPrint.bulk(printRows, { size: sz.single });
        }
      });
    }

    const btnDesel = document.getElementById('btn-deselect-all');
    if (btnDesel) {
      btnDesel.addEventListener('click', () => {
        _selected.clear();
        _updateBulkBar();
        _renderList();
      });
    }
  }

  function _updateBulkBar() {
    const bar = document.getElementById('bulk-bar');
    const cnt = document.getElementById('bulk-count');
    if (!bar || !cnt) return;
    const n = _selected.size;
    cnt.textContent = String(n);
    bar.classList.toggle('visible', n > 0);
  }

  // -------------------------------------------------------------------------
  // Row field accessors (vary by entity type)
  // -------------------------------------------------------------------------
  function _rowCode(row) {
    if (_activeTab === 'tanks') return row.serial || '';
    return row.code || row.sku || '';
  }

  function _rowName(row) {
    return row.name || '';
  }

  // -------------------------------------------------------------------------
  // Data fetch
  // -------------------------------------------------------------------------
  async function _loadTab(tab) {
    const container = document.getElementById('print-list-container');
    if (!container) return;

    // Reset enrichment caches on every tab load
    _pathMap = {};
    _bagMap  = {};

    container.innerHTML = `
      <div class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลด…
      </div>`;

    const sb = window.getSupabaseClient ? window.getSupabaseClient() : null;
    if (!sb) {
      container.innerHTML = '<div class="text-danger p-3">Supabase client ไม่พร้อม</div>';
      return;
    }

    try {
      let data = [];
      if (tab === 'items') {
        // stock_items — show code (sku) + name only
        const { data: rows, error } = await sb
          .from('stock_items')
          .select('id,sku,name')
          .eq('active', true)
          .order('sku');
        if (error) throw error;
        data = rows || [];
      } else if (tab === 'locations') {
        // locations: room, storage, shelf, bin, ambulance (+ legacy cabinet) — Phase 0.7 adds bin
        const { data: rows, error } = await sb
          .from('locations')
          .select('id,code,name,type,parent_id')
          .in('type', ['room', 'storage', 'shelf', 'bin', 'ambulance', 'cabinet'])
          .eq('active', true)
          .order('code');
        if (error) throw error;
        data = rows || [];

        // Phase 0.7: fetch breadcrumbs for bin rows from v_location_path view
        _pathMap = {};
        const hasBins = data.some((r) => r.type === 'bin');
        if (hasBins) {
          try {
            const binIds = data.filter((r) => r.type === 'bin').map((r) => r.id);
            const { data: pathRows, error: pathErr } = await sb
              .from('v_location_path')
              .select('id,path_display')
              .in('id', binIds);
            if (!pathErr && pathRows) {
              pathRows.forEach((p) => { _pathMap[p.id] = p.path_display; });
            }
          } catch (_) {
            // v_location_path not yet migrated — breadcrumbs silently absent
          }
        }
      } else if (tab === 'bags') {
        // locations: bag + zone (Phase 0.7 adds zone)
        const { data: rows, error } = await sb
          .from('locations')
          .select('id,code,name,type,parent_id')
          .in('type', ['bag', 'zone'])
          .eq('active', true)
          .order('code');
        if (error) throw error;

        // Build parent bag lookup for zone subtitle display
        _bagMap = {};
        (rows || []).filter((r) => r.type === 'bag').forEach((b) => {
          _bagMap[b.id] = { code: b.code, name: b.name };
        });

        // Sort: each bag immediately followed by its zones (sorted by code)
        const bags  = (rows || []).filter((r) => r.type === 'bag').sort(_byCode);
        const zones = (rows || []).filter((r) => r.type === 'zone').sort(_byCode);
        data = [];
        bags.forEach((bag) => {
          data.push(bag);
          zones.filter((z) => z.parent_id === bag.id).forEach((z) => data.push(z));
        });
        // Orphaned zones (parent_id null or parent not in list) appended at end
        zones.filter((z) => !_bagMap[z.parent_id]).forEach((z) => data.push(z));
      } else if (tab === 'tanks') {
        // oxygen_tanks — show serial + name
        const { data: rows, error } = await sb
          .from('oxygen_tanks')
          .select('id,serial,name')
          .order('serial');
        if (error) throw error;
        data = rows || [];
      }

      _allRows  = data;
      _filtered = data;
      _selected.clear();
      _updateBulkBar();
      _renderList();
    } catch (err) {
      container.innerHTML = `<div class="text-danger p-3">โหลดข้อมูลไม่สำเร็จ: ${_esc(err.message || '')}</div>`;
    }
  }

  function _applyFilter(q) {
    if (!q) {
      _filtered = _allRows;
      return;
    }
    _filtered = _allRows.filter((r) => {
      const code = (_rowCode(r) || '').toLowerCase();
      const name = (_rowName(r) || '').toLowerCase();
      return code.includes(q) || name.includes(q);
    });
  }

  // -------------------------------------------------------------------------
  // Render list
  // -------------------------------------------------------------------------
  function _renderList() {
    const container = document.getElementById('print-list-container');
    if (!container) return;

    if (!_filtered.length) {
      container.innerHTML = '<div class="text-muted text-center py-4">ไม่พบรายการ</div>';
      return;
    }

    // Header row with select-all checkbox
    const selectAllId = 'chk-select-all';
    let html = `
      <div class="print-list-item" style="background:#f8f9fa;">
        <input type="checkbox" class="item-check" id="${selectAllId}"
               aria-label="เลือกทั้งหมด" title="เลือกทั้งหมด">
        <span class="item-code small text-muted">รหัส</span>
        <span class="item-name small text-muted">ชื่อ</span>
        <span style="min-width:44px;"></span>
      </div>
    `;

    _filtered.forEach((row) => {
      const code    = _esc(_rowCode(row));
      const name    = _esc(_rowName(row));
      const rawCode = _rowCode(row);
      const checked = _selected.has(rawCode) ? 'checked' : '';

      // Phase 0.7: bin row breadcrumb (under code/name line)
      const isBin  = (row.type === 'bin');
      const isZone = (row.type === 'zone');

      // Breadcrumb text for bin
      let breadcrumbHtml = '';
      if (isBin && _pathMap[row.id]) {
        breadcrumbHtml = `<span class="text-muted small d-block" style="font-size:0.72rem;line-height:1.3;">${_esc(_pathMap[row.id])}</span>`;
      }

      // Parent bag label for zone
      let parentBagHtml = '';
      const parentBag = isZone && row.parent_id ? _bagMap[row.parent_id] : null;
      if (parentBag) {
        parentBagHtml = `<span class="text-muted small d-block" style="font-size:0.72rem;line-height:1.3;">${_esc(parentBag.name || parentBag.code)}</span>`;
      }

      // Subtitle passed to QRPrint (enriched for bin/zone)
      let printSubtitle = row.name || '';
      if (isBin && _pathMap[row.id]) {
        printSubtitle = (row.name || '') + ' • ' + _pathMap[row.id];
      } else if (isZone && parentBag) {
        printSubtitle = (row.name || '') + ' • ' + (parentBag.name || parentBag.code);
      }

      // Prefer 50x30 for bin and zone rows (hintSize hint to size picker)
      const preferSize = (isBin || isZone) ? '50x30' : '';

      // Zone rows get a left indent (visual nesting under parent bag)
      const itemStyle = isZone ? 'padding-left:28px;background:#fafcff;' : '';

      html += `
        <div class="print-list-item" data-code="${code}" style="${itemStyle}">
          <input type="checkbox" class="item-check" data-code="${code}"
                 aria-label="เลือก ${code}" ${checked}>
          <span class="item-code-name" style="flex:1;min-width:0;">
            <code class="item-code">${code}</code>
            <span class="item-name ms-1">${name}</span>
            ${breadcrumbHtml}${parentBagHtml}
          </span>
          <button type="button" class="btn btn-sm btn-outline-stock-accent btn-print-single"
                  data-code="${code}" data-name="${_esc(printSubtitle)}"
                  data-prefer-size="${preferSize}"
                  aria-label="พิมพ์ ${code}" title="พิมพ์ sticker เดี่ยว">
            <i class="bi bi-printer"></i>
          </button>
        </div>
      `;
    });

    container.innerHTML = html;

    // Select-all checkbox
    const selectAll = container.querySelector('#' + selectAllId);
    if (selectAll) {
      selectAll.indeterminate = _selected.size > 0 && _selected.size < _filtered.length;
      selectAll.checked = _selected.size > 0 && _selected.size === _filtered.length;
      selectAll.addEventListener('change', () => {
        if (selectAll.checked) {
          _filtered.forEach((r) => _selected.add(_rowCode(r)));
        } else {
          _filtered.forEach((r) => _selected.delete(_rowCode(r)));
        }
        _updateBulkBar();
        _renderList();
      });
    }

    // Row checkboxes
    container.querySelectorAll('.item-check[data-code]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const c = chk.dataset.code;
        if (chk.checked) _selected.add(c);
        else _selected.delete(c);
        _updateBulkBar();
        // Re-render to update select-all state without full re-fetch
        const sa = container.querySelector('#' + selectAllId);
        if (sa) {
          sa.indeterminate = _selected.size > 0 && _selected.size < _filtered.length;
          sa.checked = _selected.size > 0 && _selected.size === _filtered.length;
        }
      });
    });

    // Single print buttons
    container.querySelectorAll('.btn-print-single').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code       = btn.dataset.code;
        const subtitle   = btn.dataset.name;
        const sz         = _resolveSize();
        // Phase 0.7: bin/zone rows carry data-prefer-size='50x30' to hint the size picker
        const preferSize = btn.dataset.preferSize || sz.single;
        window.QRPrint.single(code, {
          size:       preferSize,
          label:      code,
          subtitle:   subtitle,
          entityType: (_activeTab || '').toUpperCase(),
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------
  function _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Comparator for .sort() by code field (alphabetical). */
  function _byCode(a, b) {
    return (a.code || '').localeCompare(b.code || '');
  }

})();
