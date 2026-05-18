# DRAFT — Phase 2 UI/UX Design: Medication Lots + Expiry Tracking + 30/60/90-Day Alerts

**Project:** Thegood Stock Management System
**Phase:** 2 (Medication Lots + Expiry Tracking + 30/60/90-day Alerts)
**Date:** 2026-05-18
**Author:** UI/UX Designer (autonomous draft)
**Status:** DRAFT — pending PM review + Phase 2 spec Q-Phase2-1 through Q-Phase2-4 resolution
**Source spec:** `docs/superpowers/specs/2026-05-18-phase2-medication-design.md`
**Phase 1 design reference:** `docs/superpowers/designs/2026-05-18-phase1-ui-design.md`
**Next agent:** `frontend-developer`

---

## Table of Contents

- §1 Purpose, user stories, and assumed user context
- §2 Information architecture (screen list + ASCII diagram)
- §3 Screen-by-screen mockups and interaction states
  - §3.1 Admin — "ล็อตยา" sub-view (new fourth segment in Inventory tab)
  - §3.2 Admin — Receive modal extension for `tracks_lots=true` items
  - §3.3 Admin — Item edit form: `tracks_lots` toggle
  - §3.4 Staff scan — lot-picker step (new step 2.5)
  - §3.5 Dashboard — Expiry timeline panel (replaces Phase 1 placeholder)
  - §3.6 Recall confirm modal
  - §3.7 Admin override: force-issue expired lot (admin safety escape)
- §4 Component reuse map
- §5 Interaction state diagrams
  - §5.1 Admin Inventory tab — four-segment state machine
  - §5.2 Staff scan — extended 5-step state machine
  - §5.3 Recall action flow
- §6 Microcopy table (all Thai strings + English gloss)
- §7 Accessibility notes
- §8 New CSS tokens proposed
- §9 Telegram alert message format
- §10 Open UX questions for PM

---

## 1. Purpose, User Stories, and Assumed User Context

### 1.1 Why this design exists

Phase 1 gives Thegood a general inventory system. Phase 2 adds the
patient-safety layer: every medication received must carry a lot number and an
expiry date, every issue must draw from an identified lot, and expiring
medications must be surfaced proactively before they reach a patient.

The primary safety goal is **preventing an expired medication from being
administered.** The secondary goal is **catching near-expiry lots early enough
to use or return them.** The tertiary goal is **supporting recall quarantine**
when a lot is flagged as defective.

### 1.2 User stories

**US-1 — Pharmacist / stock admin receiving a medication order**
"When I receive a box of amoxicillin I need to record which lot number and
expiry date it belongs to, so that the system knows when to alert us and which
bottles to use first."
Acceptance: The Receive form for `tracks_lots=true` items shows mandatory lot
fields. Saving creates a `stock_lots` row and a `stock_movements` row with
`lot_id` set.

**US-2 — Nurse / paramedic issuing medication from the stock room**
"When I scan a medication from the shelf the system should automatically pick
the one expiring soonest (FEFO). If something is expired I want the system to
stop me before I take it."
Acceptance: The scan flow for `tracks_lots=true` items presents a lot picker
between the location scan and the qty entry. Expired and recalled lots are
grayed out and blocked. The FEFO default is pre-selected.

**US-3 — Admin doing a quarterly expiry audit**
"I need a list of all medication lots sorted by expiry date so I can see what
is coming up, mark things that have been recalled by the manufacturer, and
verify that the system auto-expired anything past today."
Acceptance: The "ล็อตยา" sub-view in the Inventory tab shows all lots with
color-coded expiry bands, a filter bar for window / status / item, and a recall
action on each active/expired lot row.

**US-4 — Admin receiving a Telegram alert about expiring stock**
"I get a Telegram message each morning listing any medication lots expiring in
the next 30, 60, or 90 days so I can order replacements or plan usage."
Acceptance: The daily cron fires three per-bucket Telegram messages in Thai
with lot details.

**US-5 — Admin investigating a manufacturer recall**
"A supplier calls to say lot LOT-2026-A is recalled. I need to mark it so
nobody issues from it, and I need a record of when I did it and why."
Acceptance: Recall action on lot row opens a confirm modal with a reason text
field. After confirm, `status='recalled'`, and the lot is blocked from all
issue flows.

### 1.3 Assumed user context (explicit)

| Assumption | Impact on design |
|---|---|
| Admin user is typically **on desktop or tablet** at a desk when managing lots and recalls. Mobile is secondary for admin tasks. | Admin lot list can use a wider table layout. Modals are not forced full-screen on desktop. |
| Staff user (scan-issue) is **on a phone, one-handed**, often in a storeroom corridor or near a patient. | The lot picker must be large-tap-target, fast to dismiss, and never require two hands. |
| Staff may use the app in **poor or inconsistent lighting** (storeroom, ambulance at night). | High contrast colors critical. The lot expiry badge must not rely on subtle color alone (add text label). |
| **FEFO is clinical default.** The staff user trusts the system to pre-select the right lot; the override must be visible but not the obvious path. | FEFO selection is visually prominent; other lots require a deliberate tap to reveal / select. |
| The app is **online-only** in Phase 2. The lot picker requires a network call. | A loading state is mandatory for the lot picker step. No offline lot selection. |
| All users read Thai fluently. English appears only in parens for SKU / technical terms that developers need to keep stable in the DOM. | All copy Thai first; technical identifiers (SKU, Barcode, QR) kept as-is per Phase 0 convention. |
| A recalled or expired medication being issued is a **patient safety incident.** The design must treat blocking expired/recalled lots as a hard requirement, not a soft UX hint. | Expired/recalled lots are not just visually different; they are unselectable. An admin override requires 2-tap confirmation. |

---

## 2. Information Architecture

### 2.1 Screen list

| Screen ID | Surface | Screen name | Phase 2 status |
|---|---|---|---|
| S-2.1 | `admin.html` Inventory tab | "ล็อตยา" sub-view (lot list + filters) | NEW |
| S-2.2 | `admin.html` Inventory tab | Receive modal — lot fields extension | EXTENSION of Phase 1 |
| S-2.3 | `admin.html` Inventory tab | Item edit form — `tracks_lots` toggle | EXTENSION of Phase 1 |
| S-2.4 | `admin.html` Inventory tab | Recall confirm modal | NEW |
| S-2.5 | `admin.html` Inventory tab | Force-issue override (admin 2-tap) | NEW |
| S-2.6 | `staff-scan.html` | Lot picker step (step 2.5 in scan flow) | NEW STEP in Phase 1 flow |
| S-2.7 | `admin.html` Dashboard tab | Expiry timeline panel | REPLACES Phase 1 placeholder |

### 2.2 Architecture diagram (ASCII)

```
admin.html
└── nav-pills (Phase 0/1 unchanged: Dashboard | Locations | Inventory* | Ambulances | Settings | Sessions)
    │
    ├── #tab-dashboard (js/dashboard.js — EXTENDED Phase 2)
    │     └── Panel 3: Expiry timeline [S-2.7] ← replaces "เปิดใช้งานใน Phase 2" placeholder
    │           4 rows: เกินกำหนด / ใน 30 วัน / 30-60 วัน / 60-90 วัน
    │           click row → opens Inventory tab → ล็อตยา sub-view (pre-filtered)
    │
    └── #tab-inventory (js/inventory.js + js/inventory-lots.js — EXTENDED Phase 2)
          │
          ├── Toolbar row (unchanged, always visible)
          │     ├── Segmented (NOW 4 segments):
          │     │     รายการสินค้า | รับเข้า | ล็อตยา* | ค้นของ
          │     └── [+ เพิ่มสินค้า]  [📷 สแกนรับเข้า]
          │
          ├── Sub-view A: รายการสินค้า (Phase 1 — unchanged)
          │     └── Item row click → Item Detail Drawer [แก้ไข] → Item edit form [S-2.3]
          │                                                          (now includes tracks_lots toggle)
          │
          ├── Sub-view B: รับเข้า / ปรับสต๊อก (Phase 1 — EXTENDED)
          │     └── When selected item has tracks_lots=true:
          │           ↳ Lot fields section slides in [S-2.2]
          │                 lot_number | expiry_date | supplier | note
          │                 "ล็อตเดิม" option (top-up existing lot)
          │
          ├── Sub-view C: ล็อตยา [S-2.1] ← NEW
          │     ├── Filter bar: expiry window | status | item search
          │     ├── Lot list table:
          │     │     ชื่อยา | lot_number | วันหมดอายุ (color-coded) | คงเหลือ | สถานะ badge | จัดการ
          │     └── Row action: [เรียกคืน] → Recall confirm modal [S-2.4]
          │                     [ดูรายละเอียด] → lot detail panel (inline expand)
          │
          └── Sub-view D: ค้นของ (Phase 1 — unchanged)


staff-scan.html (js/staff-scan.js — EXTENDED Phase 2)
└── 5-step scan state machine (tracks_lots items only — non-tracks_lots items skip step 2.5):
      Step 1: สแกนสินค้า   (unchanged)
      Step 2: สแกน QR ตู้/ชั้น  (unchanged)
      Step 2.5: เลือกล็อต  [S-2.6] ← NEW (only for tracks_lots items + issue/adjustment_loss)
      Step 3: ระบุจำนวน + บันทึก  (unchanged)
      Success/Error states  (unchanged)
```

---

## 3. Screen-by-Screen Mockups and Interaction States

### 3.1 Admin — "ล็อตยา" Sub-View [S-2.1]

#### Context

Fourth segment in the Inventory tab segmented control. Rendered by
`js/inventory-lots.js`. Source: SELECT from `stock_lots JOIN stock_items`
where `stock_items.tracks_lots=true`, ordered `expiry_date ASC`.

#### 3.1.1 Wireframe @ 360 px (mobile)

