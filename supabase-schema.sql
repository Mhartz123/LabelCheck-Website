-- ═══════════════════════════════════════════════════════════════════
-- LabelCheck — reports table
-- Run in Supabase SQL Editor (Project → SQL Editor → New query).
--
-- ⚠ DESTRUCTIVE: this drops any existing `reports` table and everything
--   in it. That is intentional — the label/damage split changed the shape
--   of a report enough that a clean table is simpler than migrating.
--   Re-running this script wipes the dashboard again.
--
-- The app runs two independent inspections and submits a different shape
-- for each. `scan_type` is the discriminator; a row carries one set of
-- columns or the other, never both:
--
--   scan_type = 'LABEL'   → detected_product_name, expiration,
--                           all_labels_present, ingredients, extracted_text
--   scan_type = 'DAMAGE'  → is_damaged, damage_types, affected_sides,
--                           damage_spots, max_confidence, findings
--
-- Columns belonging to the other check stay null/empty rather than being
-- overloaded into a shared meaning.
-- ═══════════════════════════════════════════════════════════════════

drop table if exists reports cascade;

create table reports (
  -- ── Shared by both checks ────────────────────────────────────────
  -- Client-generated ("<epoch_ms>_<name hash>") so a retried submit
  -- upserts instead of duplicating.
  id              text primary key,
  scan_type       text        not null default 'LABEL',
  status          text        not null,
  -- The name the user saved the record under — NOT read off a label.
  product_name    text        not null default '',
  matched_keyword text        not null default '',
  reasons         text[]      not null default '{}',
  scanned_at      timestamptz,
  image_base64    text,
  created_at      timestamptz not null default now(),

  -- ── Label checks only ────────────────────────────────────────────
  -- What OCR read off the front label, as opposed to product_name above.
  detected_product_name text    not null default '',
  expiration            text    not null default '',
  -- Nullable: "not reported" is distinct from "a label was missing".
  all_labels_present    boolean,
  ingredients           text    not null default '',
  extracted_text        text    not null default '',

  -- ── Damage checks only ───────────────────────────────────────────
  is_damaged     boolean,
  -- Single-class model today, so this is ['Damage'] until it's retrained
  -- with per-type classes. Kept as an array so that needs no code change.
  damage_types   text[]  not null default '{}',
  affected_sides text    not null default '',
  damage_spots   integer,
  max_confidence real,
  -- Per-side breakdown: [{slot, label, spotCount, confidence}, …]
  findings       jsonb   not null default '[]'::jsonb,

  -- Only the two known types may be written; anything else is a client bug.
  constraint reports_scan_type_check check (scan_type in ('LABEL', 'DAMAGE'))
);

-- `status` is deliberately left unconstrained. The API already rejects
-- anything that isn't flagged, and the app submits fire-and-forget — a
-- constraint violation there would 500 and silently lose the report
-- rather than surface the problem.

-- ── Indexes ────────────────────────────────────────────────────────
create index reports_created_at_idx   on reports (created_at desc);
create index reports_scan_type_idx    on reports (scan_type);
create index reports_status_idx       on reports (status);
create index reports_product_name_idx on reports (product_name);

-- The dashboard reads through the API using the service_role key, which
-- bypasses RLS. Enabling it with no policies means nothing else can read
-- the table — in particular the public anon key cannot.
alter table reports enable row level security;
