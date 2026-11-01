// Postgres storage of learnings, briefs, applications, entry attributes and the review history they read.
import type pg from "pg";
import type { BriefPayload, Evidence, Kind, Learning, Lever, Result, StoredStatus } from "./domain.ts";

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const learningFrom = (r: any): Learning => ({
  id: r.id, campaignId: r.campaign_id, scope: r.scope, kind: r.kind, evidence: r.evidence, result: r.result, statement: r.statement,
  channel: r.channel, lever: r.lever, metric: r.metric, effect: num(r.effect), ciLow: num(r.ci_low), ciHigh: num(r.ci_high),
  nPerArm: num(r.n_per_arm), mde: num(r.mde), method: r.method, context: r.context ?? {}, experimentId: r.experiment_id,
  sourceIds: r.source_ids ?? [], status: r.status, supersededBy: r.superseded_by, createdBy: r.created_by, confirmedBy: r.confirmed_by,
  decidedAt: iso(r.decided_at)!, createdAt: iso(r.created_at)!,
});

export type NewLearning = {
  campaignId: string; scope: "campaign" | "brand"; kind: Kind; evidence: Evidence | null; result: Result | null; statement: string;
  channel?: string | null; lever?: Lever | null; metric?: string | null; effect?: number | null; ciLow?: number | null; ciHigh?: number | null;
  nPerArm?: number | null; mde?: number | null; method?: string | null; context?: Record<string, unknown>; experimentId?: string | null;
  sourceIds?: string[]; status?: StoredStatus; createdBy: string; decidedAt: string;
};
export type Application = { learningId: string; entryId: string; mode: "exploit" | "explore" | "test"; outcome: Record<string, unknown> | null; at: string };

