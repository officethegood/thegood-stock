// js/warehouse-shell.js
// Sub-nav shell for the "คลัง" tab.
// Nests #tab-inventory / #tab-oxygen / #tab-bags so their init functions
// still find them by id — no changes to those files required.
//
// Phase 6.1: "ผ้า" is a 4th sub-tab that does NOT get its own pane — it rides
// on the inventory pane (#tab-inventory), locked to the LINEN category via
// AppInventoryTab.enterLinenView(). Switching back to "สินค้า" calls
// exitLinenView(). This keeps all linen machinery in js/inventory.js (no
// duplicate module) while still presenting a dedicated ผ้า page.

(function () {
  // All selectable sub-tabs (order = display order).
  const _SUBTABS = ['inventory', 'linen', 'oxygen', 'bags', 'history'];
  // Actual DOM panes. 'linen' has none — it shares the inventory pane.
  const _PANES   = ['inventory', 'oxygen', 'bags', 'history'];
  const _LABELS  = [
    { key: 'inventory', icon: 'bi-box-seam',      label: 'สินค้า' },
    { key: 'linen',     icon: 'bi-basket',         label: 'ผ้า' },
    { key: 'oxygen',    icon: 'bi-circle-square',   label: 'ถังออกซิเจน' },
    { key: 'bags',      icon: 'bi-bag-heart',        label: 'ALS Bags' },
    { key: 'history',   icon: 'bi-clock-history',    label: 'ประวัติ' },
  ];

  // Which DOM pane backs a sub-tab. 'linen' rides on the inventory pane.
  const _paneOf = (key) => (key === 'linen' ? 'inventory' : key);

  const _initialized = new Set();   // tracks initialized PANES (inventory/oxygen/bags)
  let _subTab = 'inventory';
  try {
    const saved = localStorage.getItem('warehouse_subtab');
    if (saved && _SUBTABS.includes(saved)) _subTab = saved;
  } catch {}

  const _BTN_BASE = 'border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em';

  function _renderShell() {
    const root = document.getElementById('tab-warehouse');
    if (!root) return;

    const btns = _LABELS.map(t =>
      `<button id="btn-wh-sub-${t.key}"
        class="fc-btn fc-btn-${_subTab === t.key ? 'primary' : 'ghost'}"
        style="${_BTN_BASE}">
        <i class="bi ${t.icon} me-1"></i>${t.label}
      </button>`
    ).join('');

    const activePane = _paneOf(_subTab);

    root.innerHTML = `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-box-seam me-2"></i>คลัง</h5>
        <div role="tablist" aria-label="warehouse section"
          style="display:inline-flex;border:1.5px solid var(--fc-vital,#00B8A9);border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,184,169,0.15);flex-wrap:wrap">
          ${btns}
        </div>
      </div>

      <div id="tab-inventory" class="${activePane === 'inventory' ? '' : 'd-none'}"></div>
      <div id="tab-oxygen"    class="${activePane === 'oxygen'    ? '' : 'd-none'}"></div>
      <div id="tab-bags"      class="${activePane === 'bags'      ? '' : 'd-none'}"></div>
      <div id="tab-history"   class="${activePane === 'history'   ? '' : 'd-none'}"></div>
    `;

    _LABELS.forEach(t => {
      document.getElementById(`btn-wh-sub-${t.key}`).onclick = () => _switchSubTab(t.key);
    });

    // Run the default sub-tab init on first render
    _runForSubTab(_subTab);
  }

  function _switchSubTab(name) {
    _subTab = name;
    try { localStorage.setItem('warehouse_subtab', name); } catch {}

    const activePane = _paneOf(name);
    _PANES.forEach(p => {
      const pane = document.getElementById('tab-' + p);
      if (pane) pane.classList.toggle('d-none', p !== activePane);
    });

    // Update button styles
    _LABELS.forEach(t => {
      const btn = document.getElementById(`btn-wh-sub-${t.key}`);
      if (!btn) return;
      btn.className = `fc-btn fc-btn-${name === t.key ? 'primary' : 'ghost'}`;
      btn.style.cssText = _BTN_BASE;
    });

    _runForSubTab(name);
  }

  // Route a sub-tab to its init/mode. inventory + linen share one pane and one
  // module instance, differing only by linen-locked mode.
  function _runForSubTab(name) {
    if (name === 'inventory' || name === 'linen') {
      _ensureInventory(name === 'linen' ? 'linen' : 'normal');
    } else {
      _runInit(name);
    }
  }

  // Ensure the inventory pane is initialized, THEN apply the requested mode.
  // mode: 'linen' → enterLinenView() | 'normal' → exitLinenView().
  //
  // Caches the init() promise rather than flipping a flag up-front: a deep-link
  // (_gotoWarehouseSub clicks the warehouse tab → renders the default sub-tab →
  // then synchronously clicks another sub-tab button) can call this twice before
  // the first init resolves. Both callers must await the SAME init and only
  // enter/exit linen mode once the DOM (#inv-category, thead, subviews) exists —
  // otherwise enterLinenView/exitLinenView run against a half-built pane.
  let _invInitPromise = null;
  async function _ensureInventory(mode) {
    if (!_invInitPromise) {
      if (typeof window.initInventoryTab !== 'function') {
        console.error('warehouse: initInventoryTab missing');
        return;
      }
      _invInitPromise = Promise.resolve()
        .then(() => window.initInventoryTab())
        .catch((e) => { _invInitPromise = null; throw e; });   // allow retry
    }
    try {
      await _invInitPromise;
    } catch (e) {
      console.error('warehouse: inventory init failed', e);
      return;
    }
    const fn = mode === 'linen' ? 'enterLinenView' : 'exitLinenView';
    try { window.AppInventoryTab && window.AppInventoryTab[fn] && window.AppInventoryTab[fn](); }
    catch (e) { console.error('warehouse: inventory mode switch failed', e); }
  }

  // oxygen / bags — plain one-time init (inventory handled by _ensureInventory).
  function _runInit(name) {
    if (_initialized.has(name)) return;
    const fnName = { oxygen: 'initOxygenTab', bags: 'initBagsTab', history: 'initInventoryHistory' }[name];
    // Don't mark a sub-tab "initialized" if its init function isn't loaded —
    // otherwise a script-order regression leaves a permanently blank pane.
    if (typeof window[fnName] !== 'function') {
      console.error('warehouse: init function missing for', name, '(' + fnName + ')');
      return;  // not added to _initialized → will retry on next switch
    }
    _initialized.add(name);
    try { window[fnName](); } catch (e) { console.error('warehouse init failed for', name, e); }
  }

  window.initWarehouseTab = function () {
    // admin-shell calls this once (lazy init guarded there). Re-render the shell.
    _renderShell();
  };
})();
