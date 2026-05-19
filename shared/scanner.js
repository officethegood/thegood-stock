// shared/scanner.js
// Phase 1 — Camera barcode/QR scanner.
//
// Strategy:
//   1. Use the native `BarcodeDetector` API where available (Chrome / Edge / Android Chrome ≥ 83,
//      desktop Safari 17+). This is the hot path: no library to download, fastest decode.
//   2. Fall back to the `html5-qrcode` library, lazy-loaded from cdnjs ONLY when the native
//      detector is missing (Safari iOS < 17, Firefox without flag, older WebViews).
//
// Locked decisions (PM Pex 2026-05-18):
//   Q3: NO photo capture / file upload — scanner.js does barcode/QR detection only.
//   Q2: No Chart.js — irrelevant here.
//
// Spec refs:
//   docs/superpowers/specs/2026-05-18-phase1-inventory-design.md  §4 (lib choice), §7.2 (UX)
//   docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md    Task C2
//
// Requires (loaded BEFORE this script):
//   shared/config.js, shared/supabase-client.js   (only so it can co-exist; this module itself
//                                                  has no Supabase dependency)
//
// Public API (window.AppScanner):
//   isSupported()                                  → boolean
//   startScanning({ videoElement, onScan, onError, formats? })  → Promise<void>
//   stopScanning()                                 → Promise<void>
//   parseScanResult(text)                          → { type, value }
//
// Also exports backward-compatible window.scannerCreate / window.scannerHasNative
// to match the plan's Task C2 reference signature.

