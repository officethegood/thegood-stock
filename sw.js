// sw.js — cache-first for static, network-first for API. No background sync in Phase 0.

const CACHE_VERSION = 'thegood-stock-v0.20.31';  // กระเป๋าขึ้นรถ/คืนกระเป๋า (bag deploy & return, no due date by design): staff scans a bag QR → the checklist overlay now shows a context-aware button — "เอากระเป๋าขึ้นรถ" (with an ambulance picker) when the bag is home, or "คืนกระเป๋าเข้าที่เก็บเดิม" when its parent is an ambulance. Backed by migration 20260705010000: bag_moves audit table (who/when/where), rpc_deploy_bag re-parents the type=bag location under the chosen ambulance recording its previous parent as home, rpc_return_bag restores that home from the latest deploy row, and an AFTER INSERT trigger posts a Thai Telegram line per move (fail-soft, same pattern as stock-movement notify). Bags are locations, not stock items, so this is a re-homing rather than a loan — contents travel with the bag and the checklist keeps working on the vehicle. — Prev (v0.20.30): ยืม-คืน camera scan: borrow step 1 (item), borrow step 2 (location QR), and return step 1 (item) each get a camera button that opens a one-shot AppScanner modal — decoded text fills the input and auto-searches. Until now these steps were type-only, which is impractical when a nurse is holding an infusion pump; the camera button was requested for exactly that equipment-borrowing flow. The modal sizes its <video> via a descendant CSS rule (NOT inline style) so the html5-qrcode-injected video on iOS is also sized — same root cause class as the v0.20.26 staff-oxygen fix. Also: borrow step 1 now explains lot-tracked items are not borrowable (use เบิก-จ่าย) instead of failing later with a raw DB trigger error, and the not-found message notes that BAG-… codes are bags, not stock items. — Prev (v0.20.29): Deploy auto-heal: all 8 pages now listen for serviceworker controllerchange and reload ONCE when an updated SW takes control. Why: the v0.20.26-27 broken staff-oxygen.js got precached on staff devices; cache-first kept serving it after the server was fixed, so phones stayed stuck on กำลังโหลด until a manual hard-refresh. With this, the next SW update cycle (sw.js is refetched by the browser within ~10 min of a visit) automatically reloads the open page onto the fresh cache — no more asking staff to hard-refresh after a deploy. Guards: hadCtrl skips the very first install (clients.claim), __swAutoReloaded prevents reload loops. — Prev (v0.20.28): HOTFIX: v0.20.26's iOS O2 fix broke the O2 page outright — the explanatory HTML comment added above the <video> sat INSIDE a JS template literal and contained backticks, which terminated the literal early → SyntaxError "Unexpected identifier '#oxy'" at load → staff-oxygen.js never executed → page stuck on กำลังโหลด for everyone. Removed the backticks from the comment; all modified JS files now pass node --check (added to the pre-push routine). — Prev (v0.20.27): Lot bug batch (3 root causes): (1) Transfer modal showed "— ไม่มีล็อต —" for EVERY lot-tracked item → "สินค้านี้ต้องเลือกล็อตก่อนย้าย" made moving impossible — _fetchLots queried stock_lots.remaining_qty, a column that does not exist (it belongs to the v_lots_with_remaining view; the table column is current_qty), so the SELECT errored on every call and the catch-all returned [] silently. Fixed to current_qty + status=active. (2) Re-receiving a fully-issued lot number was a DEADLOCK: lot_number is UNIQUE per item, the depleted row keeps the number → "ล็อตใหม่" tab hit 23505 (M-47 → "use เพิ่มให้ล็อตเดิม") while that tab filtered status==='active' only → empty. FE now lists non-expired depleted lots; companion migration 20260703010000 auto-reactivates a depleted lot on refill (active, or expired if past expiry). (3) เรียกคืนล็อต failed with stock_item_locations_qty_check violation when the lot ledger said more units at a location than sil.qty actually held (legacy lot-less outflows) — migration 20260703010100 caps each location's write-off at sil.qty, zeroes current_qty on the terminal flip, and returns {removed, unaccounted}; FE shows a hand-count warning when unaccounted > 0. — Prev (v0.20.26): iOS O2 scan — REAL root cause (prior 3 attempts patched the wrong layer): the O2 camera <video> was sized by an INLINE style ON the element. On iOS the scanner falls back to html5-qrcode, which REPLACES our <video> with a wrapper div and injects its OWN <video> inside it — the inline style lived on the now-discarded original element, so the injected <video> rendered UNSIZED and iOS never decoded (camera previewed, QR never read). staff-scan always worked because it sizes its video via a DESCENDANT CSS rule (.scan-stage video) that ALSO matches the injected element. Fix: moved O2 video sizing to a `#oxy-scan-stage video` CSS rule (staff-oxygen.html) + removed the inline style (staff-oxygen.js) → now mirrors staff-scan exactly. Android uses the native BarcodeDetector path (no injection) and was never affected — which is why same-device iOS failed while Android/other scan pages worked. — Prev (v0.20.25): Auth robustness fix found in live testing: getUserRole/Name/Username read ONLY pt_user_meta (an unsigned localStorage cache). If that cache is missing while a valid signed JWT exists (token refresh repopulates tokens but not meta, or partial site-data clear), an Admin silently became 'Employee' → requireRole('Admin') bounced them to 403 even though their token said Admin (and login routed them to staff.html). Now fall back to the signed access-token claims (user_role/name/username) when the cache is absent. — Edit-lot feature: admin can now fix a mis-keyed lot number / expiry date (คลัง › ล็อตยา → แก้ไข) instead of the destructive issue-out-and-re-add workaround. AppLots.updateLot updates only lot_number + expiry_date (qty stays ledger-driven); RLS sl_update already allows Admin. — Bug batch: (1) lot picker never appeared for lot-tracked items in staff scan → "lot_id is required" — searchByBarcode SELECT omitted tracks_lots so the picker gate was structurally dead; added tracks_lots so the existing FEFO lot picker fires for issue/adjustment_loss. (2) Search missed multi-word / spaced / name_en items (Normal saline 100ml, 1000 ml, Sterile water 1000 ml, Perskindol) — replaced single ilike '%whole string%' with AND-of-words across name/name_en/sku/barcode (word order + spacing tolerant). Companion DB migration 20260601020000 fixes oxygen_movements RLS so staff can do ลงรอเติม (awaiting_refill). — REAL fix for missing ยืนยัน button in the admin "เปลี่ยนสถานะถัง" modal: the save button is cloned+replaced (to drop stale click listeners) AFTER the to-status change handler was wired, so the handler toggled d-none on the now-detached original node while the visible (cloned) button stayed d-none forever → no confirm button regardless of the status picked. The change handler now re-queries the live #oxy-transition-save. (The v0.20.21 scrollable change was the wrong cause — kept as a harmless improvement.) — Fix oxygen modals clipped on short phones. the 3 oxygen modals (add / edit / เปลี่ยนสถานะ) used modal-dialog-centered WITHOUT modal-dialog-scrollable, so on a short viewport a tall body (status + location + reason + photo) pushed the footer — incl. the ยืนยัน button — off the bottom of the screen (user could not confirm "เติมเสร็จ"). Added modal-dialog-scrollable so the body scrolls and the footer stays pinned/visible. — iOS O2 scan — robust pass + on-screen diagnostic. (1) Full-frame scanning: removed the html5-qrcode qrbox entirely so decoding no longer depends on the rendered video geometry (the whole region-mismatch failure class that plagued the O2 stage on iOS is gone; each page draws its own guide frame). Keeps the v0.20.19 wrapper height:auto fix. (2) Opt-in diagnostic: append ?scandebug=1 (or localStorage scandebug=1) to show a live on-screen readout — scan path (native/fallback), BarcodeDetector presence, library load status, camera dimensions, decode events, errors — so an iOS tester can report the exact failure from one screenshot without a Mac/console.
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
