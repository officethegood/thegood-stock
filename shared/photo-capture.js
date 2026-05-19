// shared/photo-capture.js
// Phase 3 — Reusable photo capture modal component.
// Phase 5 (oxygen tanks) and Phase 6+ will reuse this component.
//
// Spec refs:
//   docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md §7 (§7.1–§7.5)
//   docs/superpowers/specs/2026-05-19-phase3-decisions-locked.md Q-Phase3-C (photo = advisory)
//
// Component contract (UX §7.2 — exact, do NOT change parameter names):
//   PhotoCaptureModal.open({
//     // REQUIRED
//     folder:     string,   // Cloudinary subfolder path; NO trailing slash
//     label:      string,   // Modal header + camera hint text (Thai string from caller)
//
//     // OPTIONAL
//     optional:   boolean,  // default: true. If false, skip button is hidden.
//     entityId:   string,   // public_id suffix in Cloudinary; UUID generated if omitted
//     maxSizeMB:  number,   // default: 5. Client-side warning if file exceeds.
//
//     // CALLBACKS (all optional)
//     onUploaded: function(url),   // called with Cloudinary secure_url on success
//     onSkipped:  function(),      // called when user taps skip
//     onError:    function(msg),   // called with error string if upload fails
//                                  // component stays open; caller decides retry or skip
//   })
//
// Accessibility per UX §7.4:
//   - <video> aria-label="ภาพจากกล้องเพื่อถ่ายรูป"
//   - Skip button aria-label="ข้ามการถ่ายรูป"
//   - Camera button aria-label="ถ่ายรูป"
//   - progressbar role with aria-valuenow updated on each tick
//   - Camera unavailable: graceful fallback to file-upload-only UI
//
// Requires (loaded before this script):
//   shared/cloudinary.js — window.uploadToCloudinary(file, subfolder)
//   Bootstrap 5 CSS + JS (modal component)
//
// Public namespace: window.PhotoCaptureModal

