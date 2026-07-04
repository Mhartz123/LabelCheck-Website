-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query)

create table if not exists reports (
  id         text primary key,
  status     text not null,
  data       jsonb not null,       -- full report object (productName, matchedKeyword, extractedText, scannedAt, imageBase64, ...)
  created_at timestamptz not null default now()
);

create index if not exists reports_created_at_idx on reports (created_at desc);

-- Row Level Security: keep it enabled, but only the service role key
-- (used server-side by the API functions) can read/write. The dashboard
-- and Flutter app never talk to Supabase directly, so no public policies
-- are needed.
alter table reports enable row level security;
