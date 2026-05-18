# DRAFT — Phase 5 UI/UX Design: Oxygen Tanks Lifecycle

**Project:** Thegood Stock Management System
**Phase:** 5 (Oxygen Tanks per-piece serial lifecycle + Refill Batch Alerts)
**Date:** 2026-05-19
**Author:** UI/UX Designer (autonomous draft)
**Status:** DRAFT — pending PM review + Phase 5 spec Q1–Q6 resolution
**Source spec:** `docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md`
**Phase 1 design ref:** `docs/superpowers/designs/2026-05-18-phase1-ui-design.md`
**Phase 2 design ref:** `docs/superpowers/designs/2026-05-18-phase2-ui-design.md`
**Next agent:** `frontend-developer`

---

## Table of Contents

- §1 Purpose, user stories, and assumed user context
- §2 Information architecture (screen list + ASCII diagram)
- §3 Screen-by-screen mockups and interaction states
  - §3.1 Admin — "ถังออกซิเจน" tab (tank list view)
  - §3.2 Admin — Add tank modal
  - §3.3 Admin — Tank detail / history drawer
  - §3.4 Admin — Log transition modal
  - §3.5 Staff — `staff-oxygen.html` (dedicated scan flow, 7-step wizard)
  - §3.6 Dashboard — "สถานะถังออกซิเจน" panel
  - §3.7 Maintenance flagging UX (conditional on Q3)
- §4 Component reuse map
- §5 Interaction state diagrams
  - §5.1 Admin "ถังออกซิเจน" tab — state machine
  - §5.2 Staff scan — 7-step state machine
  - §5.3 Status transition flow (all actors)
- §6 Microcopy table (all Thai strings)
- §7 Accessibility notes
- §8 Open UX questions for PM

---

## 1. Purpose, User Stories, and Assumed User Context

### 1.1 Why this design exists

Phases 1–4 track inventory by SKU + quantity. Oxygen tanks require **per-piece serial identity**: each physical cylinder is tracked from first placement through deployment, refilling, maintenance, and retirement. This design covers the UI layer on top of the `oxygen_tanks` + `oxygen_movements` data model from the spec.

### 1.2 User stories

**US-O1 — Admin registers a new cylinder**
"I received three new tanks from the vendor. I need to add each serial to the system, assign a location, and record the next hydrostatic inspection date."
Acceptance: Add-tank modal, serial + size + location + inspection date → `oxygen_tanks` row + initial `oxygen_movements` (NULL → ready).

**US-O2 — Staff loads a tank onto an ambulance**
"Before departure I scan the tank cylinder. I change its status from ready to on_board and the system records which vehicle it went with."
Acceptance: `staff-oxygen.html` scan → find tank → select `on_board` → pick ambulance location → submit.

**US-O3 — Staff returns an empty tank for refilling**
"After a run the tank is empty. I scan it and mark it as needing refill."
Acceptance: Staff scan → `on_board → refilling` transition → system counts refilling tanks → if threshold reached, Telegram alert fires automatically.

**US-O4 — Admin completes a refill batch**
"The vendor returned 6 cylinders full. I mark each as ready and their last_refill_at is recorded."
Acceptance: Admin detail drawer → "เปลี่ยนสถานะ" → `refilling → ready` (Admin-only transition).

**US-O5 — Admin sees the oxygen status board at a glance**
"I open the dashboard and immediately see how many tanks are ready, on_board, in refilling, and in maintenance."
Acceptance: Dashboard panel shows per-status counts + amber alert when refilling >= threshold.

**US-O6 — Admin retires a cylinder**
"Tank OXY-0042 failed its hydrostatic test. I retire it permanently so nobody deploys it again."
Acceptance: Admin detail drawer → "เปลี่ยนสถานะ" → `retired` → confirm modal (irreversible warning) → tank greys out in list, no further transitions possible.

### 1.3 Assumed user context (explicit)

| Assumption | Impact on design |
|---|---|
| **Admin** is on desktop or tablet at a desk when adding/editing tanks or completing refill batches. Mobile is secondary for admin. | Admin list can use a wider table layout. Detail drawer is a modal (not forced full-screen on desktop). |
| **Staff** is on a phone, one hand free, in a storeroom, near an ambulance bay, or in a vehicle. | All tap targets ≥44 px. Scan step takes full width. 7-step wizard is vertical, scrollless per step. |
| Staff may be wearing **gloves** (clinical setting). | Extra-large tap targets for transition selection cards (≥60 px height). Avoid small dropdown touch targets on staff scan page. |
| **Serial barcode/QR scanning** is assumed as primary entry, manual type-in as fallback. (Spec §7.2 step 1 describes both.) | Camera occupies the full upper portion of staff page. "พิมพ์แทน" text link is below the video area, not buried. |
| **Network**: online-only for status transitions (trigger must confirm the transition). Optimistic UI is safe for the status badge display but the submit must wait for a confirmed REST response before showing success. | Loading state is mandatory. No offline transition queue. |
| **All copy in Thai.** English only in parentheses for technical terms developers keep stable (QR, Barcode, serial). | All labels Thai-first. Status enum values displayed in Thai with English in parens only in developer-facing contexts. |
| **Retired tanks** must remain visible in the list (greyed) for historical reference (spec §12 Q-Phase5-J). | Retired rows use `.text-muted` and a grey badge. They are NOT hidden by default — a "ซ่อนถังปลดระวาง" toggle may be offered (flag §8 Q-O5). |

---

## 2. Information Architecture

### 2.1 Screen list

| Screen ID | Surface | Screen name | Phase 5 status |
|---|---|---|---|
| S-5.1 | `admin.html` — top-level nav | "ถังออกซิเจน" tab (tank list + filter) | NEW tab |
| S-5.2 | `admin.html` — modal | Add tank modal | NEW |
| S-5.3 | `admin.html` — modal / offcanvas | Tank detail + history drawer | NEW |
| S-5.4 | `admin.html` — modal (nested) | Log transition modal | NEW |
| S-5.5 | `staff-oxygen.html` | Staff serial scan + transition flow | NEW PAGE |
| S-5.6 | `admin.html` Dashboard tab | "สถานะถังออกซิเจน" panel | NEW PANEL in Dashboard |

### 2.2 Architecture diagram (ASCII)

```
admin.html
└── nav-pills (Phase 0–2 tabs + NEW: ถังออกซิเจน)
    │
    ├── #tab-dashboard (js/dashboard.js — EXTENDED Phase 5)
    │     └── Panel "สถานะถังออกซิเจน" [S-5.6]
    │           count badges per status (ready/on_board/refilling/maintenance/retired)
    │           amber alert when refilling >= OXYGEN_REFILL_THRESHOLD
    │           "ดูทั้งหมด →" → opens ถังออกซิเจน tab
    │
    └── #tab-oxygen (js/oxygen.js — NEW)
          │
          ├── Toolbar (always visible)
          │     ├── "+ เพิ่มถัง" button (Admin only)
          │     └── Filter bar: สถานะ dropdown | ค้นหาหมายเลข input | "ต้องตรวจ" toggle
          │
          └── Tank list table [S-5.1]
                └── Row click → Tank detail / history drawer [S-5.3]
                      ├── Header: serial, status badge, size, location, last refill, next inspection
                      ├── History timeline (oxygen_movements, most-recent first)
                      └── "เปลี่ยนสถานะ" button → Log transition modal [S-5.4]
                            (in the drawer footer, Admin only)

  Modal: + เพิ่มถัง [S-5.2]
  │  serial | tank_size | location | next_inspection_due | notes
  └─ on save: INSERT oxygen_tanks → INSERT oxygen_movements (NULL→ready)

  Modal (nested): เปลี่ยนสถานะ [S-5.4]
  │  to_status select (filtered to allowed transitions)
  │  to_location_id (conditional)
  │  note textarea
  │  photo (Cloudinary widget — conditional on Q4 PM decision)
  └─ on save: INSERT oxygen_movements

staff-oxygen.html (js/staff-oxygen.js — NEW)
└── 7-step scan state machine (see §5.2)
      Step 1: สแกน / พิมพ์หมายเลขถัง
      Step 2: แสดงข้อมูลถัง (confirm identity)
      Step 3: เลือกสถานะใหม่ (allowed transitions for staff)
      Step 4: เลือกสถานที่ (conditional)
      Step 5: บันทึกหมายเหตุ (optional)
      Step 6: ถ่ายรูป (conditional on Q4)
      Step 7: ยืนยันและบันทึก → success overlay
```

### 2.3 Tab placement decision

**Decision (D-O1): New top-level nav tab, NOT a sub-view under Inventory.**

Rationale:
- Oxygen tanks use an entirely separate table (`oxygen_tanks`). They are not `stock_items`. Placing them under the Inventory tab would imply a relationship that does not exist architecturally and would confuse future developers (and future BA/PM who reads the tab label "Inventory" expecting SKU-based stock).
- The Inventory tab segmented control already has 4 segments (รายการสินค้า / รับเข้า / ล็อตยา / ค้นของ). Adding a 5th "ถังออกซิเจน" segment would overflow at 360 px — each segment would be narrower than 64 px, making taps unreliable even without gloves.
- A top-level "ถังออกซิเจน" tab with the `bi-wind` or `bi-droplet-fill` Bootstrap Icon is visually distinct and immediately searchable by label.
- **OPEN UX QUESTION (Q-O1):** The current admin nav has 5 tabs: Dashboard, Locations, Ambulances, Settings, Sessions. Phase 1 adds Inventory (6 tabs total). Phase 5 adds a 7th. At 360 px with `flex-wrap gap-1`, 7 pills overflow to 2 rows. Recommend PM considers the tab order and whether "Sessions" (rarely used) can move to Settings sub-tab to keep the primary nav to 6 visible pills. Flagged in §8.

