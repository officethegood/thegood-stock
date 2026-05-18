// js/admin-shell.js

(async function () {
  const ok = await window.ensureLoggedIn();
  if (!ok) return;
  if (!window.requireRole('Admin')) return;

  document.getElementById('user-name').textContent = window.getUserName();

  try { await window.loadSettings(); }
  catch (e) { console.error('settings load failed', e); }

  document.getElementById('btn-logout').onclick = () => window.handleLogout();

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  const inits = {
    dashboard:  () => window.initDashboardTab  && window.initDashboardTab(),
    locations:  () => window.initLocationsTab  && window.initLocationsTab(),
    ambulances: () => window.initAmbulancesTab && window.initAmbulancesTab(),
    settings:   () => window.initSettingsTab   && window.initSettingsTab(),
    sessions:   () => window.initSessionsTab   && window.initSessionsTab(),
  };
  const initialized = new Set();

  function activateTab(name) {
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('d-none'));
    document.getElementById('tab-' + name).classList.remove('d-none');
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (!initialized.has(name)) { inits[name]?.(); initialized.add(name); }
  }
  activateTab('dashboard');
})();
