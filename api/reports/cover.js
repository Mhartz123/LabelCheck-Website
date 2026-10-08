const { getClient } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');

// Once stored, a cover photo never changes — an upload only ever fills an
// empty one — so the browser may keep it. `private` keeps it out of shared
// caches, since it sits behind the login.
const CACHE = 'private, max-age=604800';

/**
 * `GET /api/reports/cover?id=<report_id>` — one report's cover photo as an
 * image, for the list thumbnail and the detail view.
 *
 * It used to ride inside every row of /api/reports, so each 30-second poll
 * re-downloaded every cover photo ever uploaded. Served on its own, as a
 * real image with a cache lifetime, each one leaves Supabase about once per
 * browser per week.
 */
module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  const id = req.query && req.query.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ ok: false, reason: 'missing report id' });
  }

  try {
    const { data, error } = await getClient()
      .from('reports')
      .select('image_base64')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;

    // 'data:image/jpeg;base64,<bytes>'
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is
      .exec((data && data.image_base64) || '');
    if (!m) return res.status(404).json({ ok: false, reason: 'no image' });

    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', CACHE);
    return res.status(200).send(Buffer.from(m[2], 'base64'));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
});
