# Oxygen Tank Inspection Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the half-built oxygen-tank inspection feature — make tank fields editable after creation, make the inspection-date field self-explanatory, and add a daily Telegram alert for tanks due for hydrostatic inspection.

**Architecture:** Three independent units. (A) A SECURITY DEFINER RPC `rpc_update_oxygen_tank` is the controlled edit path — `oxygen_tanks` RLS stays `USING(false)` so status still changes only through the movement ledger. (B) A daily `pg_cron` job `check_oxygen_inspection_due()` sends one Telegram alert per tank entering the due-soon window, reusing the `tg-notify` Edge Function. (C) Frontend adds an Admin "แก้ไขถัง" modal, clearer form labels, and an "เกินกำหนด" badge.

**Tech Stack:** Supabase Postgres (plpgsql, pg_cron, pg_net), vanilla JS (Bootstrap 5), service-worker PWA. Migrations applied via the Supabase web Dashboard SQL Editor (no CLI). No automated test runner — verification is manual.

**Source spec:** `docs/superpowers/specs/2026-05-21-oxygen-inspection-tracking-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `supabase/migrations/20260521010000_rpc_update_oxygen_tank.sql` | Admin edit RPC | Create |
| `supabase/migrations/20260521010100_oxygen_inspection_cron.sql` | Setting seed + alert function + cron schedule | Create |
| `shared/oxygen.js` | `updateTank()` REST helper + error mappings | Modify |
| `js/oxygen.js` | Edit modal, edit button, form clarity, overdue badge, PSI field | Modify |
| `sw.js` | Bump `CACHE_VERSION` | Modify |

Two execution tracks touch disjoint files and can run in parallel:
- **Track A (Backend):** Tasks 1–2 → migration files only.
- **Track B (Frontend):** Tasks 3–7 → `shared/oxygen.js`, `js/oxygen.js`, `sw.js`.
- **Track C (Deploy):** Tasks 8–9 → after A and B both finish.

---

## Track A — Backend

### Task 1: Edit RPC migration

**Files:**
- Create: `supabase/migrations/20260521010000_rpc_update_oxygen_tank.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/20260521010000_rpc_update_oxygen_tank.sql
-- Phase 5.1 — Admin RPC to edit mutable oxygen_tanks fields after creation.
--
-- Background:
--   oxygen_tanks RLS is FOR UPDATE USING (false) — all direct updates are
--   blocked; only apply_oxygen_movement() (SECURITY DEFINER) may write the
--   table. That makes tank_size / next_inspection_due / last_pressure_psi /
--   notes write-once-at-INSERT. This RPC is the controlled edit path for those
--   four columns. It NEVER references status / current_location_id /
--   last_refill_* — those change only through the oxygen_movements ledger.
--
-- Depends on:
--   20260519050200_oxygen_tanks.sql   (oxygen_tanks table)
--   20260520010000_lookup_lists.sql   (lookup_lists — tank_size validation)
--   Phase 0: app_user_role(), app_username() helpers.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION rpc_update_oxygen_tank(
  p_tank_id             uuid,
  p_tank_size           text,
  p_next_inspection_due date,
  p_last_pressure_psi   int,
  p_notes               text
) RETURNS oxygen_tanks
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $rpc_update_oxygen_tank$
DECLARE
  v_row oxygen_tanks;
BEGIN
  -- 1. Admin only.
  IF app_user_role() <> 'Admin' THEN
    RAISE EXCEPTION 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขข้อมูลถังได้';
  END IF;

  -- 2. tank_size must be an active lookup_lists value.
  IF NOT EXISTS (
    SELECT 1 FROM lookup_lists
    WHERE kind = 'tank_size' AND code = p_tank_size AND active = true
  ) THEN
    RAISE EXCEPTION 'ขนาดถังไม่ถูกต้อง: %', COALESCE(p_tank_size, 'NULL');
  END IF;

  -- 3. PSI, if provided, must be positive.
  IF p_last_pressure_psi IS NOT NULL AND p_last_pressure_psi <= 0 THEN
    RAISE EXCEPTION 'ค่าแรงดันต้องมากกว่า 0';
  END IF;

  -- 4. Update ONLY the four mutable columns + audit columns.
  UPDATE oxygen_tanks SET
    tank_size           = p_tank_size,
    next_inspection_due = p_next_inspection_due,
    last_pressure_psi   = p_last_pressure_psi,
    notes               = p_notes,
    updated_at          = now(),
    updated_by          = app_username()
  WHERE id = p_tank_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบถังที่ต้องการแก้ไข';
  END IF;

  RETURN v_row;
