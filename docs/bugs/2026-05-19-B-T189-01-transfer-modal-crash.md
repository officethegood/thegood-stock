# BUG-0.7-T189-01 — Transfer modal crashes on open

**Date:** 2026-05-19
**Severity:** Critical
**Blocking:** T189, T191, T192, T194, T202 (5 tests) — no transfers possible via UI
**Found by:** QA (Run 2 live functional test @ aefa347)
**Owner:** FE agent
**Status:** Fixed — verified in code 2026-07-15: no `wrap.firstChild` remains anywhere in js/shared; all modal factories use `firstElementChild` (transfer modal works in production since May)

---

## Title

`shared/transfer.js:openModal` crashes with `TypeError: t.getAttribute is not a function` — transfer modal never renders

---

## Steps to Reproduce

1. Log in as Admin at https://officethegood.github.io/thegood-stock/admin.html
2. Navigate to Inventory tab
3. Open any item with stock in a location
4. Click the "ย้าย" (Transfer) button
5. Observe: modal does not appear; console shows exception

**Cold cache:** same result (confirmed twice per QA protocol)
**Warm cache:** same result

---

## Expected

Transfer modal renders with source location selector and quantity input.

---

## Actual

Modal does not render. Console exception:

```
Uncaught (in promise) TypeError: t.getAttribute is not a function
    at getDataAttribute (bootstrap.bundle.min.js:5:6420)
    at _mergeConfigObj (bootstrap.bundle.min.js:5:6799)
    at _getConfig (bootstrap.bundle.min.js:5:7706)
    at W (bootstrap.bundle.min.js:5:7408)
    at On (bootstrap.bundle.min.js:5:51416)
    at openModal (shared/transfer.js:466:20)
```

---

## Environment

- Browser: Chrome desktop (Thegood browser, deviceId 91895557-b0c4-4315-813a-926bbbf6774d)
- OS: Windows 11 Pro 10.0.26200
- Viewport: 1278×1270
- URL: https://officethegood.github.io/thegood-stock/admin.html
- Commit: aefa347 (feat(phase0.7-fe): transfer modal + scanner fallback + bin/zone QR)
- Supabase project: xtjsjrfixngfdkaahton

---

## Root Cause

`shared/transfer.js` lines 350–352:

```javascript
const wrap = document.createElement('div');
wrap.innerHTML = `
  <div class="modal fade" id="transfer-modal" ...>
```

The template literal starts with a newline character. Therefore `wrap.firstChild` (line 465) is a Text node (nodeType=3), not the `<div>` element.

Line 467 then does:

```javascript
const bsModal = new bootstrap.Modal(modalEl);  // modalEl is a text node
```

Bootstrap's `Modal` constructor calls `element.getAttribute(...)` — which does not exist on a Text node — crash.

---

## Fix

`shared/transfer.js` line 465:

```diff
- const modalEl = wrap.firstChild;
+ const modalEl = wrap.firstElementChild;
```

`firstElementChild` skips Text/Comment nodes and returns the first actual Element child.

---

## Regression Risk

Low — single-line change, no logic change. After fix, re-run T189, T191, T192, T194, T202.

---

## Related

- BUG-0.7-T197-01 — same root cause in `shared/scanner.js:419` — must be fixed together
