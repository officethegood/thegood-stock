// shared/notify.js
// Call tg-notify Edge function. Used by admin Test button and Phase 1+ workflows.

(function () {
  async function notifyTrigger(opts) {
    try {
      const url = CONFIG.SUPABASE_URL + CONFIG.EDGE_TG_NOTIFY;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getAccessToken()}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(opts),
      });
      const data = await res.json();
      return data;
    } catch (e) {
      console.warn('[notify] error:', e);
      return { ok: false, error: String(e) };
    }
  }

  function notifyManualTest(message) {
    return notifyTrigger({
      event_type: 'manual',
      dedupe_key: 'manual:' + Math.random().toString(36).slice(2),
      message,
    });
  }

  window.notifyTrigger    = notifyTrigger;
  window.notifyManualTest = notifyManualTest;
})();