---

## 3. Screen-by-Screen Mockups and Interaction States

### 3.1 Admin — "ถังออกซิเจน" Tab: Tank List [S-5.1]

#### Context

Lazy-loaded via `js/admin-shell.js` pattern (same as Inventory tab). Script: `js/oxygen.js`.
Realtime subscription on `oxygen_tanks` channel refreshes the list live.

#### 3.1.1 Wireframe @ 360 px (mobile)

```
┌─────────────────────────────────────────────┐
│ navbar: Thegood Stock — Admin       [ออก]   │
├─────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory]           │
│ [Ambulances][ถังออกซิเจน*][Settings]…      │  ← nav-pills, scroll-x on mobile
├─────────────────────────────────────────────┤
│                                              │
│ [+ เพิ่มถัง]                                 │  ← btn-stock-primary, full-width <400 px
│                                              │
│ ── ตัวกรอง ──────────────────────────────── │
│ ┌─────────────────────────────────────────┐ │
│ │ สถานะ: ทั้งหมด ▾                         │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ 🔍 ค้นหมายเลขถัง                        │ │
│ └─────────────────────────────────────────┘ │
│ ☐ เฉพาะที่ต้องตรวจสอบ                       │  ← next_inspection_due overdue
│                                              │
│ ┌── ตาราง (table-responsive) ─────────────┐ │
│ │ หมายเลข  ขนาด  สถานะ      สถานที่       │ │
│ ├─────────────────────────────────────────┤ │
│ │ OXY-001  กลาง  [พร้อม]    ROOM-A        │ │  ← row tap → drawer
│ │ OXY-002  ใหญ่  [บนรถ]     AMB-TG4       │ │
│ │ OXY-003  เล็ก  [รอเติม]   SHELF-B       │ │
│ │ OXY-004  กลาง  [ซ่อมบำรุง] ROOM-A  ⚠  │ │  ← inspection overdue
│ │ OXY-005  กลาง  [ปลดระวาง] —      (grey)│ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

On mobile (<576 px): columns "เติมล่าสุด" and "ตรวจครั้งถัดไป" are hidden (`d-none d-sm-table-cell`). The ⚠ icon replaces them as a single visual cue. Tap the row to see all detail in the drawer.

#### 3.1.2 Wireframe @ 768 px+ (tablet / desktop)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ navbar                                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory][Ambulances][ถังออกซิเจน*][Settings][Sessions]│
├─────────────────────────────────────────────────────────────────────────────┤
│                                                         [+ เพิ่มถัง]         │
│ [สถานะ ▾]  [🔍 ค้นหมายเลขถัง          ]  [☐ เฉพาะที่ต้องตรวจ]             │
│                                                                               │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ หมายเลขถัง   ขนาด  สถานะ         สถานที่     เติมล่าสุด  ตรวจครั้งถัดไป│   │
│ ├───────────────────────────────────────────────────────────────────────┤   │
│ │ OXY-001      กลาง  [พร้อม]       ROOM-A      10/04/26    15/08/26    │   │
│ │ OXY-002      ใหญ่  [บนรถ]        AMB-TG4     28/03/26    01/09/26    │   │
│ │ OXY-003      เล็ก  [รอเติม]      SHELF-B     —           20/07/26    │   │
│ │ OXY-004      กลาง  [ซ่อมบำรุง]   ROOM-A      05/01/26    01/05/26 ⚠ │   │
│ │ OXY-005      กลาง  [ปลดระวาง]    —        (row muted/italic)         │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 3.1.3 Status badge colour specification

All badges use Bootstrap `badge` with both colour AND text label — never colour alone (WCAG 1.4.1).

| Status (enum) | Thai label | Bootstrap class | Hex |
|---|---|---|---|
| `ready` | พร้อม | `bg-stock-accent text-white` | #0d9488 (teal) |
| `on_board` | บนรถ | `bg-primary text-white` | Bootstrap blue |
| `refilling` | รอเติม | `bg-warning text-dark` | Bootstrap amber |
| `maintenance` | ซ่อมบำรุง | `bg-orange-subtle text-orange` (proposed new token — see §8.1) | #f97316 family |
| `retired` | ปลดระวาง | `bg-secondary text-white` | Bootstrap grey |

**Note on `maintenance` colour:** Bootstrap 5 does not have a built-in orange badge class distinct from warning. Proposed new CSS token:

```css
/* Proposed in shared/styles.css — add to Phase 5 CSS tokens block */
.badge-oxygen-maintenance {
  background-color: #f97316;  /* Tailwind orange-500 — harmonic with existing teal family */
  color: #fff;
}
```

This is the only new CSS token required. Flag to `frontend-developer`: add this to the Thegood Stock token block in `shared/styles.css` (line ~730 range).

#### 3.1.4 Filter bar options

**สถานะ dropdown:**

| Value | Label |
|---|---|
| `all` | ทั้งหมด (default) |
| `ready` | พร้อม |
| `on_board` | บนรถ |
| `refilling` | รอเติม |
| `maintenance` | ซ่อมบำรุง |
| `retired` | ปลดระวาง |

**"เฉพาะที่ต้องตรวจสอบ" checkbox:** filters to rows where `next_inspection_due <= today`. These rows always get a `⚠ bi-exclamation-triangle-fill text-warning` icon in the inspection date cell regardless of the checkbox state.

#### 3.1.5 Interaction states

| Element | Default | Loading | Empty | Error |
|---|---|---|---|---|
| Tank table body | rows, sorted by serial ASC | `<tr><td colspan="6">กำลังโหลด…</td></tr>` (text-muted, centered) | See §3.1.6 empty state | `<tr><td colspan="6" class="text-danger">โหลดข้อมูลถังไม่สำเร็จ — กดรีเฟรช</td></tr>` + [รีเฟรช] button |
| Status filter | `ทั้งหมด` | n/a | n/a | n/a |
| Serial search input | placeholder `ค้นหมายเลขถัง` | client-filters live on input | n/a | n/a |
| "+ เพิ่มถัง" | primary teal | n/a | n/a | inline modal error |
| Retired rows | `text-muted`, italic, greyed badge | n/a | n/a | n/a |
| ⚠ inspection due | icon + date shown in `text-warning fw-bold` | n/a | n/a | n/a |
| Realtime Realtime | row badge updates live when `oxygen_tanks` channel fires | brief flash animation (`.monitor-fade-in`) | n/a | fallback: toast "Realtime ขัดข้อง — รีเฟรชหน้า" |

#### 3.1.6 Empty state

```
┌─────────────────────────────────────────────┐
│                                              │
│       (icon: bi-wind, size 2.5rem)           │
│                                              │
│   ยังไม่มีถังออกซิเจนในระบบ                  │
│                                              │
│   กด "+ เพิ่มถัง" เพื่อลงทะเบียน           │
│   หมายเลขกระบอกแรก                           │
│                                              │
│   [+ เพิ่มถังออกซิเจน]                       │  ← btn-stock-primary
│                                              │
└─────────────────────────────────────────────┘
```

Empty state after filter with no results:
```
│   ไม่พบถังที่ตรงกับตัวกรอง                    │
│   [ล้างตัวกรอง]                               │
```

---

### 3.2 Admin — Add Tank Modal [S-5.2]

#### Context

Opened by "+ เพิ่มถัง". Admin-only. On save: INSERT `oxygen_tanks` then INSERT `oxygen_movements` (NULL → ready). Uses the existing `.modal .modal-dialog .modal-lg` pattern from Phase 1/2.

#### 3.2.1 Wireframe @ 360 px

```
┌─── modal (modal-fullscreen-sm-down on mobile) ─┐
│ เพิ่มถังออกซิเจน                          [✕]  │
├─────────────────────────────────────────────────┤
│ หมายเลขถัง (Serial) *                          │
│ [OXY-___________________________]               │  ← text input, placeholder hint
│ ℹ ตัวอักษรและตัวเลข 6–20 ตัว (เช่น OXY-0042)  │  ← form-text text-muted small
│                                                 │
│ ขนาดถัง *                                       │
│ [เล็ก / กลาง / ใหญ่       ▾]                   │  ← form-select
│                                                 │
│ สถานที่จัดเก็บเริ่มต้น *                         │
│ [— เลือกสถานที่ — ▾]                            │  ← location picker (same as Phase 1 Receive)
│                                                 │
│ วันตรวจสอบครั้งถัดไป                             │
│ [  วว/ดด/ปปปป  📅 ]                             │  ← date input, optional
│                                                 │
│ หมายเหตุ                                        │
│ [_____________________________________________] │  ← textarea 2 rows, optional
│                                                 │
│ ─────────────────────────────────────────────── │
│ [ยกเลิก]                    [บันทึก]            │  ← stack on mobile <400 px
└─────────────────────────────────────────────────┘
```

#### 3.2.2 Inline validation rules

| Field | Rule | Error copy |
|---|---|---|
| หมายเลขถัง | required | `กรุณาระบุหมายเลขถัง` |
| หมายเลขถัง | alphanumeric + dash/underscore, length 6–20 | `หมายเลขถังต้องมี 6–20 ตัวอักษร (ตัวเลขและอักษรภาษาอังกฤษ)` |
| หมายเลขถัง | unique — 409 from DB | `หมายเลขถังนี้มีอยู่แล้วในระบบ` (inline below field) |
| ขนาดถัง | required | `กรุณาเลือกขนาดถัง` |
| สถานที่ | required | `กรุณาเลือกสถานที่จัดเก็บ` |
| วันตรวจสอบ | optional, but if filled must be >= today | `วันตรวจสอบต้องเป็นวันในอนาคต` |

**Serial format note for PM / BA:** The spec says "alphanumeric, length 6–20" (spec §7.1.2). The client regex used: `/^[A-Za-z0-9\-_]{6,20}$/`. This allows dashes and underscores common in manufacturer serials (e.g., `OXY-0042`). If PM needs a stricter format (e.g., must start with `OXY-`), that must be specified — flag as **Q-O6** in §8.

#### 3.2.3 Interaction states

| State | Behavior |
|---|---|
| Modal opens | Focus on หมายเลขถัง input (first field) |
| All fields empty | [บันทึก] enabled but client validates on submit |
| Duplicate serial detected (409) | Inline error below field; button re-enables |
| Saving in progress | [บันทึก] becomes spinner + disabled; [ยกเลิก] disabled |
| Save success | Modal closes; toast `เพิ่มถัง {serial} แล้ว`; tank list refreshes (Realtime) |
| Save error (other) | toast `เพิ่มถังไม่สำเร็จ: {err}`; modal stays open for correction |

---

### 3.3 Admin — Tank Detail / History Drawer [S-5.3]

#### Context

Opens on any table row click. Implemented as a Bootstrap modal (`.modal-dialog.modal-lg`) for Phase 5, consistent with Phase 1/2 Item Detail Drawer pattern. Off-canvas upgrade is Phase 5.1 polish if PM requests it.

The modal has two regions: a **header** section (tank identity + current status) and a **history timeline** (oxygen_movements). The "เปลี่ยนสถานะ" action button is in the modal footer (Admin only; hidden for Employee role).

Realtime subscription on `oxygen_tanks` channel updates the header when another device changes the tank's status.

#### 3.3.1 Wireframe @ 360 px

```
┌─── modal (modal-fullscreen-sm-down on mobile) ─┐
│ OXY-001                                    [✕]  │  ← title = serial
│ [พร้อม]  กลาง  |  ROOM-A  |  เติม: 10/04/26    │  ← status badge + meta row
├─────────────────────────────────────────────────┤
│ ตรวจสอบครั้งถัดไป: 15/08/2026                  │
│ หมายเหตุ: —                                     │
│                                                 │
│ ── ประวัติการเปลี่ยนสถานะ ───────────────────── │
│                                                 │
│ ┌── รายการ 1 (most recent) ─────────────────┐  │
│ │ [บนรถ] → [พร้อม]                           │  ← transition icons
│ │ โดย: admin · 10/04/2026 14:22             │
│ │ หมายเหตุ: รถกลับฐาน เติมแก๊สแล้ว         │
│ │ [ภาพ: thumb 48×48]  (if photo_url)        │
│ └────────────────────────────────────────────┘  │
│                                                 │
│ ┌── รายการ 2 ────────────────────────────────┐  │
│ │ [พร้อม] → [บนรถ]                           │
│ │ โดย: staff01 · 09/04/2026 08:05           │
│ │ หมายเหตุ: —                                │
│ └────────────────────────────────────────────┘  │
│ … (scroll for older entries)                    │
│                                                 │
├─────────────────────────────────────────────────┤
│ [Export CSV] (Phase 5.1)    [เปลี่ยนสถานะ]      │
└─────────────────────────────────────────────────┘
```

Notes:
- "เปลี่ยนสถานะ" button is `btn-stock-primary` and is visible only when `user.role = 'Admin'`. Employee-role users see the drawer read-only (no footer button).
- "Export CSV" is stubbed as a disabled button with tooltip "เร็วๆ นี้ (Phase 5.1)" so the PM sees the intention without it being implemented.
- For **retired tanks**: the drawer header shows a `[ปลดระวาง]` badge and a notice "ถังนี้ปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้". The "เปลี่ยนสถานะ" button is hidden.

#### 3.3.2 Transition icon mapping

Each movement history entry uses a pair of Bootstrap Icons to communicate the transition visually without requiring the user to parse both status words:

| Transition | Icon pair | aria-label |
|---|---|---|
| NULL → ready | — → `bi-check-circle-fill text-success` | เริ่มต้น → พร้อม |
| ready → on_board | `bi-check-circle` → `bi-truck text-primary` | พร้อม → บนรถ |
| on_board → ready | `bi-truck` → `bi-check-circle-fill text-success` | บนรถ → พร้อม |
| on_board → refilling | `bi-truck` → `bi-droplet text-warning` | บนรถ → รอเติม |
| refilling → ready | `bi-droplet` → `bi-check-circle-fill text-success` | รอเติม → พร้อม |
| any → maintenance | — → `bi-tools text-orange` | → ซ่อมบำรุง |
| maintenance → ready | `bi-tools` → `bi-check-circle-fill text-success` | ซ่อมบำรุง → พร้อม |
| any → retired | — → `bi-x-octagon-fill text-secondary` | → ปลดระวาง |

The `text-orange` uses the same `badge-oxygen-maintenance` proposed token (§3.1.3). Apply as `color: #f97316` inline if the token isn't merged yet.

