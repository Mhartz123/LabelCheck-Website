#!/usr/bin/env python3
"""Prints the SQL that creates (or updates) a dashboard account.

    python scripts/create_user.py <username> <password> ["Full Name"] [admin|staff]

Same output as scripts/create-user.js — this exists because the machine
this was built on has Python but no Node. Python's hashlib.scrypt with
n=16384, r=8, p=1 is byte-identical to Node's crypto.scryptSync defaults,
which is what lib/auth.js verifies against.

There is deliberately no sign-up endpoint — accounts are made by hand and
pasted into the Supabase SQL Editor, so nothing on the public internet can
mint a login for the dashboard. The password is hashed here, on your
machine; only the digest is printed, so the plaintext never reaches
Supabase or its query logs.
"""
import base64
import hashlib
import os
import sys


def hash_password(password: str) -> str:
    """Returns "scrypt$<salt-b64>$<hash-b64>" — the shape stored in the DB."""
    salt = os.urandom(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64)
    return "scrypt${}${}".format(
        base64.b64encode(salt).decode(), base64.b64encode(digest).decode())


def q(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def main(argv):
    if len(argv) < 3:
        sys.exit('Usage: python scripts/create_user.py <username> <password> '
                 '["Full Name"] [admin|staff]')

    username, password = argv[1], argv[2]
    full_name = argv[3] if len(argv) > 3 else ''
    role      = argv[4] if len(argv) > 4 else 'admin'

    if len(password) < 8:
        sys.exit('Password must be at least 8 characters.')
    if role not in ('admin', 'staff'):
        sys.exit("Role must be 'admin' or 'staff'.")

    print("""
-- Run this in the Supabase SQL Editor.
-- Re-running with a new password resets that account's password.
insert into dashboard_users (username, password_hash, full_name, role)
values ({}, {}, {}, {})
on conflict (lower(username)) do update
  set password_hash   = excluded.password_hash,
      full_name       = excluded.full_name,
      role            = excluded.role,
      is_active       = true,
      failed_attempts = 0,
      locked_until    = null;
""".format(q(username.strip().lower()), q(hash_password(password)),
           q(full_name), q(role)).strip())


if __name__ == '__main__':
    main(sys.argv)
