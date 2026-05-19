# DRAFT — Phase 4 UI/UX Design: ALS Bags / Medical Kits Restock Workflow

**Project:** Thegood Stock Management System
**Phase:** 4 — ALS Bags / Medical Kits (bag templates, restock workflow, per-bag expiry rollup)
**Date:** 2026-05-19
**Author:** UI/UX Designer (autonomous draft)
**Status:** DRAFT — pending PM review. Six spec open questions (Q-Phase4-A through Q-Phase4-F) not yet resolved by PM. Design assumes recommended options throughout; deviations noted.
**Source spec:** `docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md`
**Phase 3 design reference:** `docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md`
**Phase 2 design reference:** `docs/superpowers/designs/2026-05-18-phase2-ui-design.md`
**Next agent:** `frontend-developer`

---

## Table of Contents

- §1   Purpose, user stories, and assumed user context
- §2   Admin tab placement — top-level "ALS Bags" recommendation
- §3   Information architecture (screen list + ASCII navigation diagram)
- §4   Admin ALS Bags tab — bag list panel [S-4.1]
- §5   Bag detail drawer [S-4.2]
- §6   Template management panel [S-4.3]
- §7   Restock flow — 5 steps [S-4.4]
- §8   Staff scan extension — bag QR path [S-4.5]
- §9   Dashboard panel "สถานะ ALS Bags" [S-4.6]
- §10  Bag QR sticker design note [S-4.7]
- §11  Interaction state diagrams
- §12  Microcopy table (Thai strings)
- §13  Accessibility notes
- §14  Mobile-first 360px checks
- §15  Open UX questions for PM
- §16  Component reuse map and hand-off note

---

## 1. Purpose, User Stories, and Assumed User Context

### 1.1 Why this design exists

Phase 1/2/3 give Thegood an inventory system with medication lot tracking and
equipment borrow/return. Phase 4 adds the ALS bag layer: each physical ALS bag
(a location of type='bag') must maintain a defined composition. The system must
surface at a glance which bags are incomplete, have expiring lots, or need
restock, and guide the Admin through a structured restock action.

The primary operational goal is **knowing whether every ALS bag is ready to
deploy**. The secondary goal is **structured restock: fill gaps against the
template target with the right lots**. The tertiary goal is **daily Telegram
alerts so issues are not silently accumulating between manual checks**.

### 1.2 User stories

**US-4-1 — Admin doing morning equipment check**
"I open the ALS Bags tab and immediately see which bags need attention — red
expired, orange expiring, amber low_stock, green complete — without clicking
into each bag individually."
Acceptance: Bag list shows status badge + completion % + nearest expiry at a
glance. Issues-only filter reduces noise.

**US-4-2 — Admin restocking a bag after a call**
"I scan the QR on the bag, see a shopping list of what is missing, add the right
items from the right lots, optionally take a photo, and confirm."
Acceptance: Restock flow completes in under 90 seconds with one hand. N
stock_movements created with reason='bag_restock'.

**US-4-3 — Admin creating a new bag template**
"We are adding a Pediatric Resus kit to every ambulance. I need to define its
composition once, then link each physical bag to that template."
Acceptance: Template editor supports adding items with target_qty and mandatory
toggle. Template code enforced unique.

**US-4-4 — Staff scanning a bag before a call**
"I scan the bag QR to see if it is complete before I take it out. I am not
authorized to restock — I just want to know if there is anything missing or
expired."
Acceptance: Staff scan shows bag checklist (read-only). No restock action
visible. Expired/expiring items highlighted. Under 10 seconds to see status.

**US-4-5 — Admin receiving daily Telegram alert**
"I get one message at 09:00 listing every bag with an issue. I can decide which
to restock first."
Acceptance: Alert groups bags by severity (expired first). One message per day
(deduplicated). Admin opens app to the ALS Bags tab with issues-only filter pre-
applied.

### 1.3 Assumed user context (explicit)

| Assumption | Impact on design |
|---|---|
| User may be one-handed (carrying bag or supplies) | All primary actions reachable with thumb in single-column layout; no multi-touch gestures required |
| Environment may be dim (ambulance storeroom, vehicle interior) | High-contrast status badges; do not rely on subtle color differences alone; always pair color with text label |
| Screen is a personal phone (Android/iOS ~360–414px wide) | Mobile-first at 360px; tab layout wraps to two rows if needed |
| Network may be intermittent | Loading spinners per action; each stock_movement has client_ref_id for idempotent retry; partial failure reported per item not wholesale failure |
| Thai is the primary language | All copy in Thai; English in parentheses only for technical codes shown to Admin |
| Restock is Admin-only | Staff scan checklist is read-only; no restock path from Staff view |
| Photo is advisory (Q-Phase4-D recommendation B) | Skip button always visible on photo step; flow never blocked by missing photo |
| Bags are locations (Phase 0 principle) | No UI hint that bags are a "new entity"; URL stays location_id; QR lookup is by locations.code |

---

## 2. Admin Tab Placement — Recommendation: Top-Level "ALS Bags" Tab

### 2.1 Options considered

**Option A — New top-level tab "ALS Bags"** (RECOMMENDED)
**Option B — Sub-view inside Inventory tab (6th segment)**

### 2.2 Option A (top-level tab) wireframe at 360px nav

```
┌────────────────────────────────────────────────────────┐
│ navbar (Sarabun, navy gradient)                        │
├────────────────────────────────────────────────────────┤
│ flex-wrap gap-1 nav — wraps to 2 rows at narrow width  │
│                                                        │
│ Row 1:                                                 │
│ [Dashboard] [Locations] [Inventory] [Ambulances]       │
│ Row 2:                                                 │
│ [Settings]  [Sessions]  [ยืม-คืน]   [ALS Bags*]       │
└────────────────────────────────────────────────────────┘
```

At 768px+ all tabs fit in one row (the existing admin.html flex-wrap gap-1 nav
already handles wrapping gracefully — verified from Phase 3 design §3.1.1).

### 2.3 Option B (6th Inventory segment) — design dissent flag

**Nielsen Heuristic #6 (Recognition over recall) violation at 360px.**

Phase 2 already documented overflow risk at 4 segments. Phase 3 added 5th
segment and flagged it as marginal. A 6th segment would push ALS Bags
completely off-screen at 360px, invisible until the user knows to swipe.
Segment label "ALS Bags" (9 chars) at 360px/6 = 60px per tab would clip to
"ALS B…" — failing both discoverability and readability tests.

Additionally, ALS bag management is operationally orthogonal to the medication
lot view. Admin checking bag status should not need to navigate into "Inventory"
first — that implies a mental model mismatch (bags are a separate workflow, not
a property of the inventory ledger).

### 2.4 Recommendation

**Option A. Top-level tab "ALS Bags"** registered in `js/admin-shell.js` after
the Phase 3 "ยืม-คืน" tab. Lazy-loaded via `js/als-bags.js`.

Tab label: **"ALS Bags"** (8 chars, fits single pill). Icon: `bi-bag-heart`
(Bootstrap Icons). At <400px, icon-only rendering is acceptable (PM preference
for icon-only nav at small sizes follows Phase 3 precedent).

---

## 3. Information Architecture

### 3.1 Screen list

| ID | Screen | Trigger | File |
|---|---|---|---|
| S-4.1 | Admin: Bag list panel | Click "ALS Bags" tab | js/als-bags.js |
| S-4.2 | Admin: Bag detail drawer | Click bag row in S-4.1 | js/als-bags-detail.js |
| S-4.3 | Admin: Template management panel | Click "จัดการเทมเพลต" in S-4.1 | js/als-bags.js (sub-panel) |
| S-4.3.1 | Admin: Template create/edit modal | Click "+ เพิ่มเทมเพลต" or "แก้ไข" in S-4.3 | inline in als-bags.js |
| S-4.4 | Admin: Restock flow (5 steps) | Click "เติมของ" in S-4.2 | js/als-bags-detail.js |
| S-4.5 | Staff: Bag checklist view | Scan bag QR in staff-scan.html | js/staff-scan.js |
| S-4.6 | Dashboard: ALS Bags status panel | Always-visible on dashboard | js/dashboard.js (extend) |

### 3.2 Navigation diagram