#### 3.3.3 Interaction states

| Element | Default | Loading | Empty | Error |
|---|---|---|---|---|
| Header | static after drawer opens | brief skeleton (`.placeholder` Bootstrap) on open | n/a | toast `โหลดข้อมูลถังไม่สำเร็จ` |
| History list | entries | `กำลังโหลดประวัติ…` (text-muted) | `— ยังไม่มีการเปลี่ยนสถานะ —` (initial tank has only the NULL→ready entry) | toast `โหลดประวัติไม่สำเร็จ` |
| Photo thumbnail | shown if `photo_url` present | `<img loading="lazy">` | nothing (no broken img) | nothing (onerror hide img) |
| Realtime update | header re-renders when status changes | badge updates in-place with `.monitor-fade-in` flash | n/a | n/a |

---

### 3.4 Admin — Log Transition Modal [S-5.4]

#### Context

Nested modal opened from Tank Detail Drawer footer → "เปลี่ยนสถานะ". Admin only.
The `to_status` selector shows ONLY the allowed transitions for the tank's current status (computed client-side, mirroring the server-side state machine table).

**CRITICAL design rule:** If the PM selects Q3 Option B (maintenance sub-reason enum), the sub-reason picker (§3.7) appears inside this modal when `to_status = 'maintenance'`. This section designs the modal for both Q3 options.

#### 3.4.1 Wireframe @ 360 px (Q3 Option A — free text, recommended)

```
┌─── modal: เปลี่ยนสถานะถัง ─────────────────────┐
│ เปลี่ยนสถานะ OXY-001                       [✕] │
│ สถานะปัจจุบัน: [พร้อม]                         │
├─────────────────────────────────────────────────┤
│ สถานะใหม่ *                                     │
│ (แสดงเฉพาะสถานะที่อนุญาต)                      │
│                                                 │
│  ○ [บนรถ]        ← ready → on_board             │
│  ○ [ซ่อมบำรุง]   ← any → maintenance           │
│  ○ [ปลดระวาง]    ← any → retired (⚠ ถาวร)      │
│                                                 │
│ (each option is a tap-card, min height 56 px)   │
│                                                 │
│ สถานที่ใหม่ (แสดงเมื่อสถานะเปลี่ยน) *           │  ← conditional
│ [— เลือกสถานที่ — ▾]                            │
│                                                 │
│ หมายเหตุ                                        │
│ [_____________________________________________] │
│ [_____________________________________________] │  ← textarea 2 rows
│                                                 │
│ แนบรูปภาพ (ไม่บังคับ)                           │  ← conditional on Q4
│ [📷 อัปโหลดรูป]                                 │
│                                                 │
│ ─────────────────────────────────────────────── │
│ [ยกเลิก]                    [บันทึก]            │
└─────────────────────────────────────────────────┘
```

#### 3.4.2 Retire confirmation pattern (irreversible action)

When user selects `[ปลดระวาง]` from the status options, a distinct warning section replaces the normal form footer:

```
│ ┌─── ⚠ คำเตือน: การดำเนินการนี้ย้อนกลับไม่ได้ ┐│
│ │                                              ││
│ │  ถังหมายเลข OXY-001 จะถูกปลดระวางถาวร        ││
│ │  ไม่สามารถเปลี่ยนสถานะได้อีก                ││
│ │                                              ││
│ │  หมายเหตุ (บังคับ เมื่อปลดระวาง) *           ││  ← required when retiring
│ │  [_______________________________________]   ││
│ └──────────────────────────────────────────────┘│
│                                                 │
│ [ยกเลิก]          [ปลดระวางถาวร]               │
│                    ↑ btn-outline-danger          │
│                    (NOT btn-danger — requires    │
│                     deliberate click, not a      │
│                     visually dominant CTA)       │
```

