-- The editor-in-chief regulator: goals (setpoints and limits), experiments, a journal, tasks for other agents, and a development clock.
-- Goals are set by people; the regulator agent only reads them. Experiments are concluded by code (rails), never by the agent.
create table campaign_goal (
  campaign_id uuid not null references campaign(id) on delete cascade,
  metric      text not null,
  kind        text not null check (kind in ('target', 'limit')),   -- target: want at least this; limit: must stay at or below
  value       numeric not null,
  updated_at  timestamptz not null default now(),
  primary key (campaign_id, metric)
);
create table regulator_state (
  campaign_id         uuid primary key references campaign(id) on delete cascade,
  frozen              boolean not null default false,              -- set by the rails when a guard is broken; only a person clears it
  frozen_reason       text,
  incumbent_entry_id  text references content_calendar(id),       -- the variant currently considered best
  last_adopted_at     timestamptz
);
create table experiment (
  id            text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  campaign_id   uuid not null references campaign(id) on delete cascade,
  hypothesis    text not null,
  metric        text not null,
  arm_a_entry   text not null references content_calendar(id),    -- control (the incumbent)
  arm_b_entry   text not null references content_calendar(id),    -- challenger
  status        text not null check (status in ('running', 'concluded')),
  verdict       text check (verdict in ('A', 'B', 'inconclusive', 'freeze')),
  result        jsonb,
  created_by    text not null default 'unknown',
  created_at    timestamptz not null default now(),
  concluded_at  timestamptz
);
create index experiment_campaign_idx on experiment (campaign_id, status);
create table journal (
  id          bigserial primary key,
  campaign_id uuid not null references campaign(id) on delete cascade,
  kind        text not null check (kind in ('run', 'learning', 'note')),
  author      text not null default 'unknown',
  body        text not null,
  data        jsonb,
  at          timestamptz not null default now()
);
create index journal_campaign_idx on journal (campaign_id, id desc);
create table task (
  id          text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  campaign_id uuid not null references campaign(id) on delete cascade,
  kind        text not null,
  brief       text not null,
  params      jsonb not null default '{}',
  status      text not null check (status in ('open', 'claimed', 'done', 'cancelled')) default 'open',
  claimed_by  text,
  result      jsonb,
  created_by  text not null default 'unknown',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index task_status_idx on task (campaign_id, status);
-- Development only: an offset added to the real time, so a simulated provider and the regulator can live days in minutes.
create table sim_clock (
  id             int primary key check (id = 1),
  offset_seconds bigint not null default 0
);
insert into sim_clock (id, offset_seconds) values (1, 0);
