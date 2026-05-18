# DRAFT — Phase 3 UI/UX Design: Equipment Borrow/Return + Photo Proof + Overdue Alerts

**Project:** Thegood Stock Management System
**Phase:** 3 — Equipment Borrow/Return with Photo Proof + Overdue Alerts
**Date:** 2026-05-19
**Author:** UI/UX Designer (autonomous draft)
**Status:** DRAFT — pending PM review + Phase 3 spec Q-Phase3-A through Q-Phase3-G resolution
**Source spec:** `docs/superpowers/specs/2026-05-19-phase3-borrow-return-design.md`
**Phase 2 design reference:** `docs/superpowers/designs/2026-05-18-phase2-ui-design.md`
**Next agent:** `frontend-developer`

---

## Table of Contents

- §1  Purpose, user stories, and assumed user context
- §2  Information architecture (screen list + ASCII diagram)
- §3  UI Placement — Option A (new top-level tab) vs Option B (5th segment)
- §4  Admin loan list view — "อุปกรณ์ยืม-คืน" tab content
- §5  Borrow scan flow (staff-scan.html extension)
- §6  Return scan flow
- §7  Photo capture component (reusable; Phase 5 contract)
- §8  Dashboard panel "สถานะอุปกรณ์ยืม-คืน"
- §9  Overdue Telegram message format
- §10 Microcopy table (all Thai strings)
- §11 Accessibility notes
- §12 Mobile-first checks at 360px
- §13 Open UX Questions for PM (§8 of Phase 2 convention renumbered here as §13)
- §14 Component reuse map and hand-off note

---

## 1. Purpose, User Stories, and Assumed User Context

### 1.1 Why this design exists

Phase 1/2 give Thegood an inventory system with medication lot tracking. Phase 3
adds the operational borrow lifecycle: staff can formally borrow reusable
equipment (stretchers, monitors, splints, bags), return it with photographic
proof, and the admin receives Telegram alerts when equipment is overdue.

The primary operational goal is **knowing who has what equipment and when it
is coming back.** The secondary goal is **photographic proof of condition at
borrow and return** to resolve disputes. The tertiary goal is **automated
overdue alerts so equipment does not silently disappear.**

### 1.2 User stories

**US-3-1 — Staff borrowing equipment before going on a call**
"I need to log that I am taking the portable monitor so that if I do not bring
it back by tomorrow the system alerts the admin."
Acceptance: The borrow scan flow completes in under 60 seconds with one hand.
A due_at is set and `stock_loans` is created with `status='active'`.

**US-3-2 — Staff returning equipment after a shift**
"When I return the monitor I scan it, take a photo to show it is undamaged,
and confirm. The system closes my loan."
Acceptance: Return scan flow completes in 3 steps. `stock_loans.status='returned'`.

**US-3-3 — Admin checking what is out on loan**
"I need a list of everything currently borrowed, who has it, and what is overdue,
without switching to multiple screens."
Acceptance: The loan list tab shows active and overdue loans, filterable by
status, borrower, and item. A red overdue count is visible on first glance.

**US-3-4 — Admin receiving a Telegram alert for overdue equipment**
"I get a message on Telegram at 09:00 and 17:00 if any equipment has passed
its due date."
Acceptance: Each message clearly states the item name, borrower, due date, and
days overdue.

**US-3-5 — Admin recording a return on behalf of a staff member**
"A staff member returned the monitor to the shelf but did not scan it. I need
to close their loan from the admin panel."
Acceptance: The loan list row has a "บันทึกคืน" button that opens a return modal.

### 1.3 Assumed user context (explicit)

| Assumption | Impact on design |
|---|---|
| Staff user is **on a phone, one-handed**, under time pressure (pre-dispatch, post-shift). | Borrow and return flows must require no more than 5 taps after opening the flow. All tap targets ≥44px. |
| Staff may be in a **poorly lit storeroom or ambulance bay**. | Photo capture must work in low light; no minimum photo quality enforcement. Camera permission gate is the same as Phase 1/2 scanner gate. |
| **Camera failure must not block a return.** Photo is advisory (per spec §3 + Q-Phase3-C Option A recommendation). | Skip button always visible in photo step; warning toast on skip. |
| Admin user is typically **on desktop or tablet** for the loan list view; phone for dashboard glance. | Loan list table uses `table-responsive`. Desktop shows all columns; mobile collapses secondary columns. |
| **Due_at presets are the primary path;** exact date picker is secondary. | Quick preset buttons (large) are the first interaction; "กำหนดเอง" reveals a date picker. |
| Users read **Thai only** for operational copy. English in parens only for technical identifiers (SKU, loan_id prefix). | All copy Thai first. |
| App is **online-only**. Photo upload requires network. | If Cloudinary upload fails, advisory toast only; movement still commits. |
| Phase 5 (oxygen) will need the **same photo capture component** with a different folder parameter. | Photo capture designed as a standalone modal component with explicit props contract in §7. |

---

## 2. Information Architecture

### 2.1 Screen list (Phase 3 new/extended)

| Screen ID | Surface | Screen name | Phase 3 status |
|---|---|---|---|
| S-3.1 | `admin.html` new tab OR Inventory sub-view | "อุปกรณ์ยืม-คืน" — loan list + filter | NEW |
| S-3.2 | `admin.html` same tab | Admin detail drawer (loan detail + photos + history) | NEW |
| S-3.3 | `admin.html` same tab | Admin return modal ("บันทึกคืน" on behalf of staff) | NEW |
| S-3.4 | `admin.html` Dashboard tab | "สถานะอุปกรณ์ยืม-คืน" panel | REPLACES Phase 1 placeholder |
| S-3.5 | `staff.html` | New "ยืมอุปกรณ์" + "คืนอุปกรณ์" buttons | EXTENSION |
| S-3.6 | `staff-scan.html` OR new `staff-borrow.html` | Borrow scan flow (5 steps) | NEW |
| S-3.7 | `staff-scan.html` OR new `staff-borrow.html` | Return scan flow (3 steps) | NEW |
| S-3.8 | shared modal component | Photo capture modal (borrow photo + return photo) | NEW — reused Phase 5 |

### 2.2 Architecture diagram (ASCII)

```
admin.html
└── nav-pills (Phase 0/1/2: Dashboard | Locations | Inventory | Ambulances | Settings | Sessions)
    │             Phase 3 Option A adds: [อุปกรณ์ยืม-คืน] as 7th tab
    │             Phase 3 Option B: no new top-level tab; 5th segment inside Inventory
    │
    ├── #tab-dashboard (js/dashboard.js — EXTENDED Phase 3)
    │     └── Panel: สถานะอุปกรณ์ยืม-คืน [S-3.4] ← replaces Phase 1 placeholder
    │           3 rows: กำลังยืม / เกินกำหนด / คืนวันนี้
    │           tap row → navigates to loan list tab (pre-filtered)
    │
    └── #tab-loans (Option A) OR Inventory sub-view D (Option B) [S-3.1]
          ├── Filter bar: สถานะ | ผู้ยืม | ค้นสินค้า | เฉพาะเลยกำหนด toggle
          ├── Loan list table (table-responsive)
          │     Columns: สินค้า | ผู้ยืม | ตำแหน่งเดิม | จำนวน | ยืมเมื่อ | ครบกำหนด | สถานะ | จัดการ
          │     Row click → Loan detail drawer [S-3.2]
          │                   shows: borrow photo + return photo (if returned)
          │                          movement history
          │                   admin action: [บันทึกคืน] [ดูรูปถ่าย]
          └── Admin return modal [S-3.3]
                opened from [บันทึกคืน] in row or detail drawer
                fields: photo capture (optional) + confirm button


staff.html
└── card extends Phase 1 with 2 new buttons:
      [ยืมอุปกรณ์] → staff borrow flow [S-3.6]
      [คืนอุปกรณ์] → staff return flow [S-3.7]


staff-scan.html (extended) OR staff-borrow.html (new page — see §5)
└── MODE selector at top: [เบิก-จ่าย] [ยืม-คืน]  ← Phase 3 adds this toggle
      ├── Mode: เบิก-จ่าย → existing Phase 1/2 flow (unchanged)
      └── Mode: ยืม-คืน
            ├── Sub-mode: ยืม → 5-step borrow flow [S-3.6]
            └── Sub-mode: คืน → 3-step return flow [S-3.7]


shared modal component: PhotoCaptureModal [S-3.8]
└── props: folder (string), entityId (string), label (string), optional (bool)
    events: uploaded(url), skipped, error(msg)
    reused by: Phase 3 borrow, Phase 3 return, Phase 5 oxygen
```

---

## 3. UI Placement — Option A vs Option B

### 3.1 Option A — New Top-Level Tab "อุปกรณ์ยืม-คืน" (RECOMMENDED)

#### 3.1.1 Wireframe @ 360px — admin.html nav with new tab

