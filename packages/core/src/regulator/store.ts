// Postgres storage of the regulator: goals, state, experiments, journal, tasks, development clock.
import type pg from "pg";
import type { Lever } from "../learnings/domain.ts";
import type { Goal, GoalMetric } from "./signals.ts";

export type State = { frozen: boolean; frozenReason: string | null; incumbentEntryId: string | null; lastAdoptedAt: string | null };
export type ExperimentRow = {
  id: string; campaignId: string; hypothesis: string; lever: Lever | null; metric: string; armA: string; armB: string; status: "running" | "concluded";
  verdict: "A" | "B" | "inconclusive" | "freeze" | null; result: unknown; createdBy: string; createdAt: string; concludedAt: string | null;
  /** Registration: what the editor expects and what the planned sample can show, fixed before the first send. */
  expectedLift: number | null; plannedRounds: number; plannedPerArm: number | null; mde: number | null;
  /** Round 1 is armA/armB; a series adds rounds with the same change. */
  rounds: { round: number; armA: string; armB: string }[];
};
export type JournalRow = { id: number; campaignId: string; kind: "run" | "learning" | "note"; author: string; body: string; data: unknown; at: string };
export type TaskRow = { id: string; campaignId: string; kind: string; brief: string; params: Record<string, unknown>; status: "open" | "claimed" | "done" | "cancelled"; claimedBy: string | null; result: unknown; createdBy: string; createdAt: string };

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const experimentFrom = (r: any, rounds: ExperimentRow["rounds"] = []): ExperimentRow => ({
  id: r.id, campaignId: r.campaign_id, hypothesis: r.hypothesis, lever: r.lever ?? null, metric: r.metric, armA: r.arm_a_entry, armB: r.arm_b_entry,
  status: r.status, verdict: r.verdict, result: r.result, createdBy: r.created_by, createdAt: iso(r.created_at)!, concludedAt: iso(r.concluded_at),
  expectedLift: num(r.expected_lift), plannedRounds: Number(r.planned_rounds ?? 1), plannedPerArm: num(r.planned_per_arm), mde: num(r.mde),
  rounds: rounds.length ? rounds : [{ round: 1, armA: r.arm_a_entry, armB: r.arm_b_entry }],
});
const taskFrom = (r: any): TaskRow => ({ id: r.id, campaignId: r.campaign_id, kind: r.kind, brief: r.brief, params: r.params, status: r.status, claimedBy: r.claimed_by, result: r.result, createdBy: r.created_by, createdAt: iso(r.created_at)! });

