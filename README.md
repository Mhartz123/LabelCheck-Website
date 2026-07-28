# LabelCheck Dashboard — Vercel + Supabase

## Two report types

The app runs two **independent** inspections and submits a different payload
for each. Every row carries `scanType`, and the dashboard reads that first —
a row shows one half of the schema or the other, never both.

| | `LABEL` | `DAMAGE` |
|---|---|---|
| Produced by | Label Check (3 label close-ups → OCR → FDA advisories) | Physical Damage Check (4 box sides → YOLO11n) |
| Stored | `detected_product_name`, `expiration`, `all_labels_present`, `ingredients`, `extracted_text` | `is_damaged`, `damage_types`, `affected_sides`, `damage_spots`, `max_confidence`, `findings` |
| Outcome | `COMPLIANT` / `NON-COMPLIANT` / `WARNING / BANNED` | damaged or not |
| Stored when | status is non-compliant or banned | damage was actually found |

`product_name` is shared: it's the name the user saved the record under, not
anything read off a label. For label checks the OCR'd name is
`detected_product_name`.

**The damage model is single-class.** It reports *that* packaging is damaged,
which sides, how many spots, and with what confidence — but not what kind of
damage. `damage_types` will read `Damage` for every row until the model is
retrained with per-type classes; nothing on the website needs to change when
it is, since the class name flows straight through.

### Deploying the schema

Run `supabase-schema.sql` in the Supabase SQL Editor.

⚠ It **drops and recreates** the `reports` table — running it wipes the
dashboard. That's deliberate: the label/damage split changed the shape of a
report enough that a clean table beats migrating. Run it once, before
deploying the API, and don't re-run it against a project holding data you
want.

The dashboard still tolerates rows with no `scan_type` (it treats them as
label checks) and with `all_labels_present = null` (shown as "Not recorded",
not "No"), so restoring an older backup won't break the UI.

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
   (creates the `reports` table and both report types' columns). Safe to
   re-run on an existing project — see "Upgrading an existing deployment".
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
