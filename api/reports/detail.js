const { getClient } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');

/**
 * `GET /api/reports/detail?id=<report_id>` — the heavy parts of one report,
 * fetched only when its detail view opens:
 *
 *   extractedText   the full OCR dump (label/both)
 *   timings         the scan's ML stages [{group, label, totalMs, runs}]
 *   damageTimings   the damage model's own stages, same shape
 *   images          the packaging photos, in the order the detector saw them
 *
 * None of this is in /api/reports, which the dashboard polls — four
 * packaging photos and a page of OCR text per report, times every report,
 * on every poll, was most of the project's egress. One request per opened
 * report costs a fraction of that.
 *
 * `ordinal` is a photo's position in the detector's input, which is what a
 * detection's `sourceIndex` points at; `slot` is the capture slot's name
 * ('front', 'side1', …) and can be null. A scan that skipped a slot still has
 * consecutive ordinals, so the two are not interchangeable.
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
    const [parent, label, damage, photos] = await Promise.all([
      supabase.from('reports').select('timings').eq('id', id).maybeSingle(),
      supabase.from('report_label_checks').select('extracted_text').eq('report_id', id).maybeSingle(),
      supabase.from('report_damage_checks').select('timings').eq('report_id', id).maybeSingle(),
      supabase.from('report_damage_images')
        .select('ordinal, slot, image_base64')
        .eq('report_id', id)
        .order('ordinal', { ascending: true }),
    ]);
    for (const r of [parent, label, damage, photos]) if (r.error) throw r.error;

    // An unknown id and a report with nothing stored both come back empty.
    // Saying which would let the endpoint be used to probe for report ids.
    return res.status(200).json({
      ok: true,
      id,
      extractedText: (label.data && label.data.extracted_text) || '',
      timings:       (parent.data && parent.data.timings) || null,
      damageTimings: (damage.data && damage.data.timings) || null,
      images: (photos.data || []).map((row) => ({
        ordinal:     row.ordinal,
        slot:        row.slot,
        imageBase64: row.image_base64,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
});
