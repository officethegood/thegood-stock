// js/staff-scan.js
// Phase 1 + Phase 2 — Staff Scan page controller.
//
// Design:  docs/superpowers/designs/2026-05-18-phase1-ui-design.md §3 (Area 2)
//          docs/superpowers/designs/2026-05-18-phase2-ui-design.md  §3.4, §5.2
// Spec:    docs/superpowers/specs/2026-05-18-phase1-inventory-design.md §7.3
//          docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md Q-D1, Q-D2, Q-D4
// Plan:    docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md Phase E
//          docs/superpowers/plans/2026-05-19-phase2-medication-plan.md Task B4
//
// Locked decisions enforced here:
//   Q-Phase1-F  Dedicated staff-scan.html (we ARE that page)
//   Q-Phase1-G  Staff can do `issue` + `adjustment_loss` only — UI hides the rest
//   Q-Phase1-J  client_ref_id UUID UNIQUE for idempotent retries
//   Q3 (PM)     NO photo upload — even for adjustment_loss in Phase 1
//   Q-D1 (Phase 2) NO force-issue override — expired/recalled lots CANNOT be issued, period
//   Q-D2 (Phase 2) FEFO override warning modal when non-FEFO lot selected
//                  Exact copy: "ล็อต {lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"
//   Q-D4 (Phase 2) Lot picker shows 5 lots by default; accordion for remainder
//
// Upstream APIs consumed:
//   window.ensureLoggedIn / getUserName / handleLogout
//   window.AppScanner.{isSupported, hasNativeDetector, startScanning, stopScanning, parseScanResult}
//   window.AppInventory.{issue, adjustmentLoss, searchByBarcode, findLocationByCode, getItem, listItems, _uuid}
//   window.AppLots (shared/lots.js — Phase 2): fetchAvailableLots, renderLotPicker, getLotBadge, formatThaiDate, mapTriggerErrorToToast
//   window.showToast (shared/ui.js)
//
// State machine (Phase 2 extended):
//   IDLE → ITEM_SCANNED → LOCATION_SCANNED
//          ↓ (if item.tracks_lots=true AND action=issue/adjustment_loss)
//          LOT_LOADING → LOT_EMPTY | LOT_PICK → CONFIRMING → SUCCESS → IDLE (auto)
//          (non-tracks_lots items skip LOT_* states entirely)
//   plus side states: MANUAL_FILL, PERMISSION_PROMPT, PERMISSION_DENIED, INSECURE, UNSUPPORTED
//
// Every transition goes through setState(next, patch?) which updates state and calls render().

