-- Projects, assets, content calendar. See docs/assets.md and docs/architecture.md.
-- shortcut: no RLS yet. root_id is the tenant boundary to enforce it on once there is more than one customer.

create table project (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references project(id),
  root_id    uuid not null,
  name       text not null,
  kind       text not null check (kind in ('brand','product','campaign')),
  starts_at  date,
  ends_at    date,
  status     text not null default 'active',
  created_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);
create index project_root_idx on project (root_id);

create table asset (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  kind         text not null check (kind in ('image','video','audio','document','font')),
  role         text not null check (role in ('source','creative','brand','reference')),
  origin       text not null check (origin in ('generated','uploaded','imported')),
  storage_key  text not null,
  sha256       text not null,
  mime         text not null,
  bytes        bigint not null,
  width        int,
  height       int,
  duration_ms  int,
  status       text not null default 'draft' check (status in ('draft','linted','approved','published','archived')),
  ai_generated boolean not null default false,
  rights       jsonb,
  provenance   jsonb,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  unique (project_id, sha256)
);

create table asset_link (
  parent_id uuid not null references asset(id),
  child_id  uuid not null references asset(id),
  relation  text not null check (relation in ('derived_from','rendered_with','used_in')),
  primary key (parent_id, child_id, relation)
);

create table content_calendar (
  id           text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  project_id   uuid not null references project(id),
  title        text not null,
  channel      text not null,
  scheduled_at timestamptz not null,
  tier         smallint not null check (tier in (1,2,3)),
  status       text not null check (status in
                 ('draft','pending_approval','approved','scheduled','published','failed','cancelled')),
  asset_id     uuid references asset(id),
  created_by   text not null default 'unknown',
  created_at   timestamptz not null default now()
);
create index content_calendar_due_idx on content_calendar (status, scheduled_at);
