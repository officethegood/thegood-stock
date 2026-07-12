// shared/loans.js
// Phase 3 — REST helpers for stock_loans (borrow/return lifecycle).
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase3-borrow-return-design.md §5, §7.3, §7.4
//   docs/superpowers/specs/2026-05-19-phase3-decisions-locked.md    Q-Phase3-C, D, E, G
//   docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md §5, §6
//
// Locked decisions enforced here:
//   Q-Phase3-C — photo is advisory; movement proceeds with photo_*_url = null
//   Q-Phase3-D — borrower_username: Staff auto-fills with own username; Admin passes explicit value
//   Q-Phase3-E — due_at: dedicated column on stock_movements (NOT encoded in note)
//   Q-Phase3-G — due_at default = 3 days from now; presets 1/3/7/custom
//
// Trigger error strings (exact — DB raises these; FE greps them):
//   'ของยืมเลยกำหนด'           — borrow with past due_at (BEFORE INSERT trigger)
//   'ต้องระบุกำหนดคืน'          — borrow without due_at (BEFORE INSERT trigger)
//   'ไม่พบรายการยืมที่เปิดอยู่'   — return with no matching open loan (AFTER INSERT trigger)
//
// Requires (loaded before this script):
//   shared/supabase-client.js — window.getSupabaseClient()
//
// Pattern: IIFE exposing window.AppLoans namespace (mirrors shared/lots.js pattern).

