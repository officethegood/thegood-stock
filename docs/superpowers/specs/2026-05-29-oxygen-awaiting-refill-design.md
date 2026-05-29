# Oxygen "Awaiting Refill" State — Design

**Date:** 2026-05-29
**Status:** Approved (design), pending implementation
**Author:** brainstorm session with Pex (officethegood/thegood-stock)

## Problem

The oxygen state machine has no state for a tank that has been **taken off the
truck but not yet sent to the refill vendor**. Crews bring empty tanks down to
base and let them pile up, then send a batch to the vendor in one trip. Today
the only post-truck option toward refill is `on_board → refilling`, which jumps
straight to "at the vendor" and loses the "waiting at base" phase.

## Goal

Add a first-class `awaiting_refill` state so the pipeline is:

```
on_board (อยู่บนรถ)
  → awaiting_refill (ลงมากองรอที่ฐาน)
  → refilling (ส่งไปที่ร้าน กำลังเติม)
  → ready (เสร็จ พร้อมใช้)
```

`refilling` changes meaning from "needs refill (waiting + at vendor)" to
"**at the vendor, being refilled**" only.

## Decisions (locked in brainstorm)

| # | Decision |
|---|---|
| D1 | Approach: add a 6th enum value `awaiting_refill` (first-class state), not a side column or location-only modelling. |
| D2 | Path: `on_board → awaiting_refill → refilling → ready` (2 distinct staff steps). |
| D3 | Both legacy transitions kept: `on_board → refilling` (send straight from truck) AND `on_board → ready` (return unused tank). |
| D4 | Permissions: `on_board → awaiting_refill` = staff; `awaiting_refill → refilling` = staff; `awaiting_refill → ready` = **admin** (correction/escape hatch); `refilling → ready` = admin (unchanged). |
| D5 | Refill-batch alert fires on **`awaiting_refill`** count ≥ threshold (not `refilling`). |
| D6 | Backfill: every tank currently in `refilling` → `awaiting_refill`. |

## Data model

`oxygen_tank_status` enum: 5 → 6 values.

```
ready · on_board · [awaiting_refill ← NEW] · refilling · maintenance · retired
```

`awaiting_refill` is inserted **BEFORE `refilling`** so dashboard sort order
reads ready → on_board → awaiting_refill → refilling → maintenance → retired.

| value | label (FE STATUS_LABELS) | badge (STATUS_BADGE_CLASS) |
|---|---|---|
| `awaiting_refill` (new) | `รอส่งเติม` | `badge bg-warning text-dark` (amber — needs action) |
| `refilling` (relabel) | `รอเติม` → **`กำลังเติม`** | `badge bg-warning text-dark` → **`badge bg-info text-dark`** (cyan — in progress at vendor) |

All other labels/badges unchanged.

## State machine (server: `enforce_oxygen_state_machine`)

Add three allowed combinations to the transition table; keep all existing ones:

```
(from='on_board'        AND to='awaiting_refill')                  -- staff or admin
(from='awaiting_refill' AND to='refilling')                        -- staff or admin
(from='awaiting_refill' AND to='ready'   AND role='Admin')         -- admin cancel/correction
```

Existing kept: null→ready (admin), ready→on_board, on_board→ready,
on_board→refilling, refilling→ready (admin), *→maintenance (admin),
maintenance→ready (admin), *→retired (admin).

## Transition labels (verb + subtitle)

Single source `shared/oxygen.js TRANSITION_LABELS`, mirrored 1:1 by the
`notify_oxygen_movement_to_tg` trigger.

| from → to | emoji | verb | subtitle |
|---|---|---|---|
| `ready→on_board` | 🚐 | ขึ้นรถ | ติดถังขึ้นรถพยาบาล |
| `on_board→ready` | 🏠 | คืนถัง | นำถังกลับเข้าห้องเก็บ |
| `on_board→awaiting_refill` (new) | ⬇️ | ลงรอเติม | นำถังลงจากรถ มากองรอที่ฐาน |
| `on_board→refilling` (new explicit) | ⛽ | ส่งเติม | ถังหมดบนรถ ส่งร้านเลย |
| `awaiting_refill→refilling` (new) | 🚚 | ส่งร้าน | ส่งถังกองรอไปเติมที่ร้าน |
| `awaiting_refill→ready` (new) | ↩️ | ยกเลิกรอเติม | ถังยังมีแก๊ส ไม่ต้องเติม |
| `refilling→ready` | ✅ | เติมเสร็จ | เติมเสร็จ พร้อมใช้ |
| `maintenance→ready` | 🛠️ | ซ่อมเสร็จ | ซ่อมเสร็จ พร้อมใช้ |
| `*→maintenance` (fallback) | 🔧 | ส่งซ่อม | ส่งถังไปซ่อมบำรุง |
| `*→retired` (fallback) | ⛔ | ปลดระวาง | ปลดถังออกจากระบบ |

**Ordering rule (notify trigger):** the specific `(from,to)` branches —
especially `awaiting_refill→refilling` — MUST be evaluated **before** the broad
`ELSIF to_status='refilling'` branch, otherwise `awaiting_refill→refilling`
would be mislabelled "ส่งเติม".

## Client transition maps (`shared/oxygen.js`)

