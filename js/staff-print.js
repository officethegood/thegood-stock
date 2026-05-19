// js/staff-print.js — Phase 0.5
// Page logic for staff-print.html
//
// Access: Employee + Admin (requireRole(['Admin','Employee']) via shared/auth.js)
// Data: Supabase REST, read-only. Displays code + name ONLY (no qty/threshold/sensitive fields).
// Four entity tabs: items (stock_items), locations, bags (locations type='bag'), tanks (oxygen_tanks)
//
// Calls QRPrint.single / QRPrint.bulk from shared/qr-print.js.

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module state
  // -------------------------------------------------------------------------
  let _activeTab    = 'items';    // 'items' | 'locations' | 'bags' | 'tanks'
  let _activeSize   = 'a4';       // 'a4' | '38mm' | '50mm' | '76mm'
  let _allRows      = [];         // full fetched list for current tab
  let _filtered     = [];         // after search filter
  let _selected     = new Set();  // selected codes (strings)
  let _searchTimer  = null;

  // -------------------------------------------------------------------------
  // Auth + boot
  // -------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
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
        const printRows = rows.map((r) => ({
          code: _rowCode(r),
          label: _rowCode(r),
          subtitle: _rowName(r),
        }));
        window.QRPrint.bulk(printRows, {});
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
        // locations excluding bags
        const { data: rows, error } = await sb
          .from('locations')
          .select('id,code,name,type')
          .eq('active', true)
          .neq('type', 'bag')
          .order('code');
        if (error) throw error;
        data = rows || [];
      } else if (tab === 'bags') {
        // locations type='bag'
        const { data: rows, error } = await sb
          .from('locations')
          .select('id,code,name,type')
          .eq('active', true)
          .eq('type', 'bag')
          .order('code');
        if (error) throw error;
        data = rows || [];
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
      const code = _esc(_rowCode(row));
      const name = _esc(_rowName(row));
      const rawCode = _rowCode(row);
      const checked = _selected.has(rawCode) ? 'checked' : '';
      html += `
        <div class="print-list-item" data-code="${code}">
          <input type="checkbox" class="item-check" data-code="${code}"
                 aria-label="เลือก ${code}" ${checked}>
          <code class="item-code">${code}</code>
          <span class="item-name">${name}</span>
          <button type="button" class="btn btn-sm btn-outline-stock-accent btn-print-single"
                  data-code="${code}" data-name="${name}"
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
        const code     = btn.dataset.code;
        const subtitle = btn.dataset.name;
        const singleSize = (_activeSize === 'a4') ? '38mm' : _activeSize;
        window.QRPrint.single(code, {
          size:     singleSize,
          label:    code,
          subtitle: subtitle,
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

})();
