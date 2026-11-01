-- Experiments that can conclude on small lists (docs/analytics.md, phase 2): registered before launch with the expected lift, the
-- planned rounds and the detectable lift at that size; one hypothesis pooled over several sends (rounds); arm entries know their
-- experiment, so the reviewer sees it on the approval card.
alter table experiment add column expected_lift numeric;
alter table experiment add column planned_rounds int not null default 1 check (planned_rounds between 1 and 20);
alter table experiment add column planned_per_arm int;          -- delivered per arm and round expected at registration
alter table experiment add column mde numeric;                  -- the lift the planned sample can show, recorded at registration
alter table experiment add column decision_rule jsonb not null default '{"method": "frequentist", "alpha": 0.05, "minRelativeLift": 0.1}';
alter table experiment add column guardrails jsonb;             -- the rails' guards in force at registration

create table experiment_round (
  experiment_id text not null references experiment(id) on delete cascade,
  round         int not null check (round >= 1),
  arm_a_entry   text not null references content_calendar(id),
  arm_b_entry   text not null references content_calendar(id),
  created_at    timestamptz not null default now(),
  primary key (experiment_id, round)
);
-- round 1 of every experiment so far is its arm pair
insert into experiment_round (experiment_id, round, arm_a_entry, arm_b_entry, created_at)
  select id, 1, arm_a_entry, arm_b_entry, created_at from experiment;

alter table content_calendar add column experiment_id text references experiment(id) on delete set null;
alter table content_calendar add column variant text check (variant in ('A', 'B'));
update content_calendar c set experiment_id = r.experiment_id, variant = 'A' from experiment_round r where r.arm_a_entry = c.id;
update content_calendar c set experiment_id = r.experiment_id, variant = 'B' from experiment_round r where r.arm_b_entry = c.id;
