-- Own short links (docs/analytics.md, step 3): one row per link of a published entry, and one row per request of it. A click keeps
-- no address and no browser string, only salted hashes: `visitor` (address and browser) counts unique clicks, `source` (address
-- alone) caps how many visitors one address can add, so rotating the browser string does not inflate the count. Previews and
-- crawlers are kept apart (bot) and never counted.
create table short_link (
  id         text primary key,                       -- the random part of the code; the code adds a signature
  entry_id   text not null references content_calendar(id) on delete cascade,
  url        text not null,                          -- where it leads, with its UTM parameters
  created_at timestamptz not null default now(),
  unique (entry_id, url)
);
create table link_click (
  id      bigserial primary key,
  link_id text not null references short_link(id) on delete cascade,
  at      timestamptz not null default now(),
  visitor text not null,
  source  text not null,
  bot     boolean not null
);
create index link_click_link_idx on link_click (link_id, at);