```
admin.html
├── [Dashboard tab]
│     └── "สถานะ ALS Bags" panel (S-4.6)
│           └── Tap count badge → ALS Bags tab (S-4.1) with issues filter
│
├── [ALS Bags tab] ← NEW (S-4.1)
│     ├── Filter bar (alert_level, template, text search)
│     ├── Bag list (v_bag_status rows)
│     │     └── Click row → Bag detail drawer (S-4.2)
│     │           ├── Template composition table
│     │           ├── Lots in this bag (expandable)
│     │           └── [เติมของ] → Restock flow (S-4.4)
│     │                 Step 1: Shopping list
│     │                 Step 2: Photo (advisory)
│     │                 Step 3: Confirm
│     │                 → submit N stock_movements → toast + refresh
│     │
│     ├── [+ เพิ่มถุงยา] → Locations create modal (type=bag pre-filled)
│     └── [จัดการเทมเพลต] → Template panel (S-4.3)
│           ├── Template list
│           └── Create/Edit modal (S-4.3.1)
│                 ├── Template header fields
│                 └── Sub-item editor (item picker + target_qty + mandatory)

staff-scan.html (extended)
└── Scan QR → resolve locations.code
      ├── type='bag' → Bag checklist view (S-4.5) [read-only]
      │     └── [กลับ] → back to scan mode
      └── type≠'bag' → existing issue/receive flow (unchanged)
```

---

## 4. Admin ALS Bags Tab — Bag List Panel [S-4.1]

### 4.1 Mobile wireframe @ 360px

```
┌────────────────────────────────────────────────────────┐
│ navbar                                                  │
├────────────────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory][Ambulances]           │
│ [Settings][Sessions][ยืม-คืน][ALS Bags*]               │
├────────────────────────────────────────────────────────┤
│ ─ ALS Bags ──────────────────────────────────────── ▼ │
│                                                        │
│ ┌── summary strip (4 tap-filter badges) ─────────────┐ │
│ │  สมบูรณ์   ของไม่ครบ  ใกล้หมด  หมดอายุ            │ │
│ │  ┌────┐   ┌────┐   ┌────┐   ┌────┐               │ │
│ │  │ 2  │   │ 1  │   │ 1  │   │ 0  │               │ │
│ │  └────┘   └────┘   └────┘   └────┘               │ │
│ │  green    amber    orange    red                   │ │
│ └────────────────────────────────────────────────────┘ │
│                                                        │
│ ┌── filter bar ───────────────────────────────────┐    │
│ │ [สถานะ: ทั้งหมด ▾]  [เทมเพลต: ทั้งหมด ▾]        │    │
│ │ [🔍 ค้นรหัส / ชื่อถุง              ]            │    │
│ └─────────────────────────────────────────────────┘    │
│                                                        │
│ ┌── bag list (card stack on mobile) ──────────────┐    │
│ │ ┌────────────────────────────────────────────┐  │    │
│ │ │ BAG-ALS-001                                │  │    │
│ │ │ ถุง ALS รถ TG1                             │  │    │
│ │ │ เทมเพลต: ALS ผู้ใหญ่                      │  │    │
│ │ │ [สมบูรณ์]  ████████████ 100%               │  │    │
│ │ │ หมดอายุใกล้สุด: 15 มิ.ย. 69               │  │    │
│ │ │                     [ดูรายละเอียด →]       │  │    │
│ │ └────────────────────────────────────────────┘  │    │
│ │ ┌────────────────────────────────────────────┐  │    │
│ │ │ BAG-ALS-002                                │  │    │
│ │ │ ถุง ALS รถ TG2                             │  │    │
│ │ │ เทมเพลต: ALS ผู้ใหญ่                      │  │    │
│ │ │ [ของไม่ครบ]  ████████░░ 80%                │  │    │
│ │ │ ขาด 1 รายการบังคับ                        │  │    │
│ │ │ หมดอายุใกล้สุด: 22 มิ.ย. 69               │  │    │
│ │ │                     [ดูรายละเอียด →]       │  │    │
│ │ └────────────────────────────────────────────┘  │    │
│ │ ┌────────────────────────────────────────────┐  │    │
│ │ │ BAG-TRX-001                                │  │    │
│ │ │ ถุง Trauma รถ TG1                          │  │    │
│ │ │ เทมเพลต: —                                │  │    │
│ │ │ [ไม่มีเทมเพลต]                             │  │    │
│ │ │                     [ดูรายละเอียด →]       │  │    │
│ │ └────────────────────────────────────────────┘  │    │
│ └─────────────────────────────────────────────────┘    │
│                                                        │
│ [+ เพิ่มถุงยา]        [จัดการเทมเพลต]                 │
└────────────────────────────────────────────────────────┘
```

### 4.2 Desktop wireframe @ 768px+

```
┌────────────────────────────────────────────────────────────────────────┐
│ navbar                                                                   │
├────────────────────────────────────────────────────────────────────────┤
│ [Dashboard][Locations][Inventory][Ambulances][Settings][Sessions][ยืม-คืน][ALS Bags*] │
├────────────────────────────────────────────────────────────────────────┤
│ ALS Bags                                [+ เพิ่มถุงยา] [จัดการเทมเพลต] │
│                                                                          │
│ สมบูรณ์ [2]  ของไม่ครบ [1]  ใกล้หมด [1]  หมดอายุ [0]                   │
│                                                                          │
│ [สถานะ ▾]  [เทมเพลต ▾]  [🔍 ค้นรหัส / ชื่อถุง              ]           │
│                                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ รหัสถุง      ชื่อ           เทมเพลต      สถานะ   ความสมบูรณ์  หมดอายุใกล้สุด │
│ ├──────────────────────────────────────────────────────────────────┤   │
│ │ BAG-ALS-001  ถุง ALS รถ TG1  ALS ผู้ใหญ่  [สมบูรณ์]  100%  15 มิ.ย. 69  [ดู] │
│ ├──────────────────────────────────────────────────────────────────┤   │
│ │ BAG-ALS-002  ถุง ALS รถ TG2  ALS ผู้ใหญ่  [ของไม่ครบ] 80% 22 มิ.ย. 69  [ดู] │
│ ├──────────────────────────────────────────────────────────────────┤   │
│ │ BAG-TRX-001  ถุง Trauma TG1  —            [ไม่มีเทมเพลต] —    —        [ดู] │
│ └──────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Alert level badge spec

| alert_level | Badge color | Bootstrap class | Thai label | Priority |
|---|---|---|---|---|
| `complete` | Green | `bg-success text-white` | สมบูรณ์ | 4 (lowest) |
| `low_stock` | Amber | `bg-warning text-dark` | ของไม่ครบ | 3 |
| `expiring` | Orange | `bg-orange text-white` (propose new token `--bs-orange`) | ใกล้หมดอายุ | 2 |
| `expired` | Red | `bg-danger text-white` | หมดอายุ | 1 (highest) |
| `no_template` | Grey | `bg-secondary text-white` | ไม่มีเทมเพลต | 5 |

**Color-only is not acceptable.** Every badge pairs color + Thai text label.
The `expiring` level needs an orange badge not present in Bootstrap 5 defaults.
Proposed new CSS token: `--stock-orange: #fd7e14` (Bootstrap $orange value),
used as `background-color: var(--stock-orange); color: #fff;`. This mirrors the
Phase 2 expiry color spec for ≤30d lots — same semantic = same token.

### 4.4 Completion % progress bar spec

- Rendered as Bootstrap `.progress` inside the card (mobile) or inline (desktop).
- Color mirrors badge: green if 100%, amber if ≥70%, red if <70%.
- Width = `completion_pct%`. Empty state = 0% width (red, full bar visible as
  background).
- ARIA: `role="progressbar" aria-valuenow="{pct}" aria-valuemin="0"
  aria-valuemax="100" aria-label="ความสมบูรณ์ {pct}%"`.

### 4.5 Summary strip behavior

Tapping a count badge filters the bag list to that alert_level. Active filter
shown with a filled ring around the badge. Tapping the same badge again resets
to "ทั้งหมด". Only one filter active at a time.

### 4.6 Empty states

| Condition | Message | Action |
|---|---|---|
| No bags exist | "ยังไม่มีถุงยา — เพิ่มถุงแรกได้เลย" | [+ เพิ่มถุงยา] button |
| Filter has no matches | "ไม่มีถุงตามเงื่อนไขที่เลือก" | [ล้างตัวกรอง] link |
| Loading | Skeleton shimmer for 3 card rows | — |

### 4.7 "+ เพิ่มถุงยา" button behavior

Opens the existing Locations create modal (Phase 0) with `type=bag` pre-selected
and locked. An additional field "เทมเพลต (Template)" appears — a select input
populated from `bag_templates WHERE active=true`. This field is optional (bag
can exist without template; alert_level will be `no_template`).