export function learningsStore(pool: pg.Pool) {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  return {
    async insert(l: NewLearning): Promise<Learning> {
      const r = (await q(
        `insert into learning (campaign_id, scope, kind, evidence, result, statement, channel, lever, metric, effect, ci_low, ci_high, n_per_arm, mde, method, context, experiment_id, source_ids, status, created_by, decided_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         on conflict (experiment_id) where experiment_id is not null do nothing returning *`,
        [l.campaignId, l.scope, l.kind, l.evidence, l.result, l.statement, l.channel ?? null, l.lever ?? null, l.metric ?? null, l.effect ?? null, l.ciLow ?? null, l.ciHigh ?? null,
         l.nPerArm ?? null, l.mde ?? null, l.method ?? null, l.context ?? {}, l.experimentId ?? null, l.sourceIds ?? [], l.status ?? "active", l.createdBy, l.decidedAt],
      ))[0];
      return learningFrom(r ?? (await q("select * from learning where experiment_id = $1", [l.experimentId]))[0]);
    },
    async get(id: string): Promise<Learning | null> {
      const r = (await q("select * from learning where id = $1", [id]))[0];
      return r ? learningFrom(r) : null;
    },
    async byExperiment(experimentId: string): Promise<Learning | null> {
      const r = (await q("select * from learning where experiment_id = $1", [experimentId]))[0];
      return r ? learningFrom(r) : null;
    },
    /** Learnings owned by any of the campaigns. */
    async list(campaignIds: string[], filter: { status?: string; kind?: string; evidence?: string } = {}): Promise<Learning[]> {
      return (await q(
        `select * from learning where campaign_id = any($1::uuid[]) and ($2::text is null or status = $2) and ($3::text is null or kind = $3) and ($4::text is null or evidence = $4)
         order by decided_at desc, created_at desc`,
        [campaignIds, filter.status ?? null, filter.kind ?? null, filter.evidence ?? null],
      )).map(learningFrom);
    },
    async supersede(ids: string[], by: string) {
      if (ids.length) await q("update learning set status = 'superseded', superseded_by = $2 where id = any($1::text[]) and status = 'active'", [ids, by]);
    },
    async setStatus(id: string, status: StoredStatus, confirmedBy?: string): Promise<Learning | null> {
      const r = (await q("update learning set status = $2, confirmed_by = coalesce($3, confirmed_by) where id = $1 returning *", [id, status, confirmedBy ?? null]))[0];
      return r ? learningFrom(r) : null;
    },
    async insertBrief(b: { campaignId: string; channel: string | null; payload: BriefPayload; createdBy: string }): Promise<string> {
      return (await q("insert into brief (campaign_id, channel, slot, payload, created_by) values ($1,$2,$3,$4,$5) returning id", [b.campaignId, b.channel, b.payload.slot, b.payload, b.createdBy]))[0].id;
    },
    async brief(id: string): Promise<{ id: string; campaignId: string; channel: string | null; payload: BriefPayload; createdAt: string } | null> {
      const r = (await q("select * from brief where id = $1", [id]))[0];
      return r ? { id: r.id, campaignId: r.campaign_id, channel: r.channel, payload: r.payload, createdAt: iso(r.created_at)! } : null;
    },
    async setEntryBrief(entryId: string, briefId: string) {
      await q("update content_calendar set brief_id = $2 where id = $1", [entryId, briefId]);
    },
    async apply(rows: { learningId: string; entryId: string; mode: Application["mode"] }[]) {
      for (const r of rows) await q("insert into learning_application (learning_id, entry_id, mode) values ($1,$2,$3) on conflict (learning_id, entry_id) do update set mode = excluded.mode", [r.learningId, r.entryId, r.mode]);
    },
    async applications(filter: { learningIds?: string[]; entryId?: string }): Promise<Application[]> {
      return (await q(
        "select * from learning_application where ($1::text[] is null or learning_id = any($1::text[])) and ($2::text is null or entry_id = $2) order by at",
        [filter.learningIds ?? null, filter.entryId ?? null],
      )).map((r: any) => ({ learningId: r.learning_id, entryId: r.entry_id, mode: r.mode, outcome: r.outcome, at: iso(r.at)! }));
    },
    async setOutcome(learningId: string, entryId: string, outcome: Record<string, unknown>) {
      await q("update learning_application set outcome = $3 where learning_id = $1 and entry_id = $2", [learningId, entryId, outcome]);
    },
    async setAttributes(entryId: string, attrs: Record<string, string>, source: "derived" | "agent" | "human") {
      for (const [k, v] of Object.entries(attrs)) {
        // derived values always follow the entry; a tag never overwrites a derived key
        await q(`insert into entry_attribute (entry_id, key, value, source) values ($1,$2,$3,$4)
                 on conflict (entry_id, key) do update set value = excluded.value, source = excluded.source
                 where entry_attribute.source <> 'derived' or excluded.source = 'derived'`, [entryId, k, v, source]);
      }
    },
    async attributes(entryIds: string[]): Promise<Map<string, Record<string, string>>> {
      const out = new Map<string, Record<string, string>>();
      for (const r of await q("select entry_id, key, value from entry_attribute where entry_id = any($1::text[])", [entryIds])) {
        out.set(r.entry_id, { ...(out.get(r.entry_id) ?? {}), [r.key]: r.value });
      }
      return out;
    },
    /** The latest send-backs under the campaigns: the reviewer's own words. */
    async feedback(campaignIds: string[], limit: number): Promise<{ entryId: string; at: string; note: string; reason: string | null }[]> {
      return (await q(
        `select ev.entry_id, ev.at, ev.note, ev.reason from entry_event ev join content_calendar c on c.id = ev.entry_id
         where ev.kind = 'changes_requested' and c.campaign_id = any($1::uuid[]) order by ev.at desc limit $2`,
        [campaignIds, limit],
      )).map((r: any) => ({ entryId: r.entry_id, at: iso(r.at)!, note: r.note ?? "", reason: r.reason }));
    },
  };
}
export type LearningsStore = ReturnType<typeof learningsStore>;
