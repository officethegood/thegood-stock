// js/staff-scan.js
// Phase 1 + Phase 2 + Phase 6 — Staff Scan page controller.
//
// Design:  docs/superpowers/designs/2026-05-18-phase1-ui-design.md §3 (Area 2)
//          docs/superpowers/designs/2026-05-18-phase2-ui-design.md  §3.4, §5.2
//          docs/superpowers/designs/2026-05-19-phase6-linens-ui-design.md §3.5–§3.8
// Spec:    docs/superpowers/specs/2026-05-18-phase1-inventory-design.md §7.3
//          docs/superpowers/specs/2026-05-19-phase2-decisions-locked.md Q-D1, Q-D2, Q-D4
//          docs/superpowers/specs/2026-05-19-phase6-linens-laundry-design.md §7.2
// Plan:    docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md Phase E
//          docs/superpowers/plans/2026-05-19-phase2-medication-plan.md Task B4
//
// Phase 6 changes (additive only — all existing Phase 1/2/3/4/5 code unchanged):
//   — When a cabinet QR is scanned (type='cabinet') and it has LINEN items,
//     shows the linen cabinet view (overlay, same pattern as Phase 4 bag checklist).
//   — Linen cabinet view: ส่งซัก / รับคืน / นับใหม่ buttons per item row.
//   — Each flow uses PhotoCaptureModal (shared/photo-capture.js, Phase 3) — reused as-is.
//   — ส่งซัก/รับคืน: AppLinens.sendToLaundry / receiveFromLaundry (shared/linens.js)
//   — นับใหม่: AppLinens.submitLinenCount (shared/linens.js)
//   — photo required=true for ส่งซัก/รับคืน; required=false for นับใหม่ (Q6-B)
//   — RBAC: รับคืน button visible for all roles (Q6-F Option B — Staff allowed)
//   — If cabinet has no LINEN items, fall through to standard Phase 1 scan flow
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
    const modalEl = wrap.firstElementChild;
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
  // Per-code cooldown to stop the camera re-decoding the SAME code every frame
  // from flooding the screen. A code that fails lookup leaves state unchanged,
  // so without this a single unrecognised QR spams dozens of "ไม่พบสินค้านี้"
  // toasts (and a just-scanned item barcode re-fires as a bogus location scan).
  // A DIFFERENT code is always processed immediately.
  let _lastScanText = null;
  let _lastScanAt   = 0;
  const SCAN_COOLDOWN_MS = 2500;

  async function onScanResult(text) {
    if (!text) return;
    // Ignore scans during transitional / non-scan states so we don't double-fire.
    // Phase 2: also ignore during LOT_* states (lot picker uses tap, not scan).
    if (!['IDLE','ITEM_SCANNED'].includes(state.name)) return;

    // Dedupe rapid repeats of the same code (see note above).
    const _now = Date.now();
    if (text === _lastScanText && (_now - _lastScanAt) < SCAN_COOLDOWN_MS) return;
    _lastScanText = text;
    _lastScanAt   = _now;

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
    // Phase 0.7: Show transfer option panel after item is scanned
    _showTransferOption(data);
  }

  /**
   * Phase 0.7 — After an item is scanned, show a small panel offering "ย้าย" as an
   * alternative to the standard "เบิก" flow.  The panel is injected below the scan stage
   * and removed when the user chooses an action or resets.
   */
  function _showTransferOption(item) {
    const old = document.getElementById('scan-transfer-option');
    if (old) old.remove();
    if (!item) return;

    // Only show if Transfer module is loaded
    if (!window.Transfer || typeof window.Transfer.openModal !== 'function') return;

    const panel = document.createElement('div');
    panel.id = 'scan-transfer-option';
    panel.className = 'mt-2 p-2 bg-white rounded shadow-sm small';
    panel.style.borderLeft = '4px solid var(--stock-accent, #0d9488)';
    panel.innerHTML = `
      <div class="fw-semibold mb-1">
        <i class="bi bi-arrows-move me-1"></i>
        ต้องการย้ายสินค้า <em>${escapeHtml(item.name)}</em> ไปตำแหน่งอื่นหรือไม่?
      </div>
      <div class="d-flex gap-2">
        <button type="button" class="btn btn-sm btn-outline-primary flex-fill"
                id="scan-transfer-go" style="min-height:40px;">ย้าย (Transfer)</button>
        <button type="button" class="btn btn-sm btn-outline-secondary flex-fill"
                id="scan-transfer-skip" style="min-height:40px;">ข้าม — เบิกปกติ</button>
      </div>`;

    const stage = document.getElementById('scan-stage');
    if (stage && stage.parentNode) {
      stage.parentNode.insertBefore(panel, stage.nextSibling);
    }

    panel.querySelector('#scan-transfer-go').addEventListener('click', () => {
      panel.remove();
      // Stop scanner while Transfer modal is open
      if (state.scanning) {
        window.AppScanner.stopScanning().catch(() => {});
        state.scanning = false;
      }
      window.Transfer.openModal({ itemId: item.id });
      // Listen once for transfer done to reset scan flow
      window.addEventListener('transfer:done', () => resetFlow(), { once: true });
    });

    panel.querySelector('#scan-transfer-skip').addEventListener('click', () => {
      panel.remove();
    });
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

    // ── Phase 4: Bag QR routing ─────────────────────────────────────────────
    // If the scanned location is type='bag', switch to read-only bag checklist view.
    // Spec: docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §7.2
    // UX:  docs/superpowers/designs/2026-05-19-phase4-als-bags-ui-design.md §8
    if (data.type === 'bag') {
      // Stop scanner while showing the checklist view.
      if (state.scanning) {
        window.AppScanner.stopScanning().catch(() => {});
        state.scanning = false;
      }
      _showBagChecklistView(data);
      return;
    }
    // ── End Phase 4 bag routing ─────────────────────────────────────────────

    // ── Phase 6: Cabinet LINEN routing ──────────────────────────────────────
    // If the scanned location is type='storage' (or legacy 'cabinet'), check for LINEN items.
    // If found, show linen cabinet view. If no LINEN items, fall through to standard scan.
    if (['storage', 'cabinet'].includes(data.type)) {
      if (state.scanning) {
        window.AppScanner.stopScanning().catch(() => {});
        state.scanning = false;
      }
      const hasLinen = await _checkCabinetHasLinens(data.id);
      if (hasLinen) {
        _showLinenCabinetView(data);
        return;
      }
      // No LINEN items — fall through to standard scan flow
    }
    // ── End Phase 6 cabinet routing ─────────────────────────────────────────

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

      // Phase 4: if location is type='bag', route to bag checklist (read-only for Staff)
      if (locRes.data.type === 'bag') {
        _showBagChecklistView(locRes.data);
        return;
      }

      // Phase 6: if location is type='storage' (or legacy 'cabinet'), check for LINEN items
      if (['storage', 'cabinet'].includes(locRes.data.type)) {
        const hasLinen = await _checkCabinetHasLinens(locRes.data.id);
        if (hasLinen) {
          _showLinenCabinetView(locRes.data);
          return;
        }
      }

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
    // Clear the scan dedupe so a deliberate "สแกนใหม่" can re-read the same
    // code immediately (the cooldown only guards against per-frame floods).
    _lastScanText = null;
    _lastScanAt   = 0;

    // Phase 0.7: Remove transfer option panel if present
    const xferPanel = document.getElementById('scan-transfer-option');
    if (xferPanel) try { xferPanel.remove(); } catch { /* ignore */ }

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

  // ==========================================================================
  // Phase 4 — Bag checklist view (S-4.5)
  //
  // Spec:  docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md §7.2
  // UX:    docs/superpowers/designs/2026-05-19-phase4-als-bags-ui-design.md §8
  //
  // Read-only for Staff (A-2 in spec §7.2): no restock button, no qty inputs.
  // Triggered when scanned/typed location has type='bag'.
  //
  // Implementation note:
  //   This function injects a full-screen overlay panel over the scan UI.
  //   "สแกนใหม่" button dismisses it and resumes scanning.
  // ==========================================================================

  async function _showBagChecklistView(location) {
    // Inject or reuse bag checklist overlay
    let overlay = document.getElementById('bag-checklist-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'bag-checklist-overlay';
      overlay.className = 'container-fluid py-3';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;z-index:1050;overflow-y:auto;';
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';

    // Loading state
    overlay.innerHTML = `
      <div class="text-center py-5">
        <span class="spinner-border text-stock-accent mb-3"></span>
        <p>กำลังโหลดข้อมูลกระเป๋า…</p>
      </div>`;

    // Load bag status
    const bagStatus = window.AppBags ? await window.AppBags.getBagStatusByCode(location.code) : null;
    const bag       = bagStatus?.data;

    if (!bag) {
      overlay.innerHTML = `
        <div class="alert alert-warning m-3">ไม่พบข้อมูลกระเป๋า ${escapeHtml(location.code)}</div>
        <div class="px-3">
          <button class="btn btn-outline-secondary w-100" id="bag-cl-back-btn">
            <i class="bi bi-arrow-left me-1"></i> สแกนใหม่
          </button>
        </div>`;
      overlay.querySelector('#bag-cl-back-btn').addEventListener('click', _dismissBagChecklist);
      return;
    }

    const alertBadge = window.AppBags?.getAlertBadge(bag.alert_level) ||
                       { cssClass: 'bg-secondary text-white', label: bag.alert_level };
    const pct        = bag.completion_pct;
    const barCls     = pct === null ? 'bg-secondary' : pct === 100 ? 'bg-success' : pct >= 70 ? 'bg-warning' : 'bg-danger';

    overlay.innerHTML = `
      <style>.badge-stock-expiring{background-color:#fd7e14;color:#fff;}</style>

      <div class="d-flex align-items-center mb-3">
        <i class="bi bi-bag-heart me-2 fs-4 text-stock-accent"></i>
        <div>
          <span class="fw-bold">${escapeHtml(bag.bag_code)}</span>
          <span class="badge ${alertBadge.cssClass} ms-2">${alertBadge.label}</span>
        </div>
      </div>
      <p class="text-muted small mb-2">${escapeHtml(bag.bag_name || '')}</p>

      ${pct !== null ? `
      <div class="mb-3">
        <div class="progress" style="height:8px;" role="progressbar"
             aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
             aria-label="ความสมบูรณ์ ${pct}%">
          <div class="progress-bar ${barCls}" style="width:${pct}%"></div>
        </div>
        <small class="text-muted">${pct}% สมบูรณ์</small>
      </div>` : ''}

      ${!bag.bag_template_id ? `
        <div class="alert alert-warning small">กระเป๋านี้ยังไม่มีเทมเพลต — ไม่สามารถตรวจสอบได้</div>` : ''}

      ${['low_stock','expiring','expired'].includes(bag.alert_level) ? `
        <div class="alert alert-warning small">
          <i class="bi bi-info-circle me-1"></i>กระเป๋านี้ยังไม่สมบูรณ์ — แจ้ง Admin เพื่อเติมของ
        </div>` : ''}

      ${bag.alert_level === 'expired' ? `
        <div class="alert alert-danger small">
          <i class="bi bi-exclamation-triangle-fill me-1"></i>มียาหมดอายุในกระเป๋านี้ — แจ้ง Admin ทันที
        </div>` : ''}

      ${bag.alert_level === 'complete' ? `
        <div class="alert alert-success small">
          <i class="bi bi-check-circle-fill me-1"></i>กระเป๋านี้สมบูรณ์พร้อมใช้งาน
        </div>` : ''}

      <h6>ตรวจสอบของในกระเป๋า</h6>
      <div id="bag-cl-composition">
        ${bag.bag_template_id
          ? '<div class="text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>กำลังโหลดรายการ…</div>'
          : '<p class="text-muted small">ไม่มีเทมเพลต</p>'}
      </div>

      <!-- กระเป๋าขึ้นรถ / คืนกระเป๋า (rendered async once the parent is known) -->
      <div id="bag-cl-deploy-wrap" class="mt-3"></div>

      <div class="mt-3">
        <button class="btn btn-outline-secondary w-100" id="bag-cl-scan-btn" style="min-height:52px;">
          <i class="bi bi-arrow-left me-1"></i> สแกนใหม่
        </button>
      </div>
      <!-- NOTE: No restock button for Staff (read-only per spec §7.2 A-2) -->`;

    overlay.querySelector('#bag-cl-scan-btn').addEventListener('click', _dismissBagChecklist);

    // กระเป๋าขึ้นรถ / คืนกระเป๋า — context-aware button (no due date by design)
    _renderBagDeploySection(location, bag).catch(() => { /* non-fatal */ });

    // Load composition async
    if (bag.bag_template_id) {
      const { data: comp, error: compErr } = await window.AppBags.getBagComposition(
        bag.location_id, bag.bag_template_id
      );
      const compEl = document.getElementById('bag-cl-composition');
      if (!compEl) return;

      if (compErr || !comp || comp.length === 0) {
        compEl.innerHTML = `<p class="text-muted small">ไม่พบรายการในเทมเพลต</p>`;
        return;
      }

      const getLotBadge = window.AppLots?.getLotBadge || (() => ({ cls: '', label: '' }));
      const rowsHtml = comp.map((r) => {
        let resultHtml;
        if (r.actual_qty >= r.target_qty) {
          resultHtml = `<span class="text-success small"><i class="bi bi-check-circle-fill"></i> ครบ</span>`;
        } else if (r.mandatory) {
          resultHtml = `<span class="text-danger small fw-bold"><i class="bi bi-x-circle-fill"></i> ขาด ${r.target_qty - r.actual_qty}</span>`;
        } else {
          resultHtml = `<span class="text-secondary small"><i class="bi bi-dash"></i> ไม่บังคับ</span>`;
        }
        return `
          <tr class="${r.mandatory && r.deficit > 0 ? 'table-danger' : ''}">
            <td><small>${r.mandatory ? '★' : '○'} ${escapeHtml(r.name)}</small></td>
            <td class="text-center"><small>${r.actual_qty}/${r.target_qty}</small></td>
            <td>${resultHtml}</td>
          </tr>`;
      }).join('');

      compEl.innerHTML = `
        <div class="table-responsive">
          <table class="table table-sm table-bordered align-middle">
            <thead class="table-light">
              <tr><th>สินค้า</th><th class="text-center">ปัจจุบัน/เป้า</th><th>ผล</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`;
    }
  }

  function _dismissBagChecklist() {
    const overlay = document.getElementById('bag-checklist-overlay');
    if (overlay) overlay.style.display = 'none';

    // Resume scanning if camera was previously started
    if (state.cameraStartedEver && !state.scanning) {
      startScanLoop().catch(handleCameraError);
    } else if (!state.cameraStartedEver) {
      setState('PERMISSION_PROMPT');
    }
  }

  // --------------------------------------------------------------------------
  // กระเป๋าขึ้นรถ / คืนกระเป๋า — context-aware section in the bag checklist.
  // If the bag's current parent is an ambulance → show "คืนกระเป๋า" (home comes
  // from the latest bag_moves deploy row, resolved server-side). Otherwise →
  // show "เอาขึ้นรถ" with a vehicle picker. Backed by rpc_deploy_bag /
  // rpc_return_bag (migration 20260705010000). No due date by design.
  // --------------------------------------------------------------------------
  async function _renderBagDeploySection(location, bag) {
    const wrap = document.getElementById('bag-cl-deploy-wrap');
    if (!wrap || !window.AppBags || !window.AppBags.deployBag) return;

    const bagLocId = bag.location_id || location.id;
    // Some scan paths resolve the bag without parent_id (e.g. v_location_path
    // rows) — refetch the bag row itself in that case.
    let parentId = location.parent_id;
    if (parentId === undefined) {
      const bagRow = await window.AppBags.getLocationBrief(bagLocId);
      parentId = bagRow?.data?.parent_id || null;
    }
    const parentRes = await window.AppBags.getLocationBrief(parentId);
    const parent = parentRes?.data || null;
    const onVehicle = !!parent && parent.type === 'ambulance';

    if (onVehicle) {
      wrap.innerHTML = `
        <div class="small text-muted mb-1"><i class="bi bi-truck me-1"></i>กระเป๋าอยู่บนรถ: <strong>${escapeHtml(parent.name || parent.code || '')}</strong></div>
        <button class="btn btn-stock-primary w-100" id="bag-cl-return-btn" style="min-height:52px;">
          <i class="bi bi-box-arrow-in-down me-1"></i> คืนกระเป๋าเข้าที่เก็บเดิม
        </button>`;
      wrap.querySelector('#bag-cl-return-btn').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังคืน…';
        const { data, error } = await window.AppBags.returnBag(bagLocId);
        if (error) {
          window.showToast('error', error.message || 'คืนกระเป๋าไม่สำเร็จ');
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-box-arrow-in-down me-1"></i> คืนกระเป๋าเข้าที่เก็บเดิม';
          return;
        }
        window.showToast('success', `คืนกระเป๋าเข้า ${data?.home_name || 'ที่เก็บเดิม'} แล้ว`);
        _dismissBagChecklist();
      });
      return;
    }

    // Not on a vehicle → offer deploy. Load the vehicle list first; hide the
    // whole section when there are no ambulance locations to send it to.
    const vehRes = await window.AppBags.listVehicleLocations();
    const vehicles = vehRes?.data || [];
    if (!vehicles.length) return;

    wrap.innerHTML = `
      <button class="btn btn-stock-primary w-100" id="bag-cl-deploy-btn" style="min-height:52px;">
        <i class="bi bi-truck me-1"></i> เอากระเป๋าขึ้นรถ
      </button>
      <div id="bag-cl-vehicle-pick" class="d-none mt-2">
        <div class="small text-muted mb-1">เลือกรถ:</div>
        ${vehicles.map((v) => `
          <button class="btn btn-outline-secondary w-100 mb-2 bag-cl-vehicle-btn"
                  data-veh-id="${escapeHtml(v.id)}" style="min-height:52px;">
            <i class="bi bi-truck me-1"></i> ${escapeHtml(v.name || v.code)}
          </button>`).join('')}
      </div>`;

    wrap.querySelector('#bag-cl-deploy-btn').addEventListener('click', () => {
      wrap.querySelector('#bag-cl-vehicle-pick')?.classList.toggle('d-none');
    });

    wrap.querySelectorAll('.bag-cl-vehicle-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        wrap.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        const { data, error } = await window.AppBags.deployBag(bagLocId, b.dataset.vehId);
        if (error) {
          window.showToast('error', error.message || 'นำกระเป๋าขึ้นรถไม่สำเร็จ');
          wrap.querySelectorAll('button').forEach((x) => { x.disabled = false; });
          return;
        }
        window.showToast('success', `กระเป๋า ${data?.bag_code || ''} ขึ้นรถ ${data?.dest_name || ''} แล้ว`);
        _dismissBagChecklist();
      });
    });
  }

  // ==========================================================================
  // Phase 6 — Linen Cabinet View + ส่งซัก / รับคืน / นับใหม่ workflows
  //
  // Spec:    docs/superpowers/specs/2026-05-19-phase6-linens-laundry-design.md §7.2
  // UX:      docs/superpowers/designs/2026-05-19-phase6-linens-ui-design.md §3.5–§3.8
  // Decisions: Q6-B (photo required for laundry, advisory for count)
  //            Q6-F Option B (Staff allowed to รับคืน)
  //            Q6-E (independent movements — no pairing)
  //
  // Reuse:   shared/photo-capture.js (PhotoCaptureModal) — DO NOT redefine
  //          shared/linens.js (AppLinens) — fetchLinenByCabinet, sendToLaundry,
  //                                          receiveFromLaundry, submitLinenCount
  //
  // Architecture: overlay panel (same pattern as Phase 4 _showBagChecklistView)
  // ==========================================================================

  /** Check whether a cabinet location has any LINEN items assigned to it. */
  async function _checkCabinetHasLinens(locationId) {
    if (!window.AppLinens) return false;
    const { data, error } = await window.AppLinens.fetchLinenByCabinet(locationId);
    if (error || !data) return false;
    return data.length > 0;
  }

  /** Dismiss linen cabinet overlay and resume scanning. */
  function _dismissLinenCabinet() {
    const overlay = document.getElementById('linen-cabinet-overlay');
    if (overlay) overlay.style.display = 'none';
    if (state.cameraStartedEver && !state.scanning) {
      startScanLoop().catch(handleCameraError);
    } else if (!state.cameraStartedEver) {
      setState('PERMISSION_PROMPT');
    }
  }

  /**
   * Show the linen cabinet view overlay.
   * Fetches LINEN items for the cabinet and renders the card list with action buttons.
   * @param {{ id: string, code: string, name: string, type: string }} location
   */
  async function _showLinenCabinetView(location) {
    let overlay = document.getElementById('linen-cabinet-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'linen-cabinet-overlay';
      overlay.className = 'scan-wrap';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#f5f7fa;z-index:1050;overflow-y:auto;padding-top:16px;';
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';

    // Loading state
    overlay.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button id="linen-back-btn" class="btn btn-sm btn-outline-secondary me-2" style="min-height:44px;">
          <i class="bi bi-arrow-left"></i>
        </button>
        <h6 class="mb-0">ตู้ ${escapeHtml(location.name)} — รายการผ้า</h6>
      </div>
      <div class="text-center py-4 text-muted">
        <span class="spinner-border spinner-border-sm me-2"></span>กำลังโหลดรายการผ้า...
      </div>`;
    overlay.querySelector('#linen-back-btn').addEventListener('click', _dismissLinenCabinet);

    if (!window.AppLinens) {
      overlay.innerHTML += `<div class="alert alert-danger m-2">โมดูล AppLinens ไม่พร้อม — ตรวจสอบ shared/linens.js</div>`;
      return;
    }

    const { data: rows, error } = await window.AppLinens.fetchLinenByCabinet(location.id);
    if (error) {
      _renderLinenOverlayError(overlay, location);
      return;
    }
    _renderLinenCabinetList(overlay, location, rows || []);
  }

  function _renderLinenOverlayError(overlay, location) {
    overlay.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button class="btn btn-sm btn-outline-secondary me-2 linen-back-btn-err" style="min-height:44px;">
          <i class="bi bi-arrow-left"></i>
        </button>
        <h6 class="mb-0">ตู้ ${escapeHtml(location.name)} — รายการผ้า</h6>
      </div>
      <div class="alert alert-danger m-2" role="alert">
        โหลดรายการผ้าไม่สำเร็จ — ลองสแกนใหม่
      </div>
      <div class="px-2">
        <button class="btn btn-outline-secondary w-100 linen-back-btn-err" style="min-height:44px;">
          <i class="bi bi-arrow-left me-1"></i> สแกนใหม่
        </button>
      </div>`;
    overlay.querySelectorAll('.linen-back-btn-err').forEach((b) =>
      b.addEventListener('click', _dismissLinenCabinet));
  }

  function _renderLinenCabinetList(overlay, location, rows) {
    const L = window.AppLinens;
    const backBtn = `<div class="d-flex align-items-center mb-3">
      <button id="linen-back-btn2" class="btn btn-sm btn-outline-secondary me-2" style="min-height:44px;">
        <i class="bi bi-arrow-left"></i>
      </button>
      <h6 class="mb-0">ตู้ ${escapeHtml(location.name)} — รายการผ้า</h6>
    </div>`;

    if (rows.length === 0) {
      overlay.innerHTML = backBtn + `
        <div class="text-center py-5 text-muted">
          <div style="font-size:3rem;">🚫</div>
          <p class="mt-2">ตู้นี้ยังไม่มีรายการผ้า</p>
          <p class="small">ติดต่อผู้ดูแลระบบเพื่อเพิ่มสินค้า</p>
          <button class="btn btn-outline-secondary" id="linen-rescan-btn" style="min-height:44px;">
            <i class="bi bi-arrow-left me-1"></i> สแกนใหม่
          </button>
        </div>`;
      overlay.querySelector('#linen-back-btn2, #linen-rescan-btn')?.addEventListener('click', _dismissLinenCabinet);
      overlay.querySelectorAll('#linen-back-btn2, #linen-rescan-btn').forEach((b) =>
        b.addEventListener('click', _dismissLinenCabinet));
      return;
    }

    const cards = rows.map((row) => {
      const lastDate   = L ? L.formatDate(row.counted_at) : (row.counted_at ? row.counted_at.slice(0, 10) : 'ยังไม่เคยนับ');
      const badge      = L ? L.discrepancyBadgeHtml(row) : '';
      const statusText = row.counted_at
        ? `นับล่าสุด: ${escapeHtml(lastDate)}`
        : 'ยังไม่เคยนับ';
      return `
        <div class="card mb-3" data-item-id="${escapeHtml(row.item_id)}"
             data-item-name="${escapeHtml(row.item_name)}"
             data-item-sku="${escapeHtml(row.sku)}"
             data-location-id="${escapeHtml(location.id)}"
             data-location-code="${escapeHtml(location.code)}"
             data-current-qty="${row.current_qty ?? 0}">
          <div class="card-body py-3">
            <div class="fw-bold mb-1">${escapeHtml(row.item_name)}</div>
            <div class="text-muted small mb-2">
              คงเหลือ: ${row.current_qty ?? 0} ผืน  •  ${escapeHtml(statusText)}
              ${badge ? '  <span class="ms-1">' + badge + '</span>' : ''}
            </div>
            <div class="d-flex gap-2 flex-wrap">
              <button class="btn btn-warning text-dark btn-sm linen-btn-send" style="min-height:44px;min-width:80px;" data-flow="laundry_out">
                ส่งซัก
              </button>
              <button class="btn btn-success btn-sm linen-btn-receive" style="min-height:44px;min-width:80px;" data-flow="laundry_in">
                รับคืน
              </button>
              <button class="btn btn-stock-primary btn-sm linen-btn-count" style="min-height:44px;min-width:80px;" data-flow="count">
                นับใหม่
              </button>
            </div>
          </div>
        </div>`;
    }).join('');

    overlay.innerHTML = backBtn + cards;
    overlay.querySelector('#linen-back-btn2')?.addEventListener('click', _dismissLinenCabinet);

    // Bind action buttons
    overlay.querySelectorAll('[data-item-id]').forEach((card) => {
      const itemId      = card.dataset.itemId;
      const itemName    = card.dataset.itemName;
      const itemSku     = card.dataset.itemSku;
      const locationId  = card.dataset.locationId;
      const locationCode = card.dataset.locationCode;
      const currentQty  = parseInt(card.dataset.currentQty, 10) || 0;

      card.querySelector('.linen-btn-send')?.addEventListener('click', () =>
        _startLinenFlow('laundry_out', { itemId, itemName, itemSku, locationId, locationCode, currentQty }, location, rows));
      card.querySelector('.linen-btn-receive')?.addEventListener('click', () =>
        _startLinenFlow('laundry_in', { itemId, itemName, itemSku, locationId, locationCode, currentQty }, location, rows));
      card.querySelector('.linen-btn-count')?.addEventListener('click', () =>
        _startLinenFlow('count', { itemId, itemName, itemSku, locationId, locationCode, currentQty }, location, rows));
    });
  }

  /**
   * Start a linen workflow (ส่งซัก / รับคืน / นับใหม่).
   * Steps: Photo → Qty/Count → Confirm → Submit
   * Photo required=true for laundry flows (Q6-B); required=false for count.
   */
  function _startLinenFlow(flow, item, location, allRows) {
    // Step 1: Photo
    if (!window.PhotoCaptureModal) {
      window.showToast('error', 'PhotoCaptureModal ไม่พร้อม — ตรวจสอบ shared/photo-capture.js');
      return;
    }

    const isLaundry = flow === 'laundry_out' || flow === 'laundry_in';
    const isCount   = flow === 'count';
    const folder    = `thegood-stock/linen/${item.locationCode}/${item.itemSku}`;
    const flowLabels = {
      laundry_out: 'ส่งซัก',
      laundry_in:  'รับคืน',
      count:       'นับใหม่',
    };
    const label = flowLabels[flow] || flow;
    const photoLabel = isLaundry
      ? (flow === 'laundry_out' ? 'ถ่ายรูปผ้าก่อนส่งซัก (บังคับ)' : 'ถ่ายรูปผ้าที่รับคืน (บังคับ)')
      : 'ถ่ายรูปผ้าที่นับ (แนะนำ — ไม่บังคับ)';

    let capturedPhotoUrl = null;

    window.PhotoCaptureModal.open({
      folder:     folder,
      label:      photoLabel,
      optional:   !isLaundry,   // Q6-B: required for laundry, optional for count
      entityId:   item.itemId + '-' + Date.now(),
      onUploaded: (url) => {
        capturedPhotoUrl = url;
        _showLinenQtyStep(flow, item, location, allRows, capturedPhotoUrl);
      },
      onSkipped:  isCount ? () => {
        capturedPhotoUrl = null;
        _showLinenQtyStep(flow, item, location, allRows, null);
      } : undefined,
      onError:    (msg) => {
        window.showToast('error', 'อัปโหลดรูปไม่สำเร็จ: ' + (msg || ''));
      },
    });
  }

  /**
   * Step 2: Qty / Count input screen (injected into linen-cabinet-overlay).
   */
  function _showLinenQtyStep(flow, item, location, allRows, photoUrl) {
    const overlay = document.getElementById('linen-cabinet-overlay');
    if (!overlay) return;

    const isCount  = flow === 'count';
    const isOut    = flow === 'laundry_out';
    const maxQty   = isOut ? item.currentQty : null;   // no ceiling for laundry_in
    const flowTitle = isCount ? 'นับใหม่' : (isOut ? 'ส่งซัก' : 'รับคืน');
    const qtyLabel  = isCount ? 'จำนวนที่นับได้จริง' : (isOut ? 'จำนวนที่ส่งซัก' : 'จำนวนที่รับคืน');

    overlay.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button id="linen-qty-back" class="btn btn-sm btn-outline-secondary me-2" style="min-height:44px;">
          <i class="bi bi-arrow-left"></i>
        </button>
        <h6 class="mb-0">${escapeHtml(flowTitle)}: ${escapeHtml(item.itemName)}</h6>
      </div>
      <div class="alert alert-light border mb-3 py-2 px-3 small">
        ตู้: ${escapeHtml(location.name)}  •  คงเหลือปัจจุบัน: ${item.currentQty} ผืน
        ${photoUrl ? ' • <span class="text-success"><i class="bi bi-check-circle-fill"></i> มีรูปถ่าย</span>' : ''}
      </div>
      ${isCount ? `<div class="alert alert-info small py-2 px-3 mb-3">
        <i class="bi bi-info-circle me-1"></i>
        การบันทึกนี้คือ "ภาพถ่ายจำนวน" เท่านั้น จะไม่เปลี่ยนยอดคงเหลือในระบบโดยอัตโนมัติ
      </div>` : ''}
      <div class="card mb-3">
        <div class="card-body">
          <label class="form-label fw-bold">${escapeHtml(qtyLabel)} *</label>
          <div class="d-flex align-items-center gap-3">
            <button id="linen-qty-minus" class="btn btn-outline-secondary" style="min-width:44px;min-height:44px;font-size:1.3rem;">−</button>
            <input id="linen-qty-input" type="number" class="form-control text-center"
                   min="${isCount ? 0 : 1}" max="${maxQty !== null ? maxQty : ''}"
                   value="${isCount ? item.currentQty : 1}"
                   style="font-size:2rem;height:64px;max-width:140px;" inputmode="numeric">
            <button id="linen-qty-plus" class="btn btn-outline-secondary" style="min-width:44px;min-height:44px;font-size:1.3rem;">+</button>
          </div>
          ${isOut ? `<div id="linen-qty-warn" class="alert alert-warning d-none mt-2 py-2 small" role="alert">
            ไม่สามารถส่งซักเกินจำนวนที่มี (สูงสุด ${item.currentQty} ผืน)
          </div>` : ''}
        </div>
      </div>
      <button id="linen-qty-next" class="btn btn-stock-primary w-100 mb-2" style="min-height:52px;">
        ถัดไป →
      </button>
      <button id="linen-qty-cancel" class="btn btn-link text-muted w-100" style="min-height:44px;">
        ยกเลิก ${escapeHtml(flowTitle)}
      </button>
    `;

    const qtyEl   = overlay.querySelector('#linen-qty-input');
    const minusBtn = overlay.querySelector('#linen-qty-minus');
    const plusBtn  = overlay.querySelector('#linen-qty-plus');
    const nextBtn  = overlay.querySelector('#linen-qty-next');
    const warnEl   = overlay.querySelector('#linen-qty-warn');

    function _validateQty() {
      const v = parseInt(qtyEl.value, 10);
      const valid = !isNaN(v) && v >= (isCount ? 0 : 1) && (maxQty === null || v <= maxQty);
      nextBtn.disabled = !valid;
      if (warnEl) warnEl.classList.toggle('d-none', !(maxQty !== null && v > maxQty));
      return valid;
    }

    qtyEl.addEventListener('input', _validateQty);
    minusBtn.addEventListener('click', () => { qtyEl.value = Math.max(isCount ? 0 : 1, parseInt(qtyEl.value || '1', 10) - 1); _validateQty(); });
    plusBtn.addEventListener('click',  () => { qtyEl.value = parseInt(qtyEl.value || '0', 10) + 1; _validateQty(); });
    overlay.querySelector('#linen-qty-back').addEventListener('click', () => _showLinenCabinetView(location));
    overlay.querySelector('#linen-qty-cancel').addEventListener('click', () => _showLinenCabinetView(location));

    nextBtn.addEventListener('click', () => {
      if (!_validateQty()) return;
      const qty = parseInt(qtyEl.value, 10);
      _showLinenConfirmStep(flow, item, location, allRows, photoUrl, qty);
    });

    _validateQty();
  }

  /**
   * Step 3: Confirm screen.
   */
  function _showLinenConfirmStep(flow, item, location, allRows, photoUrl, qty) {
    const overlay = document.getElementById('linen-cabinet-overlay');
    if (!overlay) return;

    const isCount = flow === 'count';
    const isOut   = flow === 'laundry_out';
    const flowTitle  = isCount ? 'บันทึกการนับ' : (isOut ? 'ส่งซัก' : 'รับคืน');
    const confirmBtn = isCount ? 'btn-stock-primary' : (isOut ? 'btn-warning text-dark' : 'btn-success');
    const afterQty   = isOut
      ? (item.currentQty - qty)
      : (isCount ? '—' : (item.currentQty + qty));

    // Delta hint for count confirmation
    const delta = isCount ? (item.currentQty - qty) : null;
    const deltaHtml = isCount && delta !== 0 ? `
      <div class="alert ${Math.abs(delta) > 2 ? 'alert-warning' : 'alert-info'} small py-2 mt-2">
        ต่างจากระบบ: ${delta > 0 ? '+' : ''}${delta} ผืน
        ${Math.abs(delta) > 2 ? '<br><small>หากต้องการแก้ไขยอดคงเหลือ ให้ใช้ ส่งซัก หรือ รับคืน</small>' : ''}
      </div>` : '';

    overlay.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <button id="linen-conf-back" class="btn btn-sm btn-outline-secondary me-2" style="min-height:44px;">
          <i class="bi bi-arrow-left"></i>
        </button>
        <h6 class="mb-0">สรุป${escapeHtml(flowTitle)}</h6>
      </div>
      <div class="card mb-3">
        <div class="card-body">
          <div class="row mb-2"><div class="col-5 text-muted small">รายการ:</div><div class="col-7 fw-bold">${escapeHtml(item.itemName)}</div></div>
          <div class="row mb-2"><div class="col-5 text-muted small">ตู้:</div><div class="col-7">${escapeHtml(location.name)}</div></div>
          <div class="row mb-2">
            <div class="col-5 text-muted small">${isCount ? 'จำนวนที่นับ:' : (isOut ? 'จำนวนที่ส่ง:' : 'จำนวนที่รับ:')}</div>
            <div class="col-7 fw-bold">${qty} ผืน</div>
          </div>
          ${!isCount ? `<div class="row mb-2"><div class="col-5 text-muted small">คงเหลือหลัง:</div><div class="col-7">${afterQty} ผืน</div></div>` : ''}
          ${photoUrl ? '<div class="row mb-2"><div class="col-5 text-muted small">รูปถ่าย:</div><div class="col-7"><span class="badge bg-success"><i class="bi bi-check-circle-fill me-1"></i>มีรูป</span></div></div>' : '<div class="row mb-2"><div class="col-5 text-muted small">รูปถ่าย:</div><div class="col-7 text-muted small">ข้าม</div></div>'}
          ${deltaHtml}
        </div>
      </div>
      <button id="linen-confirm-btn" class="btn ${confirmBtn} w-100 mb-2" style="min-height:52px;">
        ยืนยัน ${escapeHtml(flowTitle)}
      </button>
      <button id="linen-conf-cancel" class="btn btn-link text-muted w-100" style="min-height:44px;">
        ยกเลิก
      </button>
      <div id="linen-conf-error" class="alert alert-danger d-none mt-2" role="alert"></div>
    `;

    overlay.querySelector('#linen-conf-back').addEventListener('click', () =>
      _showLinenQtyStep(flow, item, location, allRows, photoUrl));
    overlay.querySelector('#linen-conf-cancel').addEventListener('click', () =>
      _showLinenCabinetView(location));

    overlay.querySelector('#linen-confirm-btn').addEventListener('click', async () => {
      const btn    = overlay.querySelector('#linen-confirm-btn');
      const errEl  = overlay.querySelector('#linen-conf-error');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก...';
      if (errEl) errEl.classList.add('d-none');

      let result;
      const L = window.AppLinens;
      if (!L) {
        if (errEl) { errEl.textContent = 'AppLinens ไม่พร้อม'; errEl.classList.remove('d-none'); }
        btn.disabled = false;
        btn.textContent = `ยืนยัน ${flowTitle}`;
        return;
      }

      if (isCount) {
        result = await L.submitLinenCount({
          locationId:  item.locationId,
          itemId:      item.itemId,
          countedQty:  qty,
          photoUrl:    photoUrl || null,
        });
      } else if (isOut) {
        result = await L.sendToLaundry({
          itemId:     item.itemId,
          locationId: item.locationId,
          qty,
          photoUrl,
        });
      } else {
        result = await L.receiveFromLaundry({
          itemId:     item.itemId,
          locationId: item.locationId,
          qty,
          photoUrl,
        });
      }

      if (result.error) {
        const msg = result.error.message || result.error.code || 'เกิดข้อผิดพลาด';
        if (errEl) { errEl.textContent = 'บันทึกไม่สำเร็จ — ' + msg; errEl.classList.remove('d-none'); }
        btn.disabled = false;
        btn.textContent = `ยืนยัน ${flowTitle}`;
        return;
      }

      // Success
      const successMsg = isCount
        ? `บันทึกการนับแล้ว — ${item.itemName} จำนวน ${qty} ผืน`
        : isOut
        ? `ส่งซักเรียบร้อย — qty ${item.itemName} ลดแล้ว ${qty} ผืน`
        : `รับคืนเรียบร้อย — qty ${item.itemName} เพิ่มแล้ว ${qty} ผืน`;
      window.showToast('success', successMsg);

      // Refresh linen cabinet view (re-fetch updated data)
      _showLinenCabinetView(location);
    });
  }

  // ── End Phase 6 linen cabinet view ──────────────────────────────────────

})();

