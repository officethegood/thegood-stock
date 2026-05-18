// js/login.js

(async function () {
  if (window.isLoggedIn && window.isLoggedIn()) {
    const ok = await window.refreshAccessToken().catch(() => false);
    if (ok || (window.getAccessToken() && !window.isAccessTokenExpired())) {
      window.location.replace('./index.html');
      return;
    }
  }
  document.getElementById('login-form').addEventListener('submit', window.handleLogin);
})();
