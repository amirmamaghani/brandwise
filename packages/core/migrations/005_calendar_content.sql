-- Calendar entries carry what is actually published (text, link) and the reviewer's note.
-- changes_requested = a human sent it back to the agent with a note; any edit resubmits it.
alter table content_calendar add column body text not null default '';
alter table content_calendar add column link text;
alter table content_calendar add column review_note text;
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
  ('draft','pending_approval','changes_requested','approved','scheduled','published','failed','cancelled'));
