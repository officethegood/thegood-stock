# DRAFT — Phase 6 UI/UX Design: Linens and Laundry Count + Photo Audit

**Project:** Thegood Stock Management System
**Phase:** 6 (Linens and Laundry — count-based, photo-verified, cabinet-level)
**Date:** 2026-05-19
**Author:** UI/UX Designer (autonomous draft)
**Status:** DRAFT — pending PM review + Phase 6 spec Q6-A through Q6-F resolution
**Source spec:** `docs/superpowers/specs/2026-05-19-phase6-linens-laundry-design.md`
**Phase 2 design ref:** `docs/superpowers/designs/2026-05-18-phase2-ui-design.md`
**Phase 3 design ref:** `docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md`
**Phase 5 design ref:** `docs/superpowers/designs/2026-05-19-phase5-oxygen-ui-design.md`
**Next agent:** `frontend-developer`

---

## Table of Contents

- §1 Purpose, user stories, and assumed user context
- §2 Information architecture (screen list + ASCII diagram)
- §3 Screen-by-screen mockups and interaction states
  - §3.1 Admin — Inventory tab: "ผ้า" category filter (extension of Phase 1/2 segmented row)
  - §3.2 Admin — Inventory tab: Linen item list (category=LINEN active)
  - §3.3 Admin — Cabinet detail drawer (linen items within a cabinet)
  - §3.4 Admin — Receive/Adjust form: LINEN item pre-fill behavior
  - §3.5 Staff — Cabinet QR scan landing: linen cabinet view
  - §3.6 Staff — ส่งซัก (laundry-out) flow (4 screens)
  - §3.7 Staff — รับคืน (laundry-in) flow (4 screens)
  - §3.8 Staff — นับใหม่ (count snapshot) flow (4 screens)
  - §3.9 Dashboard — "นับผ้าวันนี้" summary panel
- §4 Component reuse map
- §5 Interaction state diagrams
  - §5.1 Admin Inventory tab — linen category filter state machine
  - §5.2 Staff linen cabinet view — 3-workflow state machine
  - §5.3 ส่งซัก / รับคืน / นับใหม่ step-by-step flow
- §6 Microcopy table (all Thai strings)
- §7 Accessibility notes
- §8 Open UX questions for PM (design-blocking)
- §9 New CSS tokens proposed
- §10 Hand-off note to frontend-developer

---

## 1. Purpose, User Stories, and Assumed User Context

### 1.1 Why this design exists

Phases 1–5 track stock by SKU + quantity (Phase 1–4) or per-piece serial (Phase 5).
Linens (ผ้าปูที่นอน, ผ้าห่ม, ผ้าขนหนู, เสื้อกาวน์, ผ้าเช็ดเครื่องมือ) are SKU-quantity items
assigned to specific cabinets. The unique requirements are:

1. **Cabinet-level count snapshots** — a nightly audit compares the most recent count against
   the system qty and fires a Telegram alert if the discrepancy exceeds the threshold.
2. **Laundry lifecycle movements** — ส่งซัก (laundry-out) and รับคืน (laundry-in) are stock
   adjustments that require a mandatory photo for audit integrity.
3. **No new top-level tab** — linens live in the existing Inventory tab via a category filter,
   following the same "ผ้า" category pill pattern already used by GENERAL / SUPPLY / TOOL / CONSUME.

### 1.2 User stories

**US-L1 — Admin checks linen discrepancies after the daily cron**
"I get a Telegram alert that ผ้าปูที่นอน in Cabinet A-2 is off by 4 pieces. I open the
Inventory tab, tap 'ผ้า', see the red badge on that row, and understand the situation."
Acceptance: Inventory tab → "ผ้า" filter → linen list → red discrepancy badge on affected row.

**US-L2 — Staff sends a batch of linens to the laundry**
"Before the morning shift I gather all used bed-sheets from Cabinet A-2. I scan the cabinet
QR, tap 'ส่งซัก', photograph the pile, enter the quantity, confirm. The system records the
loss movement and the qty drops."
Acceptance: Staff scan → cabinet QR → ส่งซัก → photo (required) → qty → confirm → movement inserted.

**US-L3 — Night staff receives laundered linens back (Q6-F scenario)**
"At 23:00 the laundry returns 8 towels. I tap 'รับคืน', photograph the return, enter 8, confirm."
Acceptance: รับคืน flow works if staff RBAC is extended (Q6-F Option B). Design works
regardless — see §8 Q6-F note on how the button state differs per RBAC decision.

**US-L4 — Staff does a routine periodic count**
"Every evening I count all linens in Cabinet B-1 and enter the actual numbers. The system
records the snapshot; if the count matches I see a green badge."
Acceptance: นับใหม่ flow → photo (advisory, Skip visible) → count input → linen_counts row inserted.

**US-L5 — Admin adds a new linen SKU**
"Management bought a new type of gown. I add it in Inventory (รับเข้า sub-view), select
category=LINEN, pick sub-category เสื้อกาวน์, assign to a cabinet."
Acceptance: Existing "เพิ่มสินค้า" form extended with linen_subcategory dropdown when category=LINEN.

### 1.3 Assumed user context (explicit)

| Assumption | Impact on design |
|---|---|
| **Staff** is on a phone, one hand free, near a linen cabinet in a clinical setting. Gloves possible. | Tap targets ≥44 px on all interactive elements. Action buttons ≥52 px height on linen cabinet view. |
| **Admin** is on tablet or desktop for the Inventory tab view. Mobile admin is secondary. | Linen item list table uses horizontal scroll on mobile (<576 px). Discrepancy badge always visible without horizontal scroll. |
| **Photo screen**: staff is photographing a physical stack of linens on a shelf or trolley. Camera must open immediately. | Photo-capture modal goes directly to camera on mobile (no extra tap). |
| **Count input**: entered while physically counting a pile. Risk of fat-finger errors. | Count input is a large numeric keypad-style input. A "+1 / -1" stepper is shown next to the input for adjustment. |
| **Network**: online-only. Movements and count snapshots require confirmed REST response before success toast. | Loading state mandatory on Confirm button. No offline queue. |
| **Discrepancy badge**: clinical setting — staff may ask "why is the count off?" UI must not create alarm fatigue. | Only is_discrepancy=true rows show the red badge. Advisory amber used for "close to threshold". Green used for in-tolerance (see §9 for token). |
| **All copy in Thai.** English in parentheses only for developer-stable technical terms. | All labels Thai-first throughout. |

---

## 2. Information Architecture

### 2.1 Screen list

| Screen ID | Surface | Screen name | Phase 6 status |
|---|---|---|---|
| S-6.1 | `admin.html` Inventory tab | Linen category filter pill ("ผ้า") | NEW pill in existing filter row |
| S-6.2 | `admin.html` Inventory tab | Linen item list (category=LINEN active) | NEW sub-view inside existing Inventory tab |
| S-6.3 | `admin.html` Inventory tab | Sub-category pills (segmented) above linen list | NEW, within S-6.2 |
| S-6.4 | `admin.html` Inventory tab | Cabinet detail drawer — linen section | EXTENSION of Phase 1 drawer |
| S-6.5 | `admin.html` Inventory tab | Receive form — LINEN item pre-fill | EXTENSION of Phase 1 "รับเข้า" sub-view |
| S-6.6 | `staff-scan.html` | Linen cabinet view (after cabinet QR scan) | NEW panel inside existing scan page |
| S-6.7 | `staff-scan.html` | ส่งซัก step 1: photo screen | NEW (reuses PhotoCaptureModal) |
| S-6.8 | `staff-scan.html` | ส่งซัก step 2: qty screen | NEW |
| S-6.9 | `staff-scan.html` | ส่งซัก step 3: confirm screen | NEW |
| S-6.10 | `staff-scan.html` | รับคืน step 1: photo screen | NEW (reuses PhotoCaptureModal) |
| S-6.11 | `staff-scan.html` | รับคืน step 2: qty screen | NEW |
| S-6.12 | `staff-scan.html` | รับคืน step 3: confirm screen | NEW |
| S-6.13 | `staff-scan.html` | นับใหม่ step 1: photo screen | NEW (reuses PhotoCaptureModal) |
| S-6.14 | `staff-scan.html` | นับใหม่ step 2: count screen | NEW |
| S-6.15 | `staff-scan.html` | นับใหม่ step 3: confirm screen | NEW |
| S-6.16 | `admin.html` Dashboard tab | "นับผ้าวันนี้" summary panel | NEW panel (optional — see §3.9) |

**Architectural principle:** Phase 6 adds NO new HTML pages and NO new top-level admin nav tabs.
All linen workflows are extensions of:
- `admin.html` Inventory tab (category filter + sub-view)
- `staff-scan.html` (cabinet QR scan → linen cabinet view → workflow modals/steps)

