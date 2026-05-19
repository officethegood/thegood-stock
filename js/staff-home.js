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
  const bagsBtn = document.getElementById('btn-view-bags');
  if (bagsBtn) bagsBtn.onclick = renderBags;

  // Phase 0.7+ — Laundry quick-action buttons (Field Clinical card)
  if (window.Laundry) {
    const laundryCard = document.createElement('div');
    laundryCard.className = 'fc-card fc-reveal fc-reveal-4';
    laundryCard.style.cssText = 'margin-bottom:var(--fc-s4)';
    laundryCard.innerHTML = `
      <p class="fc-section-title" style="margin-bottom:var(--fc-s3)">ผ้าและของซัก</p>
      <div style="display:flex;flex-wrap:wrap;gap:var(--fc-s3)">
        <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('fill_vehicle')" style="min-height:44px;font-size:14px">
          <i class="bi bi-truck"></i> เติมรถ
        </button>
        <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('mark_dirty')" style="min-height:44px;font-size:14px">
          <i class="bi bi-droplet-half"></i> ใช้/เปื้อน +N
        </button>
        <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('send_wash')" style="min-height:44px;font-size:14px">
          <i class="bi bi-send"></i> ส่งซัก
        </button>
        <button class="fc-btn fc-btn-secondary" onclick="Laundry.openModal('receive_back')" style="min-height:44px;font-size:14px">
          <i class="bi bi-box-arrow-in-down"></i> รับคืน
        </button>
      </div>`;
    const detail = document.getElementById('staff-detail');
    if (detail && detail.parentNode) {
      detail.parentNode.insertBefore(laundryCard, detail);
    }
  }

  // Phase 5 — ถังออกซิเจน scan link (separate page) — use FC button
  const oxyLinkTarget = document.getElementById('staff-oxygen-link-wrap');
  if (!oxyLinkTarget) {
    const detail = document.getElementById('staff-detail');
    if (detail) {
      const wrap = document.createElement('div');
      wrap.className = 'fc-reveal fc-reveal-4';
      wrap.style.cssText = 'margin-bottom:var(--fc-s4)';
      wrap.innerHTML = `
        <a href="./staff-oxygen.html"
           class="fc-btn fc-btn-secondary"
           style="display:flex;justify-content:center;align-items:center;width:100%;min-height:52px;font-size:15px;font-weight:600;text-decoration:none">
          <i class="bi bi-circle-square me-2"></i>สแกนถังออกซิเจน
        </a>`;
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

async function renderBags() {
  const sb = getSupabaseClient();
  const root = document.getElementById('staff-detail');
  root.innerHTML = `<div class="text-muted small p-3"><i class="bi bi-hourglass-split me-1"></i>กำลังโหลด…</div>`;

  // Prefer v_bag_status (Phase 4 view with template completion + expiry rollup);
  // fall back to plain locations query if the view is unavailable.
  let rows = null;
  let usedView = false;
  try {
    const r = await sb.from('v_bag_status')
      .select('location_id,bag_code,bag_name,template_name,status,mandatory_deficit_count,mandatory_total,expired_lots_count,expiring_lots_count,nearest_expiry,bag_active')
      .order('bag_code');
    if (!r.error) { rows = r.data; usedView = true; }
  } catch (_) { /* fall through */ }

  if (!rows) {
    const r = await sb.from('locations')
      .select('id,code,name,active,parent_id')
      .eq('type', 'bag')
      .order('code');
    if (r.error) { root.innerHTML = `<div class="alert alert-danger">${r.error.message}</div>`; return; }
    rows = (r.data || []).map((l) => ({
      location_id: l.id, bag_code: l.code, bag_name: l.name, bag_active: l.active,
      template_name: null, status: null,
    }));
  }

  if (!rows.length) {
    root.innerHTML = `
      <div class="fc-empty">
        <svg class="fc-empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.2"><path d="M6 9V7a3 3 0 016 0v2M4 9h12l-1 11H5L4 9z"/></svg>
        <span class="fc-empty-label">// no als bags yet</span>
      </div>`;
    return;
  }

  function badge(status) {
    if (!status) return '<span class="fc-badge">—</span>';
    const cls = ({
      complete:    'fc-badge fc-badge-ok',
      partial:     'fc-badge fc-badge-warn',
      missing:     'fc-badge fc-badge-alert',
      no_template: 'fc-badge',
    })[status] || 'fc-badge';
    const label = ({
      complete:    'ครบ',
      partial:     'ไม่ครบ',
      missing:     'ขาดมาก',
      no_template: 'ไม่มี template',
    })[status] || status;
    return `<span class="${cls}">${escapeHtml(label)}</span>`;
  }

  root.innerHTML = `
    <div class="fc-card">
      <p class="fc-section-title" style="margin-bottom:var(--fc-s3)">
        <i class="bi bi-bag-heart me-1 text-stock-accent"></i>กระเป๋า ALS
        <span class="fc-mono" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fc-ink-mute);margin-left:var(--fc-s2)">${usedView ? 'with template status' : 'basic list'} · ${rows.length} bags</span>
      </p>
      <div style="overflow-x:auto">
        <table class="table table-sm mb-0" style="font-size:14px">
          <thead style="font-family:var(--fc-font-mono);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fc-ink-mute)">
            <tr>
              <th style="white-space:nowrap">Code</th>
              <th>ชื่อ</th>
              <th>Template</th>
              <th>Status</th>
              <th style="white-space:nowrap">ขาด/รวม</th>
              <th style="white-space:nowrap">หมดอายุ</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((b) => `
              <tr${b.bag_active === false ? ' style="opacity:0.5"' : ''}>
                <td><code class="fc-mono">${escapeHtml(b.bag_code)}</code></td>
                <td>${escapeHtml(b.bag_name)}</td>
                <td class="small text-muted">${b.template_name ? escapeHtml(b.template_name) : '—'}</td>
                <td>${badge(b.status)}</td>
                <td class="fc-mono small">${b.mandatory_total != null ? `${b.mandatory_deficit_count || 0}/${b.mandatory_total}` : '—'}</td>
                <td class="fc-mono small">${
                  b.expired_lots_count ? `<span style="color:var(--fc-pulse-red)">${b.expired_lots_count} หมด</span>` :
                  b.expiring_lots_count ? `<span style="color:var(--fc-amber)">${b.expiring_lots_count} ใกล้</span>` :
                  '—'
                }</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);margin-top:var(--fc-s3);margin-bottom:0">
        // staff อ่านอย่างเดียว · admin จัดการใน Console → ALS Bags
      </p>
    </div>`;
}