The retire confirm button is `.btn.btn-outline-danger` (not filled `.btn-danger`). This visual de-emphasis follows Nielsen H5 (error prevention) and makes the destructive path less salient than the cancel path. Two taps are required: (1) select `[ปลดระวาง]` option, (2) click `[ปลดระวางถาวร]` — not a single-tap.

Notes field is **required** (not optional) when retiring — forces the admin to document the reason.

#### 3.4.3 Conditional field logic

| Current status | Allowed to_status options | Location picker shown? | Note required? |
|---|---|---|---|
| ready | on_board, maintenance, retired | Yes (on_board changes location) | Only for retired |
| on_board | ready, refilling, maintenance, retired | Yes (ready may return to depot) | Only for retired |
| refilling | ready, maintenance, retired | Yes (ready returns to a location) | Only for retired |
| maintenance | ready, retired | Yes (ready goes back to a location) | Only for retired |
| retired | (none — no options shown) | — | — |

**Location picker visibility logic:** Show when `to_status` changes the tank's location (i.e., almost always). Except `on_board → refilling`: the tank doesn't physically move to a new storage location yet. In this case, hide the picker and keep `to_location_id = current`. Client-side logic.

#### 3.4.4 Photo field (conditional on Q4 PM decision)

- If **Q4 = Option A (optional):** Photo upload shown but labelled `แนบรูปภาพ (ไม่บังคับ)`. Single-tap to open device camera or file picker. Cloudinary upload via `shared/cloudinary.js`. On success, a thumbnail preview replaces the button; an "ลบ" link appears to remove.
- If **Q4 = Option B (required for specific transitions):** Photo field becomes mandatory (`*`) only for transitions specified by PM (e.g., `on_board → refilling`). For other transitions it remains optional. The form label changes to `แนบรูปภาพ *` and submit is blocked until photo uploaded.
- **Cross-phase dependency:** The Cloudinary photo-in-modal UX component is being designed by Phase 3 (Borrow/Return) in parallel. Phase 5 MUST reuse whatever component Phase 3 defines (spec §12 Q-Phase5-K). If Phase 3 FE lands first, reuse its component directly. If Phase 5 FE lands first, establish the pattern for Phase 3 to adopt. Coordinate via `shared/cloudinary.js`. Flag to `frontend-developer`: do not reinvent the Cloudinary widget — check with PM on Phase 3 status before implementing §3.4 photo field.

---

### 3.5 Staff — `staff-oxygen.html` (Dedicated Scan Flow) [S-5.5]

#### Recommendation on Q6: Dedicated page (Option A)

**Recommendation: New `staff-oxygen.html` page (Option A — consistent with spec recommendation).**

Rationale (for PM):
1. **Separate mental model.** Inventory scan (`staff-scan.html`) is about issuing/receiving consumable quantities. Oxygen scan is about changing the physical state of a specific serialised asset. They are different cognitive tasks. Mixing them via a mode toggle increases the risk of staff selecting the wrong mode under time pressure (ambulance departure imminent).
2. **Scan UX diverges fundamentally.** Inventory scan is a 3-step SKU+location+qty flow. Oxygen scan is a 7-step serial+status+location+note flow. A mode toggle would require the JS state machine to branch at step 1 and follow completely different paths — this is essentially two pages in one, adding hidden complexity with no UX benefit.
3. **Bookmarking + home screen icons.** Staff working exclusively with oxygen tanks can bookmark `staff-oxygen.html` on their phone home screen without navigating through a mode toggle. The current `staff.html` already supports linking to role-specific pages.
4. **Phase 3 precedent.** Phase 3 (Borrow/Return) is adding another staff flow. The pattern of separate pages per staff task type is established and should be continued.

Design note for Option B if PM overrides: a top-level mode toggle ("เบิก/จ่ายสินค้า | ถังออกซิเจน") at the top of `staff-scan.html` would switch between two independent sub-flows. The toggle must be ≥44 px tall and visually prominent (not a small pill). The JS complexity increase must be accepted.

#### 3.5.1 Staff scan page shell

The page `staff-oxygen.html` mirrors `staff.html` in structure: same navbar pattern, same Bootstrap/Sarabun links, same `shared/auth.js` guard. It is a completely standalone page.

#### 3.5.2 7-step state machine wireframes @ 360 px

**Step 1 — สแกน / พิมพ์หมายเลขถัง**

```
┌─────────────────────────────────────────────┐
│ Thegood Stock                       [ออก]   │  ← navbar
├─────────────────────────────────────────────┤
│ 🫧 ถังออกซิเจน                              │  ← page title (h5)
│ ขั้นที่ 1 / 7 · สแกนหมายเลขถัง              │  ← step indicator
├─────────────────────────────────────────────┤
│                                              │
│ [LIVE CAMERA   width:100% maxH:50vh]         │
│  ┌─────────────────────────┐                 │
│  │  viewfinder box overlay  │                │  ← CSS overlay (same as Phase 1 scanner)
│  └─────────────────────────┘                 │
│                                              │
│ หรือ พิมพ์หมายเลขแทน                        │  ← small link below camera
│ [___________________________] [ค้นหา]        │  ← text input + btn-outline-stock-accent
│                                              │
│ [เริ่มใหม่]                                  │  ← btn-outline-secondary
└─────────────────────────────────────────────┘
```

**Step 2 — แสดงข้อมูลถัง (confirm identity)**

```
┌─────────────────────────────────────────────┐
│ Thegood Stock                       [ออก]   │
├─────────────────────────────────────────────┤
│ ขั้นที่ 2 / 7 · ข้อมูลถัง                   │
├─────────────────────────────────────────────┤
│                                              │
│ ┌── island-card ──────────────────────────┐ │
│ │ OXY-001                                 │ │  ← serial (large, fw-bold)
│ │ [พร้อม]  กลาง  |  ROOM-A               │ │  ← status badge + size + location
│ │ ตรวจสอบถัดไป: 15/08/2026               │ │
│ └─────────────────────────────────────────┘ │
│                                              │
│ (ถ้าถังนี้ถูกปลดระวาง — ข้อความข้อผิดพลาด)   │
│ ┌── alert-danger ──────────────────────────┐ │
│ │ ⛔ ถังนี้ถูกปลดระวางแล้ว               │ │  ← only shown if retired
│ │    ไม่สามารถใช้งานได้                   │ │
│ └─────────────────────────────────────────┘ │
│                                              │
│ [สแกนใหม่]            [ถัดไป →]              │
│  (if retired: [ถัดไป] hidden)                │
└─────────────────────────────────────────────┘
```

"ไม่พบถัง" error state (if serial not found):

```
│ ┌── alert-warning ─────────────────────────┐ │
│ │ ⚠ ไม่พบถังหมายเลขนี้ในระบบ              │ │
│ └─────────────────────────────────────────┘ │
│ [สแกนใหม่]                                  │
```

**Step 3 — เลือกสถานะใหม่**

```
┌─────────────────────────────────────────────┐
│ Thegood Stock                       [ออก]   │
├─────────────────────────────────────────────┤
│ ขั้นที่ 3 / 7 · เลือกสถานะใหม่              │
│ (OXY-001 · ปัจจุบัน: พร้อม)                 │
├─────────────────────────────────────────────┤
│                                              │
│ ┌── tap-card  ──────────────────────────┐   │  ← min height: 60 px
│ │ 🚑  บนรถ                              │   │  ← ready → on_board (staff-allowed)
│ │     ขึ้นรถพยาบาลแล้ว                 │   │
│ └───────────────────────────────────────┘   │
│                                              │
│ (Only allowed transitions for staff shown.   │
│  maintenance and retired are HIDDEN for      │
│  Employee role — admin-only transitions.)    │
│                                              │
│ [← ย้อนกลับ]                                │
└─────────────────────────────────────────────┘
```

Tap-card visual: each option is a full-width card (`island-card`) with an icon, a Thai label, and a subtitle description. Selected state: `border-stock-accent` 2px + `bg-stock-accent-subtle`.

If current status is `on_board`, staff sees two options:
- `[พร้อม]` — รถกลับฐาน ถังยังมีแก๊ส
- `[รอเติม]` — ใช้แก๊สหมดแล้ว ต้องเติม

**Step 4 — เลือกสถานที่ (conditional)**

Shown when the selected transition changes location. E.g., `ready → on_board` requires selecting which ambulance.

```
┌─────────────────────────────────────────────┐
│ Thegood Stock                       [ออก]   │
├─────────────────────────────────────────────┤
│ ขั้นที่ 4 / 7 · เลือกสถานที่                │
├─────────────────────────────────────────────┤
│                                              │
│ สถานที่ใหม่ *                                │
│ [— เลือกสถานที่ — ▾]                         │  ← form-select, full-width
│                                              │
│ หรือสแกน QR ตู้/ชั้น                         │  ← small link (same scanner as Phase 1)
│                                              │
│ [← ย้อนกลับ]       [ถัดไป →]               │
└─────────────────────────────────────────────┘
```

Step 4 is **skipped** for `on_board → refilling` (tank stays at ambulance location until admin reassigns during refill batch completion).

**Step 5 — บันทึกหมายเหตุ (optional)**