### 2.2 Architecture diagram (ASCII)

```
admin.html
└── nav-pills (unchanged: Dashboard | Locations | Inventory | Ambulances | Settings | Sessions)
    │
    ├── #tab-dashboard (EXTENDED Phase 6)
    │     └── Panel: "นับผ้าวันนี้" [S-6.16]
    │           — discrepancy count badge + "ดูทั้งหมด →" → Inventory tab + ผ้า filter
    │
    └── #tab-inventory (EXTENDED Phase 6)
          │
          ├── Toolbar row (Phase 1/2 base — segmented + buttons — unchanged)
          │     ├── Segmented: สินค้า | รับเข้า | ล็อตยา | ค้นของ  (unchanged from Phase 2)
          │     └── Category filter row (Phase 1): ทั้งหมด | GENERAL | SUPPLY | TOOL | CONSUME
          │
          ├── **Phase 6 NEW: "ผ้า" pill added to category filter row** [S-6.1]
          │     When "ผ้า" active:
          │     │
          │     ├── Sub-category pills [S-6.3]:
          │     │     ทั้งหมด | ผ้าปูที่นอน | ผ้าห่ม | ผ้าขนหนู | เสื้อกาวน์ | ผ้าเช็ดเครื่องมือ
          │     │
          │     ├── Discrepancy banner (amber, if any is_discrepancy=true) [S-6.2 header]
          │     │
          │     └── Linen item list table [S-6.2]:
          │           ชื่อ | หมวดย่อย | ตู้ | คงเหลือ | นับล่าสุด | จำนวนนับ | ต่างจากระบบ
          │
          └── รับเข้า sub-view (EXTENDED Phase 6) [S-6.5]:
                — when LINEN item selected, reason pre-filled + sub-category field shown

staff-scan.html
└── Scan flow (Phase 1/2/3 base unchanged)
    │
    └── **Phase 6 NEW: Cabinet QR scan → LINEN item check**
          │
          ├── IF cabinet has LINEN items → Linen cabinet view [S-6.6]
          │     — header: ตู้ [name] — รายการผ้า
          │     — list: item name | คงเหลือ | นับล่าสุด | [ส่งซัก] [รับคืน] [นับใหม่]
          │
          ├── ส่งซัก flow [S-6.7 → S-6.8 → S-6.9]
          │     Photo (required) → Qty → Confirm → POST adjustment_loss reason=laundry_out
          │
          ├── รับคืน flow [S-6.10 → S-6.11 → S-6.12]
          │     Photo (required) → Qty → Confirm → POST adjustment_gain reason=laundry_in
          │
          └── นับใหม่ flow [S-6.13 → S-6.14 → S-6.15]
                Photo (advisory, Skip visible) → Count → Confirm → POST linen_counts
```

---

## 3. Screen-by-Screen Mockups and Interaction States

### 3.1 Admin — "ผ้า" Category Filter Pill [S-6.1]

#### Context

The Inventory tab already has a category filter row (Phase 1). Phase 6 adds "ผ้า" as a
sixth pill in that row. No change to the segmented control (สินค้า / รับเข้า / ล็อตยา / ค้นของ).

**Principle:** When "ผ้า" is active in the category filter while "สินค้า" (item list) segment
is active, the items table is replaced by the linen-specific table (fetched from `v_linen_audit`).
When any other segment is active (รับเข้า, ค้นของ), the category filter still affects which items
appear in those sub-views — no special linen behavior.

#### 3.1.1 Wireframe — category filter row @ 360 px

```
┌─────────────────────────────────────────────────────────┐
│ ← (segmented control, unchanged) ─────────────────────  │
│  [สินค้า*] [รับเข้า] [ล็อตยา] [ค้นของ]                   │
├─────────────────────────────────────────────────────────┤
│ ── หมวดหมู่ ────────────────────────────────────────── │
│                                                         │
│  [ทั้งหมด] [GENERAL] [SUPPLY] [TOOL] [CONSUME] [ผ้า*]   │
│                                   ← scrollable row →    │
│                                                         │
│  ↑ "ผ้า" pill shown active (teal bg, white text)        │
│                                                         │
│ ── ผ้าที่มีความคลาดเคลื่อน: 2 รายการ ─────────── [amber] │
│                                                         │
│ ── ผ้าและสิ่งทอ ────────────────────────────────────── │
│  ทั้งหมด | ผ้าปูที่นอน | ผ้าห่ม | ผ้าขนหนู | เสื้อกาวน์  │
│  ผ้าเช็ดเครื่องมือ        ← sub-category pills (row 2)  │
└─────────────────────────────────────────────────────────┘
```

#### 3.1.2 Category pill states

| State | Visual |
|---|---|
| Default (inactive) | `.btn-outline-secondary.rounded-pill` — Bootstrap border, grey text |
| Active | `.btn-stock-primary.rounded-pill` — `--stock-accent` teal bg, white text |
| Hover (inactive) | Background tints to `--stock-accent-subtle` |
| "ผ้า" active AND discrepancy exists | amber alert banner appears below pills (see §3.2) |

---

### 3.2 Admin — Linen Item List (category=LINEN active) [S-6.2]

#### Context

When "ผ้า" is active and the "สินค้า" segment is active, data is fetched from `v_linen_audit`.
The standard items table is replaced by a linen-specific table with audit columns.

#### 3.2.1 Discrepancy banner

Appears when `v_linen_audit` returns at least one row with `is_discrepancy=true`.

```
┌─────────────────────────────────────────────────────────┐
│  ⚠  ผ้าที่มีความคลาดเคลื่อน: 2 รายการ                   │
│     คลาดเคลื่อนเกินเกณฑ์ (>5% หรือ >2 ผืน)            │
└─────────────────────────────────────────────────────────┘
```

Styling: `alert alert-warning` (Bootstrap amber). No custom token needed — `alert-warning`
is already used in other parts of the app for threshold warnings.

If no discrepancies: banner is NOT shown. Do not show a "ทุกรายการปกติ" green banner —
the absence of a warning is sufficient signal. Reduces alert fatigue.

#### 3.2.2 Sub-category pills [S-6.3]

Above the linen item list. Filters the list client-side.

```
┌─────────────────────────────────────────────────────────┐
│  ทั้งหมด  ผ้าปูที่นอน  ผ้าห่ม  ผ้าขนหนู  เสื้อกาวน์     │
│  ผ้าเช็ดเครื่องมือ                                       │
└─────────────────────────────────────────────────────────┘
```

Layout: two rows on 360 px (3 pills + 2 pills). One row on ≥576 px.
Pill style: same as category filter — `.btn-outline-secondary.rounded-pill` / `.btn-stock-primary.rounded-pill`.
"ทั้งหมด" is the default active state.

#### 3.2.3 Linen item list table @ 360 px (mobile)

Mobile layout: Priority columns always visible. Lower-priority columns visible on ≥768 px.

```
┌─────────────────────────────────────────────────────────┐
│ ชื่อผ้า             คงเหลือ   ต่างจากระบบ               │
│ ─────────────────────────────────────────────────────── │
│ ผ้าปูที่นอน          10 ผืน   [  0  ]●                  │
│ ตู้ A-2 • นับ: 10 ผืน • 18 พ.ค.                         │
│ ─────────────────────────────────────────────────────── │
│ ผ้าห่ม                8 ผืน   [ -3  ]●                  │
│ ตู้ A-2 • นับ: 5 ผืน • 18 พ.ค.                          │
│ ─────────────────────────────────────────────────────── │
│ ผ้าขนหนู             12 ผืน   [  0  ]●                  │
│ ตู้ B-1 • นับ: 12 ผืน • 19 พ.ค.                         │
│ ─────────────────────────────────────────────────────── │
│ เสื้อกาวน์            6 ตัว   — ยังไม่เคยนับ            │
│ ตู้ B-1 • ไม่มีข้อมูลการนับ                              │
└─────────────────────────────────────────────────────────┘
```

**Column definitions:**
- ชื่อผ้า — `stock_items.name`. On mobile, sub-row shows: ตู้ [location_name] • นับ: [counted_qty] ผืน/ตัว • [counted_at date]
- คงเหลือ — `v_linen_audit.current_qty` + unit
- ต่างจากระบบ — `v_linen_audit.delta` formatted as signed integer; color + badge suffix (see §3.2.4)

**Full table @ ≥768 px (tablet/desktop):**
All columns visible — ชื่อ | หมวดย่อย | ตู้ | คงเหลือ | นับล่าสุด | จำนวนนับ | ต่างจากระบบ