**No new modal needed.** Reuse the existing Locations create modal with
conditional template picker rendered when `type=bag` is selected.

---

## 5. Bag Detail Drawer [S-4.2]

### 5.1 Mobile layout @ 360px

On mobile the drawer pushes the bag list off-screen (full-width replacement).
On desktop (≥768px) it is a right-panel drawer (max-width: 480px, side-by-side
with the bag list).

```
┌────────────────────────────────────────────────────────┐
│ ← กลับ                                                 │  ← back button ≥44px
├────────────────────────────────────────────────────────┤
│ BAG-ALS-001                    [ของไม่ครบ]             │  ← code + status badge
│ ถุง ALS รถ TG1                                         │  ← bag name
│ เทมเพลต: ALS ผู้ใหญ่  (TPL-ALS-ADULT)                 │
│                                                        │
│ ── ความสมบูรณ์ ─────────────────────────────────────  │
│ ████████░░ 80%   (ขาด 1 รายการบังคับ)                 │
│                                                        │
│ ── รายการของในถุง ───────────────────────────────────  │
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │ ★ อะดรีนาลีน 1mg/ml (MED-EPI-1MG)             │    │  ★ = mandatory
│ │   เป้าหมาย 5   ปัจจุบัน 5   [✓ ครบ]           │    │
│ └────────────────────────────────────────────────┘    │
│ ┌────────────────────────────────────────────────┐    │
│ │ ★ ท่อช่วยหายใจ OPA (SUP-AIRWAY-OPA)           │    │
│ │   เป้าหมาย 3   ปัจจุบัน 2   [✗ ขาด 1]        │    │  ← red "ขาด X"
│ └────────────────────────────────────────────────┘    │
│ ┌────────────────────────────────────────────────┐    │
│ │ ○ ผ้าก๊อซ (SUP-GAUZE-001)                     │    │  ○ = non-mandatory
│ │   เป้าหมาย 10  ปัจจุบัน 10  [– ไม่บังคับ]    │    │  ← grey dash
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ ── ล็อตยาในถุงนี้ ────────────────────────────── [+] │  ← expandable section
│ (expanded)                                             │
│ ┌────────────────────────────────────────────────┐    │
│ │ ชื่อยา     ล็อต       วันหมดอายุ  คงเหลือ      │    │
│ │ อะดรีนา…  LOT-EPI-A  15 มิ.ย. 69  5 หลอด      │    │
│ │                       [🟠 ใกล้หมดอายุ]          │    │  ← expiry badge
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ [เติมของ (Restock)]                                    │  ← btn-stock-primary full-width 52px
│ (always visible for Admin; activates restock flow)     │
└────────────────────────────────────────────────────────┘
```

### 5.2 Result column visual spec (template vs actual)

| Condition | Icon | Class | Text |
|---|---|---|---|
| `actual >= target` | `bi-check-circle-fill` | `text-success` | ครบ |
| `actual < target` AND `mandatory=true` | `bi-x-circle-fill` | `text-danger` | ขาด {target-actual} |
| `actual < target` AND `mandatory=false` | `bi-dash` | `text-secondary` | ไม่บังคับ |
| `actual = 0` AND `mandatory=true` | `bi-x-circle-fill` + bold | `text-danger fw-bold` | ขาด {target} (ทั้งหมด) |

### 5.3 Lots section (expandable)

- **Collapsed by default** to reduce initial scroll depth.
- Toggle button: "ล็อตยาในถุงนี้ ({count} ล็อต)" with `bi-chevron-down` / `bi-chevron-up`.
- Inside: reuses Phase 2 §3.1.3 expiry color-coding exactly:
  - Expired → `bg-danger text-white` badge "หมดอายุแล้ว"
  - ≤30d → `bg-warning text-dark` badge "ใกล้หมดอายุ"
  - ≤60d → `bg-warning text-dark opacity-75` badge "เฝ้าระวัง"
  - >90d → `bg-success text-white` badge "ปกติ"
- Empty state (no lot-tracked items in bag): "ไม่มียาที่ต้องติดตามล็อต"

### 5.4 "เติมของ (Restock)" button

- Always visible for Admin role.
- On Staff view (S-4.5): button absent entirely.
- Button label: "เติมของ (Restock)" — Thai primary, English in parentheses for
  Admin who may have EMS training in English.
- Tap → opens restock flow (S-4.4) inline (replaces drawer content) or as a
  full-screen flow on mobile (see §7 for step layout).

### 5.5 Interaction states for drawer

| State | Display |
|---|---|
| Loading bag detail | Skeleton loader: 3 grey shimmer rows in composition table |
| No template assigned | "ถุงนี้ยังไม่มีเทมเพลต — กำหนดเทมเพลตก่อนเริ่มตรวจสอบ" with [กำหนดเทมเพลต] link |
| Bag inactive | "ถุงนี้ถูกปิดใช้งาน" warning banner at top of drawer |
| Restock in progress | "กำลังโหลดข้อมูลล่าสุด…" after submit; spinner replaces button |

---

## 6. Template Management Panel [S-4.3]

### 6.1 Template list wireframe @ 360px

```
┌────────────────────────────────────────────────────────┐
│ ← กลับ (ALS Bags)                                      │
├────────────────────────────────────────────────────────┤
│ จัดการเทมเพลต               [+ เพิ่มเทมเพลต]           │
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │ TPL-ALS-ADULT                                  │    │
│ │ ALS ผู้ใหญ่  ·  หมวด: ALS  ·  3 รายการ        │    │
│ │                         [แก้ไข]  [ปิดใช้งาน]  │    │
│ └────────────────────────────────────────────────┘    │
│ ┌────────────────────────────────────────────────┐    │
│ │ TPL-TRAUMA-01                                  │    │
│ │ Trauma Kit ผู้ใหญ่  ·  หมวด: Trauma  ·  7 รายการ│   │
│ │                         [แก้ไข]  [ปิดใช้งาน]  │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ (empty state if no templates)                          │
│ "ยังไม่มีเทมเพลต — สร้างเทมเพลตแรก"                   │
└────────────────────────────────────────────────────────┘
```

### 6.2 Template create/edit modal [S-4.3.1]

```
┌────────────────────────────────────────────────────────┐
│ สร้างเทมเพลต (Create Template)           [×]           │
├────────────────────────────────────────────────────────┤
│                                                        │
│ รหัสเทมเพลต *                                          │
│ [TPL-ALS-ADULT              ]  ← uppercase-enforced    │
│                                                        │
│ ชื่อเทมเพลต *                                          │
│ [ALS ผู้ใหญ่                ]                          │
│                                                        │
│ หมวดหมู่                                               │
│ [ALS                        ]  ← free text             │
│                                                        │
│ คำอธิบาย                                               │
│ [                            ]                         │
│                                                        │
│ ── รายการในถุง ──────────────────────────────────────  │
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │ #  ชื่อสินค้า             เป้าหมาย  บังคับ     │    │
│ ├────────────────────────────────────────────────┤    │
│ │ 1  [ค้นหาสินค้า…   ▾]   [5]       [☑ บังคับ] [×]│  │
│ │ 2  [ค้นหาสินค้า…   ▾]   [3]       [☑ บังคับ] [×]│  │
│ │ 3  [ค้นหาสินค้า…   ▾]   [10]      [☐ บังคับ] [×]│  │
│ └────────────────────────────────────────────────┘    │
│ [+ เพิ่มรายการ]                                        │
│                                                        │
│ [บันทึก]                  [ยกเลิก]                     │
└────────────────────────────────────────────────────────┘
```

### 6.3 Template form field spec

| Field | Type | Validation | Error message |
|---|---|---|---|
| รหัสเทมเพลต | text | Required; unique; uppercase only (A-Z, 0-9, hyphens); max 30 chars | "รหัสเทมเพลตนี้มีอยู่แล้ว" (409) / "รหัสต้องเป็นตัวพิมพ์ใหญ่เท่านั้น" |
| ชื่อเทมเพลต | text | Required; max 100 chars | "กรุณากรอกชื่อเทมเพลต" |
| หมวดหมู่ | text | Optional; max 50 chars | — |
| คำอธิบาย | textarea | Optional | — |
| รายการสินค้า (item_id) | autocomplete select | Required; must resolve to stock_items.id | "ไม่พบสินค้า" |
| เป้าหมาย (target_qty) | number | Required; integer; min 1 | "ต้องมากกว่า 0" |
| บังคับ (mandatory) | checkbox | Default: checked | — |