```js
ALLOWED_TRANSITIONS = {
  null:            ['ready'],
  ready:           ['on_board'],
  on_board:        ['ready', 'awaiting_refill', 'refilling'],
  awaiting_refill: ['refilling', 'ready'],   // ready is admin-only (see staff map)
  refilling:       ['ready'],                // admin only
  maintenance:     ['ready'],                // admin only
};

STAFF_ALLOWED_TRANSITIONS = {
  ready:           ['on_board'],
  on_board:        ['ready', 'awaiting_refill', 'refilling'],
  awaiting_refill: ['refilling'],            // NOT ready — that's the admin cancel
};
```

`getAllowedTransitions(from, isAdmin)` already intersects STAFF map with
ALLOWED map, so admin on `awaiting_refill` sees `[refilling, ready]`, staff sees
`[refilling]`. No change to that function.

## Refill-batch alert (`check_oxygen_refill_batch`)

```
Guard:  IF NEW.to_status <> 'awaiting_refill' THEN RETURN NEW;   (was 'refilling')
Count:  SELECT count(*) FROM oxygen_tanks WHERE status='awaiting_refill';
List:   tanks WHERE status='awaiting_refill';
Dedupe: 'oxygen_refill_batch:YYYY-MM-DD' (Bangkok) — unchanged, one alert/day.
Msg:    'ถังรอส่งเติม %s ถัง (ถึงเกณฑ์ %s ถัง) — รวบส่งร้านได้แล้ว\n<list>'
```

## Frontend touchpoints

| File | Change |
|---|---|
| `shared/oxygen.js` | `ALLOWED_TRANSITIONS`, `STAFF_ALLOWED_TRANSITIONS`, `STATUS_LABELS` (+awaiting_refill, relabel refilling), `STATUS_BADGE_CLASS` (+awaiting_refill, recolor refilling), `TRANSITION_LABELS` (+4 entries: on_board→awaiting_refill, on_board→refilling, awaiting_refill→refilling, awaiting_refill→ready), `getTankStatusCounts` init object (+`awaiting_refill: 0`). |
| `js/dashboard.js` | `statusRows` +awaiting_refill row (between on_board and refilling, recolor refilling to bg-info); alert source `counts.refilling` → `counts.awaiting_refill`; alert text → "ถังรอส่งเติม X ถัง". |
| `js/staff-oxygen.js` | `needsLoc` arrays (lines ~353, ~460): add `awaiting_refill`, `refilling`; step 4 location prompt: +`awaiting_refill` → "วางที่กองรอไหน?", +`refilling` → "ส่งร้านไหน?". |
| `js/oxygen.js` | admin modal `needsLoc` array (~line 938): add `awaiting_refill`, `refilling`. |
| `sw.js` | bump `CACHE_VERSION`. |

## Migrations (order matters — Postgres enum rule)

A new enum value cannot be **used** in the same transaction that **adds** it.
Split into two files:

1. `20260529010000_oxygen_awaiting_refill_enum.sql`
   - `ALTER TYPE oxygen_tank_status ADD VALUE IF NOT EXISTS 'awaiting_refill' BEFORE 'refilling';`
   - Nothing else. Must commit before file 2 runs.

2. `20260529010100_oxygen_awaiting_refill_logic.sql`
   - Backfill: `UPDATE oxygen_tanks SET status='awaiting_refill' WHERE status='refilling';`
     plus an `oxygen_movements` audit row per backfilled tank
     (from_status='refilling', to_status='awaiting_refill', note='ระบบ: ปรับสถานะตาม state ใหม่ awaiting_refill').
     The state-machine trigger allows refilling→awaiting_refill? **No** — so the
     backfill UPDATE is a direct table UPDATE by a migration (SECURITY context),
     NOT an oxygen_movements insert. Audit rows are optional and, if added, must
     be inserted with the state-machine trigger temporarily not blocking them.
     **Decision: backfill is a plain `UPDATE oxygen_tanks` only; no synthetic
     movement rows** (keeps it simple, avoids fighting the BEFORE INSERT trigger).
   - `CREATE OR REPLACE FUNCTION enforce_oxygen_state_machine()` — add 3 combos.
   - `CREATE OR REPLACE FUNCTION notify_oxygen_movement_to_tg()` — add 4 label
     branches in correct order (specific before broad refilling branch).
   - `CREATE OR REPLACE FUNCTION check_oxygen_refill_batch()` — switch guard +
     count + message to `awaiting_refill`.
   - No trigger re-create needed (bindings are by function name).

Applied via Supabase Dashboard SQL Editor (officethegood / thegood-stock),
file 1 run and committed first, then file 2.

## Testing (manual + live — no test runner)

- T-AR1: staff scan an `on_board` tank → wizard shows "⬇️ ลงรอเติม" card.
- T-AR2: do `on_board → awaiting_refill` → Telegram "⬇️ ลงรอเติม · serial · user · loc".
- T-AR3: do `awaiting_refill → refilling` → Telegram "🚚 ส่งร้าน".
- T-AR4: admin `awaiting_refill → ready` → Telegram "↩️ ยกเลิกรอเติม"; staff does NOT see this card.
- T-AR5: push `awaiting_refill` count to threshold → batch alert "ถังรอส่งเติม X ถัง".
- T-AR6: dashboard shows 6 status badges in order; alert counts awaiting_refill.
- T-AR7: backfill — every tank that was `refilling` now reads `awaiting_refill`.
- T-AR8 (regression): ready→on_board, on_board→ready, on_board→refilling (direct), refilling→ready still work and notify correctly.

## Out of scope

- Vendor-specific tracking beyond a free location (e.g. which vendor, ETA).
- Auto-transition / time-based escalation.
- Changes to maintenance/retired flows.