END;
$rpc_update_oxygen_tank$;

COMMENT ON FUNCTION rpc_update_oxygen_tank(uuid, text, date, int, text) IS
  'Phase 5.1. Admin-only edit path for oxygen_tanks mutable columns '
  '(tank_size, next_inspection_due, last_pressure_psi, notes). SECURITY DEFINER '
  'bypasses the USING(false) UPDATE RLS. Never touches status/location/refill — '
  'those change only via oxygen_movements.';

GRANT EXECUTE ON FUNCTION rpc_update_oxygen_tank(uuid, text, date, int, text)
  TO authenticated;

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Function exists and is SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname = 'rpc_update_oxygen_tank';
--    Expected: 1 row, prosecdef = true.
--
-- B) oxygen_tanks UPDATE RLS is UNCHANGED (still USING(false)):
--    SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--    FROM pg_policy WHERE polrelid = 'oxygen_tanks'::regclass
--      AND polname = 'oxygen_tanks_update_trigger_only';
--    Expected: using_expr = 'false'.
```

- [ ] **Step 2: Verify the SQL parses (dry check)**

Read the file back and confirm the `$rpc_update_oxygen_tank$` dollar-quote tags match (open and close), and that every `IF` has a matching `END IF`. (No DB connection available locally — actual execution happens in Task 8.)

---

### Task 2: Inspection alert cron migration

**Files:**
- Create: `supabase/migrations/20260521010100_oxygen_inspection_cron.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/20260521010100_oxygen_inspection_cron.sql
-- Phase 5.1 — Daily Telegram alert for oxygen tanks due for hydrostatic test.
--
-- Behaviour: one alert per tank, fired once when the tank's next_inspection_due
-- enters the window (today + OXYGEN_INSPECTION_ALERT_DAYS) OR is already
-- overdue. The dedupe key includes the due date, so re-scheduling the
-- inspection (Admin edits the date) produces a fresh alert next cycle.
--
-- Reuses the Phase 0 tg-notify Edge Function. Reads NOTIFY_* and the new
-- OXYGEN_INSPECTION_ALERT_DAYS from the settings table (NOT current_setting —
-- Project.md gotcha: ALTER DATABASE app.* is blocked on Supabase Free/Nano).
--
-- Dependency note: tg-notify writes a notification_log row keyed by the
-- payload dedupe_key on success — the same mechanism check_oxygen_refill_batch()
-- relies on. Task 8 verifies a notification_log row appears after a test run.
--
-- Depends on:
--   20260519050200_oxygen_tanks.sql, settings (Phase 0), notification_log,
--   pg_net + pg_cron extensions, tg-notify Edge Function (Phase 0).
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING; CREATE OR REPLACE FUNCTION;
--             cron.unschedule guard + cron.schedule.

-- ── 1. Seed the configurable alert window (default 30 days) ─────────────────
INSERT INTO settings (key, value)
VALUES ('OXYGEN_INSPECTION_ALERT_DAYS', '30')
ON CONFLICT (key) DO NOTHING;

-- ── 2. The alert function ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_oxygen_inspection_due()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $check_oxygen_inspection_due$
DECLARE
  v_supabase_url     text;
  v_service_role_key text;
  v_enabled          boolean;
  v_chat_id          text;
  v_alert_days       int;
  v_today            date;
  v_tank             record;
  v_dedupe_key       text;
  v_already_sent     int;
  v_days_diff        int;
  v_when_text        text;
  v_payload          jsonb;
