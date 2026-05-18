// js/staff-scan.js
// Phase 1 — Staff Scan page controller.
//
// Design:  docs/superpowers/designs/2026-05-18-phase1-ui-design.md §3 (Area 2)
// Spec:    docs/superpowers/specs/2026-05-18-phase1-inventory-design.md §7.3
// Plan:    docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md Phase E
//
// Locked decisions enforced here:
//   Q-Phase1-F  Dedicated staff-scan.html (we ARE that page)
//   Q-Phase1-G  Staff can do `issue` + `adjustment_loss` only — UI hides the rest
//   Q-Phase1-J  client_ref_id UUID UNIQUE for idempotent retries
//   Q3 (PM)     NO photo upload — even for adjustment_loss in Phase 1
//
// Upstream APIs consumed (read-only; never mutate):
//   window.ensureLoggedIn / getUserName / handleLogout
//   window.AppScanner.{isSupported, hasNativeDetector, startScanning, stopScanning, parseScanResult}
//   window.AppInventory.{issue, adjustmentLoss, searchByBarcode, findLocationByCode, getItem, listItems, _uuid}
//   window.showToast (shared/ui.js)
//
// State machine:
//   IDLE → ITEM_SCANNED → LOCATION_SCANNED → CONFIRMING → SUCCESS → IDLE (auto)
//   plus side states for MANUAL_FILL and the permission gate ("PERMISSION_PROMPT" / "PERMISSION_DENIED").
//
// The state lives entirely on the module-private `state` object below. Every transition
// goes through `setState(next, patch?)` which (a) records the new state, (b) optionally
// merges a patch onto `state.ctx`, and (c) calls `render()` exactly once — the renderer
// is pure-ish: it reads `state` and updates DOM. This keeps "where am I now?" debuggable.

(function () {
  'use strict';

  // =========================================================================
  // Module state (single source of truth)
  // =========================================================================

  /** @typedef {'PERMISSION_PROMPT'|'PERMISSION_DENIED'|'INSECURE'|'UNSUPPORTED'|
   *           'IDLE'|'ITEM_SCANNED'|'LOCATION_SCANNED'|'MANUAL_FILL'|
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
    el.hint.classList.toggle('d-none',
      !['IDLE', 'ITEM_SCANNED', 'LOCATION_SCANNED'].includes(state.name));
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

    // --- Submit row visibility --------------------------------------------
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
    // UX nicety: focus qty input so user can start typing immediately.
    setTimeout(() => { try { el.mQty.focus(); } catch {} }, 50);
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
      setTimeout(() => { try { el.mQty.focus(); } catch {} }, 50);
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
      const fn = ctx.action === 'adjustment_loss'
        ? window.AppInventory.adjustmentLoss
        : window.AppInventory.issue;
      const { data, error } = await fn(
        ctx.item.id, ctx.location.id, ctx.qty, ctx.note || null, ctx.clientRefId
      );

      if (error) {
        const friendly =
          error.friendly
          || (error.code === '42501' ? 'ไม่มีสิทธิ์ดำเนินการนี้ — ติดต่อ Admin' : null)
          || (error.code === 'BAD_QTY' ? 'จำนวนไม่ถูกต้อง' : null)
          || error.message
          || 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง';

        // "ของไม่พอ" comes through as `friendly: 'ของไม่พอ'` from inventory.js _classifyError.
        // Special-case the trigger's "would drive qty negative" message so the toast is
        // user-friendly even if classifyError didn't catch it (e.g. wording change in PG).
        const isShortStock = /ของไม่พอ|negative|insufficient/i.test(friendly + ' ' + (error.message || ''));
        window.showToast('error', isShortStock ? 'ของไม่พอที่จุดนี้' : friendly);

        // Stay on the same step with qty preserved so user can adjust and retry.
        // We keep clientRefId so the retry is idempotent.
        setState('LOCATION_SCANNED');
        return;
      }

      // Replay-as-success: log it but don't reveal the duplicate to the user.
      if (data && data.replay) {
        console.warn('[staff-scan] idempotent replay accepted; client_ref_id =', data.client_ref_id);
      }

      onSubmitSuccess();
    } catch (e) {
      // Network failure (fetch threw before any HTTP response). Keep qty + refId so a
      // retry will be idempotent.
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
