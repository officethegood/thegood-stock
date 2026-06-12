// sw.js — cache-first for static, network-first for API. No background sync in Phase 0.

const CACHE_VERSION = 'thegood-stock-v0.20.24';  // Edit-lot feature: admin can now fix a mis-keyed lot number / expiry date (คลัง › ล็อตยา → แก้ไข) instead of the destructive issue-out-and-re-add workaround. AppLots.updateLot updates only lot_number + expiry_date (qty stays ledger-driven); RLS sl_update already allows Admin. — Bug batch: (1) lot picker never appeared for lot-tracked items in staff scan → "lot_id is required" — searchByBarcode SELECT omitted tracks_lots so the picker gate was structurally dead; added tracks_lots so the existing FEFO lot picker fires for issue/adjustment_loss. (2) Search missed multi-word / spaced / name_en items (Normal saline 100ml, 1000 ml, Sterile water 1000 ml, Perskindol) — replaced single ilike '%whole string%' with AND-of-words across name/name_en/sku/barcode (word order + spacing tolerant). Companion DB migration 20260601020000 fixes oxygen_movements RLS so staff can do ลงรอเติม (awaiting_refill). — REAL fix for missing ยืนยัน button in the admin "เปลี่ยนสถานะถัง" modal: the save button is cloned+replaced (to drop stale click listeners) AFTER the to-status change handler was wired, so the handler toggled d-none on the now-detached original node while the visible (cloned) button stayed d-none forever → no confirm button regardless of the status picked. The change handler now re-queries the live #oxy-transition-save. (The v0.20.21 scrollable change was the wrong cause — kept as a harmless improvement.) — Fix oxygen modals clipped on short phones. the 3 oxygen modals (add / edit / เปลี่ยนสถานะ) used modal-dialog-centered WITHOUT modal-dialog-scrollable, so on a short viewport a tall body (status + location + reason + photo) pushed the footer — incl. the ยืนยัน button — off the bottom of the screen (user could not confirm "เติมเสร็จ"). Added modal-dialog-scrollable so the body scrolls and the footer stays pinned/visible. — iOS O2 scan — robust pass + on-screen diagnostic. (1) Full-frame scanning: removed the html5-qrcode qrbox entirely so decoding no longer depends on the rendered video geometry (the whole region-mismatch failure class that plagued the O2 stage on iOS is gone; each page draws its own guide frame). Keeps the v0.20.19 wrapper height:auto fix. (2) Opt-in diagnostic: append ?scandebug=1 (or localStorage scandebug=1) to show a live on-screen readout — scan path (native/fallback), BarcodeDetector presence, library load status, camera dimensions, decode events, errors — so an iOS tester can report the exact failure from one screenshot without a Mac/console.
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