```
┌─────────────────────────────────────────────┐
│ navbar                                       │
├─────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory*]…         │
├─────────────────────────────────────────────┤
│ ┌─── segmented (4 tabs, scrollable) ───────┐│
│ │ รายการสินค้า | รับเข้า | ล็อตยา* | ค้นของ ││
│ └───────────────────────────────────────────┘│
│ [+ เพิ่มสินค้า]      [📷 สแกนรับเข้า]        │
│                                              │
│ ── ตัวกรอง (filter bar) ──────────────────── │
│ ┌─────────────────────────────────────────┐ │
│ │ ช่วงหมดอายุ: ทั้งหมด ▾                   │ │  ← window filter
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ สถานะ: ทุกสถานะ ▾                         │ │  ← status filter
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ 🔍 ค้นชื่อยา / SKU                       │ │  ← item search (live)
│ └─────────────────────────────────────────┘ │
│                                              │
│ ┌── lot list (table-responsive) ───────────┐│
│ │ ชื่อยา / ล็อต   วันหมดอายุ    คงเหลือ  จัดการ││
│ ├──────────────────────────────────────────┤│
│ │ อะม็อกซิลิน    [🔴 เกิน]       0        …││  ← expired: dark red
│ │ LOT-2025-A    31/12/2025                 ││
│ ├──────────────────────────────────────────┤│
│ │ อะม็อกซิลิน    [🟠 15 วัน]     80 เม็ด  …││  ← ≤30d: amber
│ │ LOT-2026-B    02/06/2026                 ││
│ ├──────────────────────────────────────────┤│
│ │ ไอบูโพรเฟน     [🟡 45 วัน]     200 เม็ด …││  ← ≤60d: yellow
│ │ LOT-2026-C    02/07/2026                 ││
│ ├──────────────────────────────────────────┤│
│ │ ไอบูโพรเฟน     [🟢 180 วัน]   500 เม็ด …││  ← ≥90d: green
│ │ LOT-2026-D    14/11/2026                 ││
│ └──────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

**Mobile layout note:** On < 576 px, columns "ชื่อยา" and "ล็อต" are
stacked as two lines in the first cell. "คงเหลือ" and "จัดการ" share the
second column. The date badge occupies the third column. This keeps the table
legible without horizontal scroll.

#### 3.1.2 Wireframe @ 768 px+ (tablet / desktop)

```
┌───────────────────────────────────────────────────────────────────────┐
│ navbar                                                                  │
├───────────────────────────────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory*][Ambulances][Settings][Sessions]      │
├───────────────────────────────────────────────────────────────────────┤
│ รายการสินค้า | รับเข้า | ล็อตยา* | ค้นของ       [+ เพิ่มสินค้า] [สแกน] │
│                                                                         │
│ [ช่วงหมดอายุ ▾]  [สถานะ ▾]  [🔍 ค้นชื่อยา / SKU         ]            │
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ SKU / ชื่อยา         ล็อตนัมเบอร์   วันหมดอายุ   คงเหลือ  สถานะ จัดการ│   │
│ ├─────────────────────────────────────────────────────────────────┤   │
│ │ MED-AMOX-500         LOT-2025-A    31/12/2025      0     [🔴หมด] [เรียกคืน]│
│ │ อะม็อกซิลิน 500mg                                                    │
│ ├─────────────────────────────────────────────────────────────────┤   │
│ │ MED-AMOX-500         LOT-2026-B    02/06/2026     80 เม็ด [🟠ใกล้] [เรียกคืน][ดู]│
│ │ อะม็อกซิลิน 500mg                                                    │
│ ├─────────────────────────────────────────────────────────────────┤   │
│ │ MED-IBU-400          LOT-2026-C    02/07/2026    200 เม็ด [🟡เฝ้า] [เรียกคืน][ดู]│
│ │ ไอบูโพรเฟน 400mg                                                     │
│ ├─────────────────────────────────────────────────────────────────┤   │
│ │ MED-IBU-400          LOT-2026-D    14/11/2026    500 เม็ด [🟢ปกติ] [เรียกคืน][ดู]│
│ │ ไอบูโพรเฟน 400mg                                                     │
│ └─────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────┘
```

#### 3.1.3 Expiry color-coding specification

The color scheme must use both color AND text label — never color alone —
so the information is accessible without color vision. All badges are Bootstrap
`badge` components with a text label inside.

| Condition | Badge color | Bootstrap utility | Badge label | Icon prefix |
|---|---|---|---|---|
| `status='expired'` | Dark red (#842029) | `bg-danger text-white` | `หมดอายุแล้ว` | 🔴 |
| `status='recalled'` | Purple (#6f42c1) | `bg-purple-subtle text-purple` | `ถูกเรียกคืน` | — (no icon — purple is rare enough) |
| `status='depleted'` | Grey | `bg-secondary text-white` | `ใช้หมดแล้ว` | — |
| `days_until_expiry <= 0` (active, but cron hasn't run yet) | Dark red | `bg-danger text-white` | `หมดอายุแล้ว` | 🔴 |
| `days_until_expiry <= 30` (active) | Amber (#fd7e14) | `bg-warning text-dark` | `ใกล้หมดอายุ` | 🟠 |
| `days_until_expiry <= 60` (active) | Yellow (#ffc107) | `bg-warning text-dark` (lighter shade via `opacity-75`) | `เฝ้าระวัง` | 🟡 |
| `days_until_expiry <= 90` (active) | Teal-subtle | `bg-stock-accent-subtle text-stock-accent-dark` | `ใกล้ครบ 90 วัน` | — |
| `days_until_expiry > 90` (active) | Green | `bg-success text-white` | `ปกติ` | 🟢 |

**Implementation note for designer + developer:** The ≤30d and ≤60d bands
both use `bg-warning`, differentiated by `opacity-75` on the 60d band and by
the icon + text label. This avoids introducing new non-Bootstrap color classes.
The `--stock-accent-subtle` token (already in `shared/styles.css` line 734)
covers the 60-90d "keep watching" band.

#### 3.1.4 Filter bar options

**ช่วงหมดอายุ (expiry window) dropdown options:**

| Option value | Label |
|---|---|
| `all` | ทั้งหมด (default) |
| `overdue` | เกินกำหนดแล้ว |
| `30` | ภายใน 30 วัน |
| `60` | ภายใน 60 วัน |
| `90` | ภายใน 90 วัน |

**สถานะ dropdown options:**

| Option value | Label |
|---|---|
| `all` | ทุกสถานะ (default) |
| `active` | ใช้งานอยู่ |
| `expired` | หมดอายุแล้ว |
| `recalled` | ถูกเรียกคืน |
| `depleted` | ใช้หมดแล้ว |

#### 3.1.5 Interaction states

| Element | Default | Loading | Empty | Error |
|---|---|---|---|---|
| Lot list table | rows ordered by `expiry_date ASC` | `<tr><td colspan="6">กำลังโหลด…</td></tr>` (text-muted, centered) | See §3.1.6 empty state | `<tr><td colspan="6" class="text-danger">โหลดล็อตไม่สำเร็จ — กดรีเฟรช</td></tr>` + [รีเฟรช] button |
| Filter dropdowns | defaults as listed above | options say `กำลังโหลด…` while items load | n/a | n/a |
| ค้นชื่อยา input | placeholder, live-filters on input event | n/a | n/a | n/a |
| [เรียกคืน] button (per row) | visible only for `status IN (active, expired)` | spinner + disabled while PATCH in flight | n/a | toast `เรียกคืนไม่สำเร็จ: {err}` |
| [ดูรายละเอียด] (per row) | visible for all non-depleted lots | n/a | n/a | n/a |

#### 3.1.6 Empty state

```
┌─────────────────────────────────────────────┐
│                                              │
│           (icon: bi-capsule)                 │
│                                              │
│   ยังไม่มีล็อตยา                              │
│                                              │
│   เริ่มที่แท็บ "รายการสินค้า"                  │
│   และเปิด "ติดตามล็อต/วันหมดอายุ"             │
│   สำหรับสินค้าในหมวด ยาและเวชภัณฑ์            │
│                                              │
│   [ไปที่รายการสินค้า →]                       │  ← btn-outline-stock-accent
│                                              │
└─────────────────────────────────────────────┘
```

**Empty state — after filter applied but no results:**

```
│   ไม่พบล็อตที่ตรงกับตัวกรอง                   │
│   [ล้างตัวกรอง]                               │
```

#### 3.1.7 Lot detail expand (inline, tap [ดูรายละเอียด])

On tap, the row expands into a detail card below it (accordion pattern,
no modal). Shows:

```
│   ผู้จัดจำหน่าย (Supplier): Pfizer Thailand  │
│   รับเข้า: 200 เม็ด  เมื่อ 2026-05-18         │
│   รับเข้าโดย: admin                           │
│   หมายเหตุ: —                                 │
│   [ปิด]                                       │
```

No edit allowed from this panel — to correct a lot, Admin uses the Receive
form to add a compensating movement, or contacts DB admin.

---

### 3.2 Admin — Receive Modal Extension for `tracks_lots=true` Items [S-2.2]

#### Context

This extends the existing Receive / Adjust sub-view (Phase 1 Screen 2.D).
When the admin selects an item from the "สินค้า" dropdown and that item has
`tracks_lots=true`, a "รายละเอียดล็อต" section slides in with an animation
(`fadeIn` — existing `shared/styles.css` keyframe). The section is mandatory
before saving.

#### 3.2.1 Wireframe — lot section visible @ 360 px

```
┌─────────────────────────────────────────────┐
│ (segmented as before, "รับเข้า" active)     │
├─────────────────────────────────────────────┤
│ ── รับเข้า / ปรับสต๊อก (Manual) ──          │
│                                              │
│ สินค้า *                                     │
│ [อะม็อกซิลิน 500mg (MED-AMOX-500) ▾]        │  ← tracks_lots=true selected
│                                              │
│ ┌── รายละเอียดล็อต ★ (required) ──────────┐ │
│ │  ★ ยาชนิดนี้ต้องระบุข้อมูลล็อต           │ │  ← blue info banner
│ │                                          │ │
│ │  ตัวเลือก: [ล็อตใหม่] [เพิ่มให้ล็อตเดิม] │ │  ← toggle tabs (2 options)
│ │                                          │ │
│ │  ── ล็อตใหม่ ──                          │ │
│ │  หมายเลขล็อต *                           │ │
│ │  [________________________]               │ │
│ │                                          │ │
│ │  วันหมดอายุ *                            │ │
│ │  [  วว/ดด/ปปปป   📅 ]                    │ │  ← date input, min=today
│ │                                          │ │
│ │  ⚠ วันหมดอายุน้อยกว่า 30 วัน (hidden unless│ │  ← warning only, not block
│ │     < 30d)                               │ │
│ │                                          │ │
│ │  ผู้จัดจำหน่าย / Supplier (ไม่บังคับ)      │ │
│ │  [________________________]               │ │
│ │                                          │ │
│ │  หมายเหตุ (ไม่บังคับ)                     │ │
│ │  [________________________]               │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌── ตัวอย่างล็อต (preview card) ───────────┐ │  ← appears when all required fields filled
│ │  MED-AMOX-500 · อะม็อกซิลิน 500mg       │ │
│ │  ล็อต: LOT-2026-B · หมด: 02/06/2026      │ │
│ │  [🟠 ใกล้หมดอายุ]                         │ │  ← expiry badge, same scale as lot list
│ └──────────────────────────────────────────┘ │
│                                              │
│ สถานที่ *                                    │
│ [— เลือก — ▾]                               │
│                                              │
│ จำนวน *          เหตุผล / Note              │
│ [_______]       [______________________]     │
│                                              │
│ [บันทึก]                                      │
└─────────────────────────────────────────────┘
```

#### 3.2.2 "เพิ่มให้ล็อตเดิม" (top-up existing lot) sub-view

When admin taps "เพิ่มให้ล็อตเดิม":

```
│ ── เพิ่มของให้ล็อตเดิม ──                    │
│                                              │
│ เลือกล็อตที่มีอยู่ *                          │
│ ┌──────────────────────────────────────────┐ │
│ │ ล็อต LOT-2026-B · หมด 02/06/2026 (80เม็ด)│ │  ← option from existing lots
│ │ ล็อต LOT-2026-D · หมด 14/11/2026 (500เม็ด)│ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ (no lot_number or expiry_date field —        │
│  the existing lot's fields are used)         │
```

This inserts a new `stock_movements` row referencing the chosen lot's `id`
with `movement_type='receive'`, without creating a new `stock_lots` row.

#### 3.2.3 Inline validation rules

| Field | Rule | Error copy |
|---|---|---|
| หมายเลขล็อต | required; client-side non-empty check | `กรุณาระบุหมายเลขล็อต` |
| หมายเลขล็อต | unique per item — 409 from DB | `ล็อตนี้มีอยู่แล้ว — ตรวจสอบ หรือเลือก "เพิ่มให้ล็อตเดิม"` (inline error below field) |
| วันหมดอายุ | required; `>= today` enforced client-side | `วันหมดอายุต้องไม่ผ่านมาแล้ว` |
| วันหมดอายุ | `>= today` but `< today + 30 days` | `⚠ วันหมดอายุน้อยกว่า 30 วัน — ยืนยันการรับเข้า?` (warning banner, does NOT block save) |

#### 3.2.4 Lot preview card states

| Condition | Preview card |
|---|---|
| Required fields empty | card hidden |
| All required fields filled | card visible with expiry badge (computed client-side using same thresholds as lot list) |
| expiry_date < today | card shows 🔴 `หมดอายุแล้ว` badge + additional warning text `ไม่สามารถรับเข้าล็อตที่หมดอายุแล้ว — แก้ไขวันหมดอายุ` |

#### 3.2.5 Interaction states

| State | What changes |
|---|---|
| `tracks_lots=false` item selected | Lot section hidden (no animation — just `d-none`). Form behaves exactly as Phase 1. |
| `tracks_lots=true` item selected | Lot section slides in (`fadeIn` 350 ms). Required indicator on card header. |
| "ล็อตใหม่" tab active (default) | Shows lot_number + expiry_date + supplier + note fields |
| "เพิ่มให้ล็อตเดิม" tab active | Shows lot picker dropdown of existing lots for this item |
| No existing lots for "เพิ่มให้ล็อตเดิม" | Dropdown shows `ยังไม่มีล็อต — สร้างล็อตใหม่` (disabled option) and auto-switches back to "ล็อตใหม่" tab |
| [บันทึก] pressed, lot section empty | Client validation fires; lot section fields highlighted; scroll to first error |
| POST success | Toast `บันทึกแล้ว — สร้างล็อต {lot_number}` + form clears + lot list sub-view auto-refreshes |

---

### 3.3 Admin — Item Edit Form: `tracks_lots` Toggle [S-2.3]

#### Context

Extends the existing "แก้ไขสินค้า" modal (Phase 1 Screen 2.C). The toggle
is a new field below the existing "ใช้งานอยู่" checkbox.

#### 3.3.1 Wireframe — new toggle row

```
┌─── modal "แก้ไขสินค้า" ─────────────────────┐
│ … (existing fields: ชื่อ, SKU, หมวด, หน่วย, │
│    เกณฑ์เตือน, ใช้งานอยู่)                   │
│                                              │
│ ──────────────── Phase 2 ─────────────────── │
│                                              │
│ ☐ ติดตามล็อต / วันหมดอายุ                   │  ← toggle (checkbox style)
│   (ใช้สำหรับยาและเวชภัณฑ์ที่ต้องระบุล็อต)  │  ← help text (text-muted small)
│                                              │
└──────────────────────────────────────────────┘
```

#### 3.3.2 Warning banner — enabling on item with existing stock

When admin enables `tracks_lots` on an item that already has
`stock_item_locations.qty > 0` (checked client-side after toggle):

```
│ ┌─── ⚠ คำเตือน ─────────────────────────────┐│
│ │  สต๊อกปัจจุบัน {X} ชิ้น ยังไม่มีข้อมูลล็อต ││
│ │  กรุณาเพิ่มล็อตด้วย "รับเข้า" ใหม่          ││
│ │  (สต๊อกเดิมยังคงอยู่ — ไม่ถูกลบ)           ││
│ └────────────────────────────────────────────┘│
```

Warning is `alert alert-warning` (Bootstrap). The save button is NOT blocked
— admin may toggle `tracks_lots=true` and add lots later. The warning is
informational only.

#### 3.3.3 Warning banner — disabling on item with active lots

When admin attempts to disable `tracks_lots` on an item that has at least one
lot with `status='active'`:

```
│ ┌─── ⚠ ไม่สามารถปิดได้ ──────────────────┐│
│ │  ยังมีล็อตยาที่ใช้งานอยู่ {N} ล็อต       ││
│ │  โปรดทำรายการล็อตให้เสร็จก่อน             ││
│ └───────────────────────────────────────────┘│
```

In this case the toggle is **prevented client-side**: if the user un-checks and
tries to save, show the error above and re-check the checkbox. This avoids a
DB state where a running lot has no UI entry point.

#### 3.3.4 Interaction states

| State | Behavior |
|---|---|
| Item has `tracks_lots=false` (default for new items) | Toggle unchecked. No warning banners. |
| Admin checks toggle (item has no stock) | Toggle checked. No warning. |
| Admin checks toggle (item has stock > 0) | Toggle checked + warning banner about missing lots appears. |
| Admin unchecks toggle (item has active lots) | Toggle reverts to checked + error banner. Save blocked client-side. |
| Admin unchecks toggle (item has no active lots) | Toggle unchecked. No warning. |
| [บันทึก] | PATCH `stock_items.tracks_lots`. Toast `อัปเดตแล้ว`. |

---

### 3.4 Staff Scan — Lot Picker Step (Step 2.5) [S-2.6]

#### Context

Inserted between the location scan (Step 2) and the qty/submit row (Step 3)
when `item.tracks_lots = true` AND `movement_type IN ('issue', 'adjustment_loss')`.

**For receive (Admin scan):** The lot step is a different form (lot fields as in
§3.2). This section covers the staff issue path only.

**FEFO logic:** The picker displays lots from `v_lots_with_remaining`
(`status='active'` AND `current_qty > 0`), ordered `expiry_date ASC`. The
first lot in the list is pre-selected. Expired and recalled lots are excluded
from this view entirely (the view filters them out). If a lot somehow appears
with `days_until_expiry <= 0` despite the cron not having run (race condition
near midnight), it is shown with the red expired badge and is unselectable
(grayed out, `pointer-events: none`).

#### 3.4.1 Full scan flow with lot step — wireframe @ 360 px

**State 1: สแกนสินค้า (unchanged from Phase 1)**

```
┌─────────────────────────────────────────────┐
│ ← Thegood Stock                    [ออก]   │
├─────────────────────────────────────────────┤
│ 📷 สแกนเบิก-จ่าย              ค้นของ ↓      │
│                                              │
│ [item: —]   [location: —]                   │
│ (ขั้นที่ 1: สแกนสินค้า)                       │
│                                              │
│ [LIVE CAMERA 55vh max]                       │
│ พิมพ์รหัสแทน →                               │
│ [เริ่มใหม่]                                   │
└─────────────────────────────────────────────┘
```

**State 2.5: เลือกล็อต (NEW — inserted after location scanned)**

```
┌─────────────────────────────────────────────┐
│ ← Thegood Stock                    [ออก]   │
├─────────────────────────────────────────────┤
│ 📷 สแกนเบิก-จ่าย              ค้นของ ↓      │
│                                              │
│ [✓ item: MED-AMOX-500 อะม็อกซิลิน]          │  ← green chip
│ [✓ location: ROOM-A ห้องคลังสำรอง]           │  ← green chip
│                                              │
│ ── ขั้นที่ 2.5: เลือกล็อต ─────────────── │
│ (กำลังโหลดล็อต…)  ← loading state           │
│                                              │
│ ── หลังโหลดเสร็จ ──                          │
│                                              │
│ ┌── FEFO default: เลือกอัตโนมัติ ──────────┐│
│ │ ✓ LOT-2026-B   [🟠 15 วัน]   80 เม็ด   ││  ← pre-selected (ring border)
│ │   หมดอายุ 02/06/2026                     ││
│ └──────────────────────────────────────────┘│
│                                              │
│ ล็อตอื่น ▾  (tap to expand)                 │  ← collapsed by default
│                                              │
│ ┌── ล็อตอื่น (expanded on tap) ────────────┐│
│ │   LOT-2026-D   [🟢 180 วัน]  500 เม็ด  ││  ← tappable
│ │   หมดอายุ 14/11/2026                     ││
│ └──────────────────────────────────────────┘│
│                                              │
│ [ขั้นต่อไป: ระบุจำนวน →]                     │  ← full-width, btn-stock-primary
│                                              │
│ [เริ่มใหม่]                                   │
└─────────────────────────────────────────────┘
```

**State 3: ระบุจำนวน (Step 3 — unchanged from Phase 1, but shows lot chip)**

```
┌─────────────────────────────────────────────┐
│ [✓ item: MED-AMOX-500 อะม็อกซิลิน]          │  ← green
│ [✓ location: ROOM-A ห้องคลัง]               │  ← green
│ [✓ ล็อต: LOT-2026-B หมด 02/06/2026]         │  ← green, NEW third chip
│                                              │
│ ขั้นที่ 3: ระบุจำนวน แล้วกด "บันทึก"         │
│                                              │
│ ประเภท               จำนวน *                │
│ [เบิก-จ่าย ▾]         [_______]             │
│                                              │
│ [บันทึก]                                      │
│ [เริ่มใหม่]                                   │
└─────────────────────────────────────────────┘
```

#### 3.4.2 Lot picker card design

Each lot is a selectable card (`island-card` pattern from `shared/styles.css`
line 405):

- **Selected lot:** `border-stock-accent` (2 px teal border) + `bg-stock-accent-subtle` background.
- **Unselected lots:** default card style (only shown when "ล็อตอื่น" is expanded).
- **Expired lot (shown if somehow visible):** `bg-light text-muted` + line-through on lot number + cursor blocked + `aria-disabled="true"`.
- **Tap target:** Each lot card min 60 px tall so it is usable with a gloved thumb.

#### 3.4.3 Lot chip (Step 3 and success overlay)

A third chip appears between location chip and the qty row:

```
[✓ ล็อต: LOT-2026-B  🟠 02/06/2026]
```

The chip background matches the expiry badge color (amber for ≤30 d, yellow
for ≤60 d, teal-subtle for ≤90 d, green for >90 d). This gives the staff
user a passive visual cue about what they are issuing.

#### 3.4.4 Empty state (no available lots)

When `v_lots_with_remaining` returns zero rows for the scanned item:

```
┌─────────────────────────────────────────────┐
│ [✓ item: MED-AMOX-500 อะม็อกซิลิน]          │
│ [✓ location: ROOM-A]                         │
│                                              │
│ ── ขั้นที่ 2.5: เลือกล็อต ──               │
│                                              │
│   ⚠ ไม่มีล็อตยาที่พร้อมใช้งาน                │
│   ติดต่อผู้ดูแลระบบเพื่อรับเข้าล็อตใหม่       │
│                                              │
│ [เริ่มใหม่]                                   │  ← only option; issue aborted
└─────────────────────────────────────────────┘
```

A `showToast('warning', 'ไม่มีล็อตยาที่พร้อมใช้งาน — ติดต่อผู้ดูแลระบบ')`
fires simultaneously. The lot picker step does NOT allow proceeding to Step 3
with no lot selected.

#### 3.4.5 Loading state

While `fetchAvailableLots(itemId)` is in flight (between Step 2 completion and
lot list appearing):

```
│ ── ขั้นที่ 2.5: เลือกล็อต ──               │
│                                              │
│   ⏳ กำลังโหลดล็อตยา…                        │  ← text-muted + monitor-spin icon
│                                              │
```

The "ขั้นต่อไป" button is disabled during loading. If the fetch fails:

```
│   โหลดล็อตยาไม่สำเร็จ — กดลองอีกครั้ง       │
│   [ลองอีกครั้ง]                              │
```

---

### 3.5 Dashboard — Expiry Timeline Panel [S-2.7]

#### Context

Replaces the Phase 1 placeholder card "ภาพรวมสินค้าหมดอายุ — เปิดใช้งานใน
Phase 2". The panel is rendered by `js/dashboard.js` (extended in Phase 2).
Data source: a count query on `stock_lots` grouped by expiry bucket.

#### 3.5.1 Wireframe @ 360 px

```
┌─── Panel 3: สถานะวันหมดอายุ ────────────────┐
│  ภาพรวมวันหมดอายุ                            │  ← card-title
│  (อัปเดต: 08:32)                            │  ← last refresh time (text-muted small)
│                                              │
│  ┌── row: เกินกำหนดแล้ว ──────────────────┐ │
│  │  🔴  เกินกำหนดแล้ว              2 ล็อต │ │  ← text-danger, bold count
│  │      [ดูล็อต →]                         │ │  ← link to ล็อตยา sub-view filtered
│  └────────────────────────────────────────┘ │
│                                              │
│  ┌── row: ใน 30 วัน ──────────────────────┐ │
│  │  🟠  ใน 30 วัน                   3 ล็อต │ │  ← text-warning
│  │      [ดูล็อต →]                         │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ┌── row: 30-60 วัน ───────────────────────┐ │
│  │  🟡  30-60 วัน                  5 ล็อต │ │  ← text-warning opacity-75
│  │      [ดูล็อต →]                         │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ┌── row: 60-90 วัน ───────────────────────┐ │
│  │  —   60-90 วัน                  8 ล็อต │ │  ← text-muted (monitoring, no alarm)
│  │      [ดูล็อต →]                         │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ∙ ปกติ (> 90 วัน): 24 ล็อต               │  ← small, text-muted, no link
└──────────────────────────────────────────────┘
```

**Zero-state (no medication lots registered yet):**

```
│   ยังไม่มีข้อมูลล็อตยา                       │
│   ไปที่ Inventory > ล็อตยา เพื่อเริ่มต้น    │
```

**All-clear state (nothing expiring within 90 days, zero overdue):**

```
│   ✓ ทุกล็อตยาอยู่ในระดับปกติ                 │  ← text-success
│   ∙ ปกติ (> 90 วัน): 32 ล็อต               │
```

#### 3.5.2 Click / tap behavior

Tapping any row (or "ดูล็อต →" link) navigates to the Inventory tab,
activates the "ล็อตยา" sub-view, and pre-sets the "ช่วงหมดอายุ" filter to
the corresponding window. This is implemented via a URL hash or a JS call
`AppInventoryTab.switchToLots({ expiryFilter: 'overdue' })`.

#### 3.5.3 Interaction states

| State | Visual |
|---|---|
| Loading | Each row shows `กำลังโหลด…` placeholder text + `monitor-spin` icon |
| Count = 0 for a bucket | Row shows `0 ล็อต` in `text-muted`; [ดูล็อต →] link still visible |
| Count > 0, overdue bucket | Row has `border-start border-danger border-3 ps-2` (Bootstrap left border accent) |
| Count > 0, 30d bucket | `border-start border-warning border-3 ps-2` |
| Fetch error | `โหลดข้อมูลไม่สำเร็จ — [รีเฟรช]` replaces all rows |

---

### 3.6 Recall Confirm Modal [S-2.4]

#### Context

Opened by tapping [เรียกคืน] on a lot row in the "ล็อตยา" sub-view. Enforces
a deliberate, documented action (Q-Phase2-2 Option A recommendation: soft status
flag with reason captured for audit).

#### 3.6.1 Wireframe @ 360 px

```
┌─── modal "ยืนยันการเรียกคืนล็อต" ──────────┐
│ ยืนยันการเรียกคืนล็อต                   [✕] │
│                                              │
│ ล็อต: LOT-2026-B                            │
│ ยา:   อะม็อกซิลิน 500mg (MED-AMOX-500)      │
│ คงเหลือ: 80 เม็ด                            │
│ วันหมดอายุ: 02/06/2026                      │
│                                              │
│ ┌─── ⚠ ────────────────────────────────────┐│
│ │  ล็อตนี้จะถูกล็อคจากการเบิก-จ่าย          ││
│ │  ทุก session ของเจ้าหน้าที่จะไม่เห็นล็อตนี้││
│ └────────────────────────────────────────────┘│
│                                              │
│ เหตุผลการเรียกคืน *                          │
│ [________________________________]           │
│ ตัวอย่าง: ผู้ผลิตแจ้งเรียกคืน, พบสิ่งปนเปื้อน│  ← placeholder
│                                              │
│        [ยกเลิก]    [ยืนยัน เรียกคืน]         │
│                    (btn-danger)              │
└──────────────────────────────────────────────┘
```

#### 3.6.2 Interaction states

| Element | Default | Loading | Success | Error |
|---|---|---|---|---|
| [ยืนยัน เรียกคืน] | `btn-danger`, enabled | spinner + disabled, text `กำลังบันทึก…` | modal closes; toast `เรียกคืนล็อต LOT-2026-B แล้ว`; lot row updates to purple badge | toast `เรียกคืนไม่สำเร็จ: {err}`; modal stays open |
| เหตุผล field | required | n/a | n/a | empty → `กรุณาระบุเหตุผล` (client-side, inline) |

**Decision (D-R1):** The reason text is stored in `stock_lots.note` column on
the PATCH (appended with timestamp and `recalled_by` username). No separate
`recall_log` table in Phase 2 — the `stock_lots.updated_by` + `updated_at`
columns serve as the audit trail per spec §5.1. If a full recall log is needed
in Phase 3+, the `note` field data can be migrated.

---

### 3.7 Admin Override: Force-Issue Expired Lot [S-2.5]

#### Context

Q-Phase2-3 and Q-Phase2-4 both recommend always-on auto-expire and DB-trigger
blocking. However, there is a clinical edge case: a clinician may need to
administer a medication that expired within the last 24 hours and is the only
available supply. This is a deliberate override by the admin only.

Per the design constraints ("Admin manual override: small 'force issue expired'
button hidden behind 2-tap confirmation"), this is in the admin context only,
not the staff scan flow.

**Location:** Lot detail expand panel in the "ล็อตยา" sub-view. The [ดูรายละเอียด]
expand shows a "force issue" option only for `status='expired'` lots.

#### 3.7.1 Wireframe — force-issue section in lot detail expand

```
│   ── ล็อตรายละเอียด ──                        │
│   ผู้จัดจำหน่าย: Pfizer Thailand              │
│   รับเข้า: 80 เม็ด เมื่อ 2026-05-15           │
│   หมายเหตุ: —                                 │
│                                              │
│   ── การจัดการพิเศษ (Admin เท่านั้น) ── │
│                                              │
│   [บังคับเบิก-จ่าย (หมดอายุ)]               │  ← small, `btn-outline-danger btn-sm`
│   (ข้ามกฎ: ล็อตนี้หมดอายุแล้ว)              │  ← text-muted small help text
│                                              │
```

On first tap, a confirmation modal appears (Step 1 of 2):

```
┌─── ยืนยันขั้นที่ 1/2 ─────────────────────┐
│ ⚠ ล็อตนี้หมดอายุแล้ว — แน่ใจหรือไม่?    [✕]│
│                                              │
│ LOT-2025-A · อะม็อกซิลิน 500mg              │
│ หมดอายุ: 31/12/2025                         │
│                                              │
│ การใช้ยาหมดอายุมีความเสี่ยงต่อผู้ป่วย       │
│                                              │
│        [ยกเลิก]    [ดำเนินการต่อ]            │
└──────────────────────────────────────────────┘
```

On "ดำเนินการต่อ", a second confirmation (Step 2 of 2):

```
┌─── ยืนยันขั้นที่ 2/2 ─────────────────────┐
│ ⚠ ยืนยันครั้งสุดท้าย                    [✕]│
│                                              │
│ เหตุผลที่ต้องใช้ยาหมดอายุ *                │
│ [________________________________]           │
│                                              │
│ การดำเนินการนี้จะถูกบันทึกในระบบ             │
│                                              │
│  [ยกเลิก]    [ยืนยัน — บังคับเบิกจ่าย]      │
│              (btn-danger)                    │
└──────────────────────────────────────────────┘
```

On confirm: Admin can then navigate to the Receive sub-view, select "เพิ่มให้
ล็อตเดิม", and issue manually. The actual force-issue mechanism (DB-level bypass)
is outside this design's scope — the plan author must determine the exact
mechanism (e.g., a temporary status change to 'active' plus immediate revert
after movement, or a special `force_issue` RPC). This design only specifies
the UX surface.

**UX flag for PM (see §10 Q-D1):** This double-confirmation flow is intentionally
friction-heavy. The intent is that it takes a minimum of 4 deliberate taps
from the lot list to complete a force-issue. The design recommends the PM
confirm this level of friction is appropriate vs requiring a phone call to
Thegood's medical director first.

---

## 4. Component Reuse Map

### 4.1 Phase 1 components reused without change

| Component | Where used in Phase 2 | Source |
|---|---|---|
| `.navbar.bg-modern-primary.navbar-dark` | All pages (unchanged) | `shared/styles.css` l.39 |
| `.nav.nav-pills .nav-link.stock-tab` | Inventory tab segmented (add 4th segment) | Phase 1 `inventory.js` |
| `.btn.btn-stock-primary` | All primary CTAs: "บันทึก", "ขั้นต่อไป" | `shared/styles.css` l.737 |
| `.btn.btn-outline-stock-accent` | Secondary CTAs: "ล้างตัวกรอง", "ไปที่รายการสินค้า →" | `shared/styles.css` l.748 |
| `.btn.btn-outline-danger` | Recall button, force-issue button | Bootstrap |
| `.island-card` | Lot picker cards in scan flow | `shared/styles.css` l.405 |
| `.modal .modal-dialog .modal-content` (rounded-20px) | Recall modal, force-issue modal | `shared/styles.css` l.507 |
| `.table.table-sm.align-middle` | Lot list table | Bootstrap |
| `.table-responsive` | Lot list table wrapper | Bootstrap |
| `.badge.bg-success/bg-danger/bg-warning/bg-secondary` | Expiry badges | Bootstrap |
| `showToast(level, msg)` | All toast notifications | `shared/ui.js` |
| `showConfirm(msg)` | NOT used for recall (needs reason text field; use custom modal) | `shared/ui.js` |
| `monitor-spin` | Loading states in lot picker and expiry panel | `shared/styles.css` l.28 |
| `fadeIn` animation | Lot section slide-in on item select | `shared/styles.css` l.17 |
| `bg-purple-subtle` + `text-purple` | Recalled lot badge | `shared/styles.css` l.5–6 |
| `text-muted` empty states | All empty states | Bootstrap |

### 4.2 Phase 1 components extended

| Component | Extension | Impacts |
|---|---|---|
| Inventory tab segmented control | Add 4th segment "ล็อตยา" | `js/inventory.js` — register new sub-view + tab |
| Receive sub-view form | Add lot fields section (conditional) | `js/inventory.js` — detect `tracks_lots`, show lot fields |
| Item Add/Edit modal | Add `tracks_lots` toggle row | `js/inventory.js` — add field, add warning logic |
| Staff scan 3-step state machine | Add step 2.5 (lot picker) | `js/staff-scan.js` — insert between `loc` and `qty` states |
| Scan chip row | Add third chip for lot | `js/staff-scan.js` — chip template |
| Dashboard Panel 3 | Replace placeholder content | `js/dashboard.js` — query expiry buckets, render rows |

### 4.3 New components (Phase 2 only)

| Component | Description | Proposed file |
|---|---|---|
| Lot list table render | Renders `stock_lots` rows with color-coded badges and action buttons | `js/inventory-lots.js` |
| Lot filter bar | Three dropdowns (window/status/search) with live filter logic | `js/inventory-lots.js` |
| Recall confirm modal | Custom modal with reason text field and 2-button footer | `js/inventory-lots.js` |
| Lot preview card | Client-computed expiry badge card shown in Receive form | `js/inventory-lots.js` or inline in `js/inventory.js` |
| Lot picker widget | Scrollable card list for staff scan step 2.5; FEFO pre-selection | `shared/lots.js` — `renderLotPicker(lots, selectedLotId, onSelect)` |
| `fetchAvailableLots(itemId)` | Queries `v_lots_with_remaining` for a given item | `shared/lots.js` |
| Expiry timeline panel | 4-row summary with colored left-border accents and drill-down links | `js/dashboard.js` (new section) |
| Force-issue 2-step modal | Double-confirmation modal for admin expired-lot override | `js/inventory-lots.js` |

---

## 5. Interaction State Diagrams

### 5.1 Admin Inventory Tab — Four-Segment State Machine

```
TAB INIT
  │
  ▼
renderShell()
  ├── Segment A: รายการสินค้า (default active)
  ├── Segment B: รับเข้า
  ├── Segment C: ล็อตยา  ← NEW Phase 2
  └── Segment D: ค้นของ

USER TAPS SEGMENT C ("ล็อตยา")
  │
  ▼
loadLotsView()
  ├── [loading] → fetch stock_lots JOIN stock_items WHERE tracks_lots=true
  │       ↓ error → [error state: โหลดล็อตไม่สำเร็จ] + [รีเฟรช] button
  │       ↓ success
  ├── [empty] → if count=0 → [empty state with helper link]
  └── [populated] → render lot list table with expiry badges

USER TAPS [เรียกคืน] on a lot row (status=active or expired)
  │
  ▼
openRecallModal(lot)
  ├── [open] → show recall modal with lot details
  │   ├── User enters reason text
  │   ├── [ยืนยัน เรียกคืน]
  │   │       ↓ reason empty → inline error, modal stays
  │   │       ↓ reason filled → PATCH stock_lots.status='recalled' + note
  │   │               ↓ error → toast error, modal stays
  │   │               ↓ success → modal closes, lot row updates badge,
  │   │                           toast "เรียกคืนล็อต {lot_number} แล้ว"
  │   └── [ยกเลิก] → modal closes, no change
  └── (depleted lots: [เรียกคืน] button absent)

USER TAPS [ดูรายละเอียด] on a lot row
  │
  ▼
expandLotDetail(lot)
  ├── Row expands inline (accordion)
  ├── For expired lots: shows force-issue section
  │   ├── [บังคับเบิก-จ่าย] tap 1 → confirmation modal step 1
  │   │   ├── [ดำเนินการต่อ] → step 2 modal with reason field
  │   │   │   ├── [ยืนยัน] → (plan author determines DB mechanism)
  │   │   │   └── [ยกเลิก] → step 2 modal closes
  │   │   └── [ยกเลิก] → step 1 modal closes
  └── [ปิด] → row collapses
```

### 5.2 Staff Scan — Extended 5-Step State Machine

```
PAGE LOAD
  │
  ├── [permission-prompt] → camera permission gate
  │       ↓ user taps [อนุญาต] → getUserMedia
  │               ↓ denied → [permission-denied]
  │               ↓ granted → [state: ITEM]
  └── [manual-fill] → fallback text inputs
                      ↓ confirm → [state: QTY] (skips steps 1+2)

[state: ITEM] — camera scanning
  ↓ scan success (item found, tracks_lots=false) → [state: LOC]
  ↓ scan success (item found, tracks_lots=true)  → [state: LOC]
                                                    (lot step pending)
  ↓ item not found → toast, stay in ITEM

[state: LOC] — camera scanning
  ↓ scan success → [state: LOT-LOADING] if tracks_lots=true
                   [state: QTY]         if tracks_lots=false
  ↓ loc not found → toast, stay in LOC

[state: LOT-LOADING] ← NEW Phase 2
  ↓ fetchAvailableLots(itemId) in flight
  ↓ error → toast + [ลองอีกครั้ง] button, stay in LOT-LOADING
  ↓ success (0 lots) → [state: LOT-EMPTY]
  ↓ success (>0 lots) → [state: LOT-PICK]

[state: LOT-EMPTY] ← NEW Phase 2
  → toast "ไม่มีล็อตยาที่พร้อมใช้งาน"
  → show [เริ่มใหม่] only (issue aborted, no path forward)

[state: LOT-PICK] ← NEW Phase 2
  → FEFO lot pre-selected (first in list)
  → optional: user taps "ล็อตอื่น" to see more lots
  → optional: user taps a different lot (selectedLot changes)
  ↓ [ขั้นต่อไป] → [state: QTY]

[state: QTY] — camera stopped
  → third chip shows selected lot (if tracks_lots=true)
  ↓ [บันทึก] → [state: SUBMITTING]

[state: SUBMITTING]
  ↓ success (2xx) → [state: SUCCESS]
  ↓ error: short-stock → toast "ของไม่พอ", stay in QTY
  ↓ error: lot-expired/recalled (DB trigger fires) → toast
     "ล็อตนี้ไม่สามารถเบิกได้ (หมดอายุหรือถูกเรียกคืน)
     — กลับไปเลือกล็อตใหม่", go to LOT-PICK
  ↓ error: network → toast, stay in QTY (idempotent)

[state: SUCCESS]
  → 800 ms overlay: "บันทึกแล้ว + lot info"
  → auto-reset to [state: ITEM]
```

**Note on the DB-trigger error path:** If a staff user's session has a cached
lot that is expired or recalled (the list was loaded before a recall happened),
the DB trigger (`enforce_lot_required_for_meds` + status check per Q-Phase2-4)
will reject the movement. The UI must handle this 400/500 error gracefully by
returning the user to the lot picker so they can re-fetch and re-select.

### 5.3 Recall Action Flow

```
Admin on ล็อตยา sub-view
  │
  ▼
Taps [เรียกคืน] on lot row (status: active or expired)
  │
  ▼
openRecallModal()
  ├── Modal shows lot details (read-only)
  ├── Reason text field (required)
  │
  ├── [ยกเลิก] → modal closes, no state change
  │
  └── [ยืนยัน เรียกคืน]
          │
          ├── reason empty → inline error "กรุณาระบุเหตุผล", modal stays
          │
          └── reason filled
                  │
                  ▼
              PATCH stock_lots
                { status: 'recalled',
                  note: existing_note + '\n[เรียกคืน ' + timestamp + '] เหตุผล: ' + reason,
                  updated_by: current_username }
                  │
                  ├── error → toast "เรียกคืนไม่สำเร็จ: {err}", modal stays open
                  │
                  └── success
                          ↓ modal closes
                          ↓ lot row badge changes to purple "ถูกเรียกคืน"
                          ↓ [เรียกคืน] button on that row becomes hidden
                          ↓ toast "เรียกคืนล็อต {lot_number} แล้ว"
                          ↓ lot disappears from v_lots_with_remaining
                             (next staff scan will not see it)
```

---

## 6. Microcopy Table (All Thai Strings)

### 6.1 Navigation / segmented control

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-01 | `ล็อตยา` | "Medication lots" tab | 4th segment in Inventory tab |
| M-02 | `รายการสินค้า` | "Items list" tab | Phase 1 — unchanged |
| M-03 | `รับเข้า` | "Receive" tab | Phase 1 — unchanged |
| M-04 | `ค้นของ` | "Find item" tab | Phase 1 — unchanged |

### 6.2 Lot list table [S-2.1]

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-05 | `SKU / ชื่อยา` | "SKU / Medication name" | Table column header |
| M-06 | `ล็อตนัมเบอร์` | "Lot number" | Table column header |
| M-07 | `วันหมดอายุ` | "Expiry date" | Table column header |
| M-08 | `คงเหลือ` | "Remaining qty" | Table column header |
| M-09 | `สถานะ` | "Status" | Table column header |
| M-10 | `จัดการ` | "Actions" | Table column header |
| M-11 | `เรียกคืน` | "Recall" | Action button label |
| M-12 | `ดูรายละเอียด` | "View details" | Action button label |
| M-13 | `หมดอายุแล้ว` | "Expired" | Badge: status=expired or days<=0 |
| M-14 | `ถูกเรียกคืน` | "Recalled" | Badge: status=recalled |
| M-15 | `ใช้หมดแล้ว` | "Depleted" | Badge: status=depleted |
| M-16 | `ใกล้หมดอายุ` | "Expiring soon" | Badge: days<=30, active |
| M-17 | `เฝ้าระวัง` | "Watch" | Badge: days<=60, active |
| M-18 | `ใกล้ครบ 90 วัน` | "Approaching 90 days" | Badge: days<=90, active |
| M-19 | `ปกติ` | "Normal" | Badge: days>90, active |
| M-20 | `กำลังโหลด…` | "Loading…" | Table loading row |
| M-21 | `โหลดล็อตไม่สำเร็จ — กดรีเฟรช` | "Failed to load lots — tap refresh" | Error row |
| M-22 | `รีเฟรช` | "Refresh" | Error action button |
| M-23 | `ยังไม่มีล็อตยา` | "No medication lots yet" | Empty state heading |
| M-24 | `เริ่มที่แท็บ "รายการสินค้า" และเปิด "ติดตามล็อต/วันหมดอายุ" สำหรับสินค้าในหมวด ยาและเวชภัณฑ์` | "Start in the Items list tab and enable lot tracking for MEDICATION category items" | Empty state body |
| M-25 | `ไปที่รายการสินค้า →` | "Go to Items list" | Empty state CTA |
| M-26 | `ไม่พบล็อตที่ตรงกับตัวกรอง` | "No lots match current filters" | Filtered empty state |
| M-27 | `ล้างตัวกรอง` | "Clear filters" | Filtered empty state CTA |

### 6.3 Filter bar

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-28 | `ช่วงหมดอายุ: ทั้งหมด` | "Expiry window: All" | Filter dropdown default |
| M-29 | `เกินกำหนดแล้ว` | "Overdue" | Window filter option |
| M-30 | `ภายใน 30 วัน` | "Within 30 days" | Window filter option |
| M-31 | `ภายใน 60 วัน` | "Within 60 days" | Window filter option |
| M-32 | `ภายใน 90 วัน` | "Within 90 days" | Window filter option |
| M-33 | `สถานะ: ทุกสถานะ` | "Status: All" | Status filter default |
| M-34 | `ใช้งานอยู่` | "Active" | Status filter option |
| M-35 | `ค้นชื่อยา / SKU` | "Search medication name / SKU" | Search input placeholder |

### 6.4 Receive form lot extension [S-2.2]

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-36 | `รายละเอียดล็อต` | "Lot details" | Section header |
| M-37 | `★ ยาชนิดนี้ต้องระบุข้อมูลล็อต` | "This medication requires lot information" | Info banner |
| M-38 | `ล็อตใหม่` | "New lot" | Toggle tab |
| M-39 | `เพิ่มให้ล็อตเดิม` | "Add to existing lot" | Toggle tab |
| M-40 | `หมายเลขล็อต *` | "Lot number (required)" | Field label |
| M-41 | `วันหมดอายุ *` | "Expiry date (required)" | Field label |
| M-42 | `ผู้จัดจำหน่าย / Supplier (ไม่บังคับ)` | "Supplier (optional)" | Field label |
| M-43 | `หมายเหตุ (ไม่บังคับ)` | "Note (optional)" | Field label |
| M-44 | `กรุณาระบุหมายเลขล็อต` | "Please enter a lot number" | Validation error |
| M-45 | `วันหมดอายุต้องไม่ผ่านมาแล้ว` | "Expiry date must not be in the past" | Validation error |
| M-46 | `⚠ วันหมดอายุน้อยกว่า 30 วัน — ยืนยันการรับเข้า?` | "Expiry date is less than 30 days away — confirm receive?" | Warning banner (does not block) |
| M-47 | `ล็อตนี้มีอยู่แล้ว — ตรวจสอบ หรือเลือก "เพิ่มให้ล็อตเดิม"` | "This lot already exists — check it or choose 'Add to existing lot'" | Duplicate lot error |
| M-48 | `บันทึกแล้ว — สร้างล็อต {lot_number}` | "Saved — lot {lot_number} created" | Success toast |
| M-49 | `เลือกล็อตที่มีอยู่ *` | "Select existing lot (required)" | Top-up dropdown label |
| M-50 | `ยังไม่มีล็อต — สร้างล็อตใหม่` | "No lots yet — create new lot" | Top-up dropdown empty option |

### 6.5 Item edit form `tracks_lots` toggle [S-2.3]

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-51 | `ติดตามล็อต / วันหมดอายุ` | "Track lots / expiry date" | Toggle label |
| M-52 | `ใช้สำหรับยาและเวชภัณฑ์ที่ต้องระบุล็อต` | "Use for medications that require lot tracking" | Help text (text-muted small) |
| M-53 | `สต๊อกปัจจุบัน {X} ชิ้น ยังไม่มีข้อมูลล็อต — กรุณาเพิ่มล็อตด้วย "รับเข้า" ใหม่` | "Current stock of {X} units has no lot data — please add lots via 'Receive'" | Warning when enabling on stocked item |
| M-54 | `ยังมีล็อตยาที่ใช้งานอยู่ {N} ล็อต — โปรดทำรายการล็อตให้เสร็จก่อน` | "Still has {N} active lots — please close all lots before disabling" | Error when disabling with active lots |

### 6.6 Staff scan lot picker [S-2.6]

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-55 | `ขั้นที่ 2.5: เลือกล็อต` | "Step 2.5: Select lot" | Step heading |
| M-56 | `FEFO default: เลือกอัตโนมัติ` | "FEFO default: auto-selected" | Sub-label above default lot card |
| M-57 | `ล็อตอื่น ▾` | "Other lots (tap to expand)" | Collapsed other-lots toggle |
| M-58 | `ขั้นต่อไป: ระบุจำนวน →` | "Next: Enter quantity" | CTA button after lot selected |
| M-59 | `✓ ล็อต: {lot_number}  {expiry_badge}` | "Lot: {lot_number} {expiry_badge}" | Third chip label (step 3) |
| M-60 | `กำลังโหลดล็อตยา…` | "Loading medication lots…" | Lot picker loading state |
| M-61 | `โหลดล็อตยาไม่สำเร็จ — กดลองอีกครั้ง` | "Failed to load lots — tap to retry" | Lot picker error |
| M-62 | `ลองอีกครั้ง` | "Try again" | Retry button |
| M-63 | `ไม่มีล็อตยาที่พร้อมใช้งาน` | "No available medication lots" | Empty picker heading |
| M-64 | `ติดต่อผู้ดูแลระบบเพื่อรับเข้าล็อตใหม่` | "Contact admin to receive a new lot" | Empty picker body |
| M-65 | `ล็อตนี้ไม่สามารถเบิกได้ (หมดอายุหรือถูกเรียกคืน) — กลับไปเลือกล็อตใหม่` | "This lot cannot be issued (expired or recalled) — go back to select another lot" | DB trigger error toast |
| M-66 | `หมดอายุ {วว/ดด/ปปปป}` | "Expires {date}" | Lot card date line (Thai date format dd/mm/yyyy) |

### 6.7 Dashboard expiry timeline panel [S-2.7]

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-67 | `ภาพรวมวันหมดอายุ` | "Expiry overview" | Panel card title |
| M-68 | `อัปเดต: {HH:MM}` | "Updated: {time}" | Last refresh subtitle |
| M-69 | `เกินกำหนดแล้ว` | "Overdue" | Row label |
| M-70 | `ใน 30 วัน` | "Within 30 days" | Row label |
| M-71 | `30-60 วัน` | "30-60 days" | Row label |
| M-72 | `60-90 วัน` | "60-90 days" | Row label |
| M-73 | `{N} ล็อต` | "{N} lots" | Count suffix in each row |
| M-74 | `ดูล็อต →` | "View lots" | Drill-down link |
| M-75 | `∙ ปกติ (> 90 วัน): {N} ล็อต` | "Normal (>90 days): {N} lots" | Bottom summary line |
| M-76 | `ยังไม่มีข้อมูลล็อตยา` | "No medication lot data yet" | Zero-state heading |
| M-77 | `ไปที่ Inventory > ล็อตยา เพื่อเริ่มต้น` | "Go to Inventory > Medication Lots to start" | Zero-state body |
| M-78 | `✓ ทุกล็อตยาอยู่ในระดับปกติ` | "All medication lots are normal" | All-clear state |
| M-79 | `โหลดข้อมูลไม่สำเร็จ — ` | "Failed to load — " | Error state prefix |

### 6.8 Recall confirm modal [S-2.4]

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-80 | `ยืนยันการเรียกคืนล็อต` | "Confirm lot recall" | Modal title |
| M-81 | `ล็อตนี้จะถูกล็อคจากการเบิก-จ่าย` | "This lot will be locked from issue" | Warning line 1 |
| M-82 | `ทุก session ของเจ้าหน้าที่จะไม่เห็นล็อตนี้` | "All staff sessions will no longer see this lot" | Warning line 2 |
| M-83 | `เหตุผลการเรียกคืน *` | "Recall reason (required)" | Field label |
| M-84 | `ตัวอย่าง: ผู้ผลิตแจ้งเรียกคืน, พบสิ่งปนเปื้อน` | "e.g. Manufacturer recall notice, contamination found" | Placeholder in reason field |
| M-85 | `กรุณาระบุเหตุผล` | "Please enter a reason" | Validation error |
| M-86 | `ยืนยัน เรียกคืน` | "Confirm recall" | Danger button label |
| M-87 | `กำลังบันทึก…` | "Saving…" | Button loading state |
| M-88 | `เรียกคืนล็อต {lot_number} แล้ว` | "Lot {lot_number} recalled" | Success toast |
| M-89 | `เรียกคืนไม่สำเร็จ: {err}` | "Recall failed: {err}" | Error toast |

### 6.9 Force-issue override [S-2.5]

| ID | Thai copy | English gloss | Context |
|---|---|---|---|
| M-90 | `บังคับเบิก-จ่าย (หมดอายุ)` | "Force issue (expired)" | Button label |
| M-91 | `ข้ามกฎ: ล็อตนี้หมดอายุแล้ว` | "Override: this lot has expired" | Help text below button |
| M-92 | `ยืนยันขั้นที่ 1/2` | "Confirm step 1 of 2" | Step 1 modal title |
| M-93 | `ล็อตนี้หมดอายุแล้ว — แน่ใจหรือไม่?` | "This lot has expired — are you sure?" | Step 1 heading |
| M-94 | `การใช้ยาหมดอายุมีความเสี่ยงต่อผู้ป่วย` | "Using expired medication poses patient risk" | Step 1 body |
| M-95 | `ดำเนินการต่อ` | "Continue" | Step 1 secondary danger button |
| M-96 | `ยืนยันขั้นที่ 2/2` | "Confirm step 2 of 2" | Step 2 modal title |
| M-97 | `ยืนยันครั้งสุดท้าย` | "Final confirmation" | Step 2 heading |
| M-98 | `เหตุผลที่ต้องใช้ยาหมดอายุ *` | "Reason for using expired medication (required)" | Step 2 field label |
| M-99 | `การดำเนินการนี้จะถูกบันทึกในระบบ` | "This action will be logged in the system" | Step 2 audit notice |
| M-100 | `ยืนยัน — บังคับเบิกจ่าย` | "Confirm — force issue" | Step 2 danger button |

---

## 7. Accessibility Notes

### 7.1 Expiry color scale — contrast audit

The color scale in §3.1.3 must meet WCAG AA (4.5:1 for text, 3:1 for large
UI and graphical elements). All badges use both a color AND a text label, so
color is never the sole differentiator.

| Badge variant | Background hex | Text hex | Contrast ratio | WCAG AA? | Notes |
|---|---|---|---|---|---|
| `bg-danger text-white` (expired, overdue) | #dc3545 | #ffffff | 5.94:1 | Pass | Bootstrap default |
| `bg-warning text-dark` (≤30 d) | #ffc107 | #212529 | 11.2:1 | Pass | Bootstrap default |
| `bg-warning text-dark opacity-75` (≤60 d) | #ffc107 at 75% ≈ #ffd048 | #212529 | ~8.5:1 | Pass | Slight change; still strong |
| `bg-stock-accent-subtle text-stock-accent-dark` (≤90 d) | #ccfbf1 | #0f766e | 4.72:1 | Pass | `--stock-accent-subtle` + `--stock-accent-dark` tokens |
| `bg-success text-white` (>90 d) | #198754 | #ffffff | 4.55:1 | Pass (barely) | Bootstrap default — do NOT lighten |
| `bg-purple-subtle text-purple` (recalled) | #e8d5f5 | #6f42c1 | 4.63:1 | Pass | Existing tokens in `shared/styles.css` l.5-6 |
| `bg-secondary text-white` (depleted) | #6c757d | #ffffff | 4.56:1 | Pass | Bootstrap default |

**Designer note:** The 60-day band uses `opacity-75` on the badge background,
not on the whole badge element. Apply via a custom class `.badge-expiry-watch`
that sets `background-color: rgba(255,193,7,0.75)` — see §8 proposed tokens.

**Recommendation to PM:** The teal-subtle band for "≤90 days" (`bg-stock-accent-
subtle`) could be confused with the "normal" green band in poor lighting. Consider
using a slightly more saturated background or adding a distinctive icon. This
is flagged in §10 Q-D3.

### 7.2 Lot picker cards — tap target

Each lot card in the scan lot picker must be a minimum **64 px tall on mobile**
to accommodate gloved-thumb use. The `island-card` base style does not enforce
this; add `min-height: 64px` via the new `.lot-card` class (§8).

### 7.3 Third chip in scan flow

The lot chip follows the same `aria-live="polite"` pattern as the item and
location chips in Phase 1. When the lot is selected, the chip updates its
`aria-label` from `ล็อต: ยังไม่ได้เลือก` to `ล็อต: {lot_number} หมดอายุ
{expiry_date}`. A screen reader user will hear the update automatically.

### 7.4 Recall modal

- `role="dialog" aria-modal="true" aria-labelledby="recall-modal-title"` on the
  modal container.
- The reason field has `aria-required="true"`. Inline error uses `aria-live="polite"`.
- The [ยืนยัน เรียกคืน] button has `aria-busy="true"` while the PATCH is in flight.
- Focus moves to the reason input on modal open.
- Focus returns to the [เรียกคืน] button that opened the modal on close (Bootstrap
  default with `data-bs-dismiss` — verify in Phase 2 plan).

### 7.5 Dashboard expiry panel

- Each row in the expiry panel is a `<div role="button" tabindex="0">` with
  a keyboard Enter/Space handler to navigate to the lots sub-view.
- The count number uses `aria-label="{N} ล็อต {bucket_label}"` so a SR user
  hears "2 ล็อต เกินกำหนดแล้ว" rather than just "2".
- The all-clear state uses `role="status"` so it is announced on update without
  requiring the user to navigate to it.

### 7.6 Color-only information rule

All four expiry buckets (overdue / ≤30d / ≤60d / ≤90d) have text labels.
No information is communicated by color alone. This applies in:
- Lot list table badge
- Lot picker card badge
- Third chip color
- Dashboard row icon

### 7.7 Keyboard order in Inventory tab

Adding a fourth segment requires verifying Tab order:
1. Segmented control (left-to-right, Arrow keys navigate between segments)
2. Toolbar buttons (+ เพิ่มสินค้า, สแกนรับเข้า)
3. Filter bar (dropdowns, search input)
4. First lot row [เรียกคืน] / [ดูรายละเอียด]
5. Subsequent lot rows

Arrow-key navigation on the segmented control requires the `role="tablist"` +
`role="tab"` + `aria-selected` pattern (same as Phase 1 — verify in `inventory.js`).

---

## 8. New CSS Tokens Proposed

All new tokens added to the `:root` block in `shared/styles.css` (after the
existing `--stock-*` tokens at line 731).

| Token | Value | Usage |
|---|---|---|
| `--lot-expiry-overdue: #842029` | Dark red | Overdue lot text / border in dashboard panel |
| `--lot-expiry-soon: #fd7e14` | Amber/orange | ≤30d badge (distinct from Bootstrap warning yellow) |
| `--lot-expiry-watch-bg: rgba(255, 193, 7, 0.75)` | Semi-transparent yellow | ≤60d badge background |
| `--lot-picker-card-selected-border: var(--stock-accent)` | Teal | Selected lot card border in scan picker |

**New utility classes** (also in `shared/styles.css`):

```css
/* §8: Phase 2 — expiry badge variants */
.badge-expiry-soon {
  background-color: var(--lot-expiry-soon) !important;
  color: #fff !important;
}
.badge-expiry-watch {
  background-color: var(--lot-expiry-watch-bg) !important;
  color: #212529 !important;
}

/* §8: Lot picker card */
.lot-card {
  min-height: 64px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.lot-card.selected {
  border: 2px solid var(--lot-picker-card-selected-border) !important;
  background-color: var(--stock-accent-subtle) !important;
}
.lot-card.expired-lot {
  opacity: 0.5;
  pointer-events: none;
  cursor: not-allowed;
}

/* §8: Dashboard expiry panel row */
.expiry-row-overdue {
  border-left: 3px solid #dc3545;
  padding-left: 0.5rem;
}
.expiry-row-soon {
  border-left: 3px solid var(--lot-expiry-soon);
  padding-left: 0.5rem;
}
```

**Total new tokens: 4.** Total new classes: 7. No external libraries added.
Bootstrap 5 base + existing `shared/styles.css` patterns are sufficient.

---

## 9. Telegram Alert Message Format

Per spec §5.5, the daily cron posts one message per expiry bucket. The
`tg-notify` Edge Function receives a `payload.lots` array and a
`payload.bucket_days` integer. The tg-notify function (or the Cloudflare Worker
`NOTIFY_PROXY_URL` points to) formats the Thai message.

**Phase 2 spec states:** `v_msg` is built in the SQL function. Below is the
recommended expanded format for the `tg-notify` → Cloudflare Worker message
formatter (or the cron SQL if it builds the full message directly).

### 9.1 Message format per bucket

```
⏳ แจ้งเตือนวันหมดอายุ (ภายใน {bucket_days} วัน)
วันที่: {run_date_thai}  ·  มีทั้งหมด {count} รายการ

{icon} {item_name}
   SKU: {sku}
   ล็อต: {lot_number}
   หมดอายุ: {expiry_date_thai}
   คงเหลือ: {current_qty} {unit}
   (อีก {days_left} วัน)

{icon} {item_name}
   …

───────────────────────────────
💊 Thegood Stock — ระบบแจ้งเตือนยาหมดอายุ
```

**Icon mapping per bucket:**

| bucket_days | Icon |
|---|---|
| 30 (≤30d) | 🟠 |
| 60 (≤60d, >30d) | 🟡 |
| 90 (≤90d, >60d) | ⬜ (white square — neutral) |

**Thai date format:** `{day} {thai_month_name} {thai_year_be}` — e.g.
`2 มิถุนายน 2569`. The cron function receives `expiry_date` as an ISO date;
conversion to Thai Buddhist calendar format happens in the Cloudflare Worker
or in the tg-notify Edge Function. If this conversion is not already implemented
in tg-notify, the cron can pass the ISO date and the message can note
"(หมดอายุ 2026-06-02)" instead.

**One message per bucket — not per lot.** The spec explicitly calls for
grouping to avoid spam. If a bucket has more than 5 lots, the message should
show the first 5 and append `… และอีก {N-5} รายการ` to keep message length
manageable for Telegram. This is a UI/copy decision; the plan author must
implement the truncation in the cron or the Worker.

**Design note on the "zero lots in bucket" case:** The cron SQL already skips
posting if `v_bucket_lots IS NULL OR jsonb_array_length(v_bucket_lots) = 0`
(spec §5.5). No "all clear" message is sent per bucket — silence means no
upcoming lots in that window. The daily cron will only generate 1–3 messages
max depending on which buckets have lots.

---

## 10. Open UX Questions for PM

These questions are design-only. They are distinct from spec Q-Phase2-1 through
Q-Phase2-4 (which are data model / behavior decisions). These questions require
PM sign-off before the `frontend-developer` can implement without guessing.

---

### Q-D1 — Force-issue expired lot: friction level

**Question:** The design (§3.7) specifies a 2-step confirmation modal (4+
deliberate taps) to force-issue an expired lot. Is this friction level
appropriate for Thegood's clinical context, or should a phone call to a
supervisor be required instead (i.e., remove the force-issue UI entirely and
force a manual DB admin action)?

**Context:** Some hospitals require a pharmacist override signature for expired
drug use. If Thegood has such a policy, the UI override may inadvertently
create a loophole.

**Options:**

| Option | Design impact |
|---|---|
| A — Keep 2-tap UI override (current design) | Implement §3.7 as designed. Add audit log entry. |
| B — Remove UI override entirely | Remove §3.7 (S-2.5) from scope. Force-issue requires direct DB intervention by a developer. |
| C — Require supervisor code | Add a PIN / password field in step 2 (a specific admin password for the override, separate from normal login). |

**Recommendation:** Option B is safest for Phase 2. Option A is convenient but
creates an audit trail challenge. Flag for PM + clinical lead decision.

---

### Q-D2 — Lot number display format in Thai date context

**Question:** The spec stores `expiry_date` as ISO (`YYYY-MM-DD`). The UI
currently shows it as `DD/MM/YYYY` (Thai convention). Should the month be
shown as a numeric month or a Thai month name?

**Context:** Thai dates in clinical documents often use Thai month names
(มิถุนายน vs 06). Using numeric is faster to scan; Thai names are more natural
for staff.

**Options:** A — `DD/MM/YYYY` (numeric, as in Phase 1 date conventions).
B — `D เดือน YYYY` (Thai month name + Buddhist year).

**Recommendation:** Option A for table cells (space-constrained). Option B for
Telegram messages (more human-readable). PM to confirm.

---

### Q-D3 — ≤90d badge color distinctiveness

**Question:** The ≤90d "ใกล้ครบ 90 วัน" band uses `bg-stock-accent-subtle`
(teal-100, very light). In a long lot list, is this visually distinct enough
from the "ปกติ" (green, >90d) band? Staff reading a table quickly may not
notice the difference.

**Options:** A — Keep as designed (teal-subtle vs green).
B — Use Bootstrap `bg-info text-dark` for the ≤90d band (light blue,
distinctly different from green).

**Recommendation:** Option B is more legible. However, it introduces a fourth
non-stock-accent color. PM + design lead to confirm.

---

### Q-D4 — Scan lot picker: how many "other lots" to show by default

**Question:** The design (§3.4.1) shows the FEFO lot prominently, and collapses
"ล็อตอื่น" in an accordion. If there are 10+ lots for an item, should the
expanded list show all of them (scroll), or paginate, or cap at 3–5 visible?

**Context:** Too many choices create decision fatigue. FEFO should be the
norm; the override should be a conscious exception. Showing 20 lots risks
confusing the staff.

**Recommendation:** Show FEFO default + cap the "ล็อตอื่น" expanded list at
5 visible, with a "ดูเพิ่มเติม ({N} ล็อต)" link if more exist. PM to confirm
the cap number.

---

### Q-D5 — Segmented control overflow on mobile (4 segments)

**Question:** Phase 1 has 3 segments that fit on a 360 px wide screen.
Adding "ล็อตยา" as a fourth segment will overflow on narrow screens if all
four labels have the same font size.

**Options:**

| Option | Trade-off |
|---|---|
| A — Horizontal scroll on the segmented control (`overflow-x: auto`) | Standard mobile pattern; users may not discover all tabs |
| B — Abbreviate "รายการสินค้า" to "สินค้า" and "รับเข้า / ปรับสต๊อก" to "รับเข้า" | Shorter labels fit; already shortened in plan D |
| C — Use icon + tooltip labels on mobile (<576 px) | Saves space; requires new icons and tooltips |

**Recommendation:** Option B. The Phase 1 plan already uses short labels
("รายการสินค้า" and "รับเข้า"). Confirming: the four labels on mobile are
`สินค้า` / `รับเข้า` / `ล็อตยา` / `ค้นของ` — each ≤6 chars — which fits on
360 px with Bootstrap `btn-group btn-sm`. PM to confirm short-label approach.

---

## Hand-off Note for `frontend-developer`

**When to start:** After PM reviews this document and answers Q-D1 through Q-D5
above, plus after PM resolves spec Q-Phase2-1 through Q-Phase2-4.

**Files to create (new):**
- `js/inventory-lots.js` — lot list render, filter bar, recall modal, lot detail expand, force-issue modal
- `shared/lots.js` — `fetchAvailableLots(itemId)`, `renderLotPicker(lots, selectedId, onSelect)`, `expiryBadgeClass(days)`, `expiryBadgeLabel(days, status)`

**Files to extend (existing):**
- `js/inventory.js` — register 4th segment "ล็อตยา"; extend receive form with lot fields section; extend item edit modal with `tracks_lots` toggle
- `js/staff-scan.js` — insert LOT-LOADING, LOT-EMPTY, LOT-PICK states between `loc` and `qty` states; add third chip
- `js/dashboard.js` — replace Panel 3 placeholder with expiry timeline panel rendering
- `shared/styles.css` — add tokens and classes listed in §8

**Phase 1 components to reuse without change:**
- `showToast`, `showConfirm` from `shared/ui.js` (note: recall modal needs custom modal, not `showConfirm`)
- `.island-card` for lot picker cards
- `.modal .modal-dialog .modal-content` for recall + force-issue modals
- `.table.table-sm.align-middle` + `.table-responsive` for lot list
- All existing expiry-unrelated badges
- `fadeIn` animation keyframe for lot section slide-in

**Questions `frontend-developer` must NOT guess about:**
1. Force-issue DB mechanism — wait for PM Q-D1 resolution before implementing §3.7
2. Telegram message date format (Thai month name vs numeric) — wait for PM Q-D2
3. Badge color for ≤90d band — wait for PM Q-D3 (may need to swap to `bg-info`)
4. "ล็อตอื่น" cap number — wait for PM Q-D4
5. Segmented short-label names on mobile — wait for PM Q-D5 confirmation

---

*Status: DRAFT — pending PM review + Phase 2 spec Q-Phase2-1 through Q-Phase2-4 resolution*
*Design doc: `docs/superpowers/designs/2026-05-18-phase2-ui-design.md`*
*Spec source: `docs/superpowers/specs/2026-05-18-phase2-medication-design.md`*
*Phase 1 design reference: `docs/superpowers/designs/2026-05-18-phase1-ui-design.md`*