```
┌─────────────────────────────────────────────┐
│ ขั้นที่ 5 / 7 · หมายเหตุ (ไม่บังคับ)        │
├─────────────────────────────────────────────┤
│                                              │
│ [_____________________________________________│
│  _____________________________________________│
│  ___________________________]                │  ← textarea 3 rows, full-width
│                                              │
│ [← ย้อนกลับ]       [ถัดไป →]               │
└─────────────────────────────────────────────┘
```

**Step 6 — ถ่ายรูป (conditional on Q4)**

Shown only if Q4 = Option B AND current transition is in the "requires photo" list defined by PM.

```
┌─────────────────────────────────────────────┐
│ ขั้นที่ 6 / 7 · ถ่ายรูปประกอบ *             │  ← * = required if Q4-B
├─────────────────────────────────────────────┤
│                                              │
│ ┌── photo preview area ───────────────────┐ │
│ │  [📷 กดเพื่อถ่ายรูป / อัปโหลด]          │ │  ← min-height 160 px, full-width
│ └─────────────────────────────────────────┘ │
│                                              │
│ (thumbnail replaces button after upload)     │
│                                              │
│ [← ย้อนกลับ]       [ถัดไป →]               │
└─────────────────────────────────────────────┘
```

**Step 7 — ยืนยันและบันทึก**

```
┌─────────────────────────────────────────────┐
│ ขั้นที่ 7 / 7 · ยืนยัน                      │
├─────────────────────────────────────────────┤
│                                              │
│ ┌── สรุปรายการ ───────────────────────────┐ │
│ │ ถัง:       OXY-001 (กลาง)              │ │
│ │ สถานะใหม่: บนรถ                        │ │
│ │ สถานที่:   AMB-TG4                      │ │
│ │ หมายเหตุ:  ออกเวร 09:00                │ │
│ └─────────────────────────────────────────┘ │
│                                              │
│                   [บันทึก]                   │  ← btn-stock-primary full-width ≥56 px
│ [← ย้อนกลับ]                                │
└─────────────────────────────────────────────┘
```

**Success overlay (after submit)**

```
┌─────────────────────────────────────────────┐
│                                              │
│          ✅ (bi-check-circle-fill teal 3rem) │
│                                              │
│   บันทึกแล้ว                                 │
│   OXY-001 → [บนรถ]                          │
│                                              │
│ [สแกนถังอื่น]          [กลับหน้าหลัก]       │
└─────────────────────────────────────────────┘
```

The overlay auto-dismisses after 3 s if user takes no action, then resets to Step 1.

**Error states in staff flow:**

| Error | Display | Recovery |
|---|---|---|
| ไม่พบถังหมายเลขนี้ (serial not found) | Inline `alert-warning` at Step 2 | [สแกนใหม่] — returns to Step 1 |
| ถังถูกปลดระวาง (retired) | Inline `alert-danger` at Step 2 | [สแกนใหม่] — returns to Step 1 |
| การเปลี่ยนสถานะนี้ไม่อนุญาต (state machine reject) | Toast `การเปลี่ยนสถานะนี้ไม่อนุญาต` + stays on Step 7 | [← ย้อนกลับ] to Step 3 |
| Network error on submit | Toast `บันทึกไม่สำเร็จ — ลองอีกครั้ง` + [ลองอีกครั้ง] button | Retry from Step 7 |

---

### 3.6 Dashboard — "สถานะถังออกซิเจน" Panel [S-5.6]

#### Placement decision

**Add as a new panel AFTER existing Phase 1 KPI panels.** Do NOT replace "สถานะอุปกรณ์ยืม-คืน" (Phase 3 placeholder) — Phase 3 is being specced in parallel and will need that slot.

The Phase 1 dashboard currently has panels for: (1) Stock KPIs, (2) Low-stock alerts, (3) Expiry timeline (Phase 2), (4) Borrow/Return placeholder (Phase 3). Phase 5 adds panel 5.

At 360 px with Bootstrap grid, panels stack vertically. Five panels is acceptable — the oxygen panel is compact (one row of count badges + optional alert).

#### 3.6.1 Wireframe @ 360 px

```
┌─── Panel 5: สถานะถังออกซิเจน ────────────────┐
│ 🫧 ถังออกซิเจน         [ดูทั้งหมด →]         │
├─────────────────────────────────────────────────┤
│                                                 │
│  [พร้อม: 8]  [บนรถ: 3]  [รอเติม: 4]           │  ← 3-column flex row
│  [ซ่อมบำรุง: 1]  [ปลดระวาง: 2]                │  ← wraps to 2nd row
│                                                 │
│ (if refilling count >= OXYGEN_REFILL_THRESHOLD:)│
│ ┌── alert-warning (amber) ──────────────────┐  │
│ │ ⚠ ถังรอเติม 4 ถัง — ถึงเกณฑ์แจ้งเตือน  │  │
│ │                  [จัดการถังรอเติม →]       │  │  ← deep-link to tab + refilling filter
│ └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Each count badge is a small `island-card`-like chip:

```
┌──────────┐
│ [พร้อม]  │  ← status badge (teal)
│   8      │  ← count (fs-4 fw-bold)
└──────────┘
```

Chips are tappable: tap a status chip → navigate to "ถังออกซิเจน" tab filtered to that status.

**"จัดการถังรอเติม →"** deep-link sets `?tab=oxygen&filter=refilling` in the URL hash (same deep-link pattern Phase 1 uses for low-stock alerts).

#### 3.6.2 Interaction states

| State | Behavior |
|---|---|
| No oxygen tanks yet | Panel shows "ยังไม่มีถังออกซิเจน — [+ เพิ่มถัง →]" |
| Count = 0 for a status | That chip shows `0` in `text-muted` (still shown so admin notices) |
| Refilling < threshold | No alert banner |
| Refilling >= threshold | Amber banner shows with deep-link button |
| Realtime update | Counts update in-place with `.monitor-fade-in` flash |

---

### 3.7 Maintenance Flagging UX (Conditional on Q3)

#### 3.7.1 If Q3 = Option A (free text only — recommended)

No special UI needed beyond the standard `note` textarea in the Log Transition modal (§3.4). The label gains a placeholder hint:

```
หมายเหตุ (เช่น ทดสอบแรงดัน / ซ่อมวาล์ว / บำรุงรักษาประจำปี)
```

The operator types the reason. History timeline shows it verbatim.

#### 3.7.2 If Q3 = Option B (sub-reason enum — segmented picker)

If PM specifies Option B, the Log Transition modal (§3.4) ADDS a sub-reason picker when `to_status = 'maintenance'`:

```
│ เหตุผลการซ่อมบำรุง *                            │
│ ┌─────── btn-group full-width ───────────────┐ │
│ │ ทดสอบ  │ ซ่อม  │ บำรุง  │ อื่นๆ           │ │
│ │ แรงดัน │ วาล์ว │ ประจำปี│                 │ │
│ └─────────────────────────────────────────────┘ │
```

This is a `btn-group[role="group"]` (Bootstrap 5 segmented control — same pattern as Phase 2 lot sub-view toggle). Each segment: min 44 px touch target.

The value is stored in `oxygen_movements.note` as a structured prefix (e.g., `[hydro_test] ซ่อมวาล์วหัวถัง`) since the spec does not add a `maintenance_reason` column in Phase 5. If Q3 = Option B requires a separate column, that is a schema change requiring PM + BA sign-off and a new migration.

**Contradiction flag:** The spec §5.3 defines `note text` with no `maintenance_reason` column. If PM chooses Q3 Option B with a formal enum column, the spec and migration files need updating before FE implements. Do NOT implement Option B without spec update.

---

## 4. Component Reuse Map

| Component needed | Reuse from | Notes |
|---|---|---|
| Navbar | `admin.html` `.navbar.bg-modern-primary.navbar-dark.px-3` | Unchanged |
| Nav-pill tabs | `.nav.nav-pills .nav-link.stock-tab` | Add new "ถังออกซิเจน" pill with `bi-wind` or `bi-droplet-fill` icon |
| Primary CTA button | `.btn.btn-stock-primary` | All "บันทึก" / "ยืนยัน" actions |
| Secondary CTA | `.btn.btn-outline-stock-accent` | All "สแกนใหม่", "ดูทั้งหมด →" actions |
| Destructive CTA | `.btn.btn-outline-danger` | "ปลดระวางถาวร" — outline, not filled |
| Modal shell | `.modal.modal-dialog.modal-lg` + `.modal-fullscreen-sm-down` | Add/Edit modal + Detail drawer + Transition modal |
| Form label style | `.form-label.small` | All form fields |
| Table | `.table.table-sm.align-middle.table-responsive` | Tank list table |
| Status badge | `.badge` + custom classes | Phase 5 adds `badge-oxygen-maintenance` (new token — §3.1.3) |
| Toast | `showToast(level, msg)` from `shared/ui.js` | All transient messages |
| Confirm dialog | `showConfirm(msg)` from `shared/ui.js` | Not used — retirement uses in-modal confirm (stronger pattern) |
| Island card | `.island-card` from `styles.css` line 405 | Step 2 tank card + Step 7 summary card + dashboard chips |
| Scanner widget | `shared/scanner.js` (Phase 1) | Step 1 camera scan (same `BarcodeDetector` / html5-qrcode fallback) |
| Location picker | Phase 1 Receive form location dropdown | Step 4 in staff flow + Add/Edit modal |
| `fadeIn` animation | `@keyframes fadeIn` in `styles.css` | Sub-view transitions |
| `monitor-fade-in` | `.monitor-fade-in` in `styles.css` | Realtime badge updates |
| Cloudinary upload | `shared/cloudinary.js` (Phase 0) | Photo field — coordinate with Phase 3 UX pattern |
| Step indicator | Not yet defined — **NEW small component** | "ขั้นที่ N / 7" progress line in staff flow |

**New component required — Step indicator:**

The staff scan flow needs a lightweight step progress indicator. Design:

```
──●──●──●──○──○──○──○──
  1  2  3  4  5  6  7