export function regulatorStore(pool: pg.Pool) {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  return {
    async goals(campaignId: string): Promise<Goal[]> {
      return (await q("select metric, kind, value from campaign_goal where campaign_id = $1 order by metric", [campaignId])).map((r: any) => ({ metric: r.metric as GoalMetric, kind: r.kind, value: Number(r.value) }));
    },
    async setGoal(campaignId: string, g: Goal) {
      await q("insert into campaign_goal (campaign_id, metric, kind, value) values ($1,$2,$3,$4) on conflict (campaign_id, metric) do update set kind = excluded.kind, value = excluded.value, updated_at = now()", [campaignId, g.metric, g.kind, g.value]);
    },
    async state(campaignId: string): Promise<State> {
      const r = (await q("select * from regulator_state where campaign_id = $1", [campaignId]))[0];
      return r ? { frozen: r.frozen, frozenReason: r.frozen_reason, incumbentEntryId: r.incumbent_entry_id, lastAdoptedAt: iso(r.last_adopted_at) } : { frozen: false, frozenReason: null, incumbentEntryId: null, lastAdoptedAt: null };
    },
    async patchState(campaignId: string, p: Partial<State>) {
      const cur = await this.state(campaignId), n = { ...cur, ...p };
      await q(`insert into regulator_state (campaign_id, frozen, frozen_reason, incumbent_entry_id, last_adopted_at) values ($1,$2,$3,$4,$5)
               on conflict (campaign_id) do update set frozen = $2, frozen_reason = $3, incumbent_entry_id = $4, last_adopted_at = $5`,
        [campaignId, n.frozen, n.frozenReason, n.incumbentEntryId, n.lastAdoptedAt]);
    },
    async insertExperiment(e: { campaignId: string; hypothesis: string; lever: Lever; metric: string; armA: string; armB: string; createdBy: string; expectedLift?: number | null; plannedRounds?: number; plannedPerArm?: number | null; mde?: number | null; decisionRule?: unknown; guardrails?: unknown }): Promise<ExperimentRow> {
      const r = (await q(
        `insert into experiment (campaign_id, hypothesis, lever, metric, arm_a_entry, arm_b_entry, status, created_by, expected_lift, planned_rounds, planned_per_arm, mde, decision_rule, guardrails)
         values ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10,$11,coalesce($12::jsonb, '{"method": "frequentist", "alpha": 0.05, "minRelativeLift": 0.1}'::jsonb),$13) returning *`,
        [e.campaignId, e.hypothesis, e.lever, e.metric, e.armA, e.armB, e.createdBy, e.expectedLift ?? null, e.plannedRounds ?? 1, e.plannedPerArm ?? null, e.mde ?? null,
         e.decisionRule === undefined ? null : JSON.stringify(e.decisionRule), e.guardrails === undefined ? null : JSON.stringify(e.guardrails)],
      ))[0];
      await this.addRound(r.id, 1, e.armA, e.armB);
      return (await this.experiment(r.id))!;
    },
    /** Attach a pair of entries as a round; the entries learn their experiment and variant (the approval card shows it). */
    async addRound(id: string, round: number, armA: string, armB: string) {
      await q("insert into experiment_round (experiment_id, round, arm_a_entry, arm_b_entry) values ($1,$2,$3,$4)", [id, round, armA, armB]);
      await q("update content_calendar set experiment_id = $1, variant = case when id = $2 then 'A' else 'B' end where id = any(array[$2, $3]::text[])", [id, armA, armB]);
    },
    async experiment(id: string): Promise<ExperimentRow | null> {
      const r = (await q("select * from experiment where id = $1", [id]))[0];
      return r ? experimentFrom(r, await this.rounds(id)) : null;
    },
    async rounds(id: string): Promise<ExperimentRow["rounds"]> {
      return (await q("select round, arm_a_entry, arm_b_entry from experiment_round where experiment_id = $1 order by round", [id])).map((r: any) => ({ round: r.round, armA: r.arm_a_entry, armB: r.arm_b_entry }));
    },
    async experiments(campaignId: string, status?: string): Promise<ExperimentRow[]> {
      const rows = await q("select * from experiment where campaign_id = $1 and ($2::text is null or status = $2) order by created_at desc", [campaignId, status ?? null]);
      return Promise.all(rows.map(async (r: any) => experimentFrom(r, await this.rounds(r.id))));
    },
    async usedArms(): Promise<Set<string>> {
      return new Set((await q("select arm_a_entry as a, arm_b_entry as b from experiment_round union all select arm_a_entry, arm_b_entry from experiment")).flatMap((r: any) => [r.a, r.b]));
    },
    async conclude(id: string, verdict: string, result: unknown, at: string) {
      await q("update experiment set status = 'concluded', verdict = $2, result = $3, concluded_at = $4 where id = $1 and status = 'running'", [id, verdict, result, at]);
    },
    async journalWrite(campaignId: string, kind: JournalRow["kind"], author: string, body: string, data?: unknown): Promise<void> {
      await q("insert into journal (campaign_id, kind, author, body, data) values ($1,$2,$3,$4,$5)", [campaignId, kind, author, body, data ?? null]);
    },
    async journal(campaignId: string, limit: number, kind?: string): Promise<JournalRow[]> {
      return (await q("select * from journal where campaign_id = $1 and ($3::text is null or kind = $3) order by id desc limit $2", [campaignId, limit, kind ?? null]))
        .map((r: any): JournalRow => ({ id: Number(r.id), campaignId: r.campaign_id, kind: r.kind, author: r.author, body: r.body, data: r.data, at: iso(r.at)! }));
    },
    async taskInsert(t: { campaignId: string; kind: string; brief: string; params: Record<string, unknown>; createdBy: string }): Promise<TaskRow> {
      return taskFrom((await q("insert into task (campaign_id, kind, brief, params, created_by) values ($1,$2,$3,$4,$5) returning *", [t.campaignId, t.kind, t.brief, t.params, t.createdBy]))[0]);
    },
    async tasks(campaignId: string, status?: string): Promise<TaskRow[]> {
      return (await q("select * from task where campaign_id = $1 and ($2::text is null or status = $2) order by created_at", [campaignId, status ?? null])).map(taskFrom);
    },
    async task(id: string): Promise<TaskRow | null> {
      const r = (await q("select * from task where id = $1", [id]))[0];
      return r ? taskFrom(r) : null;
    },
    /** Claim only while open: two workers never get the same task. */
    async taskClaim(id: string, by: string): Promise<TaskRow | null> {
      const r = (await q("update task set status = 'claimed', claimed_by = $2, updated_at = now() where id = $1 and status = 'open' returning *", [id, by]))[0];
      return r ? taskFrom(r) : null;
    },
    async taskFinish(id: string, status: "done" | "cancelled", result: unknown): Promise<TaskRow | null> {
      const r = (await q("update task set status = $2, result = $3, updated_at = now() where id = $1 and status in ('open', 'claimed') returning *", [id, status, result ?? null]))[0];
      return r ? taskFrom(r) : null;
    },
    async clockOffset(): Promise<number> {
      return Number((await q("select offset_seconds from sim_clock where id = 1"))[0]?.offset_seconds ?? 0);
    },
    async setClockOffset(seconds: number) {
      await q("update sim_clock set offset_seconds = $1 where id = 1", [seconds]);
    },
  };
}
export type RegulatorStore = ReturnType<typeof regulatorStore>;
