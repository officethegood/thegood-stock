// js/warehouse-shell.js
// Sub-nav shell for the "คลัง" tab.
// Nests #tab-inventory / #tab-oxygen / #tab-bags so their init functions
// still find them by id — no changes to those files required.

(function () {
  const _SUBTABS = ['inventory', 'oxygen', 'bags'];
  const _LABELS  = [
    { key: 'inventory', icon: 'bi-box-seam',      label: 'สินค้า' },
    { key: 'oxygen',    icon: 'bi-circle-square',  label: 'ถังออกซิเจน' },
    { key: 'bags',      icon: 'bi-bag-heart',       label: 'ALS Bags' },
  ];
  const _INITS = {
    inventory: () => window.initInventoryTab && window.initInventoryTab(),
    oxygen:    () => window.initOxygenTab    && window.initOxygenTab(),
    bags:      () => window.initBagsTab      && window.initBagsTab(),
  };

  const _initialized = new Set();
  let _subTab = 'inventory';
  try {
    const saved = localStorage.getItem('warehouse_subtab');
    if (saved && _SUBTABS.includes(saved)) _subTab = saved;
  } catch {}

  const _BTN_BASE = 'border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em';

  function _renderShell() {
    const root = document.getElementById('tab-warehouse');
    if (!root) return;

    // Build segmented control HTML
    const btns = _LABELS.map(t =>
      `<button id="btn-wh-sub-${t.key}"
        class="fc-btn fc-btn-${_subTab === t.key ? 'primary' : 'ghost'}"
        style="${_BTN_BASE}">
        <i class="bi ${t.icon} me-1"></i>${t.label}
      </button>`
    ).join('');

    root.innerHTML = `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-box-seam me-2"></i>คลัง</h5>
        <div role="tablist" aria-label="warehouse section"
          style="display:inline-flex;border:1.5px solid var(--fc-vital,#00B8A9);border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,184,169,0.15);flex-wrap:wrap">
          ${btns}
        </div>
      </div>

      <div id="tab-inventory" class="${_subTab === 'inventory' ? '' : 'd-none'}"></div>
      <div id="tab-oxygen"    class="${_subTab === 'oxygen'    ? '' : 'd-none'}"></div>
      <div id="tab-bags"      class="${_subTab === 'bags'      ? '' : 'd-none'}"></div>
    `;

    _LABELS.forEach(t => {
      document.getElementById(`btn-wh-sub-${t.key}`).onclick = () => _switchSubTab(t.key);
    });

    // Run the default sub-tab init on first render
    _runInit(_subTab);
  }

  function _switchSubTab(name) {
    _subTab = name;
    try { localStorage.setItem('warehouse_subtab', name); } catch {}

    _SUBTABS.forEach(key => {
      const pane = document.getElementById('tab-' + key);
      if (pane) pane.classList.toggle('d-none', key !== name);
    });

    // Update button styles
    _LABELS.forEach(t => {
      const btn = document.getElementById(`btn-wh-sub-${t.key}`);
      if (!btn) return;
      btn.className = `fc-btn fc-btn-${name === t.key ? 'primary' : 'ghost'}`;
      btn.style.cssText = _BTN_BASE;
    });

    _runInit(name);
  }

  function _runInit(name) {
    if (_initialized.has(name)) return;
    _initialized.add(name);
    try { _INITS[name](); } catch (e) { console.error('warehouse init failed for', name, e); }
  }

  window.initWarehouseTab = function () {
    // Reset so each full tab activation re-renders the shell (sub-pane inits stay guarded by _initialized Set)
    _renderShell();
  };
})();
