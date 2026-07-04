# LabelCheck Dashboard — Vercel + Supabase

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
   (creates a `reports` table).
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