```
┌─────────────────────────────────────────────────────┐
│ 🏥 Thegood Stock — Admin        👤 admin  [ออก]     │
├─────────────────────────────────────────────────────┤
│ [Dashboard] [Inventory] [Locations] [ยืม-คืน*] …    │
│ ← overflow-x: auto; 7 tabs total; active tab teal → │
│                                                     │
│ ┌── สถานะอุปกรณ์ยืม-คืน ──────────────────────────┐│
│ │  กำลังยืม         เลยกำหนด      คืนวันนี้        ││
│ │  [  3  ]teal    [  1  ]red    [  2  ]gray        ││
│ └─────────────────────────────────────────────────┘│
│                                                     │
│ ── ตัวกรอง ─────────────────────────────────────── │
│ ┌─────────────────────────────────────────────────┐│
│ │ สถานะ: กำลังยืม+เลยกำหนด ▾                      ││
│ └─────────────────────────────────────────────────┘│
│ ┌─────────────────────────────────────────────────┐│
│ │ 🔍 ค้นชื่อสินค้า / ผู้ยืม                        ││
│ └─────────────────────────────────────────────────┘│
│ [เฉพาะเลยกำหนด ☐]                                  │
│                                                     │
│ ── รายการยืม ────────────────────────────────────── │
│ ┌─────────────────────────────────────────────────┐│
│ │ เปลหาม · ROOM-A         admin        [กำลังยืม] ││
│ │ ครบ 22 พ.ค. 69         2 ชิ้น        [จัดการ ▾] ││
│ ├─────────────────────────────────────────────────┤│
│ │ ออกซิเจนมิเตอร์ · ROOM-B  staff01    [เลยกำหนด] ││  ← red badge
│ │ ครบ 18 พ.ค. 69 (เลย 1 วัน) 1 ชิ้น  [จัดการ ▾] ││
│ └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

**Tap targets (Option A):**
- Tab button: full nav pill, min-height 40px (same as existing nav-pills) — matches current admin.html pattern
- Filter dropdowns: min-height 44px (Bootstrap `form-select` default)
- [จัดการ ▾] button: min-width 80px, min-height 44px
- Row tap area: full row, min-height 56px

#### 3.1.2 Wireframe @ 768px+ — tablet/desktop

```
┌─────────────────────────────────────────────────────────────────────────┐
│ navbar                                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory][Ambulances][Settings][Sessions][ยืม-คืน*]│
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│ ┌── counts row ───────────────────────────────────────────────────────┐  │
│ │  กำลังยืม [3]  เลยกำหนด [1]red  คืนวันนี้ [2]gray                   │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│ [สถานะ: ทั้งหมด ▾]  [ผู้ยืม: ทั้งหมด ▾]  [🔍 ค้นสินค้า]  [เฉพาะเลยกำหนด ☐]│
│                                                                           │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ สินค้า (SKU)       ผู้ยืม   ตำแหน่งเดิม  จำนวน  ยืมเมื่อ  ครบกำหนด  สถานะ  จัดการ│ │
│ ├──────────────────────────────────────────────────────────────────────┤ │
│ │ เปลหาม (STRCH-001) admin   ROOM-A         2    19/05/69  22/05/69 [กำลังยืม]  [↗][คืน]│
│ ├──────────────────────────────────────────────────────────────────────┤ │
│ │ ออกซิเจนมิเตอร์ (OXY-01) staff01 ROOM-B  1    18/05/69  18/05/69 [เลยกำหนด] [↗][คืน]│
│ └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 Option B — 5th Segment inside Inventory Tab

#### 3.2.1 Wireframe @ 360px — Inventory tab with 5 segments

```
┌─────────────────────────────────────────────────────┐
│ navbar (unchanged)                                  │
├─────────────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory*][Ambulances]…     │
├─────────────────────────────────────────────────────┤
│ ┌── segmented control (5 tabs, overflow-x: auto) ─┐ │
│ │ รายการสินค้า │ รับเข้า │ ล็อตยา │ ค้นของ │ยืม-คืน*│ │
│ └──────────────────────────────────────────────────┘ │
│                                                     │
│  (same loan list content as Option A below filter) │
│  …                                                  │
└─────────────────────────────────────────────────────┘
```

**Tap targets (Option B):**
- Segment tabs: 5 tabs in ~360px = ~72px each — MARGINAL. Text "รายการสินค้า" is 7 chars; will be clipped on smaller screens. Phase 2 already noted overflow risk for 4 segments.
- Minimum tap target per segment: 44px height (existing Phase 2 design) — height OK, but **width shrinks below 44px for 5 segments at 360px without overflow-x scroll**.

#### 3.2.2 Option B usability note (design dissent flag)

With 5 segments at 360px and Thai text labels, each segment button shrinks to approximately 64px wide — technically above the 44px minimum, but the FEFO-critical "ล็อตยา" label in segment 3 and "ยืม-คืน" in segment 5 will render as single-line truncated text at sub-44px width on narrower handsets (320px, some Realme/Oppo devices). Phase 2 already applied `overflow-x: auto` as mitigation; a 5th segment means the last 2 segments are off-screen at first paint on 360px. Users will not discover "ยืม-คืน" unless they know to swipe.

**Nielsen Heuristic #6 (Recognition over recall):** If the loan management tab is off-screen by default, staff will not know it exists without training. This is a discoverability failure for a workflow that is operationally important.

---

### 3.3 Recommendation — §11 Q-Phase3-A

**Recommendation: Option A (new top-level tab "อุปกรณ์ยืม-คืน").**

Rationale:
1. Borrow/return is a distinct workflow orthogonal to the medication lot view. A nurse checking overdue loans should not have to navigate into "Inventory" first.
2. The Phase 1 placeholder on the dashboard already points to this as a separate concept ("สถานะอุปกรณ์ยืม-คืน" — distinct from inventory).
3. Option B creates a discoverability failure at 360px (see §3.2.2).
4. Adding a 7th top-nav pill is safe: `admin.html` already uses `flex-wrap gap-1` on the nav — the new tab wraps to a second line on very small screens without breaking layout. An icon-only fallback (`bi-arrow-left-right`) can render at <400px if PM requests icon-only nav.
5. The loan list is wide enough (8 columns) to deserve its own full-width page rather than sharing with the inventory toolbar and segment controls.

**Constraint on Option A:** The tab label must be concise. Recommended label: "ยืม-คืน" (7 chars) with icon `bi-arrow-left-right`. On very small screens, icon-only is acceptable.

---

## 4. Admin Loan List View [S-3.1]

### 4.1 Tab content overview

Location: `#tab-loans` (Option A) or 5th segment (Option B). Rendered by `js/loans.js`.
Source: SELECT from `stock_loans LEFT JOIN stock_items LEFT JOIN locations` with filters.

### 4.2 Summary panel (counts strip)

```
┌─────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────────────────────────────┐│
│ │  กำลังยืม     เลยกำหนด      คืนวันนี้                 ││
│ │  ┌───────┐  ┌───────┐     ┌───────┐                  ││
│ │  │   3   │  │   1   │     │   2   │                  ││
│ │  └───────┘  └───────┘     └───────┘                  ││
│ │  teal badge  red badge    gray badge                  ││
│ └──────────────────────────────────────────────────────┘│
│  (tap any count → filters loan list to that status)     │
└─────────────────────────────────────────────────────────┘
```

- Source: Realtime subscription on `stock_loans` channel (same pattern as Phase 2 dashboard).
- Tap "กำลังยืม" → sets filter to `status=active`.
- Tap "เลยกำหนด" → sets filter to `status=overdue`.
- Tap "คืนวันนี้" → sets filter to `returned_at::date = today`.

### 4.3 Filter bar

```
@ 360px:
┌──────────────────────────────────────────────────────┐
│ [สถานะ ▾] — select: ทั้งหมด / กำลังยืม / เลยกำหนด / คืนแล้ว │
│ [🔍 ค้นชื่อสินค้า / ผู้ยืม           ]                │  ← live filter
│ ☐ เฉพาะเลยกำหนด  (toggle quick-filter)                │
└──────────────────────────────────────────────────────┘
```

**สถานะ options:**

| Value | Label |
|---|---|
| `all` | ทั้งหมด (default) |
| `active` | กำลังยืม |
| `overdue` | เลยกำหนด |
| `returned` | คืนแล้ว |

### 4.4 Loan list table

#### 4.4.1 Mobile rows (< 576px) — stacked card style

Each row renders as a mini-card with two lines:
```
┌─────────────────────────────────────────────────────────┐
│ เปลหาม · SUP-STRCH-001 · ROOM-A          [กำลังยืม]     │
│ ผู้ยืม: admin · 2 ชิ้น · ครบ 22 พ.ค. 69  [จัดการ ▾]   │
└─────────────────────────────────────────────────────────┘
```
- Row min-height: 64px (≥44px tap target with padding).
- [จัดการ ▾] opens a dropdown: [ดูรายละเอียด] [บันทึกคืน] (admin only).

#### 4.4.2 Desktop rows (≥768px) — table layout

