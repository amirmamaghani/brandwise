-- Where a campaign publishes on a channel (e.g. telegram: {"chatId": "@mychannel"}). A campaign without its own row uses its
-- parent's (an always-on base sets the default, a campaign overrides it).
create table campaign_channel (
  campaign_id uuid not null references campaign(id) on delete cascade,
  channel     text not null,
  config      jsonb not null default '{}',
  primary key (campaign_id, channel)
);
