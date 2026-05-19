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

// Persisted view mode for staff locations: 'graph' (default) | 'table'
let __locView = (typeof localStorage !== 'undefined' && localStorage.getItem('staff_loc_view')) || 'graph';

async function renderLocations() {
  const sb = getSupabaseClient();
  const root = document.getElementById('staff-detail');
  root.innerHTML = `<div class="text-muted small p-3"><i class="bi bi-hourglass-split me-1"></i>กำลังโหลด…</div>`;

  const { data, error } = await sb.from('locations')
    .select('id,code,name,type,active,parent_id,storage_style,laundry_role,ambulance_id,ambulances(plate,callsign)')
    .order('type').order('code');
  if (error) { root.innerHTML = `<div class="alert alert-danger">${escapeHtml(error.message)}</div>`; return; }

  function viewToggle(active) {
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--fc-s3);gap:var(--fc-s3);flex-wrap:wrap">
        <p class="fc-section-title" style="margin:0">
          <i class="bi bi-diagram-3 me-1 text-stock-accent"></i>สถานที่จัดเก็บ
          <span class="fc-mono" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fc-ink-mute);margin-left:var(--fc-s2)">${data.length} nodes</span>
        </p>
        <div role="tablist" aria-label="view mode" style="display:inline-flex;border:1px solid var(--fc-hairline-strong, rgba(12,25,41,0.15));border-radius:6px;overflow:hidden">
          <button id="btn-locview-graph" class="fc-btn fc-btn-${active==='graph'?'primary':'ghost'}" style="border-radius:0;border:none;padding:6px 12px;min-height:36px;font-size:13px"><i class="bi bi-diagram-2 me-1"></i>Graph</button>
          <button id="btn-locview-table" class="fc-btn fc-btn-${active==='table'?'primary':'ghost'}" style="border-radius:0;border:none;padding:6px 12px;min-height:36px;font-size:13px"><i class="bi bi-table me-1"></i>ตาราง</button>
        </div>
      </div>`;
  }

  // Build parent chain (root → leaf) for one location using the locations array.
  // Returns { depth, pathNames: string[], parent: locationRow | null }
  function _buildChain(l, all) {
    const chain = [];
    let cur = l;
    let guard = 0;
    while (cur && guard < 8) {
      chain.unshift(cur);
      cur = cur.parent_id ? all.find((x) => x.id === cur.parent_id) : null;
      guard++;
    }
    return {
      depth: chain.length - 1,
      pathNames: chain.map((c) => c.name),
      parent: chain.length > 1 ? chain[chain.length - 2] : null,
    };
  }

  // Sort key: full path string so siblings group naturally under their parent.
  // Roots ordered by type (room before ambulance before bag) then code.
  function _sortKey(l, all) {
    const chain = _buildChain(l, all);
    const typeOrder = { room: 1, ambulance: 2, bag: 3, storage: 4, cabinet: 4, shelf: 5, bin: 6, zone: 7 };
    const rootType = typeOrder[chain.pathNames.length ? all.find((x) => x.id === l.id)?.type : 99] || 99;
    return chain.pathNames.join('|') + '|' + l.code;
  }

  function _typeBadge(type) {
    const meta = {
      room:      { label: 'ห้อง',     bg: '#0c1929', fg: '#f8f5ef' },
      ambulance: { label: 'รถ',       bg: '#1d4d8c', fg: '#f8f5ef' },
      storage:   { label: 'ตู้',       bg: '#e6f7f5', fg: '#00574F' },
      cabinet:   { label: 'ตู้',       bg: '#e6f7f5', fg: '#00574F' },
      shelf:     { label: 'ชั้น',      bg: '#f0f3f7', fg: '#3a4a5c' },
      bin:       { label: 'ตะกร้า',    bg: '#fafbfc', fg: '#5a6a7c' },
      bag:       { label: 'กระเป๋า',   bg: '#f59e0b', fg: '#ffffff' },
      zone:      { label: 'Zone',     bg: '#fff7e6', fg: '#7a4f00' },
    }[type] || { label: type, bg: '#eee', fg: '#333' };
    return `<span class="fc-mono" style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:0.05em;background:${meta.bg};color:${meta.fg};font-weight:600">${escapeHtml(meta.label)}</span>`;
  }

  function renderTable() {
    // Sort: by full path so children appear under their parent
    const sorted = [...data].sort((a, b) => _sortKey(a, data).localeCompare(_sortKey(b, data), 'th'));

    const rowsHtml = sorted.map((l) => {
      const chain = _buildChain(l, data);
      const indent = chain.depth * 18; // px
      const arrow = chain.depth > 0 ? '<span style="color:var(--fc-ink-mute);margin-right:6px">└</span>' : '';
      const parentLabel = chain.parent
        ? `<code class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);background:transparent;padding:0">${escapeHtml(chain.parent.code)}</code>`
        : '<span class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);opacity:0.5">—</span>';
      const pathLabel = chain.pathNames.length > 1
        ? `<span class="small" style="color:var(--fc-ink-mute);font-size:12px">${chain.pathNames.slice(0, -1).map((n) => escapeHtml(n)).join(' › ')}</span>`
        : '<span class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);opacity:0.5">root</span>';
      const meta = [];
      if (l.storage_style) {
        const sLabel = ({closed:'ตู้ปิด',open:'ชั้นเปิด',mesh:'ตะแกรง',drawer:'ลิ้นชัก'})[l.storage_style] || l.storage_style;
        meta.push(`<span class="fc-mono small" style="color:var(--fc-ink-mute);font-size:11px">(${sLabel})</span>`);
      }
      if (l.laundry_role) {
        const rLabel = ({clean:'พร้อมใช้',vehicle:'ในรถ',dirty:'รอซัก',external:'กำลังซัก'})[l.laundry_role] || l.laundry_role;
        meta.push(`<span class="fc-mono small" style="color:#0c574f;font-size:11px;background:#e6f7f5;padding:1px 6px;border-radius:3px">🧺 ${rLabel}</span>`);
      }
      return `
        <tr${l.active===false?' style="opacity:0.5"':''}>
          <td style="padding-left:${12 + indent}px;white-space:nowrap">
            ${arrow}<code class="fc-mono">${escapeHtml(l.code)}</code>
          </td>
          <td>${_typeBadge(l.type)}</td>
          <td>
            <div>${escapeHtml(l.name)}</div>
            <div style="margin-top:2px">${pathLabel}</div>
          </td>
          <td>${parentLabel}</td>
          <td class="small">${meta.join(' ') || '<span style="opacity:0.4">—</span>'}</td>
          <td style="text-align:center">${l.active ? '<span style="color:var(--fc-ok,#10b981)">✓</span>' : '<span style="color:var(--fc-pulse-red,#E63946)">✗</span>'}</td>
        </tr>`;
    }).join('');

    root.innerHTML = `
      <div class="fc-card">
        ${viewToggle('table')}
        <p class="fc-mono" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fc-ink-mute);margin-bottom:var(--fc-s3)">เรียงตามลำดับชั้น — ลูกอยู่ใต้พ่อแม่ของมัน</p>
        <div style="overflow-x:auto">
          <table class="table table-sm mb-0" style="font-size:14px">
            <thead style="font-family:var(--fc-font-mono);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fc-ink-mute)">
              <tr>
                <th style="white-space:nowrap">Code</th>
                <th>Type</th>
                <th>ชื่อ / Path</th>
                <th>Parent</th>
                <th>Meta</th>
                <th style="text-align:center">Active</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <p class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);margin-top:var(--fc-s3);margin-bottom:0">// อ่านอย่างเดียว · admin จัดการใน Console → สถานที่</p>
      </div>`;
    document.getElementById('btn-locview-graph').onclick = () => { __locView='graph'; try{localStorage.setItem('staff_loc_view','graph')}catch{}; renderGraph(); };
    document.getElementById('btn-locview-table').onclick = () => {};
  }

  async function renderGraph() {
    root.innerHTML = `
      <div class="fc-card">
        ${viewToggle('graph')}
        <div id="loc-graph-host"></div>
        <p class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);margin-top:var(--fc-s3);margin-bottom:0">// อ่านอย่างเดียว · room/ambulance → storage → shelf → bin · bag → zone</p>
      </div>`;
    document.getElementById('btn-locview-graph').onclick = () => {};
    document.getElementById('btn-locview-table').onclick = () => { __locView='table'; try{localStorage.setItem('staff_loc_view','table')}catch{}; renderTable(); };

    const host = document.getElementById('loc-graph-host');
    if (window.LocationsGraph) {
      await window.LocationsGraph.render(host, data, { showLegend: true, maxHeight: '70vh' });
    } else {
      host.innerHTML = `<div class="alert alert-warning small">Graph module ไม่ได้โหลด — ลอง switch ไป "ตาราง"</div>`;
    }
  }

  if (__locView === 'table') renderTable(); else await renderGraph();
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