| Column | Width | Notes |
|---|---|---|
| สินค้า (ชื่อ + SKU) | 22% | two-line cell; line 1 = ชื่อ, line 2 = SKU text-muted small |
| ผู้ยืม | 12% | text |
| ตำแหน่งเดิม | 10% | location code |
| จำนวน | 6% | right-aligned |
| ยืมเมื่อ | 10% | date DD/MM/YY |
| ครบกำหนด | 12% | date + days-remaining or days-overdue (e.g., "เหลือ 3 วัน" in gray; "เลย 1 วัน" in red) |
| สถานะ | 10% | badge (see §4.5) |
| จัดการ | 14% | [↗ ดู] [คืน] buttons |

#### 4.4.3 Interaction states

| State | Appearance |
|---|---|
| Loading | Skeleton rows: 3 gray shimmer rows, no content |
| Empty (no loans match filter) | Empty state card (see §4.6) |
| Error (network fail) | `alert alert-danger` with [รีเฟรช] button; copy: "โหลดรายการยืมไม่สำเร็จ — กดรีเฟรช" |
| Overdue row highlight | `table-danger` row background (`#f8d7da`) — same Bootstrap utility as Phase 2 expired lot rows |
| Realtime update (new loan arrives) | New row slides in with `fadeIn` animation (existing keyframe in `shared/styles.css`) |

### 4.5 Status badges

| Status | Badge class | Label | Notes |
|---|---|---|---|
| `active` | `bg-stock-accent-subtle text-stock-accent-dark` | กำลังยืม | Teal — reuses existing `--stock-accent-subtle` token |
| `overdue` | `bg-danger text-white` | เลยกำหนด | Red — same as Phase 2 `bg-danger` |
| `returned` | `bg-secondary text-white` | คืนแล้ว | Gray — same as Phase 2 depleted badge |

**Accessibility note:** Each badge includes both color AND text label. Never rely on color alone. The `เลยกำหนด` badge also shows days overdue in the "ครบกำหนด" column: "เลย N วัน" in red text — redundant channel for color-blind users.

### 4.6 Empty state

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│         (icon: bi-arrow-left-right, 2.5rem)          │
│                                                      │
│    ไม่มีรายการยืม                                     │
│                                                      │
│    เมื่อมีการยืมอุปกรณ์ รายการจะแสดงที่นี่            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

Empty state after filter: "ไม่พบรายการที่ตรงกับตัวกรอง" + [ล้างตัวกรอง]

### 4.7 Loan detail drawer [S-3.2]

Opens as a Bootstrap offcanvas (end / right) on row click. Full height on mobile.

```
┌── ออฟแคนวาส: รายละเอียดการยืม ──────────────────────┐
│ ✕  รายละเอียดการยืม                   [บันทึกคืน] │  ← admin only
├──────────────────────────────────────────────────────┤
│ สินค้า: เปลหาม (SUP-STRCH-001)                      │
│ ผู้ยืม: admin                                         │
│ ตำแหน่งเดิม: ROOM-A                                   │
│ จำนวน: 2 ชิ้น                                        │
│ ยืมเมื่อ: 19 พ.ค. 2569 14:30                         │
│ ครบกำหนด: 22 พ.ค. 2569                               │
│ สถานะ: [กำลังยืม]                                    │
│ หมายเหตุ: ใช้สำหรับรับผู้ป่วย                        │
├──────────────────────────────────────────────────────┤
│ รูปถ่ายก่อนยืม:                                       │
│ ┌──────────────────────────────────────────────────┐ │
│ │  [thumbnail 120×90]  หรือ  (ไม่มีรูปถ่าย)         │ │  ← tap → open Cloudinary URL
│ └──────────────────────────────────────────────────┘ │
│ รูปถ่ายเมื่อคืน: (ยังไม่คืน)                          │
├──────────────────────────────────────────────────────┤
│ ประวัติการเคลื่อนไหว:                                 │
│ 19 พ.ค. 69 14:30 — ยืม — admin — ROOM-A              │
└──────────────────────────────────────────────────────┘
```

**Interaction states:**
- Default: drawer closed.
- Loading: spinner centered in drawer body.
- Photo thumbnail: 120×90px, `object-fit: cover`, border-radius 8px. Tap opens `window.open(cloudinaryUrl)`.
- No photo: gray placeholder area with text "ไม่มีรูปถ่าย" and icon `bi-image`.

### 4.8 Admin return modal [S-3.3]

Opens from [บันทึกคืน] in the drawer or table row dropdown.

```
┌── modal: บันทึกคืนอุปกรณ์ ──────────────────────────┐
│ ✕  บันทึกคืนอุปกรณ์                                  │
├──────────────────────────────────────────────────────┤
│ สินค้า: เปลหาม (2 ชิ้น)                              │
│ ผู้ยืม: admin · ยืมตั้งแต่: 19 พ.ค. 69               │
│ ครบกำหนด: 22 พ.ค. 69                [กำลังยืม]       │
├──────────────────────────────────────────────────────┤
│ รูปถ่ายเมื่อคืน (ไม่บังคับ):                          │
│ [📷 ถ่ายรูปหรืออัปโหลด]                               │  ← PhotoCaptureModal trigger
│                                                      │
│ หมายเหตุ (ไม่บังคับ):                                │
│ [_______________________________________]             │
│                                                      │
│ [ยืนยันการคืน]                    [ยกเลิก]           │
└──────────────────────────────────────────────────────┘
```

---

## 5. Borrow Scan Flow [S-3.6]

### 5.1 Entry point design — two options

**Option 5A: Mode toggle at top of `staff-scan.html`**
**Option 5B: New dedicated page `staff-borrow.html`**

#### Option 5A — Mode toggle at top of staff-scan.html

```
┌─────────────────────────────────────────────────────┐
│ ← Thegood Stock                    👤 …  [ออก]      │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────┐ │
│ │  [เบิก-จ่าย]        [ยืม-คืน]                  │ │  ← mode toggle, min-height 48px
│ └─────────────────────────────────────────────────┘ │
│  (mode=ยืม-คืน selected → shows sub-mode row below) │
│ ┌─────────────────────────────────────────────────┐ │
│ │  [ยืมอุปกรณ์]        [คืนอุปกรณ์]               │ │  ← sub-mode toggle, min-height 48px
│ └─────────────────────────────────────────────────┘ │
│  … (step content below)                             │
└─────────────────────────────────────────────────────┘
```

**Option 5A pros:** Same URL, mental model continuity with Phase 1/2 staff scan.
**Option 5A cons:** Adds two toggle rows before the camera; clutters the first-paint experience for the existing Phase 1 flow which is the most common action.

#### Option 5B — Dedicated staff-borrow.html page

```
staff.html card:
┌─────────────────────────────────────────────────────┐
│ เริ่มต้น Phase 1 — สแกนเบิก-จ่าย                    │
│ [📷 สแกนเบิก-จ่าย]                   (existing)     │
│ ─────────────────────────────────                   │
│ Phase 3 — ยืม-คืนอุปกรณ์                            │
│ [↗ ยืมอุปกรณ์]          [↩ คืนอุปกรณ์]             │  ← new row
└─────────────────────────────────────────────────────┘
```

**Option 5B pros:** The default staff-scan flow is not cluttered. Borrow/return is a distinct operational flow — separate URL is cleaner for back-button behavior and makes it trivially bookmarkable.
**Option 5B cons:** Two additional HTML files to maintain; slightly more code.

**Recommendation: Option 5A (mode toggle)** for Phase 3. Rationale: maintains a single scan page URL (consistent with how Phase 2 lot picker was added as a step rather than a new page). The toggle row is positioned above the camera — staff who never borrow will quickly learn to ignore it. If the toggle proves cognitively expensive in user testing, migration to 5B is a rename and redirect.

**CONTRADICTION FLAG for PM:** The spec §4 repository structure lists `js/staff-borrow.js` as a new file (suggesting Option 5B), but the spec §7.3 says "Triggered by 'ยืมอุปกรณ์' button on `staff.html`" — which could feed either option. The spec does not specify which HTML file hosts the borrow flow. PM should confirm before `frontend-developer` begins. This design documents both; the JS module `staff-borrow.js` can be loaded by either `staff-scan.html` or `staff-borrow.html`.

### 5.2 Borrow flow — step indicator + screens

The step indicator reuses the existing `.step-indicator` / `.step-item` component from `shared/styles.css` (lines 329–385). For the borrow flow, 5 steps displayed with step labels hidden at <400px (existing CSS rule).

**Step indicator @ 360px:**
```
┌─────────────────────────────────────────────────────┐
│ ①สินค้า  ②ตำแหน่ง  ③กำหนดคืน  ④รูปถ่าย  ⑤ยืนยัน   │
│ (step labels hidden at <400px; numbers only)        │
└─────────────────────────────────────────────────────┘
```

---

#### Step 1 — สแกนสินค้า (Scan item)