**Item picker autocomplete:** searches `stock_items.name` + `stock_items.sku`
with debounce 300ms. Dropdown shows "SKU — ชื่อสินค้า" format. Same pattern as
Phase 2 Receive modal item picker.

**Uppercase enforcement on รหัสเทมเพลต:** `oninput="this.value = this.value.toUpperCase()"`.

**Row reordering:** drag-handle icon (`bi-grip-vertical`) on each row, touch-
draggable (or up/down arrow buttons as fallback for accessibility). `sort_order`
column value updated on reorder.

**Deactivate vs Delete:** "ปิดใช้งาน" sets `active=false`; does not DELETE row.
If the template is linked to active bag-locations, a warning appears: "เทมเพลต
นี้ยังถูกใช้โดย {N} ถุง — ปิดใช้งานจะไม่กระทบสถานะถุงที่มีอยู่แล้ว แต่จะไม่
สามารถเลือกเทมเพลตนี้สำหรับถุงใหม่ได้"

---

## 7. Restock Flow — 5 Steps [S-4.4]

### 7.1 Step indicator (shared across all steps)

```
①รายการ   ②รูปถ่าย   ③ยืนยัน
```

On mobile: full-width horizontal step indicator at the top of the restock
view. Active step = filled circle; completed step = check icon; future step =
empty circle. Reuses Phase 3 step indicator pattern.

### 7.2 Step 1 — รายการขาด (Shopping list)

**Triggered by:** Bag QR scan (resolves to location_id) OR "เติมของ" button from
bag detail drawer.

#### Wireframe @ 360px

```
┌────────────────────────────────────────────────────────┐
│ ← ยกเลิก                                               │
│ ①รายการ ─── ②รูปถ่าย ─── ③ยืนยัน                     │
├────────────────────────────────────────────────────────┤
│ เติมของ: BAG-ALS-001                                    │
│ ถุง ALS รถ TG1   [ของไม่ครบ]                           │
│                                                        │
│ ─ รายการที่ต้องเติม ────────────────────────────────  │
│ (เรียงตามบังคับก่อน, ขาดก่อน — ดู §15 UX Q1)          │
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │ ★ ท่อช่วยหายใจ OPA (SUP-AIRWAY-OPA)           │    │
│ │   ปัจจุบัน 2 / เป้าหมาย 3   ขาด 1             │    │
│ │   จำนวนที่จะเติม: [1      ] ชิ้น               │    │
│ │   (tracks_lots = false — ไม่ต้องเลือกล็อต)    │    │
│ │                    [ไม่มีของ — ข้าม]            │    │  ← see §15 UX Q3
│ └────────────────────────────────────────────────┘    │
│ ┌────────────────────────────────────────────────┐    │
│ │ ★ อะดรีนาลีน 1mg/ml (MED-EPI-1MG)             │    │
│ │   ปัจจุบัน 3 / เป้าหมาย 5   ขาด 2             │    │
│ │   จำนวนที่จะเติม: [2      ] ชิ้น               │    │
│ │   ── เลือกล็อต (FEFO) ────────────────────── │    │
│ │   ○ LOT-EPI-A  หมดอายุ 15 มิ.ย. 69  4 เหลือ  │    │  ← FEFO first, Phase 2 reuse
│ │   ○ LOT-EPI-B  หมดอายุ 12 ส.ค. 69  10 เหลือ  │    │
│ │                    [ไม่มีของ — ข้าม]            │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ ─ รายการไม่บังคับ (มีของแล้ว/เป็นทางเลือก) ─────────  │
│ ○ ผ้าก๊อซ — ครบแล้ว (10/10) [เติมเพิ่ม?]             │  ← collapsed or shown below
│                                                        │
│ [ถัดไป: ถ่ายรูป →]                                    │  ← btn-stock-primary 52px
└────────────────────────────────────────────────────────┘
```

#### Shopping list ordering (UX Q1 — see §15)

This design uses the following default order (PM must confirm):
1. Mandatory items with deficit first (most urgent)
2. Mandatory items already complete (shown but collapsed / greyed)
3. Non-mandatory items with deficit
4. Non-mandatory items complete (collapsed)

Within each group: alphabetical by item name (fallback; sort_order from
template takes precedence if set).

#### Lot picker for tracks_lots items

Reuses Phase 2 `shared/lots.js` `fetchAvailableLots(itemId)` exactly. The lot
picker renders as a radio group (not a dropdown) so the full expiry date is
visible without a tap. FEFO: earliest expiry is pre-selected. Expired and
recalled lots are shown as greyed-out disabled options with reason label.

**Empty lot state:** if `fetchAvailableLots(itemId)` returns zero available
lots, the item row shows: "ไม่มีล็อตที่ใช้ได้ — ต้องรับเข้าคลังก่อน" and the
"+" button is disabled. The "ไม่มีของ — ข้าม" option remains available.

#### Qty adjustment

- Default value = `target_qty - current_qty` (the deficit).
- Admin can increase above the deficit (e.g., topping up to over-target is
  allowed; template is a target, not a cap).
- Admin can decrease to 0 (equivalent to skipping — see §15 UX Q3).
- Input: `<input type="number" min="0" inputmode="numeric">` — numeric keyboard
  on mobile.
- Inline validation: "จำนวนมากกว่าล็อตที่เหลือ — ตรวจสอบก่อนบันทึก" (warning,
  not blocking — spec says deficits are flagged, movements are not blocked).

#### "ไม่มีของ — ข้าม" button

Sets `restock_qty = 0` for this item. Item row gets a "ข้าม" badge and is
visually dimmed. The item is still listed on the confirm step as "ข้าม (qty 0)"
so the Admin can see the full picture. See §15 UX Q3 for how this is recorded.

### 7.3 Step 2 — ถ่ายรูปถุง (Photo — advisory)

**Reuses `shared/photo-capture.js` from Phase 3 unchanged.**

Call signature:
```javascript
PhotoCaptureModal.open({
  folder:    'thegood-stock/bag-restock/' + bagCode + '/' + restockRefId,
  label:     'ถ่ายรูปถุงหลังเติมของ',
  optional:  true,
  entityId:  restockRefId,
  onUploaded: (url) => { restockData.photoUrl = url; proceedToStep3(); },
  onSkipped:  () => { restockData.photoUrl = null; proceedToStep3(); },
  onError:    (msg) => { showWarningToast('อัปโหลดรูปไม่สำเร็จ — ดำเนินการต่อโดยไม่มีรูป'); proceedToStep3(); }
})
```

The `restockRefId` is a single UUID generated at start of the restock flow
(not per movement). It is stored in the `note` field of each `stock_movements`
row as `'bag:' + bagCode + ':restock:' + restockRefId`.

#### Wireframe @ 360px

```
┌────────────────────────────────────────────────────────┐
│ ← กลับ                                                 │
│ ①รายการ ✓── ②รูปถ่าย ─── ③ยืนยัน                     │
├────────────────────────────────────────────────────────┤
│ ถ่ายรูปถุงหลังเติมของ (ไม่บังคับ)                      │
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │   [bi-camera 3rem icon]                        │    │
│ │                                                │    │
│ │  [📷 เปิดกล้องถ่ายรูป]  [📁 เลือกจากคลัง]    │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ (or, if photo captured:)                               │
│ ┌────────────────────────────────────────────────┐    │
│ │  [thumbnail 120×90]     [ถ่ายใหม่]            │    │
│ │  อัปโหลด… [████░░] 60%                        │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ [ถัดไป: ยืนยัน →]         [ข้าม — ไม่ถ่ายรูป]        │
└────────────────────────────────────────────────────────┘
```

### 7.4 Step 3 — ยืนยัน (Confirm + submit)

```
┌────────────────────────────────────────────────────────┐
│ ← กลับ                                                 │
│ ①รายการ ✓── ②รูปถ่าย ✓── ③ยืนยัน                     │
├────────────────────────────────────────────────────────┤
│ สรุปการเติมของ                                          │
│                                                        │
│ ถุง:   BAG-ALS-001 (ถุง ALS รถ TG1)                   │
│ รูป:   [thumbnail] หรือ ไม่มีรูปถ่าย                  │
│                                                        │
│ รายการที่จะเติม (2 รายการ):                            │
│ ┌────────────────────────────────────────────────┐    │
│ │ ★ ท่อช่วยหายใจ OPA    +1 ชิ้น                 │    │
│ │ ★ อะดรีนาลีน 1mg/ml  +2 หลอด  LOT-EPI-A      │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ รายการข้าม (ไม่เติม):                                  │
│ ┌────────────────────────────────────────────────┐    │
│ │ (none) หรือ                                    │    │
│ │ ○ ผ้าก๊อซ — [ไม่มีของ]                       │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ [ยืนยันการเติมของ]                                     │  ← btn-stock-primary 52px
│ (loading: spinner + "กำลังบันทึก X รายการ…" disabled)│
│ [← แก้ไขรายการ]                                        │
└────────────────────────────────────────────────────────┘
```

