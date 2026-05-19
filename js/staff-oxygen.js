// js/staff-oxygen.js
// Phase 5 — Staff 7-step oxygen tank scan wizard.
// Page: staff-oxygen.html
//
// Spec refs:
//   docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md §7.2
//   docs/superpowers/designs/2026-05-19-phase5-oxygen-ui-design.md §3.5, §5.2
//   docs/superpowers/plans/2026-05-19-phase5-oxygen-plan.md Task B4
//
// Step sequence:
//   1 — Scan / type serial
//   2 — Tank status card (confirm identity)
//   3 — Choose transition
//   4 — Location select (conditional on transition type)
//   5 — Note (optional)
//   6 — Photo (optional, shared/photo-capture.js)
//   7 — Confirm + submit → success overlay
//
// Dependencies:
//   shared/oxygen.js       → window.AppOxygen
//   shared/scanner.js      → window.AppScanner
//   shared/auth.js         → window.ensureLoggedIn, window.getUserRole, window.getUserName
//   shared/ui.js           → window.showToast, window.escapeHtml
//   shared/supabase-client.js → window.getSupabaseClient
//   shared/photo-capture.js → window.PhotoCaptureModal (Phase 3)

(async function () {
  'use strict';

  // =========================================================================
  // Auth guard
  // =========================================================================
  const ok = await window.ensureLoggedIn();
  if (!ok) return;

  document.getElementById('user-name').textContent = window.getUserName();
  document.getElementById('btn-logout').onclick = () => window.handleLogout();

  // =========================================================================
  // Wizard state
  // =========================================================================
  const state = {
    step:        1,
    serial:      null,   // scanned/typed serial
    tank:        null,   // oxygen_tanks row (from getTankBySerial)
    toStatus:    null,   // chosen transition
    toLocationId: null,  // chosen location (may be null)
    note:        null,
    photoUrl:    null,
    locations:   [],
  };

  // =========================================================================
  // Helpers
  // =========================================================================

  function _esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _toast(type, msg) { (window.showToast || (()=>{}))(type, msg); }

  function _isAdmin() { return window.getUserRole?.() === 'Admin'; }

  function _statusBadge(status) {
    const cls   = window.AppOxygen.STATUS_BADGE_CLASS[status] || 'badge bg-secondary';
    const label = window.AppOxygen.STATUS_LABELS[status] || status;
    return `<span class="${_esc(cls)}">${_esc(label)}</span>`;
  }

  function _fmtDate(val) {
    if (!val) return '—';
    try { return new Date(val).toLocaleDateString('th-TH'); } catch { return String(val); }
  }

  // =========================================================================
  // Step dot sync
  // =========================================================================

  function _syncDots(step) {
    for (let i = 1; i <= 7; i++) {
      const dot = document.getElementById(`dot-${i}`);
      if (!dot) continue;
      dot.className = 'step-dot' +
        (i < step ? ' done' : i === step ? ' active' : '');
    }
  }

  // =========================================================================
  // Root render dispatcher
  // =========================================================================

  function _render() {
    _syncDots(state.step);
    const app = document.getElementById('oxygen-scan-app');
    if (!app) return;
    switch (state.step) {
      case 1: _renderStep1(app); break;
      case 2: _renderStep2(app); break;
      case 3: _renderStep3(app); break;
      case 4: _renderStep4(app); break;
      case 5: _renderStep5(app); break;
      case 6: _renderStep6(app); break;
      case 7: _renderStep7(app); break;
      default: _renderStep1(app);
    }
  }

  function _goStep(n) { state.step = n; _render(); }

  function _resetWizard() {
    state.step        = 1;
    state.serial      = null;
    state.tank        = null;
    state.toStatus    = null;
    state.toLocationId = null;
    state.note        = null;
    state.photoUrl    = null;
    _render();
  }

  // =========================================================================
  // Step 1 — Scan / type serial
  // =========================================================================

  function _renderStep1(app) {
    app.innerHTML = `
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="card-title"><i class="bi bi-upc-scan me-1"></i>ขั้นที่ 1: สแกนหมายเลขถัง</h6>

          <!-- Camera scan area -->
          <div id="oxy-scan-stage" style="position:relative; width:100%; aspect-ratio:4/3;
               max-height:42vh; background:#000; border-radius:12px; overflow:hidden;"
               role="img" aria-label="กล้องสแกนบาร์โค้ด">
            <video id="oxy-scan-video" playsinline muted
                   aria-label="ภาพจากกล้องสำหรับสแกนบาร์โค้ด"
                   style="width:100%;height:100%;object-fit:cover;display:block;"></video>
            <div style="position:absolute;inset:0;pointer-events:none;
                        box-shadow:0 0 0 9999px rgba(0,0,0,.15);">
              <div style="position:absolute;top:15%;left:15%;right:15%;bottom:15%;
                          border:2px solid var(--stock-accent,#0d9488);border-radius:10px;"></div>
            </div>
            <div id="oxy-scan-hint" style="position:absolute;left:0;right:0;bottom:14px;
                 color:#fff;text-align:center;font-size:.9rem;
                 text-shadow:0 1px 4px rgba(0,0,0,.7);">
              วางบาร์โค้ด/QR ให้อยู่กลางกรอบ
            </div>
            <div id="oxy-scan-gate" style="position:absolute;inset:0;background:rgba(0,0,0,.55);
                 display:flex;align-items:center;justify-content:center;">
              <div style="text-align:center;color:#fff;padding:16px;">
                <i class="bi bi-camera" style="font-size:3rem;"></i>
                <div class="mt-2">กดปุ่มด้านล่างเพื่อเปิดกล้อง</div>
                <button type="button" id="oxy-btn-start-scan"
                        class="btn btn-stock-primary mt-3" style="min-height:48px;min-width:200px;">
                  <i class="bi bi-camera me-2"></i>เปิดกล้องสแกน
                </button>
              </div>
            </div>
          </div>

          <!-- Manual fallback -->
          <div class="text-end mt-2">
            <a href="#" id="oxy-link-manual" class="small text-muted">พิมพ์แทน →</a>
          </div>
          <div id="oxy-manual-panel" class="d-none mt-2">
            <div class="input-group">
              <input type="text" id="oxy-manual-serial" class="form-control"
                     placeholder="พิมพ์หมายเลขถัง เช่น OXY-0001"
                     autocomplete="off" inputmode="text" autocapitalize="characters"
                     style="min-height:48px;">
              <button type="button" id="oxy-btn-manual-go"
                      class="btn btn-stock-primary" style="min-height:48px;">ค้นหา</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire scanner
    const video   = document.getElementById('oxy-scan-video');
    const gate    = document.getElementById('oxy-scan-gate');
    const startBtn = document.getElementById('oxy-btn-start-scan');

    startBtn?.addEventListener('click', async () => {
      if (!window.AppScanner) { _toast('error', 'ไม่พบ AppScanner'); return; }
      try {
        await window.AppScanner.startScanning(video, async (code) => {
          await window.AppScanner.stopScanning();
          gate.style.display = 'flex';
          await _lookupSerial(code);
        });
        if (gate) gate.style.display = 'none';
      } catch (e) {
        _toast('error', 'ไม่สามารถเปิดกล้องได้: ' + (e.message || ''));
      }
    });

    // Manual toggle
    document.getElementById('oxy-link-manual')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      const p = document.getElementById('oxy-manual-panel');
      p?.classList.toggle('d-none');
      document.getElementById('oxy-manual-serial')?.focus();
    });

    document.getElementById('oxy-btn-manual-go')?.addEventListener('click', async () => {
      const serial = document.getElementById('oxy-manual-serial')?.value.trim();
      if (!serial) { _toast('warning', 'กรุณาพิมพ์หมายเลขถัง'); return; }
      await _lookupSerial(serial);
    });

    document.getElementById('oxy-manual-serial')?.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Enter') {
        const serial = ev.target.value.trim();
        if (serial) await _lookupSerial(serial);
      }
    });
  }

  async function _lookupSerial(serial) {
    const app = document.getElementById('oxygen-scan-app');
    if (app) app.innerHTML = `
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2"></span>ค้นหาถัง ${_esc(serial)}…
      </div>
    `;

    const { data: tank, error } = await window.AppOxygen.getTankBySerial(serial);
    if (error) {
      _toast('error', 'ค้นหาไม่สำเร็จ: ' + error.message);
      _render();
      return;
    }
    if (!tank) {
      _toast('error', 'ไม่พบถังหมายเลขนี้ในระบบ');
      _render();
      return;
    }
    state.serial = tank.serial;
    state.tank   = tank;
    _goStep(2);
  }

  // =========================================================================
  // Step 2 — Tank status card
  // =========================================================================

  function _renderStep2(app) {
    const t = state.tank;
    app.innerHTML = `
      <div class="oxy-tank-card mb-3">
        <div class="d-flex align-items-center gap-2 mb-2">
          <h6 class="mb-0"><code>${_esc(t.serial)}</code></h6>
          ${_statusBadge(t.status)}
        </div>
        <div class="small text-muted mb-1">
          <i class="bi bi-box me-1"></i>ขนาด: ${_esc(window.AppOxygen.SIZE_LABELS[t.tank_size] || t.tank_size)}
        </div>
        <div class="small text-muted mb-1">
          <i class="bi bi-geo-alt me-1"></i>สถานที่: ${_esc(t.locations?.name || '—')}
        </div>
        <div class="small text-muted">
          <i class="bi bi-arrow-repeat me-1"></i>เติมล่าสุด: ${_esc(_fmtDate(t.last_refill_at))}
        </div>
      </div>

      ${t.status === 'retired' ? `
        <div class="alert alert-danger" role="alert">
          <i class="bi bi-x-octagon-fill me-1"></i>
          ถังนี้ถูกปลดระวางแล้ว ไม่สามารถดำเนินการได้
        </div>
        <button type="button" id="oxy-step2-back" class="btn btn-outline-secondary w-100"
                style="min-height:48px;">
          <i class="bi bi-arrow-left me-1"></i>สแกนถังใหม่
        </button>
      ` : `
        <button type="button" id="oxy-step2-next" class="btn btn-stock-primary w-100"
                style="min-height:52px; font-size:1.05rem; font-weight:600;">
          ดำเนินการต่อ →
        </button>
        <div class="text-center mt-2">
          <button type="button" id="oxy-step2-back" class="btn btn-link btn-sm text-muted">
            สแกนถังอื่น
          </button>
        </div>
      `}
    `;

    document.getElementById('oxy-step2-next')?.addEventListener('click', () => _goStep(3));
    document.getElementById('oxy-step2-back')?.addEventListener('click', _resetWizard);
  }

  // =========================================================================
  // Step 3 — Choose transition
  // =========================================================================

  function _renderStep3(app) {
    const currentStatus = state.tank.status;
    const allowed = window.AppOxygen.getAllowedTransitions(currentStatus, _isAdmin());

    if (!allowed.length) {
      app.innerHTML = `
        <div class="alert alert-warning" role="alert">
          ไม่มีสถานะที่สามารถเปลี่ยนได้จากสถานะนี้
        </div>
        <button type="button" class="btn btn-outline-secondary w-100" id="oxy-step3-back"
                style="min-height:48px;">กลับ</button>
      `;
      document.getElementById('oxy-step3-back')?.addEventListener('click', () => _goStep(2));
      return;
    }

    const cards = allowed.map((toStatus) => {
      const label = window.AppOxygen.STATUS_LABELS[toStatus] || toStatus;
      const badge = _statusBadge(toStatus);
      return `
        <div class="oxy-choice-card" data-to-status="${_esc(toStatus)}"
             role="button" tabindex="0"
             aria-label="เปลี่ยนเป็น ${_esc(label)}">
          ${badge}
          <span class="choice-label">${_esc(label)}</span>
        </div>
      `;
    }).join('');

    app.innerHTML = `
      <div class="mb-2 small text-muted">
        สถานะปัจจุบัน: ${_statusBadge(currentStatus)}
        &nbsp;→&nbsp; เลือกสถานะใหม่:
      </div>
      ${cards}
      <div class="text-center mt-2">
        <button type="button" id="oxy-step3-back" class="btn btn-link btn-sm text-muted">
          <i class="bi bi-arrow-left me-1"></i>กลับ
        </button>
      </div>
    `;

    app.querySelectorAll('.oxy-choice-card').forEach((card) => {
      const activate = () => {
        state.toStatus = card.dataset.toStatus;
        // Step 4 needed when transition changes location context
        const needsLoc = ['on_board', 'ready', 'maintenance'].includes(state.toStatus);
        _goStep(needsLoc ? 4 : 5);
      };
      card.addEventListener('click', activate);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') activate(); });
    });

    document.getElementById('oxy-step3-back')?.addEventListener('click', () => _goStep(2));
  }

  // =========================================================================
  // Step 4 — Location select (conditional)
  // =========================================================================

  async function _renderStep4(app) {
    app.innerHTML = `
      <div class="text-center text-muted py-4">
        <span class="spinner-border spinner-border-sm me-2"></span>โหลดสถานที่…
      </div>
    `;

    // Load locations if not yet cached
    if (!state.locations.length) {
      try {
        const sb = window.getSupabaseClient();
        const { data } = await sb.from('locations')
          .select('id, name, code, type').eq('active', true).order('type').order('name');
        state.locations = data || [];
      } catch { state.locations = []; }
    }

    const opts = state.locations.map((loc) => `
      <option value="${_esc(loc.id)}">${_esc(loc.name)} (${_esc(loc.code)})</option>
    `).join('');

    const toLabel = window.AppOxygen.STATUS_LABELS[state.toStatus] || state.toStatus;
    app.innerHTML = `
      <div class="mb-2 small text-muted">
        กำลังเปลี่ยนเป็น: ${_statusBadge(state.toStatus)}
      </div>
      <div class="card mb-3">
        <div class="card-body">
          <label class="form-label" for="oxy-loc-select">
            สถานที่ (ไม่บังคับ — เว้นว่างเพื่อคงสถานที่เดิม)
          </label>
          <select id="oxy-loc-select" class="form-select" style="min-height:48px;">
            <option value="">— คงสถานที่เดิม —</option>
            ${opts}
          </select>
        </div>
      </div>
      <button type="button" id="oxy-step4-next" class="btn btn-stock-primary w-100"
              style="min-height:52px; font-size:1.05rem; font-weight:600;">
        ถัดไป →
      </button>
      <div class="text-center mt-2">
        <button type="button" id="oxy-step4-back" class="btn btn-link btn-sm text-muted">
          <i class="bi bi-arrow-left me-1"></i>กลับ
        </button>
      </div>
    `;

    document.getElementById('oxy-step4-next')?.addEventListener('click', () => {
      state.toLocationId = document.getElementById('oxy-loc-select')?.value || null;
      _goStep(5);
    });
    document.getElementById('oxy-step4-back')?.addEventListener('click', () => _goStep(3));
  }

  // =========================================================================
  // Step 5 — Note (optional)
  // =========================================================================

  function _renderStep5(app) {
    app.innerHTML = `
      <div class="card mb-3">
        <div class="card-body">
          <label class="form-label" for="oxy-note-input">
            บันทึก / เหตุผล <span class="text-muted small">(ไม่บังคับ)</span>
          </label>
          <textarea id="oxy-note-input" class="form-control" rows="3"
                    maxlength="500" placeholder="เช่น ถังหมดระหว่างรับส่งผู้ป่วย"
                    style="min-height:80px;"></textarea>
        </div>
      </div>
      <button type="button" id="oxy-step5-next" class="btn btn-stock-primary w-100"
              style="min-height:52px; font-size:1.05rem; font-weight:600;">
        ถัดไป →
      </button>
      <div class="text-center mt-2">
        <button type="button" id="oxy-step5-back" class="btn btn-link btn-sm text-muted">
          <i class="bi bi-arrow-left me-1"></i>กลับ
        </button>
      </div>
    `;

    // Pre-fill if returning to step
    if (state.note) {
      const ta = document.getElementById('oxy-note-input');
      if (ta) ta.value = state.note;
    }

    document.getElementById('oxy-step5-next')?.addEventListener('click', () => {
      state.note = document.getElementById('oxy-note-input')?.value.trim() || null;
      _goStep(6);
    });
    document.getElementById('oxy-step5-back')?.addEventListener('click', () => {
      const needsLoc = ['on_board', 'ready', 'maintenance'].includes(state.toStatus);
      _goStep(needsLoc ? 4 : 3);
    });
  }

  // =========================================================================
  // Step 6 — Photo (optional)
  // =========================================================================

  function _renderStep6(app) {
    const hasCapture = !!window.PhotoCaptureModal;

    app.innerHTML = `
      <div class="card mb-3">
        <div class="card-body text-center py-4">
          ${hasCapture ? `
            <i class="bi bi-camera" style="font-size:3rem; color:var(--stock-accent,#0d9488);"></i>
            <p class="mt-2 text-muted small">ถ่ายรูปถังเพื่อเป็นหลักฐาน (ไม่บังคับ)</p>
            <div id="oxy-step6-preview" class="mb-2">
              ${state.photoUrl
                ? `<img src="${_esc(state.photoUrl)}" class="oxy-photo-preview" alt="รูปถ่าย">`
                : '<span class="text-muted small">— ยังไม่มีรูป —</span>'}
            </div>
            <button type="button" id="oxy-step6-photo-btn"
                    class="btn btn-outline-stock-accent" style="min-height:48px;">
              <i class="bi bi-camera-fill me-1"></i>ถ่ายรูป / เลือกรูป
            </button>
          ` : `
            <i class="bi bi-camera-video-off" style="font-size:2rem; opacity:.4;"></i>
            <p class="mt-2 text-muted small">ยังไม่รองรับการอัปโหลดรูป (Phase 3 pending)</p>
          `}
        </div>
      </div>
      <button type="button" id="oxy-step6-next" class="btn btn-stock-primary w-100"
              style="min-height:52px; font-size:1.05rem; font-weight:600;">
        ถัดไป →
      </button>
      <div class="text-center mt-2">
        <button type="button" id="oxy-step6-skip" class="btn btn-link btn-sm text-muted">
          ข้ามการถ่ายรูป
        </button>
        <button type="button" id="oxy-step6-back" class="btn btn-link btn-sm text-muted ms-3">
          <i class="bi bi-arrow-left me-1"></i>กลับ
        </button>
      </div>
    `;

    if (hasCapture) {
      document.getElementById('oxy-step6-photo-btn')?.addEventListener('click', () => {
        window.PhotoCaptureModal.open({
          folder:    `thegood-stock/oxygen/${state.tank.serial}`,
          label:     `ถ่ายรูปถัง ${state.tank.serial}`,
          optional:  true,
          onUploaded: (url) => {
            state.photoUrl = url;
            const preview = document.getElementById('oxy-step6-preview');
            if (preview) {
              preview.innerHTML = `<img src="${_esc(url)}" class="oxy-photo-preview" alt="รูปถ่าย">`;
            }
          },
          onSkipped: () => { state.photoUrl = null; },
          onError:   (msg) => { _toast('error', 'อัปโหลดรูปไม่สำเร็จ: ' + msg); },
        });
      });
    }

    document.getElementById('oxy-step6-next')?.addEventListener('click', () => _goStep(7));
    document.getElementById('oxy-step6-skip')?.addEventListener('click', () => {
      state.photoUrl = null;
      _goStep(7);
    });
    document.getElementById('oxy-step6-back')?.addEventListener('click', () => _goStep(5));
  }

  // =========================================================================
  // Step 7 — Confirm and submit
  // =========================================================================

  function _renderStep7(app) {
    const fromLabel = window.AppOxygen.STATUS_LABELS[state.tank.status] || state.tank.status;
    const toLabel   = window.AppOxygen.STATUS_LABELS[state.toStatus]    || state.toStatus;

    const locName = state.toLocationId
      ? (state.locations.find((l) => l.id === state.toLocationId)?.name || state.toLocationId)
      : '(คงสถานที่เดิม)';

    app.innerHTML = `
      <div class="card mb-3">
        <div class="card-header fw-semibold">สรุปการเปลี่ยนแปลง</div>
        <div class="card-body">
          <table class="table table-sm mb-0">
            <tbody>
              <tr>
                <td class="text-muted small w-40">ถัง</td>
                <td><strong><code>${_esc(state.tank.serial)}</code></strong></td>
              </tr>
              <tr>
                <td class="text-muted small">การเปลี่ยนแปลง</td>
                <td>${_statusBadge(state.tank.status)} → ${_statusBadge(state.toStatus)}</td>
              </tr>
              <tr>
                <td class="text-muted small">สถานที่</td>
                <td class="small">${_esc(locName)}</td>
              </tr>
              ${state.note ? `
              <tr>
                <td class="text-muted small">หมายเหตุ</td>
                <td class="small">${_esc(state.note)}</td>
              </tr>` : ''}
              ${state.photoUrl ? `
              <tr>
                <td class="text-muted small">รูปถ่าย</td>
                <td>
                  <img src="${_esc(state.photoUrl)}" class="oxy-photo-preview" alt="รูปถ่าย">
                </td>
              </tr>` : ''}
            </tbody>
          </table>
        </div>
      </div>
      <div id="oxy-step7-error" class="alert alert-danger d-none" role="alert"></div>
      <button type="button" id="oxy-step7-submit" class="btn btn-stock-primary w-100"
              style="min-height:56px; font-size:1.1rem; font-weight:700;">
        <i class="bi bi-check2-circle me-1"></i>ยืนยัน
      </button>
      <div class="text-center mt-2">
        <button type="button" id="oxy-step7-back" class="btn btn-link btn-sm text-muted">
          <i class="bi bi-arrow-left me-1"></i>กลับแก้ไข
        </button>
      </div>
    `;

    document.getElementById('oxy-step7-submit')?.addEventListener('click', _submitTransition);
    document.getElementById('oxy-step7-back')?.addEventListener('click', () => _goStep(6));
  }

  async function _submitTransition() {
    const submitBtn = document.getElementById('oxy-step7-submit');
    const errEl     = document.getElementById('oxy-step7-error');

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก…';
    }
    if (errEl) errEl.classList.add('d-none');

    try {
      await window.AppOxygen.logTransition({
        tankId:      state.tank.id,
        fromStatus:  state.tank.status,
        toStatus:    state.toStatus,
        toLocationId: state.toLocationId,
        note:        state.note,
        photoUrl:    state.photoUrl,
      });

      // Show success overlay
      const newStatusLabel = window.AppOxygen.STATUS_LABELS[state.toStatus] || state.toStatus;
      const app = document.getElementById('oxygen-scan-app');
      // Sync dots to completed
      _syncDots(8);
      app.innerHTML = `
        <div class="oxy-success-overlay">
          <div class="ok-icon"><i class="bi bi-check-circle-fill"></i></div>
          <div class="ok-main">บันทึกสำเร็จ</div>
          <div class="ok-detail">
            ถัง <strong>${_esc(state.tank.serial)}</strong>
            เปลี่ยนเป็น ${_esc(newStatusLabel)} แล้ว
          </div>
        </div>
        <div class="text-center mt-4">
          <button type="button" id="oxy-btn-next-tank" class="btn btn-outline-stock-accent w-100"
                  style="min-height:52px; font-size:1.05rem;">
            <i class="bi bi-upc-scan me-1"></i>สแกนถังถัดไป
          </button>
        </div>
      `;

      document.getElementById('oxy-btn-next-tank')?.addEventListener('click', _resetWizard);

    } catch (e) {
      const msg = e.message || 'บันทึกไม่สำเร็จ';
      let friendly = msg;
      if (msg.includes(window.AppOxygen.STATE_MACHINE_ERROR) || msg.includes('การเปลี่ยนสถานะนี้ไม่อนุญาต')) {
        friendly = 'การเปลี่ยนสถานะนี้ไม่อนุญาต กรุณาลองใหม่';
      } else if (msg.includes('ปลดระวาง')) {
        friendly = 'ถังนี้ถูกปลดระวางแล้ว ไม่สามารถใช้งานได้';
      } else if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
        friendly = 'ไม่สามารถเชื่อมต่อ กรุณาลองใหม่';
      }
      if (errEl) { errEl.textContent = friendly; errEl.classList.remove('d-none'); }
      _toast('error', friendly);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="bi bi-check2-circle me-1"></i>ยืนยัน';
      }
    }
  }

  // =========================================================================
  // Boot
  // =========================================================================
  try { await window.loadSettings(); } catch {}
  _render();

})();
