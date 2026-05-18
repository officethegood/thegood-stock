// sw.js — cache-first for static, network-first for API. No background sync in Phase 0.

const CACHE_VERSION = 'thegood-stock-v0.1.0';
const STATIC_ASSETS = [
  './',
  './login.html',
  './index.html',
  './admin.html',
  './staff.html',
  './403.html',
  './shared/styles.css',
  './shared/config.js',
  './shared/supabase-client.js',
  './shared/auth.js',
  './shared/auth-jwt.js',
  './shared/ui.js',
  './shared/settings.js',
  './shared/notify.js',
  './shared/cloudinary.js',
  './shared/realtime.js',
  './js/login.js',
  './js/admin-shell.js',
  './js/dashboard.js',
  './js/locations.js',
  './js/ambulances.js',
  './js/settings-ui.js',
  './js/sessions-ui.js',
  './js/staff-home.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isApi = url.hostname.endsWith('.supabase.co') ||
                url.hostname.endsWith('.workers.dev') ||
                url.pathname.startsWith('/functions/');
  if (isApi || e.request.method !== 'GET') {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