Reuses Phase 1 camera stage + viewfinder + manual fallback. No changes to the camera component.

On successful scan:
```
┌─────────────────────────────────────────────────────┐
│ [สินค้า: เปลหาม (SUP-STRCH-001)]  [done]           │  ← chip, .scan-chip.done
│ [ตำแหน่ง: —]                                        │  ← pending chip
│                                                     │
│  ─── สินค้าที่พบ ────────────────────────────────── │
│  เปลหาม (Stretcher)                                 │
│  SKU: SUP-STRCH-001                                  │
│  คงเหลือรวม: 5 ชิ้น                                  │
│  [ถัดไป: สแกนตำแหน่ง →]                             │  ← btn-stock-primary, 52px height
└─────────────────────────────────────────────────────┘
```

**Error state — ของไม่เหลือ:**
```
│ ⚠ ของไม่เหลือในคลัง — ไม่สามารถยืมได้              │  ← alert-warning
│ คงเหลือทั้งหมด: 0 ชิ้น                               │
│ [สแกนสินค้าอื่น]                                    │
```

---

#### Step 2 — สแกนตำแหน่ง (Scan source location)

Same camera stage as Step 1. On match:
```
┌─────────────────────────────────────────────────────┐
│ [สินค้า: เปลหาม]  [done]                           │
│ [ตำแหน่ง: ROOM-A]  [done]                           │
│                                                     │
│  ตำแหน่ง ROOM-A                                     │
│  คงเหลือที่นี่: 3 ชิ้น                               │
│  [ถัดไป: กำหนดวันคืน →]                             │
└─────────────────────────────────────────────────────┘
```

**Error state — qty 0 at scanned location:**
```
│ ⚠ ไม่มีของที่ตำแหน่งนี้                             │
│ ตำแหน่งที่มีของ:                                     │
│   ROOM-B — 2 ชิ้น                                   │  ← Item Finder result
│   CORRIDOR-1 — 1 ชิ้น                               │
│ [สแกนตำแหน่งอื่น]                                    │
```

---

#### Step 3 — กำหนดวันคืน + จำนวน (Due date + qty)

```
┌─────────────────────────────────────────────────────┐
│  ── กำหนดวันคืน ──────────────────────────────────  │
│                                                     │
│  จำนวน *                                            │
│  ┌───────────────────────────────────────────────┐  │
│  │ [−]   [1]   [+]       (max: 3 ตามที่มี)      │  │  ← stepper, each btn 44px×44px
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  กำหนดคืน *                                         │
│  ┌─────────────────────────────────────────────────┐ │
│  │ [1 วัน]   [3 วัน]   [7 วัน]   [กำหนดเอง]      │ │  ← preset row, 48px height each
│  └─────────────────────────────────────────────────┘ │
│                                                     │
│  (if กำหนดเอง selected, date picker appears below)  │
│  ┌─────────────────────────────────────────────────┐ │
│  │ วันที่คืน:  [  วว/ดด/ปปปป  📅 ]               │ │  ← min = tomorrow
│  └─────────────────────────────────────────────────┘ │
│                                                     │
│  กำหนดคืน: วันที่ 22 พ.ค. 2569 (3 วัน)              │  ← computed preview
│                                                     │
│  หมายเหตุ (ไม่บังคับ)                                │
│  [_______________________________________________]   │
│                                                     │
│  [ถัดไป: ถ่ายรูป →]                                  │
└─────────────────────────────────────────────────────┘
```

**Due_at preset buttons — visual specification:**

```css
/* Quick preset row — reuse existing scan-chip style but as buttons */
/* Each button: flex 1; min-height 48px; border-radius 8px; text-center */
/* Default: bg-light border; Selected: bg-stock-accent-subtle border-stock-accent text-stock-accent-dark fw-600 */
```

**Preset default:** TBD pending Q-Phase3-G (PM decision). Design shows 3 days as pre-selected until PM decides. Annotate in code with comment `/* Q-Phase3-G default — PM to confirm */`.

**Open question note:** Q-Phase3-G asks which duration to default. This design pre-selects "3 วัน" as a reasonable middle ground for clinical equipment borrowing. See §13 for PM question.

---

#### Step 4 — ถ่ายรูปก่อนยืม (Borrow photo — optional)

Uses the shared `PhotoCaptureModal` component (§7). Inline (not modal) on this step for a smoother step-flow on mobile.

```
┌─────────────────────────────────────────────────────┐
│  ── ถ่ายรูปอุปกรณ์ก่อนยืม ─────────────────────────│
│                                                     │
│  (if no photo yet — camera trigger state)           │
│  ┌─────────────────────────────────────────────────┐ │
│  │                                                 │ │
│  │   [📷 bi-camera icon, 3rem]                     │ │
│  │                                                 │ │
│  │  [📷 เปิดกล้องถ่ายรูป]  [📁 เลือกรูปจากคลัง]  │ │  ← both ≥44px tap target
│  │                                                 │ │
│  └─────────────────────────────────────────────────┘ │
│                                                     │
│  (if photo captured — thumbnail state)              │
│  ┌─────────────────────────────────────────────────┐ │
│  │  [thumbnail 120×90, rounded-2]  [ถ่ายใหม่]    │ │
│  └─────────────────────────────────────────────────┘ │
│  อัปโหลดรูปถ่าย… [████░░░░░░] 60%                   │  ← progress (hidden after upload)
│                                                     │
│  [ถัดไป: ยืนยัน →]            [ข้าม — ไม่มีรูป]     │
│  (primary: btn-stock-primary)  (secondary: btn-link) │
└─────────────────────────────────────────────────────┘
```

---

#### Step 5 — ยืนยันการยืม (Confirm borrow)

```
┌─────────────────────────────────────────────────────┐
│  ── สรุปการยืม ─────────────────────────────────── │
│                                                     │
│  สินค้า:   เปลหาม (SUP-STRCH-001)                   │
│  ตำแหน่ง:  ROOM-A                                    │
│  จำนวน:    1 ชิ้น                                   │
│  ครบกำหนด: 22 พ.ค. 2569 (3 วัน)                     │
│  รูปถ่าย:  [thumbnail] หรือ ไม่มีรูป                │
│  หมายเหตุ: ใช้สำหรับรับผู้ป่วย                     │
│                                                     │
│  [ยืนยันการยืม]                                     │  ← btn-stock-primary, 52px
│  [← แก้ไข]                                          │  ← btn-outline-secondary
│                                                     │
│  (loading state: spinner + "กำลังบันทึก…" text,      │
│   button disabled)                                  │
└─────────────────────────────────────────────────────┘
```

**Success toast:**
```
"ยืมสำเร็จ — กำหนดคืน 22 พ.ค. 2569"
```
(Uses `shared/ui.js` toast helper. Auto-dismiss after 4s. Green background — same as Phase 1 success toast.)

**Success state — then auto-return to Step 1 ready state (borrow mode) after 1.5s.**

---

### 5.3 Interaction state summary for borrow flow

| Step | Loading | Error | Empty |
|---|---|---|---|
| 1 Scan item | camera init spinner | "สแกนไม่สำเร็จ — ลองใหม่" toast | N/A |
| 1 Item not found | N/A | "ไม่พบสินค้า — ลองใหม่" inside camera stage | N/A |
| 1 Qty = 0 | N/A | "ของไม่เหลือในคลัง — ไม่สามารถยืมได้" | N/A |
| 2 Location not found | N/A | "ไม่พบตำแหน่ง — ลองใหม่" | N/A |
| 2 Location qty = 0 | N/A | Shows nearby locations with qty > 0 | "ไม่มีตำแหน่งที่มีของ" |
| 3 Qty input | N/A | "จำนวนเกินที่มี" inline below input | N/A |
| 4 Photo upload | Progress bar | "อัปโหลดรูปไม่สำเร็จ — ยังดำเนินการได้" warning toast | N/A |
| 5 Submit | Spinner + disabled btn | "บันทึกไม่สำเร็จ: {err}" toast + can retry | N/A |
| 5 Duplicate scan (409) | N/A | Treat as success: "ยืมสำเร็จแล้ว" | N/A |
| 5 Qty negative (Phase 1 trigger) | N/A | "ของไม่พอ — ไม่สามารถยืมได้" toast | N/A |

---

## 6. Return Scan Flow [S-3.7]

Entry: "คืนอุปกรณ์" sub-mode toggle (Option 5A) or button on `staff.html`.

**Step indicator:**
```
①สแกนสินค้า  ②รูปถ่าย  ③ยืนยันคืน
```

---

#### Step 1 — สแกนสินค้า + แสดงรายละเอียดยืม

On successful scan, system queries open loans for `borrower_username = current_user` and `item_id`.

