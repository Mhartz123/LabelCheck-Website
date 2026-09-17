-- ═══════════════════════════════════════════════════════════════════
-- CheckMuna — migration: packaging photos + detection geometry
-- Run in Supabase SQL Editor (Project → SQL Editor → New query).
--
-- Brings a database created by an earlier `supabase-schema.sql` up to
-- what api/report.js now writes:
--
--   • report_damage_images  — the packaging photos the detector ran on,
--                             so a damage record has previews at all
--   • report_damage_detections gains confidence + the rect on its source
--                             photo, so the dashboard can redraw the
--                             overlay the app showed
--
-- SAFE TO RE-RUN, and safe on a database holding data: everything below
-- is `if not exists`. Nothing is dropped. This is the file to use on a
-- live project — `supabase-schema.sql` still drops and recreates every
-- table and would wipe the dashboard.
--
-- Existing rows are untouched: their new columns come out null, which is
-- exactly the "no overlay available" case the dashboard already has to
-- handle for detectors that report classes without geometry.
-- ═══════════════════════════════════════════════════════════════════

-- ── The photos the damage step ran against ──────────────────────────
-- See supabase-schema.sql for the full rationale. In short: `ordinal` is
-- the photo's position in the list handed to the detector (BoxSlot order,
-- skipped slots omitted) and is what report_damage_detections.source_index
-- points at; `slot` names it for display. The primary key leads with
-- report_id, which is the only way these are ever looked up, so no separate
-- index is needed.
create table if not exists report_damage_images (
  report_id    text    not null references reports(id) on delete cascade,
  ordinal      integer not null,
  slot         text,
  image_base64 text    not null,

  primary key (report_id, ordinal)
);

-- Added separately from the table so re-running this file over a database
-- that already has the table is still a no-op rather than an error.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'damage_images_slot_check'
  ) then
    alter table report_damage_images
      add constraint damage_images_slot_check
      check (slot is null or slot in ('front', 'side1', 'side2', 'back'));
  end if;
end $$;

alter table report_damage_images enable row level security;

-- ── Geometry on each detection ──────────────────────────────────────
-- All nullable. Null means "no overlay available" for that detection —
-- which is NOT the same as no damage (that's report_damage_checks
-- .is_damaged = false). Rows written before this migration stay null.
alter table report_damage_detections
  add column if not exists confidence   real,
  add column if not exists source_index integer,
  add column if not exists box_left     real,
  add column if not exists box_top      real,
  add column if not exists box_width    real,
  add column if not exists box_height   real;