#### 3.2.4 Discrepancy indicator badge

| Condition | Badge | Color |
|---|---|---|
| `is_discrepancy=true` (delta exceeds threshold) | `–N` or `+N` in badge | Red: `badge bg-danger` |
| Close to threshold (abs_delta >= 1 but not exceeding) | `–N` or `+N` | Amber: `badge bg-warning text-dark` |
| No discrepancy (delta=0) | `0` | Green: `badge bg-success` |
| No count yet (`counted_at IS NULL`) | `—` (em-dash, no badge) | Grey: `text-muted` |

**Close-to-threshold definition for UX:** abs_delta = 1 AND abs_delta < threshold. This
is a UX-only indicator — not a DB concept. Computed client-side from `abs_delta` and threshold settings.

**Note:** Color is NOT the only information carrier. Each badge also shows the numeric delta
value, so users with color vision deficiency can still read the state.

#### 3.2.5 Interaction states

| State | Visual |
|---|---|
| Default (data loaded) | Table rows visible, discrepancy banner shown/hidden |
| Loading | Spinner overlay on table body; `monitor-loading` class on table |
| Error (network) | `alert alert-danger`: "โหลดข้อมูลผ้าไม่สำเร็จ — กรุณาลองใหม่" + retry button |
| Empty (no LINEN items in any cabinet) | `text-muted` centered: "ยังไม่มีสินค้าหมวดผ้าในระบบ — เพิ่มสินค้าใน รับเข้า" |
| Empty (sub-category filter, no results) | "ไม่พบผ้าหมวด [ชื่อหมวด] ในระบบ" |

---

### 3.3 Admin — Cabinet Detail Drawer: Linen Section [S-6.4]

#### Context

The existing Phase 0/1 Locations drawer shows cabinet details (items in that location,
movement history). Phase 6 extends this drawer: when a cabinet contains LINEN items,
a dedicated "ผ้าในตู้นี้" section appears below the existing item list.

This is an EXTENSION of an existing component, not a new screen.

#### 3.3.1 Linen section within cabinet drawer @ 360 px

```
┌──────────────────────────────────────────────────────┐
│  ตู้ A-2 — รายละเอียด                      [✕ ปิด]  │
├──────────────────────────────────────────────────────┤
│  ... (existing location info: type, code, parent) ... │
├──────────────────────────────────────────────────────┤
│  ── รายการสินค้าทั่วไป ─────────────────────────── │
│  ... (existing item list) ...                         │
├──────────────────────────────────────────────────────┤
│  ── ผ้าในตู้นี้ ──────────────────────────────────  │ ← NEW section
│                                                      │
│  ผ้าปูที่นอน                                         │
│  คงเหลือ: 10 ผืน  •  นับล่าสุด: 18 พ.ค. 69          │
│  [⬤ ปกติ] จำนวนนับ: 10 ผืน                         │
│                                                      │
│  ผ้าห่ม                                              │
│  คงเหลือ: 8 ผืน  •  นับล่าสุด: 18 พ.ค. 69           │
│  [⬤ คลาดเคลื่อน] นับได้: 5 ผืน  ต่างกัน: −3        │
│                                                      │
│  [ดูประวัติการนับ →]                                 │
└──────────────────────────────────────────────────────┘
```

The "ดูประวัติการนับ →" link opens a sub-section listing the last 10 `linen_counts` rows
for this cabinet (all items combined), sorted by `counted_at DESC`.

---

### 3.4 Admin — Receive/Adjust Form: LINEN Item Pre-fill [S-6.5]

#### Context

The existing "รับเข้า / ปรับสต๊อก" form in the Inventory tab (Phase 1) already has a
`reason` free-text input. Phase 6 extends this form:

- When the selected item has `category=LINEN`: the `reason` field is pre-populated with
  `laundry_in` (for `adjustment_gain`) or `laundry_out` (for `adjustment_loss`), and
  a read-only "หมวดย่อย" display row appears below the item selector.
- The `reason` field remains editable (Admin may override).

#### 3.4.1 LINEN item pre-fill behavior

```
┌──────────────────────────────────────────────────────┐
│ รับเข้า / ปรับสต๊อก                                   │
├──────────────────────────────────────────────────────┤
│ สินค้า *                                               │
│ [ผ้าปูที่นอน (LINEN-SHEET-001)         ▾]             │
│                                                      │
│ หมวดย่อย (อ่านอย่างเดียว)                              │ ← NEW
│ ผ้าปูที่นอน                                           │
│                                                      │
│ ประเภทการเคลื่อนไหว *                                 │
│ [ปรับสต๊อก (เพิ่ม)  ▾]                                │
│                                                      │
│ เหตุผล                                               │
│ [laundry_in                          ] ← pre-filled  │ ← CHANGED
│  ℹ  กรณีรับผ้าคืนจากซักรีด — แก้ไขได้                │
│                                                      │
│ จำนวน *    [  8  ]                                   │
│ สถานที่ *  [ตู้ A-2  ▾]                               │
└──────────────────────────────────────────────────────┘
```

The pre-fill logic runs in JS when the item selector changes:
```
if (selectedItem.category === 'LINEN') {
  // pre-fill reason based on movement_type selection
  if (movementType === 'adjustment_gain') reason.value = 'laundry_in';
  if (movementType === 'adjustment_loss') reason.value = 'laundry_out';
  showLinenSubcategoryBadge(selectedItem.linen_subcategory);
}
```

---

### 3.5 Staff — Linen Cabinet View [S-6.6]

#### Context

When staff scans a cabinet QR code and the cabinet has `type='cabinet'`, the existing
Phase 1 staff-scan flow shows the "item scan" step. Phase 6 intercepts this flow:
if the cabinet has any LINEN items (`stock_item_locations JOIN stock_items WHERE category=LINEN`),
a dedicated linen cabinet view is rendered instead of proceeding to the standard item scan.

If the cabinet has NO LINEN items, the standard Phase 1 flow continues unmodified (fall-through).

#### 3.5.1 Wireframe @ 360 px (mobile-first, primary)