(function () {
  'use strict';

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

  // ==========================================================================
  // Trigger error → Thai toast mapper
  // Mirrors Phase 2 shared/lots.js mapTriggerErrorToToast pattern.
  // ==========================================================================

  /**
   * Map a DB trigger exception message to a user-friendly Thai toast message.
   * FE greps exact Thai strings from DB RAISE EXCEPTION.
   *
   * @param {string|object} errorObj — Supabase REST error object or string message
   * @returns {string} Thai string for showToast
   */
  function mapTriggerErrorToToast(errorObj) {
    const msg = (errorObj && errorObj.message) ? errorObj.message
              : (typeof errorObj === 'string' ? errorObj : '');

    if (msg.includes('ของยืมเลยกำหนด')) {
      return 'กำหนดคืนต้องเป็นวันในอนาคต';
    }
    if (msg.includes('ต้องระบุกำหนดคืน')) {
      return 'กรุณาระบุวันกำหนดคืนก่อนบันทึก';
    }
    if (msg.includes('ไม่พบรายการยืมที่เปิดอยู่')) {
      return 'ไม่พบรายการยืมที่เปิดอยู่';
    }
    // Lot-tracked borrow (20260709): trigger strings from check_lot_status /
    // apply_movement_to_sil — must be checked before the generic qty case.
    if (msg.includes('ล็อตหมดอายุหรือถูกเรียกคืน')) {
      return 'ล็อตนี้หมดอายุหรือถูกเรียกคืน — เลือกล็อตอื่น';
    }
    if (msg.includes('lot current_qty negative') ||
        msg.includes('stock_lots_current_qty_check')) {
      return 'ของในล็อตไม่พอ — ไม่สามารถยืมได้';
    }
    if (msg.includes('lot_id is required')) {
      return 'สินค้านี้เป็นของคุมล็อต — กรุณาเลือกล็อตก่อนยืม';
    }
    if (msg.includes('would drive qty negative')) {
      return 'ของไม่พอ — ไม่สามารถยืมได้';
    }
    if (msg.includes('client_ref_id') || (errorObj && errorObj.code === '23505')) {
      return 'รายการนี้บันทึกแล้ว';
    }
    return msg || 'เกิดข้อผิดพลาด — ลองใหม่อีกครั้ง';
  }

  // ==========================================================================
  // due_at helpers — Q-Phase3-G
  // ==========================================================================

  /**
   * Return a Date object N days from now at end-of-day local time.
   * @param {number} days
   * @returns {Date}
   */
  function dueDateFromNow(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(23, 59, 0, 0);
    return d;
  }

  /**
   * Default due_at: 3 days from now (Q-Phase3-G).
   * @returns {Date}
   */
  function defaultDueAt() {
    return dueDateFromNow(3);
  }

  /**
   * Format a Date as a Thai-locale readable string.
   * @param {Date|string} d
   * @returns {string}  e.g. "22 พ.ค. 2569"
   */
  function formatThaiDate(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('th-TH', {
      day: 'numeric', month: 'short', year: 'numeric',
      timeZone: 'Asia/Bangkok',
    });
  }

  /**
   * Days overdue (positive) or days remaining (negative) from today.
   * @param {string|Date} dueAt
   * @returns {number}
   */
  function daysOverdue(dueAt) {
    const now  = new Date();
    const due  = new Date(dueAt);
    return Math.floor((now - due) / 86400000);
  }

  // ==========================================================================
  // REST helpers
  // ==========================================================================

  /**
   * List all active + overdue loans (admin loan list default view).
   * Joins stock_items and locations for display columns.
   *
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function listActiveLoans() {
    return _safe(() =>
      _sb()
        .from('stock_loans')
        .select(`
          id, borrower_username, qty, status,
          borrowed_at, due_at, returned_at,
          photo_borrow_url, photo_return_url,
          notes, created_at,
          movement_id_borrow, movement_id_return,
          stock_items!item_id(id, name, sku),
          locations!location_id_from(id, code, name)
        `)
        .in('status', ['active', 'overdue'])
        .order('due_at', { ascending: true })
    );
  }

  /**
   * List only overdue loans.
   *
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function listOverdueLoans() {
    return _safe(() =>
      _sb()
        .from('stock_loans')
        .select(`
          id, borrower_username, qty, status,
          borrowed_at, due_at,
          stock_items!item_id(id, name, sku),
          locations!location_id_from(id, code, name)
        `)
        .eq('status', 'overdue')
        .order('due_at', { ascending: true })
    );
  }

  /**
   * List all loans for the current authenticated user.
   * Used by Staff return flow to find their open loans.
   *
   * @param {object} [opts]
   * @param {string} [opts.username]  — override borrower_username filter (Admin use)
   * @param {string[]} [opts.statuses] — default ['active','overdue']
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function listMyLoans({ username, statuses } = {}) {
    const sb      = _sb();
    let q = sb
      .from('stock_loans')
      .select(`
        id, borrower_username, qty, status,
        borrowed_at, due_at, returned_at,
        photo_borrow_url,
        notes,
        stock_items!item_id(id, name, sku),
        locations!location_id_from(id, code, name)
      `)
      .in('status', statuses || ['active', 'overdue'])
      .order('borrowed_at', { ascending: false });

    if (username) {
      q = q.eq('borrower_username', username);
    }
    // When no username override, PostgREST RLS returns only rows where
    // borrower_username = app_username() via the sl3_update_photo_own policy.
    // For Admin list, pass explicit username or rely on sl3_update_admin.
    return _safe(() => q);
  }

  /**
   * Fetch a single loan by ID.
   *
   * @param {string} loanId
   * @returns {Promise<{ data: object|null, error: object|null }>}
   */
  async function fetchLoan(loanId) {
    return _safe(() =>
      _sb()
        .from('stock_loans')
        .select(`
          id, borrower_username, qty, status,
          borrowed_at, due_at, returned_at,
          photo_borrow_url, photo_return_url,
          notes, created_at, updated_at, created_by, updated_by,
          movement_id_borrow, movement_id_return,
          stock_items!item_id(id, name, sku, unit),
          locations!location_id_from(id, code, name)
        `)
        .eq('id', loanId)
        .single()
    );
  }

  /**
   * Find active/overdue loans for a given item and borrower.
   * Used in Staff return flow Step 1 after scanning item.
   *
   * @param {string} itemId
   * @param {string} [borrowerUsername]  — omit to query via RLS (current user)
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function findOpenLoansForItem(itemId, borrowerUsername) {
    let q = _sb()
      .from('stock_loans')
      .select(`
        id, borrower_username, qty, status,
        borrowed_at, due_at,
        photo_borrow_url,
        locations!location_id_from(id, code, name)
      `)
      .eq('item_id', itemId)
      .in('status', ['active', 'overdue'])
      .order('borrowed_at', { ascending: false });

    if (borrowerUsername) {
      q = q.eq('borrower_username', borrowerUsername);
    }
    return _safe(() => q);
  }

  /**
   * Dashboard borrow panel counts.
   *
   * @returns {Promise<{ active: number, overdue: number, returnedToday: number }>}
   */
  async function getBorrowCounts() {
    try {
      const sb = _sb();
      const today = new Date().toISOString().split('T')[0];  // YYYY-MM-DD
      const [activeRes, overdueRes, todayRes] = await Promise.all([
        sb.from('stock_loans').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        sb.from('stock_loans').select('id', { count: 'exact', head: true }).eq('status', 'overdue'),
        sb.from('stock_loans').select('id', { count: 'exact', head: true })
          .eq('status', 'returned')
          .gte('returned_at', today + 'T00:00:00+07:00')
          .lte('returned_at', today + 'T23:59:59+07:00'),
      ]);
      return {
        active:        activeRes.count  ?? 0,
        overdue:       overdueRes.count ?? 0,
        returnedToday: todayRes.count   ?? 0,
        error: null,
      };
    } catch (e) {
      return { active: 0, overdue: 0, returnedToday: 0, error: e };
    }
  }

  /**
   * Create a borrow movement (Phase 3 — borrow flow Step 5).
   * The trigger create_loan_from_borrow fires AFTER INSERT and creates the stock_loans row.
   * FE then PATCHes stock_loans with photo_borrow_url after Cloudinary upload (Q-Phase3-C).
   *
   * @param {object} p
   * @param {string} p.itemId
   * @param {string} p.locationId
   * @param {number} p.qty                — positive (function negates for qty_delta)
   * @param {Date|string} p.dueAt         — Q-Phase3-E dedicated column
   * @param {string} [p.note]
   * @param {string} [p.borrowerUsername] — Q-Phase3-D: Admin passes explicit value; Staff omits
   * @param {string} [p.clientRefId]      — idempotency UUID; generated if omitted
   * @param {string} [p.lotId]            — required by DB when item.tracks_lots=true (20260709)
   * @returns {Promise<{ data: object|null, error: object|null }>}
   */
  async function createBorrow({ itemId, locationId, qty, dueAt, note, borrowerUsername, clientRefId, lotId }) {
    const refId = clientRefId || _uuid();
    const payload = {
      item_id:          itemId,
      location_id:      locationId,
      movement_type:    'borrow',
      qty_delta:        -(Math.abs(qty)),
      due_at:           dueAt instanceof Date ? dueAt.toISOString() : dueAt,
      note:             note || null,
      client_ref_id:    refId,
    };
    if (lotId) {
      payload.lot_id = lotId;
    }
    if (borrowerUsername) {
      payload.borrower_username = borrowerUsername;
    }
    return _safe(() =>
      _sb()
        .from('stock_movements')
        .insert(payload)
        .select('id, item_id, location_id, qty_delta, due_at, borrower_username, client_ref_id')
        .single()
    );
  }

  /**
   * Create a return movement (Phase 3 — return flow Step 3).
   * The trigger close_loan_from_return fires AFTER INSERT and closes the stock_loans row.
   * FE then PATCHes stock_loans with photo_return_url after Cloudinary upload (Q-Phase3-C).
   *
   * @param {object} p
   * @param {string} p.itemId
   * @param {string} p.locationId         — location_id_from of the open loan
   * @param {number} p.qty                — positive (return restores qty)
   * @param {string} [p.borrowerUsername] — Q-Phase3-D: Admin may specify; Staff omits
   * @param {string} [p.note]
   * @param {string} [p.clientRefId]
   * @returns {Promise<{ data: object|null, error: object|null }>}
   */
  async function createReturn({ itemId, locationId, qty, borrowerUsername, note, clientRefId }) {
    const refId = clientRefId || _uuid();
    const payload = {
      item_id:       itemId,
      location_id:   locationId,
      movement_type: 'return',
      qty_delta:     Math.abs(qty),
      note:          note || null,
      client_ref_id: refId,
    };
    if (borrowerUsername) {
      payload.borrower_username = borrowerUsername;
    }
    return _safe(() =>
      _sb()
        .from('stock_movements')
        .insert(payload)
        .select('id, item_id, location_id, qty_delta, client_ref_id')
        .single()
    );
  }

  /**
   * PATCH a loan's photo URL (called after Cloudinary upload — Q-Phase3-C advisory).
   *
   * @param {string} loanId
   * @param {'borrow'|'return'} side
   * @param {string} photoUrl
   * @returns {Promise<{ data: object|null, error: object|null }>}
   */
  async function patchLoanPhoto(loanId, side, photoUrl) {
    const field = side === 'return' ? 'photo_return_url' : 'photo_borrow_url';
    return _safe(() =>
      _sb()
        .from('stock_loans')
        .update({ [field]: photoUrl })
        .eq('id', loanId)
        .select('id, photo_borrow_url, photo_return_url')
        .single()
    );
  }

  /**
   * Find loan created by a borrow movement (used after INSERT to get the loan id).
   * Needed to PATCH photo_borrow_url after Cloudinary upload.
   *
   * @param {string} movementId
   * @returns {Promise<{ data: object|null, error: object|null }>}
   */
  async function fetchLoanByBorrowMovement(movementId) {
    return _safe(() =>
      _sb()
        .from('stock_loans')
        .select('id, status, photo_borrow_url, photo_return_url, borrower_username')
        .eq('movement_id_borrow', movementId)
        .single()
    );
  }

  /**
   * Admin list — all loans with optional filters.
   *
   * @param {object} [filters]
   * @param {string|string[]} [filters.status]     — 'active'|'overdue'|'returned'|'all'
   * @param {string}          [filters.search]     — borrower_username or item name/sku
   * @param {boolean}         [filters.overdueOnly]
   * @param {number}          [filters.limit]      — default 200
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function listLoans({ status, search, overdueOnly, limit } = {}) {
    let q = _sb()
      .from('stock_loans')
      .select(`
        id, borrower_username, qty, status,
        borrowed_at, due_at, returned_at,
        photo_borrow_url, photo_return_url,
        notes, created_at,
        stock_items!item_id(id, name, sku),
        locations!location_id_from(id, code, name)
      `)
      .limit(limit || 200)
      .order('due_at', { ascending: false });

    if (overdueOnly) {
      q = q.eq('status', 'overdue');
    } else if (status && status !== 'all') {
      const statuses = Array.isArray(status) ? status : [status];
      q = q.in('status', statuses);
    }

    return _safe(() => q);
  }

  // ==========================================================================
  // UUID helper (local)
  // ==========================================================================

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ==========================================================================
  // Public namespace
  // ==========================================================================
  window.AppLoans = {
    // REST helpers
    listActiveLoans,
    listOverdueLoans,
    listMyLoans,
    listLoans,
    fetchLoan,
    findOpenLoansForItem,
    fetchLoanByBorrowMovement,
    getBorrowCounts,
    createBorrow,
    createReturn,
    patchLoanPhoto,

    // Utilities
    mapTriggerErrorToToast,
    dueDateFromNow,
    defaultDueAt,
    formatThaiDate,
    daysOverdue,
  };

})();
