-- project -> campaign. "project" is bb's word for a repository; the marketing entity is a campaign.
-- Kinds: brand and product become always_on (the evergreen baseline, no end date); time-bound ones stay campaign.
alter table project rename to campaign;
alter table asset rename column project_id to campaign_id;
alter table content_calendar rename column project_id to campaign_id;

-- keep constraint and index names in step with the new names
do $$
declare r record;
begin
  for r in
    select conrelid::regclass::text as tbl, conname from pg_constraint
    where conrelid in ('campaign'::regclass, 'asset'::regclass, 'content_calendar'::regclass) and conname like '%project%'
  loop
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, replace(r.conname, 'project', 'campaign'));
  end loop;
  for r in select indexname from pg_indexes where schemaname = current_schema() and indexname like '%project%' loop
    execute format('alter index %I rename to %I', r.indexname, replace(r.indexname, 'project', 'campaign'));
  end loop;
end $$;

alter table campaign drop constraint campaign_kind_check;
update campaign set kind = 'always_on' where kind in ('brand', 'product');
alter table campaign add constraint campaign_kind_check check (kind in ('always_on', 'campaign'));