(function () {
  'use strict';

  // =========================================================================
  // Module state (single source of truth)
  // =========================================================================

  /** @typedef {'PERMISSION_PROMPT'|'PERMISSION_DENIED'|'INSECURE'|'UNSUPPORTED'|
   *           'IDLE'|'ITEM_SCANNED'|'LOCATION_SCANNED'|'MANUAL_FILL'|
   *           'LOT_LOADING'|'LOT_EMPTY'|'LOT_PICK'|
   *           'CONFIRMING'|'SUCCESS'} ScanState */

  const state = {
    /** @type {ScanState} */
    name: 'PERMISSION_PROMPT',
    ctx: {
      /** @type {object|null}  resolved stock_items row */ item:        null,
      /** @type {object|null}  resolved locations row   */ location:    null,
      /** @type {string}                                */ pendingLoc:  '',   // if loc scanned before item
      /** @type {number}                                */ qty:         0,
      /** @type {'issue'|'adjustment_loss'}             */ action:      'issue',
      /** @type {string}                                */ note:        '',
      /** @type {string|null}                          */ clientRefId: null,  // persists across retries
      // Phase 2 — lot picker state
      /** @type {Array}                                 */ availableLots:  [],   // FEFO-sorted lots from API
      /** @type {object|null}                           */ selectedLot:    null, // chosen lot
      /** @type {boolean}                               */ fefoOverride:   false,// true when non-FEFO lot confirmed
    },
    /** Set true once camera has been successfully started at least once.  */
    cameraStartedEver: false,
    /** Currently scanning (camera live + AppScanner loop active).         */
    scanning: false,
    /** setTimeout token for the 800 ms auto-reset after SUCCESS.          */
    successTimer: null,
  };

  // =========================================================================
  // DOM cache (filled on DOMContentLoaded → boot)
  // =========================================================================

  const el = {};

  function cacheDom() {
    el.userName        = document.getElementById('user-name');
    el.btnLogout       = document.getElementById('btn-logout');

    el.chipItem        = document.getElementById('chip-item');
    el.chipLoc         = document.getElementById('chip-loc');

    el.stage           = document.getElementById('scan-stage');
    el.video           = document.getElementById('scan-video');
    el.hint            = document.getElementById('scan-hint');

    el.gatePrompt      = document.getElementById('gate-prompt');
    el.gateDenied      = document.getElementById('gate-denied');
    el.gateInsecure    = document.getElementById('gate-insecure');
    el.gateUnsupported = document.getElementById('gate-unsupported');
    el.success         = document.getElementById('overlay-success');
    el.successDetail   = document.getElementById('success-detail');

    el.btnGrant        = document.getElementById('btn-grant-camera');
    el.linkManualGate  = document.getElementById('link-manual-from-gate');
    el.btnManualDenied = document.getElementById('btn-manual-from-denied');
    el.btnManualInsec  = document.getElementById('btn-manual-from-insecure');
    el.btnManualUnsup  = document.getElementById('btn-manual-from-unsupported');

    el.linkManual      = document.getElementById('link-manual-toggle');
    el.manualPanel     = document.getElementById('manual-panel');
    el.mSku            = document.getElementById('m-sku');
    el.mLoc            = document.getElementById('m-loc');
    el.btnManualOk     = document.getElementById('btn-manual-confirm');
    el.btnManualCancel = document.getElementById('btn-manual-cancel');

    el.submitRow       = document.getElementById('submit-row');
    el.mType           = document.getElementById('m-type');
    el.mQty            = document.getElementById('m-qty');
    el.mNote           = document.getElementById('m-note');
    el.btnSubmit       = document.getElementById('btn-submit');
    el.btnReset        = document.getElementById('btn-reset');

    el.finderQ         = document.getElementById('finder-q');
    el.finderResults   = document.getElementById('finder-results');
  }

  // =========================================================================
  // Boot
  // =========================================================================

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    cacheDom();

    // 1. Auth — same pattern as staff.html / js/staff-home.js.
    const ok = await window.ensureLoggedIn();
    if (!ok) return;

    // RLS authoritatively blocks what staff can't do (sm_insert_staff). We don't
    // gate by role on the client — both Admin and Employee can use this page.
    el.userName.textContent = window.getUserName();
    el.btnLogout.addEventListener('click', () => window.handleLogout());

    try { await window.loadSettings?.(); } catch { /* non-fatal */ }

    // 2. Wire all event listeners.
    bindEvents();

    // 3. Pre-flight checks (HTTPS, BarcodeDetector / getUserMedia).
    //    Choose initial state accordingly.
    if (!window.isSecureContext) {
      setState('INSECURE');
      return;
    }
    if (!window.AppScanner || !window.AppScanner.isSupported()) {
      setState('UNSUPPORTED');
      return;
    }

    // First paint = permission gate. We DO NOT auto-call getUserMedia() on load:
    // iOS Safari only grants the camera when a user gesture is the trigger, and Chrome
    // Android shows a less-trustworthy prompt without a click. The big "อนุญาตให้ใช้กล้อง"
    // button IS that user gesture. (Design D-S1.)
    setState('PERMISSION_PROMPT');
  }

  // =========================================================================
  // Event binding
  // =========================================================================

  function bindEvents() {
    // --- Permission gate buttons -------------------------------------------
    el.btnGrant.addEventListener('click', onGrantCameraClick);

    // Manual-fallback links from each gate variant. All converge on the same
    // function so the manual flow works identically regardless of how it was reached.
    [el.linkManualGate, el.btnManualDenied, el.btnManualInsec, el.btnManualUnsup, el.linkManual]
      .forEach((node) => node && node.addEventListener('click', (ev) => {
        ev.preventDefault();
        openManualPanel();
      }));

    el.btnManualCancel.addEventListener('click', () => {
      closeManualPanel();
      // If camera ever started successfully, resume scanning. Otherwise go back to gate.
      if (state.cameraStartedEver) {
        startScanLoop().catch(handleCameraError);
      } else {
        setState('PERMISSION_PROMPT');
      }
    });
    el.btnManualOk.addEventListener('click', onManualConfirm);

    // --- Submit / Reset ----------------------------------------------------
    el.btnSubmit.addEventListener('click', onSubmitClick);
    el.btnReset.addEventListener('click', resetFlow);

    el.mType.addEventListener('change', () => { state.ctx.action = el.mType.value; });
    el.mQty.addEventListener('input',   () => { state.ctx.qty    = Math.max(0, parseInt(el.mQty.value || '0', 10)); });
    el.mNote.addEventListener('input',  () => { state.ctx.note   = el.mNote.value.trim(); });

    // --- Finder ------------------------------------------------------------
    el.finderQ.addEventListener('input', debounce(onFinderInput, 250));

    // --- Lifecycle ---------------------------------------------------------
    // Release the camera if the user leaves the tab — both for battery and so the
    // device's camera LED doesn't stay on. We resume scanning on return.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Best-effort stop. Don't change state — we want the same screen on resume.
        if (state.scanning) {
          window.AppScanner.stopScanning().catch(() => {});
          state.scanning = false;
        }
      } else if (
        state.cameraStartedEver &&
        ['IDLE','ITEM_SCANNED','LOCATION_SCANNED'].includes(state.name)
      ) {
        startScanLoop().catch(handleCameraError);
      }
    });
    window.addEventListener('pagehide', () => {
      if (state.scanning) {
        window.AppScanner.stopScanning().catch(() => {});
        state.scanning = false;
      }
    });
  }

  // =========================================================================
  // State machine
  // =========================================================================

  /**
   * Centralized state transition. Also clears any pending success-timer so we
   * don't accidentally auto-reset after the user manually navigated somewhere.
   */
  function setState(next, patch) {
    if (patch) Object.assign(state.ctx, patch);
    state.name = next;
    if (next !== 'SUCCESS' && state.successTimer) {
      clearTimeout(state.successTimer);
      state.successTimer = null;
    }
    render();
  }

  // =========================================================================
  // Render — pure function of `state` → DOM
  // =========================================================================

  function render() {
    // --- Overlays inside .scan-stage --------------------------------------
    el.gatePrompt.classList.toggle('d-none',      state.name !== 'PERMISSION_PROMPT');
    el.gateDenied.classList.toggle('d-none',      state.name !== 'PERMISSION_DENIED');
    el.gateInsecure.classList.toggle('d-none',    state.name !== 'INSECURE');
    el.gateUnsupported.classList.toggle('d-none', state.name !== 'UNSUPPORTED');
    el.success.classList.toggle('d-none',         state.name !== 'SUCCESS');

    // --- Hint (only visible while video is showing) ------------------------
    const isScanState = ['IDLE', 'ITEM_SCANNED', 'LOCATION_SCANNED'].includes(state.name);
    el.hint.classList.toggle('d-none', !isScanState);
    if (state.name === 'IDLE')              el.hint.textContent = 'ขั้นที่ 1: สแกนสินค้า';
    else if (state.name === 'ITEM_SCANNED') el.hint.textContent = 'ขั้นที่ 2: สแกน QR ของตู้/ชั้น';
    else if (state.name === 'LOCATION_SCANNED') el.hint.textContent = 'ขั้นที่ 3: เลือกประเภท + จำนวน';

    // --- Chips -------------------------------------------------------------
    if (state.ctx.item) {
      el.chipItem.textContent = `สินค้า: ${state.ctx.item.sku} ${truncate(state.ctx.item.name, 22)}`;
      el.chipItem.classList.add('done');
    } else {
      el.chipItem.textContent = 'สินค้า: —';
      el.chipItem.classList.remove('done');
    }
    if (state.ctx.location) {
      el.chipLoc.textContent = `สถานที่: ${state.ctx.location.code} ${truncate(state.ctx.location.name || '', 18)}`;
      el.chipLoc.classList.add('done');
    } else {
      el.chipLoc.textContent = 'สถานที่: —';
      el.chipLoc.classList.remove('done');
    }

    // --- Submit row visibility (NOT shown during lot-picker steps) --------
    const showSubmit = ['LOCATION_SCANNED', 'CONFIRMING'].includes(state.name);
    el.submitRow.classList.toggle('d-none', !showSubmit);

    // --- Submit button state ----------------------------------------------
    const confirming = state.name === 'CONFIRMING';
    el.btnSubmit.disabled = confirming;
    el.btnSubmit.innerHTML = confirming
      ? '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก…'
      : '<i class="bi bi-check2-circle me-1"></i><span>บันทึก</span>';

    // --- Manual panel visibility ------------------------------------------
    el.manualPanel.classList.toggle('d-none', state.name !== 'MANUAL_FILL');

    // -----------------------------------------------------------------------
    // Phase 2: Lot picker panels (LOT_LOADING, LOT_EMPTY, LOT_PICK)
    // -----------------------------------------------------------------------
    _renderLotPanel();
  }

  // =========================================================================
  // Phase 2 — Lot panel renderer
  // =========================================================================

  /**
   * Render or update the lot picker panel that overlays the scan stage
   * during LOT_LOADING, LOT_EMPTY, and LOT_PICK states.
   * The panel is a sibling of the scan stage — injected once, then toggled.
   */
  function _renderLotPanel() {
    const isLotState = ['LOT_LOADING', 'LOT_EMPTY', 'LOT_PICK'].includes(state.name);

    // Get or create the lot panel container
    let panel = document.getElementById('lot-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'lot-panel';
      panel.className = 'lot-panel-overlay';
      // Insert after the scan stage (or at end of body's scan container)
      const stage = el.stage;
      if (stage && stage.parentNode) {
        stage.parentNode.insertBefore(panel, stage.nextSibling);
      } else {
        document.body.appendChild(panel);
      }
    }

    panel.classList.toggle('d-none', !isLotState);
    if (!isLotState) return;

    if (state.name === 'LOT_LOADING') {
      panel.innerHTML = `
        <div class="text-center py-5" aria-live="polite">
          <span class="spinner-border spinner-border text-stock-accent mb-3"></span>
          <p class="fw-semibold">กำลังโหลดล็อตยา…</p>
          <p class="text-muted small">ขั้นที่ 2.5: เลือกล็อต (M-60)</p>
        </div>`;
      return;
    }

    if (state.name === 'LOT_EMPTY') {
      panel.innerHTML = `
        <div class="text-center py-5" aria-live="polite">
          <div style="font-size:3rem;" class="mb-3">📦</div>
          <p class="fw-semibold mb-1">ไม่มีล็อตยาที่พร้อมใช้งาน (M-63)</p>
          <p class="text-muted small mb-4">ยาทุกล็อตหมดหรือหมดอายุ ติดต่อผู้ดูแลระบบ (M-64)</p>
          <button type="button" class="btn btn-outline-secondary" id="lot-panel-reset"
                  style="min-height:44px;">
            เริ่มใหม่
          </button>
        </div>`;
      panel.querySelector('#lot-panel-reset').addEventListener('click', resetFlow);
      return;
    }

    if (state.name === 'LOT_PICK') {
      // Build lot picker panel
      const lots = state.ctx.availableLots || [];
      const selectedId = state.ctx.selectedLot ? state.ctx.selectedLot.id : (lots[0] ? lots[0].id : null);

      // Lot chip display
      const lotChipHtml = state.ctx.selectedLot
        ? (function () {
            const badge = window.AppLots ? window.AppLots.getLotBadge(state.ctx.selectedLot) : { badgeClass: 'bg-secondary text-white', label: '' };
            const fefoNote = state.ctx.fefoOverride
              ? ' <span class="badge bg-warning text-dark ms-1 small">FEFO override</span>'
              : '';
            return `<span class="badge ${badge.badgeClass}">${escapeHtml(state.ctx.selectedLot.lot_number)}</span>${fefoNote}`;
          }())
        : '—';

      panel.innerHTML = `
        <div class="pb-4">
          <h6 class="fw-semibold mb-3">
            ขั้นที่ 2.5: เลือกล็อตยา (M-55)
          </h6>
          <div class="mb-2 small text-muted d-flex gap-2 align-items-center flex-wrap">
            <span>ล็อตที่เลือก:</span>
            <span id="lot-pick-chip">${lotChipHtml}</span>
          </div>
          <div id="lot-picker-container"></div>
          <div class="d-grid mt-3">
            <button type="button" class="btn btn-stock-primary" id="lot-pick-next"
                    style="min-height:44px;"
                    ${!state.ctx.selectedLot ? 'disabled' : ''}>
              ขั้นต่อไป: ระบุจำนวน → (M-58)
            </button>
          </div>
          <div class="mt-2 text-center">
            <button type="button" class="btn btn-link text-muted small" id="lot-pick-cancel">
              ยกเลิก — เริ่มใหม่
            </button>
          </div>
        </div>`;

      // Render lot picker widget from shared/lots.js (Q-D4)
      const pickerContainer = panel.querySelector('#lot-picker-container');
      if (window.AppLots && pickerContainer) {
        const pickerEl = window.AppLots.renderLotPicker(lots, selectedId, (lot) => {
          _handleLotSelect(lot);
        });
        pickerContainer.appendChild(pickerEl);
      }

      // Wire "next" button
      panel.querySelector('#lot-pick-next').addEventListener('click', () => {
        if (!state.ctx.selectedLot) return;
        _proceedFromLotPick();
      });

      // Wire cancel button
      panel.querySelector('#lot-pick-cancel').addEventListener('click', resetFlow);
    }
  }

  /**
   * Handle a lot being selected in the lot picker.
   * Q-D2: if the selected lot is NOT the FEFO default (lots[0]), show confirm modal.
   */
  function _handleLotSelect(lot) {
    const lots = state.ctx.availableLots || [];
    const isFEFO = lots.length > 0 && lots[0].id === lot.id;

    if (isFEFO) {
      // FEFO default — select immediately, no confirmation
      setState('LOT_PICK', { selectedLot: lot, fefoOverride: false });
      return;
    }

    // Non-FEFO selection — Q-D2 confirm modal
    // Exact copy: "ล็อต {lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?"
    _showFEFOConfirmModal(lot);
  }

  /**
   * Show FEFO override confirmation modal (Q-D2).
   * Exact copy per decisions-locked Q-D2.
   */
  function _showFEFOConfirmModal(lot) {
    const old = document.getElementById('fefo-confirm-modal');
    if (old) old.remove();

    const wrap = document.createElement('div');
    // Exact copy required by Q-D2:
    const copyText = `ล็อต ${lot.lot_number} ไม่ใช่ล็อตที่ควรใช้ก่อน — ยืนยันหรือไม่?`;

    wrap.innerHTML = `
      <div class="modal fade" id="fefo-confirm-modal" tabindex="-1" aria-labelledby="fefo-modal-title">
        <div class="modal-dialog modal-dialog-centered modal-fullscreen-sm-down">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title text-warning" id="fefo-modal-title">
                <i class="bi bi-exclamation-triangle"></i> FEFO: ลำดับการใช้
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body">
              <p class="mb-0">${escapeHtml(copyText)}</p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" id="fefo-cancel-btn"
                      style="min-height:44px;">ยกเลิก</button>
              <button type="button" class="btn btn-warning" id="fefo-confirm-btn"
                      style="min-height:44px;">ยืนยัน</button>
            </div>
          </div>
        </div>
      </div>`;
    const modalEl = wrap.firstChild;
    document.body.appendChild(modalEl);
    const modal = new bootstrap.Modal(modalEl);

    modalEl.querySelector('#fefo-confirm-btn').addEventListener('click', () => {
      modal.hide();
      // User confirmed non-FEFO lot — set fefoOverride=true
      setState('LOT_PICK', { selectedLot: lot, fefoOverride: true });
    });

    modalEl.querySelector('#fefo-cancel-btn').addEventListener('click', () => {
      modal.hide();
      // Revert to FEFO default
      const fefoLot = state.ctx.availableLots[0] || null;
      setState('LOT_PICK', { selectedLot: fefoLot, fefoOverride: false });
    });

    modalEl.addEventListener('hidden.bs.modal', () => {
      try { modalEl.remove(); } catch { /* ignore */ }
    });

    modal.show();
  }

  /**
   * Transition from LOT_PICK to LOCATION_SCANNED (quantity entry step).
   * selectedLot is already set in ctx.
   */
  function _proceedFromLotPick() {
    // Hide the lot panel and show the submit row by going to LOCATION_SCANNED
    setState('LOCATION_SCANNED');
    setTimeout(() => { try { el.mQty.focus(); } catch {} }, 50);
  }

  // =========================================================================
  // Phase 2 — Load lots after location is scanned (for tracks_lots items)
  // =========================================================================

  /**
   * Check if the current item tracks lots and the action requires a lot.
   * If so, transition to LOT_LOADING and fetch lots.
   * Returns true if lot loading was initiated (caller should NOT continue to QTY step).
   */
  async function _maybeLaunchLotPicker() {
    const ctx = state.ctx;
    if (!ctx.item) return false;

    // Only lot-picking for issue / adjustment_loss
    const needsLot = ctx.item.tracks_lots &&
                     ['issue', 'adjustment_loss'].includes(ctx.action || 'issue');
    if (!needsLot) return false;

    // Ensure shared/lots.js is available
    if (!window.AppLots) {
      // Try to load it (may already be in DOM from a previous tab init, or loaded here)
      await _ensureLotsScript();
      if (!window.AppLots) {
        window.showToast('error', 'ระบบล็อตยังไม่พร้อม — รีเฟรชหน้าใหม่');
        return false;
      }
    }

    setState('LOT_LOADING', { availableLots: [], selectedLot: null, fefoOverride: false });

    const { data, error } = await window.AppLots.fetchAvailableLots(ctx.item.id);
    if (error) {
      // M-61: load error
      window.showToast('error', 'โหลดล็อตยาไม่สำเร็จ (M-61) — ลองใหม่อีกครั้ง (M-62)');
      setState('LOCATION_SCANNED');
      return true;
    }

    const lots = window.AppLots.sortFEFO(data || []);

    if (lots.length === 0) {
      setState('LOT_EMPTY');
      return true;
    }

    // Pre-select FEFO default (lots[0])
    setState('LOT_PICK', {
      availableLots: lots,
      selectedLot:   lots[0],
      fefoOverride:  false,
    });
    return true;
  }

  /**
   * Dynamically load shared/lots.js if not yet available.
   */
  async function _ensureLotsScript() {
    if (window.AppLots) return;
    return new Promise((resolve) => {
      if (document.querySelector('script[src*="shared/lots.js"]')) { resolve(); return; }
      const s = document.createElement('script');
      s.src = './shared/lots.js';
      s.onload = resolve;
      s.onerror = resolve; // fail gracefully
      document.head.appendChild(s);
    });
  }

  // =========================================================================
  // Utility — escapeHtml (mirrors shared/ui.js)
  // =========================================================================
  function escapeHtml(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // =========================================================================
  // Camera permission flow
  // =========================================================================

  async function onGrantCameraClick() {
    // Disable button for the brief async window so users don't double-tap.
    el.btnGrant.disabled = true;
    try {
      await startScanLoop();          // throws on permission denial
      setState('IDLE', { item: null, location: null });
    } catch (e) {
      handleCameraError(e);
    } finally {
      el.btnGrant.disabled = false;
    }
  }

  async function startScanLoop() {
    if (state.scanning) return;
    state.scanning = true;
    await window.AppScanner.startScanning({
      videoElement: el.video,
      onScan:       onScanResult,
      onError:      (msg) => {
        // Errors from inside the loop (camera died mid-stream) — bubble up to gate.
        state.scanning = false;
        window.showToast('error', msg || 'กล้องมีปัญหา');
        setState('PERMISSION_PROMPT');
      },
    });
    state.cameraStartedEver = true;
  }

  function handleCameraError(e) {
    state.scanning = false;
    const name = e?.name || '';
    const msg  = e?.message || String(e || '');
    if (name === 'NotAllowedError' || /Permission|denied/i.test(msg)) {
      setState('PERMISSION_DENIED');
    } else if (/SecureContext|insecure/i.test(msg)) {
      setState('INSECURE');
    } else if (name === 'NotFoundError' || /no camera/i.test(msg)) {
      window.showToast('error', 'ไม่พบกล้องบนอุปกรณ์นี้');
      setState('UNSUPPORTED');
    } else {
      window.showToast('error', msg || 'เปิดกล้องไม่สำเร็จ');
      setState('PERMISSION_PROMPT');
    }
  }

  // =========================================================================
  // Scan event handling
  // =========================================================================

  /**
   * Single entry-point for every successful camera decode. Routes to the
   * appropriate step handler based on `state.name`.
   * @param {string} text
   */
  async function onScanResult(text) {
    if (!text) return;
    // Ignore scans during transitional / non-scan states so we don't double-fire.
    // Phase 2: also ignore during LOT_* states (lot picker uses tap, not scan).
    if (!['IDLE','ITEM_SCANNED'].includes(state.name)) return;

    const parsed = window.AppScanner.parseScanResult(text);
    if (parsed.type === 'unknown') {
      window.showToast('warning', 'QR/Barcode ไม่ถูกต้อง');
      return;
    }

    if (state.name === 'IDLE') {
      // Step 1: either an item barcode OR a location QR (if scanned out of order).
      if (parsed.type === 'item-barcode') {
        await handleItemScan(parsed.value);
      } else if (parsed.type === 'location-qr') {
        // User scanned location first — stash it so we apply it once item arrives.
        state.ctx.pendingLoc = parsed.value;
        window.showToast('info', 'รับ QR สถานที่แล้ว — กรุณาสแกนสินค้าต่อ');
      }
    } else if (state.name === 'ITEM_SCANNED') {
      // Step 2: expect a location QR. If they re-scan an item we just overwrite.
      if (parsed.type === 'location-qr' || parsed.type === 'item-barcode') {
        // Try as location first (most likely intent at this step), fall through if not found.
        await handleLocationScan(parsed.value);
      }
    }
  }

  async function handleItemScan(value) {
    const { data, error } = await window.AppInventory.searchByBarcode(value);
    if (error) {
      window.showToast('error', error.friendly || error.message || 'ค้นหาสินค้าไม่สำเร็จ');
      return;
    }
    if (!data) {
      window.showToast('warning', 'ไม่พบสินค้านี้');
      return;
    }
    // Optimistically apply any stashed location scan (out-of-order user).
    if (state.ctx.pendingLoc) {
      const loc = await window.AppInventory.findLocationByCode(state.ctx.pendingLoc);
      if (loc.data) {
        setState('LOCATION_SCANNED', { item: data, location: loc.data, pendingLoc: '' });
        return;
      }
      state.ctx.pendingLoc = '';
    }
    setState('ITEM_SCANNED', { item: data });
  }

  async function handleLocationScan(value) {
    const { data, error } = await window.AppInventory.findLocationByCode(value);
    if (error) {
      window.showToast('error', error.friendly || error.message || 'ค้นหาสถานที่ไม่สำเร็จ');
      return;
    }
    if (!data) {
      window.showToast('warning', 'ไม่พบสถานที่นี้');
      return;
    }
    setState('LOCATION_SCANNED', { location: data });

    // Phase 2: for tracks_lots items + issue/adjustment_loss, launch lot picker
    const lotLaunched = await _maybeLaunchLotPicker();
    if (!lotLaunched) {
      // Non-tracks_lots item: proceed directly to qty (Phase 1 behavior unchanged)
      setTimeout(() => { try { el.mQty.focus(); } catch {} }, 50);
    }
  }

  // =========================================================================
  // Manual fallback
  // =========================================================================

  function openManualPanel() {
    // Stop camera if it's running — manual flow doesn't need it.
    if (state.scanning) {
      window.AppScanner.stopScanning().catch(() => {});
      state.scanning = false;
    }
    setState('MANUAL_FILL');
    setTimeout(() => { try { el.mSku.focus(); } catch {} }, 50);
  }

  function closeManualPanel() {
    el.mSku.value = '';
    el.mLoc.value = '';
  }

  async function onManualConfirm() {
    const sku = el.mSku.value.trim();
    const loc = el.mLoc.value.trim();
    if (!sku) { window.showToast('warning', 'กรุณากรอก SKU หรือ Barcode'); return; }
    if (!loc) { window.showToast('warning', 'กรุณากรอกรหัสตู้/ชั้น'); return; }

    el.btnManualOk.disabled = true;
    try {
      const [itemRes, locRes] = await Promise.all([
        window.AppInventory.searchByBarcode(sku),
        window.AppInventory.findLocationByCode(loc),
      ]);
      if (itemRes.error || !itemRes.data) {
        window.showToast('warning', 'ไม่พบสินค้านี้');
        return;
      }
      if (locRes.error || !locRes.data) {
        window.showToast('warning', 'ไม่พบสถานที่นี้');
        return;
      }
      closeManualPanel();
      setState('LOCATION_SCANNED', { item: itemRes.data, location: locRes.data });

      // Phase 2: check if lot picker is needed (same as handleLocationScan path)
      const lotLaunched = await _maybeLaunchLotPicker();
      if (!lotLaunched) {
        setTimeout(() => { try { el.mQty.focus(); } catch {} }, 50);
      }
    } finally {
      el.btnManualOk.disabled = false;
    }
  }

  // =========================================================================
  // Submit (post movement)
  // =========================================================================

  async function onSubmitClick() {
    if (state.name === 'CONFIRMING') return;     // double-tap guard
    const ctx = state.ctx;

    // Pull latest qty from input in case `change` event didn't fire (e.g. iOS keyboard).
    ctx.qty    = Math.max(0, parseInt(el.mQty.value || '0', 10));
    ctx.action = el.mType.value === 'adjustment_loss' ? 'adjustment_loss' : 'issue';
    ctx.note   = el.mNote.value.trim();

    if (!ctx.item || !ctx.location) {
      window.showToast('warning', 'ยังไม่มีข้อมูลครบ — สแกนสินค้าและสถานที่ก่อน');
      return;
    }
    if (!Number.isFinite(ctx.qty) || ctx.qty <= 0) {
      window.showToast('warning', 'กรุณาระบุจำนวนให้ถูกต้อง');
      el.mQty.focus();
      return;
    }

    // Idempotency: reuse the same client_ref_id across retries of the SAME logical
    // submission. We only mint a new UUID when starting a brand-new submission —
    // i.e. when there isn't one stashed yet. The DB UNIQUE constraint then turns
    // a network retry into a 23505 → AppInventory returns `replay:true` → we
    // treat it as success.
    if (!ctx.clientRefId) {
      ctx.clientRefId = window.AppInventory._uuid();
    }

    setState('CONFIRMING');

    try {
      let data, error;

      // Phase 2: if a lot is selected, insert movement with lot_id + fefo_override directly.
      // (AppInventory.issue / adjustmentLoss don't carry lot_id yet.)
      if (ctx.selectedLot) {
        const sb = getSupabaseClient();
        const POSITIVE = new Set(['receive', 'adjustment_gain']);
        const qty_delta = POSITIVE.has(ctx.action) ? ctx.qty : -ctx.qty;
        const rawRes = await sb.from('stock_movements').insert({
          client_ref_id:  ctx.clientRefId,
          item_id:        ctx.item.id,
          location_id:    ctx.location.id,
          movement_type:  ctx.action,
          qty_delta:      qty_delta,
          lot_id:         ctx.selectedLot.id,
          fefo_override:  ctx.fefoOverride,
          note:           ctx.note || null,
        }).select().single();
        data  = rawRes.data ? { movement: rawRes.data, replay: false, client_ref_id: ctx.clientRefId } : null;
        error = rawRes.error;
      } else {
        // Phase 1 path: no lot
        const fn = ctx.action === 'adjustment_loss'
          ? window.AppInventory.adjustmentLoss
          : window.AppInventory.issue;
        const res = await fn(
          ctx.item.id, ctx.location.id, ctx.qty, ctx.note || null, ctx.clientRefId
        );
        data  = res.data;
        error = res.error;
      }

      if (error) {
        // Phase 2: check for trigger error (Q-Phase2-4 — exact server string)
        const lotTriggerMsg = window.AppLots
          ? window.AppLots.mapTriggerErrorToToast(error)
          : null;

        if (lotTriggerMsg) {
          // M-65: lot expired/recalled since lot picker loaded — go back to LOT_PICK (re-fetch)
          window.showToast('error', lotTriggerMsg);
          setState('LOCATION_SCANNED');
          // Re-launch lot picker so user sees fresh (updated) list
          await _maybeLaunchLotPicker();
          return;
        }

        // Idempotent replay (23505 on client_ref_id)
        if (error.code === '23505' && /client_ref_id/.test(error.message || '')) {
          console.warn('[staff-scan] idempotent replay accepted; client_ref_id =', ctx.clientRefId);
          onSubmitSuccess();
          return;
        }

        const friendly =
          error.friendly
          || (error.code === '42501' ? 'ไม่มีสิทธิ์ดำเนินการนี้ — ติดต่อ Admin' : null)
          || (error.code === 'BAD_QTY' ? 'จำนวนไม่ถูกต้อง' : null)
          || error.message
          || 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง';

        const isShortStock = /ของไม่พอ|negative|insufficient/i.test(friendly + ' ' + (error.message || ''));
        window.showToast('error', isShortStock ? 'ของไม่พอที่จุดนี้' : friendly);

        // Stay on the same step with qty preserved so user can adjust and retry.
        setState('LOCATION_SCANNED');
        return;
      }

      // Replay-as-success: log it but don't reveal the duplicate to the user.
      if (data && data.replay) {
        console.warn('[staff-scan] idempotent replay accepted; client_ref_id =', data.client_ref_id);
      }

      onSubmitSuccess();
    } catch (e) {
      window.showToast('error', 'เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง');
      console.error('[staff-scan] submit threw', e);
      setState('LOCATION_SCANNED');
    }
  }

  function onSubmitSuccess() {
    const ctx = state.ctx;
    const verb = ctx.action === 'adjustment_loss' ? 'รายงานชำรุด' : 'เบิก';
    const itemLabel = ctx.item ? truncate(ctx.item.name, 24) : '';
    const locLabel  = ctx.location ? ctx.location.code : '';
    el.successDetail.textContent = `${verb} ${ctx.qty} ${ctx.item?.unit || 'ชิ้น'} — ${itemLabel}  จาก ${locLabel}`;

    setState('SUCCESS');

    // 800 ms auto-reset (design D-S2 — designer pushed back on spec's 3000 ms).
    state.successTimer = setTimeout(() => {
      state.successTimer = null;
      resetFlow();
    }, 800);
  }

  // =========================================================================
  // Reset / restart
  // =========================================================================

  function resetFlow() {
    // Wipe context entirely — including clientRefId so the NEXT submission gets
    // a fresh idempotency key.
    state.ctx = {
      item: null, location: null, pendingLoc: '',
      qty: 0, action: 'issue', note: '', clientRefId: null,
      // Phase 2 lot fields
      availableLots: [], selectedLot: null, fefoOverride: false,
    };
    el.mQty.value  = '';
    el.mNote.value = '';
    el.mType.value = 'issue';

    if (state.cameraStartedEver) {
      // Make sure camera is running for the new scan. Calling start when already
      // running is a no-op inside AppScanner.
      if (!state.scanning) {
        startScanLoop().catch(handleCameraError).then(() => setState('IDLE'));
      } else {
        setState('IDLE');
      }
    } else {
      setState('PERMISSION_PROMPT');
    }
  }

  // =========================================================================
  // Item finder (below-the-fold; per design §3.2 + §3.6 microcopy)
  // =========================================================================

  async function onFinderInput() {
    const q = el.finderQ.value.trim();
    if (!q) {
      el.finderResults.innerHTML = '<span class="text-muted">— พิมพ์เพื่อค้นหา —</span>';
      return;
    }
    el.finderResults.innerHTML = '<span class="text-muted">กำลังค้นหา…</span>';

    const { data, error } = await window.AppInventory.listItems({ search: q, limit: 10 });
    if (error) {
      el.finderResults.innerHTML = `<span class="text-danger">${escapeHtml(error.message || 'ค้นหาไม่สำเร็จ')}</span>`;
      return;
    }
    if (!data || !data.length) {
      el.finderResults.innerHTML = '<span class="text-muted">ไม่พบ — ลองสแกนได้</span>';
      return;
    }

    // For each hit, fetch per-location breakdown. Cap at 5 to avoid flooding.
    const top = data.slice(0, 5);
    const detail = await Promise.all(top.map((it) => window.AppInventory.getItem(it.id)));

    el.finderResults.innerHTML = top.map((it, i) => {
      const d = detail[i]?.data;
      const total = d?.total_qty ?? it.total_qty ?? 0;
      const locs = (d?.locations || []).slice(0, 4).map((row) => {
        const code = row.locations?.code || '?';
        const name = row.locations?.name ? ` ${escapeHtml(row.locations.name)}` : '';
        return `<div class="d-flex justify-content-between small"><span><code>${escapeHtml(code)}</code>${name}</span><span class="text-stock-accent fw-semibold">${row.qty}</span></div>`;
      }).join('');
      return `
        <div class="finder-result-row">
          <div class="d-flex justify-content-between">
            <strong>${escapeHtml(it.name)}</strong>
            <span class="text-muted small">${escapeHtml(it.sku)}</span>
          </div>
          <div class="small text-muted">คงเหลือรวม ${total} ${escapeHtml(it.unit || 'ชิ้น')}</div>
          ${locs || '<div class="small text-muted fst-italic">ไม่มีในคลัง</div>'}
        </div>`;
    }).join('');
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function escapeHtml(s) {
    // Use the global helper if present (defined in shared/ui.js), else inline.
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
