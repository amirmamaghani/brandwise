// Costs and the brand's economics (docs/analytics.md, phase 3): the ledger of what was used, the profile a person sets, and the
// reports agents and people read (`bb brandwise results ...`, the Results page). Money for units is applied when a report is made.
import type pg from "pg";
import type { Campaign, Core } from "../index.ts";
import { derived, formats, production, reviewMinutes, validateProfile, type GenCost, type Profile } from "./domain.ts";

export { BUSINESS_MODELS, derived, validateProfile, type Profile } from "./domain.ts";

export type CostKind = "media" | "gen" | "llm" | "incentive" | "tool" | "sales";
const DAY = 86_400_000;

function economicsStore(pool: pg.Pool) {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  return {
    q,
    async upsertCost(c: { campaignId: string; kind: CostKind; units: number; unit: string; amount?: number | null; format?: string | null; status?: string | null; source: string; sourceRef: string; entryId?: string | null; assetId?: string | null; note?: string | null; createdBy: string; at?: string }) {
      await q(`insert into cost_entry (campaign_id, kind, units, unit, amount, format, status, source, source_ref, entry_id, asset_id, note, created_by, at)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14::timestamptz, now()))
               on conflict (source, source_ref) do update set status = coalesce(excluded.status, cost_entry.status), asset_id = coalesce(excluded.asset_id, cost_entry.asset_id),
                 format = coalesce(excluded.format, cost_entry.format), entry_id = coalesce(excluded.entry_id, cost_entry.entry_id)`,
        [c.campaignId, c.kind, c.units, c.unit, c.amount ?? null, c.format ?? null, c.status ?? null, c.source, c.sourceRef, c.entryId ?? null, c.assetId ?? null, c.note ?? null, c.createdBy, c.at ?? null]);
    },
    async setGenStatus(source: string, sourceRef: string, p: { status: string; assetId?: string | null; format?: string | null }) {
      await q("update cost_entry set status = $3, asset_id = coalesce($4, asset_id), format = coalesce($5, format) where source = $1 and source_ref = $2", [source, sourceRef, p.status, p.assetId ?? null, p.format ?? null]);
    },
    async costs(campaignIds: string[], since: string, until: string) {
      return (await q("select * from cost_entry where campaign_id = any($1::uuid[]) and at >= $2 and at < $3 order by at", [campaignIds, since, until])).map((r: any) => ({
        id: Number(r.id), campaignId: r.campaign_id, entryId: r.entry_id, assetId: r.asset_id, kind: r.kind as CostKind, units: Number(r.units), unit: r.unit,
        amount: r.amount === null ? null : Number(r.amount), format: r.format, status: r.status, source: r.source, sourceRef: r.source_ref, at: new Date(r.at).toISOString(),
      }));
    },
    async profile(campaignId: string, asOf: string): Promise<{ profile: Profile; validFrom: string; setBy: string } | null> {
      const r = (await q("select * from economics_profile where campaign_id = $1 and valid_from <= $2 order by valid_from desc limit 1", [campaignId, asOf]))[0];
      return r ? { profile: r.profile, validFrom: new Date(r.valid_from).toISOString(), setBy: r.set_by } : null;
    },
    async setProfile(campaignId: string, profile: Profile, by: string, at: string) {
      await q("insert into economics_profile (campaign_id, valid_from, profile, set_by) values ($1,$2,$3,$4)", [campaignId, at, profile, by]);
    },
  };
}

