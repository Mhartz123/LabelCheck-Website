const { getSessionUser } = require('../../lib/auth');

/**
 * GET /api/auth/me
 *
 * The gate the dashboard calls on load: 200 with the account when the
 * cookie is good, 401 when it isn't (expired, deleted, deactivated).
 */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ ok: false, reason: 'unauthorized' });
    return res.status(200).json({ ok: true, user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'database error' });
  }
};
