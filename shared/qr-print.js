// shared/qr-print.js — Phase 0.5
// Exports window.QRPrint = { single(code, opts), bulk(rows, opts),
//                             downloadPNG(code, opts), downloadBulkPNG(rows, opts) }
//
// API contract (spec §6):
//   QRPrint.single(code, { size, label, subtitle, entityType })
//   QRPrint.bulk(rows, {})
//     rows: Array<{ code, label?, subtitle? }>
//   QRPrint.downloadPNG(code, { label?, subtitle? })
//     — renders QR + text onto a 1024×1024 offscreen canvas, downloads as qr-{code}.png
//   QRPrint.downloadBulkPNG(rows, {})
//     — renders all stickers on an A4-sized canvas (2480×3508), downloads as qr-bulk-{YYYYMMDD-HHmm}.png
//
// iOS auto-fallback (spec §4.4, decision Q-QR-6):
//   On iOS Safari, QRPrint.single and QRPrint.bulk show a Bootstrap modal instead of
//   going straight to window.print(). User picks "พิมพ์" or "ดาวน์โหลด PNG".
//   Preference stored in localStorage key "qr_print_mode_pref" = 'print' | 'png'.
//   On non-iOS the stored preference is honoured; no modal on first use.
//
// QR payload = bare code string (spec §3, decision Q-QR-1).
// Rendering: uses window.QRCode (qrcode.js library from vendor/qrcode.min.js).
// Print via window.print(); layout controlled by @media print in shared/styles.css.
//
// Dependencies: vendor/qrcode.min.js must be loaded before this file.

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Wait until window.QRCode is defined (loaded from vendor file / CDN). */
  function _waitForQRCode(ms) {
    return new Promise(function (resolve, reject) {
      if (window.QRCode) { resolve(); return; }
      var deadline = Date.now() + (ms || 5000);
      var tid = setInterval(function () {
        if (window.QRCode) { clearInterval(tid); resolve(); return; }
        if (Date.now() > deadline) {
          clearInterval(tid);
          reject(new Error('QRCode library not loaded — check vendor/qrcode.min.js'));
        }
      }, 50);
    });
  }

  /**
   * Build one sticker DOM element.
   * @param {string} code    — QR payload (bare code, spec Q-QR-1)
   * @param {string} label   — human-readable code label under QR (defaults to code)
   * @param {string} subtitle — Thai name under label (optional)
   * @param {string} sizeClass — CSS class string added to the sticker div
   */
  function _buildSticker(code, label, subtitle, sizeClass) {
    var div = document.createElement('div');
    div.className = 'qr-sticker-single' + (sizeClass ? ' ' + sizeClass : '');

    // QR canvas container
    var qrDiv = document.createElement('div');
    qrDiv.className = 'qr-canvas-wrap';
    div.appendChild(qrDiv);

    // Generate QR code into canvas
    // Payload = bare code (spec §3)
    try {
      new window.QRCode(qrDiv, {
        text: String(code),
        width:  160,
        height: 160,
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch (e) {
      var errSpan = document.createElement('span');
      errSpan.className = 'text-danger small';
      errSpan.textContent = 'QR error: ' + e.message;
      qrDiv.appendChild(errSpan);
    }

    // Label (code)
    var lbl = document.createElement('div');
    lbl.className = 'qr-sticker-label';
    lbl.textContent = String(label || code);
    div.appendChild(lbl);

    // Subtitle (Thai name)
    if (subtitle) {
      var sub = document.createElement('div');
      sub.className = 'qr-sticker-subtitle';
      sub.textContent = String(subtitle).slice(0, 24);
      div.appendChild(sub);
    }

    return div;
  }

  /**
   * Inject the print container into the DOM, call window.print(),
   * then remove it after the print event fires (or after a timeout).
   */
  function _printContainer(container) {
    // Remove any previous leftover
    var old = document.getElementById('qr-print-area-root');
    if (old) old.remove();

    container.id = 'qr-print-area-root';
    container.className = (container.className || '') + ' qr-print-area';
    document.body.appendChild(container);

    // Cleanup: remove after afterprint event or 10s fallback
    function cleanup() {
      var el = document.getElementById('qr-print-area-root');
      if (el) el.remove();
    }
    window.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 10000);

    window.print();
  }

  // -------------------------------------------------------------------------
  // iOS / print-mode detection
  // -------------------------------------------------------------------------

  /**
   * Returns true when the UA is iOS (iPad/iPhone/iPod).
   * iOS Safari has window.print() but no system print preview — it silently fails.
   */
  function _isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent);
  }

  /**
   * Returns the stored print-mode preference, or null if not set.
   * Values: 'print' | 'png'
   */
  function _getPref() {
    try { return localStorage.getItem('qr_print_mode_pref') || null; }
    catch (e) { return null; }
  }

  function _setPref(val) {
    try { localStorage.setItem('qr_print_mode_pref', val); } catch (e) {}
  }

  /**
   * Decide whether to go straight to print or ask the user.
   *
   * Rules:
   *   iOS           → always show choice modal (print is silently broken)
   *   Non-iOS, pref set  → honour pref without modal
   *   Non-iOS, no pref   → go straight to print (safe default on desktop)
   *
   * Returns Promise<'print'|'png'>
   */
  function _resolvePrintMode() {
    return new Promise(function (resolve) {
      var pref = _getPref();

      // Non-iOS with saved preference → honour immediately
      if (!_isIOS() && pref) { resolve(pref); return; }

      // Non-iOS without preference → default to print silently
      if (!_isIOS()) { resolve('print'); return; }

      // iOS → always ask
      _showPrintModeModal(resolve);
    });
  }

  /**
   * Inject a Bootstrap modal with two choices: Print / Download PNG.
   * Resolves the promise when the user picks one, and remembers the choice
   * in localStorage.
   */
  function _showPrintModeModal(resolve) {
    // Remove any stale modal from a previous call
    var old = document.getElementById('qr-mode-modal');
    if (old) old.remove();

    var html = [
      '<div class="modal fade" id="qr-mode-modal" tabindex="-1" aria-modal="true" role="dialog">',
      '  <div class="modal-dialog modal-dialog-centered">',
      '    <div class="modal-content">',
      '      <div class="modal-header">',
      '        <h5 class="modal-title">เลือกวิธีรับ QR Sticker</h5>',
      '        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>',
      '      </div>',
      '      <div class="modal-body">',
      '        <p class="text-muted small mb-3">อุปกรณ์นี้อาจไม่รองรับการพิมพ์โดยตรง — ดาวน์โหลด PNG แล้วเปิดในแอปรูปภาพหรือแชร์ได้เลย</p>',
      '        <div class="d-grid gap-2">',
      '          <button type="button" class="btn btn-outline-secondary" id="qr-mode-print">',
      '            <i class="bi bi-printer me-2"></i>พิมพ์ (Print)',
      '          </button>',
      '          <button type="button" class="btn btn-stock-primary" id="qr-mode-png">',
      '            <i class="bi bi-download me-2"></i>ดาวน์โหลด PNG',
      '          </button>',
      '        </div>',
      '        <div class="form-check mt-3">',
      '          <input class="form-check-input" type="checkbox" id="qr-mode-remember">',
      '          <label class="form-check-label small text-muted" for="qr-mode-remember">จำการเลือกนี้</label>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');

    document.body.insertAdjacentHTML('beforeend', html);
    var modalEl = document.getElementById('qr-mode-modal');

    // Use Bootstrap modal if available; otherwise fall back to manual show
    var bsModal = null;
    if (window.bootstrap && window.bootstrap.Modal) {
      bsModal = new window.bootstrap.Modal(modalEl);
      bsModal.show();
    } else {
      modalEl.classList.add('show');
      modalEl.style.display = 'block';
      document.body.classList.add('modal-open');
    }

    function _pick(mode) {
      var remember = document.getElementById('qr-mode-remember');
      if (remember && remember.checked) _setPref(mode);
      if (bsModal) { bsModal.hide(); }
      else { modalEl.classList.remove('show'); modalEl.style.display = 'none'; document.body.classList.remove('modal-open'); }
      modalEl.remove();
      resolve(mode);
    }

    document.getElementById('qr-mode-print').addEventListener('click', function () { _pick('print'); });
    document.getElementById('qr-mode-png').addEventListener('click',   function () { _pick('png'); });

    // Dismiss without choice → default to print
    modalEl.addEventListener('hidden.bs.modal', function () {
      if (document.getElementById('qr-mode-modal')) { modalEl.remove(); resolve('print'); }
    }, { once: true });
  }

  // -------------------------------------------------------------------------
  // PNG generation helpers
  // -------------------------------------------------------------------------

  /**
   * Render a single QR sticker onto an offscreen canvas and return the canvas.
   * Canvas is 1024×1024 px.
   *
   * @param {string} code
   * @param {string} label     — human-readable code text below QR
   * @param {string} subtitle  — Thai name below label (optional)
   * @returns {HTMLCanvasElement}
   */
  function _renderSingleToCanvas(code, label, subtitle) {
    var SIZE = 1024;
    var QR_SIZE = 768;   // QR occupies top 75%
    var PAD = 24;

    var canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    var ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Render QR into a temporary hidden div, then copy to canvas
    var tempDiv = document.createElement('div');
    tempDiv.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(tempDiv);

    try {
      new window.QRCode(tempDiv, {
        text:         String(code),
        width:        QR_SIZE,
        height:       QR_SIZE,
        correctLevel: window.QRCode.CorrectLevel.M,
      });

      // qrcode.js renders a canvas or img; we need the image data
      var qrEl = tempDiv.querySelector('canvas') || tempDiv.querySelector('img');
      if (qrEl) {
        var offsetX = (SIZE - QR_SIZE) / 2;
        var offsetY = PAD;
        if (qrEl.tagName === 'CANVAS') {
          ctx.drawImage(qrEl, offsetX, offsetY, QR_SIZE, QR_SIZE);
        } else {
          // img element
          ctx.drawImage(qrEl, offsetX, offsetY, QR_SIZE, QR_SIZE);
        }
      }
    } finally {
      tempDiv.remove();
    }

    // Label text
    var textY = PAD + QR_SIZE + 32;
    ctx.textAlign   = 'center';
    ctx.fillStyle   = '#000000';
    ctx.font        = 'bold 36pt monospace';
    ctx.fillText(String(label || code), SIZE / 2, textY, SIZE - PAD * 2);

    // Subtitle
    if (subtitle) {
      ctx.font      = '24pt sans-serif';
      ctx.fillStyle = '#444444';
      ctx.fillText(String(subtitle).slice(0, 32), SIZE / 2, textY + 52, SIZE - PAD * 2);
    }

    return canvas;
  }

  /**
   * Render multiple stickers onto an A4-proportioned canvas (2480×3508 at 300dpi).
   * Grid: 6 columns × as many rows as needed, each cell 380×380 px with 8px gap.
   *
   * @param {Array<{code, label?, subtitle?}>} rows
   * @returns {HTMLCanvasElement}
   */
  function _renderBulkToCanvas(rows) {
    var COLS      = 6;
    var CELL      = 380;
    var GAP       = 8;
    var H_PAD     = 40;
    var V_PAD     = 40;
    var QR_SZ     = 260;
    var PAGE_W    = 2480;

    var numRows   = Math.ceil(rows.length / COLS);
    var PAGE_H    = V_PAD * 2 + numRows * (CELL + GAP) - GAP;
    // Minimum A4 height
    PAGE_H = Math.max(PAGE_H, 3508);

    var canvas = document.createElement('canvas');
    canvas.width  = PAGE_W;
    canvas.height = PAGE_H;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    rows.forEach(function (row, idx) {
      var col  = idx % COLS;
      var r    = Math.floor(idx / COLS);
      var cellX = H_PAD + col * (CELL + GAP);
      var cellY = V_PAD + r   * (CELL + GAP);

      // Cell border
      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(cellX + 0.5, cellY + 0.5, CELL - 1, CELL - 1);
      ctx.setLineDash([]);

      // QR
      var code     = row.code || '';
      var label    = row.label    || code;
      var subtitle = row.subtitle || '';

      var tempDiv = document.createElement('div');
      tempDiv.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(tempDiv);
      try {
        new window.QRCode(tempDiv, {
          text:         String(code),
          width:        QR_SZ,
          height:       QR_SZ,
          correctLevel: window.QRCode.CorrectLevel.M,
        });
        var qrEl = tempDiv.querySelector('canvas') || tempDiv.querySelector('img');
        if (qrEl) {
          var qrX = cellX + (CELL - QR_SZ) / 2;
          var qrY = cellY + 8;
          ctx.drawImage(qrEl, qrX, qrY, QR_SZ, QR_SZ);
        }
      } finally {
        tempDiv.remove();
      }

      // Label
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000000';
      ctx.font      = 'bold 18pt monospace';
      ctx.fillText(String(label).slice(0, 20), cellX + CELL / 2, cellY + QR_SZ + 28, CELL - 12);

      // Subtitle
      if (subtitle) {
        ctx.font      = '12pt sans-serif';
        ctx.fillStyle = '#555555';
        ctx.fillText(String(subtitle).slice(0, 24), cellX + CELL / 2, cellY + QR_SZ + 52, CELL - 12);
      }
    });

    return canvas;
  }

  /**
   * Trigger a PNG download from a canvas element.
   * @param {HTMLCanvasElement} canvas
   * @param {string} filename
   */
  function _downloadCanvasAsPNG(canvas, filename) {
    canvas.toBlob(function (blob) {
      if (!blob) { alert('ไม่สามารถสร้างไฟล์ PNG ได้'); return; }
      var url = URL.createObjectURL(blob);
      var a   = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  /** Format Date as YYYYMMDD-HHmm */
  function _dateStamp() {
    var d   = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return String(d.getFullYear()) +
           pad(d.getMonth() + 1) +
           pad(d.getDate()) + '-' +
           pad(d.getHours()) +
           pad(d.getMinutes());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Print a single sticker for one entity.
   * On iOS Safari, shows a modal to choose Print vs PNG download first.
   *
   * @param {string} code  — entity code; becomes both QR payload AND default label
   * @param {object} opts
   *   opts.size       {string}  '38mm' | '50mm' | '76mm'  (default '38mm')
   *   opts.label      {string}  human-readable code label   (default = code)
   *   opts.subtitle   {string}  Thai name under label        (optional)
   *   opts.entityType {string}  'item'|'location'|'bag'|'tank'  (informational only)
   */
  async function single(code, opts) {
    opts = opts || {};
    var size  = opts.size || '38mm';
    var label = opts.label || code;
    var sub   = opts.subtitle || '';

    try {
      await _waitForQRCode();
    } catch (e) {
      alert('ไม่สามารถพิมพ์ QR ได้: ' + e.message);
      return;
    }

    // Phase 0.6 Wave 2 PM decision: always download PNG, skip print dialog.
    // User feedback: print dialog UX awkward (defaults to PDF/no-printer paths).
    // Solution: deliver PNG file, user prints themselves with their preferred tool.
    downloadPNG(code, { label: label, subtitle: sub });
  }

  /**
   * Print multiple stickers in an A4 6×8 grid.
   * On iOS Safari, shows a modal to choose Print vs PNG download first.
   *
   * @param {Array<{code, label?, subtitle?}>} rows
   * @param {object} opts  — reserved; currently unused
   */
  async function bulk(rows, opts) {
    if (!rows || !rows.length) {
      alert('กรุณาเลือกรายการที่ต้องการพิมพ์');
      return;
    }

    try {
      await _waitForQRCode();
    } catch (e) {
      alert('ไม่สามารถพิมพ์ QR ได้: ' + e.message);
      return;
    }

    // Phase 0.6 Wave 2 PM decision: always download PNG, skip print dialog.
    downloadBulkPNG(rows, opts);
    return;

    // === Legacy print-dialog path retained for reference / future toggle ===
    /* eslint-disable */
    var container = document.createElement('div');
    container.classList.add('qr-page-bulk');

    var grid = document.createElement('div');
    grid.className = 'qr-sticker-grid';
    container.appendChild(grid);

    rows.forEach(function (row) {
      var sticker = _buildSticker(
        row.code,
        row.label  || row.code,
        row.subtitle || '',
        ''
      );
      grid.appendChild(sticker);
    });

    _printContainer(container);
  }

  /**
   * Download a single QR sticker as a 1024×1024 PNG file.
   * File name: qr-{code}.png
   *
   * @param {string} code
   * @param {object} opts
   *   opts.label    {string}  human-readable label below QR  (default = code)
   *   opts.subtitle {string}  Thai name below label           (optional)
   */
  async function downloadPNG(code, opts) {
    opts = opts || {};
    var label    = opts.label    || code;
    var subtitle = opts.subtitle || '';

    try {
      await _waitForQRCode();
    } catch (e) {
      alert('ไม่สามารถสร้าง PNG ได้: ' + e.message);
      return;
    }

    var canvas   = _renderSingleToCanvas(code, label, subtitle);
    var filename = 'qr-' + String(code).replace(/[^A-Za-z0-9\-_ก-๙]/g, '_') + '.png';
    _downloadCanvasAsPNG(canvas, filename);
  }

  /**
   * Download all stickers as a single A4-sized PNG file.
   * File name: qr-bulk-{YYYYMMDD-HHmm}.png
   *
   * @param {Array<{code, label?, subtitle?}>} rows
   * @param {object} opts  — reserved; currently unused
   */
  async function downloadBulkPNG(rows, opts) {
    if (!rows || !rows.length) {
      alert('กรุณาเลือกรายการที่ต้องการดาวน์โหลด');
      return;
    }

    try {
      await _waitForQRCode();
    } catch (e) {
      alert('ไม่สามารถสร้าง PNG ได้: ' + e.message);
      return;
    }

    var canvas   = _renderBulkToCanvas(rows);
    var filename = 'qr-bulk-' + _dateStamp() + '.png';
    _downloadCanvasAsPNG(canvas, filename);
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------
  window.QRPrint = {
    single:          single,
    bulk:            bulk,
    downloadPNG:     downloadPNG,
    downloadBulkPNG: downloadBulkPNG,
  };

})();