```
┌──────────────────────────────────────────────────────┐
│ navbar — [← กลับ]   THE GOOD STOCK   [👤]            │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ตู้ A-2 — รายการผ้า                                  │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  ผ้าปูที่นอน                                 │   │
│  │  คงเหลือ: 10 ผืน  •  นับล่าสุด: 18 พ.ค.    │   │
│  │  [●ปกติ]                                    │   │
│  │                                              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │   │
│  │  │ ส่งซัก   │ │ รับคืน   │ │ นับใหม่  │    │   │
│  │  │(สีส้ม)   │ │(สีเขียว) │ │(สีฟ้า)   │    │   │
│  │  └──────────┘ └──────────┘ └──────────┘    │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  ผ้าห่ม                                      │   │
│  │  คงเหลือ: 8 ผืน  •  นับล่าสุด: 18 พ.ค.     │   │
│  │  [●คลาดเคลื่อน −3]                          │   │
│  │                                              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │   │
│  │  │ ส่งซัก   │ │ รับคืน   │ │ นับใหม่  │    │   │
│  │  └──────────┘ └──────────┘ └──────────┘    │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  ผ้าขนหนู                                    │   │
│  │  คงเหลือ: 12 ผืน  •  ยังไม่เคยนับ            │   │
│  │  [— ไม่มีข้อมูลนับ]                          │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │   │
│  │  │ ส่งซัก   │ │ รับคืน   │ │ นับใหม่  │    │   │
│  │  └──────────┘ └──────────┘ └──────────┘    │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

#### 3.5.2 Empty state (no LINEN items in this cabinet)

```
┌──────────────────────────────────────────────────────┐
│  ตู้ A-2 — รายการผ้า                                  │
│                                                      │
│        🚫  ตู้นี้ยังไม่มีรายการผ้า                    │
│            ติดต่อผู้ดูแลระบบเพื่อเพิ่มสินค้า          │
│                                                      │
│       [← สแกนใหม่]                                   │
└──────────────────────────────────────────────────────┘
```

#### 3.5.3 Action button specifications

Each item card has three action buttons in a row:

| Button | Thai label | Color | Bootstrap class | Tap target height |
|---|---|---|---|---|
| ส่งซัก | ส่งซัก | Orange | `btn btn-warning text-dark btn-sm` | ≥44 px |
| รับคืน | รับคืน | Green | `btn btn-success btn-sm` | ≥44 px |
| นับใหม่ | นับใหม่ | Teal | `btn btn-stock-primary btn-sm` | ≥44 px |

On narrow screens (360 px), three buttons share the row. Each button minimum width: 90 px.
If three buttons cannot fit (ultra-narrow < 320 px), stack vertically: ส่งซัก on top, รับคืน middle, นับใหม่ bottom.

**RBAC-conditional rendering of รับคืน (Q6-F dependency):**
- If Q6-F resolved to Option A (Admin-only): รับคืน button is hidden for Employee role.
  Show tooltip on hover (desktop): "รับคืนได้เฉพาะผู้ดูแลระบบ" — but on mobile, simply hide the button.
  A grey placeholder div preserves layout. Do NOT show a disabled/greyed button that staff cannot tap — removes confusion.
- If Q6-F resolved to Option B (Staff allowed): รับคืน button is shown and active for all roles.
- **The design is implemented for Option B (all three buttons visible). If PM chooses Option A,
  the frontend-developer adds a single role-check that hides รับคืน for Employee role.**

#### 3.5.4 Interaction states

| State | Visual |
|---|---|
| Loading (fetching linen items) | Spinner in center of view; "กำลังโหลดรายการผ้า..." |
| Loaded | Item cards rendered |
| Error | `alert alert-danger`: "โหลดรายการผ้าไม่สำเร็จ — ลองสแกนใหม่" + [สแกนใหม่] button |
| Empty | See §3.5.2 |

---

### 3.6 Staff — ส่งซัก (Laundry-Out) Flow [S-6.7, S-6.8, S-6.9]

This is a 3-step flow (photo → qty → confirm). Step indicator at top reuses the existing
`.step-item` pattern from Phase 1 staff-scan.

#### Step context bar (appears at top of all 3 steps)

```
┌──────────────────────────────────────────────────────┐
│  ส่งซัก: ผ้าปูที่นอน                                   │
│  ตู้ A-2  •  คงเหลือปัจจุบัน: 10 ผืน                  │
└──────────────────────────────────────────────────────┘
```

Styling: `.island-card` with teal-left-border variant. Background `--stock-accent-subtle`.

#### Step 1 — Photo screen [S-6.7]

Photo is **REQUIRED** for ส่งซัก. The Skip button is hidden.

The `PhotoCaptureModal` is invoked as:
```
PhotoCaptureModal.open({
  folder:   'thegood-stock/linen/{cabinet_code}/{item_sku}',
  prompt:   'ถ่ายรูปผ้าก่อนส่งซัก',
  required: true,           // hides Skip button
  onSuccess: (cloudinaryUrl) => { ... proceed to step 2 },
  onCancel:  () => { ... return to linen cabinet view }
})
```

Prompt microcopy (displayed inside the PhotoCaptureModal above the camera/file button):

```
┌──────────────────────────────────────────────────────┐
│        📷  ถ่ายรูปผ้าก่อนส่งซัก                      │
│            (บังคับ — เพื่อการตรวจสอบ)                │
│                                                      │
│   [เปิดกล้อง]    [เลือกจากคลัง]                      │
│                                                      │
│   [ยกเลิก ส่งซัก]                                    │
└──────────────────────────────────────────────────────┘
```

The "เปิดกล้อง" button is the primary CTA. "เลือกจากคลัง" is secondary (smaller, below).
"ยกเลิก" is a text link, not a button, to reduce accidental dismissal.
**Skip button is absent on this screen.**

After photo captured, thumbnail preview shown + "ถ่ายใหม่" and "ใช้รูปนี้" buttons.

#### Step 2 — Qty screen [S-6.8]

```
┌──────────────────────────────────────────────────────┐
│  ┌── ขั้นตอน ─────────────────────────────────────┐  │
│  │  [1 ✓ รูปถ่าย]  [2 ● จำนวน]  [3 ยืนยัน]        │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [🖼 thumbnail — ภาพที่ถ่าย]                          │
│                                                      │
│  จำนวนที่ส่งซัก *                                    │
│                                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │   [-]   [      8      ]   [+]                 │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  คงเหลือปัจจุบัน: 10 ผืน                             │
│  ⚠ ไม่สามารถส่งซักเกินจำนวนที่มี (สูงสุด 10 ผืน)    │ ← shown if input > current_qty
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │         ถัดไป →                              │   │
│  └──────────────────────────────────────────────┘   │
│  [← ย้อนกลับ]                                        │
└──────────────────────────────────────────────────────┘
```

Input behavior:
- Large numeric input, centered text (font-size: 2rem)
- `[-]` and `[+]` stepper buttons: width 44px, height 44px, touch-friendly
- Min value: 1. Max value: current_qty (client-side validation)
- If input exceeds max: warning inline below input (amber); "ถัดไป" button disabled
- "ถัดไป" disabled if qty is 0 or empty

#### Step 3 — Confirm screen [S-6.9]

```
┌──────────────────────────────────────────────────────┐
│  ┌── ขั้นตอน ─────────────────────────────────────┐  │
│  │  [1 ✓ รูปถ่าย]  [2 ✓ จำนวน]  [3 ● ยืนยัน]      │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  สรุปการส่งซัก                                        │
│  ─────────────────────────────────────────────────  │
│  รายการ:      ผ้าปูที่นอน                             │
│  ตู้:          A-2                                   │
│  จำนวนที่ส่ง: 8 ผืน                                  │
│  คงเหลือหลังส่ง: 2 ผืน                               │
│                                                      │
│  [🖼 ภาพที่ถ่าย — thumbnail 80×80]                   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │        ยืนยัน ส่งซัก                         │   │ ← primary btn, full width
│  └──────────────────────────────────────────────┘   │
│  [← แก้ไขจำนวน]                                      │
│                                                      │
│  ─── (during submit) ────────────────────────────── │
│  [spinner] กำลังบันทึก...                             │ ← overlays button area
└──────────────────────────────────────────────────────┘
```

"ยืนยัน ส่งซัก" button: `.btn-warning.text-dark` (orange). Full width. Height 52 px.
During submit: button disabled + spinner. No double-tap possible.

On success: toast at bottom of screen (3 seconds):
`"ส่งซักเรียบร้อย — qty ผ้าปูที่นอน ลดแล้ว 8 ผืน"`

On error (network / RLS): toast error:
`"บันทึกไม่สำเร็จ — กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ"`
Error toast persists until dismissed (no auto-dismiss on error).

After success: flow returns to linen cabinet view with the item row refreshed.

---

### 3.7 Staff — รับคืน (Laundry-In) Flow [S-6.10, S-6.11, S-6.12]

Structurally identical to ส่งซัก. Differences noted below.

#### Step 1 — Photo screen [S-6.10]

```
PhotoCaptureModal.open({
  folder:   'thegood-stock/linen/{cabinet_code}/{item_sku}',
  prompt:   'ถ่ายรูปผ้าที่รับคืน',
  required: true,
  onSuccess: ..., onCancel: ...
})
```

Prompt microcopy:
```
        📷  ถ่ายรูปผ้าที่รับคืนจากซักรีด
            (บังคับ — เพื่อการตรวจสอบ)
```

No Skip button.

#### Step 2 — Qty screen [S-6.11]

Label: "จำนวนที่รับคืน *"
Min: 1. No maximum (receiving from laundry can exceed previous send batch if admin reconciling).
No "ไม่สามารถรับคืนเกิน..." warning — qty ceiling does not apply for laundry-in.

#### Step 3 — Confirm screen [S-6.12]

"ยืนยัน รับคืน" button: `.btn-success` (green). Full width. Height 52 px.

Summary row: "จำนวนที่รับคืน: 8 ผืน" + "คงเหลือหลังรับ: 18 ผืน"

Success toast:
`"รับคืนเรียบร้อย — qty ผ้าปูที่นอน เพิ่มแล้ว 8 ผืน"`

#### RBAC rendering (Q6-F dependency — same as §3.5.3)

If Q6-F Option A (Admin-only): this flow is only reachable from admin.html, not from staff-scan.html.
If Q6-F Option B: flow available in staff-scan.html as designed here.

---

### 3.8 Staff — นับใหม่ (Count Snapshot) Flow [S-6.13, S-6.14, S-6.15]

Photo is **ADVISORY** (Skip button visible). Count does NOT update qty.

#### Step 1 — Photo screen [S-6.13]

```
PhotoCaptureModal.open({
  folder:   'thegood-stock/linen/{cabinet_code}/{item_sku}',
  prompt:   'ถ่ายรูปผ้าที่นับ',
  required: false,          // Skip button visible
  onSuccess: ...,
  onSkip:   () => { photoUrl = null; proceed to step 2 },
  onCancel:  () => { ... return to linen cabinet view }
})
```

Prompt microcopy:
```
        📷  ถ่ายรูปผ้าที่นับ (แนะนำ)

        การถ่ายรูปช่วยให้การตรวจสอบแม่นยำขึ้น

   [เปิดกล้อง]    [เลือกจากคลัง]

   [ข้ามขั้นตอนนี้]

   [ยกเลิก]
