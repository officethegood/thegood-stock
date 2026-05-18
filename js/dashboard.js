// js/dashboard.js

window.initDashboardTab = async function () {
  const root = document.getElementById('tab-dashboard');

  root.innerHTML = `
    <div class="card border-stock-accent">
      <div class="card-body">
        <h5 class="card-title text-stock-accent">Phase 0 Foundation — สถานะระบบ</h5>
        <ul class="list-unstyled mb-3" id="dash-status">
          <li>กำลังตรวจสอบ…</li>
        </ul>
        <p class="text-muted small mb-0">📊 Dashboard สำหรับสต๊อก / แจ้งเตือนจะเปิดใช้งานใน Phase 1 ขึ้นไป</p>
      </div>
    </div>
  `;

  const sb = getSupabaseClient();
  const [locRes, ambRes, ambSyncRes, tgRes] = await Promise.all([
    sb.from('locations').select('id', { count: 'exact', head: true }),
    sb.from('ambulances').select('id', { count: 'exact', head: true }),
    sb.from('ambulances').select('last_synced_at').order('last_synced_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('settings').select('value').eq('key', 'NOTIFY_TELEGRAM_ENABLED').maybeSingle(),
  ]);

  const lastSync = ambSyncRes?.data?.last_synced_at;
  const tgOn     = tgRes?.data?.value === 'true';

  document.getElementById('dash-status').innerHTML = `
    <li>✓ Auth พร้อม</li>
    <li>✓ DB เชื่อมต่อ <code>thegood-stock</code></li>
    <li>${(locRes.count ?? 0) > 0 ? '✓' : '⚠'} Locations: <strong>${locRes.count ?? 0}</strong></li>
    <li>${(ambRes.count ?? 0) > 0 ? '✓' : '⚠'} Ambulances: <strong>${ambRes.count ?? 0}</strong> ${lastSync ? `(last sync: ${new Date(lastSync).toLocaleString('th-TH')})` : ''}</li>
    <li>${tgOn ? '✓' : '⚠'} Telegram: <strong>${tgOn ? 'เปิด' : 'ปิดอยู่'}</strong> — ตั้งค่าได้ที่แท็บ Settings</li>
  `;
};
