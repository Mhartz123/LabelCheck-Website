const { getClient } = require('../lib/supabase');
const { normalizeStatus } = require('../lib/status');

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

const BOX_SLOTS = ['front', 'side1', 'side2', 'back'];

// This endpoint is open — the phone has no account to sign in with — so the
// packaging photos need a ceiling that doesn't depend on the client behaving.
// The app downscales to ~200 KB per shot and sends at most four; these are
// roughly double that, loose enough never to reject a real scan.
const MAX_IMAGES = 6;
const MAX_IMAGE_CHARS = 600 * 1024;

/**
 * A 0..1 fraction, or null when the detector reported no geometry.
 *
 * null and empty string are geometry the detector did not report, not the
 * coordinate zero — Number() would quietly turn both into 0 and put a
 * zero-area box in the top-left corner of the photo.
 */
function toFraction(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalises `damage.images` into rows.
 *
 * Accepts either bare data URLs or `{ slot, imageBase64 }` objects, because
 * the slot name is only worth having when the app actually knows it — a
 * detector fed a plain list of photos still gets captions by position.
 *
 * `ordinal` is the photo's index in the list as sent, which is what
 * `box.sourceIndex` refers to. It is assigned before anything is dropped, so
 * an oversized photo leaves a gap rather than shifting every later photo out
 * from under the detections pointing at it.
 */
function toImageRows(reportId, raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_IMAGES)
    .map((entry, i) => {
      const obj = (entry && typeof entry === 'object') ? entry : {};
      const data = typeof entry === 'string'
        ? entry
        : (obj.imageBase64 || obj.image || '');
      const slot = BOX_SLOTS.includes(obj.slot) ? obj.slot : null;
      return { report_id: reportId, ordinal: i, slot, image_base64: data };
    })
    .filter((row) =>
      typeof row.image_base64 === 'string' &&
      row.image_base64.startsWith('data:image/') &&
      row.image_base64.length <= MAX_IMAGE_CHARS);
}

/**
 * One row per detection, with geometry when the app sent it.
 *
 * `boxes` is the richer form of the same findings as `detections` — same
 * classes, same order, plus a rect and a per-detection confidence — so it
 * wins outright when present. `detections` stays the fallback for records
 * from before boxes existed and for any detector that reports classes
 * without geometry; those rows keep null geometry, which the dashboard reads
 * as "no overlay", not as "no damage".
 */
function toDetectionRows(reportId, damage) {
  const boxes = Array.isArray(damage.boxes) ? damage.boxes : [];
  if (boxes.length > 0) {
    return boxes.map((b, i) => {
      const box = (b && typeof b === 'object') ? b : {};
      const src = Number(box.sourceIndex);
      return {
        report_id:       reportId,
        detection_class: String(box.label || 'Damage'),
        ordinal:         i,
        confidence:      toConfidence(box.confidence),
        source_index:    Number.isInteger(src) && src >= 0 ? src : null,
        box_left:        toFraction(box.left),
        box_top:         toFraction(box.top),
        box_width:       toFraction(box.width),
        box_height:      toFraction(box.height),
      };
    });
  }

  const detections = Array.isArray(damage.detections) ? damage.detections : [];
  return detections.map((d, i) => ({
    report_id:       reportId,
    detection_class: String(d || 'Damage'),
    ordinal:         i,
  }));
}

/**
 * Ingest for all three flows.
 *
 * A record is written across up to five tables depending on `kind`:
 * the parent row always, plus a label row (label/both), a damage row
 * (damage/both), one row per packaging photo, and one row per detected
 * damage instance.
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
    status:          normalizeStatus(body.status),
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

    const { error: imgDelErr } = await supabase
      .from('report_damage_images').delete().eq('report_id', body.id);
    if (imgDelErr) throw imgDelErr;

    const { error: dmgDelErr } = await supabase
      .from('report_damage_checks').delete().eq('report_id', body.id);
    if (dmgDelErr) throw dmgDelErr;

    let detectionCount = 0;
    let imageCount = 0;
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

      // Photos before detections: the detections point at them by ordinal, so
      // the other order would leave a moment where a reader could see a box
      // referring to a photo that isn't stored yet.
      const imageRows = toImageRows(body.id, damage.images);
      if (imageRows.length > 0) {
        const { error: imgErr } = await supabase
          .from('report_damage_images').insert(imageRows);
        if (imgErr) throw imgErr;
        imageCount = imageRows.length;
      }

      const detectionRows = toDetectionRows(body.id, damage);
      if (detectionRows.length > 0) {
        const { error: detErr } = await supabase
          .from('report_damage_detections').insert(detectionRows);
        if (detErr) throw detErr;
        detectionCount = detectionRows.length;
      }
    }

    console.log(
      `[+] ${kind} report: ${reportRow.product_name} — ${reportRow.status}` +
      (packagingType ? ` (${packagingType})` : '') +
      (detectionCount ? `, ${detectionCount} detection(s)` : '') +
      (imageCount ? `, ${imageCount} photo(s)` : '')
    );
    return res.status(200).json({ ok: true, id: body.id, kind });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
