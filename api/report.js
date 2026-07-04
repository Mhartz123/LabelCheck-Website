const { getClient } = require('../lib/supabase');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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

  // Only store flagged reports (mirrors the original server behavior)
  const allowed = ['NON-COMPLIANT', 'WARNING / BANNED'];
  if (!allowed.includes(body.status)) {
    return res.status(200).json({ ok: false, reason: 'status not flagged — not stored' });
  }

  if (!body.id) body.id = Date.now() + '_' + Math.random().toString(36).slice(2);

  try {
    const supabase = getClient();
    const { error } = await supabase
      .from('reports')
      .upsert({ id: body.id, status: body.status, data: body }, { onConflict: 'id' });

    if (error) throw error;

    console.log(`[+] Report received: ${body.productName} — ${body.status}`);
    return res.status(200).json({ ok: true, id: body.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