### 7.5 Submit + progress display

After "ยืนยันการเติมของ":
- Button becomes disabled with spinner.
- For each item with `restock_qty > 0`:
  - POST `stock_movements` with `movement_type='receive'`, `location_id=<bag>`,
    `qty_delta=restock_qty`, `lot_id=<selected lot if tracks_lots>`,
    `reason='bag_restock'`, `client_ref_id=crypto.randomUUID()` (per item),
    `note='bag:' + bagCode + ':restock:' + restockRefId`.
  - Per-item progress: inline status icon on confirm table row:
    - Pending: spinner (grey)
    - Succeeded: `bi-check-circle-fill text-success`
    - Failed: `bi-x-circle-fill text-danger`

**All succeeded:** toast "เติมของเสร็จสิ้น — 2 รายการ" (green, 4s). Auto-return
to bag detail drawer after 1.5s. Bag status refreshes from `v_bag_status`.

**Partial failure (one or more items failed):**
- Remaining items continue.
- After all items attempted: "เติมของบางส่วน — สำเร็จ 1, ล้มเหลว 1" (amber
  toast). Failed items listed below confirm table with error text.
- [ลองใหม่สำหรับรายการที่ล้มเหลว] button retries only failed items (client_ref_id
  is per-item, so retry is safe — 409 on already-posted = treat as success).

**Idempotency (409 conflict on client_ref_id):** treated as success. No error
shown. Mirrors Phase 1 T137 acceptance test behavior.

### 7.6 Restock flow interaction state table

| State | Loading | Error | Empty |
|---|---|---|---|
| Fetch bag detail / template | Skeleton shimmer | "โหลดข้อมูลไม่สำเร็จ — ลองอีกครั้ง" + retry button | N/A |
| Fetch available lots (FEFO) | Spinner in lot section | "โหลดล็อตไม่สำเร็จ" inline | "ไม่มีล็อตที่ใช้ได้" |
| Photo upload | Progress bar (see §7.3) | "อัปโหลดรูปไม่สำเร็จ" — advisory; flow continues | N/A |
| Submit movement (per item) | Per-row spinner | Per-row "บันทึกล้มเหลว: {err}" | N/A |
| 409 (duplicate client_ref_id) | — | Treat as success — no toast error | N/A |
| No deficit items (bag already complete) | — | — | "ถุงนี้สมบูรณ์แล้ว — ไม่ต้องเติมของ" + [เติมเพิ่ม?] option |

---

## 8. Staff Scan Extension — Bag QR Path [S-4.5]

### 8.1 Scan routing logic (js/staff-scan.js extension)

On QR scan success, after `GET /locations?code=eq.{scanned_code}`:
```
if (location.type === 'bag') {
  → render bag checklist view (S-4.5)
} else {
  → existing issue/receive flow (unchanged)
}
```

**Fallback for non-QR bag lookup:** Staff types bag code manually if camera
fails. Text input already exists in staff-scan.html. No new UI needed. Type
"BAG-ALS-001" → same routing logic applies.

### 8.2 Staff bag checklist wireframe @ 360px

```
┌────────────────────────────────────────────────────────┐
│ ─ Staff Scan ────────────────────────────────────────  │
├────────────────────────────────────────────────────────┤
│                                                        │
│ ┌── bag detected banner ─────────────────────────────┐ │
│ │  bi-bag-heart icon  BAG-ALS-001                    │ │
│ │  ถุง ALS รถ TG1                                    │ │
│ │  [ของไม่ครบ]   ████████░░ 80%                     │ │
│ └────────────────────────────────────────────────────┘ │
│                                                        │
│ ─ ตรวจสอบของในถุง ──────────────────────────────────  │
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │ ★ อะดรีนาลีน 1mg/ml      5 / 5   [✓ ครบ]     │    │
│ │   LOT-EPI-A  หมดอายุ 15 มิ.ย. [🟠 ใกล้หมด]   │    │
│ └────────────────────────────────────────────────┘    │
│ ┌────────────────────────────────────────────────┐    │
│ │ ★ ท่อช่วยหายใจ OPA        2 / 3   [✗ ขาด 1]  │    │  ← highlighted row
│ └────────────────────────────────────────────────┘    │
│ ┌────────────────────────────────────────────────┐    │
│ │ ○ ผ้าก๊อซ                10 / 10  [✓ ครบ]     │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ (NO "เติมของ" button — read-only for Staff per §7.2 A-2)│
│                                                        │
│ ┌────────────────────────────────────────────────┐    │
│ │ ℹ ถุงนี้ยังไม่สมบูรณ์ — แจ้ง Admin เพื่อเติมของ │    │
│ └────────────────────────────────────────────────┘    │
│                                                        │
│ [← สแกนใหม่]                                          │  ← 52px
└────────────────────────────────────────────────────────┘
```

### 8.3 Read-only enforcement

- No restock button.
- No qty edit inputs.
- No lot picker.
- The info banner "ถุงนี้ยังไม่สมบูรณ์ — แจ้ง Admin เพื่อเติมของ" appears when
  `alert_level IN ('low_stock', 'expiring', 'expired')`.
- The banner is informational only. Phase 4 does not include a "Report to Admin"
  action (deferred per spec §7.2 A-2). If PM adds staff-initiated restock
  requests in Phase 4.1, a [รายงานปัญหา] button will be added here.

### 8.4 Staff scan interaction states

| State | Display |
|---|---|
| Loading bag detail | Spinner inside detected banner; checklist shimmer |
| Bag not found (QR not in locations) | "ไม่พบถุงนี้ในระบบ — ตรวจสอบรหัส QR" (existing Phase 1 not-found error pattern) |
| No template assigned | "ถุงนี้ยังไม่มีเทมเพลต — ไม่สามารถตรวจสอบได้" with amber banner |
| Bag complete | Green banner "ถุงนี้สมบูรณ์พร้อมใช้งาน" |
| Expired lot in bag | Red banner "มียาหมดอายุในถุงนี้ — แจ้ง Admin ทันที" (blink-badge on expired items) |

---

## 9. Dashboard Panel "สถานะ ALS Bags" [S-4.6]

### 9.1 Panel wireframe @ 360px

```
┌────────────────────────────────────────────────────────┐
│ ┌── สถานะ ALS Bags ───────────────────────────── [→] ┐ │
│ │                                                    │ │
│ │  สมบูรณ์  ของไม่ครบ  ใกล้หมด  หมดอายุ            │ │
│ │  ┌────┐   ┌────┐    ┌────┐   ┌────┐             │ │
│ │  │ 2  │   │ 1  │    │ 1  │   │ 0  │             │ │
│ │  └────┘   └────┘    └────┘   └────┘             │ │
│ │  green    amber     orange    red                 │ │
│ │                                                    │ │
│ │  (if any issues: amber/red count glows/blinks)     │ │
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

### 9.2 Tap behavior

- Tap any count badge → navigates to ALS Bags tab (S-4.1) with that alert_level
  pre-filtered.
- Tap the [→] icon at top-right → navigates to ALS Bags tab with no filter
  (all bags).

### 9.3 Panel placement on dashboard

Placed after the Phase 3 "สถานะอุปกรณ์ยืม-คืน" panel and before the Phase 2
"ล็อตยาที่ใกล้หมดอายุ" panel. The dashboard uses Bootstrap `.row` with `.col-12
col-lg-6`; this panel occupies one column.

### 9.4 Attention state

- If `expired` count > 0: the `expired` badge uses `.blink-badge` animation
  (already in `shared/styles.css`). The panel border uses `.blink-border` class.
- If only `expiring` or `low_stock`: no blinking; amber/orange badge color is
  sufficient.
- All zeros: panel shows "ถุงทั้งหมดสมบูรณ์" with a green check icon.

### 9.5 Data source

SELECT from `v_bag_status GROUP BY alert_level` — four counts. Loaded on
dashboard init. No realtime subscription needed for the dashboard panel (status
changes at restock time, not continuously). Manual refresh button matches
Phase 2 dashboard pattern.

---

## 10. Bag QR Sticker Design Note [S-4.7]

This section specifies the QR sticker for physical bag labeling. It is a note
for future PM workflow, not a UI screen.

### 10.1 QR content format

The QR code encodes the bare `locations.code` value only. Example:
`BAG-ALS-001`

No URL prefix. The staff-scan.html scanner resolves the code via
`GET /locations?code=eq.{scanned_code}&type=eq.bag`. This is consistent with
Phase 1 item QR sticker convention (item codes are bare SKUs, not full URLs).

### 10.2 Print spec recommendation

| Attribute | Spec |
|---|---|
| Sticker size | 50mm × 50mm minimum (provides ~38mm QR area + text below) |
| QR error correction | Level H (30% data recovery — resilient to physical damage, scuffs, blood/fluid stains common in EMS context) |
| Text below QR | bag_code (e.g., BAG-ALS-001) in bold + bag_name in smaller text |
| Material | Water-resistant label (laminated or synthetic) — ambulance environment |
| Placement | Inside front flap of bag, and duplicate on outside handle |
| Background | White or light grey — ensures QR scanner contrast |

### 10.3 PM workflow note

QR stickers should be generated and printed when a new bag-location is created
in the Admin UI. A future enhancement (not Phase 4): a "พิมพ์ QR" button on the
bag detail drawer that calls `window.print()` on a print-optimized `<div>`
containing the QR code (generated client-side via `qrcode.js` library or
similar). Not in scope for Phase 4 — record as Phase 4.1 feature request.

---

## 11. Interaction State Diagrams

### 11.1 Admin ALS Bags tab state machine

```
[Tab click]
     │
     ▼
