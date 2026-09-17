/**
 * The app's three verdicts, as the strings it uploads.
 *
 * The app renamed its advisory verdict from Banned to Warning; records saved
 * before that carry 'WARNING / BANNED' (or 'BANNED'), and phones still on an
 * older build keep sending it. Both spellings are the same verdict, so they
 * are folded into 'WARNING' on the way in and on the way out.
 *
 * Anything unrecognised becomes NON-COMPLIANT, matching the app's own
 * fallback: a status nobody can read is not a pass.
 */
const STATUSES = ['COMPLIANT', 'NON-COMPLIANT', 'WARNING'];
const LEGACY_WARNING = ['WARNING / BANNED', 'BANNED'];

function normalizeStatus(v) {
  const s = String(v || '').trim().toUpperCase();
  if (LEGACY_WARNING.includes(s)) return 'WARNING';
  return STATUSES.includes(s) ? s : 'NON-COMPLIANT';
}

module.exports = { STATUSES, normalizeStatus };