```

"ข้ามขั้นตอนนี้" is visible — plain text button, smaller weight than [เปิดกล้อง].
Advisory message: "การถ่ายรูปช่วยให้การตรวจสอบแม่นยำขึ้น" — not an error, not a warning.
Uses `.text-muted` or `.text-stock-accent` for gentle emphasis.

#### Step 2 — Count screen [S-6.14]

```
┌──────────────────────────────────────────────────────┐
│  ┌── ขั้นตอน ────────────────────────────────────┐  │
│  │  [1 ✓ รูปถ่าย] [2 ● จำนวนนับ] [3 ยืนยัน]      │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  จำนวนที่นับได้จริง *                                │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │   [-]   [      10     ]   [+]                │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  คงเหลือในระบบปัจจุบัน: 10 ผืน                       │
│                                                      │
│  ℹ  การบันทึกนี้คือ "ภาพถ่ายจำนวน" เท่านั้น          │
│     จะไม่เปลี่ยนยอดคงเหลือในระบบโดยอัตโนมัติ         │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │         ถัดไป →                              │   │
│  └──────────────────────────────────────────────┘   │
│  [← ย้อนกลับ]                                        │
└──────────────────────────────────────────────────────┘
```

The "count is snapshot only" notice is shown in a light info box (`.alert-info` style, small).
This is critical — staff must understand the count does not auto-correct the system qty.
Copy: "การบันทึกนี้คือ 'ภาพถ่ายจำนวน' เท่านั้น จะไม่เปลี่ยนยอดคงเหลือในระบบโดยอัตโนมัติ"

Min count: 0 (legitimate — all linens may be in laundry).

#### Step 3 — Confirm screen [S-6.15]

```
┌──────────────────────────────────────────────────────┐
│  สรุปการนับผ้า                                        │
│  ─────────────────────────────────────────────────  │
│  รายการ:        ผ้าห่ม                               │
│  ตู้:            A-2                                 │
│  จำนวนที่นับ:   5 ผืน                                │
│  คงเหลือในระบบ: 8 ผืน                                │
│                                                      │
│  ┌─── ข้อมูลความต่าง ────────────────────────────┐   │
│  │  ต่างจากระบบ: −3 ผืน                          │   │ ← shown if delta ≠ 0
│  │  [⚠ แตกต่างเกินเกณฑ์]                         │   │ ← badge if is_discrepancy=true
│  └─────────────────────────────────────────────────┘  │
│                                                      │
│  หากต้องการแก้ไขยอดคงเหลือ ให้ใช้ ส่งซัก หรือ รับคืน │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │        ยืนยัน บันทึกการนับ                   │   │ ← btn-stock-primary (teal)
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

The delta difference box only appears if `counted_qty !== current_qty`.
The reconciliation guidance line ("หากต้องการแก้ไข...") only appears if delta ≠ 0.

Success toast:
`"บันทึกการนับแล้ว — ผ้าห่ม จำนวน 5 ผืน"`

After success: linen cabinet view refreshes the row's "นับล่าสุด" column.

---

### 3.9 Dashboard — "นับผ้าวันนี้" Summary Panel [S-6.16]

This panel is **optional** (spec §8 Dashboard panel). Including it as part of the design;
PM may choose to defer to Phase 6.1.

The panel appears in the admin Dashboard tab alongside the existing Phase 1–5 panels.
It is a read-only summary: no actions inline — clicking navigates to Inventory + ผ้า filter.

#### 3.9.1 Panel wireframe @ 360 px

```
┌──────────────────────────────────────────────────────┐
│  🧺  นับผ้าวันนี้                                     │ ← panel header
│                                                      │
│  ผ้าที่มีความคลาดเคลื่อน     2 รายการ  [⬤ แดง]       │
│  ผ้าที่นับแล้ววันนี้          5 รายการ                │
│  ผ้าที่ยังไม่เคยนับ            3 รายการ                │
│                                                      │
│  [ดูรายละเอียด → ผ้า]                                │ ← navigates to Inventory + ผ้า filter
└──────────────────────────────────────────────────────┘
```

"ผ้าที่มีความคลาดเคลื่อน" badge: `badge bg-danger` if > 0; hidden if 0 (no "0 รายการ" display).
"ผ้าที่นับแล้ววันนี้" = count of distinct (location_id, item_id) combos with `linen_counts` row
where `counted_at::date = today`.
"ผ้าที่ยังไม่เคยนับ" = `v_linen_audit` rows where `counted_at IS NULL`.

Panel heading icon: Bootstrap Icons `bi-layers` (stacked fabric icon closest in BI set).
If no better icon available, use `bi-archive` or `bi-box`. Do not invent new icons.

---

## 4. Component Reuse Map

### 4.1 Phase 0–5 components reused without change

| Component | Where used in Phase 6 | Source |
|---|---|---|
| `.navbar.bg-modern-primary.navbar-dark` | All pages (unchanged) | `shared/styles.css` l.39 |
| `.nav.nav-pills .nav-link.stock-tab` | Inventory tab category filter pills | Phase 1 |
| `.btn-stock-primary` | "นับใหม่" button, "ยืนยัน บันทึกการนับ" CTA | `shared/styles.css` l.737 |
| `.btn-outline-stock-accent` | Secondary CTAs in linen list | `shared/styles.css` l.748 |
| `.island-card` | Item cards in linen cabinet view, step context bars | `shared/styles.css` l.405 |
| `.modal .modal-dialog .modal-content` (rounded-20px) | PhotoCaptureModal (already styled in Phase 3) | `shared/styles.css` l.507 |
| `.table.table-sm.align-middle` | Linen item list table (admin) | Bootstrap |
| `alert alert-warning` | Discrepancy banner | Bootstrap |
| `alert alert-danger` | Error states | Bootstrap |
| `.text-muted` | "ยังไม่เคยนับ" state, empty states | Bootstrap |
| `.step-item` / `.step-number` / `.step-label` | 3-step wizard header (ส่งซัก / รับคืน / นับใหม่) | `shared/styles.css` |
| `PhotoCaptureModal` | All 3 photo steps | `shared/photo-capture.js` (Phase 3) |
| `window.uploadToCloudinary` | Photo upload in all 3 flows | `shared/cloudinary.js` (Phase 0) |
| Toast notification pattern | Success / error toasts | Phase 1 JS pattern |

### 4.2 Components to BUILD NEW (Phase 6)

| Component | File | Notes |
|---|---|---|
| Linen workflow helpers | `shared/linen.js` | `fetchLinenByCabinet`, `submitLinenCount`, `submitLinenMovement` |
| "ผ้า" category filter pill | `js/inventory.js` (EDIT) | Add pill + data-category="LINEN" attribute |
| Linen item list (v_linen_audit) | `js/inventory.js` (EDIT) | New render path when category=LINEN active |
| Sub-category pills | `js/inventory.js` (EDIT) | Client-side filter, no new API call |
| Discrepancy banner | `js/inventory.js` (EDIT) | Conditional render |
| Linen cabinet view (after cabinet QR scan) | `js/staff-scan.js` (EDIT) | Intercept cabinet scan if LINEN items present |
| ส่งซัก / รับคืน / นับใหม่ step flows | `js/staff-scan.js` (EDIT) or `shared/linen.js` | 3-step wizard per workflow |
| Dashboard panel "นับผ้าวันนี้" | `js/dashboard.js` (EDIT) | Optional — replaces placeholder if slot available |
| LINEN sub-category field in receive form | `js/inventory.js` (EDIT) | Conditional field + reason pre-fill |

### 4.3 photo-capture.js reuse confirmation

**YES — `shared/photo-capture.js` is reused as-is.** No modification required.

The three Phase 6 photo steps map cleanly to the existing `PhotoCaptureModal.open(config)` contract:
- ส่งซัก: `required: true` (no Skip)
- รับคืน: `required: true` (no Skip)
- นับใหม่: `required: false` (Skip visible, `onSkip` callback sets `photoUrl = null`)

The `folder` parameter uses the linen-specific Cloudinary path:
`thegood-stock/linen/{cabinet_code}/{item_sku}`

No new props are needed on the `PhotoCaptureModal` component. The existing `required: true/false`
prop already controls Skip button visibility (per Phase 3 design §7.2 component contract).

---

## 5. Interaction State Diagrams

### 5.1 Admin Inventory Tab — Linen Category Filter State Machine

