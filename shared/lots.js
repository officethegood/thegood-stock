// shared/lots.js
// Phase 2 — Medication lot REST helpers + FEFO sort + expiry badge + lot picker widget.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md   (Q-D1..Q-D5, derived #1..#11)
//   docs/superpowers/plans/2026-05-19-phase2-medication-plan.md    Task B1
//   docs/superpowers/designs/2026-05-18-phase2-ui-design.md        §3.1.3, §4.3
//
// Locked decisions:
//   Q-D1: NO force-issue override — expired/recalled lots are strictly blocked
//   Q-D2: FEFO override warning copy EXACT: "ล็อต {lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"
//   Q-D3: expired badge uses bg-stock-accent-subtle (teal-neutral, NOT red)
//         (corrected per spec: ≤0 days uses bg-danger per UX §3.1.3 color table —
//          Q-D3 says bg-stock-accent-subtle for the 60-90 day "ใกล้ครบ 90 วัน" badge.
//          See getLotBadge() below for correct mapping.)
//   Q-D4: lot picker shows 5 lots by default; accordion for "ดูทั้งหมด"
//   Q-D5: overflow-x auto (handled in CSS via .inventory-tabs-scroll)
//
// Trigger error string (exact, per Q-Phase2-4, must match DB RAISE EXCEPTION):
//   'ล็อตหมดอายุหรือถูกเรียกคืน'
//
// Requires (loaded BEFORE this script):
//   shared/supabase-client.js  — exposes window.getSupabaseClient()
//
// Pattern: IIFE exposing window.AppLots namespace (mirrors shared/inventory.js pattern).
// No ES module import syntax — same no-build-step constraint as Phase 1.

