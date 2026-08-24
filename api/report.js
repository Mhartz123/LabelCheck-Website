const { getClient } = require('../lib/supabase');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const KINDS = ['label', 'damage', 'both'];
const PACKAGING_TYPES = ['box', 'foil', 'bottle'];

/** Clamp a confidence to 0..1; anything unparseable becomes 0. */
function toConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function toPackagingType(v) {
  return PACKAGING_TYPES.includes(v) ? v : null;
}

/**
 * Ingest for all three flows.
 *
 * A record is written across up to four tables depending on `kind`:
 * the parent row always, plus a label row (label/both), a damage row
 * (damage/both), and one detection row per detected damage instance.
 *
 * Every saved scan is stored, including compliant and no-damage ones —
 * the dashboard needs clean results to show a ratio against.
 *
 * Children are deleted and rewritten rather than upserted, so a resubmit
 * of the same id can't leave stale detections from a previous attempt.
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

  // Submissions from before the split carry no kind. Those records held
  // both halves, which is exactly what 'both' means.
  const kind = KINDS.includes(body.kind) ? body.kind : 'both';
  const hasLabel  = kind !== 'damage';
  const hasDamage = kind !== 'label';

  if (!body.id) body.id = Date.now() + '_' + Math.random().toString(36).slice(2);

  const packagingType = toPackagingType(body.packagingType);

  const reportRow = {
    id:              body.id,
    kind,
    packaging_type:  packagingType,
    status:          body.status || 'NON-COMPLIANT',
    product_name:    body.productName || '',
    matched_keyword: body.matchedKeyword || '',
    reasons:         Array.isArray(body.reasons) ? body.reasons : [],
    scanned_at:      body.scannedAt || null,
    image_base64:    body.imageBase64 || null,
  };

  try {
    const supabase = getClient();

    // ── Parent ──
    const { error: parentErr } = await supabase
      .from('reports')
      .upsert(reportRow, { onConflict: 'id' });
    if (parentErr) throw parentErr;

    // ── Label half ──
    // Clear first so a record that changed kind (or a retry) can't keep a
    // stale half that no longer applies.
    const { error: labelDelErr } = await supabase
      .from('report_label_checks').delete().eq('report_id', body.id);
    if (labelDelErr) throw labelDelErr;

    if (hasLabel) {
      const label = (body.label && typeof body.label === 'object') ? body.label : {};
      const { error } = await supabase.from('report_label_checks').insert({
        report_id:             body.id,
        detected_product_name: label.detectedProductName || '',
        expiration:            label.expiration || '',
        ingredients:           label.ingredients || '',
        extracted_text:        label.extractedText || '',
      });
      if (error) throw error;
    }

    // ── Damage half + detections ──
    // Detections cascade off the parent, not the damage row, so delete
    // them explicitly here.
    const { error: detDelErr } = await supabase
      .from('report_damage_detections').delete().eq('report_id', body.id);
    if (detDelErr) throw detDelErr;

    const { error: dmgDelErr } = await supabase
      .from('report_damage_checks').delete().eq('report_id', body.id);
    if (dmgDelErr) throw dmgDelErr;

    let detectionCount = 0;
    if (hasDamage) {
      const damage = (body.damage && typeof body.damage === 'object') ? body.damage : {};
      const { error } = await supabase.from('report_damage_checks').insert({
        report_id:      body.id,
        packaging_type: packagingType,
        available:      damage.available === true,
        is_damaged:     damage.isDamaged === true,
        message:        damage.message || '',
        max_confidence: toConfidence(damage.maxConfidence),
      });
      if (error) throw error;

      const detections = Array.isArray(damage.detections) ? damage.detections : [];
      if (detections.length > 0) {
        const rows = detections.map((d, i) => ({
          report_id:       body.id,
          detection_class: String(d || 'Damage'),
          ordinal:         i,
        }));
        const { error: detErr } = await supabase
          .from('report_damage_detections').insert(rows);
        if (detErr) throw detErr;
        detectionCount = rows.length;
      }
    }

    console.log(
      `[+] ${kind} report: ${reportRow.product_name} — ${reportRow.status}` +
      (packagingType ? ` (${packagingType})` : '') +
      (detectionCount ? `, ${detectionCount} detection(s)` : '')
    );
    return res.status(200).json({ ok: true, id: body.id, kind });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