BEGIN
  -- Read settings from the settings table.
  SELECT value INTO v_supabase_url     FROM settings WHERE key = 'NOTIFY_SUPABASE_URL';
  SELECT value INTO v_service_role_key FROM settings WHERE key = 'NOTIFY_SERVICE_ROLE_KEY';
  SELECT (value = 'true') INTO v_enabled
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_ENABLED';
  SELECT value INTO v_chat_id
    FROM settings WHERE key = 'NOTIFY_TELEGRAM_CHAT_ID';
  SELECT value::int INTO v_alert_days
    FROM settings WHERE key = 'OXYGEN_INSPECTION_ALERT_DAYS';

  -- Guard: notify credentials not configured.
  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE WARNING
      'check_oxygen_inspection_due: NOTIFY_SUPABASE_URL หรือ NOTIFY_SERVICE_ROLE_KEY '
      'ยังไม่ได้ตั้งค่า — ข้ามการแจ้งเตือน';
    RETURN;
  END IF;

  -- Guard: Telegram globally disabled.
  IF v_enabled IS NOT TRUE THEN
    RETURN;
  END IF;

  v_alert_days := COALESCE(v_alert_days, 30);
  v_today      := (now() AT TIME ZONE 'Asia/Bangkok')::date;

  -- One alert per tank in the window (due-soon OR overdue), excluding retired.
  FOR v_tank IN
    SELECT id, serial, tank_size, next_inspection_due
    FROM oxygen_tanks
    WHERE next_inspection_due IS NOT NULL
      AND next_inspection_due <= v_today + v_alert_days
      AND status <> 'retired'
    ORDER BY next_inspection_due
  LOOP
    v_dedupe_key := 'oxygen_inspection_due:' || v_tank.id || ':'
                    || v_tank.next_inspection_due;

    SELECT count(*) INTO v_already_sent
    FROM notification_log
    WHERE dedupe_key = v_dedupe_key AND success = true;

    IF v_already_sent > 0 THEN
      CONTINUE;  -- this tank+due-date already alerted
    END IF;

    v_days_diff := v_tank.next_inspection_due - v_today;
    IF v_days_diff < 0 THEN
      v_when_text := format('เกินกำหนด %s วัน', abs(v_days_diff));
    ELSIF v_days_diff = 0 THEN
      v_when_text := 'ครบกำหนดวันนี้';
    ELSE
      v_when_text := format('อีก %s วัน', v_days_diff);
    END IF;

    v_payload := jsonb_build_object(
      'event_type', 'oxygen_inspection_due',
      'dedupe_key', v_dedupe_key,
      'message', format(
        '[Stock] ถังออกซิเจน %s (%s) ครบกำหนดทดสอบถัง %s (%s)',
        v_tank.serial, v_tank.tank_size, v_tank.next_inspection_due, v_when_text
      ),
      'chat_id', v_chat_id
    );

    PERFORM net.http_post(
      url     := v_supabase_url || '/functions/v1/tg-notify',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_role_key,
        'apikey',        v_service_role_key,
        'X-Internal',    'true'
      ),
      body    := v_payload::text
    );
  END LOOP;

  RETURN;
END;
$check_oxygen_inspection_due$;

COMMENT ON FUNCTION check_oxygen_inspection_due() IS
  'Phase 5.1. Daily pg_cron job. Sends one Telegram alert per oxygen tank whose '
  'next_inspection_due is within OXYGEN_INSPECTION_ALERT_DAYS (or already '
  'overdue) and not retired. Dedupe key '
  'oxygen_inspection_due:<tank_id>:<due_date> — one alert per tank per '
  'due-date. Reuses tg-notify; reads NOTIFY_* from the settings table.';

-- ── 3. Schedule daily at 02:00 UTC = 09:00 Asia/Bangkok ────────────────────
DO $cron_oxygen_inspection$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'oxygen_inspection_alert') THEN
    PERFORM cron.unschedule('oxygen_inspection_alert');
  END IF;
END
$cron_oxygen_inspection$;

SELECT cron.schedule(
  'oxygen_inspection_alert',
  '0 2 * * *',
  $$SELECT check_oxygen_inspection_due()$$
);

