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
  // Public API
  // =========================================================================

  /** @namespace AppScanner */
  const AppScanner = {
    isSupported,
    hasNativeDetector,
    startScanning,
    stopScanning,
    parseScanResult,
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
