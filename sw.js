// sw.js — cache-first for static, network-first for API. No background sync in Phase 0.

const CACHE_VERSION = 'thegood-stock-v0.20.18';  // Bug-audit fixes: (HIGH) staff-oxygen step-5 "back" needsLoc now matches step-3 forward (5 statuses incl awaiting_refill/refilling) so back-nav no longer skips the location step / drops the picked location; (MED) warehouse-shell _ensureInventory caches the init() promise instead of flipping a flag up-front, so a first-open deep-link can't run enterLinenView/exitLinenView against a half-built inventory pane; (LOW) listRecentMovements dateTo upper bound now microsecond-inclusive. Companion DB migration 20260601010000 fixes check_oxygen_refill_batch pg_net body back to jsonb.
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