-- ==========================================================================
-- Verification SQL (paste in Dashboard SQL Editor after applying)
-- ==========================================================================
-- A) Setting seeded:
--    SELECT key, value FROM settings WHERE key = 'OXYGEN_INSPECTION_ALERT_DAYS';
--    Expected: 1 row, value = '30'.
--
-- B) Function exists, SECURITY DEFINER:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname = 'check_oxygen_inspection_due';
--    Expected: 1 row, prosecdef = true.
--
-- C) Cron job registered:
--    SELECT jobname, schedule FROM cron.job
--    WHERE jobname = 'oxygen_inspection_alert';
--    Expected: 1 row, schedule = '0 2 * * *'.
--
-- D) Manual smoke run (does nothing harmful if no tanks are due):
--    SELECT check_oxygen_inspection_due();
--    Expected: no error.
```

- [ ] **Step 2: Verify the SQL parses (dry check)**

Read the file back and confirm: all four dollar-quote tag pairs match
(`$check_oxygen_inspection_due$`, `$cron_oxygen_inspection$`, `$$...$$`), every
`IF`/`LOOP` has a matching `END IF`/`END LOOP`, and the function body is
syntactically balanced.

- [ ] **Step 3: Commit Track A**

```bash
git add supabase/migrations/20260521010000_rpc_update_oxygen_tank.sql supabase/migrations/20260521010100_oxygen_inspection_cron.sql
git commit -m "feat(oxygen): inspection edit RPC + due-date alert cron migrations"
```

---

## Track B — Frontend

### Task 3: `shared/oxygen.js` — `updateTank()` helper

**Files:**
- Modify: `shared/oxygen.js`

- [ ] **Step 1: Add the `updateTank` function**

Insert this function immediately AFTER the `logTransition` function (after its
closing `}` and before the `getTankStatusCounts` function):

```js
  /**
   * Update an oxygen tank's mutable fields (Admin only).
   * Calls the rpc_update_oxygen_tank SECURITY DEFINER function — status,
   * location and refill columns CANNOT be changed through this path.
   *
   * @param {{
   *   tankId:            string,
   *   tankSize:          string,
   *   nextInspectionDue: string|null,   // 'YYYY-MM-DD' or null
   *   lastPressurePsi:   number|null,
   *   notes:             string|null,
   * }} opts
   * @returns {Promise<{ data: object, error: null }>}
   */
  async function updateTank({ tankId, tankSize, nextInspectionDue, lastPressurePsi, notes }) {
    if (!tankId)   throw new Error('[AppOxygen.updateTank] tankId is required');
    if (!tankSize) throw new Error('[AppOxygen.updateTank] tankSize is required');

    const sb = _sb();
    const { data, error } = await sb.rpc('rpc_update_oxygen_tank', {
      p_tank_id:             tankId,
      p_tank_size:           tankSize,
      p_next_inspection_due: nextInspectionDue || null,
      p_last_pressure_psi:   (lastPressurePsi ?? null),
      p_notes:               notes || null,
    });
    if (error) _throw(error);
    return { data, error: null };
  }
```

- [ ] **Step 2: Add error mappings**

In the `_mapError` function, add these three checks immediately BEFORE the
final `return null;` line:

```js
    if (msg.includes('เฉพาะผู้ดูแลระบบ')) {
      return 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขข้อมูลถังได้';
    }
    if (msg.includes('ขนาดถังไม่ถูกต้อง')) {
      return 'ขนาดถังไม่ถูกต้อง กรุณาเลือกใหม่';
    }
    if (msg.includes('ค่าแรงดันต้องมากกว่า')) {
      return 'ค่าแรงดันต้องเป็นตัวเลขมากกว่า 0';
    }
```

- [ ] **Step 3: Register `updateTank` in the public namespace**

In the `window.AppOxygen = { ... }` object, in the `// REST helpers` group, add
`updateTank,` on the line immediately after `logTransition,`:

```js
    // REST helpers
    listTanks,
    getTankBySerial,
    getTankHistory,
    logTransition,
    updateTank,
    getTankStatusCounts,
    subscribeOxygenTanks,
```

- [ ] **Step 4: Manual verify**

Confirm the file still parses (no syntax error): the new function is inside the
IIFE, `updateTank` appears exactly once in the namespace object, and the three
`_mapError` checks sit before `return null;`.

---

### Task 4: `js/oxygen.js` — overdue badge

**Files:**
- Modify: `js/oxygen.js` (the `_inspectionWarning` function, ~line 72)

- [ ] **Step 1: Replace `_inspectionWarning`**

Replace the entire existing `_inspectionWarning` function:

```js
  function _inspectionWarning(dateStr) {
    if (!dateStr) return '';
    const days = Math.floor((new Date(dateStr) - new Date()) / 86400000);
    if (days <= 30) return ' <span class="badge bg-danger ms-1">ตรวจด่วน</span>';
    if (days <= 90) return ' <span class="badge bg-warning text-dark ms-1">ใกล้ถึงกำหนด</span>';
    return '';
  }
```

with:

```js
  function _inspectionWarning(dateStr) {
    if (!dateStr) return '';
    const days = Math.floor((new Date(dateStr) - new Date()) / 86400000);
    if (days < 0)   return ' <span class="badge bg-danger ms-1">เกินกำหนด</span>';
    if (days <= 30) return ' <span class="badge bg-danger ms-1">ตรวจด่วน</span>';
    if (days <= 90) return ' <span class="badge bg-warning text-dark ms-1">ใกล้ถึงกำหนด</span>';
    return '';
  }
```

---

### Task 5: `js/oxygen.js` — add-tank form clarity + PSI field

**Files:**
- Modify: `js/oxygen.js` (add-tank modal HTML in `_renderShell`; `_openAddModal`; `_saveNewTank`)

- [ ] **Step 1: Update the add-tank modal HTML**

In `_renderShell`, find this block (the inspection field of the add modal):

```html
              <div class="mb-3">
                <label class="form-label" for="oxy-add-inspection">วันตรวจสอบครั้งถัดไป</label>
                <input type="date" id="oxy-add-inspection" class="form-control">
              </div>
```

Replace it with (adds a PSI field above, relabels, adds helper text):

```html
              <div class="mb-3">
                <label class="form-label" for="oxy-add-pressure">ค่าแรงดันล่าสุด (PSI)</label>
                <input type="number" id="oxy-add-pressure" class="form-control"
                       min="1" placeholder="เช่น 2000" autocomplete="off">
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-add-inspection">วันครบกำหนดทดสอบถัง (ครั้งถัดไป)</label>
                <input type="date" id="oxy-add-inspection" class="form-control">
                <div class="form-text">วันครบกำหนดส่งทดสอบสภาพ/แรงดันถังครั้งถัดไป — เว้นว่างได้</div>
              </div>
```

- [ ] **Step 2: Reset the PSI field when the modal opens**

In `_openAddModal`, find the field-reset array and add `'oxy-add-pressure'`:

```js
    ['oxy-add-serial','oxy-add-size','oxy-add-location','oxy-add-inspection','oxy-add-notes','oxy-add-pressure']
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
```

- [ ] **Step 3: Read + validate + insert PSI in `_saveNewTank`**

In `_saveNewTank`, find the variable declarations at the top of the function and
add the `pressureRaw` read after the `notes` line:

```js
    const notes     = document.getElementById('oxy-add-notes')?.value.trim() || null;
    const pressureRaw = document.getElementById('oxy-add-pressure')?.value;
```

Then, after the existing `if (!locationId) { ... }` validation line and BEFORE
`if (errEl) errEl.classList.add('d-none');`, add PSI validation:

```js
    const pressure = pressureRaw ? parseInt(pressureRaw, 10) : null;
    if (pressure !== null && (!Number.isFinite(pressure) || pressure <= 0)) {
      _showErr('ค่าแรงดันต้องเป็นตัวเลขมากกว่า 0'); return;
    }
```

Then in the `sb.from('oxygen_tanks').insert({ ... })` call, add the
`last_pressure_psi` key:

```js
      const { data: tankData, error: tankErr } = await sb.from('oxygen_tanks').insert({
        serial,
        tank_size:           size,
        current_location_id: locationId,
        next_inspection_due: inspection,
        last_pressure_psi:   pressure,
        notes,
      }).select().single();
```

---

### Task 6: `js/oxygen.js` — edit-tank modal

**Files:**
- Modify: `js/oxygen.js` (edit modal HTML in `_renderShell`; drawer footer in `_renderShell`; `_openDetailDrawer`; new `_openEditModal` + `_saveEditTank`)

- [ ] **Step 1: Add the edit-modal HTML**

In `_renderShell`, find the closing of the add-tank modal — the `</div>` line
that ends `<!-- Add tank modal -->` (the add modal's outermost `</div>`, right
before `<!-- Tank detail / history drawer (offcanvas) -->`). Immediately AFTER
that closing `</div>` and before the drawer comment, insert:

```html
      <!-- Edit tank modal (Admin only) -->
      <div class="modal fade" id="oxy-edit-modal" tabindex="-1"
           aria-labelledby="oxy-edit-modal-label">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="oxy-edit-modal-label">แก้ไขข้อมูลถัง</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="ปิด"></button>
            </div>
            <div class="modal-body">
              <div id="oxy-edit-error" class="alert alert-danger d-none" role="alert"></div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-serial">หมายเลขถัง (Serial)</label>
                <input type="text" id="oxy-edit-serial" class="form-control" readonly disabled>
                <div class="form-text">หมายเลขถังแก้ไขไม่ได้</div>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-size">ขนาดถัง <span class="text-danger">*</span></label>
                <select id="oxy-edit-size" class="form-select" required>
                  <option value="">— เลือกขนาด —</option>
                </select>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-pressure">ค่าแรงดันล่าสุด (PSI)</label>
                <input type="number" id="oxy-edit-pressure" class="form-control"
                       min="1" placeholder="เช่น 2000" autocomplete="off">
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-inspection">วันครบกำหนดทดสอบถัง (ครั้งถัดไป)</label>
                <input type="date" id="oxy-edit-inspection" class="form-control">
                <div class="form-text">วันครบกำหนดส่งทดสอบสภาพ/แรงดันถังครั้งถัดไป — เว้นว่างได้</div>
              </div>
              <div class="mb-3">
                <label class="form-label" for="oxy-edit-notes">หมายเหตุ</label>
                <textarea id="oxy-edit-notes" class="form-control" rows="2" maxlength="500"></textarea>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">ยกเลิก</button>
              <button type="button" id="oxy-edit-save" class="btn btn-stock-primary"
                      style="min-height:40px;">บันทึก</button>
            </div>
          </div>
        </div>
      </div>
```

(The existing `init()` line `document.querySelectorAll('#tab-oxygen .modal')
.forEach((m) => document.body.appendChild(m))` automatically relocates this new
modal to `<body>` — no change to `init()` is needed.)

- [ ] **Step 2: Add the edit button to the drawer footer**

In `_renderShell`, find the drawer footer block:

```js
        ${_isAdmin() ? `
          <div class="p-3 border-top">
            <button type="button" id="oxy-btn-transition" class="btn btn-stock-primary w-100"
                    style="min-height:44px;">
              <i class="bi bi-arrow-repeat me-1"></i>เปลี่ยนสถานะ
            </button>
          </div>
        ` : ''}
```

Replace it with:

```js
        ${_isAdmin() ? `
          <div class="p-3 border-top d-grid gap-2">
            <button type="button" id="oxy-btn-edit" class="btn btn-outline-secondary"
                    style="min-height:44px;">
              <i class="bi bi-pencil-square me-1"></i>แก้ไขข้อมูลถัง
            </button>
            <button type="button" id="oxy-btn-transition" class="btn btn-stock-primary"
                    style="min-height:44px;">
              <i class="bi bi-arrow-repeat me-1"></i>เปลี่ยนสถานะ
            </button>
          </div>
        ` : ''}
```

- [ ] **Step 3: Wire the edit button in `_openDetailDrawer`**

In `_openDetailDrawer`, find the transition-button wiring block:

```js
    // Wire transition button
    const transBtn = document.getElementById('oxy-btn-transition');
    if (transBtn) {
      const newBtn = transBtn.cloneNode(true);
      transBtn.parentNode.replaceChild(newBtn, transBtn);
      newBtn.addEventListener('click', () => _openTransitionModal(tankId));
    }
```

Immediately AFTER that block, add:

```js
    // Wire edit button
    const editBtn = document.getElementById('oxy-btn-edit');
    if (editBtn) {
      const newEdit = editBtn.cloneNode(true);
      editBtn.parentNode.replaceChild(newEdit, editBtn);
      newEdit.addEventListener('click', () => _openEditModal(tankId));
    }
```

- [ ] **Step 4: Add `_openEditModal` and `_saveEditTank`**

Insert these two functions immediately AFTER the `_saveNewTank` function (after
its closing `}`, before the `// Tank detail / history drawer` comment block):

