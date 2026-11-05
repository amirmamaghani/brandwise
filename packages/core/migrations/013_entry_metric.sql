-- Numbers of calendar entries from sources that only report current totals (platform APIs): each pull stores a snapshot of the
-- running total, so history builds up and a report can be made "as of" any moment (docs/analytics.md, step 2). Sources with their own
-- event history (e-mail) are read live and store nothing here. Rows are only added; a repeated pull at the same moment is a no-op.
create table entry_metric (
  source      text not null,                 -- the source's id: email, links, ga4, ...
  entry_id    text not null references content_calendar(id) on delete cascade,
  metric      text not null,                 -- from the fixed vocabulary in src/metrics/domain.ts
  value       numeric not null,
  observed_at timestamptz not null,          -- when the source said so
  started_at  timestamptz,                   -- when the entry reached its audience, if the source knows
  primary key (source, entry_id, metric, observed_at)
);
create index entry_metric_entry_idx on entry_metric (entry_id, observed_at);
