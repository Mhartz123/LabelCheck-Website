# CheckMuna Dashboard — Vercel + Supabase

## Three scan flows, four tables

The app has three entry points and every record says which one produced it
via `kind`:

| `kind` | Flow | Halves stored |
|---|---|---|
| `label` | Check Labels — 3 close-ups → OCR → FDA advisories | label only |
| `damage` | Damage Detection — 4 packaging photos → detector | damage only |
| `both` | Inspection Mode — label check *then* packaging photos, saved as **one** record | both |

That last one is why the schema is split across tables rather than one wide
row: an inspection genuinely has both halves, so a flat row would need every
column of both and no way to say which half actually ran. Here a half exists
iff its row exists.

```
reports                    1 row  per scan          (always)
report_label_checks        0..1   per scan          (kind label/both)
report_damage_checks       0..1   per scan          (kind damage/both)
report_damage_detections   0..N   per damage check  (one row per detection)
```

Children declare `on delete cascade`, so deleting a report cleans up the rest.

`product_name` is on the parent and shared: it's the name the user saved the
record under, not anything read off a label. The OCR'd name is
`report_label_checks.detected_product_name`.

### Packaging types

Damage scans carry `packaging_type` — `box`, `foil` or `bottle`, picked by
the user before the camera opens. Only **box** has a trained detector today;
foil and bottle are captured and stored but report `available = false`.

That flag matters: `available = false` means the check could not run, which
is **not** the same as `available = true, is_damaged = false` (a real clean
result). Keep them apart or "no damage found" counts get inflated by scans
that never ran. The dashboard renders them as "Check unavailable" vs "No
damage detected".

### Detections

The box detector is two-class — `Dent` and `Scratches`. Each surviving
detection is one row in `report_damage_detections`, so two dents and one
scratch is three rows, and the API returns both the ordered list and a
per-class count (`{Dent: 2, Scratches: 1}`).

### Deploying the schema

Run `supabase-schema.sql` in the Supabase SQL Editor.

⚠ It **drops and recreates all four tables** — running it wipes the
dashboard. Run it once, before deploying the API, and don't re-run it
against a project holding data you want.

### What the app sends

`ReportService` posts every saved scan, including compliant and no-damage
ones — the dashboard needs clean results to show a ratio against.

```jsonc
{
  "id": "<epoch_ms>_<name hash>",
  "kind": "label" | "damage" | "both",
  "packagingType": "box" | "foil" | "bottle" | null,
  "productName": "<record name>",
  "status": "COMPLIANT" | "NON-COMPLIANT" | "WARNING / BANNED",
  "matchedKeyword": "...",
  "reasons": ["..."],
  "scannedAt": "<iso8601>",
  "imageBase64": "data:image/jpeg;base64,...",   // optional, ≤200 KB

  "label": {                    // omitted when kind = "damage"
    "detectedProductName": "...",
    "expiration": "...",
    "ingredients": "...",
    "extractedText": "..."
  },

  "damage": {                   // omitted when kind = "label"
    "available": true,
    "message": "...",
    "isDamaged": true,
    "detections": ["Dent", "Dent", "Scratches"],
    "maxConfidence": 0.82
  }
}
```

## What changed from the original

The original `labelcheck_server.js` was a single long-running Node process
that wrote reports to a local `reports.json` file and listened on a fixed
port. That doesn't work on Vercel: serverless functions don't stay running
and their filesystem is thrown away after every request, so any data
written to a local file disappears almost immediately (and isn't shared
between function instances anyway).

This version splits things up:

- `index.html` — the dashboard, now calls `/api/...` on its own origin
  instead of a hardcoded `http://localhost:8080`.
- `api/report.js` — `POST /api/report` (used by the Flutter app)
- `api/reports.js` — `GET /api/reports` (used by the dashboard)
- `api/reports/delete.js` — `POST /api/reports/delete`
- `lib/supabase.js` — shared Supabase client
- `legacy-local-server.js` — your old server, kept for reference only,
  not used in deployment.

Each file under `api/` becomes its own serverless function automatically —
no extra Vercel config needed.

## 1. Set up Supabase first

Yes — set up Supabase **before** deploying to Vercel, otherwise the API
routes will error out (they need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` to exist).

1. Create a free project at supabase.com.
2. Open the SQL Editor and run the contents of `supabase-schema.sql`
   (creates all four tables). This DROPS existing data — see
   "Deploying the schema" above.
3. Go to Project Settings → API and copy:
   - Project URL → `SUPABASE_URL`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY`
     (server-side only — never put this in the HTML/dashboard, only in
     Vercel's environment variables).

## 2. Deploy to Vercel

1. Push this folder to a GitHub repo (or run `vercel` from inside it with
   the Vercel CLI).
2. Import the repo in Vercel.
3. In Project Settings → Environment Variables, add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Deploy. Vercel will run `npm install` automatically (installs
   `@supabase/supabase-js`).

Your dashboard will be live at `https://your-project.vercel.app/`, reports
API at `https://your-project.vercel.app/api/report`.

## 3. Point the Flutter app at the new URL

In the Flutter app's `ReportService`, change the endpoint from
`http://<LAN_IP>:8080/api/report` to your Vercel URL, e.g.:

```
https://your-project.vercel.app/api/report
```

## Local testing

```
npm install
vercel dev
```

This runs the same serverless functions locally on `http://localhost:3000`,
reading/writing to the same Supabase project — so local and production
behave identically (no more hardcoded ports).
