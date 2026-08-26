const { getClient } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');

module.exports = requireAuth(async (req, res) => {
  // Dashboard-only, same origin — see the note in api/reports.js.
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0) {
    return res.status(200).json({ ok: true, deleted: 0 });
  }

  try {
    const supabase = getClient();
    // Deleting the parent is enough — report_label_checks,
    // report_damage_checks and report_damage_detections all declare
    // "on delete cascade" against reports(id).
    const { error } = await supabase.from('reports').delete().in('id', ids);
    if (error) throw error;

    console.log(`[-] ${req.user.username} deleted ${ids.length} report(s)`);
    return res.status(200).json({ ok: true, deleted: ids.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
});
