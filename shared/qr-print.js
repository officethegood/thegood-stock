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

  // -------------------------------------------------------------------------
  // FC sticker design system (Phase 0.6 Wave 4)
  // Vital teal #00B8A9, Mitr/JetBrains Mono via canvas font strings
  // -------------------------------------------------------------------------

  var FC_VITAL = '#00B8A9';
  var FC_INK   = '#0c1929';
  var FC_SOFT  = 'rgba(12,25,41,0.62)';
  var FC_MUTE  = 'rgba(12,25,41,0.40)';
  var FC_LINE  = 'rgba(12,25,41,0.18)';

  /** Render QR-only image into a canvas region. Returns the qr element. */
  function _drawQRInto(ctx, code, x, y, size) {
    var tempDiv = document.createElement('div');
    tempDiv.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(tempDiv);
    try {
      new window.QRCode(tempDiv, {
        text: String(code),
        width: size,
        height: size,
        correctLevel: window.QRCode.CorrectLevel.M,
      });
      var qrEl = tempDiv.querySelector('canvas') || tempDiv.querySelector('img');
      if (qrEl) ctx.drawImage(qrEl, x, y, size, size);
    } finally {
      tempDiv.remove();
    }
  }

  /** Truncate text to fit max width on canvas, append … if cut. */
  function _fit(ctx, text, maxW) {
    text = String(text || '');
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) {
      text = text.slice(0, -1);
    }
    return text + '…';
  }

  /**
   * 50×50 mm square layout (1000×1000 px @ 508dpi).
   * Layout: top vital-teal stripe, brand wordmark + entity-type tag, QR centered,
   * monospace code below QR, subtle subtitle, scan hint footer.
   */
  function _renderSquare50(code, label, subtitle, entityType) {
    var W = 1000, H = 1000;
    var QR_SIZE = 620;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Hairline border
    ctx.strokeStyle = FC_LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    // Top vital-teal stripe (brand identifier)
    ctx.fillStyle = FC_VITAL;
    ctx.fillRect(0, 0, W, 14);

    // Brand wordmark (top-left)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = FC_INK;
    ctx.font = '600 22pt "Mitr", system-ui, sans-serif';
    ctx.fillText('thegood', 36, 38);
    ctx.fillStyle = FC_VITAL;
    ctx.font = '600 22pt "JetBrains Mono", monospace';
    ctx.fillText('/stock', 175, 38);

    // Entity-type tag (top-right uppercase)
    if (entityType) {
      ctx.textAlign = 'right';
      ctx.fillStyle = FC_MUTE;
      ctx.font = '500 12pt "JetBrains Mono", monospace';
      var tag = String(entityType).toUpperCase();
      ctx.fillText(tag, W - 36, 46);
    }

    // QR centered horizontally, vertically positioned with breathing room
    var qrX = (W - QR_SIZE) / 2;
    var qrY = 130;
    _drawQRInto(ctx, code, qrX, qrY, QR_SIZE);

    // Subtle vital corners around QR (4 brand marks at QR corners)
    ctx.strokeStyle = FC_VITAL;
    ctx.lineWidth = 4;
    var c = 18; // corner length
    [[qrX, qrY], [qrX + QR_SIZE, qrY], [qrX, qrY + QR_SIZE], [qrX + QR_SIZE, qrY + QR_SIZE]].forEach(function (p, i) {
      var dx = (i === 1 || i === 3) ? -1 : 1;
      var dy = (i >= 2) ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1] + dy * c);
      ctx.lineTo(p[0], p[1]);
      ctx.lineTo(p[0] + dx * c, p[1]);
      ctx.stroke();
    });

    // Code text (monospace, large, bold)
    var codeY = qrY + QR_SIZE + 50;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = FC_INK;
    ctx.font = '700 34pt "JetBrains Mono", monospace';
    var codeTxt = _fit(ctx, label || code, W - 80);
    ctx.fillText(codeTxt, W / 2, codeY);

    // Subtitle (Thai name)
    if (subtitle) {
      ctx.font = '400 20pt "IBM Plex Sans Thai", "Sarabun", sans-serif';
      ctx.fillStyle = FC_SOFT;
      var subTxt = _fit(ctx, subtitle, W - 80);
      ctx.fillText(subTxt, W / 2, codeY + 55);
    }

    // Bottom hairline + scan hint
    ctx.strokeStyle = FC_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(36, H - 50);
    ctx.lineTo(W - 36, H - 50);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = FC_MUTE;
    ctx.font = '400 11pt "JetBrains Mono", monospace';
    ctx.fillText('SCAN TO LOOK UP', W / 2, H - 38);

    return canvas;
  }

  /**
   * 50×30 mm landscape layout (1000×600 px).
   * Layout: QR on left, brand + code + subtitle + scan hint on right.
   */
  function _renderLandscape5030(code, label, subtitle, entityType) {
    var W = 1000, H = 600;
    var QR_SIZE = 500;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    // Background + border
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = FC_LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    // Left vital-teal stripe
    ctx.fillStyle = FC_VITAL;
    ctx.fillRect(0, 0, 12, H);

    // QR positioned left with breathing room
    var qrX = 50;
    var qrY = (H - QR_SIZE) / 2;
    _drawQRInto(ctx, code, qrX, qrY, QR_SIZE);

    // Vital corners around QR
    ctx.strokeStyle = FC_VITAL;
    ctx.lineWidth = 4;
    var c = 14;
    [[qrX, qrY], [qrX + QR_SIZE, qrY], [qrX, qrY + QR_SIZE], [qrX + QR_SIZE, qrY + QR_SIZE]].forEach(function (p, i) {
      var dx = (i === 1 || i === 3) ? -1 : 1;
      var dy = (i >= 2) ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1] + dy * c);
      ctx.lineTo(p[0], p[1]);
      ctx.lineTo(p[0] + dx * c, p[1]);
      ctx.stroke();
    });

    // Right side: text block
    var rightX = qrX + QR_SIZE + 50;
    var rightW = W - rightX - 30;

    // Brand wordmark
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = FC_INK;
    ctx.font = '600 18pt "Mitr", system-ui, sans-serif';
    ctx.fillText('thegood', rightX, 60);
    ctx.fillStyle = FC_VITAL;
    ctx.font = '600 18pt "JetBrains Mono", monospace';
    ctx.fillText('/stock', rightX + 118, 60);

    // Entity-type tag
    if (entityType) {
      ctx.fillStyle = FC_MUTE;
      ctx.font = '500 11pt "JetBrains Mono", monospace';
      ctx.fillText(String(entityType).toUpperCase(), rightX, 100);
    }

    // Divider hairline
    ctx.strokeStyle = FC_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rightX, 138);
    ctx.lineTo(rightX + rightW, 138);
    ctx.stroke();

    // Code text (large monospace bold)
    ctx.fillStyle = FC_INK;
    ctx.font = '700 30pt "JetBrains Mono", monospace';
    var codeTxt = _fit(ctx, label || code, rightW);
    ctx.fillText(codeTxt, rightX, 165);

    // Subtitle (Thai name, multi-line if needed)
    if (subtitle) {
      ctx.fillStyle = FC_SOFT;
      ctx.font = '400 18pt "IBM Plex Sans Thai", "Sarabun", sans-serif';
      var subTxt = _fit(ctx, subtitle, rightW);
      ctx.fillText(subTxt, rightX, 235);
    }

    // Bottom scan hint with arrow
    ctx.fillStyle = FC_MUTE;
    ctx.font = '400 11pt "JetBrains Mono", monospace';
    ctx.fillText('SCAN TO LOOK UP ↗', rightX, H - 60);

    return canvas;
  }

  /**
   * Render a single QR sticker. Routes to the layout matching `size`.
   *
   * @param {string} code
   * @param {string} label
   * @param {string} subtitle
   * @param {string} size       '50x50' | '50x30' (default '50x50')
   * @param {string} entityType 'ITEM'|'LOCATION'|'BAG'|'TANK'|'LOT' (informational only)
   * @returns {HTMLCanvasElement}
   */
  function _renderSingleToCanvas(code, label, subtitle, size, entityType) {
    if (size === '50x30') return _renderLandscape5030(code, label, subtitle, entityType);
    return _renderSquare50(code, label, subtitle, entityType);
  }

  /**
   * Render multiple stickers onto an A4-proportioned canvas (2480×3508 at 300dpi).
   * Grid: 6 columns × as many rows as needed, each cell 380×380 px with 8px gap.
   *
   * @param {Array<{code, label?, subtitle?}>} rows
   * @returns {HTMLCanvasElement}
   */
  /**
   * Render bulk stickers on an A4 page (2480×3508 @ 300dpi).
   * Cell size matches `size`:
   *   '50x50' — 4 cols × 5 rows = 20 stickers/page (each ≈ 500×500 px)
   *   '50x30' — 4 cols × 8 rows = 32 stickers/page (each ≈ 500×300 px)
   */
  function _renderBulkToCanvas(rows, size) {
    var isLandscape = (size === '50x30');
    var PAGE_W = 2480;   // A4 portrait width at 300dpi
    var PAGE_H = 3508;   // A4 portrait height
    var H_PAD  = 40;
    var V_PAD  = 50;
    var GAP    = 20;
    var COLS, CELL_W, CELL_H, ROWS_PER_PAGE;

    if (isLandscape) {
      COLS = 4; CELL_W = 590; CELL_H = 354;
      ROWS_PER_PAGE = 8;
    } else {
      COLS = 4; CELL_W = 590; CELL_H = 590;
      ROWS_PER_PAGE = 5;
    }

    var numRows = Math.ceil(rows.length / COLS);
    var pages   = Math.ceil(numRows / ROWS_PER_PAGE);
    PAGE_H = Math.max(PAGE_H, pages * 3508);

    var canvas = document.createElement('canvas');
    canvas.width  = PAGE_W;
    canvas.height = PAGE_H;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    rows.forEach(function (row, idx) {
      var col = idx % COLS;
      var r   = Math.floor(idx / COLS);
      var cellX = H_PAD + col * (CELL_W + GAP);
      var cellY = V_PAD + r   * (CELL_H + GAP);

      // Render mini-canvas using same single-sticker renderer (consistent design)
      var miniCanvas = isLandscape
        ? _renderLandscape5030(row.code || '', row.label || row.code || '', row.subtitle || '', row.entityType || '')
        : _renderSquare50(row.code || '', row.label || row.code || '', row.subtitle || '', row.entityType || '');

      ctx.drawImage(miniCanvas, cellX, cellY, CELL_W, CELL_H);
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
    // Phase 0.6 Wave 4: size '50x50' (square) | '50x30' (landscape).
    // Legacy values '38mm'/'50mm'/'76mm' mapped to '50x50' for compat.
    var size = opts.size === '50x30' ? '50x30' : '50x50';
    var label = opts.label || code;
    var sub   = opts.subtitle || '';
    var entityType = (opts.entityType || '').toUpperCase();

    try {
      await _waitForQRCode();
    } catch (e) {
      alert('ไม่สามารถพิมพ์ QR ได้: ' + e.message);
      return;
    }

    // PM decision (Wave 2): always download PNG, skip print dialog.
    downloadPNG(code, { label: label, subtitle: sub, size: size, entityType: entityType });
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
    var label      = opts.label      || code;
    var subtitle   = opts.subtitle   || '';
    var size       = opts.size       || '50x50';   // '50x50' | '50x30'
    var entityType = opts.entityType || '';

    try {
      await _waitForQRCode();
    } catch (e) {
      alert('ไม่สามารถสร้าง PNG ได้: ' + e.message);
      return;
    }

    // Ensure web fonts are loaded before drawing text (Mitr, JetBrains Mono, IBM Plex Sans Thai)
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) { /* non-fatal */ }
    }

    var canvas   = _renderSingleToCanvas(code, label, subtitle, size, entityType);
    var filename = 'qr-' + String(code).replace(/[^A-Za-z0-9\-_ก-๙]/g, '_') + '-' + size + '.png';
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
    opts = opts || {};
    var size = opts.size || '50x50';

    try {
      await _waitForQRCode();
    } catch (e) {
      alert('ไม่สามารถสร้าง PNG ได้: ' + e.message);
      return;
    }

    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) { /* non-fatal */ }
    }

    var canvas   = _renderBulkToCanvas(rows, size);
    var filename = 'qr-bulk-' + size + '-' + _dateStamp() + '.png';
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
