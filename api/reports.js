const { getClient } = require('../lib/supabase');

const COLUMNS = [
  'id',
  'scan_type',
  'status',
  'product_name',
  'matched_keyword',
  'reasons',
  'scanned_at',
  'image_base64',
  'created_at',
  // Label-check columns
  'detected_product_name',
  'expiration',
  'all_labels_present',
  'ingredients',
  'extracted_text',
  // Damage-check columns
  'is_damaged',
  'damage_types',
  'affected_sides',
  'damage_spots',
  'max_confidence',
  'findings',
].join(', ');

/**
 * Returns every stored report, newest first. Each row is camel-cased for the
 * dashboard and carries `scanType` — the dashboard reads that first and only
 * renders the half of the payload that applies.
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
      .select(COLUMNS)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const reports = data.map((row) => ({
      id:             row.id,
      // Rows predating the split have no scan_type; they were label checks.
      scanType:       row.scan_type || 'LABEL',
      status:         row.status,
      productName:    row.product_name,
      matchedKeyword: row.matched_keyword,
      reasons:        row.reasons,
      scannedAt:      row.scanned_at,
      imageBase64:    row.image_base64,

      detectedProductName: row.detected_product_name,
      expiration:          row.expiration,
      allLabelsPresent:    row.all_labels_present,
      ingredients:         row.ingredients,
      extractedText:       row.extracted_text,

      isDamaged:     row.is_damaged,
      damageTypes:   row.damage_types || [],
      affectedSides: row.affected_sides,
      damageSpots:   row.damage_spots,
      maxConfidence: row.max_confidence,
      findings:      row.findings || [],
    }));

    return res.status(200).json({ ok: true, reports });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
