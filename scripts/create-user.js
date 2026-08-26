#!/usr/bin/env node
/**
 * Prints the SQL that creates (or updates) a dashboard account.
 *
 *   node scripts/create-user.js <username> <password> ["Full Name"] [role]
 *
 * There is deliberately no sign-up endpoint — accounts are made by hand
 * and pasted into the Supabase SQL Editor. That way nothing on the public
 * internet can create a login for the dashboard.
 *
 * The password is hashed here, on your machine; only the digest is
 * printed, so the plaintext never reaches Supabase or the SQL logs.
 */
const { hashPassword } = require('../lib/auth');

const [, , username, password, fullName = '', role = 'admin'] = process.argv;

if (!username || !password) {
  console.error('Usage: node scripts/create-user.js <username> <password> ["Full Name"] [admin|staff]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}
if (role !== 'admin' && role !== 'staff') {
  console.error("Role must be 'admin' or 'staff'.");
  process.exit(1);
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

console.log(`
-- Run this in the Supabase SQL Editor.
-- Re-running with a new password resets that account's password.
insert into dashboard_users (username, password_hash, full_name, role)
values (${q(username.trim().toLowerCase())}, ${q(hashPassword(password))}, ${q(fullName)}, ${q(role)})
on conflict (lower(username)) do update
  set password_hash   = excluded.password_hash,
      full_name       = excluded.full_name,
      role            = excluded.role,
      is_active       = true,
      failed_attempts = 0,
      locked_until    = null;
`.trim());
