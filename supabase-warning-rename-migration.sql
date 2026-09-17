-- ═══════════════════════════════════════════════════════════════════
-- CheckMuna — migration: Banned → Warning
-- Run in Supabase SQL Editor (Project → SQL Editor → New query).
--
-- The app renamed its advisory verdict. New scans upload status 'WARNING';
-- rows saved before the rename say 'WARNING / BANNED'. The API already
-- folds both into 'WARNING' when it reads, so this is housekeeping: it makes
-- the stored data match, and adds a check so nothing else creeps in.
--
-- SAFE TO RE-RUN, and safe on a database holding data. Nothing is dropped.
-- ═══════════════════════════════════════════════════════════════════

update reports
   set status = 'WARNING'
 where status in ('WARNING / BANNED', 'BANNED');

-- The API used to store whatever string it was sent. Anything that is not
-- one of the three verdicts is read as NON-COMPLIANT, so store it that way.
update reports
   set status = 'NON-COMPLIANT'
 where status not in ('COMPLIANT', 'NON-COMPLIANT', 'WARNING');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reports_status_check'
  ) then
    alter table reports
      add constraint reports_status_check
      check (status in ('COMPLIANT', 'NON-COMPLIANT', 'WARNING'));
  end if;
end $$;
