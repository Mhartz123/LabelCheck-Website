const { getClient } = require('../../lib/supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    const { error } = await supabase.from('reports').delete().in('id', ids);
    if (error) throw error;

    console.log(`[-] Deleted ${ids.length} report(s)`);
    return res.status(200).json({ ok: true, deleted: ids.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
