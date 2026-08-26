-- ═══════════════════════════════════════════════════════════════════
-- CheckMuna — dashboard login schema
-- Run in Supabase SQL Editor (Project → SQL Editor → New query).
--
-- Safe to re-run: everything here is "if not exists", so unlike
-- supabase-schema.sql this will NOT wipe existing accounts.
--
--   dashboard_users      one row per person who can open the dashboard
--   dashboard_sessions   one row per active browser sign-in
--
-- The dashboard is the only thing behind the login. The Flutter app's
-- POST /api/report stays open — the phone has no account to sign in
-- with, it just uploads scans.
--
-- Passwords are never stored. `password_hash` holds a scrypt digest in
-- the format  scrypt$<salt-b64>$<hash-b64>  produced by lib/auth.js.
-- Create the first account with:  node scripts/create-user.js
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Accounts ────────────────────────────────────────────────────────
create table if not exists dashboard_users (
  id             uuid primary key default gen_random_uuid(),
  -- Stored already lower-cased; the API lower-cases before looking up,
  -- so "Admin" and "admin" are the same account.
  username       text        not null,
  password_hash  text        not null,
  full_name      text        not null default '',
  role           text        not null default 'staff',
  -- Lets an account be switched off without deleting it (and losing the
  -- record of who it was).
  is_active      boolean     not null default true,
  -- Brute-force brake. Cleared on every successful sign-in.
  failed_attempts integer    not null default 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),

  constraint dashboard_users_role_check
    check (role in ('admin', 'staff'))
);

create unique index if not exists dashboard_users_username_key
  on dashboard_users (lower(username));

-- ── Sessions ────────────────────────────────────────────────────────
-- The browser holds a random token in an HttpOnly cookie; only its
-- SHA-256 lives here. A leaked table therefore can't be used to sign in,
-- and "sign out" is a real server-side delete rather than just dropping
-- the cookie.
create table if not exists dashboard_sessions (
  token_hash  text        primary key,
  user_id     uuid        not null
                references dashboard_users(id) on delete cascade,
  expires_at  timestamptz not null,
  user_agent  text        not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists dashboard_sessions_user_idx
  on dashboard_sessions (user_id);
create index if not exists dashboard_sessions_expires_idx
  on dashboard_sessions (expires_at);

-- ── Row level security ──────────────────────────────────────────────
-- Same posture as the reports tables: the API reads through the
-- service_role key (which bypasses RLS) and enabling RLS with no
-- policies means the public anon key can't touch password hashes or
-- session tokens.
alter table dashboard_users    enable row level security;
alter table dashboard_sessions enable row level security;
