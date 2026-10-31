-- Publishing state: run-due claims approved entries whose time has come, a connector publishes them.
-- publishing = claimed by a run (reclaimed when the run dies), needs_manual = no connector for the channel.
alter table content_calendar add column attempts int not null default 0;
alter table content_calendar add column next_attempt_at timestamptz;
alter table content_calendar add column claimed_at timestamptz;
alter table content_calendar add column external_id text;
alter table content_calendar add column external_url text;
alter table content_calendar add column error text;
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'content_calendar'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table content_calendar drop constraint %I', c);
  end loop;
end $$;
alter table content_calendar add constraint content_calendar_status_check check (status in
  ('draft','pending_approval','changes_requested','approved','scheduled','publishing','published','needs_manual','failed','cancelled'));