```js
  // =========================================================================
  // Edit-tank modal (Admin only)
  // =========================================================================

  async function _openEditModal(tankId) {
    const sb = window.getSupabaseClient();
    const { data: tank, error } = await sb.from('oxygen_tanks')
      .select('id, serial, tank_size, last_pressure_psi, next_inspection_due, notes')
      .eq('id', tankId).maybeSingle();
    if (error || !tank) { _toast('error', 'โหลดข้อมูลถังไม่สำเร็จ'); return; }

    document.getElementById('oxy-edit-serial').value     = tank.serial || '';
    document.getElementById('oxy-edit-pressure').value   = tank.last_pressure_psi ?? '';
    document.getElementById('oxy-edit-inspection').value = tank.next_inspection_due || '';
    document.getElementById('oxy-edit-notes').value      = tank.notes || '';

    const sizeEl = document.getElementById('oxy-edit-size');
    if (sizeEl) await _fillLookupSelect(sizeEl, 'tank_size', tank.tank_size);

    const errEl = document.getElementById('oxy-edit-error');
    if (errEl) { errEl.classList.add('d-none'); errEl.textContent = ''; }

    const modalEl = document.getElementById('oxy-edit-modal');
    if (!modalEl) return;
    bootstrap.Modal.getOrCreateInstance(modalEl).show();

    // Re-wire save button each open to avoid duplicate listeners.
    const saveBtn = document.getElementById('oxy-edit-save');
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener('click', () => _saveEditTank(tankId));
  }

  async function _saveEditTank(tankId) {
    const errEl = document.getElementById('oxy-edit-error');
    function _showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('d-none'); }
    }

    const size       = document.getElementById('oxy-edit-size')?.value;
    const psiRaw     = document.getElementById('oxy-edit-pressure')?.value;
    const inspection = document.getElementById('oxy-edit-inspection')?.value || null;
    const notes      = document.getElementById('oxy-edit-notes')?.value.trim() || null;

    if (!size) { _showErr('กรุณาเลือกขนาดถัง'); return; }
    const psi = psiRaw ? parseInt(psiRaw, 10) : null;
    if (psi !== null && (!Number.isFinite(psi) || psi <= 0)) {
      _showErr('ค่าแรงดันต้องเป็นตัวเลขมากกว่า 0'); return;
    }
    if (errEl) errEl.classList.add('d-none');

    const saveBtn = document.getElementById('oxy-edit-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'กำลังบันทึก…'; }

    try {
      await window.AppOxygen.updateTank({
        tankId,
        tankSize:          size,
        nextInspectionDue: inspection,
        lastPressurePsi:   psi,
        notes,
      });
      bootstrap.Modal.getOrCreateInstance(document.getElementById('oxy-edit-modal')).hide();
      _toast('success', 'บันทึกการแก้ไขแล้ว');
      if (_currentTankId === tankId) _renderDetailDrawer(tankId);
      _updateListRow(tankId);
    } catch (e) {
      _showErr(e.message || 'บันทึกไม่สำเร็จ');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'บันทึก'; }
    }
  }
```

- [ ] **Step 5: Manual verify the file**

Confirm `js/oxygen.js` still parses: `_openEditModal` and `_saveEditTank` are
inside the module IIFE, `oxy-edit-modal` appears in the `_renderShell` template,
and `_fillLookupSelect` / `_updateListRow` / `_renderDetailDrawer` /
`_currentTankId` (all referenced by the new code) are existing identifiers in
the same file.

---

### Task 7: `sw.js` — bump cache version

**Files:**
- Modify: `sw.js` (line 3, `CACHE_VERSION`)

- [ ] **Step 1: Bump the version**

Replace the `CACHE_VERSION` line. The current value is
`'thegood-stock-v0.18.8'`. Change it to:

```js
const CACHE_VERSION = 'thegood-stock-v0.19.0';  // Oxygen inspection tracking — Admin edit-tank modal (rpc_update_oxygen_tank), clearer inspection-date labels + PSI field, overdue badge, daily Telegram alert cron for tanks due for hydrostatic test.
```

- [ ] **Step 2: Commit Track B**

```bash
git add shared/oxygen.js js/oxygen.js sw.js
git commit -m "feat(oxygen): edit-tank modal + inspection-date clarity + overdue badge"
```