(function () {
  'use strict';

  // ==========================================================================
  // Internal state (one modal instance at a time)
  // ==========================================================================

  let _cfg       = null;   // current open() config
  let _stream    = null;   // active MediaStream (camera)
  let _capturedFile = null; // File object from camera snapshot or file input
  let _capturedBlob = null; // Blob for canvas capture
  let _modalEl   = null;   // Bootstrap modal DOM element
  let _bsModal   = null;   // Bootstrap modal instance

  // Internal states: 'initial' | 'camera' | 'captured' | 'uploading' | 'error'
  let _internalState = 'initial';

  // ==========================================================================
  // Helper: generate UUID (used as entityId fallback)
  // ==========================================================================

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ==========================================================================
  // DOM builders
  // ==========================================================================

  function _ensureModal() {
    let existing = document.getElementById('photo-capture-modal');
    if (existing) return existing;

    const el = document.createElement('div');
    el.id = 'photo-capture-modal';
    el.className = 'modal fade';
    el.setAttribute('tabindex', '-1');
    el.setAttribute('aria-labelledby', 'photo-capture-modal-label');
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="photo-capture-modal-label">ถ่ายรูป</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"
                    aria-label="ปิด"></button>
          </div>
          <div class="modal-body p-3" id="photo-capture-body"></div>
          <div class="modal-footer flex-column align-items-stretch gap-2 p-3"
               id="photo-capture-footer"></div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    return el;
  }

  // ==========================================================================
  // State renderers
  // ==========================================================================

  function _renderInitial() {
    _internalState = 'initial';
    const body   = document.getElementById('photo-capture-body');
    const footer = document.getElementById('photo-capture-footer');
    if (!body || !footer) return;

    body.innerHTML = `
      <div class="text-center py-3">
        <div class="mb-3 text-muted" style="font-size:3rem;">
          <i class="bi bi-camera" aria-hidden="true"></i>
        </div>
        <p class="text-muted small mb-3">${_esc(_cfg.label || 'ถ่ายรูปอุปกรณ์')}</p>
        <div class="d-flex gap-2 justify-content-center flex-wrap">
          <button type="button" class="btn btn-outline-secondary"
                  id="pcm-btn-open-camera"
                  style="min-height:48px;">
            <i class="bi bi-camera-fill me-1" aria-hidden="true"></i>📷 เปิดกล้องถ่ายรูป
          </button>
          <label class="btn btn-outline-secondary mb-0"
                 style="min-height:48px; cursor:pointer;">
            <i class="bi bi-folder2-open me-1" aria-hidden="true"></i>📁 เลือกรูปจากคลัง
            <input type="file" id="pcm-file-input"
                   accept="image/*" capture="environment"
                   aria-label="เลือกรูปจากคลัง"
                   style="opacity:0; position:absolute; width:1px; height:1px; overflow:hidden;">
          </label>
        </div>
        <div id="pcm-camera-unavailable" class="alert alert-warning mt-3 d-none small" role="alert">
          กล้องไม่พร้อมใช้งาน — เลือกรูปจากคลังแทน
        </div>
      </div>
    `;

    footer.innerHTML = _cfg.optional !== false
      ? `<button type="button" class="btn btn-link text-muted"
                 id="pcm-btn-skip" aria-label="ข้ามการถ่ายรูป"
                 style="min-height:44px;">ข้าม — ไม่มีรูป</button>`
      : '';

    document.getElementById('pcm-btn-open-camera')?.addEventListener('click', _startCamera);
    document.getElementById('pcm-file-input')?.addEventListener('change', _onFileSelect);
    document.getElementById('pcm-btn-skip')?.addEventListener('click', _onSkip);
  }

  function _renderCamera(stream) {
    _internalState = 'camera';
    const body   = document.getElementById('photo-capture-body');
    const footer = document.getElementById('photo-capture-footer');
    if (!body || !footer) return;

    body.innerHTML = `
      <div style="position:relative;">
        <video id="pcm-video"
               autoplay playsinline muted
               aria-label="ภาพจากกล้องเพื่อถ่ายรูป"
               style="width:100%; aspect-ratio:4/3; max-height:240px;
                      object-fit:cover; border-radius:8px; background:#000;">
        </video>
        <canvas id="pcm-canvas" style="display:none;"></canvas>
      </div>
    `;

    footer.innerHTML = `
      <div class="d-flex justify-content-center mb-1">
        <button type="button" class="btn btn-stock-primary rounded-circle"
                id="pcm-btn-shutter"
                aria-label="ถ่ายรูป"
                style="width:64px; height:64px; font-size:1.5rem;">
          <i class="bi bi-camera-fill" aria-hidden="true"></i>
        </button>
      </div>
      ${_cfg.optional !== false
        ? `<button type="button" class="btn btn-link text-muted"
                   id="pcm-btn-skip" aria-label="ข้ามการถ่ายรูป"
                   style="min-height:44px;">ข้าม — ไม่มีรูป</button>`
        : ''}
    `;

    const video = document.getElementById('pcm-video');
    if (video && stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

    document.getElementById('pcm-btn-shutter')?.addEventListener('click', _captureFromCamera);
    document.getElementById('pcm-btn-skip')?.addEventListener('click', _onSkip);
  }

  function _renderCaptured(objectUrl) {
    _internalState = 'captured';
    const body   = document.getElementById('photo-capture-body');
    const footer = document.getElementById('photo-capture-footer');
    if (!body || !footer) return;

    body.innerHTML = `
      <div class="text-center">
        <img src="${_esc(objectUrl)}" alt="รูปถ่ายที่จับได้"
             style="max-width:120px; height:90px; object-fit:cover;
                    border-radius:6px; border:1px solid #dee2e6;">
      </div>
    `;

    footer.innerHTML = `
      <button type="button" class="btn btn-stock-primary"
              id="pcm-btn-use" style="min-height:48px;">ใช้รูปนี้</button>
      <button type="button" class="btn btn-outline-secondary"
              id="pcm-btn-retake" style="min-height:44px;">ถ่ายใหม่</button>
      ${_cfg.optional !== false
        ? `<button type="button" class="btn btn-link text-muted"
                   id="pcm-btn-skip" aria-label="ข้ามการถ่ายรูป"
                   style="min-height:44px;">ข้าม — ไม่มีรูป</button>`
        : ''}
    `;

    document.getElementById('pcm-btn-use')?.addEventListener('click', _startUpload);
    document.getElementById('pcm-btn-retake')?.addEventListener('click', () => {
      _stopCamera();
      _renderInitial();
    });
    document.getElementById('pcm-btn-skip')?.addEventListener('click', _onSkip);
  }

  function _renderUploading(objectUrl) {
    _internalState = 'uploading';
    const body   = document.getElementById('photo-capture-body');
    const footer = document.getElementById('photo-capture-footer');
    if (!body || !footer) return;

    body.innerHTML = `
      <div class="text-center">
        <img src="${_esc(objectUrl)}" alt="รูปถ่ายที่กำลังอัปโหลด"
             style="max-width:120px; height:90px; object-fit:cover;
                    border-radius:6px; border:1px solid #dee2e6;">
        <div class="mt-2">
          <div class="progress" style="height:8px;"
               role="progressbar"
               aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"
               aria-label="กำลังอัปโหลดรูปถ่าย">
            <div id="pcm-progress-bar" class="progress-bar bg-stock-accent progress-bar-striped progress-bar-animated"
                 style="width:10%"></div>
          </div>
          <small class="text-muted mt-1 d-block" id="pcm-progress-text">อัปโหลดรูปถ่าย…</small>
        </div>
      </div>
    `;

    footer.innerHTML = `
      <button type="button" class="btn btn-stock-primary" disabled
              style="min-height:48px;">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
        กำลังอัปโหลด…
      </button>
    `;

    // Animate progress (indeterminate — Cloudinary doesn't give progress events via fetch)
    let pct = 10;
    const prog = document.getElementById('pcm-progress-bar');
    const progTick = setInterval(() => {
      if (!prog) { clearInterval(progTick); return; }
      pct = Math.min(90, pct + Math.random() * 8);
      prog.style.width = pct + '%';
      prog.setAttribute('aria-valuenow', Math.round(pct));
      const txt = document.getElementById('pcm-progress-text');
      if (txt) txt.textContent = `อัปโหลดรูปถ่าย… ${Math.round(pct)}%`;
    }, 300);
    // Store cleanup reference on modal element
    if (_modalEl) _modalEl._progressTimer = progTick;
  }

  function _renderError(objectUrl, msg) {
    _internalState = 'error';
    const body   = document.getElementById('photo-capture-body');
    const footer = document.getElementById('photo-capture-footer');
    if (!body || !footer) return;

    body.innerHTML = `
      <div class="text-center">
        <img src="${_esc(objectUrl)}" alt="รูปถ่าย"
             style="max-width:120px; height:90px; object-fit:cover;
                    border-radius:6px; border:1px solid #dee2e6;">
        <div class="alert alert-danger mt-2 small" role="alert">
          <i class="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>
          อัปโหลดรูปไม่สำเร็จ: ${_esc(msg)}
        </div>
      </div>
    `;

    footer.innerHTML = `
      <button type="button" class="btn btn-stock-primary"
              id="pcm-btn-retry" style="min-height:48px;">ลองอีกครั้ง</button>
      <button type="button" class="btn btn-outline-secondary"
              id="pcm-btn-proceed-noimg"
              style="min-height:44px;">ดำเนินการต่อโดยไม่มีรูป</button>
    `;

    document.getElementById('pcm-btn-retry')?.addEventListener('click', _startUpload);
    document.getElementById('pcm-btn-proceed-noimg')?.addEventListener('click', _onSkip);

    if (typeof _cfg.onError === 'function') _cfg.onError(msg);
  }

  // ==========================================================================
  // Camera helpers
  // ==========================================================================

  async function _startCamera() {
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      _renderCamera(_stream);
    } catch (e) {
      // Camera unavailable — show file-upload fallback hint
      const unavail = document.getElementById('pcm-camera-unavailable');
      const openBtn = document.getElementById('pcm-btn-open-camera');
      if (unavail) unavail.classList.remove('d-none');
      if (openBtn) openBtn.disabled = true;
    }
  }

  function _stopCamera() {
    if (_stream) {
      _stream.getTracks().forEach((t) => t.stop());
      _stream = null;
    }
    // Stop any lingering progress animation
    if (_modalEl && _modalEl._progressTimer) {
      clearInterval(_modalEl._progressTimer);
      _modalEl._progressTimer = null;
    }
  }

  function _captureFromCamera() {
    const video  = document.getElementById('pcm-video');
    const canvas = document.getElementById('pcm-canvas');
    if (!video || !canvas) return;

    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    _stopCamera();

    canvas.toBlob((blob) => {
      if (!blob) return;
      _capturedBlob = blob;
      _capturedFile = new File([blob], 'capture.jpg', { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      _renderCaptured(url);

      // Warn if size exceeds maxSizeMB (default 5)
      const maxBytes = (_cfg.maxSizeMB || 5) * 1024 * 1024;
      if (blob.size > maxBytes) {
        _showSizeWarning();
      }
    }, 'image/jpeg', 0.85);
  }

  function _onFileSelect(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    _capturedFile = file;
    _capturedBlob = null;
    const url = URL.createObjectURL(file);
    _renderCaptured(url);

    const maxBytes = (_cfg.maxSizeMB || 5) * 1024 * 1024;
    if (file.size > maxBytes) {
      _showSizeWarning();
    }
  }

  function _showSizeWarning() {
    const body = document.getElementById('photo-capture-body');
    if (!body) return;
    const existing = body.querySelector('.pcm-size-warning');
    if (existing) return;
    const warn = document.createElement('div');
    warn.className = 'alert alert-warning small mt-2 pcm-size-warning';
    warn.setAttribute('role', 'alert');
    warn.textContent = 'รูปถ่ายใหญ่มาก — อาจใช้เวลานานในการอัปโหลด';
    body.appendChild(warn);
  }

  // ==========================================================================
  // Upload
  // ==========================================================================

  async function _startUpload() {
    if (!_capturedFile) return;

    const file      = _capturedFile;
    const objectUrl = URL.createObjectURL(file);
    const entityId  = _cfg.entityId || _uuid();
    // subfolder is the folder prop (NO trailing slash), entityId appended as filename
    const subfolder = _cfg.folder + '/' + entityId;

    _renderUploading(objectUrl);

    try {
      const url = await window.uploadToCloudinary(file, subfolder);

      // Stop progress animation
      if (_modalEl && _modalEl._progressTimer) {
        clearInterval(_modalEl._progressTimer);
        _modalEl._progressTimer = null;
      }

      // Success: fill bar to 100%, pause, then close
      const prog = document.getElementById('pcm-progress-bar');
      if (prog) {
        prog.style.width = '100%';
        prog.setAttribute('aria-valuenow', '100');
        prog.classList.remove('progress-bar-animated');
      }

      await new Promise((r) => setTimeout(r, 500));

      _closeModal();

      if (typeof _cfg.onUploaded === 'function') _cfg.onUploaded(url);

    } catch (e) {
      if (_modalEl && _modalEl._progressTimer) {
        clearInterval(_modalEl._progressTimer);
        _modalEl._progressTimer = null;
      }
      _renderError(objectUrl, e && e.message ? e.message : String(e));
    }
  }

  // ==========================================================================
  // Skip
  // ==========================================================================

  function _onSkip() {
    _closeModal();
    if (typeof _cfg.onSkipped === 'function') _cfg.onSkipped();
  }

  // ==========================================================================
  // Modal lifecycle
  // ==========================================================================

  function _closeModal() {
    _stopCamera();
    if (_bsModal) _bsModal.hide();
  }

  function _cleanup() {
    _stopCamera();
    _capturedFile = null;
    _capturedBlob = null;
    _cfg = null;
    _internalState = 'initial';
  }

  // ==========================================================================
  // Public API: PhotoCaptureModal.open(config)
  // UX §7.2 contract — exact parameter names, do not rename.
  // ==========================================================================

  function open(config) {
    if (!config || !config.folder || !config.label) {
      console.error('[PhotoCaptureModal] folder and label are required');
      return;
    }

    _cfg = {
      folder:     config.folder,
      label:      config.label,
      optional:   config.optional !== false,  // default true
      entityId:   config.entityId  || null,
      maxSizeMB:  config.maxSizeMB || 5,
      onUploaded: typeof config.onUploaded === 'function' ? config.onUploaded : null,
      onSkipped:  typeof config.onSkipped  === 'function' ? config.onSkipped  : null,
      onError:    typeof config.onError    === 'function' ? config.onError    : null,
    };

    _capturedFile  = null;
    _capturedBlob  = null;
    _internalState = 'initial';

    _modalEl = _ensureModal();

    // Update label
    const labelEl = document.getElementById('photo-capture-modal-label');
    if (labelEl) labelEl.textContent = _cfg.label;

    // Bootstrap modal
    if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
      _bsModal = bootstrap.Modal.getOrCreateInstance(_modalEl, {
        backdrop: 'static',  // prevent accidental dismiss
        keyboard: false,
      });
    }

    // Cleanup on modal hidden
    _modalEl.removeEventListener('hidden.bs.modal', _cleanup);
    _modalEl.addEventListener('hidden.bs.modal', _cleanup);

    _renderInitial();

    if (_bsModal) _bsModal.show();
  }

  // ==========================================================================
  // Escape helper
  // ==========================================================================

  function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ==========================================================================
  // Public namespace
  // ==========================================================================
  window.PhotoCaptureModal = { open };

})();