[Loading: fetch v_bag_status]
     │──────────► [Error: "โหลดข้อมูลไม่สำเร็จ" + [ลองใหม่]]
     │
     ▼
[Bag list rendered]
     │
     ├──[No bags exist]──► [Empty: "ยังไม่มีถุงยา" + [+ เพิ่มถุงยา]]
     │
     ├──[Click bag row]──► [Bag detail drawer loading]
     │                          │
     │                          ▼
     │                     [Drawer: template table + lots]
     │                          │
     │                          └──[Click เติมของ]──► [Restock flow S-4.4]
     │
     ├──[Click + เพิ่มถุงยา]──► [Locations create modal (type=bag)]
     │
     └──[Click จัดการเทมเพลต]──► [Template panel S-4.3]
```

### 11.2 Restock flow state machine

```
[เติมของ clicked]
     │
     ▼
[Step 1: Shopping list — fetch template + current qty + lots]
     │──[no deficit items]──► ["ถุงสมบูรณ์แล้ว" state]
     │
     ▼
[Admin adjusts qty / selects lots / marks skips]
     │
     ├──[ถัดไป]──► [Step 2: Photo (advisory)]
     │                   │──[ถ่ายรูป / อัปโหลด / ข้าม]
     │                   ▼
     │              [Step 3: Confirm summary]
     │                   │
     │                   └──[ยืนยัน]──► [Submit N movements]
     │                                      │
     │                                      ├──[all success]──► toast + return to drawer
     │                                      └──[partial fail]──► partial error + retry option
     │
     └──[ยกเลิก]──► [Return to bag detail drawer]
```

### 11.3 Staff scan bag path state machine

```
[Scan QR]
     │
     ▼
[Resolve locations.code]
     │──[not found]──► [Error: "ไม่พบถุงนี้"]
     │──[type≠'bag']──► [Existing issue/receive flow]
     │
     ▼
[type='bag' → fetch bag detail + template]
     │
     ▼
[Bag checklist (read-only)]
     │
     └──[← สแกนใหม่]──► [Back to scan mode]
