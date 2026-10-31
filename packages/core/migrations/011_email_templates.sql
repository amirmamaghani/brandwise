-- E-mail template production: brand kits and components per client (inherited down the campaign tree), immutable published template
-- versions, render snapshots (exactly what was approved and sent), and the binding of a calendar entry to a template version and content.
create table email_brand_kit (
  campaign_id uuid primary key references campaign(id) on delete cascade,
  brand       jsonb not null,
  version     int not null default 1,
  updated_at  timestamptz not null default now()
);
create table email_component (
  campaign_id uuid not null references campaign(id) on delete cascade,
  name        text not null check (name ~ '^[a-z][a-z0-9_]{1,31}$'),
  mjml        text not null,
  updated_at  timestamptz not null default now(),
  primary key (campaign_id, name)
);
-- A published version never changes: the files, the resolved brand kit and the components as they were at publish time.
create table email_template_version (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaign(id) on delete cascade,
  template_id text not null,
  version     int not null,
  files       jsonb not null,            -- {mjml, config, brand, sample, partials}
  hash        text not null,
  note        text,
  created_by  text not null default 'unknown',
  created_at  timestamptz not null default now(),
  unique (campaign_id, template_id, version)
);
-- A render snapshot is content-addressed: the same inputs are stored once.
create table email_render (
  id                  uuid primary key default gen_random_uuid(),
  hash                text not null unique,
  template_version_id uuid references email_template_version(id),
  locale              text not null default 'en',
  target              text not null,
  subject             text not null,
  preheader           text not null default '',
  html                text not null,
  text                text not null default '',
  size                int not null,
  findings            jsonb not null default '[]',
  created_at          timestamptz not null default now()
);
create table email_entry (
  entry_id            text primary key references content_calendar(id),
  template_version_id uuid not null references email_template_version(id),
  locale              text not null default 'en',
  content             jsonb not null,
  render_id           uuid not null references email_render(id),
  updated_at          timestamptz not null default now()
);
alter table email_send add column render_id uuid references email_render(id);
