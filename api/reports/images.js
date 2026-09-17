const { getClient } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');

/**
 * `GET /api/reports/images?id=<report_id>` — the packaging photos for one
 * report, in the order the damage detector was fed them.
 *
 * These live behind their own endpoint rather than inside /api/reports
 * because they are the heaviest thing in the database and the least often
 * looked at: a damage scan carries four full-frame shots, and the reports
 * list shows none of them. Fetching them per report means opening a detail
 * view costs one small request instead of every list refresh — including the
 * 30-second poll — carrying every photo ever uploaded.
 *
 * `ordinal` is the photo's position in that list, which is what a detection's
 * `sourceIndex` points at, so the dashboard can hang each box on the right
 * photo. `slot` is the capture slot's own name ('front', 'side1', …) and can
 * be null: a scan that skipped a slot still has consecutive ordinals, so the
 * two are not interchangeable.
 */
module.exports = requireAuth(async (req, res) => {
  // Dashboard-only, same origin — see the note in api/reports.js.
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  const id = req.query && req.query.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ ok: false, reason: 'missing report id' });
  }

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('report_damage_images')
      .select('ordinal, slot, image_base64')
      .eq('report_id', id)
      .order('ordinal', { ascending: true });

    if (error) throw error;

    // An unknown id and a report with no stored photos both come back as an
    // empty list. That's the same thing to the caller: there is nothing to
    // show either way, and saying which would let the endpoint be used to
    // probe for report ids.
    const images = (data || []).map((row) => ({
      ordinal:     row.ordinal,
      slot:        row.slot,
      imageBase64: row.image_base64,
    }));

    return res.status(200).json({ ok: true, id, images });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
});
