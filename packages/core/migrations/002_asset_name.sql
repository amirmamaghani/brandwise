-- Human-readable name so assets can be renamed in the UI (storage_key stays content-addressed).
alter table asset add column name text;
update asset set name = regexp_replace(storage_key, '^.*/', '') where name is null;
alter table asset alter column name set not null;
