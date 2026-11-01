-- Learnings: what the system knows works, and the history that feeds it (docs/analytics.md, phase 1).
-- E1 (experiment verdicts) and E2 (patterns over many entries) are written by code only; agents may add E3 observations and
-- propose reviewer preferences, which a person confirms. Nothing is deleted: a newer learning supersedes an older one.
create table learning (
  id            text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  campaign_id   uuid not null references campaign(id) on delete cascade,  -- the owner: the always-on base for scope brand
  scope         text not null check (scope in ('campaign', 'brand')),
  kind          text not null check (kind in ('performance', 'null_result', 'reviewer_preference')),
  evidence      text check (evidence in ('E1', 'E2', 'E3')),                -- null for reviewer preferences
  result        text check (result in ('better', 'worse', 'unsafe', 'no_difference')),  -- of `lever.to` against `lever.from`
  statement     text not null,
  channel       text,
  lever         jsonb,           -- {"attribute": "subject_style", "from": "plain", "to": "number"}
  metric        text,
  effect        numeric,         -- relative effect of `to` against `from` (0.38 = +38 %)
  ci_low        numeric,
  ci_high       numeric,
  n_per_arm     int,
  mde           numeric,         -- the smallest lift the test could show (null results)
  method        text,
  context       jsonb not null default '{}',
  experiment_id text references experiment(id) on delete set null,
  source_ids    text[] not null default '{}',   -- promoted from these learnings, or a preference drawn from these entries
  status        text not null default 'active' check (status in ('proposed', 'active', 'superseded', 'retired')),
  superseded_by text references learning(id) on delete set null,
  created_by    text not null,
  confirmed_by  text,
  decided_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index learning_campaign_idx on learning (campaign_id, status);
create unique index learning_experiment_idx on learning (experiment_id) where experiment_id is not null;

-- What an agent was told before it wrote an entry; reproducible, holds aggregates only.
create table brief (
  id          text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  campaign_id uuid not null references campaign(id) on delete cascade,
  channel     text,
  slot        text not null check (slot in ('exploit', 'explore')),
  payload     jsonb not null,
  created_by  text not null default 'unknown',
  created_at  timestamptz not null default now()
);
alter table content_calendar add column brief_id text references brief(id) on delete set null;

-- Which learnings an entry applied or tests; the outcome is filled once the entry has matured.
create table learning_application (
  learning_id text not null references learning(id) on delete cascade,
  entry_id    text not null references content_calendar(id) on delete cascade,
  mode        text not null check (mode in ('exploit', 'explore', 'test')),
  outcome     jsonb,
  at          timestamptz not null default now(),
  primary key (learning_id, entry_id)
);
create index learning_application_entry_idx on learning_application (entry_id);

-- Review history: every action on an entry, so a send-back note is never lost and production can be measured.
create table entry_event (
  id          bigserial primary key,
  entry_id    text not null references content_calendar(id) on delete cascade,
  kind        text not null check (kind in ('created', 'edited', 'approved', 'changes_requested', 'unapproved', 'cancelled', 'published', 'failed', 'needs_manual')),
  actor       text not null default 'unknown',   -- ui, cli, an agent label, auto, scheduler (not verified)
  from_status text,
  to_status   text,
  note        text,
  reason      text check (reason in ('claims', 'facts', 'tone', 'brand', 'visual', 'legal', 'typo', 'offer', 'other')),
  data        jsonb,
  at          timestamptz not null default now()
);
create index entry_event_entry_idx on entry_event (entry_id, at);
create index entry_event_kind_idx on entry_event (kind, at);
alter table content_calendar add column approved_at timestamptz;
alter table content_calendar add column approved_by text;

-- Attributes of an entry (format, hook, subject style...): derived by code where possible, otherwise set by an agent or a person.
-- Learnings over many entries are mined from these.
create table entry_attribute (
  entry_id text not null references content_calendar(id) on delete cascade,
  key      text not null,
  value    text not null,
  source   text not null check (source in ('derived', 'agent', 'human')),
  primary key (entry_id, key)
);
create index entry_attribute_kv_idx on entry_attribute (key, value);

-- The one variable an experiment changes; learnings and the re-test gate key on it.
alter table experiment add column lever jsonb;
