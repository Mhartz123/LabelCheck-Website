const crypto = require('crypto');
const { getClient } = require('./supabase');

// Cookie name is deliberately boring — it only ever holds an opaque token.
const COOKIE_NAME  = 'cm_session';
// "Keep me signed in" ticked vs not. Unticked also drops Max-Age from the
// cookie, so it dies with the browser — the point of not being remembered
// on a shared machine.
const SESSION_DAYS  = 7;
const SESSION_HOURS = 12;

// Failed sign-ins per account before it's frozen, and for how long.
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MINS  = 15;

// scrypt params. keylen 64 with the Node defaults (N=16384, r=8, p=1)
// costs ~50ms per hash here, which is fine for a login and expensive
// enough to make offline guessing painful.
const SCRYPT_KEYLEN = 64;

// ── Passwords ───────────────────────────────────────────────────────

/** Returns "scrypt$<salt-b64>$<hash-b64>" — the shape stored in the DB. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

/**
 * Constant-time check of a plaintext password against a stored digest.
 * Returns false (never throws) on a malformed or unknown-format digest.
 */
function verifyPassword(password, stored) {
  try {
    const [scheme, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

    const expected = Buffer.from(hashB64, 'base64');
    const actual   = crypto.scryptSync(
      password, Buffer.from(saltB64, 'base64'), expected.length);

    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── Cookies ─────────────────────────────────────────────────────────

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * HttpOnly so no script can read the token, SameSite=Lax so it isn't sent
 * on cross-site requests, Secure because Vercel is HTTPS (browsers also
 * accept Secure cookies on http://localhost, so `vercel dev` still works).
 */
function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  // null → a session cookie the browser discards when it closes.
  if (maxAgeSeconds != null) parts.push('Max-Age=' + maxAgeSeconds);
  return parts.join('; ');
}

function clearedCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

// ── Sessions ────────────────────────────────────────────────────────

/** Only the digest is stored, so the table can't be replayed as a login. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(userId, userAgent, remember) {
  const token   = crypto.randomBytes(32).toString('base64url');
  const ttlMs   = remember ? SESSION_DAYS * 86400000 : SESSION_HOURS * 3600000;
  const expires = new Date(Date.now() + ttlMs);

  const supabase = getClient();
  const { error } = await supabase.from('dashboard_sessions').insert({
    token_hash: hashToken(token),
    user_id:    userId,
    expires_at: expires.toISOString(),
    user_agent: String(userAgent || '').slice(0, 300),
  });
  if (error) throw error;

  // The row expires either way; only the cookie's lifetime differs.
  return { token, maxAge: remember ? Math.floor(ttlMs / 1000) : null };
}

/**
 * Resolves the request's cookie to an account, or null. Expired rows are
 * deleted as they're encountered — there's no cron on Vercel, and a
 * session is looked up on every dashboard poll anyway.
 */
async function getSessionUser(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;

  const supabase = getClient();
  const { data, error } = await supabase
    .from('dashboard_sessions')
    .select('token_hash, expires_at, dashboard_users (id, username, full_name, role, is_active)')
    .eq('token_hash', hashToken(token))
    .maybeSingle();

  if (error || !data) return null;

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await supabase.from('dashboard_sessions')
      .delete().eq('token_hash', data.token_hash);
    return null;
  }

  // PostgREST hands a to-one embed back as an object or a 1-element array.
  const u = Array.isArray(data.dashboard_users)
    ? data.dashboard_users[0]
    : data.dashboard_users;

  if (!u || u.is_active === false) return null;
  return { id: u.id, username: u.username, fullName: u.full_name, role: u.role };
}

async function destroySession(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return;
  await getClient().from('dashboard_sessions')
    .delete().eq('token_hash', hashToken(token));
}

/**
 * Wraps a handler so it only runs for a signed-in browser. A rejected
 * request gets 401 with `reason: 'unauthorized'`, which the dashboard
 * treats as "bounce to the login page".
 */
function requireAuth(handler) {
  return async (req, res) => {
    let user;
    try {
      user = await getSessionUser(req);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, reason: 'database error' });
    }
    if (!user) {
      return res.status(401).json({ ok: false, reason: 'unauthorized' });
    }
    req.user = user;
    return handler(req, res);
  };
}

module.exports = {
  COOKIE_NAME, MAX_ATTEMPTS, LOCKOUT_MINS, SESSION_DAYS, SESSION_HOURS,
  hashPassword, verifyPassword,
  sessionCookie, clearedCookie,
  createSession, getSessionUser, destroySession, requireAuth,
};
