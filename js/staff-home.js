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

  // Phase 0.7+ — Laundry quick-action buttons
  if (window.Laundry) {
    const laundryCard = document.createElement('div');
    laundryCard.className = 'card mb-3';
    laundryCard.innerHTML = `
      <div class="card-body">
        <p class="mb-2"><strong>ผ้าและของซัก</strong></p>
        <div class="d-flex flex-wrap gap-2">
          <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('fill_vehicle')">
            <i class="bi bi-truck"></i> เติมรถ
          </button>
          <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('mark_dirty')">
            <i class="bi bi-droplet-half"></i> ใช้/เปื้อน +N
          </button>
          <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('send_wash')">
            <i class="bi bi-send"></i> ส่งซัก
          </button>
          <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('receive_back')">
            <i class="bi bi-box-arrow-in-down"></i> รับคืน
          </button>
        </div>
      </div>`;
    const detail = document.getElementById('staff-detail');
    if (detail && detail.parentNode) {
      detail.parentNode.insertBefore(laundryCard, detail);
    }
  }

  // Phase 5 — add ถังออกซิเจน scan link (Q-Phase5-6: separate page)
  const oxyLinkTarget = document.getElementById('staff-oxygen-link-wrap');
  if (!oxyLinkTarget) {
    // Inject button below the existing action buttons if no placeholder exists
    const detail = document.getElementById('staff-detail');
    if (detail) {
      const wrap = document.createElement('div');
      wrap.className = 'mt-3 d-grid';
      wrap.innerHTML = `
        <a href="./staff-oxygen.html"
           class="btn btn-outline-stock-accent"
           style="min-height:52px; font-size:1.05rem; font-weight:600;">
          <i class="bi bi-circle-square me-2"></i>สแกนถังออกซิเจน
        </a>
      `;
      detail.parentNode.insertBefore(wrap, detail);
    }
  }
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
