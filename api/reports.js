const { getClient } = require('../lib/supabase');
const { requireAuth } = require('../lib/auth');
const { normalizeStatus } = require('../lib/status');

// PostgREST embedded selects — one round trip pulls each report with its
// label half, damage half, and detection rows. Relies on the foreign keys
// declared in supabase-schema.sql.
const SELECT = `
  id, kind, packaging_type, status, product_name, matched_keyword,
  reasons, scanned_at, image_base64, created_at,
  report_label_checks (
    detected_product_name, expiration, ingredients, extracted_text
  ),
  report_damage_checks (
    packaging_type, available, is_damaged, message, max_confidence
  ),
  report_damage_detections (
    detection_class, ordinal, confidence, source_index,
    box_left, box_top, box_width, box_height
  ),
  report_damage_images (
    ordinal, slot
  )
`;

// Deliberately no image_base64 in the embed above: four packaging photos per
// damage report, times every report ever saved, is a response the dashboard
// would spend seconds downloading to show a list that displays one thumbnail
// per row. The photos are fetched one report at a time from
// /api/reports/images when a detail view actually opens; what comes back here
// is just enough to caption and count them.

/** PostgREST returns a to-one embed as an object or a 1-element array. */
function one(v) {
  if (Array.isArray(v)) return v[0] || null;
  return v || null;
}

/**
 * Returns every stored report, newest first, each flattened into a single
 * camelCased object with `label` and `damage` sub-objects — null when that
 * half wasn't run. The dashboard reads `kind` and renders the halves that
 * are present, so an inspection record shows both.
 *
 * The damage half names its packaging photos but does not carry them; the
 * bytes come from /api/reports/images per report.
 */
module.exports = requireAuth(async (req, res) => {
  // No CORS headers: unlike /api/report (which the phone posts to from
  // another origin) this is read by the dashboard on its own origin, and
  // the session cookie wouldn't be sent cross-site anyway.
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('reports')
      .select(SELECT)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const reports = data.map((row) => {
      const label  = one(row.report_label_checks);
      const damage = one(row.report_damage_checks);

      const detectionRows = (row.report_damage_detections || [])
        .slice()
        .sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));

      const detections = detectionRows.map((d) => d.detection_class);

      // Only the detections the detector gave geometry for — a zero-area rect
      // is nothing to draw, so it counts as no geometry. Kept as its own
      // list rather than nulls inside `detections` so the dashboard can ask
      // "is there an overlay to draw?" without walking every row — and so an
      // empty `boxes` on a damaged record reads as "no overlay available",
      // never as "no damage".
      const boxes = detectionRows
        .filter((d) => d.box_width > 0 && d.box_height > 0)
        .map((d) => ({
          label:       d.detection_class,
          confidence:  d.confidence,
          sourceIndex: d.source_index,
          left:        d.box_left,
          top:         d.box_top,
          width:       d.box_width,
          height:      d.box_height,
        }));

      // Which packaging photos exist, without their bytes — see the note on
      // SELECT above. `ordinal` is what a box's sourceIndex points at.
      const photos = (row.report_damage_images || [])
        .slice()
        .sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0))
        .map((img) => ({ ordinal: img.ordinal, slot: img.slot }));

      // Occurrences per class, e.g. { "Structural deformation": 2 } — lets the
      // dashboard say "2 × Structural deformation" rather than just naming the classes.
      const detectionCounts = detections.reduce((acc, c) => {
        acc[c] = (acc[c] || 0) + 1;
        return acc;
      }, {});

      return {
        id:             row.id,
        // Rows predating the split carry no kind; they held both halves.
        kind:           row.kind || 'both',
        packagingType:  row.packaging_type,
        // Rows saved before the Banned → Warning rename still say
        // 'WARNING / BANNED'; the dashboard only has to know one spelling.
        status:         normalizeStatus(row.status),
        productName:    row.product_name,
        matchedKeyword: row.matched_keyword,
        reasons:        row.reasons || [],
        scannedAt:      row.scanned_at,
        imageBase64:    row.image_base64,

        label: label ? {
          detectedProductName: label.detected_product_name,
          expiration:          label.expiration,
          ingredients:         label.ingredients,
          extractedText:       label.extracted_text,
        } : null,

        damage: damage ? {
          packagingType: damage.packaging_type,
          available:     damage.available,
          isDamaged:     damage.is_damaged,
          message:       damage.message,
          maxConfidence: damage.max_confidence,
          detections,
          detectionCounts,
          boxes,
          photos,
        } : null,
      };
    });

    return res.status(200).json({ ok: true, reports });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
});
