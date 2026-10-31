-- A time-bound campaign always lives under an always-on base (it inherits that base's look).
alter table campaign add constraint campaign_parent_check check (kind = 'always_on' or parent_id is not null);