```
[Inventory tab opens]
        │
        ▼
[category filter = "ทั้งหมด" (default)]
        │
        │ User taps "ผ้า" pill
        ▼
[category = LINEN active]
        │
        ├── [loading] → spinner on table body
        │
        ├── [loaded, no items] → empty state: "ยังไม่มีสินค้าหมวดผ้า"
        │
        ├── [loaded, items, no discrepancy] → linen table, no banner
        │
        ├── [loaded, items, discrepancy > 0] → amber banner + linen table with red badges
        │
        └── [error] → alert-danger + retry button

From linen table:
        │ User taps sub-category pill
        ▼
[client-side filter applied, no new API call]
        │
        └── [no results for this subcategory] → empty state: "ไม่พบผ้าหมวด [X]"
```

### 5.2 Staff Linen Cabinet View — 3-Workflow State Machine

```
[Staff scans cabinet QR]
        │
        ▼
[JS checks: does cabinet have LINEN items?]
        │
        ├── NO → fall through to standard Phase 1 staff scan (unchanged)
        │
        └── YES
                │
                ▼
        [Linen cabinet view rendered] [S-6.6]
                │
                ├── [ส่งซัก tapped] → ส่งซัก flow [S-6.7 → S-6.8 → S-6.9]
                │         └── success → return to linen cabinet view (row refreshed)
                │         └── cancel/error → return to linen cabinet view (no change)
                │
                ├── [รับคืน tapped] → รับคืน flow [S-6.10 → S-6.11 → S-6.12]
                │         └── success → return to linen cabinet view (row refreshed)
                │         └── cancel/error → return to linen cabinet view (no change)
                │
                └── [นับใหม่ tapped] → นับใหม่ flow [S-6.13 → S-6.14 → S-6.15]
                          └── success → return to linen cabinet view (counted_at refreshed)
                          └── cancel/error → return to linen cabinet view (no change)
```

### 5.3 ส่งซัก Step-by-Step Flow (same structure for รับคืน and นับใหม่)

```
[Step 1: Photo]
  required=true (ส่งซัก/รับคืน) or required=false (นับใหม่)
        │
        ├── [camera opens] → staff captures photo
        │         ├── [thumbnail preview shown]
        │         │     ├── [ใช้รูปนี้] → photoUrl = Cloudinary URL → Step 2
        │         │     └── [ถ่ายใหม่] → re-open camera
        │         └── [upload error] → toast error, retry option
        │
        ├── (นับใหม่ only) [ข้ามขั้นตอนนี้] → photoUrl = null → Step 2
        │
        └── [ยกเลิก] → back to linen cabinet view

[Step 2: Qty / Count]
  ← ย้อนกลับ possible (goes back to Step 1, photo re-takeable)
        │
        ├── [qty/count entered + valid] → ถัดไป enabled
        ├── [qty/count invalid] → ถัดไป disabled + inline error
        └── [ถัดไป tapped] → Step 3

[Step 3: Confirm]
  ← แก้ไขจำนวน goes back to Step 2
        │
        ├── [ยืนยัน tapped]
        │     ├── [loading state] — button disabled, spinner
        │     ├── [success] → toast + return to linen cabinet view (refreshed)
        │     └── [error] → persistent error toast, ยืนยัน re-enabled for retry
        └── (implicitly: no cancel from confirm screen — use ← แก้ไขจำนวน to back out)
```

---

## 6. Microcopy Table (All Thai Strings)

### 6.1 Navigation / category filter

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-L01 | `ผ้า` | "Linens" | Category filter pill in Inventory tab |
| M-L02 | `ผ้าและสิ่งทอ` | "Linens and textiles" | Category full name (from DB) |

### 6.2 Sub-category pills

| ID | Thai copy | English gloss | Enum value |
|---|---|---|---|
| M-L10 | `ทั้งหมด` | "All" | (no filter) |
| M-L11 | `ผ้าปูที่นอน` | "Bed sheet" | `sheet` |
| M-L12 | `ผ้าห่ม` | "Blanket" | `blanket` |
| M-L13 | `ผ้าขนหนู` | "Towel" | `towel` |
| M-L14 | `เสื้อกาวน์` | "Gown" | `gown` |
| M-L15 | `ผ้าเช็ดเครื่องมือ` | "Instrument wipe" | `wipe` |

### 6.3 Linen item list table headers

| ID | Thai copy | English gloss | Column |
|---|---|---|---|
| M-L20 | `ชื่อผ้า` | "Item name" | `stock_items.name` |
| M-L21 | `หมวดย่อย` | "Subcategory" | `linen_subcategory` |
| M-L22 | `ตู้` | "Cabinet" | `location_name` |
| M-L23 | `คงเหลือ` | "Qty in stock" | `current_qty` |
| M-L24 | `นับล่าสุด` | "Last counted" | `counted_at` |
| M-L25 | `จำนวนนับ` | "Counted qty" | `counted_qty` |
| M-L26 | `ต่างจากระบบ` | "Delta from system" | `delta` |

### 6.4 Discrepancy banner

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-L30 | `ผ้าที่มีความคลาดเคลื่อน: {N} รายการ` | "{N} discrepant items" | Amber banner |
| M-L31 | `คลาดเคลื่อนเกินเกณฑ์ (>5% หรือ >2 ผืน)` | "Exceeds threshold (>5% or >2 pcs)" | Banner sub-line |

### 6.5 Linen cabinet view (staff)

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-L40 | `ตู้ {name} — รายการผ้า` | "Cabinet {name} — Linen items" | Page header |
| M-L41 | `คงเหลือ: {N} {unit}` | "Remaining: {N} {unit}" | Item row |
| M-L42 | `นับล่าสุด: {date}` | "Last counted: {date}" | Item row |
| M-L43 | `ยังไม่เคยนับ` | "Never counted" | Item row, no count data |
| M-L44 | `ส่งซัก` | "Send to laundry" | Action button |
| M-L45 | `รับคืน` | "Receive from laundry" | Action button |
| M-L46 | `นับใหม่` | "New count" | Action button |
| M-L47 | `ตู้นี้ยังไม่มีรายการผ้า — ติดต่อผู้ดูแลระบบเพื่อเพิ่มสินค้า` | "No linen items in this cabinet — contact admin to add items" | Empty state |
| M-L48 | `กำลังโหลดรายการผ้า...` | "Loading linen items..." | Loading state |
| M-L49 | `โหลดรายการผ้าไม่สำเร็จ — ลองสแกนใหม่` | "Failed to load linen items — try scanning again" | Error state |

### 6.6 ส่งซัก flow

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-L50 | `ส่งซัก: {item_name}` | "Send to laundry: {item_name}" | Context bar title |
| M-L51 | `ถ่ายรูปผ้าก่อนส่งซัก` | "Photograph linens before sending to laundry" | Photo prompt |
| M-L52 | `(บังคับ — เพื่อการตรวจสอบ)` | "(Required — for audit)" | Photo sub-prompt |
| M-L53 | `จำนวนที่ส่งซัก *` | "Qty to send *" | Qty input label |
| M-L54 | `ไม่สามารถส่งซักเกินจำนวนที่มี (สูงสุด {N} ผืน)` | "Cannot send more than available (max {N} pcs)" | Qty over-limit warning |
| M-L55 | `สรุปการส่งซัก` | "Send-to-laundry summary" | Confirm screen header |
| M-L56 | `จำนวนที่ส่ง: {N} {unit}` | "Qty to send: {N}" | Confirm row |
| M-L57 | `คงเหลือหลังส่ง: {N} {unit}` | "Remaining after send: {N}" | Confirm row |
| M-L58 | `ยืนยัน ส่งซัก` | "Confirm send to laundry" | Primary CTA |
| M-L59 | `ส่งซักเรียบร้อย — qty {item} ลดแล้ว {N} {unit}` | "Sent to laundry — {item} reduced by {N}" | Success toast |
| M-L60 | `ยกเลิก ส่งซัก` | "Cancel send to laundry" | Cancel link |

### 6.7 รับคืน flow

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-L70 | `รับคืน: {item_name}` | "Receive from laundry: {item_name}" | Context bar title |
| M-L71 | `ถ่ายรูปผ้าที่รับคืนจากซักรีด` | "Photograph linens received from laundry" | Photo prompt |
| M-L72 | `จำนวนที่รับคืน *` | "Qty to receive *" | Qty input label |
| M-L73 | `สรุปการรับคืน` | "Receive-from-laundry summary" | Confirm screen header |
| M-L74 | `จำนวนที่รับคืน: {N} {unit}` | "Qty received: {N}" | Confirm row |
| M-L75 | `คงเหลือหลังรับ: {N} {unit}` | "Remaining after receive: {N}" | Confirm row |
| M-L76 | `ยืนยัน รับคืน` | "Confirm receive" | Primary CTA |
| M-L77 | `รับคืนเรียบร้อย — qty {item} เพิ่มแล้ว {N} {unit}` | "Received — {item} increased by {N}" | Success toast |
| M-L78 | `ยกเลิก รับคืน` | "Cancel receive" | Cancel link |

