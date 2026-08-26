const { getClient } = require('../../lib/supabase');
const {
  verifyPassword, createSession, sessionCookie,
  MAX_ATTEMPTS, LOCKOUT_MINS,
} = require('../../lib/auth');

/**
 * POST /api/auth/login  { username, password }
 *
 * On success sets the HttpOnly session cookie and returns the account.
 * Every failure — unknown user, wrong password, deactivated account —
 * answers with the same 401 and the same message, so the response can't
 * be used to work out which usernames exist.
 *
 * Repeated failures against one account freeze it for LOCKOUT_MINS. The
 * counter lives on the row rather than in memory because serverless
 * functions don't share memory between invocations.
 */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method not allowed' });
  }

  const body     = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!username || !password) {
    return res.status(400).json({ ok: false, reason: 'Enter your username and password.' });
  }

  const DENIED = { ok: false, reason: 'Incorrect username or password.' };

  try {
    const supabase = getClient();

    const { data: user, error } = await supabase
      .from('dashboard_users')
      .select('id, username, password_hash, full_name, role, is_active, failed_attempts, locked_until')
      .eq('username', username)
      .maybeSingle();
    if (error) throw error;

    if (!user || !user.is_active) return res.status(401).json(DENIED);

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const mins = Math.max(1, Math.ceil(
        (new Date(user.locked_until).getTime() - Date.now()) / 60000));
      return res.status(429).json({
        ok: false,
        reason: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      });
    }

    if (!verifyPassword(password, user.password_hash)) {
      const attempts = (user.failed_attempts || 0) + 1;
      const lock = attempts >= MAX_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINS * 60000).toISOString()
        : null;

      await supabase.from('dashboard_users').update({
        failed_attempts: lock ? 0 : attempts,   // reset the tally once locked
        locked_until:    lock,
      }).eq('id', user.id);

      if (lock) {
        return res.status(429).json({
          ok: false,
          reason: `Too many failed attempts. Try again in ${LOCKOUT_MINS} minutes.`,
        });
      }
      return res.status(401).json(DENIED);
    }

    // ── Signed in ──
    const remember = body.remember !== false;
    const { token, maxAge } =
      await createSession(user.id, req.headers['user-agent'], remember);

    await supabase.from('dashboard_users').update({
      failed_attempts: 0,
      locked_until:    null,
      last_login_at:   new Date().toISOString(),
    }).eq('id', user.id);

    // Housekeeping: no cron on Vercel, so expired rows get swept here.
    await supabase.from('dashboard_sessions')
      .delete().lt('expires_at', new Date().toISOString());

    res.setHeader('Set-Cookie', sessionCookie(token, maxAge));
    console.log(`[auth] ${user.username} signed in`);

    return res.status(200).json({
      ok: true,
      user: {
        id: user.id, username: user.username,
        fullName: user.full_name, role: user.role,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'Server error. Try again.' });
  }
};
