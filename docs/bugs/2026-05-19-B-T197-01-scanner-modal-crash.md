# BUG-0.7-T197-01 — Scanner modal crashes on open (same root cause as B-T189-01)

**Date:** 2026-05-19
**Severity:** Critical
**Blocking:** T197, T205, T206 (3 tests) — camera scan path completely non-functional
**Found by:** QA (code inspection during Run 2 live functional test @ aefa347)
**Owner:** FE agent
**Status:** Open

---

## Title

`shared/scanner.js:_openScannerModal` crashes with `TypeError: t.getAttribute is not a function` — same `wrap.firstChild` bug as BUG-0.7-T189-01

---

## Steps to Reproduce

1. Trigger any action that calls `window.AppScanner.openForLocation()` (e.g. scan source location in transfer flow — if transfer modal bug T189-01 is fixed)
2. The scanner location modal fails to render
3. Console shows Bootstrap `getAttribute` crash from `scanner.js:421`

Note: This bug was found via code inspection, not live interaction, because the transfer modal crash (BUG-0.7-T189-01) prevents reaching the scanner. Fix B-T189-01 first, then reproduce this crash.

---

## Expected

Full-screen scanner modal opens with camera viewfinder and manual fallback button.

---

## Actual

Modal does not render. Console exception equivalent to BUG-0.7-T189-01 — Bootstrap Modal receives a Text node instead of an Element.

---

## Environment

- Same as BUG-0.7-T189-01
- Commit: aefa347
- File: `shared/scanner.js` lines 383–421

---

## Root Cause

`shared/scanner.js` lines 383–384:

```javascript
const wrap = document.createElement('div');
wrap.innerHTML = `
  <div class="modal fade" id="scanner-loc-modal" tabindex="-1" ...>
```

Template literal starts with a newline. Line 419:

```javascript
const modalEl = wrap.firstChild;  // Text node, not <div>
```

Line 421:

```javascript
const bsModal = new bootstrap.Modal(modalEl, { backdrop: 'static' });  // crash
```

Identical pattern to BUG-0.7-T189-01.

---

## Fix

`shared/scanner.js` line 419:

```diff
- const modalEl = wrap.firstChild;
+ const modalEl = wrap.firstElementChild;
```

---

## Regression Risk

Low — single-line change. After fix (both files), re-run T197 (camera permission denied flow), T205 (bin QR scan), T206 (zone QR scan).

---

## Related

- BUG-0.7-T189-01 — same root cause in `shared/transfer.js:465` — fix both together