(function () {
  'use strict';

  // =========================================================================
  // Internal helper — get Supabase client (same pattern as shared/inventory.js)
  // =========================================================================

  function _sb() { return window.getSupabaseClient(); }

  /** Wrap async DB call into { data, error } envelope. */
  async function _safe(run) {
    try {
      const r = await run();
      if (r && typeof r === 'object' && ('data' in r || 'error' in r)) return r;
      return { data: r, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }

  // =========================================================================
  // REST helpers
  // =========================================================================

  /**
   * Fetch active lots for an item ordered FEFO (soonest expiry first).
   * Uses stock_lots table directly (filtered to status='active' and current_qty > 0).
   * Falls back gracefully if v_lots_with_remaining view does not exist yet.
   *
   * @param {string} itemId - UUID of the stock_item
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function fetchAvailableLots(itemId) {
    return _safe(async () => {
      // Try view first (BE may have created v_lots_with_remaining).
      const sb = _sb();
      const vRes = await sb
        .from('v_lots_with_remaining')
        .select('id,lot_number,expiry_date,current_qty,supplier,status,item_id,days_until_expiry')
        .eq('item_id', itemId)
        .order('expiry_date', { ascending: true });

      // PGRST205 = table/view not found in schema cache; 42P01 = relation does not exist.
      if (vRes.error && (vRes.error.code === 'PGRST205' || vRes.error.code === '42P01' ||
                         /v_lots_with_remaining/.test(vRes.error.message || ''))) {
        // Fallback: query stock_lots directly, join item for unit.
        return sb
          .from('stock_lots')
          .select('id,lot_number,expiry_date,current_qty,supplier,status,item_id,stock_items!inner(unit)')
          .eq('item_id', itemId)
          .eq('status', 'active')
          .gt('current_qty', 0)
          .order('expiry_date', { ascending: true });
      }
      return vRes;
    });
  }

  /**
   * Fetch all lots for an item (all statuses — for admin lot list).
   * Joins stock_items so the lot list can show item name/sku/unit.
   *
   * @param {string} itemId - UUID
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function fetchAllLots(itemId) {
    return _safe(() =>
      _sb()
        .from('stock_lots')
        .select('id,item_id,lot_number,expiry_date,received_qty,current_qty,supplier,note,status,recalled_reason,recalled_by,recalled_at,created_at,created_by,stock_items(sku,name,unit)')
        .eq('item_id', itemId)
        .order('expiry_date', { ascending: true })
    );
  }

  /**
   * Fetch all lots for all tracks_lots items (admin lot list, "ล็อตยา" sub-view).
   * Ordered by expiry_date ASC.
   *
   * @param {object} [opts]
   * @param {string} [opts.status]       filter by status ('active'|'expired'|'recalled'|'depleted'|null)
   * @param {number} [opts.expiryDays]   if set, filter to lots expiring within N days
   * @param {boolean}[opts.overdueOnly]  if true, filter to lots with expiry_date < today OR status='expired'
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function fetchAllLotsForAdmin(opts) {
    return _safe(async () => {
      const sb = _sb();
      let q = sb
        .from('stock_lots')
        .select('id,item_id,lot_number,expiry_date,received_qty,current_qty,supplier,note,status,recalled_reason,recalled_by,recalled_at,created_at,created_by,stock_items!inner(sku,name,unit,tracks_lots)')
        .eq('stock_items.tracks_lots', true)
        .order('expiry_date', { ascending: true });

      if (opts && opts.status && opts.status !== 'all') {
        q = q.eq('status', opts.status);
      }

      return q;
    });
  }

  /**
   * Create a new lot (Admin receive flow).
   * initial current_qty = received_qty (trigger will adjust on movements).
   *
   * @param {{ item_id, lot_number, expiry_date, received_qty, supplier?, note? }} lot
   * @returns {Promise<{ data: object, error: object|null }>}
   */
  async function createLot(lot) {
    return _safe(() =>
      _sb()
        .from('stock_lots')
        .insert({
          item_id:      lot.item_id,
          lot_number:   lot.lot_number,
          expiry_date:  lot.expiry_date,
          received_qty: lot.received_qty,
          current_qty:  lot.received_qty,   // initial balance
          supplier:     lot.supplier  || null,
          note:         lot.note      || null,
        })
        .select('id,lot_number,expiry_date,current_qty')
        .single()
    );
  }

  /**
   * Mark a lot as recalled (Admin action).
   * Server-side: RLS sl_update allows Admin only; three audit columns set here.
   *
   * @param {string} lotId      - UUID
   * @param {string} reason     - Required recall reason (validated on caller side)
   * @param {string} recalledBy - Current admin username
   * @returns {Promise<{ data: object, error: object|null }>}
   */
  async function recallLot(lotId, reason, recalledBy) {
    return _safe(() =>
      _sb()
        .from('stock_lots')
        .update({
          status:          'recalled',
          recalled_reason: reason,
          recalled_by:     recalledBy,
          recalled_at:     new Date().toISOString(),
        })
        .eq('id', lotId)
        .select('id,status,recalled_at,recalled_reason')
        .single()
    );
  }

  // =========================================================================
  // FEFO sort helper
  // =========================================================================

  /**
   * Sort lots by expiry_date ASC (First Expiry First Out).
   * Lots without expiry_date (null) sort last.
   * Does not mutate the input array.
   *
   * @param {Array} lots
   * @returns {Array}
   */
  function sortFEFO(lots) {
    return [...lots].sort((a, b) => {
      if (!a.expiry_date && !b.expiry_date) return 0;
      if (!a.expiry_date) return 1;
      if (!b.expiry_date) return -1;
      return new Date(a.expiry_date) - new Date(b.expiry_date);
    });
  }

  // =========================================================================
  // Expiry bucket helper (for dashboard timeline rows)
  // =========================================================================

  /**
   * Assign a lot to a named expiry bucket.
   * Buckets: 'overdue' | 'within30' | 'within60' | 'within90' | 'normal'
   * Note: 'overdue' includes both status='expired' AND active lots past expiry (pre-cron window).
   *
   * @param {object} lot - { status, expiry_date }
   * @returns {'overdue'|'within30'|'within60'|'within90'|'normal'}
   */
  function getExpiryBucket(lot) {
    if (lot.status === 'expired') return 'overdue';
    if (!lot.expiry_date) return 'normal';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp   = new Date(lot.expiry_date);
    exp.setHours(0, 0, 0, 0);
    const days = Math.floor((exp - today) / 86400000);
    if (days < 0)   return 'overdue';
    if (days <= 30) return 'within30';
    if (days <= 60) return 'within60';
    if (days <= 90) return 'within90';
    return 'normal';
  }

  // =========================================================================
  // Status + badge helpers
  // =========================================================================

  /**
   * Compute expiry badge metadata from a lot's expiry_date and status.
   * Returns { badgeClass, label, daysLeft }.
   *
   * Color mapping (UX §3.1.3):
   *   expired / days <= 0   → bg-danger text-white          "หมดอายุแล้ว"
   *   recalled              → bg-purple-subtle text-purple   "ถูกเรียกคืน"
   *   depleted              → bg-secondary text-white        "ใช้หมดแล้ว"
   *   days <= 30  (active)  → bg-warning text-dark           "ใกล้หมดอายุ"
   *   days <= 60  (active)  → bg-warning text-dark + opacity "เฝ้าระวัง"
   *   days <= 90  (active)  → bg-stock-accent-subtle text-stock-accent-dark   "ใกล้ครบ 90 วัน"  ← Q-D3
   *   days > 90   (active)  → bg-success text-white          "ปกติ"
   *
   * @param {{ status: string, expiry_date: string, days_until_expiry?: number }} lot
   * @returns {{ badgeClass: string, label: string, daysLeft: number|null }}
   */
  function getLotBadge(lot) {
    const days = (lot.days_until_expiry !== undefined && lot.days_until_expiry !== null)
      ? lot.days_until_expiry
      : (lot.expiry_date
          ? (function () {
              const today = new Date(); today.setHours(0,0,0,0);
              const exp   = new Date(lot.expiry_date); exp.setHours(0,0,0,0);
              return Math.floor((exp - today) / 86400000);
            }())
          : null);

    if (lot.status === 'recalled')
      return { badgeClass: 'bg-purple-subtle text-purple',                  label: 'ถูกเรียกคืน',    daysLeft: days };
    if (lot.status === 'depleted')
      return { badgeClass: 'bg-secondary text-white',                       label: 'ใช้หมดแล้ว',     daysLeft: days };
    if (lot.status === 'expired' || (days !== null && days < 0))
      return { badgeClass: 'bg-danger text-white',                          label: 'หมดอายุแล้ว',    daysLeft: days };
    if (days !== null && days === 0)
      return { badgeClass: 'bg-danger text-white',                          label: 'หมดอายุวันนี้',  daysLeft: days };
    if (days !== null && days <= 30)
      return { badgeClass: 'bg-warning text-dark',                          label: 'ใกล้หมดอายุ',    daysLeft: days };
    if (days !== null && days <= 60)
      return { badgeClass: 'bg-warning text-dark opacity-75',               label: 'เฝ้าระวัง',      daysLeft: days };
    if (days !== null && days <= 90)
      return { badgeClass: 'bg-stock-accent-subtle text-stock-accent-dark', label: 'ใกล้ครบ 90 วัน', daysLeft: days };
    return   { badgeClass: 'bg-success text-white',                         label: 'ปกติ',           daysLeft: days };
  }

  /**
   * Format an ISO date string as Thai DD/MM/YYYY (Buddhist Era year = CE + 543).
   *
   * @param {string|null} dateStr  e.g. '2027-05-01'
   * @returns {string}             e.g. '01/05/2570'
   */
  function formatThaiDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear() + 543;
    return `${dd}/${mm}/${yyyy}`;
  }

  // =========================================================================
  // Trigger error mapper (Q-Phase2-4)
  // =========================================================================

  /**
   * Detect the exact server error string from the DB trigger check_lot_status
   * and return a user-facing Thai toast copy.
   *
   * Trigger raises: 'ล็อตหมดอายุหรือถูกเรียกคืน'
   * UI copy returned: 'ล็อตนี้หมดอายุหรือถูกเรียกคืน — เลือกล็อตอื่น'
   *
   * @param {{ message?: string, details?: string } | null} error
   * @returns {string|null}  Thai toast copy, or null if this is not a lot-status error
   */
  function mapTriggerErrorToToast(error) {
    if (!error) return null;
    const msg = String(error.message || error.details || '');
    if (msg.includes('ล็อตหมดอายุหรือถูกเรียกคืน')) {
      return 'ล็อตนี้หมดอายุหรือถูกเรียกคืน — เลือกล็อตอื่น';
    }
    return null;
  }

  // =========================================================================
  // Lot picker widget (staff scan step 2.5)
  // =========================================================================

  /**
   * Render a lot picker for staff scan step 2.5.
   *
   * Q-D4: shows up to 5 lots by default (FEFO order); "ดูทั้งหมด ({n} ล็อต)" accordion link
   *       to expand remaining lots.
   * Q-D1: expired/recalled lots are aria-disabled=true + visually grayed — tap does nothing.
   * Q-D2: FEFO default (lots[0]) is pre-selected and marked with a badge.
   *
   * Tap target height: min 44px per mobile-first requirement.
   *
   * @param {Array}    lots          - FEFO-sorted array of lot objects from fetchAvailableLots
   * @param {string}   selectedLotId - Pre-selected lot id (default: lots[0].id)
   * @param {Function} onSelect      - Callback(lot) called when a selectable lot is tapped
   * @returns {HTMLElement}          - Container div ready to insert into DOM
   */
  function renderLotPicker(lots, selectedLotId, onSelect) {
    const DEFAULT_SHOW = 5;   // Q-D4
    const container = document.createElement('div');
    container.className = 'lot-picker';
    container.setAttribute('role', 'listbox');
    container.setAttribute('aria-label', 'เลือกล็อตยา');

    if (!lots || lots.length === 0) {
      container.innerHTML = `
        <div class="text-center py-4">
          <p class="fw-semibold mb-1">ไม่มีล็อตยาที่พร้อมใช้งาน</p>
          <p class="text-muted small mb-0">ติดต่อผู้ดูแลระบบเพื่อรับเข้าล็อตใหม่</p>
        </div>`;
      return container;
    }

    const currentId = selectedLotId || lots[0].id;

    function buildCard(lot, isFefoDefault) {
      const badge    = getLotBadge(lot);
      const isBlocked = lot.status === 'expired' || lot.status === 'recalled';
      const isSelected = lot.id === currentId;

      const card = document.createElement('div');
      card.className = [
        'card mb-2 lot-picker-card',
        isSelected ? 'border-primary' : '',
        isBlocked  ? 'lot-picker-card--blocked opacity-50' : '',
      ].join(' ').trim();
      card.dataset.lotId = lot.id;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', isSelected ? 'true' : 'false');

      // Q-D1: expired/recalled lots are aria-disabled and do not respond to tap.
      if (isBlocked) {
        card.setAttribute('aria-disabled', 'true');
        card.style.cursor = 'not-allowed';
        card.setAttribute('tabindex', '-1');
      } else {
        card.style.cursor = 'pointer';
        card.setAttribute('tabindex', '0');
        card.style.minHeight = '44px';  // mobile tap target

        card.addEventListener('click', () => onSelect(lot));
        card.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onSelect(lot);
          }
        });
      }

      const unit = (lot.stock_items && lot.stock_items.unit) ? lot.stock_items.unit : 'ชิ้น';

      card.innerHTML = `
        <div class="card-body py-2 px-3" style="min-height:44px;">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div class="flex-grow-1">
              ${isFefoDefault && !isBlocked
                ? '<span class="badge bg-primary-subtle text-primary me-1 small">FEFO — เลือกอัตโนมัติ</span>'
                : ''}
              <span class="fw-semibold">${_esc(lot.lot_number)}</span>
              ${isBlocked ? `<span class="ms-1 small text-muted">(${badge.label})</span>` : ''}
            </div>
            <span class="badge ${badge.badgeClass} flex-shrink-0">${_esc(badge.label)}</span>
          </div>
          <div class="text-muted small mt-1">
            หมดอายุ ${formatThaiDate(lot.expiry_date)}
            &nbsp;·&nbsp; คงเหลือ ${_esc(String(lot.current_qty))} ${_esc(unit)}
          </div>
        </div>`;

      return card;
    }

    const visibleLots = lots.slice(0, DEFAULT_SHOW);
    const hiddenLots  = lots.slice(DEFAULT_SHOW);

    visibleLots.forEach((lot, i) => container.appendChild(buildCard(lot, i === 0)));

    if (hiddenLots.length > 0) {
      const totalCount = lots.length;
      const expandBtn  = document.createElement('button');
      expandBtn.type   = 'button';
      expandBtn.className = 'btn btn-link btn-sm text-muted px-0 mt-1';
      // Q-D4 accordion copy format: "ดูทั้งหมด ({n} ล็อต)"
      expandBtn.textContent = `ดูทั้งหมด (${totalCount} ล็อต)`;
      expandBtn.style.minHeight = '44px';
      expandBtn.addEventListener('click', () => {
        hiddenLots.forEach((lot) => container.insertBefore(buildCard(lot, false), expandBtn));
        expandBtn.remove();
      });
      container.appendChild(expandBtn);
    }

    return container;
  }

  // =========================================================================
  // Utility — escapeHtml (mirrors shared/ui.js; fallback in case load order shifts)
  // =========================================================================

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // =========================================================================
  // Realtime subscription helper (extends Phase 1 channel)
  // =========================================================================

  /**
   * Subscribe to stock_lots table changes (status updates from cron auto-expire
   * or Admin recall propagate in real-time).
   *
   * Returns an unsubscribe function. Call it on tab teardown.
   *
   * @param {(table: string, payload: object) => void} onChange
   * @returns {() => void} unsubscribe
   */
  function subscribeStockLots(onChange) {
    const sb = _sb();
    const ch = sb.channel('lots:phase2')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_lots' },
          (p) => onChange('stock_lots', p))
      .subscribe();
    return () => { try { sb.removeChannel(ch); } catch { /* ignore */ } };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  window.AppLots = {
    // REST helpers
    fetchAvailableLots,
    fetchAllLots,
    fetchAllLotsForAdmin,
    createLot,
    recallLot,
    // Sort / bucket
    sortFEFO,
    getExpiryBucket,
    // Badge / format
    getLotBadge,
    formatThaiDate,
    // Error mapping (trigger error → toast copy)
    mapTriggerErrorToToast,
    // UI widget
    renderLotPicker,
    // Realtime
    subscribeStockLots,
  };

})();