### 6.8 นับใหม่ flow

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-L80 | `นับใหม่: {item_name}` | "Count: {item_name}" | Context bar title |
| M-L81 | `ถ่ายรูปผ้าที่นับ (แนะนำ)` | "Photograph linens being counted (advisory)" | Photo prompt |
| M-L82 | `การถ่ายรูปช่วยให้การตรวจสอบแม่นยำขึ้น` | "Photos improve audit accuracy" | Advisory sub-text |
| M-L83 | `ข้ามขั้นตอนนี้` | "Skip this step" | Skip button |
| M-L84 | `จำนวนที่นับได้จริง *` | "Actual counted qty *" | Count input label |
| M-L85 | `การบันทึกนี้คือ "ภาพถ่ายจำนวน" เท่านั้น จะไม่เปลี่ยนยอดคงเหลือในระบบโดยอัตโนมัติ` | `"This records a count snapshot only. It does not automatically change the system qty."` | Info notice on count screen |
| M-L86 | `สรุปการนับผ้า` | "Count summary" | Confirm screen header |
| M-L87 | `จำนวนที่นับ: {N} {unit}` | "Counted: {N}" | Confirm row |
| M-L88 | `คงเหลือในระบบ: {N} {unit}` | "System qty: {N}" | Confirm row |
| M-L89 | `ต่างจากระบบ: {delta} {unit}` | "Delta from system: {delta}" | Confirm row (shown if delta ≠ 0) |
| M-L90 | `แตกต่างเกินเกณฑ์` | "Exceeds threshold" | Badge on confirm screen (if is_discrepancy) |
| M-L91 | `หากต้องการแก้ไขยอดคงเหลือ ให้ใช้ ส่งซัก หรือ รับคืน` | "To correct the qty, use Send-to-laundry or Receive" | Guidance text (if delta ≠ 0) |
| M-L92 | `ยืนยัน บันทึกการนับ` | "Confirm — save count" | Primary CTA |
| M-L93 | `บันทึกการนับแล้ว — {item} จำนวน {N} {unit}` | "Count saved — {item} qty {N}" | Success toast |
| M-L94 | `ยกเลิก` | "Cancel" | Cancel link |

### 6.9 Shared error states

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-L99 | `บันทึกไม่สำเร็จ — กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ` | "Save failed — please retry or contact admin" | Error toast (all flows) |
| M-L98 | `โหลดข้อมูลผ้าไม่สำเร็จ — กรุณาลองใหม่` | "Failed to load linen data — please retry" | Error state (admin list) |

---

## 7. Accessibility Notes

### 7.1 Tap targets

| Element | Minimum size | Implementation |
|---|---|---|
| ส่งซัก / รับคืน / นับใหม่ buttons (linen cabinet view) | 44 px height | `min-height: 44px` on `.btn-sm` in linen context |
| `[-]` and `[+]` stepper buttons | 44 × 44 px | `width: 44px; height: 44px` + `touch-action: manipulation` |
| "ยืนยัน" CTA buttons | 52 px height | `padding: 0.75rem 1rem` on full-width btn |
| Sub-category pills | 40 px height minimum (advisory; 36 px acceptable for admin desktop) | `padding: 0.4rem 0.75rem` |
| "ข้ามขั้นตอนนี้" skip link | 44 px touch area | Padding extends touch area; visible text can be smaller |

### 7.2 Color contrast (WCAG AA)

| Element | Foreground | Background | Ratio check |
|---|---|---|---|
| `.btn-stock-primary` text | #ffffff | `--stock-accent` (#0d9488) | 3.3:1 — fails AA for normal text; passes AA for large/bold text (≥18px or 14px bold). Thai text at 16px bold. Verify against WCAG 1.4.3. |
| Red discrepancy badge | #ffffff | Bootstrap `bg-danger` (#dc3545) | 4.5:1 — passes |
| Amber badge `.bg-warning.text-dark` | #212529 | #ffc107 | 5.7:1 — passes |
| Green badge `.bg-success` text | #ffffff | #198754 | 4.5:1 — passes |
| "ต่างจากระบบ" table column text | delta value in badge — covered above | — | — |

