-- E-mail: one row per campaign we hand to a provider (email_send) and the events that come back (email_event).
-- Statistics hang on email_send (our id, the calendar entry), never on the provider's ids, so a provider can be swapped.
create table email_send (
  id           uuid primary key default gen_random_uuid(),
  entry_id     text not null references content_calendar(id),
  provider     text not null,
  external_id  text not null,
  capabilities jsonb not null,
  created_at   timestamptz not null default now(),
  unique (provider, external_id),
  unique (entry_id)
);
create table email_event (
  id                bigserial primary key,
  provider          text not null,
  provider_event_id text not null,
  send_id           uuid references email_send(id),
  ref_external_id   text,
  type              text not null,
  at                timestamptz not null,
  recipient_hash    text not null,
  recipient_domain  text not null,
  detail            jsonb not null default '{}',
  raw               jsonb,
  schema_version    int not null default 1,
  received_at       timestamptz not null default now(),
  unique (provider, provider_event_id)
);
create index email_event_send_idx on email_event (send_id, type);
create index email_event_unlinked_idx on email_event (provider, ref_external_id) where send_id is null;
