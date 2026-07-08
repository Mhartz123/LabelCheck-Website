-- LabelCheck reports table — flattened schema
-- Run this in Supabase SQL Editor (Project → SQL Editor → New query)

-- ═══════════════════════════════════════════════════════════════════
-- STEP 1: If the old JSONB `data` column exists, migrate it first.
-- ═══════════════════════════════════════════════════════════════════
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'reports' and column_name = 'data'
  ) then
    -- Add new columns
    alter table reports add column if not exists product_name    text not null default '';
    alter table reports add column if not exists matched_keyword text not null default '';
    alter table reports add column if not exists reasons         text[] not null default '{}';
    alter table reports add column if not exists brand           text not null default '';
    alter table reports add column if not exists expiration      text not null default '';
    alter table reports add column if not exists ingredients     text not null default '';
    alter table reports add column if not exists extracted_text  text not null default '';
    alter table reports add column if not exists scanned_at      timestamptz;
    alter table reports add column if not exists image_base64    text;

    -- Backfill from the JSONB blob
    update reports set
      product_name    = coalesce(data->>'productName', ''),
      matched_keyword = coalesce(data->>'matchedKeyword', ''),
      reasons         = coalesce(
        (select array_agg(elem::text) from jsonb_array_elements_text(data->'reasons') as elem),
        '{}'
      ),
      brand           = coalesce(data->>'brand', ''),
      expiration      = coalesce(data->>'expiration', ''),
      ingredients     = coalesce(data->>'ingredients', ''),
      extracted_text  = coalesce(data->>'extractedText', ''),
      scanned_at      = (data->>'scannedAt')::timestamptz,
      image_base64    = data->>'imageBase64'
    where data is not null;

    -- Drop the old JSONB column
    alter table reports drop column data;

    raise notice 'Migration complete — JSONB data column dropped, columns backfilled.';
  else
    raise notice 'No migration needed — data column does not exist.';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 2: Create indexes (columns now guaranteed to exist).
-- ═══════════════════════════════════════════════════════════════════
create index if not exists reports_created_at_idx on reports (created_at desc);
create index if not exists reports_status_idx on reports (status);
create index if not exists reports_product_name_idx on reports (product_name);

alter table reports enable row level security;
