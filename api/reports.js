const { getClient } = require('../lib/supabase');
const { requireAuth } = require('../lib/auth');
const { normalizeStatus } = require('../lib/status');

// PostgREST embedded selects — one round trip pulls each report with its
// label half, damage half, and detection rows. Relies on the foreign keys
// declared in the schema.
//
// What is NOT here is as deliberate as what is. Supabase bills egress for
// every byte this query returns, and the dashboard re-polls it:
//   • reports.image_base64 (the ~200 KB cover photo) — only `has_image`.
//     The thumbnail comes from /api/reports/cover, which the browser caches.
//   • report_damage_images.image_base64 (four packaging photos per scan) —
//     only ordinal + slot, to caption and count them.
//   • report_label_checks.extracted_text (the whole OCR dump), the timings
//     arrays and the damage report JSON — /api/reports/detail serves those
//     for the one report that is open.
const SELECT = `
  id, kind, packaging_type, status, product_name, matched_keyword,
  reasons, scanned_at, has_image, created_at, updated_at,
  ml_total_ms, ocr_ms, damage_model_ms,
  report_label_checks (
    detected_product_name, expiration, ingredients
  ),
  report_damage_checks (
    packaging_type, available, is_damaged, message, max_confidence,
    inference_mean_ms, inference_min_ms, inference_max_ms, model_load_ms
  ),
  report_damage_detections (
    detection_class, ordinal, confidence, source_index,
    box_left, box_top, box_width, box_height
  ),
  report_damage_images (
    ordinal, slot
  )
`;

// A delta poll re-reads rows changed this long before the cursor. An upload
// stamps updated_at when its transaction starts, not when it commits, so a
// row can become visible with a timestamp slightly older than a cursor
// handed out in between. The overlap re-sends a few rows; the browser merges
// by id, so seeing one twice is harmless and missing one is not.
const CURSOR_OVERLAP_MS = 60 * 1000;

// Rows per select — Supabase's default max-rows.
const PAGE = 1000;

/** PostgREST returns a to-one embed as an object or a 1-element array. */
function one(v) {
  if (Array.isArray(v)) return v[0] || null;
  return v || null;
}

/**
 * `GET /api/reports` — every stored report, each flattened into a single
 * camelCased object with `label` and `damage` sub-objects (null when that
 * half wasn't run).
 *
 * `GET /api/reports?since=<cursor>` — only the reports added or changed
 * since that cursor, plus `total`, the number of reports that exist. The
 * dashboard polls this way: a quiet 30 s poll returns no rows at all. It
 * merges the delta into what it holds, and when its count then differs from
 * `total` (something was deleted) it does one full reload.
 *
 * Every response carries `cursor` — the newest updated_at it saw — to pass
 * as `since` next time.
 */
module.exports = requireAuth(async (req, res) => {
  // No CORS headers: unlike /api/report (which the phone posts to from
  // another origin) this is read by the dashboard on its own origin, and
  // the session cookie wouldn't be sent cross-site anyway.
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  const sinceRaw = req.query && req.query.since;
  const sinceMs  = typeof sinceRaw === 'string' ? Date.parse(sinceRaw) : NaN;
  const isDelta  = Number.isFinite(sinceMs);

  try {
    const supabase = getClient();

    // Supabase caps one select at 1000 rows (its default max-rows), and a
    // phone's sync can put thousands here, so read in pages. id breaks ties
    // in created_at so no row straddles a page boundary twice or not at all.
    const data = [];
    for (let from = 0; ; from += PAGE) {
      let query = supabase
        .from('reports')
        .select(SELECT)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (isDelta) {
        query = query.gt('updated_at', new Date(sinceMs - CURSOR_OVERLAP_MS).toISOString());
      }
      const { data: page, error } = await query;
      if (error) throw error;
      data.push(...page);
      if (page.length < PAGE) break;
    }

    // A head-only count: the row total comes back in a header, no rows.
    let total = data.length;
    if (isDelta) {
      const { count, error: countErr } = await supabase
        .from('reports')
        .select('id', { count: 'exact', head: true });
      if (countErr) throw countErr;
      total = count;
    }

    // Newest change seen — never moves backwards, even on an empty delta.
    // Compared as numbers: Postgres and JS print timestamps differently.
    let cursorMs = isDelta ? sinceMs : 0;
    for (const row of data) {
      const t = Date.parse(row.updated_at);
      if (Number.isFinite(t) && t > cursorMs) cursorMs = t;
    }
    const cursor = cursorMs ? new Date(cursorMs).toISOString() : null;

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
        updatedAt:      row.updated_at,
        // The bytes come from /api/reports/cover?id=… — see SELECT.
        hasImage:       row.has_image === true,

        // On-device ML time for the whole scan. All null on records saved
        // before the app measured it — "not measured", never zero.
        timing: {
          totalMs:       row.ml_total_ms,
          ocrMs:         row.ocr_ms,
          damageModelMs: row.damage_model_ms,
        },

        label: label ? {
          detectedProductName: label.detected_product_name,
          expiration:          label.expiration,
          ingredients:         label.ingredients,
          // extractedText is fetched with the detail view — see SELECT.
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
          // Per-photo inference over the photos that ran, and the one-time
          // model load (null when it was already loaded before this scan).
          inferenceMeanMs: damage.inference_mean_ms,
          inferenceMinMs:  damage.inference_min_ms,
          inferenceMaxMs:  damage.inference_max_ms,
          modelLoadMs:     damage.model_load_ms,
        } : null,
      };
    });

    return res.status(200).json({
      ok: true, full: !isDelta, reports, total, cursor,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
});
