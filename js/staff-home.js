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

  function renderTable() {
    root.innerHTML = `
      <div class="fc-card">
        ${viewToggle('table')}
        <div style="overflow-x:auto">
          <table class="table table-sm mb-0" style="font-size:14px">
            <thead style="font-family:var(--fc-font-mono);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fc-ink-mute)">
              <tr><th>Code</th><th>Type</th><th>ชื่อ</th><th>Active</th></tr>
            </thead>
            <tbody>
              ${data.map((l) => `<tr${l.active===false?' style="opacity:0.5"':''}>
                <td><code class="fc-mono">${escapeHtml(l.code)}</code></td>
                <td class="small text-muted">${escapeHtml(l.type)}</td>
                <td>${escapeHtml(l.name)}</td>
                <td>${l.active ? '✓' : '✗'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);margin-top:var(--fc-s3);margin-bottom:0">// อ่านอย่างเดียว · admin จัดการใน Console → สถานที่</p>
      </div>`;
    document.getElementById('btn-locview-graph').onclick = () => { __locView='graph'; try{localStorage.setItem('staff_loc_view','graph')}catch{}; renderGraph(); };
    document.getElementById('btn-locview-table').onclick = () => {};
  }

  function nodeLabel(l) {
    // Mermaid node label: code on line 1, name on line 2, optional metadata line 3
    const lines = [escapeMer(l.code), escapeMer(l.name)];
    if (l.type === 'storage' && l.storage_style) {
      const styleLabel = ({closed:'ตู้ปิด',open:'ชั้นเปิด',mesh:'ตะแกรง',drawer:'ลิ้นชัก'})[l.storage_style] || l.storage_style;
      lines.push(`(${styleLabel})`);
    }
    if (l.laundry_role) {
      const roleLabel = ({clean:'พร้อมใช้',vehicle:'ในรถ',dirty:'รอซัก',external:'กำลังซัก'})[l.laundry_role] || l.laundry_role;
      lines.push(`🧺 ${roleLabel}`);
    }
    if (l.type === 'ambulance' && l.ambulances) {
      const plate = l.ambulances.plate || '';
      const cs = l.ambulances.callsign ? ` · ${l.ambulances.callsign}` : '';
      lines.push(`${plate}${cs}`);
    }
    return lines.join('<br/>');
  }

  function escapeMer(s) {
    // Mermaid node text in [" ... "] — escape quotes
    return String(s ?? '').replace(/"/g, '#quot;');
  }

  function buildMermaid() {
    const lines = ['graph TD'];
    // Nodes
    data.forEach((l) => {
      const safeId = `n_${l.id.replace(/-/g, '_')}`;
      lines.push(`  ${safeId}["${nodeLabel(l)}"]:::${l.type}`);
    });
    // Edges (parent → child)
    data.forEach((l) => {
      if (l.parent_id) {
        const parent = data.find((p) => p.id === l.parent_id);
        if (parent) {
          const pId = `n_${parent.id.replace(/-/g, '_')}`;
          const cId = `n_${l.id.replace(/-/g, '_')}`;
          lines.push(`  ${pId} --> ${cId}`);
        }
      }
    });
    // FC-themed class definitions
    lines.push(`  classDef room      fill:#0c1929,stroke:#00B8A9,color:#f8f5ef,stroke-width:2px`);
    lines.push(`  classDef ambulance fill:#1d4d8c,stroke:#00B8A9,color:#f8f5ef,stroke-width:2px`);
    lines.push(`  classDef storage   fill:#f8f5ef,stroke:#00B8A9,color:#0c1929,stroke-width:1.5px`);
    lines.push(`  classDef cabinet   fill:#f8f5ef,stroke:#00B8A9,color:#0c1929,stroke-width:1.5px`);
    lines.push(`  classDef shelf     fill:#ffffff,stroke:#7a8a9a,color:#0c1929,stroke-width:1px`);
    lines.push(`  classDef bin       fill:#ffffff,stroke:#a8b4c0,color:#0c1929,stroke-width:1px`);
    lines.push(`  classDef bag       fill:#f59e0b,stroke:#7a4f00,color:#ffffff,stroke-width:2px`);
    lines.push(`  classDef zone      fill:#fff7e6,stroke:#f59e0b,color:#7a4f00,stroke-width:1px`);
    return lines.join('\n');
  }

  async function renderGraph() {
    root.innerHTML = `
      <div class="fc-card">
        ${viewToggle('graph')}
        <div style="display:flex;flex-wrap:wrap;gap:var(--fc-s3);margin-bottom:var(--fc-s3);font-size:11px;font-family:var(--fc-font-mono);letter-spacing:0.05em;text-transform:uppercase;color:var(--fc-ink-mute)">
          <span><span style="display:inline-block;width:10px;height:10px;background:#0c1929;border:2px solid #00B8A9;vertical-align:middle;margin-right:4px"></span>room/ambulance</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#f8f5ef;border:1.5px solid #00B8A9;vertical-align:middle;margin-right:4px"></span>storage</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#fff;border:1px solid #7a8a9a;vertical-align:middle;margin-right:4px"></span>shelf/bin</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#f59e0b;border:2px solid #7a4f00;vertical-align:middle;margin-right:4px"></span>bag/zone</span>
        </div>
        <div id="loc-graph" style="overflow:auto;max-height:70vh;border:1px solid var(--fc-hairline-strong, rgba(12,25,41,0.08));border-radius:8px;padding:var(--fc-s4);background:repeating-linear-gradient(0deg,transparent,transparent 19px,rgba(12,25,41,0.04) 19px,rgba(12,25,41,0.04) 20px),repeating-linear-gradient(90deg,transparent,transparent 19px,rgba(12,25,41,0.04) 19px,rgba(12,25,41,0.04) 20px),#fafbfc">
          <pre class="mermaid" style="background:transparent;margin:0">${buildMermaid()}</pre>
        </div>
        <p class="fc-mono" style="font-size:11px;color:var(--fc-ink-mute);margin-top:var(--fc-s3);margin-bottom:0">// อ่านอย่างเดียว · room/ambulance → storage → shelf → bin · bag → zone</p>
      </div>`;
    document.getElementById('btn-locview-graph').onclick = () => {};
    document.getElementById('btn-locview-table').onclick = () => { __locView='table'; try{localStorage.setItem('staff_loc_view','table')}catch{}; renderTable(); };
    if (window.mermaid) {
      try {
        mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: {
          fontFamily: 'Sarabun, IBM Plex Sans Thai, sans-serif', fontSize: '13px',
          lineColor: '#7a8a9a', primaryColor: '#f8f5ef', primaryTextColor: '#0c1929'
        }});
        await mermaid.run({ nodes: root.querySelectorAll('pre.mermaid') });
      } catch (e) {
        console.warn('mermaid render failed', e);
        const g = document.getElementById('loc-graph');
        if (g) g.innerHTML = `<div class="alert alert-warning small">วาด graph ไม่สำเร็จ — ลอง switch ไป "ตาราง"</div>`;
      }
    } else {
      const g = document.getElementById('loc-graph');
      if (g) g.innerHTML = `<div class="alert alert-warning small">Mermaid ไม่ได้โหลด — ลอง switch ไป "ตาราง"</div>`;
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
