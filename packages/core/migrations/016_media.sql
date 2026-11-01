-- Paid media (docs/analytics.md, phase 5): an ad buy, a boost or a budget change is a calendar entry on channel "ads" at tier 3, with
-- its order here. Limits are checked when the order is made and again right before money moves; the payment token never leaves the
-- connector's memory, only its reference is kept. Platform reports land as metric points; spend lands in the cost ledger.
create table media_order (
  entry_id     text primary key references content_calendar(id) on delete cascade,
  action       text not null check (action in ('media_buy', 'boost', 'budget_change')),
  budget       numeric not null check (budget >= 0),
  currency     text not null,
  days         int not null check (days between 1 and 90),
  objective    text not null default 'traffic',
  boost_of     text references content_calendar(id),            -- the published post a boost promotes
  order_of     text references media_order(entry_id),           -- the order a budget change changes
  platform     text,                                            -- the buyer adapter: the campaign's ads target when the order was made
  payment      text,                                            -- the payment method of that target (what the person approved)
  prepaid      boolean not null default false,                  -- the account is prepaid or invoiced: no payment step
  external_id  text,
  started_at   timestamptz,                                     -- when it went live: its days run from here
  payment_ref  text,                                            -- the payment's reference; the token itself is never stored
  status       text not null default 'draft' check (status in ('draft', 'live', 'paused', 'ended', 'refused')),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One narrow table for numbers from platforms (docs/roadmap.md §6): idempotent per source, entity, metric and time.
create table metric_point (
  source  text not null,           -- the platform adapter: mock-ads, meta-ads, ...
  entity  text not null,           -- calendar:<entry id>
  metric  text not null,           -- impressions, reach, clicks, spend, conversions
  at      timestamptz not null,    -- the day (UTC midnight) the value is for
  value   numeric not null,
  dims    jsonb not null default '{}',
  primary key (source, entity, metric, at)
);
