// sw.js — cache-first for static, network-first for API. No background sync in Phase 0.

const CACHE_VERSION = 'thegood-stock-v0.20.16';  // Fix iOS O2 scan: html5-qrcode fallback (used when BarcodeDetector is absent → iOS Safari) had a fixed 250×250 qrbox that overflowed the short O2 scan stage (aspect 4/3, max-height 42vh) → scan region mis-placed, never decoded. Android uses the native BarcodeDetector path (no qrbox), so it worked; taller stages (staff-scan 3/4) also fit. shared/scanner.js now sizes qrbox adaptively to 75% of the smaller viewfinder edge so it always fits.
const STATIC_ASSETS = [
  './',
  './login.html',
  './index.html',
  './admin.html',
  './staff.html',
  './staff-scan.html',
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
  './shared/inventory.js',
  './shared/lots.js',
  './shared/loans.js',
  './shared/photo-capture.js',
  './shared/bags.js',
  './shared/linens.js',
  './shared/scanner.js',
  './shared/locations.js',
  './shared/locations-graph.js',
  './shared/transfer.js',
  './shared/laundry.js',
  './shared/lookup-lists.js',
  './js/login.js',
  './js/admin-shell.js',
  './js/dashboard.js',
  './js/locations.js',
  './js/inventory.js',
  './js/inventory-lots.js',
  './js/ambulances.js',
  './js/settings-ui.js',
  './js/sessions-ui.js',
  './js/loans.js',
  './js/bag-templates.js',
  './js/bags.js',
  './js/staff-home.js',
  './js/staff-scan.js',
  './shared/oxygen.js',
  './js/oxygen.js',
  './js/inventory-history.js',
  './js/warehouse-shell.js',
  './js/staff-oxygen.js',
  './staff-oxygen.html',
  './vendor/qrcode.min.js',
  './shared/qr-print.js',
  './shared/icons.js',
  './staff-print.html',
  './js/staff-print.js',
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
