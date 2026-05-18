// js/staff-home.js

(async function () {
  const ok = await window.ensureLoggedIn();
  if (!ok) return;
  if (window.getUserRole() === 'Admin') {
    const greet = document.getElementById('staff-greeting');
    if (greet) greet.insertAdjacentHTML('beforeend',
      ' <a href="./admin.html" class="ms-2 small">(ไปหน้า Admin)</a>');
  }

  try { await window.loadSettings(); } catch {}

  document.getElementById('user-name').textContent = window.getUserName();
  document.getElementById('btn-logout').onclick    = () => window.handleLogout();

  document.getElementById('btn-view-loc').onclick = renderLocations;
  document.getElementById('btn-view-amb').onclick = renderAmbulances;
})();

async function renderLocations() {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('locations')
    .select('code,name,type,active,parent_id').order('type').order('code');
  const root = document.getElementById('staff-detail');
  if (error) { root.innerHTML = `<div class="alert alert-danger">${error.message}</div>`; return; }
  root.innerHTML = `
    <h6>สถานที่จัดเก็บ (อ่านอย่างเดียว)</h6>
    <table class="table table-sm">
      <thead><tr><th>Code</th><th>Type</th><th>ชื่อ</th><th>Active</th></tr></thead>
      <tbody>${data.map((l) => `<tr>
        <td><code>${escapeHtml(l.code)}</code></td>
        <td>${escapeHtml(l.type)}</td>
        <td>${escapeHtml(l.name)}</td>
        <td>${l.active ? '✓' : '✗'}</td>
      </tr>`).join('')}</tbody>
    </table>
  `;
}

async function renderAmbulances() {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('ambulances').select('plate,callsign,active').order('plate');
  const root = document.getElementById('staff-detail');
  if (error) { root.innerHTML = `<div class="alert alert-danger">${error.message}</div>`; return; }
  root.innerHTML = `
    <h6>รถพยาบาล (อ่านอย่างเดียว)</h6>
    <table class="table table-sm">
      <thead><tr><th>Plate</th><th>Callsign</th><th>Active</th></tr></thead>
      <tbody>${data.map((a) => `<tr>
        <td><code>${escapeHtml(a.plate)}</code></td>
        <td>${escapeHtml(a.callsign || '—')}</td>
        <td>${a.active ? '✓' : '✗'}</td>
      </tr>`).join('')}</tbody>
    </table>
  `;
}