**State A — loan found (normal case):**
```
┌─────────────────────────────────────────────────────┐
│ [สินค้า: เปลหาม]  [done]                           │
│                                                     │
│  ── รายการที่ยืมอยู่ ────────────────────────────── │
│  ┌─────────────────────────────────────────────────┐ │
│  │ เปลหาม (SUP-STRCH-001)                          │ │
│  │ จำนวน: 1 ชิ้น   ตำแหน่งเดิม: ROOM-A            │ │
│  │ ยืมเมื่อ: 19 พ.ค. 69                            │ │
│  │ ครบกำหนด: 22 พ.ค. 69   [กำลังยืม]              │ │
│  └─────────────────────────────────────────────────┘ │
│  [ถัดไป: ถ่ายรูป →]                                  │
└─────────────────────────────────────────────────────┘
```

**State B — loan overdue:**
```
│  ┌── ⚠ เลยกำหนด ──────────────────────────────────┐ │  ← alert-danger border
│  │ เปลหาม · ครบกำหนด 18 พ.ค. 69  [เลยกำหนด]       │ │
│  │ เลย 1 วัน — กรุณาคืนโดยเร็ว                    │ │
│  └─────────────────────────────────────────────────┘ │
│  (step proceeds normally — overdue badge is         │
│   informational only; does not block return)         │
```

**State C — no open loan found (error):**
```
│  ⚠ ไม่พบรายการยืมที่เปิดอยู่                        │  ← alert-warning
│  ไม่มีรายการยืมที่ยังค้างอยู่สำหรับสินค้านี้         │
│  ถ้ายืมโดยผู้ใช้อื่น โปรดแจ้ง Admin                │
│  [สแกนสินค้าอื่น]                                    │
```

**State D — multiple open loans for same item (edge case):**
```
│  พบรายการยืมหลายรายการ — เลือกรายการที่ต้องการคืน:   │
│  ┌──────────────────────────────────────────────────┐│
│  │ ○ ยืมเมื่อ 19 พ.ค. 69 · 1 ชิ้น · ครบ 22 พ.ค.  ││  ← radio list
│  │ ○ ยืมเมื่อ 17 พ.ค. 69 · 2 ชิ้น · ครบ 20 พ.ค.  ││
│  └──────────────────────────────────────────────────┘│
│  [ถัดไป →]                                           │
```

---

#### Step 2 — ถ่ายรูปเมื่อคืน (Return photo — optional)

Same layout as Step 4 of borrow flow. Both photo options (camera + file upload) visible.

**Option A — advisory photo (spec recommendation):**
```
│  [📷 ถ่ายรูปอุปกรณ์เมื่อคืน]                        │
│  [📁 เลือกรูปจากคลัง]                                │
│  [ถัดไป →]                     [ข้าม — ไม่มีรูป]    │
```

**Option B — required photo at borrow (not recommended; design only):**
```
│  ★ จำเป็นต้องมีรูปถ่าย                               │  ← shown only if Q-Phase3-C = Option B
│  [📷 ถ่ายรูปอุปกรณ์ก่อนยืม]                          │
│  [📁 เลือกรูปจากคลัง]                                │
│  [ถัดไป →]   (skip button NOT shown in Option B)     │
```

Design presents Option A. If PM chooses Option B, remove the skip button on the BORROW step only (return remains advisory per spec §7.4).

---

#### Step 3 — ยืนยันคืน (Confirm return)

```
┌─────────────────────────────────────────────────────┐
│  ── สรุปการคืน ─────────────────────────────────── │
│                                                     │
│  สินค้า:     เปลหาม (SUP-STRCH-001)                 │
│  จำนวน:      1 ชิ้น                                 │
│  ยืมเมื่อ:   19 พ.ค. 2569                            │
│  ครบกำหนด:   22 พ.ค. 2569                            │
│  สถานะ:      [กำลังยืม]                              │
│  รูปถ่าย:    [thumbnail] หรือ ไม่มีรูป              │
│                                                     │
│  [ยืนยันการคืน]                                     │  ← btn-stock-primary, 52px
│  [← แก้ไข]                                          │
└─────────────────────────────────────────────────────┘
```

**Success toast:** "คืนสำเร็จ ขอบคุณ"
(4s, green, auto-dismiss. Auto-return to return Step 1 ready state after 1.5s.)

**Error — loan already closed (trigger error):**
```
toast: "ไม่พบรายการยืมที่เปิดอยู่"
```
This matches the exact Thai trigger error string from spec §5.2.2: `'ไม่พบรายการยืมที่เปิดอยู่ สำหรับ % รายการ %'`. The FE trims the PostgreSQL interpolation placeholders and shows only the first phrase.

---

## 7. Photo Capture Component — Reusable Contract for Phase 5 [S-3.8]

### 7.1 Component overview

`PhotoCaptureModal` is a shared modal component designed once in Phase 3 and reused by Phase 5 (oxygen tank photo proof). It handles:
- Camera preview (via `<video>` + `getUserMedia`)
- File upload fallback (`<input type="file" accept="image/*" capture="environment">`)
- Thumbnail preview
- Cloudinary upload via `window.uploadToCloudinary` (`shared/cloudinary.js`)
- Upload progress indication
- Optional skip

### 7.2 Component contract (props + events)

**File location (to be created):** `shared/photo-capture.js`
**HTML usage:** triggered by calling `PhotoCaptureModal.open(config)`.

```
PhotoCaptureModal.open({
  // REQUIRED
  folder:     string,   // Cloudinary subfolder path; NO trailing slash
                        //   Phase 3 borrow:  'thegood-stock/borrow/{client_ref_id}/borrow'
                        //   Phase 3 return:  'thegood-stock/borrow/{client_ref_id}/return'
                        //   Phase 5 oxygen:  'thegood-stock/oxygen/{tank_serial}/fill'
  label:      string,   // Modal header + camera hint text (Thai string from caller)
                        //   e.g. 'ถ่ายรูปอุปกรณ์ก่อนยืม' or 'ถ่ายรูปถังออกซิเจน'

  // OPTIONAL
  optional:   boolean,  // default: true. If false, skip button is hidden.
  entityId:   string,   // used as public_id suffix in Cloudinary (e.g. client_ref_id)
                        //   If omitted, UUID generated client-side.
  maxSizeMB:  number,   // default: 5. Client-side warning if file exceeds.

  // CALLBACKS (all optional)
  onUploaded: function(url),   // called with Cloudinary secure_url on success
  onSkipped:  function(),      // called when user taps skip
  onError:    function(msg),   // called with error string if upload fails
                               // component stays open; caller decides whether to retry or skip
})
```

**Phase 5 usage example (for oxygen tank photo):**
```
PhotoCaptureModal.open({
  folder:    'thegood-stock/oxygen/' + tank_serial + '/fill',
  label:     'ถ่ายรูปถังออกซิเจน',
  optional:  true,
  entityId:  tank_serial,
  onUploaded: (url) => { loanData.photoUrl = url; proceedToConfirm(); },
  onSkipped:  () => { proceedToConfirm(); },
  onError:    (msg) => { showWarningToast('อัปโหลดรูปไม่สำเร็จ — ดำเนินการต่อโดยไม่มีรูป'); proceedToConfirm(); }
})
```

### 7.3 Internal states

| State | UI |
|---|---|
| Initial (no photo) | Two buttons: [📷 เปิดกล้อง] [📁 เลือกจากคลัง]. Both min 48px height. |
| Camera active | `<video>` preview, 4:3 aspect ratio, max-height 240px. [📸 ถ่ายรูป] center button (64px diameter). |
| Photo captured | Static `<img>` thumbnail (120×90). [ใช้รูปนี้] (primary) + [ถ่ายใหม่] (secondary). |
| Uploading | Thumbnail stays visible. Progress bar (Bootstrap `.progress`) below thumbnail. Percentage label. Buttons disabled. |
| Upload success | Thumbnail stays. Check icon overlay on thumbnail. Modal auto-closes after 0.5s. Calls `onUploaded(url)`. |
| Upload error | Thumbnail stays. Red alert below thumbnail: "อัปโหลดรูปไม่สำเร็จ". [ลองอีกครั้ง] + [ดำเนินการต่อโดยไม่มีรูป]. Calls `onError(msg)`. |
| Skip | Modal closes. Calls `onSkipped()`. No toast — caller decides toast message. |

### 7.4 Accessibility requirements for PhotoCaptureModal

- `<video>` element: `aria-label="ภาพจากกล้องเพื่อถ่ายรูป"` (same pattern as scanner video).
- `<input type="file">` is visually hidden but keyboard-accessible (`opacity: 0; position: absolute;`). A visible button triggers it.
- Camera button: `aria-label="ถ่ายรูป"`.
- Skip button: `aria-label="ข้ามการถ่ายรูป"`.
- Upload progress: `role="progressbar"`, `aria-valuenow` updated on each progress tick.
- If camera is unavailable (permission denied or HTTPS issue): gracefully falls back to file-upload-only UI. The camera button is replaced by: "กล้องไม่พร้อมใช้งาน — เลือกรูปจากคลังแทน".

### 7.5 Mobile-first considerations for photo capture