```

CSS-only: a `div.d-flex.gap-1.align-items-center` with dots (`.rounded-circle` 10px). Filled dots = `.bg-stock-accent`; empty dots = `.bg-secondary opacity-25`. No labels needed (the step heading text provides context). This is a ~5-line CSS-only component with no new external dependency.

---

## 5. Interaction State Diagrams

### 5.1 Admin "ถังออกซิเจน" Tab — State Machine

```
[PAGE LOAD]
     │
     ▼
[LOADING — กำลังโหลด…]
     │ REST SELECT oxygen_tanks
     ├── success → [TANK LIST with filters]
     └── error → [ERROR ROW + รีเฟรช button]

[TANK LIST]
     │ click row
     ▼
[DETAIL DRAWER OPENS]
     │ REST SELECT oxygen_movements WHERE tank_id=…
     ├── loading → [กำลังโหลดประวัติ…]
     ├── success → [HISTORY TIMELINE]
     └── error → [toast error, drawer stays open]

[DETAIL DRAWER — Admin]
     │ click "เปลี่ยนสถานะ"
     ▼
[LOG TRANSITION MODAL]
     │ select to_status (filtered allowed list)
     │ fill note / location / photo
     │ submit
     ├── success → [modal closes] → [toast บันทึกแล้ว] → [drawer header updates via Realtime]
     └── error → [toast error] → [modal stays for correction]

[+ เพิ่มถัง]
     │
     ▼
[ADD TANK MODAL]
     │ fill serial + size + location + inspection + notes
     │ submit
     ├── success → [modal closes] → [toast เพิ่มถัง serial แล้ว] → [list updates via Realtime]
     └── error (duplicate serial) → [inline error below serial field]
     └── error (other) → [toast error]
```

### 5.2 Staff Scan — 7-Step State Machine

```
Step 1: SCAN
     │ scan result OR manual type + ค้นหา
     ├── invalid format → client-side inline warning under text field
     └── submit serial
           │ REST SELECT oxygen_tanks WHERE serial=…
           ├── not found → Step 2 (ERROR state: ไม่พบถัง)
           └── found → Step 2 (FOUND state)

Step 2: DISPLAY TANK
     ├── retired → error state, [สแกนใหม่] only
     └── active → [ถัดไป]
           ▼ Step 3

Step 3: SELECT TO_STATUS
     │ tap option card
     └── → Step 4 (if location needed) OR Step 5 (if no location change)

Step 4: SELECT LOCATION (conditional)
     │ pick from dropdown OR scan QR
     └── → Step 5

Step 5: NOTE (optional)
     └── → Step 6 (if photo required by Q4-B) OR Step 7

Step 6: PHOTO (conditional)
     └── → Step 7

Step 7: CONFIRM
     │ tap [บันทึก]
     ├── submitting → button spinner + disabled
     ├── success → SUCCESS OVERLAY (3 s auto-dismiss → Step 1)
     └── error → toast + [ลองอีกครั้ง] stays on Step 7
```

### 5.3 Status Transition Flow (all actors)

```
NULL ──────────────────────────────► ready
                                      │
         (Admin only)                 │◄──── refilling (Admin only completes)
         maintenance ◄──────────────  │
              │                       │
         (Admin only)                 ▼
         maintenance ──► ready       on_board
                                      │
                                      ▼ (Staff or Admin)
                                   refilling
                                      │
                              ┌───────┘
                              ▼
                     (all states)
                         retired  ← TERMINAL (Admin only)
                      (no exit from retired)
