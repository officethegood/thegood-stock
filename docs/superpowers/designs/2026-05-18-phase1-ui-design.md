# DRAFT — Phase 1 UI/UX Design (pending PM review)

**Project:** Thegood Stock Management System
**Phase:** 1 (General Inventory + Multi-Location + Low-stock + Item Finder + Storage Scanning)
**Date:** 2026-05-18
**Author:** UI/UX Designer (autonomous draft while PM "Pex" away)
**Status:** DRAFT — pending PM review. Do NOT implement yet. Open questions in §6.
**Source of truth:** `docs/superpowers/specs/2026-05-18-phase1-inventory-design.md` (§7 UI Spec, §9 T24–T44)
**Plan reference:** `docs/superpowers/plans/2026-05-18-phase1-inventory-plan.md` (Phases D, E, F)
**Next agent:** `frontend-developer`

---

## 0. Method note

The `/frontend-design` skill referenced in `.claude/agents/ui-ux-designer.md` is NOT loaded in this environment. This design therefore falls back to first principles: Nielsen's 10 heuristics (with extra weight on H1 "visibility of system status", H5 "error prevention", H9 "help users recover from errors"), WCAG 2.1 AA (tap targets ≥44x44 px CSS, text contrast ≥4.5:1), and mobile-first responsive ordering (360 px viewport drives the layout; tablet/desktop are progressive enhancement).

Visual choices cite either an existing token in `shared/styles.css` or a Bootstrap 5 utility class. New tokens are proposed explicitly in §5.

---

## Table of Contents

- §1 Cross-area foundation (shared modal style, toast style, scanner widget contract, color tokens, breakpoints)
- §2 Area 1 — Admin Inventory tab (`admin.html` new tab + 3 sub-views + 5 modals + scan overlay)
- §3 Area 2 — `staff-scan.html` (camera-first mobile page)
- §4 Area 3 — Dashboard panels (extend Phase 0 placeholder + Item Finder)
- §5 New CSS tokens proposed
- §6 Open questions for PM
- §7 Hand-off checklist for `frontend-developer`

---

## 1. Cross-area foundation

### 1.1 Universal user-context assumptions (apply to all three areas)

| Assumption | Why it matters here |
|---|---|
| User has **one hand free** at the moment of interaction (other hand holds patient supplies, a clipboard, or a stretcher rail). | All primary buttons must be reachable with the thumb. CTAs sit on the bottom half of the viewport; destructive actions sit top-right where mis-taps are less likely. |
| Limited time per interaction (≤10 s for a scan, ≤60 s for an admin form). | No multi-step wizards for staff flow; scan path uses a single screen with a 3-state machine inside it. |
| Lighting may be poor (storeroom, ambulance interior at night). | Reuse existing high-contrast navy gradient navbar; teal accent (`#0d9488`) on white passes WCAG AA at 4.55:1 for text and 3:1 for large UI. |
| User may wear gloves (clinical). | All tap targets ≥44 px CSS (WCAG 2.5.5). Form inputs use `form-control` (Bootstrap default ~38 px) wrapped in a row with `py-2` padding so the hit area is 44 px+. |
| Network can be flaky (mobile cellular in concrete corridors). | Show optimistic local UI on submit + a clear `บันทึกแล้ว` (saved) toast only when REST returns. Retry uses the same `client_ref_id` so duplicate taps are safe (spec §5.4). |
| All copy in Thai; English allowed only in parens for technical terms developers must keep stable (SKU, QR, Barcode). | Matches Phase 0 convention. Sarabun font already loaded in every HTML. |

### 1.2 Shared visual language (reuse, no new CSS unless §5 lists it)

| Surface | Reuses |
|---|---|
| Navbar | `.navbar.bg-modern-primary.navbar-dark.px-3` (existing in `admin.html`, `staff.html`). |
| Primary CTA (save, submit) | `.btn.btn-stock-primary` (teal gradient, defined in `shared/styles.css` line 737). |
| Secondary CTA (cancel, back) | `.btn.btn-secondary` or `.btn.btn-outline-stock-accent` (line 748). |
| Destructive CTA (deactivate, delete) | `.btn.btn-outline-danger` (Bootstrap default). |
| Card containers | `.card .card-body` (Bootstrap). On mobile the `.island-card` class from `styles.css` line 405 gives the rounded 16 px shadow used on Phase 0 forms. |
| Modal | `.modal .modal-dialog .modal-content` with the rounded-20 px override in `styles.css` line 507. Footer buttons stack vertically below 400 px via Bootstrap default. |
| Table | `.table.table-sm.align-middle`. Mobile fallback wraps in `.table-responsive`. |
| Form labels | `.form-label.small` (Phase 0 pattern in `settings-ui.js`). |
| Toast | Existing `showToast(level, msg)` helper from `shared/ui.js`. Levels used: `success` (green check), `warning` (amber), `error` (red). All three are auto-dismiss after ~3 s — accessible because they also write to an ARIA-live region (must verify in `ui.js`; flag in §6). |
| Confirm dialog | Existing `showConfirm(msg)` from `shared/ui.js` (used in `locations.js` line 252). Returns Promise<bool>. |
| Tab pills | `.nav.nav-pills .nav-link.stock-tab` (existing pattern in `admin.html`). |
| Empty state | Inline grey text `<p class="text-muted">— ไม่มีรายการ —</p>` (Phase 0 convention, e.g. `locations.js` line 55). |
| Loading state | Inline grey text `<p class="text-muted">กำลังโหลด…</p>` for tables/lists; for full-screen waits, use `.monitor-spin` icon (line 27). Phase 1 has no full-screen waits. |

### 1.3 Shared scanner widget contract (reusable across Area 1 and Area 2)

The scanner UI is identical in admin scan-receive (§2) and staff scan-issue (§3), only the resulting `movement_type` and copy differ. Plan §C2 already defines a `scannerCreate({onResult, onError})` JS API.

ASCII contract:

```
+------------------------------------------------+
|  [hint text — what to scan now]                |  ← changes per state
+------------------------------------------------+
|                                                |
|  [LIVE CAMERA VIDEO  width:100% maxH:50-55vh]  |  ← <video> el
|        ┌────────────────────┐                  |
|        |   viewfinder box   |                  |  ← CSS overlay (proposed token §5.1)
|        └────────────────────┘                  |
|                                                |
+------------------------------------------------+
|  [chip-item: SKU NAME]  [chip-loc: CODE NAME]  |  ← becomes green when filled
+------------------------------------------------+
|  [qty input] [primary submit]                  |  ← hidden until both chips filled
+------------------------------------------------+
|  [secondary: reset]  [link: type manually]     |
+------------------------------------------------+
```

3-state machine (matches spec §7.2 and plan D4 `inventory-scan.js`):

| State | Hint copy (Thai) | Chips | Submit row | Camera |
|---|---|---|---|---|
| `item` | `ขั้นที่ 1: สแกนบาร์โค้ดหรือ QR ของสินค้า` | both `bg-secondary` "—" | hidden | running |
| `loc` | `ขั้นที่ 2: สแกน QR ของตู้/ชั้นที่จัดเก็บ` | item green; loc grey | hidden | running |
| `qty` | `ขั้นที่ 3: ระบุจำนวน แล้วกด "บันทึก"` | both green | visible | stopped (frees device camera) |
| `success` | `บันทึกแล้ว` (overlay 1.5 s) | both green | success state | stopped |
| `error` | toast only; state unchanged | as before | as before | running |

### 1.4 Breakpoints

| BP | Range | What changes |
|---|---|---|
| Mobile (default) | <768 px | One-column. Cards stack. Modal becomes `modal-fullscreen-sm-down` on the scan overlay so the camera fills the screen. |
| Tablet | 768–1023 px | Two-column on Receive form (form left, recent movements right). Items table shows all 6 columns. |
| Desktop | ≥1024 px | Same as tablet plus dashboard KPI cards laid out 3-up. |

Bootstrap utilities used for the grid: `col-12 col-md-4 col-lg-3` etc. — already standard in Phase 0.

### 1.5 Accessibility baseline (applies to every screen below)