- Max camera preview height: 240px at 360px viewport (leaves room for action buttons above the fold).
- Touch-friendly shutter button: 64px diameter, centered, uses `bi-camera-fill` icon. Thumb-reachable at bottom of preview.
- File input: `accept="image/*" capture="environment"` to prefer rear camera on mobile.
- If photo file > 5MB: inline warning "รูปถ่ายใหญ่มาก — อาจใช้เวลานานในการอัปโหลด" (not blocking).
- Component renders inside a Bootstrap `.modal .modal-dialog-centered` with `modal-dialog-scrollable`. At <576px, `modal-dialog-centered` bottom-aligns per existing `styles.css` rule (line 669).

---

## 8. Dashboard Panel "สถานะอุปกรณ์ยืม-คืน" [S-3.4]

### 8.1 Panel wireframe @ 360px

```
┌─────────────────────────────────────────────────────┐
│ ┌── สถานะอุปกรณ์ยืม-คืน ────────────────────────┐  │
│ │                                               │  │
│ │  [กำลังยืม]teal              [3 รายการ]  →   │  │  ← tap → loan list, filter=active
│ │  [เลยกำหนด]red               [1 รายการ]  →   │  │  ← tap → loan list, filter=overdue
│ │  [คืนวันนี้]gray             [2 รายการ]  →   │  │  ← tap → loan list, filter=returned today
│ │                                               │  │
│ └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 8.2 Panel detail spec

```
Layout:  .card (Bootstrap) with header "สถานะอุปกรณ์ยืม-คืน" + bi-arrow-left-right icon
         3 rows, each:
           - Left: colored badge label (teal/red/gray)
           - Right: count (numeric) + arrow → 
           - min-height 44px per row (tap target)
           - border-bottom between rows (except last)

Colors:
  กำลังยืม:  badge class = bg-stock-accent-subtle text-stock-accent-dark
  เลยกำหนด:  badge class = bg-danger text-white  +  .blink-badge animation if count > 0
             (existing .blink-badge keyframe in shared/styles.css line 24)
  คืนวันนี้:  badge class = bg-secondary text-white

Realtime: Supabase channel subscription on stock_loans table.
          On INSERT or UPDATE → re-fetch counts.
          While loading: show "—" placeholders in count cells.
```

### 8.3 Navigation target

Tapping a row navigates to the loan list tab (Option A: `#tab-loans`; Option B: Inventory tab with "ยืม-คืน" segment selected), with the corresponding status filter pre-applied.

Implementation note for `frontend-developer`: set `activeFilters.status = 'active' | 'overdue' | 'returned_today'` in `loans.js` module before activating the tab. The tab activation must be triggered via `admin-shell.js` `activateTab('loans')` pattern (same as Phase 2 expiry panel links to inventory).

---

## 9. Overdue Telegram Message Format

### 9.1 Individual loan message (≤ threshold loans overdue)

Source: `run_overdue_alert()` function in spec §5.2.3.

```
⚠️ เลยกำหนดคืน: {item_name} ({sku}) จำนวน {qty} — ยืมโดย {borrower_username} — ครบกำหนด {DD Mon YYYY HH:MM}
```

**Visual rendering (chat preview):**
```
⚠️ เลยกำหนดคืน: เปลหาม (SUP-STRCH-001) จำนวน 1
— ยืมโดย staff01 — ครบกำหนด 18 พ.ค. 2569 09:00
```

**Message format notes:**
- Emoji: ⚠️ (warning; not 🔴 as the initial brief suggested — spec §5.2.3 uses ⚠️ throughout).
  **FLAG:** The initial design brief says "🔴 เกินกำหนดคืน" but the spec trigger code uses "⚠️ เลยกำหนด". This design follows the spec. If PM wants a different prefix emoji, update in `run_overdue_alert()` SQL only.
- Date format: `DD Mon YYYY HH:MM` in Asia/Bangkok (spec: `to_char(..., 'DD Mon YYYY HH24:MI')`).
- Month abbreviation will be English (PostgreSQL default). If Thai month names are required, note for PM to add a custom format or post-process.

### 9.2 Grouped message (> threshold loans overdue)

```
⚠️ มีอุปกรณ์เลยกำหนดคืน {N} รายการ กรุณาตรวจสอบแท็บอุปกรณ์ยืม-คืน
```

Where `{N}` = count of all currently overdue loans.

### 9.3 Threshold configuration

Per spec Q-Phase3-F recommendation (Option B): threshold stored in `settings` table as `OVERDUE_GROUP_THRESHOLD` with default value `10`. No UI needed to edit this — admin can update via Settings tab's existing key-value editor (Phase 1 settings UI).

---

## 10. Microcopy Table (All Thai Strings)

All strings in Thai. English in parentheses only for technical identifiers.

### 10.1 Buttons and CTAs

| Element | Thai copy | Notes |
|---|---|---|
| Top nav tab (Option A) | ยืม-คืน | Short label; icon bi-arrow-left-right |
| Mode toggle: existing mode | เบิก-จ่าย | Existing Phase 1 label unchanged |
| Mode toggle: new mode | ยืม-คืน | |
| Sub-mode: borrow | ยืมอุปกรณ์ | |
| Sub-mode: return | คืนอุปกรณ์ | |
| staff.html new button 1 | ↗ ยืมอุปกรณ์ | |
| staff.html new button 2 | ↩ คืนอุปกรณ์ | |
| Due_at preset: 1 day | 1 วัน | |
| Due_at preset: 3 days | 3 วัน | |
| Due_at preset: 7 days | 7 วัน | |
| Due_at preset: custom | กำหนดเอง | |
| Photo: open camera | 📷 เปิดกล้องถ่ายรูป | |
| Photo: choose from gallery | 📁 เลือกรูปจากคลัง | |
| Photo: use this photo | ใช้รูปนี้ | primary action |
| Photo: retake | ถ่ายใหม่ | secondary |
| Photo: skip | ข้าม — ไม่มีรูป | btn-link, not btn-outline |
| Photo: retry upload | ลองอีกครั้ง | |
| Photo: proceed without photo | ดำเนินการต่อโดยไม่มีรูป | |
| Step next | ถัดไป → | e.g. "ถัดไป: สแกนตำแหน่ง →" |
| Step edit | ← แก้ไข | |
| Confirm borrow | ยืนยันการยืม | |
| Confirm return | ยืนยันการคืน | |
| Admin record return | บันทึกคืน | |
| View detail | ดูรายละเอียด | |
| View photo | ดูรูปถ่าย | |
| Filter clear | ล้างตัวกรอง | |
| Filter overdue only toggle | เฉพาะเลยกำหนด | checkbox label |
| Refresh | รีเฟรช | |

### 10.2 Status badges

| Value | Thai label |
|---|---|
| active | กำลังยืม |
| overdue | เลยกำหนด |
| returned | คืนแล้ว |

### 10.3 Toast messages

| Trigger | Thai copy | Toast type |
|---|---|---|
| Borrow success (with photo) | ยืมสำเร็จ — กำหนดคืน {DD พ.ค. YYYY} | success (green) |
| Borrow success (no photo) | ยืมสำเร็จ — แต่ไม่สามารถอัปโหลดรูปถ่ายได้ — กรุณาอัปโหลดภายหลัง | warning (amber) |
| Borrow duplicate scan (409) | ยืมสำเร็จแล้ว | success (green) |
| Return success | คืนสำเร็จ ขอบคุณ | success (green) |
| Return success (no photo) | คืนสำเร็จ แต่ไม่มีรูปถ่าย | warning (amber) |
| Photo upload fail | อัปโหลดรูปไม่สำเร็จ — ยังดำเนินการต่อได้ | warning |
| Borrow fail — qty zero | ของไม่เหลือในคลัง — ไม่สามารถยืมได้ | danger |
| Borrow fail — neg qty (Phase 1 trigger) | ของไม่พอ — ไม่สามารถยืมได้ | danger |
| Return fail — no open loan (trigger error) | ไม่พบรายการยืมที่เปิดอยู่ | danger |
| Return fail — general network | บันทึกการคืนไม่สำเร็จ — ลองใหม่อีกครั้ง | danger |
| Admin return success | บันทึกการคืนสำเร็จ | success |
| Loan list load fail | โหลดรายการยืมไม่สำเร็จ — กดรีเฟรช | danger |

### 10.4 Form labels and placeholders

| Field | Label | Placeholder / hint |
|---|---|---|
| จำนวน (borrow) | จำนวน * | (stepper, no placeholder needed) |
| กำหนดคืน | กำหนดคืน * | — |
| หมายเหตุ (borrow) | หมายเหตุ (ไม่บังคับ) | — |
| หมายเหตุ (admin return) | หมายเหตุ (ไม่บังคับ) | — |
| Custom date picker | วันที่คืน | วว/ดด/ปปปป |
| Filter: search | — | ค้นชื่อสินค้า / ผู้ยืม |
| Filter: status dropdown | สถานะ | — |

### 10.5 Error messages (inline)

