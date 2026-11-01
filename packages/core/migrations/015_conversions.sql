-- Leads and orders (docs/analytics.md, phase 4): conversions from a site, a CRM or a shop, keyed to the calendar entry that brought
-- them (utm_content or bw), with their status history, so cost per lead and per qualified lead can be counted and an experiment can
-- reject a variant that wins on clicks and loses on leads. Customers are stored as salted hashes only.

-- Installation-wide values that must survive with the database (the recipient-hash salt: losing it would change every hash).
create table installation (
  key   text primary key,
  value text not null
);

create table conversion_source (
  id            text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  root_id       uuid not null references campaign(id),          -- the brand (always-on base) the conversions belong to
  name          text not null,
  adapter       text not null check (adapter in ('generic', 'csv', 'sim')),
  secret_sealed text,                                             -- the webhook signing secret, sealed with the plugin's encryption key
  created_by    text not null,
  created_at    timestamptz not null default now()
);

create table conversion (
  id            bigserial primary key,
  source_id     text not null references conversion_source(id),
  external_id   text not null,
  kind          text not null check (kind in ('lead', 'order')),
  status        text not null,
  occurred_at   timestamptz not null,
  root_id       uuid not null references campaign(id),
  entry_id      text references content_calendar(id) on delete set null,   -- last click: utm_content or bw of the visit
  campaign_id   uuid references campaign(id) on delete set null,          -- the entry's campaign, or the promo code's
  customer_hash text,
  value         numeric,
  currency      text,
  utm           jsonb,
  promo_code    text,
  self_report   text,
  raw           jsonb,                                                      -- without personal data
  version       int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source_id, external_id)
);
create index conversion_entry_idx on conversion (entry_id) where entry_id is not null;
create index conversion_root_idx on conversion (root_id, occurred_at);

create table conversion_status_event (
  source_id   text not null,
  external_id text not null,
  status      text not null,
  at          timestamptz not null,
  primary key (source_id, external_id, status)
);

-- A promo code belongs to a campaign: a conversion that names it is attributed there (one model of the range).
create table promo_code (
  code        text primary key,
  campaign_id uuid not null references campaign(id) on delete cascade
);
