const { getClient } = require('../lib/supabase');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Records per database call. Each one is a single round trip that resolves
// the whole batch, so this only bounds the size of one request body.
const BATCH = 500;
// A phone holds a few thousand records at most; anything far past that is
// not the app.
const MAX_RECORDS = 20000;

/**
 * `POST /api/sync-check` — which of the phone's records does the server
 * already hold?
 *
 * Body:     {"records": [{"id", "recordName", "scannedAt"}, …]}
 * Response: {"existing": ["<id>", …]}
 *
 * The app's "Sync to dashboard" asks this first, then uploads the missing
 * records in full and re-sends the rest without photos. It sends nothing at
 * all unless this answers 200 with an `existing` array — so this endpoint
 * must be live before anyone presses Sync.
 *
 * Matching is the same as POST /api/report's: by record_uid, else a legacy
 * row (random id, record_uid NULL) with the same scan time and sanitised
 * name. A legacy match is claimed here — its record_uid is set — so the
 * upload that follows is a plain unique-key hit. That is done inside
 * checkmuna_sync_check, which returns only the matching ids: the response
 * from the database is a list of strings, not rows.
 *
 * Open like /api/report — the phone has no account. It only answers for ids
 * the caller already knows, and returns nothing else about them.
 */
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.records)) {
    return res.status(400).json({ ok: false, reason: 'expected {"records": [...]}' });
  }
  if (body.records.length > MAX_RECORDS) {
    return res.status(413).json({ ok: false, reason: 'too many records' });
  }

  // Renamed to what the SQL function reads, deduplicated by id.
  const byUid = new Map();
  for (const r of body.records) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue;
    byUid.set(r.id, {
      uid:     r.id,
      name:    typeof r.recordName === 'string' ? r.recordName : null,
      scanned: typeof r.scannedAt  === 'string' ? r.scannedAt  : null,
    });
  }
  const records = [...byUid.values()];

  try {
    const supabase = getClient();
    const existing = [];
    for (let i = 0; i < records.length; i += BATCH) {
      const { data, error } = await supabase.rpc('checkmuna_sync_check', {
        p_records: records.slice(i, i + BATCH),
      });
      if (error) throw error;
      if (Array.isArray(data)) existing.push(...data);
    }

    console.log(`[?] sync-check: ${existing.length} of ${records.length} already stored`);
    return res.status(200).json({ ok: true, existing });
  } catch (err) {
    console.error(err);
    // Anything but 200 makes the app send nothing, which is the safe
    // outcome when the server can't say what it already has.
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
