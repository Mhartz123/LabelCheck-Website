# CheckMuna Dashboard — Vercel + Supabase

Monitoring dashboard for the CheckMuna Android app. Every scan the app saves
(label check, damage check, or both) is posted to `POST /api/report` and
shown here to signed-in reviewers.

## Three scan flows, five tables

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
report_damage_images       0..N   per damage check  (one row per packaging photo)
report_damage_detections   0..N   per damage check  (one row per detection)
```

Children declare `on delete cascade`, so deleting a report cleans up the rest.

`product_name` is on the parent and shared: it's the name the user saved the
record under, not anything read off a label. The OCR'd name is
`report_label_checks.detected_product_name`.

### Packaging types

Damage scans carry `packaging_type` — `box`, `foil` or `bottle`, picked by
the user before the camera opens. Each type has its own on-device YOLO
detector (box: YOLO11n, bottle: YOLOv8n, foil: YOLOv5nu).

`available = false` means the check could not run — model missing, failed
its load check, or inference failed on every photo. That
is **not** the same as `available = true, is_damaged = false` (a real clean
result). Keep them apart or "no damage found" counts get inflated by scans
that never ran. The dashboard renders them as "Check unavailable" vs "No
damage detected".

### Detections

Detector classes are `Structural deformation` (box, foil) and
`Label aberration` (box, bottle); early box records say `Dent`/`Scratches`.
Each surviving detection is one row in `report_damage_detections`, and the
API returns both the ordered list and a per-class count
(`{"Structural deformation": 2, "Label aberration": 1}`).

Damage is filtered twice. Each detector keeps boxes at 0.25–0.35 confidence
and those are drawn, but the app only fails the scan when the top confidence
reaches **0.70**. So a record can carry detections and still be `COMPLIANT`.
The dashboard shows the app's verdict as the badge, counts "failed on
packaging damage" at ≥ 0.70, and marks weaker detections as below the fail
threshold.

A detection row also carries **where** it was found: its own confidence, a
0..1 rect on the source photo, and `source_index` — which packaging photo it
came from. All of that is nullable, and null means the detector reported the
class without geometry. That is "no outline to draw", **not** "no damage";
the dashboard says so in as many words rather than leaving a damaged record
looking clean.

### Packaging photos

`report_damage_images` holds the four full-frame shots the detector actually
ran on, one row each, as base64 data URLs like `reports.image_base64`. They
are what the dashboard draws the detection rects back onto, so a "91% dent"
is something you can look at instead of take on faith.

`ordinal` is the photo's position in the list the app fed the detector
(`BoxSlot` order, skipped slots omitted) and is what `source_index` points
at. `slot` names it separately — `front`, `side1`, `side2`, `back` — because
a scan that skipped a slot still has consecutive ordinals, so the two are not
interchangeable. A photo the phone couldn't encode is dropped but **keeps its
ordinal**, leaving a gap rather than sliding every later photo out from under
the detections that reference it.

These are the heaviest rows in the database and the least often read, so
`GET /api/reports` deliberately does not carry them — it returns only each
photo's ordinal and slot. The bytes come from `GET /api/reports/images` when
a detail view opens. Without that split the 30-second dashboard poll would
re-download every packaging photo ever uploaded.

Records saved before the app uploaded photos simply have none, and the
dashboard hides the section rather than showing an empty gallery.

### Verdicts

The app decides the verdict; the dashboard never re-decides it.

| Status | Meaning |
|---|---|
| `COMPLIANT` | every check that ran passed |
| `NON-COMPLIANT` | expired, no/unreadable expiry, no ingredient list, or packaging damage ≥ 0.70 |
| `WARNING` | the product name matched an FDA Philippines advisory entry — flagged for manual verification |

`WARNING` used to be `WARNING / BANNED`. `lib/status.js` folds the old
spelling (and anything unrecognised, as `NON-COMPLIANT`) on ingest and on
read, so old rows and older app builds display correctly without a
migration. `supabase-warning-rename-migration.sql` rewrites the stored rows
and adds a check constraint; it is safe to re-run.

### What the dashboard shows

- **Home** — verdict totals, label pass rate and packaging undamaged rate
  (unavailable checks excluded), damage checks by packaging type, the most
  common flag triggers, and the decision rules.
- **Reports** — filter by mode, packaging and verdict (plus "Damage found"
  for any detection), search, sort, delete, CSV export, and a printable
  **Summary report** (save as PDF from the print dialog) that mirrors the
  app's Product Compliance Summary Report.
- **Detail** — verdict, reasons, advisory note with the FDA hotline for a
  Warning, label fields and OCR text, damage findings, and the packaging
  photos with detection boxes redrawn.

### Deploying the schema

Run `supabase-schema.sql` in the Supabase SQL Editor.

⚠ It **drops and recreates all five tables** — running it wipes the
dashboard. Run it once, before deploying the API, and don't re-run it
against a project holding data you want.

**Already have a database from an earlier version?** Run
`supabase-damage-images-migration.sql` instead. It adds
`report_damage_images` and the geometry columns on
`report_damage_detections`, is all `if not exists`, and drops nothing — safe
on a project holding data, and safe to re-run. Existing rows come out with
null geometry, which reads as "no outline available" and displays correctly.
Also run `supabase-warning-rename-migration.sql` to rewrite old
`WARNING / BANNED` rows as `WARNING` and add the status check constraint.

### What the app sends

`ReportService` posts every saved scan, including compliant and no-damage
ones — the dashboard needs clean results to show a ratio against.

```jsonc
{
  "id": "<epoch_ms>_<name hash>",
  "kind": "label" | "damage" | "both",
  "packagingType": "box" | "foil" | "bottle" | null,
  "productName": "<record name>",
  "status": "COMPLIANT" | "NON-COMPLIANT" | "WARNING",
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
    "detections": ["Structural deformation", "Label aberration"],
    "maxConfidence": 0.82,

    // Same findings as `detections`, plus geometry. left/top/width/height
    // are 0..1 fractions of the photo named by sourceIndex, with EXIF
    // orientation already applied.
    "boxes": [
      { "label": "Structural deformation", "confidence": 0.82,
        "left": 0.11, "top": 0.24, "width": 0.30, "height": 0.19,
        "sourceIndex": 0 }
    ],

    // The photos those boxes sit on, in the order the detector saw them.
    // An entry with no imageBase64 is a photo that couldn't be encoded —
    // it holds its place so sourceIndex keeps pointing at the right shot.
    "images": [
      { "slot": "front", "imageBase64": "data:image/jpeg;base64,..." },
      { "slot": "side1", "imageBase64": "data:image/jpeg;base64,..." }
    ]
  }
}
```

The app downscales every uploaded photo to ~200 KB (longest edge 900px,
dropping quality if that isn't enough) rather than skipping one that's too
big, which is why damage records have previews at all — a full-frame
packaging shot is several megabytes straight off the camera. The originals
stay on the phone.

## Signing in

The dashboard is behind a login; the app's upload endpoint is not.

| Route | Who calls it | Auth |
|---|---|---|
| `POST /api/report` | the Flutter app | open — the phone has no account to sign in with |
| `GET /api/reports` | the dashboard | session cookie required |
| `GET /api/reports/images` | the dashboard | session cookie required |
| `POST /api/reports/delete` | the dashboard | session cookie required |
| `POST /api/auth/login` · `logout` · `GET /api/auth/me` | the login screen | — |

Opening `/` with no valid session bounces to `/login.html?next=…`; signing
in returns you to where you were headed. The 30-second report poll notices
a session that ends mid-visit (expiry, sign-out elsewhere, account
switched off) and bounces the same way.

### Two tables

```
dashboard_users      one row per person who can open the dashboard
dashboard_sessions   one row per active browser sign-in
```

Passwords are never stored — `password_hash` holds a scrypt digest
(`scrypt$<salt>$<hash>`, verified in constant time). Sessions work the same
way round: the browser holds a random token in an `HttpOnly; Secure;
SameSite=Lax` cookie and only its SHA-256 is in the table, so the table
can't be replayed as a login and "sign out" is a real server-side delete
rather than just dropping the cookie.

Five failed attempts freeze an account for 15 minutes. That counter lives
on the row rather than in memory because serverless functions don't share
memory between invocations. Unknown username, wrong password and
deactivated account all answer with the same message, so the login can't
be used to find out which usernames exist.

"Keep me signed in" means a 7-day session; unticked it's 12 hours and the
cookie is dropped when the browser closes.

### Setting it up

1. Run `supabase-auth-schema.sql` in the Supabase SQL Editor. Unlike
   `supabase-schema.sql` it's all `if not exists`, so re-running it won't
   wipe accounts.
2. Make the first account — on your own machine, so the plaintext password
   never reaches Supabase or its query logs:

   ```
   node scripts/create-user.js admin "your-password" "Maria Santos" admin
   ```

   No Node installed? `scripts/create_user.py` is the same tool and prints
   the same SQL — Python's `hashlib.scrypt` at n=16384, r=8, p=1 is
   byte-identical to Node's `scryptSync` defaults:

   ```
   python scripts/create_user.py admin "your-password" "Maria Santos" admin
   ```

   Either one prints an `insert … on conflict do update` statement; paste it
   into the SQL Editor. Run it again for any further accounts — and running
   it for an existing username resets that account's password and clears any
   lockout.

There is deliberately no sign-up endpoint — accounts are created by hand,
so nothing on the public internet can mint a login for the dashboard.

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
- `api/reports/images.js` — `GET /api/reports/images?id=…`, the packaging
  photos for one report, fetched only when a detail view opens
- `api/reports/delete.js` — `POST /api/reports/delete`
- `login.html` — the sign-in screen
- `api/auth/login.js`, `api/auth/logout.js`, `api/auth/me.js` — the login API
- `lib/supabase.js` — shared Supabase client
- `lib/status.js` — normalises the verdict string (Banned → Warning)
- `lib/auth.js` — password hashing, session cookies, the `requireAuth` wrapper
- `scripts/create-user.js` · `scripts/create_user.py` — print the SQL for a
  new account (same output; use whichever runtime you have)

Each file under `api/` becomes its own serverless function automatically —
no extra Vercel config needed.

## 1. Set up Supabase first

Yes — set up Supabase **before** deploying to Vercel, otherwise the API
routes will error out (they need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` to exist).

1. Create a free project at supabase.com.
2. Open the SQL Editor and run the contents of `supabase-schema.sql`
   (creates all five report tables). This DROPS existing data — see
   "Deploying the schema" above, which also covers upgrading a database
   that already has reports in it. Then run `supabase-auth-schema.sql`
   (the two login tables) and create your first account — see
   "Signing in" above.
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
