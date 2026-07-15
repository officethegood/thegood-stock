# BUG-0.7-T185-01 — No ambulance_id selector when creating type=ambulance location

**Date:** 2026-05-19
**Severity:** High
**Blocking:** T185 (partial fail) — ambulance locations cannot be created via UI
**Found by:** QA (Run 2 live functional test @ aefa347)
**Owner:** FE agent
**Status:** Fixed — verified in code 2026-07-15: `js/locations.js` renders an ambulance selector when type=ambulance, requires it before save, and writes `ambulance_id` in the payload (comment cites BUG-T185-01)

---

## Title

Location create/edit form has no `ambulance_id` field when `type=ambulance` is selected — DB constraint `chk_ambulance_link` blocks insert with no user-friendly path forward

---

## Steps to Reproduce

1. Admin → admin.html → Locations tab → "+ เพิ่มใหม่"
2. Set Type = "รถพยาบาล (ambulance)"
3. Fill code (e.g. `LOC-AMB-TG1`) and name
4. Click "บันทึก"

---

## Expected

When type=ambulance is selected, an "ambulance" dropdown/selector appears, populated from the `ambulances` table (TG1, TG2, TG4, TG6). The selected ambulance's ID is sent as `ambulance_id` in the INSERT.

Or alternatively: the Ambulances tab's "+ เพิ่มตำแหน่ง" button pre-fills `ambulance_id` from the current ambulance context.

---

## Actual

No `ambulance_id` field is present in the form. The INSERT fires without `ambulance_id`, triggering DB constraint:

```
new row for relation "locations" violates check constraint "chk_ambulance_link"
```

Toast shows the raw constraint name — no Thai user-friendly message.

---

## Environment

- Browser: Chrome desktop (Thegood browser)
- OS: Windows 11 Pro 10.0.26200
- Viewport: 1278×1270
- Commit: aefa347
- Supabase project: xtjsjrfixngfdkaahton

---

## DB Constraint

`supabase/migrations/` — `chk_ambulance_link` CHECK constraint on `locations` table:

```sql
CONSTRAINT chk_ambulance_link CHECK (
  (type <> 'ambulance') OR (ambulance_id IS NOT NULL)
)
```

The constraint is correct and working. The UI is missing the corresponding input.

---

## Fix Options

**Option A (recommended):** In `js/locations.js` location create/edit modal, when `type=ambulance` is selected:
- Show an `<select id="location-ambulance-id">` populated by `SELECT id,code,name FROM ambulances WHERE active=true`
- Set it required when type=ambulance
- Include selected value as `ambulance_id` in the INSERT/UPDATE payload

**Option B:** From the Ambulances tab, clicking "+ เพิ่มตำแหน่ง" for a specific ambulance row pre-fills `ambulance_id` and forces `type=ambulance` in the create modal.

---

## Regression Risk

Medium — requires changes to the location create modal in `js/locations.js`. Re-run T14 (type=ambulance without ambulance_id → block confirmed) and T185 (ambulance → storage → shelf hierarchy).