(function () {
  'use strict';

  // CDN source — pinned version + SRI-friendly cdnjs URL.
  // html5-qrcode v2.3.8 — load LAZILY only when native detector is absent.
  const H5Q_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
  const H5Q_FALLBACK_CDN = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

  // Default scan formats. Covers item barcodes (EAN/UPC/Code-128/Code-39) and location QR codes.
  const DEFAULT_FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar'];

  // Location QR convention: payloads stored in locations.qr_payload typically equal the location
  // code (e.g. "ROOM-A", "SHELF-A1-T1"). We also accept an explicit "LOC:..." prefix so a label
  // printer can disambiguate locations from item barcodes when both formats are 1D.
  const LOC_PREFIX = 'LOC:';

  // Module state — only one scanner can be active at a time on a page.
  let _libLoading = null;        // Promise — in-flight CDN load
  let _libLoaded  = false;       // resolved successfully
  let _active     = false;
  let _stream     = null;        // MediaStream (native path)
  let _rafId      = null;        // requestAnimationFrame token (native path)
  let _videoEl    = null;        // <video> we attached to (native path)
  let _h5q        = null;        // Html5Qrcode instance (fallback path)
  let _h5qWrapId  = null;        // wrapper div id (fallback path)

  // =========================================================================
  // Capability detection
  // =========================================================================

  /** @returns {boolean} true if the native BarcodeDetector API is present. */
  function hasNativeDetector() {
    return typeof window !== 'undefined' && typeof window.BarcodeDetector !== 'undefined';
  }

  /**
   * Whether scanning is supported in this browser.
   * Native: always true (no library needed).
   * Fallback: true iff getUserMedia is available — the html5-qrcode library will load on demand.
   * @returns {boolean}
   */
  function isSupported() {
    if (hasNativeDetector()) return true;
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // =========================================================================
  // Lazy CDN load for html5-qrcode
  // =========================================================================

  /**
   * @internal
   * Load html5-qrcode from CDN exactly once. Tries cdnjs first, falls back to unpkg.
   * Resolves when window.Html5Qrcode is defined. Subsequent calls return the cached promise.
   * @returns {Promise<void>}
   */
  function _loadHtml5Qrcode() {
    if (_libLoaded) return Promise.resolve();
    if (_libLoading) return _libLoading;
    _libLoading = new Promise((resolve, reject) => {
      const tryUrl = (url, andThen) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.crossOrigin = 'anonymous';
        s.referrerPolicy = 'no-referrer';
        s.onload  = () => {
          if (window.Html5Qrcode) { _libLoaded = true; resolve(); }
          else                    { andThen(new Error('html5-qrcode loaded but global missing')); }
        };
        s.onerror = () => andThen(new Error('failed to load ' + url));
        document.head.appendChild(s);
      };
      tryUrl(H5Q_CDN, (err1) => {
        // Retry with unpkg mirror.
        tryUrl(H5Q_FALLBACK_CDN, (err2) => {
          _libLoading = null;
          reject(err2 || err1);
        });
      });
    });
    return _libLoading;
  }

  // =========================================================================
  // Native BarcodeDetector path
  // =========================================================================

  async function _startNative(videoEl, formats, onScan, onError) {
    const detector = new window.BarcodeDetector({ formats });

    _stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    _videoEl = videoEl;
    videoEl.srcObject = _stream;
    videoEl.setAttribute('playsinline', 'true');  // iOS Safari
    videoEl.muted = true;
    await videoEl.play();

    // Throttle: don't run detect() on every animation frame — every ~150 ms is plenty.
    let lastRun = 0;
    const MIN_INTERVAL_MS = 150;

    const loop = async (ts) => {
      if (!_active) return;
      if (ts - lastRun >= MIN_INTERVAL_MS) {
        lastRun = ts;
        try {
          const codes = await detector.detect(videoEl);
          if (codes && codes.length > 0 && _active) {
            const c = codes[0];
            try { onScan(c.rawValue, c.format || 'unknown'); }
            catch (cbErr) { onError?.(cbErr?.message || String(cbErr)); }
          }
        } catch (e) {
          // Per-frame decode failures are normal — only surface if the detector itself died.
          if (/InvalidStateError|NotSupportedError/.test(e?.name || '')) {
            onError?.(e?.message || String(e));
          }
        }
      }
      _rafId = requestAnimationFrame(loop);
    };
    _rafId = requestAnimationFrame(loop);
  }

  // =========================================================================
  // html5-qrcode fallback path
  // =========================================================================

  async function _startFallback(videoEl, formats, onScan, onError) {
    await _loadHtml5Qrcode();

    // html5-qrcode renders into a <div>, not a <video>. We replace the caller's video element
    // with a wrapper div, then put it back on stop().
    const wrap = document.createElement('div');
    _h5qWrapId = 'h5q-' + Math.random().toString(36).slice(2, 9);
    wrap.id = _h5qWrapId;
    wrap.style.width  = videoEl.style.width  || '100%';
    wrap.style.height = videoEl.style.height || 'auto';
    wrap.dataset.h5qReplaces = 'true';
    _videoEl = videoEl;
    videoEl.replaceWith(wrap);

    // Map our format names to html5-qrcode's enum where possible.
    let formatsEnum;
    try {
      const F = window.Html5QrcodeSupportedFormats;
      if (F) {
        const map = {
          qr_code: F.QR_CODE, code_128: F.CODE_128, code_39: F.CODE_39,
          ean_13: F.EAN_13, ean_8: F.EAN_8, upc_a: F.UPC_A, upc_e: F.UPC_E,
          itf: F.ITF, codabar: F.CODABAR,
        };
        formatsEnum = formats.map((f) => map[f]).filter((v) => v !== undefined);
      }
    } catch { /* ignore */ }

    _h5q = new window.Html5Qrcode(_h5qWrapId, formatsEnum && formatsEnum.length ? { formatsToSupport: formatsEnum } : undefined);

    await _h5q.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (text, result) => {
        if (!_active) return;
        const fmt = result?.result?.format?.formatName || 'unknown';
        try { onScan(text, String(fmt).toLowerCase()); }
        catch (cbErr) { onError?.(cbErr?.message || String(cbErr)); }
      },
      () => { /* per-frame failures silenced; html5-qrcode is noisy */ },
    );
  }

  // =========================================================================
  // Public — start / stop
  // =========================================================================

  /**
   * Start continuous scanning. Fires `onScan(decodedText, format)` on every detection.
   * The caller decides when to stop — typically inside `onScan` once the first valid code arrives.
   *
   * BROWSER SUPPORT:
   *   * Native path (`BarcodeDetector`): Chrome ≥ 83, Edge ≥ 83, Android Chrome ≥ 83, Safari 17+.
   *   * Fallback path (html5-qrcode): everything else with getUserMedia. Lazy-loaded from cdnjs.
   *
   * @param {object} opts
   * @param {HTMLVideoElement} opts.videoElement     Where to render the camera preview.
   * @param {(text: string, format: string) => void} opts.onScan
   * @param {(message: string) => void} [opts.onError]
   * @param {string[]} [opts.formats]                Override default format list.
   * @returns {Promise<void>} resolves once the camera is live and decoding has started.
   */
  async function startScanning({ videoElement, onScan, onError, formats } = {}) {
    if (_active) {
      onError?.('scanner already running — call stopScanning() first');
      return;
    }
    if (!videoElement) {
      onError?.('videoElement is required');
      return;
    }
    if (typeof onScan !== 'function') {
      onError?.('onScan callback is required');
      return;
    }

    _active = true;
    const fmts = (formats && formats.length) ? formats : DEFAULT_FORMATS;

    try {
      if (hasNativeDetector()) {
        await _startNative(videoElement, fmts, onScan, onError);
      } else {
        await _startFallback(videoElement, fmts, onScan, onError);
      }
    } catch (e) {
      _active = false;
      const msg = _friendlyCameraError(e);
      onError?.(msg);
      // Best-effort cleanup if we partially started.
      await stopScanning();
    }
  }

  /**
   * Stop scanning, release the camera, and clean up DOM.
   * Idempotent — safe to call even if scanning never started.
   * @returns {Promise<void>}
   */
  async function stopScanning() {
    _active = false;

    if (_rafId) {
      try { cancelAnimationFrame(_rafId); } catch { /* ignore */ }
      _rafId = null;
    }
    if (_stream) {
      try { _stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      _stream = null;
    }
    if (_videoEl && hasNativeDetector()) {
      try { _videoEl.pause(); } catch { /* ignore */ }
      try { _videoEl.srcObject = null; } catch { /* ignore */ }
    }
    if (_h5q) {
      try { await _h5q.stop(); } catch { /* ignore */ }
      try { _h5q.clear(); } catch { /* ignore */ }
      _h5q = null;
    }
    // Restore the original <video> in place of the html5-qrcode wrapper div.
    if (_h5qWrapId) {
      const wrap = document.getElementById(_h5qWrapId);
      if (wrap && _videoEl && wrap.dataset.h5qReplaces === 'true') {
        try { wrap.replaceWith(_videoEl); } catch { /* ignore */ }
      }
      _h5qWrapId = null;
    }
    _videoEl = null;
  }

  // =========================================================================
  // Parsing
  // =========================================================================

  /**
   * Classify a decoded scan as a location QR or an item barcode/SKU.
   * Heuristic (no DB call):
   *   * Starts with "LOC:"           → location-qr (value = text after the prefix)
   *   * Otherwise                    → item-barcode (value = the raw text)
   *   * Empty / non-string           → unknown
   *
   * Callers should still confirm with `AppInventory.findLocationByCode()` or
   * `AppInventory.searchByBarcode()` — this is just an optimistic classification
   * so the scan UI can pick the right next step.
   *
   * @param {string} text
   * @returns {{ type: 'location-qr' | 'item-barcode' | 'unknown', value: string }}
   */
  function parseScanResult(text) {
    if (typeof text !== 'string') return { type: 'unknown', value: '' };
    const trimmed = text.trim();
    if (!trimmed) return { type: 'unknown', value: '' };
    if (trimmed.toUpperCase().startsWith(LOC_PREFIX)) {
      return { type: 'location-qr', value: trimmed.slice(LOC_PREFIX.length) };
    }
    return { type: 'item-barcode', value: trimmed };
  }

  // =========================================================================
  // Error mapping
  // =========================================================================

  function _friendlyCameraError(e) {
    const name = e?.name || '';
    const msg  = e?.message || String(e || 'unknown error');
    if (name === 'NotAllowedError' || /Permission/.test(msg))   return 'ไม่ได้รับสิทธิ์เข้าถึงกล้อง';
    if (name === 'NotFoundError'  || /no camera/i.test(msg))    return 'ไม่พบกล้องบนอุปกรณ์นี้';
    if (name === 'NotReadableError' || /in use/i.test(msg))     return 'กล้องถูกใช้งานโดยแอปอื่น';
    if (name === 'OverconstrainedError')                        return 'ไม่สามารถเปิดกล้องด้วยการตั้งค่าที่ขอ';
    if (/SecureContext|insecure context/i.test(msg))            return 'ต้องเปิดผ่าน HTTPS เท่านั้น';
    return msg;
  }

  // =========================================================================
  // Phase 0.7 — Camera availability flag (§5.2.2)
  // =========================================================================

  // Detect on module init: if mediaDevices is unavailable (desktop without camera, certain
  // in-app browsers) expose cameraAvailable=false so callers can hide the scan button.
  const cameraAvailable = !!(navigator.mediaDevices);

  // =========================================================================
  // Phase 0.7 — openForLocation: scan QR and resolve to a location row
  // =========================================================================

  /**
   * Open a full-screen scan modal expecting a `location:<uuid>` payload.
   * On success resolves with { id, code, name, type, path_display, scanned: true }.
   * On any camera failure → auto-opens tree-picker (§5.2.1), resolves with scanned:false.
   * Rejects only if the user explicitly cancels (tree-picker cancel).
   *
   * @returns {Promise<{id:string,code:string,name:string,type:string,path_display:string,scanned:boolean}>}
   */
  function openForLocation() {
    return new Promise((resolve, reject) => {
      // §5.2.2: if no mediaDevices at all, skip straight to manual
      if (!cameraAvailable) {
        _fallbackToManual('device-not-supported', resolve, reject);
        return;
      }

      // §5.2.1: iOS LINE/FB in-app browser heuristic
      const ua = navigator.userAgent || '';
      const isInApp = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(ua);
      if (isInApp) {
        _fallbackToManual('device-not-supported', resolve, reject);
        return;
      }

      _openScannerModal(resolve, reject);
    });
  }

  /**
   * Build and show a minimal scan modal.  Attaches AppScanner.startScanning internally.
   */
  function _openScannerModal(resolve, reject) {
    const old = document.getElementById('scanner-loc-modal');
    if (old) try { old.remove(); } catch { /* ignore */ }

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal fade" id="scanner-loc-modal" tabindex="-1"
           aria-labelledby="scanner-loc-title">
        <div class="modal-dialog modal-dialog-centered modal-fullscreen-sm-down">
          <div class="modal-content bg-dark text-white">
            <div class="modal-header border-0 pb-0">
              <h5 class="modal-title" id="scanner-loc-title">สแกน QR ตำแหน่ง</h5>
              <button type="button" class="btn-close btn-close-white"
                      data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body p-2">
              <div style="position:relative;width:100%;aspect-ratio:3/4;max-height:55vh;
                          background:#000;border-radius:12px;overflow:hidden;">
                <video id="scanner-loc-video" playsinline muted
                       style="width:100%;height:100%;object-fit:cover;display:block;"
                       aria-label="กล้องสแกน QR ตำแหน่ง"></video>
                <div style="position:absolute;top:15%;left:15%;right:15%;bottom:15%;
                            border:2px solid #00B8A9;border-radius:10px;pointer-events:none;
                            box-shadow:0 0 0 9999px rgba(0,0,0,0.20);"></div>
                <div id="scanner-loc-hint"
                     style="position:absolute;left:0;right:0;bottom:14px;text-align:center;
                            color:#fff;font-size:0.95rem;text-shadow:0 1px 4px rgba(0,0,0,0.7);">
                  สแกน QR ของตำแหน่งที่ต้องการ
                </div>
              </div>
            </div>
            <div class="modal-footer border-0 pt-0">
              <button type="button" class="btn btn-outline-light flex-grow-1"
                      id="scanner-loc-manual" style="min-height:44px;">
                <i class="bi bi-list-ul me-1"></i> เลือกจากรายการแทน
              </button>
            </div>
          </div>
        </div>
      </div>`;
    const modalEl = wrap.firstElementChild;
    document.body.appendChild(modalEl);
    const bsModal = new bootstrap.Modal(modalEl, { backdrop: 'static' });

    const videoEl   = modalEl.querySelector('#scanner-loc-video');
    const manualBtn = modalEl.querySelector('#scanner-loc-manual');

    let _resolved = false;

    async function _startCam() {
      // Wrap startScanning in a 5-second getUserMedia timeout (§5.2.1).
      // We do a preflight getUserMedia with a race so we can catch NotAllowed/NotFound/timeout
      // before AppScanner.startScanning tries to open the stream internally.
      let preflightStream = null;
      try {
        preflightStream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
      } catch (err) {
        const reason = _mapCameraError(err);
        bsModal.hide();
        _fallbackToManual(reason, resolve, reject);
        return;
      }
      // Preflight succeeded — release its tracks; startScanning will open its own stream.
      preflightStream.getTracks().forEach((t) => t.stop());

      try {
        await startScanning({
          videoElement: videoEl,
          formats: ['qr_code'],
          onScan: async (text) => {
            if (_resolved) return;
            const locId = _parseLocationQR(text);
            if (!locId) {
              // Not a location QR — keep scanning
              return;
            }
            _resolved = true;
            await stopScanning();
            bsModal.hide();
            try {
              const loc = await _resolveLocationId(locId);
              if (!loc) throw new Error('ไม่พบตำแหน่งนี้ในระบบ');
              resolve({ ...loc, scanned: true });
            } catch (e) {
              reject(e);
            }
          },
          onError: (msg) => {
            if (_resolved) return;
            stopScanning().catch(() => {});
            bsModal.hide();
            _fallbackToManual('unknown-error', resolve, reject);
          },
        });
      } catch (err) {
        const reason = _mapCameraError(err);
        bsModal.hide();
        _fallbackToManual(reason, resolve, reject);
      }
    }

    manualBtn.addEventListener('click', () => {
      _resolved = true;
      stopScanning().catch(() => {});
      bsModal.hide();
      _openManualFallback(resolve, reject);
    });

    modalEl.addEventListener('hidden.bs.modal', () => {
      if (!_resolved) {
        stopScanning().catch(() => {});
        reject(new Error('cancelled'));
      }
      try { modalEl.remove(); } catch { /* ignore */ }
    });

    bsModal.show();
    // Start cam after modal transition (user gesture satisfied by show())
    modalEl.addEventListener('shown.bs.modal', () => {
      _startCam();
    }, { once: true });
  }

  /**
   * Parse a QR payload in "location:<uuid>" format.
   * Returns the UUID string or null.
   * Also accepts the older "LOC:<code>" prefix by returning null (caller should re-query by code).
   */
  function _parseLocationQR(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    // Phase 0.7 format: "location:<uuid>"
    const m = t.match(/^location:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (m) return m[1];
    return null;
  }

  /**
   * Lookup a location from DB by UUID, returning the full path row.
   */
  async function _resolveLocationId(uuid) {
    if (typeof getSupabaseClient !== 'function' && typeof window.getSupabaseClient !== 'function') return null;
    const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient : window.getSupabaseClient)();
    // Join v_location_path with locations for code
    const pathR = await sb.from('v_location_path')
      .select('id,name,type,path_display')
      .eq('id', uuid)
      .single();
    if (pathR.error || !pathR.data) return null;
    const codeR = await sb.from('locations').select('code').eq('id', uuid).single();
    return { ...pathR.data, code: codeR.data?.code ?? '' };
  }

  /**
   * Map a getUserMedia/Promise.race error to a fallback reason string (§5.2.1).
   */
  function _mapCameraError(err) {
    const name = err?.name || '';
    const msg  = err?.message || '';
    if (name === 'NotAllowedError')   return 'permission-denied';
    if (name === 'NotFoundError')     return 'no-camera';
    if (name === 'NotReadableError')  return 'camera-busy';
    if (msg   === 'timeout')          return 'camera-timeout';
    if (!navigator.mediaDevices)      return 'device-not-supported';
    return 'unknown-error';
  }

  /**
   * Show a Thai toast for the camera failure reason, then open tree-picker (§5.2.1).
   * No dead-end: resolve/reject are passed through to the picker.
   */
  function _fallbackToManual(reason, resolve, reject) {
    const messages = {
      'device-not-supported': 'อุปกรณ์นี้ไม่รองรับกล้อง',
      'permission-denied':    'ไม่ได้รับอนุญาตใช้กล้อง — ตั้งค่าใน browser หรือเลือกตำแหน่งด้วยมือ',
      'no-camera':            'ไม่พบกล้องในอุปกรณ์นี้',
      'camera-busy':          'กล้องถูกใช้งานโดย app อื่น',
      'camera-timeout':       'กล้องไม่ตอบสนอง — ลองใหม่หรือเลือกด้วยมือ',
      'unknown-error':        'เปิดกล้องไม่สำเร็จ — กรุณาเลือกตำแหน่งด้วยมือ',
    };
    const msg = messages[reason] || messages['unknown-error'];
    // Show toast — use window.showToast if available, otherwise console
    if (typeof window.showToast === 'function') {
      window.showToast('warning', msg);
    } else {
      console.warn('[AppScanner] camera fallback:', msg);
    }
    // Auto-open tree-picker immediately (no dead-end)
    _openManualFallback(resolve, reject);
  }

  /**
   * Delegate to Transfer._openLocationTreePicker if available, otherwise reject.
   */
  function _openManualFallback(resolve, reject) {
    if (window.Transfer && typeof window.Transfer._openLocationTreePicker === 'function') {
      window.Transfer._openLocationTreePicker({})
        .then(resolve)
        .catch(reject);
    } else {
      reject(new Error('tree-picker not available'));
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** @namespace AppScanner */
  const AppScanner = {
    isSupported,
    hasNativeDetector,
    startScanning,
    stopScanning,
    parseScanResult,
    // Phase 0.7 additions
    openForLocation,
    cameraAvailable,
    // NOTE: deliberately NO capturePhoto / uploadImage — Phase 1 Q3 (PM Pex 2026-05-18).
  };

  window.AppScanner = AppScanner;

  // -------------------------------------------------------------------------
  // Backward-compat shims for the plan's Task C2 reference signature
  //   const s = scannerCreate({ onResult, onError }); await s.start(videoEl); s.stop();
  //   scannerHasNative()
  // Lets any code authored against the plan keep working unchanged.
  // -------------------------------------------------------------------------
  function scannerCreate({ onResult, onError } = {}) {
    return {
      async start(videoEl) {
        await startScanning({ videoElement: videoEl, onScan: (t) => onResult?.(t), onError });
      },
      stop() { stopScanning().catch(() => {}); },
    };
  }
  window.scannerCreate    = scannerCreate;
  window.scannerHasNative = hasNativeDetector;
})();