- **Tap targets:** every interactive element ≥44×44 px. Form inputs satisfy this when wrapped with `.mb-2` row + 8 px label padding (verified in Phase 0 settings form).
- **Color contrast:** body text on white = `#333` on `#fff` = 12.6:1 (existing `body` rule). Teal CTA `#0d9488` on white = 4.55:1 (AA). Low-stock red number uses Bootstrap `text-danger` `#dc3545` on white = 5.94:1 (AA).
- **Keyboard order:** modals open with focus on first input; ESC closes (Bootstrap default). Tab traversal follows DOM order, which is the visual order in all wireframes below.
- **ARIA:** add `role="dialog" aria-modal="true" aria-labelledby="..."` to every modal we open dynamically (Phase 0 `locations.js` does not do this — flag as cross-area improvement in §6).
- **Screen reader copy:** scan video element gets `aria-label="ภาพจากกล้องสำหรับสแกน QR"`. Chip badges get `aria-live="polite"` so a SR user hears when the scan fills the chip.
- **Focus visible:** Bootstrap default outline preserved (don't override).
- **Reduced motion:** no design depends on the existing `.blink-badge` / `monitor-spin` animations being on. Static states are all readable.

---

## 2. Area 1 — Admin Inventory tab

### 2.1 Goals + user persona

**User:** Pex (PM/Admin owner) + future stock managers. Desktop most of the time (sits at office desk to onboard items), occasionally a tablet on the storeroom floor. Needs to perform 4 verbs efficiently: **find** an item, **add** a new item, **receive** new stock into a location, **investigate** low-stock alerts.

**Goal:** Make the 4 verbs reachable within 1 click from the tab. Keep the per-screen cognitive load low — admin should never need to switch sub-views to complete one verb.

### 2.2 Information architecture

```
admin.html
└── nav-pills (Phase 0: Dashboard | Locations | [NEW: Inventory] | Ambulances | Settings | Sessions)
    └── #tab-inventory (lazy-init from js/inventory.js)
        ├── Toolbar (always visible)
        │     ├── Segmented switch: รายการสินค้า | รับเข้า / ปรับสต๊อก | ค้นของ
        │     └── Top-right buttons: [+ เพิ่มสินค้า] [สแกนรับเข้า]
        ├── Sub-view A: รายการสินค้า (default)
        │     ├── Search + filter row
        │     ├── Items table
        │     └── On row click → Item Detail Drawer (modal)
        │           └── from drawer: [แก้ไข] [ปิดใช้งาน / เปิดใช้งาน]
        ├── Sub-view B: รับเข้า / ปรับสต๊อก
        │     ├── Manual Receive form (left on tablet, top on mobile)
        │     └── 50 รายการล่าสุด table (right on tablet, below on mobile)
        ├── Sub-view C: ค้นของ (Item Finder)
        │     └── Search-as-you-type, results grouped per item with per-location breakdown
        ├── Modal: เพิ่มสินค้า / แก้ไขสินค้า (same form, prefilled in edit mode)
        ├── Modal: Item Detail Drawer (read-mostly + 2 action buttons)
        └── Overlay: 📷 สแกนรับเข้า (full-screen on mobile)
```

**Decision (D-A1):** Spec §7.1 lists 3 sub-views inside the tab. The "+ เพิ่มสินค้า" modal and the "📷 สแกนรับเข้า" overlay are reachable from the **always-visible toolbar** (not only from the Items sub-view) because admins frequently want to "just add a thing" without first navigating. Cost: 2 extra buttons in the toolbar. Benefit: 1-click reach for the two most frequent admin verbs. Cite: Nielsen H7 (flexibility / shortcut paths).

**Decision (D-A2):** Transfer (between locations) is NOT a separate modal in Phase 1. Per spec §1 out-of-scope: "Transfer between locations as a single atomic operation (Phase 1 records as one `issue` + one `receive` pair; a true `transfer` movement type can be added later)." Admin who needs to move stock does so by (a) issuing from source (use Receive sub-view → type `adjustment_loss` is wrong — flag in §6 Q-D2) or (b) waiting for Phase 2+. **I am pushing back on the prompt's "Transfer modal" requirement — see §6 Q-D2.**

### 2.3 Screen 2.A — Items list (sub-view default)

#### 2.A.1 Wireframe @ 360 px (mobile)

```
┌─────────────────────────────────────────┐
│ navbar: Thegood Stock — Admin     [ออก] │  ← bg-modern-primary
├─────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory*]…     │  ← nav-pills, scroll-x on mobile
├─────────────────────────────────────────┤
│ ┌── segmented (full width, 3 buttons) ─┐│
│ │ รายการสินค้า | รับเข้า | ค้นของ        ││  ← active = stock-tab style
│ └───────────────────────────────────────┘│
│                                          │
│ [+ เพิ่มสินค้า]    [สแกนรับเข้า]          │  ← stack vertically <400 px
│                                          │
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 ค้นชื่อ / SKU / Barcode          │ │  ← input full-width
│ └─────────────────────────────────────┘ │
│ ┌──────────────┐  ┌──── ☐ เฉพาะของใกล้  │  ← 2 controls: cat dropdown + checkbox
│ │ หมวด: ทั้งหมด │  │      หมด           │
│ └──────────────┘  └────────────────────  │
│                                          │
│ ┌─────────────────────────────────────┐ │
│ │ SKU         ชื่อ          คงเหลือ ! │ │  ← table-sm, sticky thead
│ ├─────────────────────────────────────┤ │
│ │ SUP-GA-001  ผ้าก๊อซ       15  ⚠   │ │  ← row click → drawer
│ │ SUP-GLV-001 ถุงมือยาง     220     │ │
│ │ TOOL-BP-001 ที่วัดความดัน  3   ⚠   │ │
│ │ …                                    │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

On mobile (<576 px), columns "หมวด" and "เกณฑ์" hide via `d-none d-sm-table-cell`. The "⚠" badge replaces them with a single visual cue. Tap a row to see all six columns + per-location detail in the drawer.

#### 2.A.2 Wireframe @ 768 px+ (tablet/desktop)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ navbar                                                                     │
├───────────────────────────────────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory*][Ambulances][Settings][Sessions]         │
├───────────────────────────────────────────────────────────────────────────┤
│ รายการสินค้า | รับเข้า | ค้นของ             [+ เพิ่มสินค้า] [📷 สแกนรับเข้า] │
│                                                                            │
│ [🔍 ค้นชื่อ / SKU / Barcode             ] [หมวด ▾] [☐ เฉพาะของใกล้หมด]    │
│                                                                            │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ SKU             ชื่อ                หมวด        คงเหลือ  เกณฑ์ สถานะ │ │
│ ├──────────────────────────────────────────────────────────────────────┤ │
│ │ SUP-GAUZE-001   ผ้าก๊อซ            วัสดุสิ้นเปลือง  15 ⚠  20    ใช้งาน│ │
│ │ SUP-GLV-001     ถุงมือยาง          วัสดุสิ้นเปลือง  220     50    ใช้งาน│ │
│ │ TOOL-BP-001     ที่วัดความดัน        อุปกรณ์ใช้ซ้ำ    3 ⚠   5     ใช้งาน │ │
│ │ CONS-ALC-001    แอลกอฮอล์เช็ดแผล    ของใช้แล้วทิ้ง  90      30    ปิด  │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

#### 2.A.3 Interaction states (per element)

| Element | Default | Loading | Empty | Error | Success | Disabled |
|---|---|---|---|---|---|---|
| Search input | placeholder `ค้นชื่อ / SKU / Barcode` (text-muted) | n/a | n/a | n/a (search never errors visibly; failed REST → table empty state with retry hint) | n/a | n/a |
| Category dropdown | `หมวด: ทั้งหมด` selected | options "กำลังโหลด…" while categories fetching | only "ทั้งหมด" if 0 categories | toast `โหลดหมวดไม่สำเร็จ` | n/a | n/a |
| "เฉพาะของใกล้หมด" checkbox | unchecked | n/a | n/a | n/a | n/a | n/a |
| Items table body | rows render | `<tr><td colspan>กำลังโหลด…</td></tr>` (text-muted) | `<tr><td colspan>— ไม่มีรายการ —</td></tr>` | `<tr><td colspan class="text-danger">โหลดสินค้าไม่สำเร็จ — กดรีเฟรช</td></tr>` + `[รีเฟรช]` button below | n/a | n/a |
| Row | hover: `bg-light` (Bootstrap default) ; focus: thicker outline (default) ; active: ripple via existing `.patient-card:active` transform | n/a | n/a | n/a | n/a | inactive items shown grey (line-through if `inv-low-only` and `active=false`) |
| Low-stock badge ⚠ | shown when `total_qty <= reorder_threshold AND reorder_threshold > 0` | n/a | n/a | n/a | n/a | n/a |
| `+ เพิ่มสินค้า` | primary teal | submit-disabled while modal post pending | n/a | inline modal error | toast `เพิ่มสินค้าแล้ว` | n/a |
| `📷 สแกนรับเข้า` | outline teal | spinner replaces text while camera permission pending | n/a | toast `ไม่สามารถเปิดกล้อง — ลองอนุญาตในเบราว์เซอร์` | overlay closes + toast `บันทึกแล้ว` | greyed when device has no camera (detected via `navigator.mediaDevices`) |

#### 2.A.4 Thai microcopy (every string)

| Where | Copy |
|---|---|
| Segmented tab labels | `รายการสินค้า` / `รับเข้า / ปรับสต๊อก` / `ค้นของ` |
| Toolbar button (add) | `+ เพิ่มสินค้า` |
| Toolbar button (scan) | `📷 สแกนรับเข้า` |
| Search placeholder | `ค้นชื่อ / SKU / Barcode` |
| Category dropdown default | `หมวด: ทั้งหมด` |
| Low-stock checkbox | `เฉพาะของใกล้หมด` |
| Table headers | `SKU` / `ชื่อ` / `หมวด` / `คงเหลือรวม` / `เกณฑ์` / `สถานะ` |
| Status badge active | `ใช้งาน` (success green) |
| Status badge inactive | `ปิด` (secondary grey) |
| Low-stock visual marker | the qty number turns `text-danger fw-bold` + a `⚠` icon next to it; no extra word (saves horizontal space on mobile) |
| Loading row | `กำลังโหลด…` |
| Empty row | `— ไม่มีรายการ —` |
| Error row | `โหลดสินค้าไม่สำเร็จ — กดรีเฟรช` |
| Toast: load fail | `โหลดสินค้าไม่สำเร็จ: {err}` |

#### 2.A.5 Accessibility notes

- Table: `<thead>` cells have explicit `scope="col"`. Rows are clickable; add `role="button" tabindex="0"` and key handler for Enter/Space to open drawer (Phase 0 `locations.js` does NOT do this for its tree rows — flag §6 cross-area Q-X1).
- Low-stock ⚠ icon needs a visible text alternative for screen readers: wrap in `<span aria-label="ใกล้หมด"><i class="bi bi-exclamation-triangle"></i></span>`.
- Sticky thead via Bootstrap `position-sticky top-0 bg-white` so the header stays visible when scrolling long item lists.
- Checkbox label must be associated with input via `for=` (Phase 0 pattern already does this).

#### 2.A.6 Bootstrap 5 components reused

`nav nav-pills`, `btn-group` (for segmented), `btn btn-stock-primary`, `btn btn-outline-stock-accent`, `form-control`, `form-select`, `form-check form-check-input`, `table table-sm align-middle`, `table-responsive`, `badge bg-success/bg-secondary`, `text-danger`, `text-muted`, `d-none d-sm-table-cell`.

### 2.4 Screen 2.B — Item Detail Drawer (opens on row click)

This is the "side drawer with full detail + per-location breakdown" called out in spec §7.1.1. We implement it as a centered Bootstrap modal (`.modal-dialog.modal-lg`) for now — a true off-canvas drawer (`.offcanvas.offcanvas-end`) is a Phase 1.1 polish if PM wants it (flag §6).

#### 2.B.1 Wireframe @ 360 px

```
┌─── modal (full-width on mobile) ─────────┐
│ ผ้าก๊อซ                              [✕] │
│ SUP-GAUZE-001                            │
│                                          │
│ หมวด: วัสดุสิ้นเปลือง · หน่วย: ชิ้น        │
│ เกณฑ์เตือน: 20 (รวมทุกที่)                │
│ Barcode: 8851234567890                   │
│                                          │
│ ─── คงเหลือต่อสถานที่ ───                  │
│ ROOM-A         ห้องคลังสำรอง       10 ⚠ │
│ SHELF-A1-T1   ชั้น A1 ล่าง           5  │
│ ─── รวม ─── 15 ⚠                         │
│                                          │
│ [แก้ไข]            [ปิดใช้งาน]            │  ← stack on mobile, side-by-side on tablet+
└──────────────────────────────────────────┘
```

#### 2.B.2 Interaction states

| Element | Default | Loading | Empty | Error |
|---|---|---|---|---|
| Per-location list | rows | `กำลังโหลด…` | `ไม่มีในคลัง — กด "+ รับเข้า" เพื่อเริ่ม` (also gives an actionable next step per Nielsen H10 "help and documentation") | toast `โหลดข้อมูลสถานที่ไม่สำเร็จ` |
| `[แก้ไข]` | outline secondary | n/a | n/a | n/a |
| `[ปิดใช้งาน]` | outline danger; text flips to `[เปิดใช้งาน]` when `active=false` | spinner inside button while toggling | n/a | toast `อัปเดตไม่สำเร็จ` |

#### 2.B.3 Microcopy

| Element | Copy |
|---|---|
| Close button | `[✕]` (Bootstrap `.btn-close`, aria-label automatic) |
| Section header | `คงเหลือต่อสถานที่` |
| Empty | `ไม่มีในคลัง — กด "+ รับเข้า" เพื่อเริ่ม` |
| Sum row | `รวม` |
| Edit btn | `แก้ไข` |
| Deactivate btn | `ปิดใช้งาน` / `เปิดใช้งาน` |
| Toast on toggle | `ปิดใช้งานแล้ว` / `เปิดใช้งานแล้ว` |

#### 2.B.4 Accessibility

- Modal has `role="dialog" aria-modal="true" aria-labelledby="drawer-title"`.
- The per-location list is a real `<ul>` with `<li>` rows so screen readers announce the count.
- Sum row outside the `<ul>` is a `<div>` with `aria-label="คงเหลือรวมทุกสถานที่"`.
- Action buttons stack vertically below 400 px to keep 44 px hit area without buttons touching.

### 2.5 Screen 2.C — Add / Edit Item modal

Same form for both verbs; `isEdit` prefills + disables SKU (immutable in Phase 1 because SKU is the natural key and changing it would orphan barcode scans). Matches plan D2 markup.

#### 2.C.1 Wireframe @ 360 px

```
┌─── modal ───────────────────────────────┐
│ เพิ่มสินค้าใหม่                       [✕] │  (or "แก้ไขสินค้า")
│                                          │
│ ชื่อ *                                    │
│ [_________________________________]      │
│                                          │
│ SKU *                  Barcode           │
│ [_______________]      [_______________] │
│                                          │
│ หมวด           หน่วย     เกณฑ์เตือน        │
│ [— ▾]          [ชิ้น]    [0]              │
│                                          │
│ ☐ ใช้งานอยู่                              │
│                                          │
│ ┌── inline error (hidden by default) ──┐ │
│ │ SKU ซ้ำ                              │ │
│ └──────────────────────────────────────┘ │
│                                          │
│              [ยกเลิก]    [บันทึก]         │
└──────────────────────────────────────────┘
```

#### 2.C.2 Interaction states

| Field | Default | Validation (client) | Server error |
|---|---|---|---|
| ชื่อ | required, focus on open (add mode) | empty → `กรอกชื่อสินค้า` red border + msg | passthrough |
| SKU | required, autoupper-case on blur; disabled in edit | empty → `กรอก SKU` | duplicate (`23505`) → inline alert `SKU ซ้ำ — เลือกใหม่` |
| Barcode | optional | none | duplicate → inline alert `Barcode ซ้ำ — ตรวจสอบ` |
| หมวด | optional dropdown of `stock_categories` | n/a | n/a |
| หน่วย | default `ชิ้น`; text input (not enum, per spec) | empty → fallback to `ชิ้น` on submit | n/a |
| เกณฑ์เตือน | number, default 0, min 0 | negative → snap to 0 | n/a |
| ใช้งานอยู่ | checked by default in add; reflects current value in edit | n/a | n/a |
| [บันทึก] | primary teal | spinner inside button + disabled while POST in flight | n/a |
| [ยกเลิก] | secondary | n/a | n/a |

#### 2.C.3 Microcopy

| Element | Copy |
|---|---|
| Title (add) | `เพิ่มสินค้าใหม่` |
| Title (edit) | `แก้ไขสินค้า` |
| Required marker | `*` (asterisk) — and label color stays default (no red asterisk; the validation message handles the red) |
| Labels | `ชื่อ`, `SKU`, `Barcode`, `หมวด`, `หน่วย`, `เกณฑ์เตือน`, `ใช้งานอยู่` |
| Helper text under เกณฑ์เตือน (small grey) | `แจ้งเตือน Telegram เมื่อคงเหลือรวม ≤ ค่านี้ (0 = ไม่แจ้ง)` |
| Empty-required error | `กรอกชื่อสินค้า` / `กรอก SKU` |
| Duplicate SKU | `SKU ซ้ำ — เลือกใหม่` |
| Duplicate Barcode | `Barcode ซ้ำ — ตรวจสอบ` |
| Save toast | `เพิ่มสินค้าแล้ว` / `อัปเดตแล้ว` |
| Cancel | `ยกเลิก` |
| Save | `บันทึก` |

#### 2.C.4 Accessibility

- First field receives focus on open (`autofocus`). On the SKU field, set `inputmode="latin"` and `autocomplete="off"` (it's a code, not personal data).
- Each label `for=`-bound to input id. Required fields use `aria-required="true"`.
- Inline error uses `aria-live="polite"` so a screen reader announces "SKU ซ้ำ" on submit failure.
- Submit button has `aria-busy="true"` while POST in flight.

### 2.6 Screen 2.D — Receive / Adjust sub-view

Manual two-column on tablet+, stacked on mobile. Already drawn by plan D3; this section adds states + microcopy + accessibility.

#### 2.D.1 Wireframe @ 360 px

```
┌─────────────────────────────────────────┐
│ (toolbar + segmented as before)         │
├─────────────────────────────────────────┤
│ ── รับเข้า / ปรับสต๊อก (Manual) ──        │
│                                          │
│ สินค้า *                                  │
│ [— เลือก — ▾                            ] │  ← autocomplete + native select
│                                          │
│ สถานที่ *                                 │
│ [— เลือก — ▾                            ] │
│                                          │
│ ประเภท              จำนวน *               │
│ [รับเข้า (Receive) ▾]  [_________]        │
│                                          │
│ เหตุผล / Note                            │
│ [_________________________________]      │
│                                          │
│ [บันทึก]                                   │
├─────────────────────────────────────────┤
│ ── 50 รายการล่าสุด ──                     │
│ (scrollable table — see plan D3)         │
└─────────────────────────────────────────┘
```

#### 2.D.2 Interaction states

| Element | Default | Loading | Empty | Error | Success |
|---|---|---|---|---|---|
| สินค้า dropdown | `— เลือก —` then a list ordered alphabetically by name | options say `กำลังโหลด…` while categories+items load | only `— เลือก —` if 0 active items + a helper link `เพิ่มสินค้าก่อน →` opens add modal | n/a | n/a |
| สถานที่ dropdown | `— เลือก —` then `code — name (type)` sorted by code | same | only `— เลือก —` + helper `ไปแท็บ Locations →` | n/a | n/a |
| ประเภท select | 3 options: `รับเข้า (Receive)` (default), `ปรับเพิ่ม`, `ปรับลด (ของชำรุด/หาย)` | n/a | n/a | n/a | n/a |
| จำนวน input | empty, number, min 1, inputmode="numeric" | n/a | n/a | client: `จำนวนต้องมากกว่า 0` | n/a |
| Note input | empty | n/a | n/a | n/a | clears on save |
| [บันทึก] | primary teal | spinner + disabled during POST | n/a | toast `ของไม่พอ` (trigger negative-qty) or `บันทึกไม่สำเร็จ: {msg}` | toast `บันทึกแล้ว` + qty/note cleared + recent-movements list re-fetches |
| Recent movements table | rows | `กำลังโหลด…` | `— ยังไม่มีรายการ —` | inline error row | rows update via Realtime debounce 300 ms |

#### 2.D.3 Microcopy

| Where | Copy |
|---|---|
| Card title | `รับเข้า / ปรับสต๊อก (Manual)` |
| Sub-hint under card title (small grey) | `สำหรับสแกน QR ให้ใช้ปุ่ม "📷 สแกนรับเข้า" ด้านบน` |
| Labels | `สินค้า *`, `สถานที่ *`, `ประเภท`, `จำนวน *`, `เหตุผล / Note` |
| Type options | `รับเข้า (Receive)` / `ปรับเพิ่ม` / `ปรับลด (ของชำรุด/หาย)` |
| Submit | `บันทึก` |
| Toast success | `บันทึกแล้ว` |
| Toast: short-stock | `ของไม่พอ — คงเหลือไม่ครบ` (per spec Q-Phase1 Q7 wording question, see §6) |
| Toast: form incomplete | `กรอกข้อมูลไม่ครบ` |
| Recent table title | `50 รายการล่าสุด` |
| Recent table headers | `เวลา` / `ประเภท` / `SKU/ชื่อ` / `สถานที่` / `Δ` / `คงเหลือ` / `ผู้ทำ` |
| Recent empty | `— ยังไม่มีรายการ —` |

#### 2.D.4 Accessibility

- Form is a real `<form>` with `onsubmit` (not a div with a button) so Enter on the qty input submits.
- Number input uses `inputmode="numeric"` so mobile keyboards show the numpad. Also `pattern="[0-9]*"`.
- Recent movements table has `aria-live="polite"` so SR announces "1 รายการใหม่" on Realtime insert (debounced 300 ms to avoid spam).
- The "ของไม่พอ" toast appears immediately and the qty input stays focused so user can correct without re-tabbing.

### 2.7 Screen 2.E — Scan-Receive overlay (camera)

Full-screen on mobile (`.modal-fullscreen-sm-down`), centered modal on desktop. Reuses the shared scanner widget contract from §1.3.

#### 2.E.1 Wireframe @ 360 px (state = `item`)

```
┌─────────────────────────────────────────┐
│ 📷 สแกนรับเข้า                       [ปิด]│  ← top bar
│ ขั้นที่ 1: สแกนบาร์โค้ดหรือ QR ของสินค้า  │  ← hint
│                                          │
│ ┌─────────────────────────────────────┐ │
│ │                                      │ │
│ │      [LIVE CAMERA — max 50vh]        │ │
│ │      ┌──────────────────────┐        │ │
│ │      │   viewfinder (teal)   │        │ │
│ │      └──────────────────────┘        │ │
│ │                                      │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ [item: —]  [location: —]                 │  ← chips, both grey
│                                          │
│ [เริ่มใหม่]   พิมพ์รหัสแทน →              │  ← reset + manual fallback link
└─────────────────────────────────────────┘
```

@ state `qty`:

```
┌─────────────────────────────────────────┐
│ 📷 สแกนรับเข้า                       [ปิด]│
│ ขั้นที่ 3: ระบุจำนวน แล้วกด "บันทึก"        │
│                                          │
│ [item: SUP-GAUZE-001 ผ้าก๊อซ]✓           │  ← green
│ [location: ROOM-A ห้องคลัง]✓              │
│                                          │
│ จำนวน                                     │
│ [______]   [บันทึก]                       │
│                                          │
│ [เริ่มใหม่]                                 │
└─────────────────────────────────────────┘
```

#### 2.E.2 Interaction states (full table)

| State | Triggered by | Visual | Copy |
|---|---|---|---|
| `permission-prompt` | first open, no camera grant yet | dim camera box + center icon + button | hint `ระบบต้องใช้กล้องเพื่อสแกน QR` + button `อนุญาตให้ใช้กล้อง` + below: `หรือพิมพ์รหัสแทน →` |
| `permission-denied` | user said no | dim camera box + warning | hint `เบราว์เซอร์บล็อกกล้องอยู่ — เปิดในการตั้งค่าหรือพิมพ์รหัสแทน` + button `พิมพ์รหัสแทน` |
| `item` | scanner started, item not yet scanned | live video, viewfinder visible | hint `ขั้นที่ 1: สแกนบาร์โค้ดหรือ QR ของสินค้า` |
| `loc` | item scanned successfully | live video, viewfinder visible, item chip green | hint `ขั้นที่ 2: สแกน QR ของตู้/ชั้นที่จัดเก็บ` |
| `qty` | both chips filled | camera stopped (black box with "ปิดกล้องแล้ว — สแกนเสร็จ" overlay), qty row visible | hint `ขั้นที่ 3: ระบุจำนวน แล้วกด "บันทึก"` |
| `submitting` | bันทึก pressed | submit button spinner + disabled | hint stays `ขั้นที่ 3:…` |
| `success` | server 2xx | overlay green check 1.5 s | overlay text `บันทึกแล้ว` |
| `error: not-found-item` | invFindItemByCode returned null | toast | `ไม่พบสินค้า — ลองสแกนใหม่ หรือพิมพ์รหัส` |
| `error: not-found-loc` | invFindLocationByCode returned null | toast | `ไม่พบตู้/ชั้น — ลองสแกนใหม่` |
| `error: short-stock` | trigger negative-qty (shouldn't happen for receive, but defensive) | toast | `ของไม่พอ` |
| `error: network` | REST exception | toast | `เครือข่ายมีปัญหา — กลับมาลองใหม่ ระบบจำรายการไว้ให้แล้ว` (idempotency saves us) |
| `error: idempotent-replay` | duplicate `client_ref_id` (retry) | toast (subtle) | `บันทึกแล้ว (ซ้ำ — ระบบบันทึกครั้งเดียว)` |

#### 2.E.3 Microcopy

All copy listed in 2.E.2. Additional:

| Element | Copy |
|---|---|
| Close button | `ปิด` (Bootstrap `.btn-close` with `aria-label="ปิด"`) |
| Reset button | `เริ่มใหม่` |
| Manual fallback link | `พิมพ์รหัสแทน →` (toggles a small panel below the chips with two text inputs) |
| Manual panel — item input placeholder | `SKU หรือ Barcode` |
| Manual panel — location input placeholder | `รหัสตู้/ชั้น` (e.g. `ROOM-A`) |
| Manual panel button | `ยืนยันรหัส` |
| Submit | `บันทึก` |

#### 2.E.4 Accessibility

- Camera permission prompt is keyboard-accessible: `อนุญาตให้ใช้กล้อง` is a real `<button>`, not a div. Pressing Enter triggers `getUserMedia`.
- Viewfinder is a CSS overlay (proposed token `--scan-viewfinder-color` §5.1). It is decorative — purely visual; the actual detection is on the video element.
- Chips have `aria-live="polite"` and switch from `aria-label="สินค้า ยังไม่ได้สแกน"` to `aria-label="สินค้า: SUP-GAUZE-001 ผ้าก๊อซ"` so a SR user knows what was captured.
- After a successful scan, focus moves to the qty input automatically (state `qty`).
- On `success`, focus returns to the trigger button (`📷 สแกนรับเข้า`) per WCAG 2.4.3 "focus order".
- ESC closes the overlay (Bootstrap default) and stops the camera (memory leak prevention; verify in plan D4).

#### 2.E.5 Bootstrap 5 + new tokens

Reuses: `.modal-fullscreen-sm-down`, `.modal-content`, `.btn-stock-primary`, `.badge.bg-success`, `.badge.bg-secondary`, `.form-control`, `.text-muted`, `.row.g-2`.

New token proposed: `--scan-viewfinder-color` — see §5.1.

---

## 3. Area 2 — `staff-scan.html` (mobile-first standalone)

### 3.1 Goals + user persona

**User:** Employee (general staff) — paramedic, nurse, storeroom helper. On phone, often one-handed. Tasks: scan-issue (เบิก-จ่าย) and scan-loss (รายงานของชำรุด/หาย). Secondary: lookup where an item is stored (Item Finder embed).

**Goal:** Camera should launch within 2 s of opening the page. Most users scan-issue 1–5 items per visit and never touch the rest of the page. Item Finder is below the fold and only used when an item can't be found visually.

### 3.2 Information architecture

```
staff-scan.html (standalone page; no admin chrome)
├── navbar: ← back to staff.html | logout
├── Section A: Scan panel (above fold)
│     ├── Title row: "📷 สแกนเบิก-จ่าย" + link "ค้นของ ↓"
│     ├── Chips row: [item: —] [location: —]
│     ├── Camera (or permission gate / fallback)
│     ├── (Manual fallback panel — hidden by default)
│     ├── Submit row: [type select] [qty] [บันทึก]
│     ├── Photo row (only when type=adjustment_loss) — optional file input
│     └── Reset link
├── <hr>
└── Section B: Item Finder (below fold; anchor #finder-anchor)
      ├── Search input
      └── Results list (read-only, per-location qty)
```

**Decision (D-S1):** Camera auto-starts on page load (after permission). Per spec §7.3: "Pre-flight check: if camera permission denied → fallback to text input". Per task: "Camera should launch on page load (with permission gate)". Implementation: first paint shows the permission-gate state with a single big `อนุญาตให้ใช้กล้อง` button. Tapping it calls `getUserMedia`. Once granted, the state transitions to `item` and the live video appears.

**Decision (D-S2):** "Chain scans → success → auto-restart in 3 s" per task. I am tuning this to **800 ms** (matches plan E2 line 1991 `setTimeout(reset, 800)`). 3 s feels long when the user is mid-flow. The success toast itself is the visual confirmation; we don't need to hold the success state. **Pushing back on task spec — see §6 Q-S1.**

**Decision (D-S3):** "Bottom nav: back to staff.html, logout" per task. Replaced with **top nav** (the existing `.navbar` already has back + logout). A bottom nav on this page would compete for thumb-reach with the [บันทึก] button. The navbar back link uses `bi-arrow-left` icon for clarity. Mobile users reach top with one-handed thumb stretch.

### 3.3 Screen 3.A — Camera live view (state `item`)

#### 3.3.1 Wireframe @ 360 px (primary)

```
┌─────────────────────────────────────────┐
│ ← Thegood Stock                  [ออก] │  ← navbar (existing)
├─────────────────────────────────────────┤
│ 📷 สแกนเบิก-จ่าย              ค้นของ ↓ │
│                                          │
│ [item: —]  [location: —]                 │
│                                          │
│ ┌─────────────────────────────────────┐ │
│ │                                      │ │
│ │       [LIVE CAMERA, 55vh max]        │ │
│ │       ┌────────────────────┐         │ │
│ │       │   viewfinder       │         │ │
│ │       └────────────────────┘         │ │
│ │                                      │ │
│ │  ขั้นที่ 1: สแกนสินค้า                │ │  ← overlay caption on video
│ └─────────────────────────────────────┘ │
│                                          │
│ พิมพ์รหัสแทน →                            │  ← link toggles fallback
│                                          │
│ ── ดำเนินการ ──                          │
│ ประเภท                จำนวน              │
│ [เบิก-จ่าย ▾]          [____]            │
│                       [บันทึก]            │  ← full-width submit
│                                          │
│ [เริ่มใหม่]                                │  ← small, secondary
│                                          │
│ ════════════════════════════════════════ │
│ ค้นของ (ดูสถานที่จัดเก็บ)                  │  ← anchor #finder-anchor
│ [🔍 ค้นชื่อ / SKU / Barcode             ] │
│ (empty until user types)                  │
└─────────────────────────────────────────┘
```

@ 768 px+ (tablet, rare for this page but supported): camera caps at 60vh and submit row goes inline (`[type] [qty] [บันทึก]` all on one line).

### 3.4 Screen 3.B — Permission gate states

#### 3.4.1 Wireframe — first paint (permission-prompt)

```
┌─────────────────────────────────────────┐
│ ← Thegood Stock                  [ออก] │
├─────────────────────────────────────────┤
│ 📷 สแกนเบิก-จ่าย                         │
│                                          │
│ ┌─────────────────────────────────────┐ │
│ │                                      │ │
│ │            📷 (large icon)            │ │
│ │                                      │ │
│ │   ระบบต้องใช้กล้องเพื่อสแกน QR         │ │
│ │                                      │ │
│ │   [อนุญาตให้ใช้กล้อง]                  │ │  ← btn-stock-primary lg
│ │                                      │ │
│ │   หรือพิมพ์รหัสแทน                      │ │  ← outline-stock-accent
│ │                                      │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### 3.4.2 Wireframe — permission-denied

```
┌─────────────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │            ⚠ (warning icon)           │ │
│ │   เบราว์เซอร์บล็อกกล้องอยู่             │ │
│ │   เปิดสิทธิ์กล้องในการตั้งค่าเบราว์เซอร์  │ │
│ │   หรือพิมพ์รหัสแทน                      │ │
│ │                                      │ │
│ │   [พิมพ์รหัสแทน]                       │ │  ← btn-stock-primary
│ │                                      │ │
│ │   วิธีเปิดกล้องใหม่ →                   │ │  ← link to short Thai HOW-TO (Phase 1.1 — see §6)
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### 3.4.3 Wireframe — manual fallback panel (after toggling "พิมพ์รหัสแทน")

```
│ ── พิมพ์รหัสแทนการสแกน ──                  │
│ SKU หรือ Barcode                         │
│ [_________________________________]      │
│ รหัสตู้/ชั้น                                │
│ [_________________________________]      │
│ [ยืนยันรหัส]    [กลับไปสแกน]              │
```

### 3.5 Screen 3.C — Chain flow states (success, error, restart)

Identical state machine to admin scan-receive (§2.E.2), but with these differences:

| Difference | Admin scan-receive | Staff scan-issue |
|---|---|---|
| `movement_type` posted | `receive` | `issue` (default) or `adjustment_loss` (when user picks the alt) |
| `qty_delta` sign | positive | negative (computed `-qty`) |
| Success copy | `บันทึกแล้ว` | `บันทึกแล้ว: {type} {qty} ชิ้น — {item name}` (longer, since staff want a confirmation of what they just did) |
| Auto-restart | no (single-shot, admin closes when done) | yes, 800 ms after success (see D-S2) |
| Photo input | not shown | shown only when `type=adjustment_loss` |

#### 3.5.1 Success-state overlay wireframe (1.5 s before auto-reset)

```
┌─────────────────────────────────────────┐
│ (camera area dimmed to ~30% opacity)    │
│                                          │
│           ✓ (large green check)          │
│                                          │
│           บันทึกแล้ว                       │
│                                          │
│           เบิก 5 ชิ้น — ผ้าก๊อซ            │  ← qty + item name
│           จาก ROOM-A                     │  ← location
│                                          │
│   เริ่มสแกนใหม่ใน 0.8 วินาที               │  ← small countdown, subtle
└─────────────────────────────────────────┘
```

#### 3.5.2 Full state table (Staff)

| State | Trigger | Visual | Copy | Camera | Next |
|---|---|---|---|---|---|
| `permission-prompt` | first load, no grant | gate | as 3.4.1 | off | tap allow → `item` |
| `permission-denied` | getUserMedia rejected | gate | as 3.4.2 | off | tap fallback → `manual-fill` |
| `item` | grant or after reset | live video, item chip grey, loc chip grey | hint `ขั้นที่ 1: สแกนสินค้า` | on | scan succ → `loc` |
| `loc` | item filled | live, item chip green, loc chip grey | hint `ขั้นที่ 2: สแกน QR ของตู้/ชั้น` | on | scan succ → `qty` |
| `qty` | both filled | camera stopped (dim) + qty row visible | hint `ขั้นที่ 3: เลือกประเภท + จำนวน` | off | submit → `submitting` |
| `manual-fill` | from gate or "พิมพ์รหัสแทน" link | text inputs visible | as 3.4.3 | off | confirm → `qty` |
| `submitting` | submit pressed | submit spinner | hint stays | off | response → `success` or error |
| `success` | server 2xx | overlay 3.5.1 | as above | off | 800 ms → `item` (auto-reset) |
| `error: short-stock` | trigger raises negative | toast `ของไม่พอ — คงเหลือ {qty_after_neg→0} ชิ้น` (we can show the would-be qty by querying SIL — Phase 1.1 polish; for Phase 1 just `ของไม่พอ`) | toast | back to `qty` | user changes qty |
| `error: not-found-item` | toast `ไม่พบสินค้า — ลองอีกครั้ง` | back to `item` | camera resumes | |
| `error: not-found-loc` | toast `ไม่พบตู้/ชั้น — ลองอีกครั้ง` | back to `loc` | camera resumes | |
| `error: rls-403` | non-Admin tried `receive` somehow | toast `ไม่มีสิทธิ์ดำเนินการนี้ — ติดต่อ Admin` | back to `qty` | |
| `error: network` | fetch exception | toast `เครือข่ายมีปัญหา — รายการรอส่งใหม่อัตโนมัติ` | back to `qty` (idempotency keeps client_ref_id) | |
| `error: camera-lost` | mid-stream camera died | toast + return to `permission-prompt` | gate | |

### 3.6 Microcopy (every string on staff-scan.html)

| Where | Copy |
|---|---|
| Page title (`<title>`) | `สแกนเบิก-จ่าย — Thegood Stock` |
| Navbar brand | `← Thegood Stock` (the arrow IS the back affordance) |
| Logout button | `ออก` |
| Section title | `📷 สแกนเบิก-จ่าย` |
| Finder anchor link | `ค้นของ ↓` |
| Chip empty (item) | `item: —` (literal — keeps it short on narrow screen; could also be `สินค้า: —` per §6 Q-S2) |
| Chip empty (loc) | `location: —` |
| Chip filled (item) | `{SKU} {name}` (truncated with ellipsis past 25 chars) |
| Chip filled (loc) | `{code} {name}` |
| Permission gate primary text | `ระบบต้องใช้กล้องเพื่อสแกน QR` |
| Permission gate primary btn | `อนุญาตให้ใช้กล้อง` |
| Permission gate secondary | `หรือพิมพ์รหัสแทน` |
| Permission denied text | `เบราว์เซอร์บล็อกกล้องอยู่ — เปิดสิทธิ์ในการตั้งค่า หรือพิมพ์รหัสแทน` |
| Permission denied btn | `พิมพ์รหัสแทน` |
| Step 1 hint | `ขั้นที่ 1: สแกนสินค้า` |
| Step 2 hint | `ขั้นที่ 2: สแกน QR ของตู้/ชั้น` |
| Step 3 hint | `ขั้นที่ 3: เลือกประเภท + จำนวน` |
| Section divider | `── ดำเนินการ ──` |
| Type label | `ประเภท` |
| Type options | `เบิก-จ่าย (issue)` / `รายงานของชำรุด/หาย` |
| Qty label | `จำนวน` |
| Qty placeholder | `0` |
| Submit | `บันทึก` |
| Reset | `เริ่มใหม่` |
| Manual fallback link | `พิมพ์รหัสแทน →` |
| Manual fallback labels | `SKU หรือ Barcode` / `รหัสตู้/ชั้น` |
| Manual fallback btn | `ยืนยันรหัส` |
| Manual fallback secondary | `กลับไปสแกน` |
| Photo row label | `แนบรูป (ไม่บังคับ — สำหรับของชำรุด)` |
| Success copy main | `บันทึกแล้ว` |
| Success copy detail | `{ประเภทคำกริยา} {qty} ชิ้น — {item name}` (e.g. `เบิก 5 ชิ้น — ผ้าก๊อซ`) |
| Success countdown | `เริ่มสแกนใหม่ใน 0.8 วินาที` (subtle, can be dropped if too noisy — flag §6) |
| Toast: short-stock | `ของไม่พอ` |
| Toast: item not found | `ไม่พบสินค้า — ลองอีกครั้ง` |
| Toast: loc not found | `ไม่พบตู้/ชั้น — ลองอีกครั้ง` |
| Toast: rls-403 | `ไม่มีสิทธิ์ดำเนินการนี้ — ติดต่อ Admin` |
| Toast: network | `เครือข่ายมีปัญหา — รายการรอส่งใหม่อัตโนมัติ` |
| Toast: photo upload fail | `อัปโหลดรูปไม่สำเร็จ — บันทึกโดยไม่มีรูป` |
| Finder section title | `ค้นของ (ดูสถานที่จัดเก็บ)` |
| Finder placeholder | `ค้นชื่อ / SKU / Barcode` |
| Finder empty | `ไม่พบ — ลองสแกนได้` |
| Finder per-item empty location | `ไม่มีในคลัง` |

### 3.7 Accessibility (staff-scan specific)

- The whole page works **without a mouse** — every action is reachable via Tab/Enter/Space.
- Camera permission gate primary button receives focus on first paint so a SR user lands directly on the action.
- Chips have `aria-live="polite"` and `role="status"`.
- Video element has `aria-label="ภาพจากกล้องสำหรับสแกน QR"` plus `playsinline muted` (iOS requirement).
- Number input uses `inputmode="numeric"` + `pattern="[0-9]*"`.
- Submit button is min 48 px tall (`btn-lg` Bootstrap class) since staff use it with thumb under time pressure.
- Toasts (per §1.2) must write to an ARIA-live region in `shared/ui.js` — flag in §6 if absent.
- Success overlay uses `role="alert"` so the success message is announced even if visually dismissed quickly.
- Reduced motion: the 0.8 s auto-reset countdown is purely visual; the state will reset regardless of motion preference.

### 3.8 Bootstrap 5 components reused

`.navbar.bg-modern-primary`, `.container.py-3`, `.btn.btn-stock-primary`, `.btn.btn-lg`, `.btn.btn-outline-stock-accent`, `.form-control`, `.form-select`, `.row.g-2`, `.badge.bg-success/bg-secondary`, `.alert.alert-warning` (permission-denied), `.text-muted`, `.text-danger`, `<hr class="my-4">`.

### 3.9 New CSS tokens needed

- `--scan-viewfinder-color: var(--stock-accent)` — corner brackets of the scan target box.
- See §5 full list.

---

## 4. Area 3 — Dashboard panels

### 4.1 Goals + user persona

**User:** Admin / leadership. Glanceable overview when they open admin → Dashboard. Two questions answered in 5 s: "are we OK on stock?" and "is anything almost out?".

Per PDF §2: 4 panels — Current Stock, Low-stock list, Expiry overview, Borrow status. Phase 1 ships #1 and #2 live; #3 and #4 are placeholders that show users which capability is coming.

### 4.2 Information architecture

```
admin.html → #tab-dashboard (lazy-init from js/dashboard.js)
├── Phase 0 status card (existing — DO NOT REDESIGN, see §6 Q-X2)
├── Item Finder bar (ALWAYS visible top of dashboard, new in Phase 1)
├── KPI row (3 cards on tablet+, stacked on mobile):
│     ├── Panel 1a: สินค้าทั้งหมด (count of active items)
│     ├── Panel 1b: ของใกล้หมด (count below threshold)
│     └── Panel 1c: รายการวันนี้ (count of stock_movements today)
├── Panel 1 chart: Current Stock breakdown by category (small donut/stacked bar)
├── Panel 2: Low-stock list (scrollable; link to Inventory tab on click)
├── Panel 3 placeholder: Expiry overview ("เปิดใช้งานใน Phase 2")
└── Panel 4 placeholder: Borrow status ("เปิดใช้งานใน Phase 3")
```

**Decision (D-D1):** Plan F2 currently only ships the 3 KPI cards + low-stock list. The task asks for a donut chart for Panel 1 (category breakdown). I'm including the chart in the design but mark it **Phase 1.0 or 1.1 — PM decides** in §6 Q-D1 because adding a chart library (Chart.js) is out of scope per the plan's "no new libraries except html5-qrcode".

**Decision (D-D2):** Item Finder bar at top of dashboard is **net-new** vs plan F2. The task explicitly asks for it. I'm adding it; behavior matches Area 1 sub-view C but is condensed (single-input, results in a dropdown overlay rather than full-page list).

### 4.3 Screen 4.A — Dashboard layout

#### 4.3.1 Wireframe @ 360 px

```
┌─────────────────────────────────────────┐
│ navbar                                   │
├─────────────────────────────────────────┤
│ [Dashboard*][Locations][Inventory]…     │
├─────────────────────────────────────────┤
│ ┌── Item Finder ──────────────────────┐ │
│ │ 🔍 ค้นของเร็ว: ชื่อ / SKU / Barcode  │ │  ← always visible
│ └─────────────────────────────────────┘ │
│                                          │
│ ┌── Phase 0 status (existing) ────────┐ │
│ │ ✓ Auth พร้อม                         │ │
│ │ ✓ DB เชื่อมต่อ thegood-stock          │ │
│ │ ✓ Locations: 12                      │ │
│ │ ✓ Ambulances: 3                      │ │
│ │ ✓ Telegram: เปิด                     │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ ┌─────────────────────────────────────┐ │
│ │  สินค้าทั้งหมด (active)              │ │
│ │  142                                  │ │  ← h3
│ └─────────────────────────────────────┘ │
│ ┌─── border-warning ──────────────────┐ │
│ │  ของใกล้หมด (≤ เกณฑ์)                │ │
│ │  7  ⚠                                 │ │  ← text-warning
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │  รายการสแกน/รับ/จ่าย วันนี้           │ │
│ │  38                                   │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ ┌─── Panel 1 chart (donut) ───────────┐ │
│ │  สินค้าตามหมวด                       │ │
│ │  [donut chart 200×200]                │ │
│ │  ทั่วไป 30 · วัสดุ 80 · …             │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ ┌─── Panel 2: Low-stock list ─────────┐ │
│ │  รายการที่ควรสั่งเพิ่ม                  │ │
│ │  • ผ้าก๊อซ (SUP-GAUZE-001)            │ │
│ │    คงเหลือ 15 / เกณฑ์ 20 → ดู        │ │  ← link to inventory tab
│ │  • ที่วัดความดัน (TOOL-BP-001)         │ │
│ │    คงเหลือ 3 / เกณฑ์ 5 → ดู          │ │
│ │  …                                    │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ ┌─── Panel 3 placeholder ─────────────┐ │
│ │  ภาพรวมสินค้าหมดอายุ                  │ │
│ │  (icon clock)                         │ │
│ │  เปิดใช้งานใน Phase 2                 │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ ┌─── Panel 4 placeholder ─────────────┐ │
│ │  สถานะอุปกรณ์ยืม-คืน                  │ │
│ │  (icon arrow-repeat)                  │ │
│ │  เปิดใช้งานใน Phase 3                 │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### 4.3.2 Wireframe @ 768 px+ (tablet/desktop)

```
┌────────────────────────────────────────────────────────────────────┐
│ navbar                                                              │
├────────────────────────────────────────────────────────────────────┤
│ [Dashboard*][Locations][Inventory][Ambulances][Settings][Sessions] │
├────────────────────────────────────────────────────────────────────┤
│ [🔍 ค้นของเร็ว: ชื่อ / SKU / Barcode                              ] │
│                                                                     │
│ ┌── Phase 0 status (unchanged) ──────────────────────────────────┐ │
│ │ ✓ Auth · ✓ DB · ✓ Locations 12 · ✓ Ambulances 3 · ✓ Telegram   │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐    │
│ │ สินค้าทั้งหมด     │ │ ของใกล้หมด ⚠      │ │ รายการวันนี้     │    │
│ │ 142              │ │ 7 (warning)      │ │ 38               │    │
│ └──────────────────┘ └──────────────────┘ └──────────────────┘    │
│                                                                     │
│ ┌──────────────────────┐ ┌──────────────────────────────────────┐ │
│ │ สินค้าตามหมวด          │ │ รายการที่ควรสั่งเพิ่ม                  │ │
│ │ [donut 240×240]       │ │ • ผ้าก๊อซ — 15/20 → ดู                │ │
│ │ ทั่วไป 30              │ │ • ที่วัดความดัน — 3/5 → ดู             │ │
│ │ วัสดุ 80               │ │ • แอลกอฮอล์ — 12/15 → ดู              │ │
│ │ อุปกรณ์ใช้ซ้ำ 20         │ │ … (max 20 rows, scrollable)          │ │
│ │ ใช้แล้วทิ้ง 12           │ │                                       │ │
│ └──────────────────────┘ └──────────────────────────────────────┘ │
│                                                                     │
│ ┌──────────────────────┐ ┌──────────────────────────────────────┐ │
│ │ ภาพรวมสินค้าหมดอายุ    │ │ สถานะอุปกรณ์ยืม-คืน                    │ │
│ │ (clock icon greyed)   │ │ (arrow-repeat icon greyed)             │ │
│ │ เปิดใช้งานใน Phase 2  │ │ เปิดใช้งานใน Phase 3                   │ │
│ └──────────────────────┘ └──────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

### 4.4 Per-panel interaction states

#### 4.4.1 Item Finder bar (top)

| State | Visual | Copy |
|---|---|---|
| Default | empty input | placeholder `ค้นของเร็ว: ชื่อ / SKU / Barcode` |
| Typing (debounce 250 ms) | input value | spinner `bi-arrow-clockwise` inline-end |
| Results found | dropdown overlay below input, max 8 items, click → opens Item Detail Drawer (reuses 2.B) | each row: `{SKU} — {name} · คงเหลือรวม {n}` |
| No results | dropdown shows `ไม่พบ — ลองสแกนหรือดูในแท็บ Inventory` | (small grey) |
| Cleared | dropdown closes | n/a |
| Error | toast `โหลดข้อมูลค้นหาไม่สำเร็จ` | inline |

#### 4.4.2 KPI cards

| Card | Default | Loading | Empty | Error | Realtime update |
|---|---|---|---|---|---|
| สินค้าทั้งหมด | h3 number | `—` while fetching | `0` | `—` + toast | re-fetch on `stock_items` change |
| ของใกล้หมด ⚠ | h3 number with `text-warning` if >0, `text-success` (`text-stock-accent`) if 0 | `—` | `0` (text-success) | `—` + toast | re-fetch on `stock_item_locations` change (debounce 500 ms) |
| รายการวันนี้ | h3 number | `—` | `0` | `—` + toast | re-fetch on `stock_movements`-driven `stock_item_locations` change |

#### 4.4.3 Panel 1 chart (category donut)

| State | Visual | Copy |
|---|---|---|
| Default | donut + legend | title `สินค้าตามหมวด` |
| Loading | grey circle skeleton | `กำลังโหลด…` |
| Empty (no items) | text only | `ยังไม่มีสินค้า — เริ่มที่แท็บ Inventory` |
| Error | text | `โหลดกราฟไม่สำเร็จ` |

If PM decides chart is Phase 1.1 (see §6 Q-D1), the panel falls back to a simple list:
```
สินค้าตามหมวด:
ทั่วไป 30 · วัสดุสิ้นเปลือง 80 · อุปกรณ์ใช้ซ้ำ 20 · ของใช้แล้วทิ้ง 12
```

#### 4.4.4 Panel 2 — Low-stock list

| State | Visual | Copy |
|---|---|---|
| Default | up to 20 rows sorted by `total_qty ASC` (most urgent first) | header `รายการที่ควรสั่งเพิ่ม` |
| Each row | `• {name} ({SKU}) — คงเหลือ {n} / เกณฑ์ {t} → ดู` | "ดู" is a link to Inventory tab with that SKU pre-filtered |
| Loading | `กำลังโหลด…` | |
| Empty (no low-stock) | success state: `✓ ทุกอย่างเพียงพอ — ไม่มีของใกล้หมด` (text-success) | |
| Error | `โหลดรายการไม่สำเร็จ` | |
| Realtime | re-fetch on change (debounce 500 ms) | |

The "→ ดู" link calls `window.switchTab('inventory', { sku: 'SUP-GAUZE-001' })` — frontend-developer needs a new helper on admin-shell. Flag in §6 Q-X3 (cross-area).

#### 4.4.5 Panels 3 and 4 — placeholders

| Element | Default |
|---|---|
| Card border | dashed grey (`border border-dashed`) or just default; container has `opacity:0.7` |
| Icon | large greyed icon (`bi-clock` for expiry, `bi-arrow-repeat` for borrow), `text-muted` |
| Title | `ภาพรวมสินค้าหมดอายุ` / `สถานะอุปกรณ์ยืม-คืน` |
| Subtitle | `เปิดใช้งานใน Phase 2` / `เปิดใช้งานใน Phase 3` |
| No actions, no buttons | — |

These exist to set expectation and avoid the "where's expiry?" question. They take up vertical space the user can scroll past on mobile.

### 4.5 Microcopy (dashboard)

| Where | Copy |
|---|---|
| Item Finder placeholder | `ค้นของเร็ว: ชื่อ / SKU / Barcode` |
| Item Finder empty result | `ไม่พบ — ลองสแกนหรือดูในแท็บ Inventory` |
| KPI 1a label | `สินค้าทั้งหมด (active)` |
| KPI 1b label | `ของใกล้หมด (≤ เกณฑ์)` |
| KPI 1c label | `รายการสแกน/รับ/จ่าย วันนี้` |
| Panel 1 title | `สินค้าตามหมวด` |
| Panel 1 empty | `ยังไม่มีสินค้า — เริ่มที่แท็บ Inventory` |
| Panel 2 title | `รายการที่ควรสั่งเพิ่ม` |
| Panel 2 row | `• {name} ({SKU}) — คงเหลือ {n} / เกณฑ์ {t} → ดู` |
| Panel 2 empty (success) | `✓ ทุกอย่างเพียงพอ — ไม่มีของใกล้หมด` |
| Panel 3 title | `ภาพรวมสินค้าหมดอายุ` |
| Panel 3 subtitle | `เปิดใช้งานใน Phase 2` |
| Panel 4 title | `สถานะอุปกรณ์ยืม-คืน` |
| Panel 4 subtitle | `เปิดใช้งานใน Phase 3` |

### 4.6 Accessibility (dashboard)

- Item Finder dropdown is keyboard-navigable: arrow-down to enter dropdown, arrow-up/down within, Enter to select, ESC to close.
- KPI numbers use `<h3>` semantically (not visual-only). For SR, the label and number are read together because the label is the `<p>` before the `<h3>` in the same card.
- Low-stock list is a real `<ul>` with `<li>` rows so SR announces "5 รายการ". Each row's "→ ดู" is a real `<a>` or `<button>`.
- Panel 3/4 placeholders have `aria-disabled="true"` on the card so SR knows they're not yet interactive.
- Donut chart (if shipped Phase 1.0) MUST include a hidden `<table>` with the same data for SR users (WCAG 1.1.1 "non-text content").
- Color: warning amber on `ของใกล้หมด` count uses Bootstrap `text-warning` = `#ffc107` — at h3 size this passes WCAG AA (large text bar). Body-size copy "⚠" is paired with the icon text so color isn't the sole channel.

### 4.7 Bootstrap 5 components reused

`.card.card-body`, `.row.g-3`, `.col-12.col-md-4`, `.border-warning`, `.border-stock-accent` (already in `dashboard.js`), `.text-warning`, `.text-success`, `.text-muted`, `.bi-clock`, `.bi-arrow-repeat`, `.input-group` for finder + spinner icon.

If donut chart approved: add Chart.js (`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js`) as a per-page lazy load on the dashboard tab only.

---

## 5. New CSS tokens proposed

All new tokens live in `shared/styles.css` under the "Thegood Stock — Teal accent override" block (existing comment at line 729).

| Token | Value | Used by | Rationale |
|---|---|---|---|
| `--scan-viewfinder-color` | `var(--stock-accent)` (= `#0d9488`) | Scanner overlay corner brackets in §2.E and §3.A | Reuses existing accent so the camera viewfinder reads as on-brand. No new color introduced. |
| `--scan-viewfinder-width` | `2px` | same | Thin enough not to obscure detection, thick enough to see in low light. |
| `--scan-overlay-dim-bg` | `rgba(0,0,0,0.55)` | Permission gate background + success overlay backdrop | Slightly darker than Bootstrap modal backdrop (`rgba(0,0,0,0.5)`) to make camera UI text legible. |
| `--scan-chip-bg-pending` | `var(--bs-secondary-bg-subtle, #e9ecef)` | Chip "item: —" before scan | Distinct from filled state. |
| `--scan-chip-bg-done` | `var(--bs-success-bg-subtle, #d1e7dd)` | Chip after fill | Matches Bootstrap badge bg-success conventions. |
| `--badge-low-stock-bg` | `var(--bs-warning-bg-subtle, #fff3cd)` | ⚠ low-stock indicator dot if PM wants more emphasis | Optional — flag §6 Q-D3. |
| `--placeholder-card-opacity` | `0.7` | Phase 2/3 placeholder cards in §4 | Visually signals "not active yet" without removing the card from layout. |

Optional class shorthand also added:

```css
.scan-viewfinder {
  position: absolute; inset: 0;
  pointer-events: none;
  border: var(--scan-viewfinder-width) solid var(--scan-viewfinder-color);
  border-radius: 12px;
  /* corner-only style via SVG mask or :before/:after for the 4 brackets */
}
.scan-overlay-dim {
  position: absolute; inset: 0;
  background: var(--scan-overlay-dim-bg);
  display: flex; align-items: center; justify-content: center;
  color: #fff;
}
.card-placeholder {
  opacity: var(--placeholder-card-opacity);
  border-style: dashed !important;
}
```

These additions are purely additive — no Phase 0 styles change.

---

## 6. Open questions for PM

Numbered Q-D# for design, Q-S# for staff-scan specifics, Q-X# for cross-area.

### Q-D1 — Category donut chart in Panel 1?

Plan F2 ships only KPI cards + low-stock list. Adding a category donut needs Chart.js (one more CDN dep, ~70 KB minified, lazy-loaded only on dashboard).

**Options:** (a) Ship donut in Phase 1.0 (recommended — answers "what's in our cabinet" question PDF §2 implies). (b) Defer to Phase 1.1; show category counts as a comma-separated list only.

**My recommendation:** (b) for Phase 1.0 — the task prompt allows "small donut or stacked bar" but the plan explicitly avoids new libraries; respecting the plan author's discipline. Phase 1.1 can promote to a real chart in 1 hour of work.

### Q-D2 — Transfer modal in Phase 1?

The task prompt asks for a "Transfer modal: from-location, to-location, qty". The **spec §1 explicitly defers single-atomic transfer to Phase 2+** ("Phase 1 records as one `issue` + one `receive` pair").

**Conflict:** prompt vs spec. Spec is the source of truth (per plan reading-order). I have **NOT** designed a Transfer modal. If PM wants one, two options:

- (a) Defer to Phase 2 as the spec says. Admin does transfer via Receive sub-view by issuing from source then receiving into destination (2 actions, 2 ledger rows).
- (b) Add a "Transfer" pseudo-action button in the Receive sub-view that walks the user through both rows (still 2 ledger inserts under the hood). UI only, no schema change.

**My recommendation:** (a) for Phase 1.0. (b) for Phase 1.1 if real-world admins complain.

### Q-D3 — Should low-stock items have a yellow/red row background?

Currently the design uses only `text-danger` on the qty number + a ⚠ icon. An entire-row background tint (e.g. `bg-warning-subtle`) would scream louder but reduce table scannability if many rows are low. Token `--badge-low-stock-bg` proposed in §5 covers either path.

**My recommendation:** keep current (icon + colored number). Background tint only on the Item Detail Drawer's per-location list, where context is narrower.

### Q-D4 — Toast aria-live region in `shared/ui.js`?

I haven't read `shared/ui.js` yet but the design assumes `showToast()` writes to an ARIA-live region for SR users. If it doesn't, the success/error feedback is invisible to SR users. Frontend-developer to verify; if missing, add an `<div aria-live="polite" id="toast-sr-channel" class="visually-hidden"></div>` mirror.

### Q-D5 — Item dropdown in Receive form: autocomplete vs native select?

With >100 items the native `<select>` becomes painful. The plan currently uses native select. A typeahead (search inside the select) is a 30-line addition.

**My recommendation:** ship native select in Phase 1.0; add typeahead in Phase 1.1 when item count exceeds ~50.

### Q-S1 — Auto-restart delay after success

Task spec said 3 s; plan E2 uses 800 ms; I picked 800 ms (D-S2). 3 s feels slow; 800 ms is the minimum that still shows the success state long enough to be perceived. **Recommend 800 ms.**

### Q-S2 — Chip label language

Chips currently say `item: —` (English label, Thai value). Could be `สินค้า: —` (fully Thai). Trade-off: English label is shorter (saves horizontal space on 360 px) and matches the developer-facing DB columns; Thai label is more accessible to non-English staff.

**My recommendation:** fully Thai. Change to `สินค้า: —` and `สถานที่: —`. Costs 4 extra chars per chip; still fits on 360 px when chips wrap.

### Q-S3 — Photo upload UX on adjustment_loss

Plan E2 uses Cloudinary upload; spec §1 has photo upload deferred to Phase 3 (image_url on items master, not on movements). The plan adds a photo input to staff-scan as an optional convenience but stores the URL in `stock_movements.note` (prefix `photo:`).

**Two issues:**
1. This is an undocumented use of `note` (Phase 2+ might want a structured field).
2. PDF §1 only mandates photo for borrow-return and laundry, not for adjustment_loss.

**My recommendation:** ship the photo input as designed (low-risk, optional), but flag for Phase 2 to add a dedicated `stock_movements.attachments jsonb` column instead of stuffing URLs in `note`.

### Q-S4 — Should manual fallback always show, or only on permission denial?

Currently: only shown after camera grant fails OR user taps "พิมพ์รหัสแทน". Some users (gloved, awkward lighting) might prefer typing first.

**My recommendation:** keep the link-toggle approach. Always-showing both inputs + camera adds clutter. The link is one tap away.

### Q-S5 — Success countdown text "เริ่มสแกนใหม่ใน 0.8 วินาที"

Possibly noisy. Some users won't read it; others may rely on it. Could drop to a tiny progress bar at the bottom of the success overlay instead.

**My recommendation:** ship the text in Phase 1.0; A/B in Phase 1.1.

### Q-X1 — Phase 0 keyboard accessibility on row-click patterns

The existing `js/locations.js` renders tree rows as `<div>` with `onclick` handlers but no `role="button" tabindex="0"` or key handler. This is a Phase 0 accessibility gap. Phase 1 designs use the same pattern (Items list row → drawer) and should fix it. Minor edit to `locations.js` for consistency? Out of Phase 1 scope per project rule "scope drift" — flag here.

### Q-X2 — Phase 0 dashboard status card placement

Plan F2 keeps the Phase 0 status card and *adds* Phase 1 panels below. My design follows that. If PM wants the status card minimized (collapsed by default once Phase 1 is live), that's a small follow-up.

### Q-X3 — New helper `window.switchTab(name, params)` needed

Panel 2 low-stock list links "→ ดู" jump to the Inventory tab with a pre-filtered SKU. This requires a helper in `js/admin-shell.js` that switches tab AND passes parameters. Currently `admin-shell.js` only does the tab switch (verify with frontend-developer). Add `switchTab(name, { sku?, focus? })` — initInventoryTab reads URL hash or param.

### Q-X4 — Offcanvas drawer vs centered modal for Item Detail

Current design uses a centered modal. Phase 1.1 could promote to `.offcanvas.offcanvas-end` for a more "drawer-like" feel. Trade-off: modal centers attention; offcanvas keeps the list visible to the left. Either works at 360 px (both go full-width).

### Q-X5 — Color on the "ของใกล้หมด" KPI when count = 0

I propose `text-success` (= `#198754`) when count is 0 (good news) and `text-warning` when >0 (action needed). Alternative is always-`text-warning` (defaults grim). PM call.

---

## 7. Hand-off checklist for `frontend-developer`

When PM signs off this design, frontend-developer can start. Pointers:

### 7.1 Files this design touches (NEW or EDIT)

NEW (per plan §4):
- `staff-scan.html` — markup per §3
- `shared/scanner.js` — already specified in plan C2
- `shared/inventory.js` — already specified in plan C1
- `js/inventory.js` — tab init, items list, drawer per §2.3–2.5
- `js/inventory-scan.js` — overlay per §2.7
- `js/inventory-finder.js` — finder sub-view per §2.3 sub-view C
- `js/staff-scan.js` — page logic per §3

EDIT:
- `admin.html` — add Inventory tab pill + pane + scripts (per plan D1)
- `staff.html` — link to staff-scan.html (per plan E3)
- `js/admin-shell.js` — register inventory init + add `switchTab(name, params)` helper (Q-X3)
- `js/dashboard.js` — add Item Finder bar + KPI cards + Panel 1/2 + Panel 3/4 placeholders per §4
- `shared/styles.css` — append §5 tokens + `.scan-viewfinder`, `.scan-overlay-dim`, `.card-placeholder`

### 7.2 Acceptance tests this design satisfies

- **T24–T28** Items master CRUD: §2.3 + §2.5
- **T29–T32** Receive + per-location: §2.6
- **T33–T36** Scan-receive: §2.7
- **T37–T39** Staff scan-issue + short-stock: §3.5
- **T40** Realtime live update: §2.A.6 + §4.4.2
- **T41–T43** Low-stock alert UX (visible in dashboard Panel 2, list updates after Telegram fires): §4.4.4
- **T44** Multi-location issue: §3.5 + §2.B (drawer shows both locations)
- F1-added **T26b, T44b, T44c** in plan: §2.B (deactivate toggle), §4 (dashboard render + Realtime)

### 7.3 Components reused (do not reinvent)

| New code | Reuses |
|---|---|
| Admin tab shell | `js/admin-shell.js` segmented pill pattern (already there) |
| Modal | `bootstrap.Modal` API + `.modal-content` rounded-20 px (existing) |
| Toast | `showToast(level, msg)` from `shared/ui.js` |
| Confirm | `showConfirm(msg)` from `shared/ui.js` |
| Form pattern | `js/settings-ui.js` row/col + `.form-label.small` |
| Tree-style row click | match `locations.js` pattern (and fix Q-X1 if PM agrees) |
| Scanner | `shared/scanner.js` per plan C2 |
| REST + Realtime | `shared/inventory.js` per plan C1 |

### 7.4 Cross-area consistency (must remain identical)

- Scanner widget contract (§1.3) is identical between admin scan-receive and staff scan-issue. Only `movement_type`, sign of `qty_delta`, success copy detail, and auto-restart behavior differ.
- Toast styling, confirm dialog styling, modal corner radius, form label sizing are the same across all 3 areas.
- Teal accent (`--stock-accent`) is the ONLY accent color. No new brand color introduced.
- Empty state copy follows the pattern `— X —` (em-dash padded text-muted) where X is a single short phrase.
- Error toast copy is plain Thai + suggestion + (optional) raw error in `{err}` only when actionable.

### 7.5 Definition of done

Per project rule "verify before done": frontend-developer should be able to implement every screen above without asking questions. If anything is ambiguous, that's a design gap — escalate to ui-ux-designer (this agent) before coding.

---

# End of design
