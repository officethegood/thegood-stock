// shared/auth.js
// User metadata helpers + login form glue.
// Requires: config.js, supabase-client.js, auth-jwt.js

(function () {
  // ===== localStorage keys =====
  const K_META    = 'pt_user_meta';
  const K_ACCESS  = 'stock_access_token';
  const K_REFRESH = 'stock_refresh_token';
  const K_EXP     = 'stock_token_exp';

  // ===== Session helpers =====
  function getUserMeta() {
    try { return JSON.parse(localStorage.getItem(K_META) || 'null'); }
    catch { return null; }
  }
  function setUserMeta(meta)   { localStorage.setItem(K_META, JSON.stringify(meta)); }
  function clearAllAuth()      {
    localStorage.removeItem(K_META);
    localStorage.removeItem(K_ACCESS);
    localStorage.removeItem(K_REFRESH);
    localStorage.removeItem(K_EXP);
  }

  function isLoggedIn()        { return !!localStorage.getItem(K_ACCESS); }

  // Decode the signed access-token payload. The JWT carries user_role / name /
  // username and is the AUTHORITATIVE source — pt_user_meta is only a cache.
  // If that cache is ever missing (e.g. a token refresh repopulates the tokens
  // but not the meta, or site data is partially cleared) reading role from the
  // cache alone silently downgrades an Admin to 'Employee' and bounces them to
  // 403 even though their token says Admin. So fall back to the JWT.
  function _jwtPayload() {
    try {
      const t = localStorage.getItem(K_ACCESS);
      if (!t) return null;
      const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      // decodeURIComponent(escape(atob())) decodes UTF-8 (Thai name) correctly.
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch { return null; }
  }

  function getUserRole()       { return getUserMeta()?.role     || _jwtPayload()?.user_role || 'Employee'; }
  function getUserName()       { return getUserMeta()?.name     || _jwtPayload()?.name     || 'Unknown'; }
  function getUserUsername()   { return getUserMeta()?.username || _jwtPayload()?.username || ''; }

  // ===== Login form glue =====
  async function handleLogin(e) {
    if (e && e.preventDefault) e.preventDefault();

    const userEl = document.getElementById('login-user');
    const passEl = document.getElementById('login-pass');
    const errEl  = document.getElementById('login-error');
    const btn    = document.getElementById('btn-login');

    const username = (userEl?.value || '').trim();
    const password = passEl?.value || '';

    if (!username || !password) {
      if (errEl) { errEl.textContent = 'กรุณากรอก Username และ Password'; errEl.classList.remove('d-none'); }
      return;
    }
    if (errEl) { errEl.classList.add('d-none'); errEl.textContent = ''; }
    if (btn)   { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังเข้าสู่ระบบ...'; }

    try {
      const url = CONFIG.SUPABASE_URL + CONFIG.EDGE_AUTH_BRIDGE;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action: 'login', username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        const msg = data?.error === 'invalid_credentials' ? 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง'
                  : data?.error === 'account_inactive'    ? 'ท่านไม่มีสิทธิ์เข้าถึงข้อมูลเหล่านี้ได้'
                  : data?.error === 'gas_unreachable'     ? 'ระบบ HR ตอบสนองช้า กรุณาลองใหม่'
                  : 'เข้าสู่ระบบไม่สำเร็จ';
        throw new Error(msg);
      }

      // Store
      setUserMeta({ name: data.name, role: data.user_role, username: data.username });
      localStorage.setItem(K_ACCESS,  data.access_token);
      localStorage.setItem(K_REFRESH, data.refresh_token);
      localStorage.setItem(K_EXP,     data.expires_at);

      // Initialize client with new token
      window.createOrUpdateSupabaseClient(data.access_token);

      // Schedule refresh
      if (window.scheduleTokenRefresh) window.scheduleTokenRefresh();

      // Redirect
      window.location.replace('./index.html');
    } catch (err) {
      if (errEl) { errEl.textContent = err.message || 'เข้าสู่ระบบไม่สำเร็จ'; errEl.classList.remove('d-none'); }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = 'เข้าสู่ระบบ (Login)'; }
    }
  }

  async function handleLogout() {
    const refresh = localStorage.getItem(K_REFRESH);
    try {
      await fetch(CONFIG.SUPABASE_URL + CONFIG.EDGE_AUTH_BRIDGE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action: 'logout', refresh_token: refresh }),
      });
    } catch { /* silent */ }
    clearAllAuth();
    window.location.replace('./login.html');
  }

  // Redirect to /403 on role mismatch. Returns true if OK to proceed.
  // Accepts a single role string OR an array of allowed roles.
  function requireRole(role) {
    const current = getUserRole();
    const allowed = Array.isArray(role) ? role : [role];
    if (!allowed.includes(current)) {
      window.location.replace('./403.html');
      return false;
    }
    return true;
  }

  // Public API
  window.getUserMeta     = getUserMeta;
  window.isLoggedIn      = isLoggedIn;
  window.getUserRole     = getUserRole;
  window.getUserName     = getUserName;
  window.getUserUsername = getUserUsername;
  window.handleLogin     = handleLogin;
  window.handleLogout    = handleLogout;
  window.requireRole     = requireRole;
  window.__authKeys      = { K_META, K_ACCESS, K_REFRESH, K_EXP };
})();
