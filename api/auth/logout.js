const { destroySession, clearedCookie } = require('../../lib/auth');

/**
 * POST /api/auth/logout
 *
 * Deletes the session row as well as the cookie, so a token copied off
 * the machine before signing out is dead too. Always answers 200 — an
 * already-signed-out browser asking to sign out has got what it wanted.
 */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  try {
    await destroySession(req);
  } catch (err) {
    console.error(err);   // cookie still gets cleared below
  }

  res.setHeader('Set-Cookie', clearedCookie());
  return res.status(200).json({ ok: true });
};