---

## Track C — Deploy & Verify (after Tracks A and B both complete)

### Task 8: Apply migrations to Supabase

**Prerequisite:** Tasks 1–2 committed.

- [ ] **Step 1: Apply both migrations via the Supabase Dashboard SQL Editor**

Open `https://supabase.com/dashboard/project/xtjsjrfixngfdkaahton/sql/new`.
Run the full contents of `20260521010000_rpc_update_oxygen_tank.sql`, then the
full contents of `20260521010100_oxygen_inspection_cron.sql`. Each must succeed
with no error.

- [ ] **Step 2: Run the verification queries**

Run the `Verification SQL` block from each migration's trailing comments.
Expected results:
- `rpc_update_oxygen_tank` exists, `prosecdef = true`.
- `oxygen_tanks_update_trigger_only` policy `using_expr` is still `'false'`.
- `OXYGEN_INSPECTION_ALERT_DAYS` setting = `'30'`.
- `check_oxygen_inspection_due` exists, `prosecdef = true`.
- `cron.job` has `oxygen_inspection_alert` at schedule `'0 2 * * *'`.
- `SELECT check_oxygen_inspection_due();` runs without error.

- [ ] **Step 3: Verify the alert dedupe end-to-end (assumption check)**

The spec assumes `tg-notify` writes a `notification_log` row keyed by
`dedupe_key`. Confirm it: pick any tank, set its `next_inspection_due` to today
via `SELECT rpc_update_oxygen_tank(...)`, run `SELECT
check_oxygen_inspection_due();`, then:
`SELECT dedupe_key, success FROM notification_log WHERE dedupe_key LIKE
'oxygen_inspection_due:%' ORDER BY created_at DESC LIMIT 5;`
Expected: a row appears. If NO row appears, the cron function must be amended to
insert the `notification_log` row itself — report this back rather than
proceeding.

---

### Task 9: Deploy & live smoke test

**Prerequisite:** Tasks 1–8 done; Tracks A & B committed.

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

(Requires the `officethegood` GitHub account for write access — switch the
active `gh` account up for the push, then switch back to `supwilaimedical`.)

- [ ] **Step 2: Live smoke test**

On `https://officethegood.github.io/thegood-stock/`, log in as Admin → คลัง →
ถังออกซิเจน. Confirm:
1. Add-tank modal shows the PSI field and the relabelled inspection field with
   helper text.
2. Open any tank's detail drawer → "แก้ไขข้อมูลถัง" button appears → opens the
   edit modal pre-filled → changing the inspection date and saving succeeds and
   the list row + drawer refresh.
3. A tank with a past inspection date shows the "เกินกำหนด" badge.
4. The edit modal renders in front of the backdrop (not trapped behind it).

---

## Self-Review

**Spec coverage:**
- Goal "Admin can edit tank fields" → Tasks 1, 3, 6. ✓
- Goal "inspection field self-explanatory" → Task 5 (add modal), Task 6 (edit modal). ✓
- Goal "daily alert, one per tank" → Task 2. ✓
- Goal "overdue tanks visually flagged" → Task 4. ✓
- Decision D-1 (SECURITY DEFINER RPC, RLS unchanged) → Task 1 + Task 8 Step 2 verifies RLS unchanged. ✓
- Decision D-3 (one alert per tank, dedupe includes due-date) → Task 2 dedupe key. ✓
- Decision D-4 (configurable window) → Task 2 setting seed. ✓
- Non-goal "no Dashboard widget / no auto-calc / no history table" → not present in any task. ✓
- Spec §7 error handling → Task 3 Step 2 error mappings. ✓
- Spec §8 testing → Task 8 Step 3 + Task 9 Step 2. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code. ✓

**Type/name consistency:** `updateTank` signature in Task 3 (`tankId, tankSize,
nextInspectionDue, lastPressurePsi, notes`) matches the call in Task 6
`_saveEditTank`. RPC param names (`p_tank_id`, `p_tank_size`,
`p_next_inspection_due`, `p_last_pressure_psi`, `p_notes`) match between Task 1
and the Task 3 `sb.rpc(...)` call. Element ids (`oxy-edit-*`) consistent between
Task 6 Step 1 HTML and Step 4 JS. ✓
