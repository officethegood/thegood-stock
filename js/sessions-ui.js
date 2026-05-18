// js/sessions-ui.js

(function () {
  function fmt(s) { return s ? new Date(s).toLocaleString('th-TH') : '—'; }

  async function render() {
    const root = document.getElementById('tab-sessions');
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('user_sessions')
      .select('id,username,name,role,ip,user_agent,issued_at,expires_at,refresh_expires_at,revoked,last_seen_at')
      .order('issued_at', { ascending: false }).limit(100);
    if (error) { showToast('error', error.message); return; }

    root.innerHTML = `
      <h5 class="mb-3"><i class="bi bi-people"></i> Sessions Audit (ล่าสุด 100)</h5>
      <div class="card"><div class="card-body p-0">
        <table class="table table-sm mb-0">
          <thead><tr><th>User</th><th>Role</th><th>IP</th><th>Issued</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${data.map((s) => `
              <tr class="${s.revoked ? 'text-muted' : ''}">
                <td>${escapeHtml(s.name || s.username)} <small class="text-muted">@${escapeHtml(s.username)}</small></td>
                <td>${escapeHtml(s.role)}</td>
                <td><code class="small">${escapeHtml(s.ip || '—')}</code></td>
                <td>${fmt(s.issued_at)}</td>
                <td>${fmt(s.last_seen_at)}</td>
                <td>${s.revoked ? 'revoked' : (new Date(s.refresh_expires_at) < new Date() ? 'expired' : 'active')}</td>
                <td>${!s.revoked ? `<button class="btn btn-sm btn-outline-danger" data-revoke="${s.id}">revoke</button>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div></div>
    `;
    root.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => {
        const ok = await showConfirm('ตัดสิทธิ์ session นี้?');
        if (!ok) return;
        const { error } = await sb.from('user_sessions').update({ revoked: true }).eq('id', b.dataset.revoke);
        if (error) showToast('error', error.message);
        else { showToast('success', 'revoked'); render(); }
      };
    });
  }

  window.initSessionsTab = render;
})();