**Note on btn-stock-primary contrast:** The teal (#0d9488) with white text at 16px bold
is borderline. Verify with a live contrast checker. If the implementation fails AA at the
chosen font weight, darken to `--stock-accent-dark` (#0f766e) for the button background.

### 7.3 Non-color information carriers

All status indicators use BOTH color AND text/symbol:
- Discrepancy badges show the numeric delta (–3, +3, 0) in addition to color
- "แตกต่างเกินเกณฑ์" text label on red badge
- "ปกติ" text label on green badge (on admin list, optional — space-permitting)

### 7.4 ARIA and keyboard order

**Admin linen list (role="tablist" pattern from Phase 2):**
1. Category filter pills: `role="radiogroup"` / each pill `role="radio"` or use `role="tab"` / `aria-selected` pattern
2. Sub-category pills: same pattern within `role="group" aria-label="ประเภทย่อยผ้า"`
3. Discrepancy banner: `role="alert"` so screen reader announces it when it appears
4. Table: `role="table"` with `<th scope="col">` on all headers
5. "ดูประวัติการนับ →" link: descriptive text already sufficient

**Staff linen cabinet view:**
1. Page heading: `<h2>ตู้ A-2 — รายการผ้า</h2>`
2. Each item card: `role="group" aria-label="ผ้าปูที่นอน"`
3. Action buttons: `aria-label="ส่งซัก ผ้าปูที่นอน"` / `aria-label="รับคืน ผ้าปูที่นอน"` / `aria-label="นับใหม่ ผ้าปูที่นอน"` (include item name for screen-reader users who cannot see the card context)

**3-step wizard:**
1. Step indicator: `role="list"` + `aria-current="step"` on current step
2. "ถัดไป" button: `aria-disabled="true"` when disabled (not HTML `disabled` alone — also set `tabindex="-1"`)
3. Count input: `aria-label="จำนวนที่นับได้จริง"` + `aria-describedby` pointing to the "snapshot only" notice

### 7.5 Focus management

- When a flow step transitions (e.g., Step 1 → Step 2), focus moves to the step header or the first interactive element of Step 2
- On modal/overlay open (PhotoCaptureModal): focus trapped inside modal
- On modal close: focus returns to the button that opened it (item-specific action button)

### 7.6 Screen reader labels for discrepancy badges

The numeric delta badge `–3` alone is insufficient. Use `aria-label="คลาดเคลื่อน ลบ 3 ผืน"` on the badge element. "0" badge: `aria-label="ปกติ จำนวนตรงกัน"`.

---

## 8. Open UX Questions for PM (Design-Blocking)

The following questions are either design-blocking or create significantly different
frontend implementations depending on the PM decision. PM sign-off required before
implementation begins.

### Q6-F — Staff RBAC for รับคืน (adjustment_gain)

**UX impact: HIGH — changes button visibility in staff UI**

If **Option A (Admin-only)**: The "รับคืน" button is hidden from Employee-role staff
in the linen cabinet view. Staff cannot reach S-6.10–S-6.12. A visible-but-disabled button
would create confusion ("why can't I?") — so hidden is preferred. Admin must confirm returns.
This creates an operational bottleneck during night shifts when no admin is present.

If **Option B (Staff allowed)**: All three buttons (ส่งซัก / รับคืน / นับใหม่) are visible
and active for Employee role. Requires a new migration to update `sm_insert_staff` policy.

**Designer recommendation: Option B.** Night-shift staff receiving laundered linens is a
legitimate and frequent operation. Blocking it via Admin-only creates an audit gap (linens
arrive but aren't recorded until next admin login). The photo-required constraint for
รับคืน provides sufficient audit trail.

**PM must confirm before frontend-developer implements the รับคืน button visibility logic.**

### Q6-B — Photo requirement for periodic count (นับใหม่)

**UX impact: MEDIUM — changes Step 1 screen presentation**

If photo becomes **required** for นับใหม่: "ข้ามขั้นตอนนี้" button is removed. Consistent
with ส่งซัก / รับคืน. Higher friction for routine daily counts (staff may be counting
dozens of items per shift).

If **advisory** (as designed here): Skip button visible. Lower friction. Photo URLs will
be null for many count records, reducing audit coverage.

**Designer recommendation: Advisory (as designed).** Routine counts happen multiple times daily.
Required photo on every count creates significant friction and may discourage compliance. Reserve
required photo for the laundry transitions where a physical handoff (and therefore discrepancy risk)
occurs.

**PM may override to Required if full photo coverage is an organizational requirement.**

### Q6-B-photo-scope — Photo must show full cabinet or per-item stack?

**UX impact: LOW — affects only the photo prompt copy and the Cloudinary folder structure**

Current design: one photo per item per workflow action (e.g., ส่งซัก on ผ้าปูที่นอน = one photo).
If the organisation requires a photo showing the full cabinet contents (all items visible):
the folder structure and `PhotoCaptureModal` folder param remain the same, but the prompt
copy changes to "ถ่ายรูปทั้งตู้ก่อนส่งซัก" and there should be only one photo step per
cabinet (not per item).

Current design is per-item. If PM wants per-cabinet, the workflow must be redesigned to
aggregate all items in one cabinet into a single cabinet-level form (not per-item). This is
a structural change to the ส่งซัก / รับคืน flow.

**Designer recommendation: Per-item photo (as designed).** Simpler flow; more granular audit trail.
If per-cabinet photo is required, flag to frontend-developer as a structural redesign.

### Q6-D — Sub-category seed list confirmation

**UX impact: LOW — affects only sub-category pill labels**

The five sub-categories (sheet / blanket / towel / gown / wipe) are the enum values from
spec §5.1. The UX is designed around these five. If clinical staff use different names or
need additional sub-categories, the enum and the pill labels must be updated before migration.

**PM must confirm the five sub-categories with clinical staff before the DDL migration runs.**
Adding a sub-category post-migration requires an ALTER TYPE migration.

### Q6-A — Count audit cadence (UX display only)

**UX impact: VERY LOW — affects only dashboard panel timestamp label**

The "นับผ้าวันนี้" dashboard panel shows "นับแล้ววันนี้" as the count metric.
If the cron runs per-shift instead of daily, this label should change to "นับในกะนี้".
This is a copy-only change; no structural design impact.

**Designer recommendation: Accept daily cadence (M-L30 labels as designed).**

### Q6-E — ส่งซัก / รับคืน pairing (laundry batch tracking)

**UX impact: MEDIUM if Phase 6 base — would require new UI for batch status**

Current design: no pairing. Each movement is independent. No "open laundry batch" concept.
If PM adds Phase 6 base scope for pairing (Q6-E Option B), a "รายการซักรีดที่ค้างอยู่"
view would be needed in admin (analogous to loans in Phase 3). This is not in the current design.

**Designer recommendation: Independent movements for Phase 6 base (as designed). Defer pairing to Phase 6.1.**

---

## 9. New CSS Tokens Proposed

Phase 6 uses only existing tokens from `shared/styles.css`. No new tokens are required.

The discrepancy badges reuse Bootstrap utilities (`.bg-danger`, `.bg-warning.text-dark`, `.bg-success`).
The linen cabinet item cards reuse `.island-card`.
The action buttons reuse `.btn-warning` (orange for ส่งซัก), `.btn-success` (green for รับคืน),
`.btn-stock-primary` (teal for นับใหม่).

**One micro-token proposed (optional):**

```css
/* Linen-specific: left-border accent on item cards in linen cabinet view */
.linen-item-card {
  border-left: 3px solid var(--stock-accent);
  border-radius: 12px;
}
.linen-item-card.has-discrepancy {
  border-left-color: #dc3545; /* Bootstrap danger */
}
```

This is a local CSS utility, not a `shared/styles.css` root token. Add to a `<style>` block
in `staff-scan.html` or a `linen.css` local file. **Do NOT add to `shared/styles.css` unless
the PM confirms this pattern will be reused in other phases.**

---

## 10. Hand-off Note to frontend-developer

**Next agent:** `frontend-developer`

### What to implement first (dependency order)

1. **`shared/linen.js`** — New file. Implement helpers:
   - `fetchLinenByCabinet(locationId)` → queries `v_linen_audit` filtered by `location_id`
   - `submitLinenMovement(params)` → POST to `stock_movements` with `reason=laundry_out/laundry_in`
   - `submitLinenCount(params)` → POST to `linen_counts`
   - No dependencies on UI; can be built and unit-tested first.

2. **`js/inventory.js` — "ผ้า" category filter extension**
   - Add "ผ้า" pill (M-L01) to the existing category filter row (after "CONSUME")
   - When active + "สินค้า" segment active: fetch from `v_linen_audit` + render linen table
   - Sub-category pills (M-L10 to M-L15) with client-side filter
   - Discrepancy banner (conditional)
   - Receive form: LINEN item detection + reason pre-fill (§3.4)

3. **`js/staff-scan.js` — Cabinet QR linen intercept**
   - After cabinet QR scan resolves: call `fetchLinenByCabinet(locationId)` from `shared/linen.js`
   - If result.length > 0: render linen cabinet view [S-6.6]
   - If result.length === 0: fall through to existing Phase 1 staff scan flow (do NOT break existing flow)
   - Wire up ส่งซัก / รับคืน / นับใหม่ buttons to their respective step flows

4. **3-step workflow steps** (ส่งซัก / รับคืน / นับใหม่):
   - All three share the same 3-step skeleton (Photo → Qty/Count → Confirm)
   - The only differences are: photo `required` prop, input label, max-value constraint, confirm CTA label, success toast copy, and the `submitLinenMovement` vs `submitLinenCount` call
   - Recommended implementation: a shared `LinenWorkflowWizard` class in `shared/linen.js` with a config object, rather than three separate copy-pasted implementations.
   - `PhotoCaptureModal.open()` is called with the existing contract — no changes to `shared/photo-capture.js`

5. **`js/dashboard.js` — "นับผ้าวันนี้" panel** (optional — implement last if PM confirms):
   - Query `v_linen_audit` for discrepancy count + `linen_counts` for today's counts
   - Panel tap → `AppInventoryTab.switchTo({ category: 'LINEN' })` or equivalent navigation function

### Questions the frontend-developer should NOT have to ask

These are resolved in this document:
- Photo-capture.js is reused as-is: YES (§4.3)
- Skip button on นับใหม่ is visible: YES (§3.8)
- Skip button on ส่งซัก / รับคืน is hidden: YES (§3.6, §3.7)
- Count snapshot does NOT update qty: YES — the info notice in Step 2 copy explains this (M-L85)
- Max qty on ส่งซัก: `current_qty` from cabinet (§3.6 step 2)
- Max qty on รับคืน: no ceiling (§3.7 step 2)
- Min qty on all flows: 1 for ส่งซัก / รับคืน; 0 for นับใหม่ (§3.8)
- Cloudinary folder path: `thegood-stock/linen/{cabinet_code}/{item_sku}` (§3.6)
- v_linen_audit is the data source for the admin linen list: YES (§3.2)
- Sub-category pills are client-side filter only (no new API): YES (§3.2.2)
- รับคืน button visibility: implement for Option B (all roles see it); add a role-check function call that can be switched to Option A by changing one condition (§3.5.3)
- No new admin tab: the "ผ้า" category pill is inside the existing Inventory tab segmented row (§2.1 architectural principle)
- No new HTML page: all staff linen flows live inside `staff-scan.html` (§2.2)

### Existing components to REUSE (do not rebuild)

- `shared/photo-capture.js` — `PhotoCaptureModal.open(config)` (Phase 3)
- `shared/cloudinary.js` — `window.uploadToCloudinary()` (Phase 0)
- `.step-item` / `.step-number` / `.step-label` step wizard styles (existing CSS)
- `.island-card` for item cards
- Bootstrap `.alert-warning`, `.alert-danger`, `.badge.bg-danger/success/warning` for status indicators
- Existing toast pattern from Phase 1/3

### New files to create

- `shared/linen.js` (NEW)
- Optional: `linen.css` (if linen-item-card left-border token needed, see §9)

### Files to edit

- `js/inventory.js` — "ผ้า" pill + linen list + subcategory pills + receive form extension
- `js/staff-scan.js` — cabinet scan intercept + linen cabinet view + 3 workflow flows
- `js/dashboard.js` — "นับผ้าวันนี้" panel (optional)
- `admin.html` — no change needed (inventory tab already exists; no new tab)
- `staff-scan.html` — no structural change needed (linen view renders inside existing page)

---

*DRAFT — pending PM resolution of Q6-F (RBAC), Q6-B (photo requirement on count), Q6-D (sub-category seed confirmation), and Q6-A (cron cadence) before implementation begins.*

*Hand-off note: next agent is `frontend-developer`. All resolved questions and component contracts are documented in this file. The `superpowers:writing-plans` agent should also read this file after PM approval to produce the Phase 6 plan.*