export function createEconomics(deps: { core: Core; now: () => Promise<Date>; /** money per unit of a generation provider (its `<id>.unitPrice` setting), null when unset */ unitPrice?: (provider: string, campaignId: string) => Promise<number | null> }) {
  const { core } = deps;
  const store = economicsStore(core.pool);

  async function family(campaignId: string): Promise<{ campaign: Campaign; root: Campaign; tree: Campaign[] }> {
    const all = await core.campaigns.list();
    const campaign = all.find((c) => c.id === campaignId);
    if (!campaign) throw new Error(`No campaign with id ${campaignId}`);
    const root = all.find((c) => c.id === campaign.rootId) ?? campaign;
    // a campaign and everything under it (a base: the whole brand)
    const under = (id: string): Campaign[] => [all.find((c) => c.id === id)!, ...all.filter((c) => c.parentId === id).flatMap((c) => under(c.id))];
    return { campaign, root, tree: under(campaign.id) };
  }
  const window = async (sinceDays?: number) => {
    const until = await deps.now();
    return { since: new Date(until.getTime() - (sinceDays ?? 30) * DAY).toISOString(), until: until.toISOString(), months: (sinceDays ?? 30) / 30.44 };
  };

  async function profileFor(campaignId: string, asOf?: string) {
    const { root } = await family(campaignId);
    return store.profile(root.id, asOf ?? (await deps.now()).toISOString());
  }

  /** Assets that made it into an approved (or later published) entry, or that a person approved in the library. */
  async function approvedAssets(campaignIds: string[]): Promise<Set<string>> {
    const rows = await store.q(
      `select distinct asset_id from content_calendar where asset_id is not null and campaign_id = any($1::uuid[]) and (approved_at is not null or status in ('approved', 'scheduled', 'publishing', 'published'))
       union select id from asset where campaign_id = any($1::uuid[]) and status in ('approved', 'published')`, [campaignIds]);
    return new Set(rows.map((r: any) => r.asset_id));
  }

  /** Generations with their money (units x the provider's unit price, null while no price is set). */
  async function genCosts(campaignIds: string[], since: string, until: string): Promise<(GenCost & { campaignId: string; source: string; at: string })[]> {
    const rows = (await store.costs(campaignIds, since, until)).filter((c) => c.kind === "gen");
    return Promise.all(rows.map(async (r) => {
      const price = deps.unitPrice ? await deps.unitPrice(r.source, r.campaignId) : null;
      return { format: r.format, status: r.status, units: r.units, money: r.amount ?? (price === null ? null : r.units * price), assetId: r.assetId, campaignId: r.campaignId, source: r.source, at: r.at };
    }));
  }

  return {
    store,
    /** A generation was started: its estimated units are spent from now on (rejected and failed ones count too). */
    async recordGeneration(g: { campaignId: string; provider: string; jobId: string; units: number; unit: string; format: string; createdBy: string }) {
      await store.upsertCost({ campaignId: g.campaignId, kind: "gen", units: g.units, unit: g.unit, format: g.format, status: "started", source: g.provider, sourceRef: g.jobId, createdBy: g.createdBy });
    },
    async finishGeneration(provider: string, jobId: string, p: { status: "done" | "failed"; assetId?: string; format?: string }) {
      await store.setGenStatus(provider, jobId, p);
    },
    /** Units of a provider spent today under a scope (a campaign and everything under it; null = everything): what daily budgets read. */
    async spentToday(provider: string, scope: string | null): Promise<number> {
      // the UTC day as explicit instants: a date compared with timestamptz would follow the database session's time zone
      const start = new Date(`${(await deps.now()).toISOString().slice(0, 10)}T00:00:00.000Z`), end = new Date(start.getTime() + DAY);
      const ids = scope === null ? null : (await family(scope)).tree.map((c) => c.id);
      const r = (await store.q("select coalesce(sum(units), 0) as n from cost_entry where kind = 'gen' and source = $1 and ($2::uuid[] is null or campaign_id = any($2::uuid[])) and at >= $3 and at < $4", [provider, ids, start.toISOString(), end.toISOString()]))[0];
      return Number(r.n);
    },
    /** A cost a person states: media spend, an incentive, a tool, sales cost (for CAC). Idempotent per reference. */
    async addCost(c: { campaignId: string; kind: "media" | "incentive" | "tool" | "sales"; amount: number; entryId?: string | null; ref: string; note?: string; createdBy: string; at?: string }) {
      if (!(c.amount >= 0)) throw new Error("The amount is 0 or more");
      if (!c.ref.trim()) throw new Error("Give a reference (an invoice or order number): the same reference is recorded once");
      await store.upsertCost({ campaignId: c.campaignId, kind: c.kind, units: c.amount, unit: "money", amount: c.amount, source: "manual", sourceRef: `${c.kind}:${c.ref.trim()}`, entryId: c.entryId ?? null, note: c.note ?? null, createdBy: c.createdBy, at: c.at });
    },
    profile: {
      get: profileFor,
      /** A person's action: a new version from now on (reports for earlier dates keep the old one). */
      async set(campaignId: string, input: Record<string, unknown>, by: string) {
        const { root } = await family(campaignId);
        const profile = validateProfile(input);
        await store.setProfile(root.id, profile, by, (await deps.now()).toISOString());
        return profile;
      },
    },

    /** What the campaign cost in the window, by kind, at the profile's prices; what cannot be priced yet says what it needs. */
    async costs(campaignId: string, opts: { sinceDays?: number } = {}) {
      const { campaign, root, tree } = await family(campaignId);
      const w = await window(opts.sinceDays);
      const ids = tree.map((c) => c.id);
      const prof = (await store.profile(root.id, w.until))?.profile ?? null;
      const needs = new Set<string>();
      const ledger = await store.costs(ids, w.since, w.until);
      const gens = await genCosts(ids, w.since, w.until);
      const genMoney = gens.reduce((t, g) => (g.money === null ? (needs.add("the unit price of the generation provider (setting <provider>.unitPrice)"), t) : t + g.money), 0);
      const sum = (k: CostKind) => ledger.filter((c) => c.kind === k).reduce((t, c) => t + (c.amount ?? 0), 0);
      // review minutes: the approval dialog's timer, or the tier's default for approvals without one
      const reviews = await store.q(
        `select ev.data, c.tier from entry_event ev join content_calendar c on c.id = ev.entry_id
         where c.campaign_id = any($1::uuid[]) and ev.kind in ('approved', 'changes_requested', 'cancelled') and ev.at >= $2 and ev.at < $3`, [ids, w.since, w.until]);
      const minutes = reviews.reduce((t: number, r: any) => t + reviewMinutes({ reviewSeconds: r.data?.review_seconds ?? null, tier: r.tier }, prof), 0);
      if (minutes > 0 && prof?.hourlyRate === undefined) needs.add("hourlyRate in the economics profile");
      const sent = Number((await store.q(
        `select count(*) as n from email_event ev join email_send s on s.id = ev.send_id join content_calendar c on c.id = s.entry_id
         where ev.type = 'sent' and c.campaign_id = any($1::uuid[]) and ev.at >= $2 and ev.at < $3`, [ids, w.since, w.until]))[0].n);
      if (sent > 0 && prof?.espPerThousand === undefined) needs.add("espPerThousand in the economics profile");
      // LLM: the monthly amount over the brand, this campaign's share by the entries written outside the UI (agents work through the CLI)
      const agentEntries = async (cids: string[]) => Number((await store.q("select count(*) as n from content_calendar where campaign_id = any($1::uuid[]) and created_by <> 'ui' and created_at >= $2 and created_at < $3", [cids, w.since, w.until]))[0].n);
      const brandIds = (await family(root.id)).tree.map((c) => c.id);
      const [mine, all] = [await agentEntries(ids), await agentEntries(brandIds)];
      const llm = prof?.llmMonthly !== undefined ? (all > 0 ? (prof.llmMonthly * w.months * mine) / all : 0) : null;
      if (llm === null && mine > 0) needs.add("llmMonthly in the economics profile");
      const rows = [
        { kind: "gen", money: genMoney, detail: `${gens.length} generation(s), ${gens.reduce((t, g) => t + g.units, 0)} units` },
        { kind: "media", money: sum("media"), detail: "stated spend" },
        { kind: "human", money: prof?.hourlyRate !== undefined ? (minutes / 60) * prof.hourlyRate : null, detail: `${Math.round(minutes)} review minute(s)` },
        { kind: "distribution", money: prof?.espPerThousand !== undefined ? (sent / 1000) * prof.espPerThousand : null, detail: `${sent} e-mail(s) sent` },
        { kind: "llm", money: llm, detail: `${mine} of ${all} agent-written entries of the brand` },
        { kind: "incentive", money: sum("incentive"), detail: "stated" },
        ...(campaign.id === root.id ? [{ kind: "tool", money: (prof?.toolsMonthly ?? 0) * w.months + sum("tool"), detail: "period level only" }] : []),
      ];
      const total = rows.every((r) => r.money !== null) ? rows.reduce((t, r) => t + r.money!, 0) : null;
      return { campaign: campaign.name, currency: prof?.currency ?? null, since: w.since, until: w.until, rows, total, partial: rows.filter((r) => r.money === null).map((r) => r.kind), needs: [...needs] };
    },

    /** Creative economics per format: cost per approved asset with rejected and failed generations in, and the share that gets approved. */
    async formats(campaignId: string, opts: { sinceDays?: number } = {}) {
      const { tree } = await family(campaignId);
      const w = await window(opts.sinceDays ?? 90);
      const ids = tree.map((c) => c.id);
      return formats(await genCosts(ids, w.since, w.until), await approvedAssets(ids));
    },

    /** Production: first-pass approval, rounds of send-backs, time to approval and the reasons, over entries a person reviews (tier 2 and 3). */
    async production(campaignId: string, opts: { sinceDays?: number } = {}) {
      const { tree } = await family(campaignId);
      const w = await window(opts.sinceDays ?? 90);
      const entries = await store.q("select id, created_at from content_calendar where campaign_id = any($1::uuid[]) and tier > 1 and created_at >= $2 and created_at < $3", [tree.map((c) => c.id), w.since, w.until]);
      const events = await store.q("select entry_id, kind, at, reason from entry_event where entry_id = any($1::text[]) order by at, id", [entries.map((e: any) => e.id)]);
      return production(entries.map((e: any) => ({ id: e.id, createdAt: new Date(e.created_at).toISOString(), events: events.filter((x: any) => x.entry_id === e.id).map((x: any) => ({ entryId: x.entry_id, kind: x.kind, at: new Date(x.at).toISOString(), reason: x.reason })) })));
    },

    /** What the profile alone says (ceilings), with what is missing. Leads and CPL come with conversions (phase 4). */
    async economics(campaignId: string) {
      const p = await profileFor(campaignId);
      return { profile: p?.profile ?? null, validFrom: p?.validFrom ?? null, setBy: p?.setBy ?? null, derived: derived(p?.profile ?? null) };
    },
  };
}
export type Economics = ReturnType<typeof createEconomics>;
