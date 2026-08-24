-- ═══════════════════════════════════════════════════════════════════
-- CheckMuna — reports schema
-- Run in Supabase SQL Editor (Project → SQL Editor → New query).
--
-- ⚠ DESTRUCTIVE: drops and recreates every table below. Run once, before
--   deploying the API. Re-running wipes the dashboard.
--
-- The app runs three flows and a record knows which via `kind`:
--
--   kind = 'label'   → label check only      (label rows only)
--   kind = 'damage'  → damage check only     (damage rows only)
--   kind = 'both'    → Inspection Mode: label check then packaging photos,
--                      saved as ONE record   (both sets of rows)
--
-- That last one is why this is split across tables rather than one wide
-- row: an inspection genuinely has both halves, so a single flat row would
-- need every column of both and no way to say which half was actually run.
-- Here, a half exists iff its row exists.
--
--   reports                    1 row  per scan          (always)
--   report_label_checks        0..1   per scan          (kind label/both)
--   report_damage_checks       0..1   per scan          (kind damage/both)
--   report_damage_detections   0..N   per damage check  (one per detection)
--
-- Children cascade on delete, so removing a report cleans up everything.
-- ═══════════════════════════════════════════════════════════════════

drop table if exists report_damage_detections cascade;
drop table if exists report_damage_checks     cascade;
drop table if exists report_label_checks      cascade;
drop table if exists reports                  cascade;

-- ── Core: one row per saved scan ────────────────────────────────────
create table reports (
  -- Client-generated ("<epoch_ms>_<name hash>") so a retried submit
  -- upserts instead of duplicating.
  id              text primary key,
  kind            text        not null,
  -- Which packaging the damage step ran against. Null for a label-only
  -- scan. Denormalised onto the parent (rather than living only on
  -- report_damage_checks) so the dashboard can sort and filter the list
  -- by packaging without a join.
  packaging_type  text,
  status          text        not null,
  -- The name the user saved the record under — NOT read off a label.
  product_name    text        not null default '',
  matched_keyword text        not null default '',
  reasons         text[]      not null default '{}',
  scanned_at      timestamptz,
  image_base64    text,
  created_at      timestamptz not null default now(),

  constraint reports_kind_check
    check (kind in ('label', 'damage', 'both')),
  constraint reports_packaging_type_check
    check (packaging_type is null or packaging_type in ('box', 'foil', 'bottle'))
);

-- ── Label half ──────────────────────────────────────────────────────
-- Exists for kind 'label' and 'both'. PK is the FK, enforcing 0..1.
create table report_label_checks (
  report_id             text primary key
                          references reports(id) on delete cascade,
  -- What OCR read off the front label, vs reports.product_name which is
  -- the user's own record name.
  detected_product_name text not null default '',
  expiration            text not null default '',
  ingredients           text not null default '',
  extracted_text        text not null default ''
);

-- ── Damage half ─────────────────────────────────────────────────────
-- Exists for kind 'damage' and 'both'.
--
-- `available` false means the check could not run at all — no model is
-- wired up for foil/bottle yet, or the box model failed to load. That is
-- distinct from available = true, is_damaged = false, which is a real
-- clean result. Keep them apart or "no damage found" counts get inflated
-- by scans that never ran.
create table report_damage_checks (
  report_id      text primary key
                   references reports(id) on delete cascade,
  packaging_type text,
  available      boolean not null default false,
  is_damaged     boolean not null default false,
  message        text    not null default '',
  -- Highest confidence across all packaging photos, 0..1.
  max_confidence real    not null default 0,

  constraint damage_packaging_type_check
    check (packaging_type is null or packaging_type in ('box', 'foil', 'bottle'))
);

-- ── Individual detections ───────────────────────────────────────────
-- One row per surviving detection, so 'Dent' twice and 'Scratches' once
-- is three rows. Lets the dashboard count occurrences per class instead
-- of just listing distinct names.
create table report_damage_detections (
  id              bigint generated always as identity primary key,
  report_id       text not null references reports(id) on delete cascade,
  -- Detector class name: 'Dent' or 'Scratches' today.
  detection_class text not null,
  -- Position in the detector's output, so ordering is reproducible.
  ordinal         integer not null default 0
);

-- ── Indexes ─────────────────────────────────────────────────────────
-- Sort/filter axes on the reports list.
create index reports_created_at_idx     on reports (created_at desc);
create index reports_scanned_at_idx     on reports (scanned_at desc);
create index reports_kind_idx           on reports (kind);
create index reports_packaging_type_idx on reports (packaging_type);
create index reports_status_idx         on reports (status);
create index reports_product_name_idx   on reports (product_name);

-- Child lookups by parent.
create index damage_detections_report_idx on report_damage_detections (report_id);
create index damage_detections_class_idx  on report_damage_detections (detection_class);

-- ── Row level security ──────────────────────────────────────────────
-- The dashboard reads through the API using the service_role key, which
-- bypasses RLS. Enabling it with no policies means nothing else can read
-- these tables — in particular the public anon key cannot.
alter table reports                  enable row level security;
alter table report_label_checks      enable row level security;
alter table report_damage_checks     enable row level security;
alter table report_damage_detections enable row level security;
