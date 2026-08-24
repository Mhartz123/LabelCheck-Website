const { getClient } = require('../lib/supabase');

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
    detection_class, ordinal
  )
`;

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
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

      const detections = (row.report_damage_detections || [])
        .slice()
        .sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0))
        .map((d) => d.detection_class);

      // Occurrences per class, e.g. { Dent: 2, Scratches: 1 } — lets the
      // dashboard say "2 dents" rather than just naming the classes.
      const detectionCounts = detections.reduce((acc, c) => {
        acc[c] = (acc[c] || 0) + 1;
        return acc;
      }, {});

      return {
        id:             row.id,
        // Rows predating the split carry no kind; they held both halves.
        kind:           row.kind || 'both',
        packagingType:  row.packaging_type,
        status:         row.status,
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
        } : null,
      };
    });

    return res.status(200).json({ ok: true, reports });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
