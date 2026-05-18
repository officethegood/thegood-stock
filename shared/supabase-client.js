// shared/supabase-client.js
// Requires: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//           and shared/config.js loaded first.

(function() {
  let _sbClient = null;
  let _currentToken = null;

  function createOrUpdate(accessToken) {
    if (accessToken === _currentToken && _sbClient) return _sbClient;
    _currentToken = accessToken || null;

    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

    _sbClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      global: { headers },
      auth:   { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });

    return _sbClient;
  }

  function getSupabaseClient() {
    if (!_sbClient) createOrUpdate(_currentToken);
    return _sbClient;
  }

  window.createOrUpdateSupabaseClient = createOrUpdate;
  window.getSupabaseClient             = getSupabaseClient;
})();