// =============================================================================
// Phase 3 — Mode toggle: เบิก-จ่าย / ยืม-คืน
//
// Spec: docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md §5, §6
// Decisions-locked:
//   Q-Phase3-A — mode toggle at top of staff-scan.html
//   Q-Phase3-C — photo is advisory; skip always shown
//   Q-Phase3-D — Staff auto-fills borrower_username; Admin shows picker
//   Q-Phase3-G — due_at default 3 days; presets 1/3/7/custom
//
// ARCHITECTURE NOTE:
//   The Phase 1/2 scan state machine (above) handles เบิก-จ่าย mode unchanged.
//   Phase 3 PREPENDS a mode toggle above the existing scan section.
//   When ยืม-คืน mode is active, this module renders a separate borrow/return
//   multi-step flow below the mode toggle and hides the Phase 1/2 scan section.
//
// Movement types in ยืม-คืน mode: ONLY 'borrow' and 'return' (not issue/adjustment_loss).
// Those remain in เบิก-จ่าย mode exclusively.
//
// Requires (loaded before sw caches this file):
//   shared/loans.js       — window.AppLoans
//   shared/photo-capture.js — window.PhotoCaptureModal
//   shared/inventory.js   — window.AppInventory
// =============================================================================

(function () {
  'use strict';

  // ==========================================================================
  // Constants + state
  // ==========================================================================

  // Mode: 'issue' (เบิก-จ่าย, Phase 1/2) or 'borrow' (ยืม-คืน, Phase 3)
  let _mode     = 'issue';   // current top-level mode
  let _subMode  = 'borrow';  // within ยืม-คืน: 'borrow' or 'return'

  // Borrow flow state
  const _borrow = {
    step:           1,      // 1=scan item, 2=scan loc, 3=due/qty, 4=photo, 5=confirm
    item:           null,
    location:       null,
    qty:            1,
    dueAt:          null,   // Date object
    duePreset:      3,      // 1|3|7|'custom'
    note:           '',
    photoUrl:       null,
    clientRefId:    null,
  };

  // Return flow state
  const _return = {
    step:           1,      // 1=scan item, 2=photo, 3=confirm
    item:           null,
    loan:           null,   // open loan row
    photoUrl:       null,
    clientRefId:    null,
  };

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _toast(type, msg) { (window.showToast || (()=>{}))(type, msg); }

  // ==========================================================================
  // DOM injection — insert mode toggle above the existing scan section
  // ==========================================================================

  function _injectModeToggle() {
    const scanPage = document.getElementById('scan-page');
    if (!scanPage || document.getElementById('mode-toggle-row')) return;

    const toggleDiv = document.createElement('div');
    toggleDiv.id = 'mode-toggle-row';
    toggleDiv.className = 'mb-3 mt-2';
    toggleDiv.innerHTML = `
      <div class="btn-group w-100" role="group" aria-label="เลือกโหมดการทำงาน">
        <button type="button" id="mode-btn-issue"
                class="btn btn-stock-primary active"
                aria-label="โหมดเบิก-จ่าย"
                style="min-height:48px; font-weight:600;">
          เบิก-จ่าย
        </button>
        <button type="button" id="mode-btn-borrow"
                class="btn btn-outline-secondary"
                aria-label="โหมดยืม-คืน"
                style="min-height:48px; font-weight:600;">
          ยืม-คืน
        </button>
      </div>

      <!-- ยืม-คืน panel (hidden when mode=issue) -->
      <div id="borrow-return-panel" class="d-none mt-3">
        <!-- Sub-mode toggle: ยืมอุปกรณ์ / คืนอุปกรณ์ -->
        <div class="btn-group w-100 mb-3" role="group" aria-label="เลือกยืมหรือคืน">
          <button type="button" id="submode-btn-borrow"
                  class="btn btn-stock-primary active"
                  aria-label="ยืมอุปกรณ์"
                  style="min-height:48px;">
            ↗ ยืมอุปกรณ์
          </button>
          <button type="button" id="submode-btn-return"
                  class="btn btn-outline-secondary"
                  aria-label="คืนอุปกรณ์"
                  style="min-height:48px;">
            ↩ คืนอุปกรณ์
          </button>
        </div>

        <!-- Step-flow content area (re-rendered per step) -->
        <div id="borrow-flow-content"></div>
      </div>
    `;

    // Insert at start of scan-page main
    scanPage.insertBefore(toggleDiv, scanPage.firstChild);

    // Wire mode toggle
    document.getElementById('mode-btn-issue')?.addEventListener('click', () => _setMode('issue'));
    document.getElementById('mode-btn-borrow')?.addEventListener('click', () => _setMode('borrow'));
    document.getElementById('submode-btn-borrow')?.addEventListener('click', () => _setSubMode('borrow'));
    document.getElementById('submode-btn-return')?.addEventListener('click', () => _setSubMode('return'));
  }

  function _setMode(mode) {
    _mode = mode;
    const issueBtn  = document.getElementById('mode-btn-issue');
    const borrowBtn = document.getElementById('mode-btn-borrow');
    const panel     = document.getElementById('borrow-return-panel');
    const scanSections = document.querySelectorAll('#scan-page > section, #scan-page > hr');

    if (mode === 'issue') {
      issueBtn?.classList.add('active', 'btn-stock-primary');
      issueBtn?.classList.remove('btn-outline-secondary');
      borrowBtn?.classList.remove('active', 'btn-stock-primary');
      borrowBtn?.classList.add('btn-outline-secondary');
      panel?.classList.add('d-none');
      scanSections.forEach((s) => s.classList.remove('d-none'));
    } else {
      borrowBtn?.classList.add('active', 'btn-stock-primary');
      borrowBtn?.classList.remove('btn-outline-secondary');
      issueBtn?.classList.remove('active', 'btn-stock-primary');
      issueBtn?.classList.add('btn-outline-secondary');
      panel?.classList.remove('d-none');
      scanSections.forEach((s) => s.classList.add('d-none'));
      _renderBorrowReturnFlow();
    }
  }

  function _setSubMode(sub) {
    _subMode = sub;
    const bBtn = document.getElementById('submode-btn-borrow');
    const rBtn = document.getElementById('submode-btn-return');
    if (sub === 'borrow') {
      bBtn?.classList.add('active', 'btn-stock-primary');
      bBtn?.classList.remove('btn-outline-secondary');
      rBtn?.classList.remove('active', 'btn-stock-primary');
      rBtn?.classList.add('btn-outline-secondary');
      _resetBorrow();
    } else {
      rBtn?.classList.add('active', 'btn-stock-primary');
      rBtn?.classList.remove('btn-outline-secondary');
      bBtn?.classList.remove('active', 'btn-stock-primary');
      bBtn?.classList.add('btn-outline-secondary');
      _resetReturn();
    }
  }

  function _renderBorrowReturnFlow() {
    if (_subMode === 'borrow') _renderBorrowStep();
    else _renderReturnStep();
  }

  // ==========================================================================
  // BORROW FLOW — 5 steps
  // ==========================================================================

  function _resetBorrow() {
    _borrow.step = 1; _borrow.item = null; _borrow.location = null;
    _borrow.qty = 1; _borrow.dueAt = window.AppLoans ? window.AppLoans.defaultDueAt() : _defaultDue();
    _borrow.duePreset = 3; _borrow.note = ''; _borrow.photoUrl = null;
    _borrow.clientRefId = null;
    _renderBorrowStep();
  }

  function _defaultDue() {
    const d = new Date(); d.setDate(d.getDate() + 3); d.setHours(23,59,0,0); return d;
  }

  function _renderBorrowStep() {
    const root = document.getElementById('borrow-flow-content');
    if (!root) return;

    // Step indicator
    const steps = ['สแกนสินค้า','สแกนตำแหน่ง','กำหนดวันคืน','ถ่ายรูป','ยืนยัน'];
    const stepIndicator = steps.map((s, i) => {
      const n = i + 1;
      const active = n === _borrow.step ? 'fw-bold text-stock-accent' : 'text-muted';
      const done   = n < _borrow.step;
      return `<span class="small ${active}" style="min-width:40px; text-align:center;">
        <span class="${done ? 'text-success' : ''}">${done ? '✓' : n}</span>
        <span class="d-none d-sm-inline"> ${_esc(s)}</span>
      </span>`;
    }).join('<span class="text-muted mx-1">›</span>');
    root.innerHTML = `<div class="d-flex align-items-center flex-wrap gap-1 mb-3">${stepIndicator}</div>
      <div id="borrow-step-body"></div>`;

    const body = document.getElementById('borrow-step-body');
    if (!body) return;

    if (_borrow.step === 1) _renderBorrowStep1(body);
    else if (_borrow.step === 2) _renderBorrowStep2(body);
    else if (_borrow.step === 3) _renderBorrowStep3(body);
    else if (_borrow.step === 4) _renderBorrowStep4(body);
    else if (_borrow.step === 5) _renderBorrowStep5(body);
  }

  // ---------------------------------------------------------------------
  // One-shot camera scan modal for the ยืม-คืน steps. Resolves with the raw
  // decoded text via onText, then closes. The main issue-mode camera is
  // stopped first — AppScanner allows a single active session per page.
  // NOTE: the <video> is sized by the CSS rule injected below, NOT an inline
  // style — on iOS html5-qrcode REPLACES the video element, and only a
  // descendant CSS rule also covers the injected replacement (same root
  // cause as the staff-oxygen iOS scan fix, v0.20.26).
  // ---------------------------------------------------------------------
  function _openBorrowScanModal(title, onText) {
    if (!window.AppScanner || !window.AppScanner.isSupported()) {
      _toast('warning', 'อุปกรณ์นี้ใช้กล้องสแกนไม่ได้ — พิมพ์รหัสแทน');
      return;
    }
    try { window.AppScanner.stopScanning().catch(() => {}); } catch { /* ignore */ }
    try { if (typeof state === 'object' && state) state.scanning = false; } catch { /* ignore */ }

    const old = document.getElementById('borrow-scan-modal');
    if (old) try { old.remove(); } catch { /* ignore */ }

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal fade" id="borrow-scan-modal" tabindex="-1" aria-labelledby="borrow-scan-title">
        <style>#borrow-scan-modal .borrow-scan-stage video{width:100%;height:100%;object-fit:cover;display:block;}</style>
        <div class="modal-dialog modal-dialog-centered modal-fullscreen-sm-down">
          <div class="modal-content bg-dark text-white">
            <div class="modal-header border-0 pb-0">
              <h5 class="modal-title" id="borrow-scan-title"></h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body p-2">
              <div class="borrow-scan-stage"
                   style="position:relative;width:100%;aspect-ratio:3/4;max-height:55vh;
                          background:#000;border-radius:12px;overflow:hidden;">
                <video id="borrow-scan-video" playsinline muted aria-label="กล้องสแกน"></video>
                <div style="position:absolute;top:15%;left:15%;right:15%;bottom:15%;
                            border:2px solid #00B8A9;border-radius:10px;pointer-events:none;"></div>
                <div style="position:absolute;left:0;right:0;bottom:14px;text-align:center;
                            color:#fff;font-size:.95rem;text-shadow:0 1px 4px rgba(0,0,0,.7);">
                  วางบาร์โค้ด/QR ให้อยู่กลางกรอบ
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const modalEl = wrap.firstElementChild;
    modalEl.querySelector('#borrow-scan-title').textContent = title;
    document.body.appendChild(modalEl);
    const bsModal = new bootstrap.Modal(modalEl);
    let _done = false;

    modalEl.addEventListener('shown.bs.modal', () => {
      window.AppScanner.startScanning({
        videoElement: modalEl.querySelector('#borrow-scan-video'),
        onScan: (text) => {
          if (_done) return;
          _done = true;
          window.AppScanner.stopScanning().catch(() => {});
          bsModal.hide();
          onText(String(text || '').trim());
        },
        onError: (msg) => {
          if (_done) return;
          _done = true;
          window.AppScanner.stopScanning().catch(() => {});
          bsModal.hide();
          _toast('error', 'เปิดกล้องไม่สำเร็จ: ' + (msg || '') + ' — พิมพ์รหัสแทนได้');
        },
      });
    }, { once: true });

    modalEl.addEventListener('hidden.bs.modal', () => {
      if (!_done) window.AppScanner.stopScanning().catch(() => {});
      try { modalEl.remove(); } catch { /* ignore */ }
    });

    bsModal.show();
  }

  function _renderBorrowStep1(body) {
    const camBtn = (window.AppScanner && window.AppScanner.cameraAvailable)
      ? `<button type="button" id="borrow-scan-item-btn" class="btn btn-outline-secondary"
                 style="min-width:56px;min-height:48px;" aria-label="สแกนด้วยกล้อง">
           <i class="bi bi-camera"></i></button>`
      : '';
    body.innerHTML = `
      <div class="card p-3">
        <h6 class="mb-2">ขั้นที่ 1: สแกนหรือพิมพ์ SKU สินค้า</h6>
        <div class="d-flex gap-2 mb-2">
          <input type="text" id="borrow-sku-input" class="form-control flex-grow-1"
                 placeholder="SKU / Barcode" autocomplete="off"
                 style="min-height:48px; font-size:1.05rem;">
          ${camBtn}
        </div>
        <button type="button" id="borrow-step1-btn" class="btn btn-stock-primary w-100"
                style="min-height:48px;">ค้นหาสินค้า →</button>
        <div id="borrow-item-result" class="mt-2"></div>
      </div>`;

    document.getElementById('borrow-step1-btn')?.addEventListener('click', async () => {
      const sku = (document.getElementById('borrow-sku-input')?.value || '').trim();
      if (!sku) { _toast('warning', 'กรุณาระบุ SKU หรือ Barcode'); return; }
      const res = await window.AppInventory.searchByBarcode(sku);
      if (res.error || !res.data) {
        document.getElementById('borrow-item-result').innerHTML =
          `<div class="alert alert-warning small">ไม่พบสินค้า — ลองใหม่<br>
           <span class="text-muted">หมายเหตุ: รหัสกระเป๋า (BAG-…) ไม่ใช่สินค้า — ยืม-คืนใช้ได้กับ "สินค้า" ในคลังเท่านั้น</span></div>`;
        return;
      }
      const item = res.data;
      // Lot-tracked meds cannot be borrowed: the borrow movement carries no
      // lot_id and the DB trigger rejects it. Say so clearly instead of
      // letting the user hit a raw trigger error at the confirm step.
      if (item.tracks_lots) {
        document.getElementById('borrow-item-result').innerHTML =
          `<div class="alert alert-warning small">
             <strong>${_esc(item.name || '')}</strong> เป็นของคุมล็อต/วันหมดอายุ —
             ยืม-คืนใช้กับอุปกรณ์เท่านั้น ให้ใช้โหมด <strong>เบิก-จ่าย</strong> แทน</div>`;
        return;
      }
      if ((item.total_qty || 0) <= 0) {
        document.getElementById('borrow-item-result').innerHTML =
          `<div class="alert alert-warning small">ของไม่เหลือในคลัง — ไม่สามารถยืมได้</div>`;
        return;
      }
      _borrow.item = item;
      _borrow.step = 2;
      _renderBorrowStep();
    });

    document.getElementById('borrow-scan-item-btn')?.addEventListener('click', () => {
      _openBorrowScanModal('สแกนสินค้า', (text) => {
        const input = document.getElementById('borrow-sku-input');
        if (input) input.value = text;
        document.getElementById('borrow-step1-btn')?.click();
      });
    });

    document.getElementById('borrow-sku-input')?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') document.getElementById('borrow-step1-btn')?.click();
    });
  }

  function _renderBorrowStep2(body) {
    const item = _borrow.item;
    body.innerHTML = `
      <div class="card p-3">
        <div class="alert alert-success small py-2 mb-2">
          สินค้า: <strong>${_esc(item?.name || '')} (${_esc(item?.sku || '')})</strong>
          · คงเหลือรวม: ${_esc(String(item?.total_qty || 0))} ชิ้น
        </div>
        <h6 class="mb-2">ขั้นที่ 2: สแกนหรือพิมพ์ตำแหน่งจัดเก็บ</h6>
        <div class="d-flex gap-2 mb-2">
          <input type="text" id="borrow-loc-input" class="form-control flex-grow-1"
                 placeholder="รหัสตำแหน่ง (เช่น ROOM-A)" autocomplete="off"
                 style="min-height:48px; font-size:1.05rem;">
          ${(window.AppScanner && window.AppScanner.cameraAvailable)
            ? `<button type="button" id="borrow-scan-loc-btn" class="btn btn-outline-secondary"
                       style="min-width:56px;min-height:48px;" aria-label="สแกน QR ตำแหน่ง">
                 <i class="bi bi-camera"></i></button>`
            : ''}
        </div>
        <button type="button" id="borrow-step2-btn" class="btn btn-stock-primary w-100"
                style="min-height:48px;">ค้นหาตำแหน่ง →</button>
        <div id="borrow-loc-result" class="mt-2"></div>
        <button type="button" class="btn btn-link btn-sm mt-2" id="borrow-back-1">← แก้ไขสินค้า</button>
      </div>`;

    document.getElementById('borrow-scan-loc-btn')?.addEventListener('click', () => {
      _openBorrowScanModal('สแกน QR ตำแหน่ง', (text) => {
        const input = document.getElementById('borrow-loc-input');
        if (input) input.value = text;
        document.getElementById('borrow-step2-btn')?.click();
      });
    });

    document.getElementById('borrow-step2-btn')?.addEventListener('click', async () => {
      const code = (document.getElementById('borrow-loc-input')?.value || '').trim();
      if (!code) { _toast('warning', 'กรุณาระบุรหัสตำแหน่ง'); return; }
      const res = await window.AppInventory.findLocationByCode(code);
      if (res.error || !res.data) {
        document.getElementById('borrow-loc-result').innerHTML =
          `<div class="alert alert-warning small">ไม่พบตำแหน่ง — ลองใหม่</div>`;
        return;
      }
      _borrow.location = res.data;
      _borrow.step = 3;
      if (!_borrow.dueAt) _borrow.dueAt = _defaultDue();
      _renderBorrowStep();
    });

    document.getElementById('borrow-loc-input')?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') document.getElementById('borrow-step2-btn')?.click();
    });
    document.getElementById('borrow-back-1')?.addEventListener('click', () => {
      _borrow.step = 1; _renderBorrowStep();
    });
  }

  function _renderBorrowStep3(body) {
    const presets = [1, 3, 7];
    const presetHtml = presets.map((d) => {
      const active = _borrow.duePreset === d
        ? 'btn-stock-primary fw-600'
        : 'btn-outline-secondary';
      return `<button type="button" class="btn ${active} flex-fill borrow-preset-btn"
                      data-days="${d}" style="min-height:48px;">${d} วัน</button>`;
    }).join('');

    const dueStr = _borrow.dueAt ? _borrow.dueAt.toISOString().split('T')[0] : '';
    body.innerHTML = `
      <div class="card p-3">
        <h6 class="mb-3">ขั้นที่ 3: กำหนดวันคืน + จำนวน</h6>

        <label class="form-label small fw-semibold">จำนวน *</label>
        <div class="d-flex align-items-center gap-2 mb-3">
          <button type="button" class="btn btn-outline-secondary" id="borrow-qty-minus"
                  style="min-width:44px; min-height:44px; font-size:1.2rem;">−</button>
          <input type="number" id="borrow-qty" class="form-control text-center"
                 value="${_borrow.qty}" min="1" style="min-height:44px; max-width:80px;"
                 inputmode="numeric">
          <button type="button" class="btn btn-outline-secondary" id="borrow-qty-plus"
                  style="min-width:44px; min-height:44px; font-size:1.2rem;">+</button>
        </div>

        <label class="form-label small fw-semibold">กำหนดคืน * <small class="text-muted">(Q-Phase3-G: default 3 วัน)</small></label>
        <div class="d-flex gap-2 mb-2 flex-wrap">
          ${presetHtml}
          <button type="button" class="btn ${_borrow.duePreset === 'custom' ? 'btn-stock-primary fw-600' : 'btn-outline-secondary'} flex-fill borrow-preset-btn"
                  data-days="custom" style="min-height:48px;">กำหนดเอง</button>
        </div>

        <div id="borrow-custom-date" class="${_borrow.duePreset === 'custom' ? '' : 'd-none'} mb-2">
          <label class="form-label small">วันที่คืน</label>
          <input type="date" id="borrow-due-date" class="form-control" value="${dueStr}"
                 min="${new Date().toISOString().split('T')[0]}"
                 style="min-height:44px;">
        </div>

        <div id="borrow-due-preview" class="text-muted small mb-3"></div>

        <label class="form-label small">หมายเหตุ (ไม่บังคับ)</label>
        <textarea id="borrow-note" class="form-control mb-3" rows="2"
                  placeholder="หมายเหตุ">${_esc(_borrow.note)}</textarea>

        <button type="button" id="borrow-step3-next" class="btn btn-stock-primary w-100"
                style="min-height:48px;">ถัดไป: ถ่ายรูป →</button>
        <button type="button" class="btn btn-link btn-sm mt-2" id="borrow-back-2">← แก้ไขตำแหน่ง</button>
      </div>`;

    _updateDuePreview();

    body.querySelectorAll('.borrow-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const days = btn.dataset.days;
        _borrow.duePreset = days === 'custom' ? 'custom' : parseInt(days);
        if (_borrow.duePreset !== 'custom') {
          _borrow.dueAt = window.AppLoans ? window.AppLoans.dueDateFromNow(_borrow.duePreset) : _defaultDue();
        }
        document.getElementById('borrow-custom-date')?.classList.toggle('d-none', _borrow.duePreset !== 'custom');
        _renderBorrowStep3Buttons();
        _updateDuePreview();
      });
    });

    document.getElementById('borrow-due-date')?.addEventListener('change', (ev) => {
      const val = ev.target.value;
      if (val) { _borrow.dueAt = new Date(val + 'T23:59:00'); _updateDuePreview(); }
    });

    document.getElementById('borrow-qty-minus')?.addEventListener('click', () => {
      _borrow.qty = Math.max(1, _borrow.qty - 1);
      const inp = document.getElementById('borrow-qty');
      if (inp) inp.value = _borrow.qty;
    });
    document.getElementById('borrow-qty-plus')?.addEventListener('click', () => {
      _borrow.qty = Math.min(999, _borrow.qty + 1);
      const inp = document.getElementById('borrow-qty');
      if (inp) inp.value = _borrow.qty;
    });
    document.getElementById('borrow-qty')?.addEventListener('input', (ev) => {
      _borrow.qty = Math.max(1, parseInt(ev.target.value || '1', 10) || 1);
    });

    document.getElementById('borrow-note')?.addEventListener('input', (ev) => {
      _borrow.note = ev.target.value;
    });

    document.getElementById('borrow-step3-next')?.addEventListener('click', () => {
      _borrow.qty = Math.max(1, parseInt(document.getElementById('borrow-qty')?.value || '1', 10) || 1);
      _borrow.note = document.getElementById('borrow-note')?.value || '';
      if (!_borrow.dueAt || _borrow.dueAt <= new Date()) {
        _toast('warning', 'วันคืนต้องไม่ผ่านมาแล้ว'); return;
      }
      _borrow.step = 4; _renderBorrowStep();
    });

    document.getElementById('borrow-back-2')?.addEventListener('click', () => {
      _borrow.step = 2; _renderBorrowStep();
    });
  }

  function _renderBorrowStep3Buttons() {
    // Re-highlight preset buttons without full re-render
    document.querySelectorAll('.borrow-preset-btn').forEach((btn) => {
      const days = btn.dataset.days;
      const isActive = days === 'custom'
        ? _borrow.duePreset === 'custom'
        : parseInt(days) === _borrow.duePreset;
      btn.classList.toggle('btn-stock-primary', isActive);
      btn.classList.toggle('btn-outline-secondary', !isActive);
    });
  }

  function _updateDuePreview() {
    const preview = document.getElementById('borrow-due-preview');
    if (!preview || !_borrow.dueAt) return;
    const fmt = window.AppLoans ? window.AppLoans.formatThaiDate(_borrow.dueAt)
              : _borrow.dueAt.toLocaleDateString('th-TH');
    preview.textContent = `กำหนดคืน: ${fmt}`;
  }

  function _renderBorrowStep4(body) {
    const photoLabel = _borrow.photoUrl
      ? `<div class="mb-2"><img src="${_esc(_borrow.photoUrl)}" class="img-thumbnail"
             style="max-width:100px; height:75px; object-fit:cover;" alt="รูปก่อนยืม"></div>`
      : '';
    body.innerHTML = `
      <div class="card p-3">
        <h6 class="mb-2">ขั้นที่ 4: ถ่ายรูปอุปกรณ์ก่อนยืม (ไม่บังคับ)</h6>
        ${photoLabel}
        <button type="button" id="borrow-step4-photo" class="btn btn-outline-secondary mb-2 w-100"
                style="min-height:48px;">
          <i class="bi bi-camera me-1" aria-hidden="true"></i>📷 ถ่าย / เลือกรูป
        </button>
        <div class="d-flex gap-2">
          <button type="button" id="borrow-step4-next" class="btn btn-stock-primary flex-grow-1"
                  style="min-height:48px;">ถัดไป: ยืนยัน →</button>
          <button type="button" id="borrow-step4-skip" class="btn btn-link"
                  aria-label="ข้ามการถ่ายรูป"
                  style="min-height:48px;">ข้าม — ไม่มีรูป</button>
        </div>
        <button type="button" class="btn btn-link btn-sm mt-2" id="borrow-back-3">← แก้ไขวันคืน</button>
      </div>`;

    document.getElementById('borrow-step4-photo')?.addEventListener('click', () => {
      if (!window.PhotoCaptureModal) { _toast('warning', 'โหลดโมดูลถ่ายรูปไม่สำเร็จ'); return; }
      const refId = _borrow.clientRefId || (_borrow.clientRefId = _uuid());
      window.PhotoCaptureModal.open({
        folder:     'thegood-stock/borrow/' + refId + '/borrow',
        label:      'ถ่ายรูปอุปกรณ์ก่อนยืม',
        optional:   true,
        entityId:   refId,
        onUploaded: (url) => {
          _borrow.photoUrl = url;
          _borrow.step = 5; _renderBorrowStep();
        },
        onSkipped: () => { _borrow.step = 5; _renderBorrowStep(); },
        onError:   () => _toast('warning', 'อัปโหลดรูปไม่สำเร็จ — ยังดำเนินการได้'),
      });
    });

    document.getElementById('borrow-step4-next')?.addEventListener('click', () => {
      _borrow.step = 5; _renderBorrowStep();
    });
    document.getElementById('borrow-step4-skip')?.addEventListener('click', () => {
      _borrow.step = 5; _renderBorrowStep();
    });
    document.getElementById('borrow-back-3')?.addEventListener('click', () => {
      _borrow.step = 3; _renderBorrowStep();
    });
  }

  function _renderBorrowStep5(body) {
    const item = _borrow.item;
    const loc  = _borrow.location;
    const due  = _borrow.dueAt
      ? (window.AppLoans ? window.AppLoans.formatThaiDate(_borrow.dueAt) : _borrow.dueAt.toLocaleDateString('th-TH'))
      : '—';
    body.innerHTML = `
      <div class="card p-3">
        <h6 class="mb-3">ยืนยันการยืม</h6>
        <dl class="mb-3">
          <dt class="small text-muted">สินค้า</dt>
          <dd>${_esc(item?.name || '—')} <code class="small">${_esc(item?.sku || '')}</code></dd>
          <dt class="small text-muted">ตำแหน่ง</dt>
          <dd>${_esc(loc?.code || loc?.name || '—')}</dd>
          <dt class="small text-muted">จำนวน</dt>
          <dd>${_borrow.qty} ชิ้น</dd>
          <dt class="small text-muted">ครบกำหนด</dt>
          <dd>${_esc(due)}</dd>
          <dt class="small text-muted">รูปถ่าย</dt>
          <dd>${_borrow.photoUrl
            ? `<img src="${_esc(_borrow.photoUrl)}" class="img-thumbnail"
                   style="max-width:80px; height:60px; object-fit:cover;" alt="รูปก่อนยืม">`
            : '<span class="text-muted small">ไม่มีรูป</span>'}</dd>
          ${_borrow.note ? `<dt class="small text-muted">หมายเหตุ</dt><dd>${_esc(_borrow.note)}</dd>` : ''}
        </dl>
        <button type="button" id="borrow-confirm-btn" class="btn btn-stock-primary w-100 mb-2"
                style="min-height:52px; font-weight:600;">ยืนยันการยืม</button>
        <button type="button" id="borrow-back-4" class="btn btn-outline-secondary w-100"
                style="min-height:44px;">← แก้ไข</button>
      </div>`;

    document.getElementById('borrow-confirm-btn')?.addEventListener('click', _submitBorrow);
    document.getElementById('borrow-back-4')?.addEventListener('click', () => {
      _borrow.step = 4; _renderBorrowStep();
    });
  }

  async function _submitBorrow() {
    const btn = document.getElementById('borrow-confirm-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก…'; }

    if (!_borrow.clientRefId) _borrow.clientRefId = _uuid();

    const r = await window.AppLoans.createBorrow({
      itemId:     _borrow.item.id,
      locationId: _borrow.location.id,
      qty:        _borrow.qty,
      dueAt:      _borrow.dueAt,
      note:       _borrow.note || null,
      clientRefId: _borrow.clientRefId,
    });

    if (r.error) {
      const msg = window.AppLoans.mapTriggerErrorToToast(r.error);
      _toast('error', 'บันทึกไม่สำเร็จ: ' + msg);
      if (btn) { btn.disabled = false; btn.textContent = 'ยืนยันการยืม'; }
      return;
    }

    // PATCH photo if captured
    if (_borrow.photoUrl && r.data?.id) {
      const loanRes = await window.AppLoans.fetchLoanByBorrowMovement(r.data.id);
      if (loanRes.data?.id) {
        await window.AppLoans.patchLoanPhoto(loanRes.data.id, 'borrow', _borrow.photoUrl);
      }
    }

    const due = _borrow.dueAt
      ? (window.AppLoans ? window.AppLoans.formatThaiDate(_borrow.dueAt) : _borrow.dueAt.toLocaleDateString('th-TH'))
      : '';
    const toastMsg = _borrow.photoUrl
      ? `ยืมสำเร็จ — กำหนดคืน ${due}`
      : `ยืมสำเร็จ — แต่ไม่สามารถอัปโหลดรูปถ่ายได้ — กำหนดคืน ${due}`;
    _toast(_borrow.photoUrl ? 'success' : 'warning', toastMsg);

    setTimeout(() => _resetBorrow(), 1500);
  }

  // ==========================================================================
  // RETURN FLOW — 3 steps
  // ==========================================================================

  function _resetReturn() {
    _return.step = 1; _return.item = null; _return.loan = null;
    _return.photoUrl = null; _return.clientRefId = null;
    _renderReturnStep();
  }

  function _renderReturnStep() {
    const root = document.getElementById('borrow-flow-content');
    if (!root) return;

    const steps = ['สแกนสินค้า','ถ่ายรูป','ยืนยันคืน'];
    const stepIndicator = steps.map((s, i) => {
      const n = i + 1;
      const active = n === _return.step ? 'fw-bold text-stock-accent' : 'text-muted';
      const done   = n < _return.step;
      return `<span class="small ${active}" style="min-width:40px; text-align:center;">
        <span class="${done ? 'text-success' : ''}">${done ? '✓' : n}</span>
        <span class="d-none d-sm-inline"> ${_esc(s)}</span>
      </span>`;
    }).join('<span class="text-muted mx-1">›</span>');

    root.innerHTML = `<div class="d-flex align-items-center flex-wrap gap-1 mb-3">${stepIndicator}</div>
      <div id="return-step-body"></div>`;

    const body = document.getElementById('return-step-body');
    if (!body) return;

    if (_return.step === 1) _renderReturnStep1(body);
    else if (_return.step === 2) _renderReturnStep2(body);
    else if (_return.step === 3) _renderReturnStep3(body);
  }

  function _renderReturnStep1(body) {
    body.innerHTML = `
      <div class="card p-3">
        <h6 class="mb-2">ขั้นที่ 1: สแกนหรือพิมพ์ SKU สินค้าที่ต้องการคืน</h6>
        <div class="d-flex gap-2 mb-2">
          <input type="text" id="return-sku-input" class="form-control flex-grow-1"
                 placeholder="SKU / Barcode" autocomplete="off"
                 style="min-height:48px; font-size:1.05rem;">
          ${(window.AppScanner && window.AppScanner.cameraAvailable)
            ? `<button type="button" id="return-scan-item-btn" class="btn btn-outline-secondary"
                       style="min-width:56px;min-height:48px;" aria-label="สแกนด้วยกล้อง">
                 <i class="bi bi-camera"></i></button>`
            : ''}
        </div>
        <button type="button" id="return-step1-btn" class="btn btn-stock-primary w-100"
                style="min-height:48px;">ค้นหารายการยืม →</button>
        <div id="return-loan-result" class="mt-2"></div>
      </div>`;

    document.getElementById('return-scan-item-btn')?.addEventListener('click', () => {
      _openBorrowScanModal('สแกนสินค้าที่จะคืน', (text) => {
        const input = document.getElementById('return-sku-input');
        if (input) input.value = text;
        document.getElementById('return-step1-btn')?.click();
      });
    });

    document.getElementById('return-step1-btn')?.addEventListener('click', async () => {
      const sku = (document.getElementById('return-sku-input')?.value || '').trim();
      if (!sku) { _toast('warning', 'กรุณาระบุ SKU หรือ Barcode'); return; }

      const itemRes = await window.AppInventory.searchByBarcode(sku);
      if (itemRes.error || !itemRes.data) {
        document.getElementById('return-loan-result').innerHTML =
          `<div class="alert alert-warning small">ไม่พบสินค้า — ลองใหม่</div>`;
        return;
      }

      _return.item = itemRes.data;

      const loanRes = await window.AppLoans.findOpenLoansForItem(itemRes.data.id);
      if (loanRes.error || !loanRes.data?.length) {
        document.getElementById('return-loan-result').innerHTML = `
          <div class="alert alert-warning small">
            ไม่มีรายการยืมที่ยังค้างอยู่สำหรับสินค้านี้<br>
            <small>ถ้ายืมโดยผู้ใช้อื่น โปรดแจ้ง Admin</small>
          </div>`;
        return;
      }

      const loans = loanRes.data;
      _return.loan = loans[0];  // most recent

      // If multiple loans, show selection (edge case per UX §6)
      if (loans.length > 1) {
        const options = loans.map((l) => {
          const due = l.due_at ? (window.AppLoans ? window.AppLoans.formatThaiDate(l.due_at) : l.due_at) : '—';
          const overdue = l.status === 'overdue' ? ' <span class="badge bg-danger">เลยกำหนด</span>' : '';
          return `<div class="form-check border rounded p-2 mb-1">
            <input class="form-check-input" type="radio" name="return-loan-radio"
                   id="loan-radio-${_esc(l.id)}" value="${_esc(l.id)}">
            <label class="form-check-label" for="loan-radio-${_esc(l.id)}">
              ยืมเมื่อ ${window.AppLoans ? window.AppLoans.formatThaiDate(l.borrowed_at) : l.borrowed_at}
              · จำนวน ${l.qty} ชิ้น · ครบ ${due}${overdue}
            </label>
          </div>`;
        }).join('');
        document.getElementById('return-loan-result').innerHTML = `
          <p class="small text-muted">พบรายการยืมหลายรายการ — เลือกรายการที่ต้องการคืน:</p>
          ${options}
          <button type="button" id="return-loan-select" class="btn btn-stock-primary w-100 mt-2"
                  style="min-height:44px;">เลือก →</button>`;

        document.getElementById('return-loan-select')?.addEventListener('click', () => {
          const checked = document.querySelector('input[name="return-loan-radio"]:checked');
          if (!checked) { _toast('warning', 'กรุณาเลือกรายการยืม'); return; }
          _return.loan = loans.find((l) => l.id === checked.value) || loans[0];
          _return.step = 2; _renderReturnStep();
        });
        return;
      }

      _return.step = 2; _renderReturnStep();
    });

    document.getElementById('return-sku-input')?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') document.getElementById('return-step1-btn')?.click();
    });
  }

  function _renderReturnStep2(body) {
    const loan = _return.loan;
    const item = _return.item;
    const due  = loan?.due_at
      ? (window.AppLoans ? window.AppLoans.formatThaiDate(loan.due_at) : loan.due_at)
      : '—';
    const isOverdue = loan?.status === 'overdue';
    const overdueMsg = isOverdue
      ? `<div class="alert alert-danger small mb-2">
           <i class="bi bi-exclamation-triangle-fill me-1"></i>
           เลยกำหนดคืน: ${due} — กรุณาคืนโดยเร็ว
         </div>` : '';

    const photoLabel = _return.photoUrl
      ? `<div class="mb-2"><img src="${_esc(_return.photoUrl)}" class="img-thumbnail"
             style="max-width:100px; height:75px; object-fit:cover;" alt="รูปเมื่อคืน"></div>`
      : '';

    body.innerHTML = `
      <div class="card p-3">
        ${overdueMsg}
        <div class="alert alert-info small py-2 mb-3">
          <strong>${_esc(item?.name || '')} (${_esc(item?.sku || '')})</strong><br>
          จำนวน: ${loan?.qty || 1} ชิ้น · ครบกำหนด: ${_esc(due)}
        </div>
        <h6 class="mb-2">ขั้นที่ 2: ถ่ายรูปอุปกรณ์เมื่อคืน (ไม่บังคับ)</h6>
        ${photoLabel}
        <button type="button" id="return-step2-photo" class="btn btn-outline-secondary mb-2 w-100"
                style="min-height:48px;">
          <i class="bi bi-camera me-1" aria-hidden="true"></i>📷 ถ่าย / เลือกรูป
        </button>
        <div class="d-flex gap-2">
          <button type="button" id="return-step2-next" class="btn btn-stock-primary flex-grow-1"
                  style="min-height:48px;">ถัดไป: ยืนยัน →</button>
          <button type="button" id="return-step2-skip" class="btn btn-link"
                  aria-label="ข้ามการถ่ายรูป"
                  style="min-height:48px;">ข้าม — ไม่มีรูป</button>
        </div>
        <button type="button" class="btn btn-link btn-sm mt-2" id="return-back-1">← แก้ไขสินค้า</button>
      </div>`;

    document.getElementById('return-step2-photo')?.addEventListener('click', () => {
      if (!window.PhotoCaptureModal) { _toast('warning', 'โหลดโมดูลถ่ายรูปไม่สำเร็จ'); return; }
      const loanId = _return.loan?.id || _uuid();
      window.PhotoCaptureModal.open({
        folder:     'thegood-stock/borrow/' + loanId + '/return',
        label:      'ถ่ายรูปอุปกรณ์เมื่อคืน',
        optional:   true,
        entityId:   loanId,
        onUploaded: (url) => { _return.photoUrl = url; _return.step = 3; _renderReturnStep(); },
        onSkipped:  () => { _return.step = 3; _renderReturnStep(); },
        onError:    () => _toast('warning', 'อัปโหลดรูปไม่สำเร็จ — ยังดำเนินการต่อได้'),
      });
    });
    document.getElementById('return-step2-next')?.addEventListener('click', () => { _return.step = 3; _renderReturnStep(); });
    document.getElementById('return-step2-skip')?.addEventListener('click', () => { _return.step = 3; _renderReturnStep(); });
    document.getElementById('return-back-1')?.addEventListener('click', () => { _return.step = 1; _renderReturnStep(); });
  }

  function _renderReturnStep3(body) {
    const loan = _return.loan;
    const item = _return.item;
    const borrowed = loan?.borrowed_at ? (window.AppLoans ? window.AppLoans.formatThaiDate(loan.borrowed_at) : loan.borrowed_at) : '—';
    const due      = loan?.due_at      ? (window.AppLoans ? window.AppLoans.formatThaiDate(loan.due_at)      : loan.due_at)      : '—';
    const isOverdue = loan?.status === 'overdue';

    body.innerHTML = `
      <div class="card p-3">
        <h6 class="mb-3">ยืนยันการคืน</h6>
        <dl class="mb-3">
          <dt class="small text-muted">สินค้า</dt>
          <dd>${_esc(item?.name || '—')} <code class="small">${_esc(item?.sku || '')}</code></dd>
          <dt class="small text-muted">จำนวน</dt><dd>${loan?.qty || 1} ชิ้น</dd>
          <dt class="small text-muted">ยืมเมื่อ</dt><dd>${_esc(borrowed)}</dd>
          <dt class="small text-muted">ครบกำหนด</dt>
          <dd>${_esc(due)} ${isOverdue ? '<span class="badge bg-danger ms-1">เลยกำหนด</span>' : ''}</dd>
          <dt class="small text-muted">รูปถ่าย</dt>
          <dd>${_return.photoUrl
            ? `<img src="${_esc(_return.photoUrl)}" class="img-thumbnail"
                   style="max-width:80px; height:60px; object-fit:cover;" alt="รูปเมื่อคืน">`
            : '<span class="text-muted small">ไม่มีรูป</span>'}</dd>
        </dl>
        <button type="button" id="return-confirm-btn" class="btn btn-stock-primary w-100 mb-2"
                style="min-height:52px; font-weight:600;">ยืนยันการคืน</button>
        <button type="button" id="return-back-2" class="btn btn-outline-secondary w-100"
                style="min-height:44px;">← แก้ไข</button>
      </div>`;

    document.getElementById('return-confirm-btn')?.addEventListener('click', _submitReturn);
    document.getElementById('return-back-2')?.addEventListener('click', () => { _return.step = 2; _renderReturnStep(); });
  }

  async function _submitReturn() {
    const btn = document.getElementById('return-confirm-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก…'; }

    const loan = _return.loan;
    if (!_return.clientRefId) _return.clientRefId = _uuid();

    const r = await window.AppLoans.createReturn({
      itemId:     _return.item.id,
      locationId: loan.locations?.id || loan.location_id_from,
      qty:        loan.qty,
      clientRefId: _return.clientRefId,
    });

    if (r.error) {
      const msg = window.AppLoans.mapTriggerErrorToToast(r.error);
      _toast('error', msg);
      if (btn) { btn.disabled = false; btn.textContent = 'ยืนยันการคืน'; }
      return;
    }

    // PATCH photo if captured
    if (_return.photoUrl && loan?.id) {
      await window.AppLoans.patchLoanPhoto(loan.id, 'return', _return.photoUrl);
    }

    const toastMsg = _return.photoUrl ? 'คืนสำเร็จ ขอบคุณ' : 'คืนสำเร็จ แต่ไม่มีรูปถ่าย';
    _toast(_return.photoUrl ? 'success' : 'warning', toastMsg);
    setTimeout(() => _resetReturn(), 1500);
  }

  // ==========================================================================
  // UUID helper
  // ==========================================================================

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ==========================================================================
  // Init — inject toggle after DOMContentLoaded
  // ==========================================================================

  function _init() {
    // AppLoans may not be loaded yet (lazy). Retry up to 500ms.
    if (!window.AppLoans) {
      let tries = 0;
      const tick = () => {
        if (window.AppLoans || tries++ > 5) { _injectAndBind(); } else setTimeout(tick, 100);
      };
      tick();
    } else {
      _injectAndBind();
    }
  }

  function _injectAndBind() {
    _borrow.dueAt = window.AppLoans ? window.AppLoans.defaultDueAt() : _defaultDue();
    _injectModeToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