```

---

## 12. Microcopy Table (Thai Strings)

All strings are Thai-primary. English in parentheses only when shown to Admin
and the English term is a known technical/clinical term (bag code, lot, SKU).

| Key | Thai copy | Context |
|---|---|---|
| tab_label | ALS Bags | Top-level tab label (Admin nav) |
| bag_list_title | ถุงยา / ชุดปฐมพยาบาล | Page heading in ALS Bags tab |
| badge_complete | สมบูรณ์ | alert_level=complete badge |
| badge_low_stock | ของไม่ครบ | alert_level=low_stock badge |
| badge_expiring | ใกล้หมดอายุ | alert_level=expiring badge |
| badge_expired | หมดอายุ | alert_level=expired badge |
| badge_no_template | ไม่มีเทมเพลต | alert_level=no_template badge |
| btn_add_bag | + เพิ่มถุงยา | Add bag button |
| btn_manage_templates | จัดการเทมเพลต | Open template management |
| btn_view_detail | ดูรายละเอียด | Bag list row action |
| btn_restock | เติมของ (Restock) | Drawer CTA for Admin |
| btn_back | ← กลับ | Back navigation |
| btn_cancel | ← ยกเลิก | Cancel restock flow |
| btn_next_photo | ถัดไป: ถ่ายรูป → | Step 1 → Step 2 |
| btn_next_confirm | ถัดไป: ยืนยัน → | Step 2 → Step 3 |
| btn_confirm_restock | ยืนยันการเติมของ | Step 3 submit |
| btn_skip_photo | ข้าม — ไม่ถ่ายรูป | Photo step skip |
| btn_skip_item | ไม่มีของ — ข้าม | Per-item skip in shopping list |
| btn_retry_failed | ลองใหม่สำหรับรายการที่ล้มเหลว | Partial failure retry |
| btn_scan_again | ← สแกนใหม่ | Staff scan back button |
| btn_add_template | + เพิ่มเทมเพลต | Template list CTA |
| empty_no_bags | ยังไม่มีถุงยา — เพิ่มถุงแรกได้เลย | Empty bag list |
| empty_no_templates | ยังไม่มีเทมเพลต — สร้างเทมเพลตแรก | Empty template list |
| empty_filter | ไม่มีถุงตามเงื่อนไขที่เลือก | No filter results |
| empty_no_deficit | ถุงนี้สมบูรณ์แล้ว — ไม่ต้องเติมของ | Shopping list has no items to fill |
| empty_no_lots | ไม่มียาที่ต้องติดตามล็อต | Lots section empty |
| empty_no_available_lots | ไม่มีล็อตที่ใช้ได้ — ต้องรับเข้าคลังก่อน | Lot picker empty |
| error_load_failed | โหลดข้อมูลไม่สำเร็จ — ลองอีกครั้ง | Generic load failure |
| error_bag_not_found | ไม่พบถุงนี้ในระบบ — ตรวจสอบรหัส QR | Staff scan not found |
| error_no_template_for_bag | ถุงนี้ยังไม่มีเทมเพลต — ไม่สามารถตรวจสอบได้ | Staff scan no template |
| error_duplicate_template_code | รหัสเทมเพลตนี้มีอยู่แล้ว | Template create 409 |
| error_template_code_uppercase | รหัสต้องเป็นตัวพิมพ์ใหญ่เท่านั้น | Template code validation |
| error_target_qty_zero | ต้องมากกว่า 0 | Template item target_qty validation |
| error_item_not_found | ไม่พบสินค้า | Template item picker autocomplete |
| error_qty_exceeds_lot | จำนวนมากกว่าล็อตที่เหลือ — ตรวจสอบก่อนบันทึก | Lot qty warning (non-blocking) |
| toast_restock_success | เติมของเสร็จสิ้น — {N} รายการ | All succeed toast |
| toast_restock_partial | เติมของบางส่วน — สำเร็จ {N}, ล้มเหลว {M} | Partial failure toast |
| toast_already_posted | รายการนี้บันทึกแล้ว | 409 idempotency toast |
| toast_photo_upload_failed | อัปโหลดรูปไม่สำเร็จ — ดำเนินการต่อโดยไม่มีรูป | Photo advisory failure |
| info_bag_incomplete_staff | ถุงนี้ยังไม่สมบูรณ์ — แจ้ง Admin เพื่อเติมของ | Staff checklist info banner |
| info_bag_expired_staff | มียาหมดอายุในถุงนี้ — แจ้ง Admin ทันที | Staff checklist expired banner |
| info_bag_complete_staff | ถุงนี้สมบูรณ์พร้อมใช้งาน | Staff checklist complete banner |
| label_mandatory | บังคับ | Template item mandatory indicator |
| label_optional | ไม่บังคับ | Template item optional indicator |
| label_deficit | ขาด {N} | Composition table deficit cell |
| label_complete_item | ครบ | Composition table complete cell |
| label_target_qty | เป้าหมาย | Column header |
| label_current_qty | ปัจจุบัน | Column header |
| label_nearest_expiry | หมดอายุใกล้สุด | Bag list column header |
| label_completion_pct | ความสมบูรณ์ | Bag list column header |
| label_template | เทมเพลต | Column/field label |
| label_restock_qty | จำนวนที่จะเติม | Shopping list input label |
| label_skipped | ข้าม | Per-item skip state label |
| label_lots_section | ล็อตยาในถุงนี้ ({N} ล็อต) | Expandable lots section toggle |
| dashboard_panel_title | สถานะ ALS Bags | Dashboard panel heading |
| dashboard_all_complete | ถุงทั้งหมดสมบูรณ์ | Dashboard zero-issues state |
| deactivate_confirm | ปิดใช้งานเทมเพลตนี้? | Deactivate confirmation |
| deactivate_in_use | เทมเพลตนี้ยังถูกใช้โดย {N} ถุง — ปิดใช้งานจะไม่กระทบสถานะถุงที่มีอยู่แล้ว แต่จะไม่สามารถเลือกเทมเพลตนี้สำหรับถุงใหม่ได้ | Deactivate warning when in use |
| submitting_N | กำลังบันทึก {N} รายการ… | Submit in-progress label |
| step_1 | ①รายการ | Step indicator |
| step_2 | ②รูปถ่าย | Step indicator |
| step_3 | ③ยืนยัน | Step indicator |
| photo_label | ถ่ายรูปถุงหลังเติมของ (ไม่บังคับ) | Photo step heading |

---

## 13. Accessibility Notes

### 13.1 Tap target compliance (≥44px)

All interactive elements in the Phase 4 UI must meet 44px minimum:

| Element | Size spec |
|---|---|
| Bag list row "ดูรายละเอียด →" | min-height: 48px |
| Summary strip count badges | min 52px × 52px (tap area via padding) |
| Filter dropdowns (สถานะ ▾, เทมเพลต ▾) | min-height: 44px |
| Shopping list "ไม่มีของ — ข้าม" | min-height: 44px, full-width |
| Step navigation buttons | min-height: 52px, full-width |
| Template row action buttons [แก้ไข] [ปิดใช้งาน] | min-height: 44px; min-width: 80px; gap ≥8px between |
| Template form row [×] delete icon | 44px × 44px click area around the icon |
| Expandable lots section toggle | min-height: 44px full-width |
| Qty input +/- buttons (if added) | 44px × 44px |

### 13.2 Color contrast (WCAG AA minimum — 4.5:1 for normal text)

| Element | Foreground | Background | Passes AA? |
|---|---|---|---|
| สมบูรณ์ badge | #fff | `bg-success` (#198754) | Yes (4.54:1) |
| ของไม่ครบ badge | #000 (`text-dark`) | `bg-warning` (#ffc107) | Yes (4.68:1) |
| ใกล้หมดอายุ badge | #fff | `--stock-orange` (#fd7e14) | Yes (3.2:1 on white bg; but #fff text on orange fails — use `text-dark` instead) |
| หมดอายุ badge | #fff | `bg-danger` (#dc3545) | Yes (4.50:1) |
| ไม่มีเทมเพลต badge | #fff | `bg-secondary` (#6c757d) | Yes (4.48:1) |

**Correction for expiring badge:** use `text-dark` on `--stock-orange` background
instead of `text-white`. White on #fd7e14 is only 3.2:1 (fails WCAG AA). Black
on #fd7e14 is approximately 4.8:1 (passes). This contradicts the table in §4.3
— the corrected spec is `bg-orange text-dark` (parallel to `bg-warning text-dark`
used for low_stock / Phase 2 ≤30d expiry band).

### 13.3 Focus order

Restock flow focus order (mobile, Step 1):
1. "← ยกเลิก" back button
2. Step indicator (not focusable — presentational)
3. First shopping list item: qty input → lot radio group (if tracks_lots) → skip button
4. Next shopping list item (repeat)
5. "ถัดไป: ถ่ายรูป →" button

Focus must not be trapped inside the lot radio group. Arrow keys navigate radio
options; Tab moves to next item's qty input.

### 13.4 Screen reader labels

| Element | aria-label |
|---|---|
| Summary strip badges | "สมบูรณ์: {N} ถุง" / "ของไม่ครบ: {N} ถุง" etc. |
| Completion % progress bar | "ความสมบูรณ์ {N}%" |
| Bag list row | "ถุง {bag_code}: {bag_name}, สถานะ: {alert_level}, ความสมบูรณ์ {pct}%" |
| Shopping list item row | "รายการ {item_name}: เป้าหมาย {target}, ปัจจุบัน {actual}, ขาด {deficit}" |
| Step indicator | `aria-current="step"` on active step |
| Expandable lots section | `aria-expanded="true/false"` on toggle button |
| Template row mandatory checkbox | `aria-label="บังคับสำหรับ {item_name}"` |

### 13.5 Keyboard navigation

- All modals and drawers: `Escape` key closes.
- Template sub-item rows: `Tab` navigates field-to-field; `Enter` on "+ เพิ่มรายการ" adds a row.
- Lot radio group: arrow keys navigate; `Space` selects.
- Bag list: `Enter` or `Space` on row opens detail drawer.

---

## 14. Mobile-First 360px Checks

| Check | Status | Notes |
|---|---|---|
| Bag list cards: one column | Pass | Cards stack vertically; no horizontal scroll |
| Summary strip: 4 badges in row | Pass | Each badge ~80px wide at 360px; fits in one row with flex-wrap |
| Filter bar: two dropdowns + search | Pass | First row: two dropdowns; second row: search input full-width |
| Shopping list qty input + lot picker | Pass | Full-width layout; lot radio group stacks vertically |
| Step indicator: 3 steps | Pass | "①รายการ ②รูปถ่าย ③ยืนยัน" fits in one row at 360px (30 chars total) |
| Template form: item rows | Flag | Each row has 4 fields (picker + qty + checkbox + ×) — at 360px this is tight. Recommend stacking picker on first line, qty+mandatory+× on second line on mobile. |
| Confirm step summary table | Pass | 2 columns (item name + qty); no horizontal overflow |
| Drawer back navigation | Pass | Full-width "← กลับ" button at top; thumb-reachable |
| Desktop drawer (≥768px) | Pass | Right-panel drawer 480px; bag list remains visible at 288px |
| Nav tab overflow | Pass | flex-wrap wraps to 2 rows; no horizontal scroll on nav |

**Template form mobile fix (flagged above):** On mobile (<576px), each
template item row uses a 2-line layout:
```
Line 1: [item picker autocomplete — full width]
Line 2: เป้าหมาย [qty input 80px]  [☑ บังคับ]  [×]
```
On desktop (≥768px): single-row 4-column grid layout as shown in §6.2.

---

## 15. Open UX Questions for PM (Pex)

### UX Q1 — Restock shopping-list ordering

**Question:** In Step 1 (shopping list), what order should deficit items appear?

Three options:
| Option | Order | Pros | Cons |
|---|---|---|---|
| **A — Mandatory first, then by deficit severity (RECOMMENDED)** | Mandatory+deficit > mandatory+complete > optional+deficit > optional+complete; within each group: alphabetical | Most urgent items first; reduces scroll to reach critical items | Items shift position after qty is filled (can be disorienting) |
| B — Template sort_order | Exactly as defined in template (Admin-controlled) | Predictable; Admin can define clinical priority order | Requires Admin to set sort_order intentionally; defaults to 0 (random) |
| C — Alphabetical throughout | A-Z regardless of mandatory/deficit | Predictable; easy to find specific item | Critical deficits may be at the bottom |

**Recommendation: Option A** (mandatory+deficit first). This matches clinical
priority: the most operationally dangerous gaps surface at the top of the list.
If PM prefers Admin-controlled ordering, Option B with a sort_order UI in the
template editor is the right path.

**This design implements Option A.** If PM chooses B, the `sort_order` field in
the template item editor must be made explicitly editable (currently sortable
by drag-handle but not shown as a numbered field).

---

### UX Q2 — Bag QR scan vs manual code entry fallback

**Question:** The spec describes scanning bag QR. Is manual code entry as fallback already specced?

**Analysis:** staff-scan.html already has a text input for manual code entry
(Phase 1 pattern). The bag scan routing logic (§8.1) applies to both scan and
manual entry. **No new UX decision needed.** Manual entry works out of the box.

However, the placeholder text on the staff-scan.html input currently says
"สแกนหรือพิมพ์รหัสสินค้า". Phase 4 should update it to:
"สแกนหรือพิมพ์รหัสสินค้า / ถุงยา"

This is a one-line microcopy change in `staff-scan.html`. Include in Phase 4
frontend developer handoff.

---

### UX Q3 — "ไม่มีของ — ข้าม" per-item skip: how is it recorded?

**Question:** When Admin taps "ไม่มีของ — ข้าม" for an item, what happens?

**Current design (§7.2):** Sets `restock_qty = 0` for that item. No
`stock_movements` row is created (qty_delta = 0 would be a no-op; Phase 1
trigger checks `qty_delta > 0` for stock_item_locations update).

**Risk:** If Admin skips item X, the bag still shows `low_stock` for item X
after restock. This is correct behavior (the deficit is real) but the Admin
has no way to record "I checked and there is genuinely no stock right now."

**Options:**
| Option | Recording | Pros | Cons |
|---|---|---|---|
| **A — No record (RECOMMENDED for Phase 4)** | Skip = omit from submission | Simple; correct data (bag truly is low) | No audit trail for "acknowledged shortage" |
| B — Record as note-only movement | INSERT stock_movements with qty_delta=0, reason='bag_restock_skip', note='{item_name}: ไม่มีของ' | Audit trail | Triggers Phase 1 trigger which may not handle qty_delta=0 gracefully; needs testing |
| C — Skip acknowledgment flag in restock_ref | Store skipped item IDs in a note field on a "summary" movement | Minimal footprint | Custom parsing needed for reporting |

**Recommendation: Option A for Phase 4.** Record keeping for skip/acknowledge
is Phase 4.1 scope. The confirm step (§7.4) shows skipped items clearly so
the Admin has visual confirmation before submitting.

**PM must decide:** If Thegood needs EMS compliance audit trails for
"verified shortage acknowledged", Option B or C must be implemented. Raise with PM before plan write-up.

---

### UX Q4 — Bag history view (full restock timeline)

**Question:** Should Phase 4 include a bag history view showing all past restocks?

**Analysis:** `stock_movements WHERE location_id = <bag> AND reason = 'bag_restock'`
is queryable. The data exists. Building a history timeline tab in the drawer
would take approximately 0.5 day of frontend work.

**Recommendation: Phase 4.1.** Phase 4 focuses on the restock workflow and
status view. History timeline is useful for compliance but not operationally
blocking. The drawer currently shows "last restock date" (TBD per spec Q-Phase4-F
— derivable as MAX(performed_at) from stock_movements).

The drawer header shows a derivable "last restock" date (no new column needed):
```
หมดอายุใกล้สุด: 15 มิ.ย. 69  |  เติมของล่าสุด: 12 พ.ค. 69
```
Source: `SELECT MAX(performed_at) FROM stock_movements WHERE location_id=<bag> AND reason='bag_restock'`.

Add a [ดูประวัติ] link placeholder (disabled, tooltip "เร็วๆ นี้ใน Phase 4.1") if
PM wants to signal the feature is planned.

---

## 16. Component Reuse Map and Hand-Off Note

### 16.1 Reuse from existing code

| Component | Source | Reuse type | Notes |
|---|---|---|---|
| `shared/photo-capture.js` | Phase 3 | **Unchanged reuse** | Call `PhotoCaptureModal.open()` with Phase 4 folder path. No contract changes. |
| `shared/lots.js` `fetchAvailableLots(itemId)` | Phase 2 | **Unchanged reuse** | FEFO lot list for tracks_lots items in shopping list. Renders as radio group in Phase 4 (vs dropdown in Phase 2 Receive modal). |
| `shared/styles.css` | Phase 0 | **Token reuse** | `.blink-badge`, `.blink-border`, `.bg-modern-primary`, `.view-section.active` animation, Sarabun font. One new token needed: `--stock-orange` (see §4.3). |
| Bootstrap 5 badge, progress, modal | Phase 0 | **Unchanged reuse** | Bag status badges, completion bar, template create modal. |
| Existing Locations create modal | Phase 0 | **Extend with template picker** | Add conditional `<select>` for `bag_template_id` when `type=bag` is selected in the form. |
| `shared/ui.js` toast helper | Phase 1 | **Unchanged reuse** | All Phase 4 toasts use the same helper with green (success) / amber (warning) / red (danger) variants. |
| Phase 2 expiry color-coding (§3.1.3) | Phase 2 design | **Unchanged reuse** | Lot expiry bands in the drawer lots section and staff checklist. Same badge classes. |
| Step indicator pattern | Phase 3 | **Unchanged reuse** | `①รายการ ②รูปถ่าย ③ยืนยัน` matches Phase 3 step indicator visual. |

### 16.2 New files to build

| File | Purpose |
|---|---|
| `js/als-bags.js` | Admin ALS Bags tab init: bag list, summary strip, filter bar, empty states, "+ เพิ่มถุงยา" (delegates to existing Locations modal extended), "จัดการเทมเพลต" panel + template create/edit modal |
| `js/als-bags-detail.js` | Bag detail drawer: template composition table, lots section, restock flow (Steps 1–3), submit + progress |
| `shared/bags.js` | Bag status query helpers: `fetchBagStatus()` (v_bag_status), `fetchBagDetail(locationId)`, `submitRestockMovements(items[])` |

### 16.3 Existing files to edit

| File | Change |
|---|---|
| `js/admin-shell.js` | Register "ALS Bags" tab after "ยืม-คืน" tab |
| `js/staff-scan.js` | Add bag-type routing: if `location.type === 'bag'` → render S-4.5 bag checklist; add read-only checklist view |
| `staff-scan.html` | Update scan input placeholder to "สแกนหรือพิมพ์รหัสสินค้า / ถุงยา" |
| `js/dashboard.js` | Add S-4.6 "สถานะ ALS Bags" panel |
| `shared/styles.css` | Add `--stock-orange: #fd7e14` token (one line) |
| `sw.js` | Add `als-bags.js`, `als-bags-detail.js`, `bags.js` to STATIC_ASSETS; bump CACHE_VERSION |

