-- Scoped settings: one value per (scope, key). campaign_id null = global.
-- A campaign sees its own value, else its parent's (the always-on base), else the global one, else the field's default.
-- Secrets are stored encrypted ({"enc": "<base64>"}); the key lives outside the database.
create table setting (
  campaign_id uuid references campaign(id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  secret      boolean not null default false,
  updated_at  timestamptz not null default now()
);
create unique index setting_scope_key_idx on setting (campaign_id, key) nulls not distinct;
