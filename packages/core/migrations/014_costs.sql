-- Costs and the brand's economics (docs/analytics.md, phase 3).
-- The ledger keeps what was used in its own unit (credits, money); money for units is applied when a report is made, from the
-- economics profile valid at that time, so a price change needs no re-allocation. Review minutes and e-mail sends are not copied
-- here: reports read them from entry_event and email_event.
create table cost_entry (
  id           bigserial primary key,
  campaign_id  uuid not null references campaign(id) on delete cascade,
  entry_id     text references content_calendar(id) on delete set null,
  asset_id     uuid references asset(id) on delete set null,
  kind         text not null check (kind in ('media', 'gen', 'llm', 'incentive', 'tool', 'sales')),
  units        numeric not null,      -- in `unit`
  unit         text not null,         -- credits, money, tokens
  amount       numeric,               -- money, when the source states it (media spend, an invoice)
  format       text,                  -- what was produced: image/<model>, video/<model>
  status       text,                  -- generations: started, done, failed
  source       text not null,         -- higgsfield, manual, ...
  source_ref   text not null,         -- idempotency: the provider's job id, an invoice number
  note         text,
  created_by   text not null default 'unknown',
  at           timestamptz not null default now(),
  unique (source, source_ref)
);
create index cost_entry_campaign_idx on cost_entry (campaign_id, kind, at);
create index cost_entry_asset_idx on cost_entry (asset_id) where asset_id is not null;

-- The brand's economics, set by a person, with history: a report "as of" a date uses the version valid then.
create table economics_profile (
  id          bigserial primary key,
  campaign_id uuid not null references campaign(id) on delete cascade,   -- the always-on base; its campaigns inherit it
  valid_from  timestamptz not null default now(),
  profile     jsonb not null,
  set_by      text not null,
  unique (campaign_id, valid_from)
);
