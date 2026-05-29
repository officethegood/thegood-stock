// shared/oxygen.js
// Phase 5 — REST helpers for oxygen_tanks and oxygen_movements.
// Client-side state-machine validation (mirrors server for UX feedback).
// Status labels, badge classes, and error mapper.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md §5
//   docs/superpowers/specs/2026-05-19-phase5-decisions-locked.md derived #5
//   docs/superpowers/plans/2026-05-19-phase5-oxygen-plan.md Task B1
//
// Locked decisions:
//   Q-Phase5-1: tank sizes 0.5Q/1.5Q/4.5Q/6Q (Layout-Stock-2026-O2), text col on oxygen_tanks.
//   Q-Phase5-2: OXYGEN_REFILL_THRESHOLD default 5, configurable via settings.
//   Q-Phase5-3: maintenance reason = free text in oxygen_movements.note.
//   Q-Phase5-4: photo optional on all transitions, reuses PhotoCaptureModal.
//
// Public namespace: window.AppOxygen

(function () {
  'use strict';

  // =========================================================================
  // State machine constants (mirrors DB enforce_oxygen_state_machine trigger)
  // =========================================================================

  /**
   * Allowed to_status values per from_status.
   * null key = initial placement (Admin only, enforced server-side).
   * Retired has no transitions (terminal state).
   */
  const ALLOWED_TRANSITIONS = {
    null:            ['ready'],                       // initial placement — Admin only
    ready:           ['on_board'],
    on_board:        ['ready', 'awaiting_refill', 'refilling'],
    awaiting_refill: ['refilling', 'ready'],          // ready is Admin-only (cancel) — see staff map
    refilling:       ['ready'],                       // Admin only — server enforces
    maintenance:     ['ready'],                       // Admin only — server enforces
    // retired: [] — terminal state, no transitions allowed
  };

  /**
   * to_status values that require Admin role.
   * Used to filter the transition select in the staff scan wizard.
   */
  const ADMIN_ONLY_TO_STATUS = new Set([
    'ready',       // when from_status = 'refilling' (refilling → ready)
    'maintenance',
    'retired',
  ]);

  /**
   * from_status / to_status combos that are Admin-only transitions.
   * Staff can do ready→on_board, on_board→ready, on_board→refilling.
   * All others require Admin.
   */
  const STAFF_ALLOWED_TRANSITIONS = {
    ready:           ['on_board'],
    on_board:        ['ready', 'awaiting_refill', 'refilling'],
    awaiting_refill: ['refilling'],   // NOT ready — awaiting_refill→ready is the Admin cancel
  };

  /**
   * Thai display labels for each status enum value.
   */
  const STATUS_LABELS = {
    ready:           'พร้อมใช้',
    on_board:        'ประจำรถ',
    awaiting_refill: 'รอส่งเติม',   // off truck, staged at base, waiting to be batch-sent
    refilling:       'กำลังเติม',   // at the vendor being refilled (was 'รอเติม')
    maintenance:     'ซ่อมบำรุง',
    retired:         'ปลดระวาง',
  };

  /**
   * Bootstrap badge CSS class per status.
   * bg-orange requires the custom CSS variable defined in Phase 0 shared/styles.css.
   */
  const STATUS_BADGE_CLASS = {
    ready:           'badge bg-success',
    on_board:        'badge bg-primary',
    awaiting_refill: 'badge bg-warning text-dark',   // amber — needs action (send to vendor)
    refilling:       'badge bg-info text-dark',       // cyan — in progress at vendor
    maintenance:     'badge bg-orange text-white',
    retired:         'badge bg-secondary',
  };

  /**
   * Display labels for tank_size values.
   * Sizes are the cylinder Q-ratings from Layout-Stock-2026-O2 — the code is
   * already the human-readable label, so each maps to itself.
   */
  const SIZE_LABELS = {
    '0.5Q': '0.5Q',
    '1.5Q': '1.5Q',
    '4.5Q': '4.5Q',
    '6Q':   '6Q',
  };

  /**
   * Action-verb labels per state transition.
   * MUST stay in sync with notify_oxygen_movement_to_tg() trigger
   * (supabase/migrations/20260525020000_fix_notify_emojis.sql §2)
   * so Telegram notifications and FE wizard cards share vocabulary.
   *
   * Status names ("ประจำรถ"/"พร้อมใช้") describe a STATE; users picking a
   * card need to know the ACTION — hence verbs like "ขึ้นรถ"/"คืนถัง".
   * Vocab mismatch caused operator inversion (Telegram showed "คืนถัง"
   * when staff thought they were doing "ขึ้นรถ").
   */
  const TRANSITION_LABELS = {
    'null→ready':                { emoji: '🆕',  verb: 'รับถังใหม่',   subtitle: 'ลงทะเบียนถังเข้าระบบ' },
    'ready→on_board':            { emoji: '🚐',  verb: 'ขึ้นรถ',       subtitle: 'ติดถังขึ้นรถพยาบาล' },
    'on_board→ready':            { emoji: '🏠',  verb: 'คืนถัง',       subtitle: 'นำถังกลับเข้าห้องเก็บ' },
    'on_board→awaiting_refill':  { emoji: '⬇️', verb: 'ลงรอเติม',     subtitle: 'นำถังลงจากรถ มากองรอที่ฐาน' },
    'on_board→refilling':        { emoji: '⛽',  verb: 'ส่งเติม',      subtitle: 'ถังหมดบนรถ ส่งร้านเลย' },
    'awaiting_refill→refilling': { emoji: '🚚',  verb: 'ส่งร้าน',      subtitle: 'ส่งถังกองรอไปเติมที่ร้าน' },
    'awaiting_refill→ready':     { emoji: '↩️', verb: 'ยกเลิกรอเติม', subtitle: 'ถังยังมีแก๊ส ไม่ต้องเติม' },
    'refilling→ready':           { emoji: '✅',  verb: 'เติมเสร็จ',    subtitle: 'เติมเสร็จ พร้อมใช้' },
    'maintenance→ready':         { emoji: '🛠️', verb: 'ซ่อมเสร็จ',    subtitle: 'ซ่อมเสร็จ พร้อมใช้' },
  };

  /**
   * Fallback per to_status — matches trigger's broad branches
   * (any → maintenance, any → retired).
   */
  const TRANSITION_FALLBACK_BY_TO = {
    maintenance: { emoji: '🔧', verb: 'ส่งซ่อม',   subtitle: 'ส่งถังไปซ่อมบำรุง' },
    retired:     { emoji: '⛔', verb: 'ปลดระวาง',  subtitle: 'ปลดถังออกจากระบบ (ไม่สามารถย้อนได้)' },
  };

  /**
   * Look up the action-verb label for a (fromStatus, toStatus) transition.
   * Falls back to status name when no verb is defined.
   *
   * @param {string|null} fromStatus
   * @param {string}      toStatus
   * @returns {{ emoji: string, verb: string, subtitle: string }}
   */
  function getTransitionLabel(fromStatus, toStatus) {
    const key = `${fromStatus === null || fromStatus === undefined ? 'null' : fromStatus}→${toStatus}`;
    if (TRANSITION_LABELS[key]) return TRANSITION_LABELS[key];
    if (TRANSITION_FALLBACK_BY_TO[toStatus]) return TRANSITION_FALLBACK_BY_TO[toStatus];
    return { emoji: '🔄', verb: STATUS_LABELS[toStatus] || toStatus, subtitle: '' };
  }

  // =========================================================================
  // Error handling
  // =========================================================================

  /**
   * The canonical FE-greppable error string from the BEFORE INSERT trigger.
   * Decisions-locked derived #5 — verbatim, do not change.
   */
  const STATE_MACHINE_ERROR = 'การเปลี่ยนสถานะถังนี้ไม่ถูกต้อง';

  /**
   * Map a Supabase REST error to a localised Thai message.
   * Returns null if the error is not a recognised oxygen error.
   */
  function _mapError(err) {
    if (!err) return null;
    const msg = (err.message || err.details || '');
    if (msg.includes(STATE_MACHINE_ERROR)) {
      return 'การเปลี่ยนสถานะนี้ไม่อนุญาต';
    }
    if (msg.includes('ถูกปลดระวางแล้ว')) {
      return 'ถังนี้ถูกปลดระวางแล้ว ไม่สามารถใช้งานได้';
    }
    if (msg.includes('สถานะปัจจุบันของถัง')) {
      return 'สถานะถังในระบบไม่ตรงกัน กรุณารีเฟรชและลองใหม่';
    }
    if (msg.includes('23505') || msg.includes('unique')) {
      return 'หมายเลขถังนี้มีอยู่แล้ว';
    }
    if (msg.includes('ที่ลบถังได้')) {
      return 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบถังได้';
    }
    if (msg.includes('เฉพาะผู้ดูแลระบบ')) {
      return 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขข้อมูลถังได้';
    }
    if (msg.includes('ขนาดถังไม่ถูกต้อง')) {
      return 'ขนาดถังไม่ถูกต้อง กรุณาเลือกใหม่';
    }
    if (msg.includes('ค่าแรงดันต้องมากกว่า')) {
      return 'ค่าแรงดันต้องเป็นตัวเลขมากกว่า 0';
    }
    return null;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  function _sb() {
    // Phase 0 global: window.getSupabaseClient()
    if (typeof window.getSupabaseClient === 'function') return window.getSupabaseClient();
    throw new Error('[AppOxygen] getSupabaseClient() not found — load shared/supabase-client.js first');
  }

  function _throw(err) {
    const friendly = _mapError(err) || (err && err.message) || 'ข้อผิดพลาดที่ไม่รู้จัก';
    const e = new Error(friendly);
    e.original = err;
    throw e;
  }

  // =========================================================================
  // REST helpers
  // =========================================================================

  /**
   * List oxygen_tanks with optional status filter and serial search.
   * @param {{ status?: string, search?: string, limit?: number }} opts
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function listTanks({ status, search, limit = 200 } = {}) {
    const sb = _sb();
    let q = sb
      .from('oxygen_tanks')
      .select(`
        id, serial, tank_size, status,
        current_location_id,
        last_refill_at, last_refill_by,
        last_pressure_psi, next_inspection_due,
        notes, created_at, updated_at, created_by, updated_by,
        locations ( id, name, code )
      `)
      .order('serial', { ascending: true })
      .limit(limit);

    if (status) q = q.eq('status', status);
    if (search) q = q.ilike('serial', `%${search}%`);

    return q;
  }

  /**
   * Get a single tank by its serial number.
   * Returns null in the data field if not found.
   * @param {string} serial
   * @returns {Promise<{ data: object|null, error: object|null }>}
   */
  async function getTankBySerial(serial) {
    const sb = _sb();
    const { data, error } = await sb
      .from('oxygen_tanks')
      .select(`
        id, serial, tank_size, status,
        current_location_id,
        last_refill_at, last_refill_by,
        last_pressure_psi, next_inspection_due,
        notes, created_at, updated_at, created_by, updated_by,
        locations ( id, name, code )
      `)
      .eq('serial', serial)
      .maybeSingle();
    return { data, error };
  }

  /**
   * Get movement history for a tank.
   * @param {string} tankId  UUID of the oxygen_tanks row.
   * @returns {Promise<{ data: Array, error: object|null }>}
   */
  async function getTankHistory(tankId) {
    const sb = _sb();
    return sb
      .from('oxygen_movements')
      .select(`
        id, from_status, to_status,
        from_location_id, to_location_id,
        performed_by, performed_at,
        note, photo_url, created_at,
        from_loc:locations!oxygen_movements_from_location_id_fkey ( id, name, code ),
        to_loc:locations!oxygen_movements_to_location_id_fkey ( id, name, code )
      `)
      .eq('tank_id', tankId)
      .order('performed_at', { ascending: false });
  }

  /**
   * Insert a movement row (state transition).
   * Throws a localised Thai error if the transition is rejected by the trigger.
   *
   * @param {{
   *   tankId:       string,
   *   fromStatus:   string|null,
   *   toStatus:     string,
   *   toLocationId: string|null,
   *   note:         string|null,
   *   photoUrl:     string|null,
   * }} opts
   * @returns {Promise<{ data: Array, error: null }>}
   */
  async function logTransition({ tankId, fromStatus, toStatus, toLocationId, note, photoUrl }) {
    if (!tankId) throw new Error('[AppOxygen.logTransition] tankId is required');
    if (!toStatus) throw new Error('[AppOxygen.logTransition] toStatus is required');

    const sb = _sb();
    const row = {
      tank_id:         tankId,
      from_status:     fromStatus ?? null,
      to_status:       toStatus,
      to_location_id:  toLocationId  ?? null,
      note:            note          ?? null,
      photo_url:       photoUrl      ?? null,
    };

    const { data, error } = await sb.from('oxygen_movements').insert(row).select();
    if (error) _throw(error);
    return { data, error: null };
  }

  /**
   * Update an oxygen tank's mutable fields (Admin only).
   * Calls the rpc_update_oxygen_tank SECURITY DEFINER function — status,
   * location and refill columns CANNOT be changed through this path.
   *
   * @param {{
   *   tankId:            string,
   *   tankSize:          string,
   *   nextInspectionDue: string|null,   // 'YYYY-MM-DD' or null
   *   lastPressurePsi:   number|null,
   *   notes:             string|null,
   * }} opts
   * @returns {Promise<{ data: object, error: null }>}
   */
  async function updateTank({ tankId, tankSize, nextInspectionDue, lastPressurePsi, notes }) {
    if (!tankId)   throw new Error('[AppOxygen.updateTank] tankId is required');
    if (!tankSize) throw new Error('[AppOxygen.updateTank] tankSize is required');

    const sb = _sb();
    const { data, error } = await sb.rpc('rpc_update_oxygen_tank', {
      p_tank_id:             tankId,
      p_tank_size:           tankSize,
      p_next_inspection_due: nextInspectionDue || null,
      p_last_pressure_psi:   (lastPressurePsi ?? null),
      p_notes:               notes || null,
    });
    if (error) _throw(error);
    return { data, error: null };
  }

  /**
   * Permanently delete an oxygen tank (Admin only).
   * Calls the rpc_delete_oxygen_tank SECURITY DEFINER function, which deletes
   * the tank's initial-placement movement row(s) and the tank itself in one
   * transaction. The RPC rejects any tank that has operational history — those
   * must be retired, not deleted — and throws a localised Thai error.
   *
   * @param {{ tankId: string }} opts
   * @returns {Promise<{ error: null }>}
   */
  async function deleteTank({ tankId }) {
    if (!tankId) throw new Error('[AppOxygen.deleteTank] tankId is required');

    const sb = _sb();
    const { error } = await sb.rpc('rpc_delete_oxygen_tank', {
      p_tank_id: tankId,
    });
    if (error) _throw(error);
    return { error: null };
  }

  /**
   * Get counts of tanks grouped by status.
   * @returns {Promise<{ ready: number, on_board: number, awaiting_refill: number, refilling: number, maintenance: number, retired: number }>}
   */
  async function getTankStatusCounts() {
    const sb = _sb();
    const { data, error } = await sb
      .from('oxygen_tanks')
      .select('status');

    if (error) _throw(error);

    const counts = { ready: 0, on_board: 0, awaiting_refill: 0, refilling: 0, maintenance: 0, retired: 0 };
    for (const row of (data || [])) {
      if (counts[row.status] !== undefined) counts[row.status]++;
    }
    return counts;
  }

  /**
   * Get allowed to_status values for a given from_status.
   * Pass isAdmin=true to include Admin-only transitions.
   * @param {string|null} fromStatus
   * @param {boolean} isAdmin
   * @returns {string[]}
   */
  function getAllowedTransitions(fromStatus, isAdmin = false) {
    if (fromStatus === 'retired') return [];
    const all = ALLOWED_TRANSITIONS[fromStatus ?? null] || [];
    if (isAdmin) return all;
    return (STAFF_ALLOWED_TRANSITIONS[fromStatus] || []).filter((s) => all.includes(s));
  }

  /**
   * Realtime subscription helper.
   * @param {function} onChange  Called on INSERT/UPDATE to oxygen_tanks.
   * @returns {function}  Teardown function — call to unsubscribe.
   */
  function subscribeOxygenTanks(onChange) {
    const sb = _sb();
    // Defensive: drop any stale channel of the same name first — calling
    // channel(name) twice returns the existing already-subscribed channel,
    // and a subsequent .on() throws "cannot add callbacks after subscribe()".
    try {
      (sb.getChannels() || [])
        .filter((c) => c && c.topic === 'realtime:oxygen-tanks-realtime')
        .forEach((c) => sb.removeChannel(c));
    } catch { /* ignore */ }
    const channel = sb
      .channel('oxygen-tanks-realtime')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'oxygen_tanks' },
        (payload) => { try { onChange(payload); } catch (e) { console.error('[AppOxygen] realtime handler error', e); } }
      )
      .subscribe();

    return () => { try { sb.removeChannel(channel); } catch {} };
  }

  // =========================================================================
  // Public namespace
  // =========================================================================
  window.AppOxygen = {
    // REST helpers
    listTanks,
    getTankBySerial,
    getTankHistory,
    logTransition,
    updateTank,
    deleteTank,
    getTankStatusCounts,
    subscribeOxygenTanks,

    // State machine helpers
    getAllowedTransitions,
    getTransitionLabel,

    // Constants
    ALLOWED_TRANSITIONS,
    ADMIN_ONLY_TO_STATUS,
    STAFF_ALLOWED_TRANSITIONS,
    STATUS_LABELS,
    STATUS_BADGE_CLASS,
    SIZE_LABELS,
    TRANSITION_LABELS,
    STATE_MACHINE_ERROR,
  };

})();