```

**Staff-allowed transitions (highlighted for staff scan UX):**
- `ready → on_board`
- `on_board → ready`
- `on_board → refilling`

**Admin-only transitions:**
- `refilling → ready`
- `any → maintenance`
- `maintenance → ready`
- `any → retired`

---

## 6. Microcopy Table (All Thai Strings)

### 6.1 Navigation & Labels

| Location | Copy |
|---|---|
| Nav tab | `ถังออกซิเจน` |
| Tab icon | `bi-droplet-fill` (or `bi-wind` — confirm with PM; `bi-droplet-fill` is more universally understood for gas cylinders) |
| Page title (staff) | `ถังออกซิเจน` |
| Section header (dashboard panel) | `ถังออกซิเจน` |

### 6.2 Status Labels

| Status enum | Thai label | Context |
|---|---|---|
| `ready` | พร้อม | All surfaces |
| `on_board` | บนรถ | All surfaces |
| `refilling` | รอเติม | All surfaces |
| `maintenance` | ซ่อมบำรุง | All surfaces |
| `retired` | ปลดระวาง | All surfaces |

### 6.3 Tank Size Labels

| Size value | Thai label |
|---|---|
| `small` | เล็ก |
| `medium` | กลาง |
| `large` | ใหญ่ |

### 6.4 Admin Tank List

| Location | Copy |
|---|---|
| "+ เพิ่มถัง" button | `+ เพิ่มถัง` |
| Filter label | `สถานะ: ทั้งหมด` |
| Search placeholder | `ค้นหมายเลขถัง` |
| Inspection filter checkbox | `เฉพาะที่ต้องตรวจสอบ` |
| Table header: serial | `หมายเลขถัง` |
| Table header: size | `ขนาด` |
| Table header: status | `สถานะ` |
| Table header: location | `สถานที่` |
| Table header: last refill | `เติมล่าสุด` |
| Table header: next inspection | `ตรวจครั้งถัดไป` |
| Loading row | `กำลังโหลด…` |
| Empty — no tanks | `ยังไม่มีถังออกซิเจนในระบบ` |
| Empty CTA | `+ เพิ่มถังออกซิเจน` |
| Empty — no filter match | `ไม่พบถังที่ตรงกับตัวกรอง` |
| Clear filter | `ล้างตัวกรอง` |
| Error row | `โหลดข้อมูลถังไม่สำเร็จ — กดรีเฟรช` |
| Refresh button | `รีเฟรช` |

### 6.5 Add Tank Modal

| Location | Copy |
|---|---|
| Modal title | `เพิ่มถังออกซิเจน` |
| Field: serial | `หมายเลขถัง (Serial)` |
| Serial placeholder | `OXY-XXXX` |
| Serial hint | `ตัวอักษรและตัวเลข 6–20 ตัว (เช่น OXY-0042)` |
| Field: size | `ขนาดถัง` |
| Field: location | `สถานที่จัดเก็บเริ่มต้น` |
| Field: inspection date | `วันตรวจสอบครั้งถัดไป` |
| Field: notes | `หมายเหตุ` |
| Cancel button | `ยกเลิก` |
| Submit button | `บันทึก` |
| Toast success | `เพิ่มถัง {serial} แล้ว` |
| Toast error | `เพิ่มถังไม่สำเร็จ: {err}` |

### 6.6 Add Tank Validation Errors

| Rule | Error copy |
|---|---|
| Serial required | `กรุณาระบุหมายเลขถัง` |
| Serial invalid format | `หมายเลขถังต้องมี 6–20 ตัวอักษร (ตัวเลขและอักษรภาษาอังกฤษ)` |
| Serial duplicate | `หมายเลขถังนี้มีอยู่แล้วในระบบ` |
| Size required | `กรุณาเลือกขนาดถัง` |
| Location required | `กรุณาเลือกสถานที่จัดเก็บ` |
| Inspection date in past | `วันตรวจสอบต้องเป็นวันในอนาคต` |

### 6.7 Tank Detail Drawer

| Location | Copy |
|---|---|
| Section header | `ประวัติการเปลี่ยนสถานะ` |
| Loading history | `กำลังโหลดประวัติ…` |
| Empty history | `— ยังไม่มีการเปลี่ยนสถานะ —` |
| Error history | `โหลดประวัติไม่สำเร็จ` |
| Change status button | `เปลี่ยนสถานะ` |
| Export CSV button (stubbed) | `Export CSV` |
| Export CSV tooltip | `เร็วๆ นี้ (Phase 5.1)` |
| Retired notice | `ถังนี้ปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้` |

### 6.8 Log Transition Modal

| Location | Copy |
|---|---|
| Modal title | `เปลี่ยนสถานะถัง` |
| Current status label | `สถานะปัจจุบัน:` |
| Field: new status | `สถานะใหม่` |
| Status note | `(แสดงเฉพาะสถานะที่อนุญาต)` |
| on_board option subtitle | `ขึ้นรถพยาบาลแล้ว` |
| ready option subtitle (from on_board) | `รถกลับฐาน ถังยังมีแก๊ส` |
| refilling option subtitle | `ใช้แก๊สหมดแล้ว ต้องเติม` |
| maintenance option subtitle | `ส่งซ่อมหรือทดสอบ` |
| retired option subtitle | `ปลดระวางถาวร` |
| Field: location | `สถานที่ใหม่` |
| Field: note | `หมายเหตุ` |
| Note placeholder (maintenance) | `เช่น ทดสอบแรงดัน / ซ่อมวาล์ว / บำรุงรักษาประจำปี` |
| Photo field (optional) | `แนบรูปภาพ (ไม่บังคับ)` |
| Photo field (required, Q4-B) | `แนบรูปภาพ` |
| Photo upload button | `📷 อัปโหลดรูป` |
| Retire warning title | `คำเตือน: การดำเนินการนี้ย้อนกลับไม่ได้` |
| Retire warning body | `ถังหมายเลข {serial} จะถูกปลดระวางถาวร ไม่สามารถเปลี่ยนสถานะได้อีก` |
| Retire note label | `หมายเหตุ (บังคับ เมื่อปลดระวาง)` |
| Retire confirm button | `ปลดระวางถาวร` |
| Cancel | `ยกเลิก` |
| Submit (non-retire) | `บันทึก` |
| Toast success | `บันทึกแล้ว` |
| Toast error | `บันทึกไม่สำเร็จ: {err}` |

### 6.9 State Machine Error Messages (exact — must not be paraphrased)

These are the exact error strings from the DB trigger (spec §5.4). The UI maps them to user-facing toasts:

| DB error string | UI toast copy |
|---|---|
| `ถังหมายเลข {serial} ถูกปลดระวางแล้ว ไม่สามารถเปลี่ยนสถานะได้` | `ถังนี้ถูกปลดระวางแล้ว ไม่สามารถใช้งานได้` |
| `สถานะปัจจุบันของถัง ({current}) ไม่ตรงกับ from_status ({supplied})` | `ข้อมูลสถานะขัดแย้ง — รีเฟรชและลองอีกครั้ง` |
| `การเปลี่ยนสถานะถัง {from} → {to} ไม่ได้รับอนุญาต` | `การเปลี่ยนสถานะนี้ไม่อนุญาต` |

The DB error strings from spec §5.4 are the authoritative trigger error text. The UI does NOT display raw DB messages to users — it maps them to the Thai toast copy above using error string matching (`error.message.includes('ถูกปลดระวาง')`).

### 6.10 Staff Scan Flow

| Location | Copy |
|---|---|
| Page title | `ถังออกซิเจน` |
| Step 1 heading | `สแกนหมายเลขถัง` |
| Step 1 indicator | `ขั้นที่ 1 / 7 · สแกนหมายเลขถัง` |
| Manual type link | `หรือ พิมพ์หมายเลขแทน` |
| Manual input placeholder | `เช่น OXY-0042` |
| Manual search button | `ค้นหา` |
| Reset button | `เริ่มใหม่` |
| Step 2 heading | `ข้อมูลถัง` |
| Not found error | `ไม่พบถังหมายเลขนี้ในระบบ` |
| Retired error | `ถังนี้ถูกปลดระวางแล้ว ไม่สามารถใช้งานได้` |
| Step 3 heading | `เลือกสถานะใหม่` |
| Step 3 sub | `ปัจจุบัน: {status_thai}` |
| Step 4 heading | `เลือกสถานที่` |
| QR scan location link | `หรือสแกน QR ตู้/ชั้น` |
| Step 5 heading | `หมายเหตุ (ไม่บังคับ)` |
| Step 5 placeholder | `(เว้นว่างได้)` |
| Step 6 heading | `ถ่ายรูปประกอบ` |
| Step 7 heading | `ยืนยัน` |
| Summary: tank | `ถัง:` |
| Summary: new status | `สถานะใหม่:` |
| Summary: location | `สถานที่:` |
| Summary: note | `หมายเหตุ:` |
| Submit button | `บันทึก` |
| Success title | `บันทึกแล้ว` |
| Success subtitle | `{serial} → [{new_status_thai}]` |
| Scan another | `สแกนถังอื่น` |
| Go home | `กลับหน้าหลัก` |
| Submit error toast | `บันทึกไม่สำเร็จ — ลองอีกครั้ง` |
| Retry button | `ลองอีกครั้ง` |
| Transition not allowed toast | `การเปลี่ยนสถานะนี้ไม่อนุญาต` |
| Back button | `← ย้อนกลับ` |
| Next button | `ถัดไป →` |
| Scan new | `สแกนใหม่` |

### 6.11 Dashboard Panel

| Location | Copy |
|---|---|
| Panel heading | `ถังออกซิเจน` |
| "View all" link | `ดูทั้งหมด →` |
| Empty state | `ยังไม่มีถังออกซิเจน` |
| Empty state CTA | `+ เพิ่มถัง →` |
| Refill threshold alert | `ถังรอเติม {n} ถัง — ถึงเกณฑ์แจ้งเตือน` |
| Threshold CTA | `จัดการถังรอเติม →` |

---

## 7. Accessibility Notes

### 7.1 Color contrast

| Element | Foreground | Background | Ratio | Pass? |
|---|---|---|---|---|
| Body text | #333 | #fff | 12.6:1 | AA + AAA |
| พร้อม badge text | #fff | #0d9488 | 4.55:1 | AA |
| บนรถ badge text | #fff | Bootstrap primary #0d6efd | 4.56:1 | AA |
| รอเติม badge text | #000 (text-dark) | Bootstrap warning #ffc107 | 5.74:1 | AA |
| ซ่อมบำรุง badge text | #fff | #f97316 | 3.0:1 | AA (large text ≥18px) — BORDERLINE |
| ปลดระวาง badge text | #fff | Bootstrap secondary #6c757d | 4.49:1 | AA |
| Teal CTA text | #fff | #0d9488 | 4.55:1 | AA |

**Maintenance badge contrast note:** The proposed `#f97316` orange with white text hits exactly 3.0:1, which passes for large text (badge text is typically `0.75rem` = 12px — NOT large text). Risk: fails AA for small text. Recommendation: Use `#d97706` (Tailwind amber-600) instead, which gives 4.5:1 with white. Proposed token:

```css
.badge-oxygen-maintenance {
  background-color: #d97706;  /* amber-600 — passes AA with white text */
  color: #fff;
}
```

Flagging this to `frontend-developer`: verify contrast at final font size before shipping.

### 7.2 Tap targets (staff flow — critical)

| Element | Minimum size | Rationale |
|---|---|---|
| Transition option cards (Step 3) | min-height: 60 px, full-width | Gloved-hand use, primary decision step |
| [บันทึก] submit (Step 7) | min-height: 56 px, full-width | Most-tapped element in the flow |
| [ถัดไป →] / [← ย้อนกลับ] | min-height: 44 px, min-width: 80 px | Navigation — WCAG 2.5.5 minimum |
| [สแกนใหม่] / [เริ่มใหม่] | min-height: 44 px | Error recovery |
| Dashboard status chips | min-height: 48 px, min-width: 80 px | Tap to filter — used with phone thumb |

### 7.3 ARIA and screen reader

- Tank status badge: wrap in `<span aria-label="{status_thai}">`. E.g., `<span class="badge bg-stock-accent" aria-label="พร้อม">พร้อม</span>`.
- Inspection warning icon: `<span aria-label="ต้องตรวจสอบ"><i class="bi bi-exclamation-triangle-fill text-warning"></i></span>`.
- Modal: `role="dialog" aria-modal="true" aria-labelledby="modal-title"` on every modal.
- Step indicator: `<nav aria-label="ขั้นตอน">` wrapper with step dots; each dot `aria-current="step"` for active step.
- Scanner video: `aria-label="ภาพจากกล้องสำหรับสแกนหมายเลขถัง"` (matches Phase 1 pattern).
- Retired rows: add `aria-disabled="true"` to the table row, not `disabled` (table rows are not form elements).
- History timeline entries: each entry should be in `<li>` inside `<ul aria-label="ประวัติการเปลี่ยนสถานะ">` for screen-reader listitem semantics.
- Transition option cards (Step 3): `role="radio"` + `aria-checked` within `role="radiogroup"`. This is more semantically correct than `role="button"` for a single-choice selection.

### 7.4 Keyboard navigation (admin power users)

- Drawer opens: focus moves to drawer title (h5 or h4) or first interactive element.
- Log Transition modal: focus moves to the first option card (tab navigates through option cards, Space selects, Enter submits when a valid option is selected).
- Retire confirmation: focus must land on [ยกเลิก] by default — not on [ปลดระวางถาวร]. This implements Nielsen H5 (error prevention) via keyboard UX.
- ESC closes any modal; Bootstrap default handles this.
- Tab order: filter bar → "+ เพิ่มถัง" → table rows (each row `tabindex="0"` + Enter to open drawer) → drawer close button. This is the visual DOM order.

### 7.5 Reduced motion

- All `.monitor-fade-in` status updates and `.fadeIn` animations use `@media (prefers-reduced-motion: reduce)` in `shared/styles.css` (Phase 1 already uses these keyframes — verify existing styles.css has the reduced-motion media query; if not, flag to `frontend-developer`).
- Success overlay animation (checkmark pulse) must be suppressed under reduced-motion.

---

## 8. Open UX Questions for PM

**Status on each Phase 5 spec Q1–Q6:** Design produces wireframes for BOTH paths where applicable. PM must answer before `frontend-developer` starts implementation.

---

**Q-O1 — Admin nav overflow at 360 px (7 tabs)**