| Trigger | Thai copy |
|---|---|
| Qty > available at location | จำนวนเกินที่มีในตำแหน่งนี้ ({N} ชิ้น) |
| Due_at < today | วันคืนต้องไม่ผ่านมาแล้ว |
| Item not found by scan | ไม่พบสินค้า — ลองใหม่ |
| Location not found | ไม่พบตำแหน่ง — ลองใหม่ |
| No loan for return | ไม่มีรายการยืมที่ยังค้างอยู่สำหรับสินค้านี้ |

### 10.6 Empty states

| Screen | Thai copy |
|---|---|
| Loan list (no loans at all) | ไม่มีรายการยืม — เมื่อมีการยืมอุปกรณ์ รายการจะแสดงที่นี่ |
| Loan list (filter, no results) | ไม่พบรายการที่ตรงกับตัวกรอง |
| Drawer: no borrow photo | ไม่มีรูปถ่ายก่อนยืม |
| Drawer: no return photo | ยังไม่มีรูปถ่ายเมื่อคืน |

### 10.7 Section headings and labels

| Context | Thai copy |
|---|---|
| Admin tab title (Option A) | อุปกรณ์ยืม-คืน |
| Dashboard panel title | สถานะอุปกรณ์ยืม-คืน |
| Loan list header | รายการยืม-คืนอุปกรณ์ |
| Borrow flow: due date section | กำหนดวันคืน |
| Borrow flow: photo section | ถ่ายรูปอุปกรณ์ก่อนยืม |
| Borrow flow: confirm section | สรุปการยืม |
| Return flow: loan card heading | รายการที่ยืมอยู่ |
| Return flow: photo section | ถ่ายรูปอุปกรณ์เมื่อคืน |
| Return flow: confirm section | สรุปการคืน |
| Admin drawer title | รายละเอียดการยืม |
| Admin return modal title | บันทึกคืนอุปกรณ์ |

---

## 11. Accessibility Notes

### 11.1 Color contrast

All status badges use Bootstrap semantic utility classes with sufficient contrast ratios:

