const { getClient } = require('../lib/supabase');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const FLAGGED_STATUSES = ['NON-COMPLIANT', 'WARNING / BANNED'];

/** Clamp a confidence to 0..1; anything unparseable becomes null. */
function toConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function toPositiveInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Normalises the per-side damage breakdown the app sends. Entries that
 * aren't objects are dropped rather than stored as junk.
 */
function toFindings(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      slot:       String(f.slot || ''),
      label:      String(f.label || 'Damage'),
      spotCount:  toPositiveInt(f.spotCount) ?? 1,
      confidence: toConfidence(f.confidence) ?? 0,
    }));
}

/**
 * Ingest for both inspections. The app posts a different shape per check —
 * see scanType — so this builds the row from only the fields that belong to
 * that type and leaves the other type's columns at their defaults.
 *
 * Only flagged results are stored: a label check that came back
 * non-compliant or banned, or a damage check that actually found damage.
 * Clean scans are acknowledged and discarded (ok:false, not an error) so the
 * app's fire-and-forget submit doesn't treat them as failures.
 */
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, reason: 'invalid JSON' });
  }

  // Submissions from before the label/damage split carry no scanType; they
  // were all label checks, which is what the column defaults to.
  const scanType = body.scanType === 'DAMAGE' ? 'DAMAGE' : 'LABEL';
  const isDamageCheck = scanType === 'DAMAGE';

  if (isDamageCheck) {
    if (body.isDamaged !== true) {
      return res
        .status(200)
        .json({ ok: false, reason: 'no damage found — not stored' });
    }
  } else if (!FLAGGED_STATUSES.includes(body.status)) {
    return res
      .status(200)
      .json({ ok: false, reason: 'status not flagged — not stored' });
  }

  if (!body.id) body.id = Date.now() + '_' + Math.random().toString(36).slice(2);

  const row = {
    id:              body.id,
    scan_type:       scanType,
    status:          body.status || 'NON-COMPLIANT',
    // The name the user saved the record under — common to both checks.
    product_name:    body.productName || '',
    matched_keyword: body.matchedKeyword || '',
    reasons:         Array.isArray(body.reasons) ? body.reasons : [],
    scanned_at:      body.scannedAt || null,
    image_base64:    body.imageBase64 || null,
  };

  if (isDamageCheck) {
    row.is_damaged     = true;
    row.damage_types   = Array.isArray(body.damageTypes) ? body.damageTypes : [];
    row.affected_sides = body.affectedSides || '';
    row.damage_spots   = toPositiveInt(body.damageSpots);
    row.max_confidence = toConfidence(body.maxConfidence);
    row.findings       = toFindings(body.findings);
  } else {
    // detectedProductName is what OCR read off the front label, as opposed
    // to product_name above which is the user's own record name.
    row.detected_product_name = body.detectedProductName || '';
    row.expiration            = body.expiration || '';
    row.all_labels_present    =
      typeof body.allLabelsPresent === 'boolean' ? body.allLabelsPresent : null;
    row.ingredients           = body.ingredients || '';
    row.extracted_text        = body.extractedText || '';
  }

  try {
    const supabase = getClient();
    const { error } = await supabase
      .from('reports')
      .upsert(row, { onConflict: 'id' });

    if (error) throw error;

    const outcome = isDamageCheck
      ? `damage on ${row.affected_sides || 'unspecified side(s)'}`
      : row.status;
    console.log(`[+] ${scanType} report received: ${row.product_name} — ${outcome}`);
    return res.status(200).json({ ok: true, id: row.id, scanType });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
