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
--   report_damage_images       0..N   per damage check  (one per packaging photo)
--   report_damage_detections   0..N   per damage check  (one per detection)
--
-- Children cascade on delete, so removing a report cleans up everything.
-- ═══════════════════════════════════════════════════════════════════

drop table if exists report_damage_detections cascade;
drop table if exists report_damage_images     cascade;
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
  -- COMPLIANT | NON-COMPLIANT | WARNING. Warning is an FDA advisory name
  -- match (formerly 'WARNING / BANNED'; lib/status.js folds that in).
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
  constraint reports_status_check
    check (status in ('COMPLIANT', 'NON-COMPLIANT', 'WARNING')),
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
-- loaded for that packaging type, it failed its load check, or inference
-- failed on every photo. That is
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

-- ── Packaging photos ────────────────────────────────────────────────
-- The four full-frame shots the damage step ran against. reports.image_base64
-- holds one cover photo for the whole record; these are the actual inputs to
-- the detector, and they are what report_damage_detections.source_index and
-- the dashboard's overlay refer to.
--
-- `ordinal` is the photo's position in the list the app fed the detector
-- (BoxSlot order, skipped slots omitted) — NOT the slot's own index. `slot`
-- carries the name separately so the dashboard can caption a photo "Side 1"
-- even when an earlier slot was never captured.
--
-- Stored inline as data URLs like reports.image_base64 rather than in
-- Supabase Storage: the app already posts base64 over one endpoint, and a
-- bucket would need its own credentials, lifecycle and signed-URL handling
-- for a payload the phone caps at a few hundred KB anyway.
-- No separate index on report_id: the primary key below leads with it, and
-- fetching one report's photos is the only query there is.
create table report_damage_images (
  report_id    text    not null references reports(id) on delete cascade,
  ordinal      integer not null,
  slot         text,
  -- 'data:image/jpeg;base64,...'
  image_base64 text    not null,

  primary key (report_id, ordinal),
  constraint damage_images_slot_check
    check (slot is null or slot in ('front', 'side1', 'side2', 'back'))
);

-- ── Individual detections ───────────────────────────────────────────
-- One row per surviving detection, so 'Structural deformation' twice and
-- 'Label aberration' once
-- is three rows. Lets the dashboard count occurrences per class instead
-- of just listing distinct names.
create table report_damage_detections (
  id              bigint generated always as identity primary key,
  report_id       text not null references reports(id) on delete cascade,
  -- Detector class name: 'Structural deformation' (box, foil) or
  -- 'Label aberration' (box, bottle). Early box records say 'Dent'/'Scratches'.
  detection_class text not null,
  -- Position in the detector's output, so ordering is reproducible.
  ordinal         integer not null default 0,

  -- ── Geometry, all nullable ─────────────────────────────────────────
  -- The app sends these as `damage.boxes`. They are null for records saved
  -- before boxes were captured, and for any future detector that reports
  -- classes without geometry. Null means "no overlay available" — never
  -- "no damage", which is report_damage_checks.is_damaged = false.
  --
  -- This detection's own confidence, 0..1. Distinct from
  -- report_damage_checks.max_confidence, which is the peak across the
  -- whole scan: a 91% dent and a 54% scratch are two rows here and one
  -- 0.91 there.
  confidence      real,
  -- Which packaging photo this was found on: report_damage_images.ordinal.
  -- Not a foreign key — a report may carry boxes whose photos were too
  -- large to upload, and losing the geometry with them would be worse than
  -- an index that points at nothing.
  source_index    integer,
  -- Rect on that photo, normalised 0..1 with EXIF orientation already
  -- baked in, so an overlay lines up at any display size and survives the
  -- photo being resized. Named box_* because `left` is reserved in SQL.
  box_left        real,
  box_top         real,
  box_width       real,
  box_height      real
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
alter table report_damage_images     enable row level security;
alter table report_damage_detections enable row level security;
