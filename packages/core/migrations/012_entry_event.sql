-- Review history: every action on a calendar entry, so a send-back note is never lost and an approval says who and when
-- (docs/analytics.md, D4). Rows are only ever added; they go with the entry when it is deleted. "if not exists": databases that ran
-- the earlier feat/analytics branch already have the table.
create table if not exists entry_event (
  id          bigserial primary key,
  entry_id    text not null references content_calendar(id) on delete cascade,
  kind        text not null check (kind in ('created', 'edited', 'approved', 'changes_requested', 'unapproved', 'cancelled', 'published', 'failed', 'needs_manual')),
  actor       text not null default 'unknown',   -- ui, cli, cli:<label>, auto, scheduler (a label, not a verified identity)
  from_status text,
  to_status   text,
  note        text,
  reason      text check (reason in ('claims', 'facts', 'tone', 'brand', 'visual', 'legal', 'typo', 'offer', 'other')),
  data        jsonb,
  at          timestamptz not null default now()
);
create index if not exists entry_event_entry_idx on entry_event (entry_id, at);
create index if not exists entry_event_kind_idx on entry_event (kind, at);
alter table content_calendar add column if not exists approved_at timestamptz;
alter table content_calendar add column if not exists approved_by text;
