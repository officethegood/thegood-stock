// js/settings-ui.js

(function () {
  function v(key, fallback) {
    const x = settingsGet(key);
    return x == null ? (fallback ?? '') : x;
  }

  // Sub-tab persistence: 'system' (default) | 'ambulances'
  let _subTab = (typeof localStorage !== 'undefined' && localStorage.getItem('settings_subtab')) || 'system';

  function _renderShell(activeSub) {
    return `
      <div class="d-flex align-items-center mb-3 flex-wrap gap-2">
        <h5 class="mb-0 me-auto fc-display"><i class="bi bi-gear me-2"></i>ตั้งค่า</h5>
        <div role="tablist" aria-label="settings section" style="display:inline-flex;border:1.5px solid var(--fc-vital,#00B8A9);border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,184,169,0.15)">
          <button id="btn-set-sub-system"     class="fc-btn fc-btn-${activeSub==='system'?'primary':'ghost'}"     style="border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em"><i class="bi bi-gear me-1"></i>ระบบ</button>
          <button id="btn-set-sub-ambulances" class="fc-btn fc-btn-${activeSub==='ambulances'?'primary':'ghost'}" style="border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em"><i class="bi bi-truck me-1"></i>รถพยาบาล</button>
        </div>
      </div>

      <!-- System settings pane -->
      <div id="settings-pane-system" class="${activeSub==='system'?'':'d-none'}"></div>

      <!-- Ambulances pane — the ambulances.js render() targets #tab-ambulances. -->
      <div id="tab-ambulances" class="${activeSub==='ambulances'?'':'d-none'}"></div>
    `;
  }

  function _renderSystemPane() {
    const host = document.getElementById('settings-pane-system');
    if (!host) return;
    host.innerHTML = `
      <div class="card mb-3"><div class="card-body">
        <h6>การแจ้งเตือน Telegram</h6>
        <div class="form-check form-switch mb-2">
          <input class="form-check-input" type="checkbox" id="s-tg-enabled" ${v('NOTIFY_TELEGRAM_ENABLED') === 'true' ? 'checked' : ''}>
          <label class="form-check-label" for="s-tg-enabled">เปิดใช้งานการแจ้งเตือน</label>
        </div>
        <div class="row g-2 mb-2">
          <div class="col-md-6"><label class="form-label small">Chat ID</label>
            <input class="form-control" id="s-tg-chat" value="${escapeHtml(v('NOTIFY_TELEGRAM_CHAT_ID'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">เวลาสรุปประจำวัน (HH)</label>
            <input class="form-control" id="s-tg-hour" type="number" min="0" max="23" value="${escapeHtml(v('NOTIFY_CRON_HOUR'))}">
          </div>
        </div>
        <button class="btn btn-outline-stock-accent btn-sm" id="btn-test-tg">ทดสอบส่ง Telegram</button>
      </div></div>

      <div class="card mb-3"><div class="card-body">
        <h6>เกณฑ์การแจ้งเตือน</h6>
        <div class="row g-2">
          <div class="col-md-3"><label class="form-label small">Dedupe window (ชม.)</label>
            <input class="form-control" id="s-dedupe" type="number" value="${escapeHtml(v('LOW_STOCK_DEDUPE_HOURS'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">Expiry alert (วัน)</label>
            <input class="form-control" id="s-expiry" value="${escapeHtml(v('EXPIRY_ALERT_DAYS'))}">
          </div>
          <div class="col-md-3"><label class="form-label small">Oxygen refill threshold</label>
            <input class="form-control" id="s-o2" type="number" value="${escapeHtml(v('OXYGEN_REFILL_THRESHOLD'))}">
          </div>
        </div>
      </div></div>

      <div class="card mb-3"><div class="card-body">
        <h6>ภายนอกระบบ</h6>
        <label class="form-label small">Ambulance GAS URL</label>
        <input class="form-control" id="s-amb-url" value="${escapeHtml(v('AMBULANCE_GAS_URL'))}">
      </div></div>

      <button class="btn btn-stock-primary" id="btn-save-settings">บันทึกการตั้งค่า</button>
    `;
  }

  function _wireSystemHandlers() {
    document.getElementById('btn-save-settings').onclick = async () => {
      try {
        await settingsSet({
          NOTIFY_TELEGRAM_ENABLED: document.getElementById('s-tg-enabled').checked ? 'true' : 'false',
          NOTIFY_TELEGRAM_CHAT_ID: document.getElementById('s-tg-chat').value.trim(),
          NOTIFY_CRON_HOUR:        document.getElementById('s-tg-hour').value.trim(),
          LOW_STOCK_DEDUPE_HOURS:  document.getElementById('s-dedupe').value.trim(),
          EXPIRY_ALERT_DAYS:       document.getElementById('s-expiry').value.trim(),
          OXYGEN_REFILL_THRESHOLD: document.getElementById('s-o2').value.trim(),
          AMBULANCE_GAS_URL:       document.getElementById('s-amb-url').value.trim(),
        });
        showToast('success', 'บันทึกการตั้งค่าแล้ว');
      } catch (e) { showToast('error', e.message); }
    };

    document.getElementById('btn-test-tg').onclick = async () => {
      const res = await notifyManualTest('ทดสอบส่งจาก Thegood Stock — ' + new Date().toLocaleString('th-TH'));
      if (res?.sent)              showToast('success', 'ส่งสำเร็จ ตรวจ Telegram chat');
      else if (res?.reason === 'disabled') showToast('warning', 'Telegram ปิดอยู่ — เปิดและบันทึกก่อน');
      else                        showToast('error', 'ส่งไม่สำเร็จ: ' + (res?.error || 'unknown'));
    };
  }

  function _switchSubTab(name) {
    _subTab = name;
    try { localStorage.setItem('settings_subtab', name); } catch {}
    document.getElementById('settings-pane-system').classList.toggle('d-none', name !== 'system');
    document.getElementById('tab-ambulances').classList.toggle('d-none', name !== 'ambulances');
    // Update sub-nav button visuals
    document.getElementById('btn-set-sub-system').className = `fc-btn fc-btn-${name==='system'?'primary':'ghost'}`;
    document.getElementById('btn-set-sub-system').style.cssText = 'border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em';
    document.getElementById('btn-set-sub-ambulances').className = `fc-btn fc-btn-${name==='ambulances'?'primary':'ghost'}`;
    document.getElementById('btn-set-sub-ambulances').style.cssText = 'border-radius:0;border:none;padding:8px 16px;min-height:40px;font-size:13px;font-weight:600;letter-spacing:0.02em';
    if (name === 'ambulances') {
      // Initialize ambulances UI on first display
      if (window.initAmbulancesTab) {
        try { window.initAmbulancesTab(); } catch (e) { showToast('error', e.message || 'โหลด ambulances ไม่สำเร็จ'); }
      }
    }
  }

  window.initSettingsTab = function () {
    const root = document.getElementById('tab-settings');
    root.innerHTML = _renderShell(_subTab);
    _renderSystemPane();
    _wireSystemHandlers();
    document.getElementById('btn-set-sub-system').onclick     = () => _switchSubTab('system');
    document.getElementById('btn-set-sub-ambulances').onclick = () => _switchSubTab('ambulances');
    // If saved sub-tab was ambulances, init it now
    if (_subTab === 'ambulances' && window.initAmbulancesTab) {
      try { window.initAmbulancesTab(); } catch (e) { showToast('error', e.message || 'โหลด ambulances ไม่สำเร็จ'); }
    }
  };
})();
