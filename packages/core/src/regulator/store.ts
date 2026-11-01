// Postgres storage of the regulator: goals, state, experiments, journal, tasks, development clock.
import type pg from "pg";
import type { Lever } from "../learnings/domain.ts";
import type { Goal, GoalMetric } from "./signals.ts";

export type State = { frozen: boolean; frozenReason: string | null; incumbentEntryId: string | null; lastAdoptedAt: string | null };
export type ExperimentRow = { id: string; campaignId: string; hypothesis: string; lever: Lever | null; metric: string; armA: string; armB: string; status: "running" | "concluded"; verdict: "A" | "B" | "inconclusive" | "freeze" | null; result: unknown; createdBy: string; createdAt: string; concludedAt: string | null };
export type JournalRow = { id: number; campaignId: string; kind: "run" | "learning" | "note"; author: string; body: string; data: unknown; at: string };
export type TaskRow = { id: string; campaignId: string; kind: string; brief: string; params: Record<string, unknown>; status: "open" | "claimed" | "done" | "cancelled"; claimedBy: string | null; result: unknown; createdBy: string; createdAt: string };

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const experimentFrom = (r: any): ExperimentRow => ({ id: r.id, campaignId: r.campaign_id, hypothesis: r.hypothesis, lever: r.lever ?? null, metric: r.metric, armA: r.arm_a_entry, armB: r.arm_b_entry, status: r.status, verdict: r.verdict, result: r.result, createdBy: r.created_by, createdAt: iso(r.created_at)!, concludedAt: iso(r.concluded_at) });
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
    async insertExperiment(e: { campaignId: string; hypothesis: string; lever: Lever; metric: string; armA: string; armB: string; createdBy: string }): Promise<ExperimentRow> {
      return experimentFrom((await q("insert into experiment (campaign_id, hypothesis, lever, metric, arm_a_entry, arm_b_entry, status, created_by) values ($1,$2,$3,$4,$5,$6,'running',$7) returning *", [e.campaignId, e.hypothesis, e.lever, e.metric, e.armA, e.armB, e.createdBy]))[0]);
    },
    async experiment(id: string): Promise<ExperimentRow | null> {
      const r = (await q("select * from experiment where id = $1", [id]))[0];
      return r ? experimentFrom(r) : null;
    },
    async experiments(campaignId: string, status?: string): Promise<ExperimentRow[]> {
      return (await q("select * from experiment where campaign_id = $1 and ($2::text is null or status = $2) order by created_at desc", [campaignId, status ?? null])).map(experimentFrom);
    },
    async usedArms(): Promise<Set<string>> {
      return new Set((await q("select arm_a_entry as a, arm_b_entry as b from experiment")).flatMap((r: any) => [r.a, r.b]));
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