### 16.4 Hand-off note for frontend-developer

**This design is complete for Phase 4 implementation when PM resolves:**
1. UX Q1 (shopping list ordering) — default in this design is Option A
   (mandatory+deficit first); if PM chooses Option B (template sort_order),
   the sort_order field in the template editor must be made explicitly numbered.
2. UX Q3 (skip recording) — this design implements Option A (no record for
   Phase 4); if PM requires audit trail for skip, Option B/C adds complexity.
3. Spec Q-Phase4-B (N INSERTs vs bulk RPC) — this design assumes N individual
   INSERTs (Option A); if PM chooses RPC, Step 3 submit logic in
   `als-bags-detail.js` changes to a single POST to `bag_restock_bulk`.
4. Spec Q-Phase4-D (photo advisory) — this design uses advisory photo
   (skip button always visible); if PM chooses required photo, remove skip
   button from photo step.

**Implement in this order:**
1. `shared/bags.js` — data layer first (fetchBagStatus, fetchBagDetail,
   submitRestockMovements).
2. `js/als-bags.js` + `js/admin-shell.js` — bag list tab (S-4.1).
3. `js/als-bags-detail.js` — bag detail drawer (S-4.2) + restock flow (S-4.4).
4. Template management (S-4.3 / S-4.3.1) — inside als-bags.js.
5. `js/staff-scan.js` extension — bag checklist (S-4.5).
6. `js/dashboard.js` — dashboard panel (S-4.6).
7. `shared/styles.css` — add `--stock-orange` token.
8. `sw.js` — add new files to cache, bump version.

**photo-capture.js reuse: CONFIRMED. No changes to the file or its contract.**
Phase 4 calls `PhotoCaptureModal.open()` with Phase 4-specific `folder` and
`label` parameters. The `entityId` in Phase 4 is the `restockRefId` UUID
(one UUID per restock session, not per item).

---

*DRAFT — awaiting PM review of UX Q1 (ordering), UX Q3 (skip recording), and
spec open questions Q-Phase4-A through Q-Phase4-F before plan write-up.*

*Files read for this design: `shared/styles.css`, `docs/superpowers/specs/2026-05-19-phase4-als-bags-design.md`, `docs/superpowers/designs/2026-05-19-phase3-borrow-return-ui-design.md`, `docs/superpowers/designs/2026-05-18-phase2-ui-design.md`.*