| Badge | Background | Foreground | Contrast ratio | WCAG AA (4.5:1 body) |
|---|---|---|---|---|
| กำลังยืม | `--stock-accent-subtle` (#ccfbf1) | `--stock-accent-dark` (#0f766e) | ~5.0:1 | Pass |
| เลยกำหนด | `bg-danger` (#dc3545) | white (#fff) | ~5.0:1 | Pass |
| คืนแล้ว | `bg-secondary` (#6c757d) | white (#fff) | ~4.5:1 | Pass (borderline — verify in browser) |

**Note on "คืนแล้ว":** Bootstrap `bg-secondary` (#6c757d) against white text is exactly 4.48:1 — marginally below WCAG AA for body text but acceptable for badge (large text equivalent ≥3:1). If PM requires strict AA compliance, use `#5a6268` (slightly darker) for the returned badge.

**Note:** Color is NEVER the only distinguishing signal. Every badge includes text label. The "เลยกำหนด" condition additionally shows "เลย N วัน" text in the due_at column.

### 11.2 Tap targets

| Component | Min target size | Compliance |
|---|---|---|
| Mode toggle buttons | 48px height, full half-width | Pass |
| Due_at preset buttons | 48px height, ≥80px width | Pass |
| [ยืนยันการยืม] / [ยืนยันการคืน] | 52px height, full width | Pass |
| Photo: camera + file buttons | 48px height | Pass |
| Photo: shutter button (camera mode) | 64px diameter | Pass |
| Loan list row (mobile card) | 64px min-height | Pass |
| [จัดการ ▾] dropdown | 44px height, 80px width | Pass |
| Dashboard panel rows | 44px min-height | Pass |
| Nav tab "ยืม-คืน" (Option A) | 40px height (same as existing pills) | Borderline — existing pattern |

**Nav tab note:** The admin.html nav-pills buttons are currently `padding: 0.4rem 0.8rem` at < 768px (line 682 in `styles.css`), which gives approximately 38-40px height. This is slightly below the 44px target but matches the existing pattern used in all 6 tabs. Changing this would require updating ALL tabs. Recommend PM note this as a known acceptable deviation from 44px — consistent with Phase 1/2 design decisions.

### 11.3 Keyboard navigation order

For the borrow flow (staff-scan.html, mode toggle added):

1. Mode toggle: [เบิก-จ่าย] → [ยืม-คืน] (left/right arrow keys within `role="tablist"`)
2. Sub-mode toggle: [ยืมอุปกรณ์] → [คืนอุปกรณ์]
3. Step 3 (due date): qty stepper (−, input, +) → preset buttons (1 วัน, 3 วัน, 7 วัน, กำหนดเอง) → date input (if กำหนดเอง) → notes textarea → [ถัดไป]
4. Step 4 (photo): [เปิดกล้อง] → [เลือกจากคลัง] → [ถัดไป] → [ข้าม]
5. Step 5 (confirm): [ยืนยันการยืม] → [← แก้ไข]

`aria-live="polite"` on the chip row (existing pattern in `staff-scan.html` line 200) — continue for borrow mode.

`role="alert"` on success/error overlays (existing pattern in `staff-scan.html` line 265) — continue for all borrow/return feedback.

### 11.4 Screen reader labels

| Element | `aria-label` |
|---|---|
| Mode toggle: เบิก-จ่าย | โหมดเบิก-จ่าย |
| Mode toggle: ยืม-คืน | โหมดยืม-คืน |
| Sub-mode: ยืมอุปกรณ์ | ยืมอุปกรณ์ |
| Sub-mode: คืนอุปกรณ์ | คืนอุปกรณ์ |
| Photo shutter button | ถ่ายรูป |
| Photo skip button | ข้ามการถ่ายรูป |
| Photo upload progress | `role="progressbar" aria-valuenow="{N}" aria-valuemin="0" aria-valuemax="100" aria-label="กำลังอัปโหลดรูปถ่าย"` |
| Status badge | Include text in badge; no `aria-label` needed |
| Loan list row (click target) | `aria-label="รายละเอียดการยืม {item_name} โดย {borrower}"` |
| Dashboard counts | `aria-label="กำลังยืม {N} รายการ"` etc. |

---

## 12. Mobile-First Checks at 360px

### 12.1 Photo capture viewport

At 360px width, the camera preview inside `PhotoCaptureModal`:
- Modal uses `modal-dialog-centered` → bottom-aligned at <576px (existing `styles.css` line 669).
- Camera `<video>` element: `width: 100%; aspect-ratio: 4/3; max-height: 240px`. At 360px, this renders at 360×270px — fits above the fold with action buttons visible.
- Shutter button (64px diameter) sits below the preview and above the footer buttons.
- Total modal height: ~240px preview + 64px shutter + 48px footer buttons + padding ≈ 380px. Viewport height at 360px device: typically 640-780px. Fits comfortably.

### 12.2 Due_at picker on small screens

Quick preset row (4 buttons: 1วัน, 3วัน, 7วัน, กำหนดเอง):
- At 360px: each button = (360 - 3×8px gap - 2×12px padding) / 4 ≈ 78px wide × 48px tall. Sufficient.
- If กำหนดเอง selected: date input `<input type="date">` expands below the preset row. Native date picker on iOS/Android is accessible and sized to the OS.
- At <320px (very rare): preset buttons may need to wrap. Use `flex-wrap: wrap` on the preset row as a safety net. On wrap, 2+2 layout is acceptable.

### 12.3 Admin loan list at 360px

Mobile card layout (§4.4.1) is used instead of a table. Each card shows 2 lines of information — fits comfortably at 360px without horizontal scroll.

### 12.4 Mode toggle at 360px

Two mode toggle buttons: [เบิก-จ่าย] [ยืม-คืน]. Each is 50% of 360px minus gap = ~172px wide × 48px tall. Adequate.

Sub-mode row: [ยืมอุปกรณ์] [คืนอุปกรณ์]. Same calculation. "คืนอุปกรณ์" (4 chars) fits at 172px easily.

### 12.5 Step indicator at 360px

5 steps with numeric circles only (label hidden at <400px via existing `.step-item .step-label` rule). Each step item = 360/5 = 72px wide × ~40px tall. Adequate.

---

## 13. Open UX Questions for PM

These must appear in the spec §11 decisions log before `frontend-developer` starts.

### Q-Phase3-A — UI Placement (also addressed in §3)

**Decision needed:** New top-level tab "อุปกรณ์ยืม-คืน" (Option A, RECOMMENDED) vs 5th segment inside Inventory (Option B)?

**Design vote: Option A.** See §3.3 for full rationale. If PM chooses Option B, the segment overflow design pattern from Phase 2 (`overflow-x: auto` on segment row) applies, but discoverability risk at 360px is documented in §3.2.2.

---

### Q-Phase3-C — Photo Required vs Advisory

**Decision needed:** At the borrow step, is a photo required (blocks proceeding without one) or advisory only (skip button available)?

**Design implication:** Option A (advisory) = skip button always visible. Option B (required at borrow) = skip button removed from Step 4 of borrow flow; `optional: false` passed to `PhotoCaptureModal`. Return photo remains advisory regardless.

**Design vote: Option A (advisory).** See spec §7 Q-Phase3-C rationale. Camera failure or poor lighting in a storeroom must not block equipment from being tracked.

---

### Q-Phase3-G — Default due_at preset

**Decision needed:** Which preset is pre-selected when a staff member opens the due_date picker? Options: 1 day, 3 days, 7 days.

**Design implication:** The pre-selected preset is visually highlighted (teal background). Changing the default requires only a one-line JS change.

**Design vote:** 3 วัน (3 days). Rationale: for clinical paramedic equipment, 1 day is too short (shift work may span overnight), 7 days is too long (equipment sits untracked). 3 days is a reasonable middle ground. If the PM has operational data suggesting a different default, override this.

---

### Q-Photo-Reuse — PhotoCaptureModal shared with Phase 5 Oxygen

**Open coordination item:** Phase 5 (oxygen tank tracking) runs in parallel. This design document specifies the `PhotoCaptureModal` component contract in §7.2. Phase 5's UI designer must use the same component with `folder: 'thegood-stock/oxygen/{tank_serial}/fill'` and `label: 'ถ่ายรูปถังออกซิเจน'`.

**Action for PM:** Confirm that Phase 5 designer has received §7 of this document before Phase 5 UI design is drafted. If Phase 5 needs additional parameters (e.g., `maxPhotos: 2` for multi-angle), propose them as additions to the contract — do NOT fork the component.

---

### Q-Active-Loan-Visibility — Loan status on item detail anywhere else?

**Open UX question:** Should an active loan be visible on the item row in the Inventory tab (e.g., "2/5 ชิ้น กำลังถูกยืม" badge on the item card)?

**Design vote:** Yes, this would be useful for admin situational awareness. However, it is a scope addition not in the Phase 3 spec. Flag as Phase 3.1 enhancement. For Phase 3, loan status is only visible in the "อุปกรณ์ยืม-คืน" tab and the dashboard panel.

---

### Q-Overdue-Staff-Visibility — Do non-borrower staff see other people's overdue loans?

**Open UX question:** In the staff return flow (Step 1), when a staff member scans an item, do they see only THEIR open loans, or also open loans by other staff?

**Current spec behavior:** `close_loan_from_return()` trigger matches by `borrower_username = NEW.performed_by`. So only the scanner's own loans can be closed from the staff flow.

**Design implication:** The return flow Step 1 currently shows only the current user's loan. If an admin needs to close someone else's loan, they use the admin "บันทึกคืน" button. This distinction should be documented in the onboarding hint: "ถ้ายืมโดยผู้ใช้อื่น โปรดแจ้ง Admin" (already in §6 Step 1 State C copy).

---

## 14. Component Reuse Map and Hand-Off Note

### 14.1 Components to REUSE (no changes)

| Component | File | Usage in Phase 3 |
|---|---|---|
| Scanner camera stage + viewfinder | `staff-scan.html` inline styles | Reused in borrow Steps 1+2 and return Step 1 |
| `AppScanner` (shared scanner) | `shared/scanner.js` | Item scan + location scan in both flows |
| `uploadToCloudinary(file, subfolder)` | `shared/cloudinary.js` | Called by `PhotoCaptureModal` with `folder` param |
| Toast helper | `shared/ui.js` | All toast messages |
| `.step-indicator` / `.step-item` | `shared/styles.css` lines 329-385 | Borrow flow 5-step + return flow 3-step |
| `.scan-chip` / `.scan-chip.done` | `staff-scan.html` inline `<style>` | Borrow/return chip row |
| `.scan-stage` + `.scan-hint` | `staff-scan.html` inline `<style>` | Scanner stage in borrow/return |
| `fadeIn` animation | `shared/styles.css` line 18 | Loan list row entry + section reveals |
| `.blink-badge` | `shared/styles.css` line 25 | Overdue count badge in dashboard panel |
| Bootstrap offcanvas | Bootstrap 5 | Loan detail drawer [S-3.2] |
| Bootstrap modal | Bootstrap 5 | Admin return modal [S-3.3] + PhotoCaptureModal |
| `.bg-stock-accent-subtle` + teal tokens | `shared/styles.css` lines 730-735 | Active loan badge, preset selected state |
| Admin tab activation pattern | `js/admin-shell.js` | Tab "loans" activation from dashboard panel tap |

### 14.2 Components to BUILD NEW

| Component | File | Notes |
|---|---|---|
| PhotoCaptureModal | `shared/photo-capture.js` | New. Contract in §7. Must expose `window.PhotoCaptureModal.open(config)`. |
| Loan list view + filter bar | `js/loans.js` | New. Realtime subscription + REST query. |
| Admin return modal logic | part of `js/loans.js` or separate `js/loans-scan.js` | Per spec repo structure §4 |
| Mode toggle + borrow/return sub-mode routing | `js/staff-borrow.js` | New. Loaded by `staff-scan.html` (Option 5A) or `staff-borrow.html` (Option 5B). |
| Due_at preset picker component | inline in `js/staff-borrow.js` | Not a standalone component — too simple. |
| Dashboard loan panel | extend `js/dashboard.js` | Replaces `<!-- Phase 1 placeholder -->` |
| New tab registration | edit `admin.html` + `js/admin-shell.js` | Add `data-tab="loans"` pill + `#tab-loans` div |

### 14.3 NEW CSS tokens proposed

One new token is needed. All others reuse existing tokens.

```css
/* Add to shared/styles.css under Thegood Stock section (after line 762): */

/* Phase 3 — Borrow/Return specific */
--loan-overdue-row-bg: #f8d7da;   /* Bootstrap table-danger; already available as utility class */
--loan-due-soon-text:  #842029;   /* dark red for "เลย N วัน" inline text */

/* Phase 3 quick-preset selected state (reuses existing tokens): */
/* selected preset: bg-stock-accent-subtle border-stock-accent text-stock-accent-dark fw-semibold */
/* No new token needed — composition of existing tokens is sufficient */
```

The `--loan-overdue-row-bg` and `--loan-due-soon-text` values are identical to Bootstrap's `table-danger` and `text-danger-emphasis` utilities. These are listed here for documentation; the frontend-developer can use the Bootstrap utilities directly without adding custom CSS tokens.

### 14.4 Hand-off note to frontend-developer

**Next agent:** `frontend-developer`

**What to implement first (in dependency order):**
1. `shared/photo-capture.js` — PhotoCaptureModal component. Contract in §7.2. No dependencies on Phase 3 data.
2. `admin.html` — add "ยืม-คืน" tab pill + `#tab-loans` div (Option A confirmed by PM).
3. `js/admin-shell.js` — register `loans` tab; wire dashboard panel tap navigation.
4. `js/loans.js` — loan list + filter bar + detail drawer + admin return modal. Depends on (2)+(3).
5. `js/dashboard.js` — replace Phase 1 placeholder panel with live counts using Realtime. Depends on `stock_loans` table existing (migrations must run first).
6. `js/staff-borrow.js` — borrow + return scan flow. Depends on (1) for photo step. Load in `staff-scan.html` (Option A) or new `staff-borrow.html` (Option B pending PM decision).
7. `staff.html` — add "ยืมอุปกรณ์" + "คืนอุปกรณ์" buttons.

**Questions the frontend-developer should NOT have to ask** (already resolved in this document):
- What are the status badge colors? → §4.5
- What are all the Thai strings? → §10
- What tap target sizes? → §11.2
- What does the photo component API look like? → §7.2
- What happens on photo upload failure? → §5.3 (borrow) and §6 (return): advisory toast, movement proceeds
- What trigger error string to display for "no open loan"? → §10.3: "ไม่พบรายการยืมที่เปิดอยู่"
- How does the dashboard panel navigate to the loan list? → §8.3: `loans.js` module filter API
- What does the empty state look like? → §4.6 and §10.6

**Questions requiring PM decision before coding starts:**
- Q-Phase3-A: tab vs segment (blocks admin.html structure)
- Q-Phase3-C: photo required vs advisory (blocks PhotoCaptureModal `optional` param for borrow step)
- Q-Phase3-G: default preset days (blocks preset pre-selection in Step 3 JS)
- Q-Phase3-E: due_at transport (blocks note format or column choice in submit JS) — backend decision but affects FE note field format
- Staff borrow page option (5A vs 5B) — affects which HTML file to create

---

*Status: DRAFT — pending PM review + Phase 3 spec Q-Phase3-A through Q-Phase3-G resolution*

*Files read for this design:*
- `docs/superpowers/specs/2026-05-19-phase3-borrow-return-design.md` (all 1085 lines)
- `docs/superpowers/designs/2026-05-18-phase2-ui-design.md` (lines 1-500)
- `shared/cloudinary.js`
- `shared/styles.css`
- `admin.html`
- `staff-scan.html`
- `staff.html`
