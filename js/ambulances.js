// js/ambulances.js

(function () {
  async function load() {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('ambulances')
      .select('id,gas_id,plate,callsign,active,last_synced_at')
      .order('plate');
    if (error) throw error;
    return data;
  }

  async function loadLocLinks() {
    const sb = getSupabaseClient();
    const { data } = await sb.from('locations')
      .select('id,code,ambulance_id')
      .eq('type', 'ambulance');
    const map = new Map();
    for (const l of data || []) map.set(l.ambulance_id, l);
    return map;
  }

  function fmtDate(s) { return s ? new Date(s).toLocaleString('th-TH') : '—'; }

  async function render() {
    const root = document.getElementById('tab-ambulances');
    const [list, linkMap] = await Promise.all([load(), loadLocLinks()]);

    const lastSync = list.reduce((acc, r) => {
      if (!r.last_synced_at) return acc;
      return acc && acc > r.last_synced_at ? acc : r.last_synced_at;
    }, null);

    root.innerHTML = `
      <div class="d-flex align-items-center mb-2">
        <h5 class="mb-0 me-auto"><i class="bi bi-truck"></i> รถพยาบาล</h5>
        <button class="btn btn-stock-primary" id="btn-sync-amb"><i class="bi bi-arrow-clockwise"></i> ซิงค์จาก GAS</button>
      </div>
      <p class="text-muted small">Last sync: ${fmtDate(lastSync)} — ${list.length} คัน</p>
      <div class="card"><div class="card-body p-0">
        <table class="table table-sm mb-0">
          <thead><tr><th>Plate</th><th>Callsign</th><th>Status</th><th>Location?</th><th></th></tr></thead>
          <tbody>
            ${list.map((a) => `
              <tr>
                <td><code>${escapeHtml(a.plate)}</code></td>
                <td>${escapeHtml(a.callsign || '—')}</td>
                <td>${a.active ? '<span class="text-success">✓ active</span>' : '<span class="text-muted">✗ inactive</span>'}</td>
                <td>${linkMap.get(a.id) ? `<code class="small">${escapeHtml(linkMap.get(a.id).code)}</code>` : '<span class="text-muted">—</span>'}</td>
                <td><button class="btn btn-sm btn-link" data-id="${a.id}">${linkMap.get(a.id) ? 'แก้ Location' : '+ Location'}</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div></div>
    `;

    document.getElementById('btn-sync-amb').onclick = doSync;
    root.querySelectorAll('button[data-id]').forEach((b) => {
      b.onclick = () => {
        showToast('info', 'ไปที่แท็บ Locations แล้วเลือก type=ambulance');
      };
    });
  }

  async function doSync() {
    const btn = document.getElementById('btn-sync-amb');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังซิงค์...';
    try {
      const res = await fetch(CONFIG.SUPABASE_URL + CONFIG.EDGE_SYNC_AMBU, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAccessToken()}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('error', `ซิงค์ล้มเหลว: ${data.error}`);
      } else {
        showToast('success', `ซิงค์สำเร็จ: ${data.upserted} คัน, deactivated ${data.deactivated} (${data.duration_ms}ms)`);
        await render();
      }
    } catch (e) {
      showToast('error', e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> ซิงค์จาก GAS';
    }
  }

  window.initAmbulancesTab = async function () {
    try { await render(); }
    catch (e) { showToast('error', e.message); }
  };
})();