The current shell has 5 tabs. Phase 1 adds Inventory (6). Phase 5 adds ถังออกซิเจน (7). At 360 px, `flex-wrap gap-1` wraps to 2 rows. Options:

- **Option A:** Accept 2-row nav. The existing `flex-wrap` handles this gracefully.
- **Option B:** Move "Sessions" (low-frequency admin tab) inside Settings sub-tab. Net: 6 primary tabs.
- **Option C:** Horizontal scroll on nav (`overflow-x: auto; white-space: nowrap`). Keeps 1 row but makes far tabs non-discoverable without scrolling.

**Designer recommendation:** Option B. "Sessions" is an IT-admin view used rarely; collapsing it into Settings reduces the nav to 6 tabs and avoids 2-row overflow at 360 px. Requires PM sign-off on the Sessions tab reorganisation — this is scope beyond Phase 5 strictly.

---

**Q-O2 — Phase 5 spec Q1: Tank size enum**

Spec recommends 3 sizes: small/medium/large. Thai labels above use เล็ก/กลาง/ใหญ่. If PM wants a 4th size (`extra_large` = ใหญ่พิเศษ), the dropdown and filter bar simply gain a 4th option — no layout change needed. **PM decision needed before FE starts.**

---

**Q-O3 — Phase 5 spec Q2: Refill threshold default (5)**

Dashboard alert banner uses `OXYGEN_REFILL_THRESHOLD` from settings. The default 5 is acceptable for wireframe purposes. The Settings tab already allows admin to edit this value. No design change regardless of PM answer.

---

**Q-O4 — Phase 5 spec Q3: Maintenance sub-reason (free text vs enum picker)**

Both options are designed above (§3.7). The design impact is small:
- Option A: note textarea gets a helpful placeholder (§6.8 "หมายเหตุ placeholder (maintenance)").
- Option B: `btn-group` segmented picker added to Log Transition modal for `to_status = maintenance`. Adds ~60 px of height to the modal. No new CSS needed.

**Designer recommendation:** Option A (free text). Lower staff friction; maintenance reasons are often unique to each incident. Sub-reason enum creates false precision. If compliance reporting requires structured data, add at Phase 5.1 with a proper schema change.

---

**Q-O5 — Phase 5 spec Q4: Photo proof requirement**

Design is built for Option A (optional). If PM specifies Option B (required for specific transitions), the transitions list must be provided to the designer so the `*` required marker can be added to the correct steps. **PM must specify the list if choosing Option B.**

Additionally: **if PM chooses Option B and Phase 3 (Borrow/Return) is implementing the Cloudinary modal component first**, Phase 5 FE must wait for or reuse that component. Designer strongly recommends sequencing Phase 3 FE before Phase 5 FE if photo is required.

---

**Q-O6 — Serial number format enforcement**

The spec (§7.1.2) says "alphanumeric, length 6–20" but gives the example `OXY-0042` which contains a dash. The client regex in this design is `/^[A-Za-z0-9\-_]{6,20}$/` (allows dashes and underscores). If PM or operations has a specific manufacturer serial format (e.g., must start with `OXY-`, or must be purely numeric), the regex and validation copy (§6.6) need updating.

**Designer recommendation:** Keep the permissive regex. Strict format enforcement should come from the physical label format on the cylinders — if all cylinders have a known format, specify it.

---

**Q-O7 — Hide / show retired tanks (default visibility)**

Retired tanks must remain visible per spec (§12 Q-Phase5-J). However, as the tank fleet grows over years, retired tanks could dominate the list. Consider adding a "ซ่อนถังปลดระวาง" toggle (default: on, hiding retired). PM decision on default behaviour.

**Designer recommendation:** Default hide retired tanks; show a "แสดงถังปลดระวาง ({n})" link at the bottom of the list. This matches the pattern of how inactive items are handled in the Phase 1 Items list (where `active=false` rows are hidden until checked).

---

**Q-O8 — Pressure reading capture**

The `oxygen_tanks.last_pressure_psi` column exists. No UI is currently designed to capture this value — the spec says Phase 5 only stores "the most recent reading" and pressure history is Phase 5.1. Should Phase 5 include a PSI field in the Log Transition modal (e.g., when transitioning `refilling → ready`, record the fill pressure)?

Options:
- **Option A:** Add optional PSI number input to the Log Transition modal. Simple; uses `<input type="number" min="0" max="4000">`. Stored in `oxygen_tanks.last_pressure_psi`.
- **Option B:** Defer PSI capture entirely to Phase 5.1.

**Designer recommendation:** Option A — the DB column exists, the field is optional, and the effort is minimal. Adding it later requires a second modal redesign review. Proposed copy: `ความดัน (PSI, ไม่บังคับ)` with `type="number"` input. No slider (sliders are imprecise on mobile; number pad is more accurate for a known value).

---

## Cross-Phase Coordination Notes

### 9.1 Cloudinary photo-in-modal pattern

Phase 3 (Borrow/Return) is being specced in parallel and will establish the Cloudinary upload UX inside a modal. The exact component interface (button, progress indicator, thumbnail preview, remove link) is **undefined until Phase 3 FE implements it**.

Action items:
1. `frontend-developer` implementing Phase 5 must check with PM on Phase 3 status.
2. If Phase 3 FE is already done: reuse the Cloudinary modal widget component verbatim.
3. If Phase 5 FE lands first: define the component in `shared/cloudinary.js` with the interface described in §3.4.4, document the interface for Phase 3 to adopt.
4. Cloudinary folder for Phase 5: `thegood-stock/oxygen/{tank_serial}/` (spec §5.3, §12 Q-Phase5-H). This is distinct from Phase 3 (`thegood-stock/borrow/`).

### 9.2 Tab placement in admin.html

The spec (§7.1) places the "ถังออกซิเจน" tab after "Inventory". The `frontend-developer` must add:
1. A new nav-pill `<li>` after the Inventory pill in `admin.html`.
2. A new `<div id="tab-oxygen" class="tab-pane d-none"></div>`.
3. Register the tab slug `oxygen` in `js/admin-shell.js` (the existing tab registry pattern).
4. Add `js/oxygen.js` and `js/oxygen-history.js` as `<script>` tags.

### 9.3 Dashboard panel integration

The existing Phase 1 dashboard (`js/dashboard.js`) will receive the new oxygen panel. The `frontend-developer` must ensure the panel loads only after `oxygen_tanks` table exists (i.e., Phase 5 migrations have been deployed). A try/catch on the aggregate query with a graceful "ถังออกซิเจน: ยังไม่พร้อมใช้งาน" fallback will handle pre-migration states.

---

## 10. Hand-off Checklist for `frontend-developer`

### Files to create (Phase 5 FE only)
- [ ] `staff-oxygen.html` — page shell mirroring `staff.html` structure
- [ ] `js/staff-oxygen.js` — 7-step wizard state machine
- [ ] `js/oxygen.js` — admin tank list, filter, add/edit modal
- [ ] `js/oxygen-history.js` — detail drawer + history timeline
- [ ] `shared/oxygen-client.js` — REST helpers (`listTanks`, `getBySerial`, `logTransition`, `addTank`)

### Files to edit
- [ ] `admin.html` — add "ถังออกซิเจน" nav pill and tab-pane div
- [ ] `js/admin-shell.js` — register `oxygen` tab slug
- [ ] `js/dashboard.js` — add oxygen panel (Panel 5)
- [ ] `shared/styles.css` — add `.badge-oxygen-maintenance { background-color: #d97706; color: #fff; }` in Phase 5 token block
- [ ] `sw.js` — add `staff-oxygen.html` + new JS files to cache list; bump `CACHE_VERSION`

### Design components to implement new
- [ ] Step indicator dots (§4 "New component required")
- [ ] Tank status badge colour mapping (§3.1.3)
- [ ] Transition icon mapping for history timeline (§3.3.2)
- [ ] Retire confirmation in-modal pattern (§3.4.2)
- [ ] Transition option tap-cards with radio semantics (§7.3)
- [ ] Cloudinary photo field (coordinate with Phase 3 — §9.1)

### Design components to reuse (no new code)
- [ ] `.island-card` (Phase 0 styles.css line 405)
- [ ] `showToast(level, msg)` (shared/ui.js)
- [ ] `shared/scanner.js` camera widget
- [ ] `.monitor-fade-in` animation
- [ ] `@keyframes fadeIn`
- [ ] Phase 1 location picker dropdown
- [ ] Bootstrap modal shell + modal-fullscreen-sm-down

### Open items before implementation starts
- [ ] PM answers spec Q1–Q6 (§8 above maps each question)
- [ ] Phase 3 FE status — coordinate Cloudinary modal (§9.1)
- [ ] Nav overflow strategy confirmed (Q-O1)
- [ ] Retire default visibility confirmed (Q-O7)
- [ ] PSI capture decision (Q-O8)

---

**Status: DRAFT — pending PM review + Phase 5 spec Q1–Q6 resolution**

**Files read in producing this design:**
- `docs/superpowers/specs/2026-05-19-phase5-oxygen-tanks-design.md` (the spec)
- `docs/superpowers/designs/2026-05-18-phase1-ui-design.md` (Phase 1 design patterns)
- `docs/superpowers/designs/2026-05-18-phase2-ui-design.md` (Phase 2 design patterns)
- `admin.html` (admin shell)
- `staff.html` (staff shell)
- `shared/styles.css` (design tokens)
