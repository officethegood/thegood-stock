// shared/auth-jwt.js
// JWT lifecycle: refresh timer, ensureLoggedIn boot.
// Requires: config.js, supabase-client.js, auth.js

(function () {
  const { K_ACCESS, K_REFRESH, K_EXP } = window.__authKeys;
  let _refreshTimer = null;

  function getAccessToken()  { return localStorage.getItem(K_ACCESS);  }
  function getRefreshToken() { return localStorage.getItem(K_REFRESH); }
  function getExpiresAt()    { return localStorage.getItem(K_EXP);     }

  function msUntilExpiry() {
    const exp = getExpiresAt();
    if (!exp) return -1;
    return new Date(exp).getTime() - Date.now();
  }
  function isExpired() { return msUntilExpiry() <= 0; }

  async function refreshAccessToken() {
    const refresh = getRefreshToken();
    if (!refresh) return false;
    try {
      const url = CONFIG.SUPABASE_URL + CONFIG.EDGE_AUTH_BRIDGE;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action: 'refresh', refresh_token: refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      localStorage.setItem(K_ACCESS,  data.access_token);
      localStorage.setItem(K_REFRESH, data.refresh_token);
      localStorage.setItem(K_EXP,     data.expires_at);
      window.createOrUpdateSupabaseClient(data.access_token);
      scheduleTokenRefresh();
      return true;
    } catch { return false; }
  }

  function scheduleTokenRefresh() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    const ms = msUntilExpiry();
    const fireIn = Math.max(15_000, ms - 5 * 60 * 1000); // 5 min before exp, min 15s
    _refreshTimer = setTimeout(refreshAccessToken, fireIn);
  }

  async function ensureLoggedIn() {
    if (!getAccessToken()) { window.location.replace('./login.html'); return false; }
    if (isExpired()) {
      const ok = await refreshAccessToken();
      if (!ok) { window.location.replace('./login.html'); return false; }
    } else {
      window.createOrUpdateSupabaseClient(getAccessToken());
      scheduleTokenRefresh();
    }
    return true;
  }

  window.getAccessToken       = getAccessToken;
  window.getRefreshToken      = getRefreshToken;
  window.isAccessTokenExpired = isExpired;
  window.refreshAccessToken   = refreshAccessToken;
  window.scheduleTokenRefresh = scheduleTokenRefresh;
  window.ensureLoggedIn       = ensureLoggedIn;
})();
