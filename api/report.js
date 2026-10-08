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

// ── Timings ─────────────────────────────────────────────────────────

const TIMING_GROUPS = ['ocr', 'damageModel'];
// A scan has a handful of stages; this is only a ceiling for an open endpoint.
const MAX_TIMINGS = 64;
const MAX_REPORT_CHARS = 64 * 1024;

/**
 * `timings` as [{group, label, totalMs, runs}], or null when the record has
 * none — every record saved before the app measured them. Null, not [], so
 * the dashboard can tell "not measured" from "measured nothing".
 */
function toTimings(raw) {
  if (!Array.isArray(raw)) return null;
  const list = raw.slice(0, MAX_TIMINGS).map((t) => {
    const o = (t && typeof t === 'object') ? t : {};
    const ms = Number(o.totalMs);
    if (o.totalMs == null || !Number.isFinite(ms) || ms < 0) return null;
    const runs = Number(o.runs);
    return {
      group:   TIMING_GROUPS.includes(o.group) ? o.group : String(o.group || 'other').slice(0, 40),
      label:   String(o.label || '').slice(0, 120),
      totalMs: ms,
      runs:    Number.isInteger(runs) && runs > 0 ? runs : 1,
    };
  }).filter(Boolean);
  return list.length ? list : null;
}

/**
 * Sum of one group's stages (or all of them), or null when that group never
 * ran — a label-only scan has no damage-model time, and storing 0 for it
 * would drag the dashboard's averages toward zero.
 */
function sumTimings(timings, group) {
  if (!timings) return null;
  const rows = group ? timings.filter((t) => t.group === group) : timings;
  return rows.length ? rows.reduce((acc, t) => acc + t.totalMs, 0) : null;
}

/** `damage.report` as sent, if it is an object of sane size. */
function toDamageReport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return JSON.stringify(raw).length <= MAX_REPORT_CHARS ? raw : null;
}

/**
 * Per-photo inference figures pulled out of `damage.report`, matching the
 * app's DamageSessionReport: over the photos that ran (`succeeded` absent
 * means it ran — older reports only listed photos that did). modelLoadMs is
 * absent when the model was already loaded before the scan, and stays null.
 */
function inferenceStats(report) {
  const photos = report && Array.isArray(report.photos) ? report.photos : [];
  const ms = photos
    .filter((p) => p && typeof p === 'object' && p.succeeded !== false)
    .map((p) => (p.inferenceMs == null ? NaN : Number(p.inferenceMs)))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const load = report && report.modelLoadMs != null ? Number(report.modelLoadMs) : NaN;
  return {
    inference_mean_ms: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
    inference_min_ms:  ms.length ? Math.min(...ms) : null,
    inference_max_ms:  ms.length ? Math.max(...ms) : null,
    model_load_ms:     Number.isFinite(load) && load >= 0 ? load : null,
  };
}

function isDataImage(v) {
  return typeof v === 'string' && v.startsWith('data:image/') && v.length <= MAX_IMAGE_CHARS;
}

/**
 * Ingest for all three flows — insert a new record, or update one the
 * server already has.
 *
 * A record spans up to five tables depending on `kind`: the parent row
 * always, plus a label row (label/both), a damage row (damage/both), one row
 * per packaging photo, and one row per detected damage instance.
 *
 * The app's "Sync to dashboard" re-sends every record on the phone, so this
 * must be idempotent. The payload `id` is stable — "<recordName>@
 * <scannedAt>" — and is stored as `record_uid`. The work happens in one
 * Postgres function (checkmuna_ingest_report, supabase-sync-migration.sql),
 * so it is one transaction and one round trip:
 *
 *   1. find the row by record_uid
 *   2. else a legacy row (uploaded with a random id) with the same scan time
 *      and sanitised name — and give it this record_uid
 *   3. found → UPDATE: timings/report columns take the new values, anything
 *      else only fills what is empty. Child rows are upserted, never added
 *      twice. A re-send without photos (the app omits them on a sync) leaves
 *      the stored photos alone.
 *   4. not found → INSERT … ON CONFLICT, so two concurrent syncs can't race
 *      into a duplicate.
 *
 * Builds without stable ids send a random id and no `recordName`. Those keep
 * record_uid NULL (their id is not the phone's record id), so a later sync
 * from an updated phone still finds them as legacy rows.
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

  const recordName = typeof body.recordName === 'string' && body.recordName
    ? body.recordName : null;
  const id = body.id
    ? String(body.id)
    : Date.now() + '_' + Math.random().toString(36).slice(2);
  const recordUid = body.id && recordName ? id : null;

  const packagingType = toPackagingType(body.packagingType);
  const timings = toTimings(body.timings);

  const report = {
    id,
    kind,
    packaging_type:  packagingType,
    status:          normalizeStatus(body.status),
    product_name:    body.productName || '',
    matched_keyword: body.matchedKeyword || '',
    reasons:         Array.isArray(body.reasons) ? body.reasons.map(String) : [],
    // Passed through as the string the app sent and parsed by Postgres,
    // exactly as it always has been — legacy matching depends on that.
    scanned_at:      body.scannedAt || null,
    // Absent on a sync re-send → null → the stored photo is kept.
    image_base64:    isDataImage(body.imageBase64) ? body.imageBase64 : null,
    timings,
    ml_total_ms:     sumTimings(timings),
    ocr_ms:          sumTimings(timings, 'ocr'),
    damage_model_ms: sumTimings(timings, 'damageModel'),
  };

  let label = null;
  if (hasLabel) {
    const l = (body.label && typeof body.label === 'object') ? body.label : {};
    label = {
      detected_product_name: l.detectedProductName || '',
      expiration:            l.expiration || '',
      ingredients:           l.ingredients || '',
      extracted_text:        l.extractedText || '',
    };
  }

  let damage = null;
  let images = [];
  let detections = [];
  if (hasDamage) {
    const d = (body.damage && typeof body.damage === 'object') ? body.damage : {};
    const damageReport = toDamageReport(d.report);
    damage = {
      packaging_type: packagingType,
      available:      d.available === true,
      is_damaged:     d.isDamaged === true,
      message:        d.message || '',
      max_confidence: toConfidence(d.maxConfidence),
      timings:        toTimings(d.timings),
      report:         damageReport,
      ...inferenceStats(damageReport),
    };
    // Absent on a sync re-send → [] → nothing inserted, nothing deleted.
    images = toImageRows(id, d.images);
    detections = toDetectionRows(id, d);
  }

  try {
    const { data, error } = await getClient().rpc('checkmuna_ingest_report', {
      p: {
        record_uid:  recordUid,
        record_name: recordName,
        report, label, damage, images, detections,
      },
    });
    if (error) throw error;

    const storedId = (data && data.id) || id;
    const inserted = !!(data && data.inserted);

    console.log(
      `[${inserted ? '+' : '~'}] ${kind} report: ${report.product_name} — ${report.status}` +
      (packagingType ? ` (${packagingType})` : '') +
      (detections.length ? `, ${detections.length} detection(s)` : '') +
      (images.length ? `, ${images.length} photo(s)` : '') +
      (timings ? `, ${Math.round(report.ml_total_ms)} ms ML` : '')
    );
    return res.status(200).json({
      ok: true, id: storedId, kind, result: inserted ? 'inserted' : 'updated',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};

