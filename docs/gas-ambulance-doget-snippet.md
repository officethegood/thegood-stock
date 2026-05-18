# Ambulance GAS — Add JSON list endpoint

The Stock app's `sync-ambulances` Edge Function expects the Ambulance GAS web app at

```
https://script.google.com/macros/s/AKfycbwefEV0CebLwA-BUKfg1hwwMcpu_0AS33YIFV3P3qU6AZilKZy9FbHZs51xu5vu1mFH/exec
```

to respond to `GET ?action=listAmbulances` with a JSON array of ambulance rows.

## Snippet to add

Open the Ambulance GAS project, add or extend `doGet(e)` in `Code.gs`:

```javascript
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'listAmbulances') {
    // Replace with the actual spreadsheet id and sheet name used by the Ambulance system
    const SHEET_ID   = 'PASTE_AMBULANCE_SPREADSHEET_ID_HERE';
    const SHEET_NAME = 'PASTE_AMBULANCE_SHEET_NAME_HERE';

    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const rows  = sheet.getDataRange().getValues();
    const headers = rows[0];
    const data = rows.slice(1).map(function(r) {
      const obj = {};
      headers.forEach(function(h, i) { obj[h] = r[i]; });
      return obj;
    });

    return ContentService
             .createTextOutput(JSON.stringify(data))
             .setMimeType(ContentService.MimeType.JSON);
  }

  // Fallback to existing dashboard HTML output
  return HtmlService.createHtmlOutputFromFile('Index');
}
```

## Required fields in each row

The Stock `sync-ambulances` function looks for these keys (case-sensitive — match your headers):

- `id` or `ambulance_id` or `gas_id` — unique per ambulance
- `plate` or `license` or `tabian` — ทะเบียนรถ
- `callsign` or `call_sign` — optional

Other fields are stored verbatim in `ambulances.raw` jsonb.

## Deploy

After saving, **Manage Deployments → Edit → New version → Deploy**. The URL must stay the same (`/exec`).

## Verify

```bash
curl -L 'https://script.google.com/macros/s/AKfycbwefEV0CebLwA-BUKfg1hwwMcpu_0AS33YIFV3P3qU6AZilKZy9FbHZs51xu5vu1mFH/exec?action=listAmbulances'
```

Expected: `[{...}, {...}]` — JSON array, not HTML.

Once verified, paste the same URL into Stock's Settings → AMBULANCE_GAS_URL.
