// Learnings: what the system knows works, and how agents get it before they write (docs/analytics.md, phase 1).
// Code writes E1 (experiment verdicts, see regulator) and E2 (patterns, `mine`); agents may add E3 observations and propose
// reviewer preferences, which only a person confirms. Agents read the result through `brief`, never raw rows.
import type { Campaign, Core } from "../index.ts";
import type { createEmail } from "../email/index.ts";
import { wilson } from "../regulator/stats.ts";
import { parseTags } from "./attributes.ts";
import {
  briefText, composeBrief, effectiveStatus, isContrary, leverKey, parseLever, promotions, statementFor, supersededBy,
  type BriefPayload, type Learning, type Lever, type Result,
} from "./domain.ts";
import { minePatterns, type Observation } from "./miner.ts";
import { learningsStore, type NewLearning } from "./store.ts";

export { briefText, parseLever, leverText, effectiveStatus, weight, reviewAt } from "./domain.ts";
export type { BriefPayload, Learning, Lever } from "./domain.ts";
export { parseTags, ATTRIBUTE_KEYS, TAGGED_KEYS, DERIVED_KEYS } from "./attributes.ts";

type Email = ReturnType<typeof createEmail>;
/** What an entry did, once it has matured: the measure learnings are checked against. Null while immature or unmeasurable. */
export type Measure = {
  outcome(entryId: string, asOf: Date): Promise<{ rate: number; low: number; high: number; delivered: number } | null>;
  observations(campaignIds: string[], asOf: Date): Promise<Omit<Observation, "attributes">[]>;
};

/** E-mail entries are measured by unique click rate, 24 h after sending, with at least 50 delivered. */
export function emailMeasure(email: Email, matureHours = 24, minDelivered = 50): Measure {
  const mature = (sentAt: string | null, asOf: Date) => sentAt !== null && Date.parse(sentAt) + matureHours * 3_600_000 <= asOf.getTime();
  return {
    async outcome(entryId, asOf) {
      const s = await email.stats({ entryId, asOf: asOf.toISOString() });
      const sentAt = s.sends[0]?.sentAt ?? null;
      if (!mature(sentAt, asOf) || s.counts.delivered < minDelivered) return null;
      const k = s.counts.clicked.unique, n = s.counts.delivered, ci = wilson(k, n);
      return { rate: k / n, low: ci.low, high: ci.high, delivered: n };
    },
    async observations(campaignIds, asOf) {
      const out: Omit<Observation, "attributes">[] = [];
      for (const campaignId of campaignIds) {
        for (const send of await email.store.sends({ campaignId })) {
          if (!mature(send.sentAt, asOf)) continue;
          const s = await email.stats({ entryId: send.entryId, asOf: asOf.toISOString() });
          if (s.counts.delivered >= minDelivered) out.push({ entryId: send.entryId, sentAt: send.sentAt!, delivered: s.counts.delivered, clicks: s.counts.clicked.unique });
        }
      }
      return out;
    },
  };
}

export function createLearnings(deps: { core: Core; now: () => Promise<Date>; measure?: Measure }) {
  const { core } = deps;
  const store = learningsStore(core.pool);

  /** A campaign, its always-on base and every campaign of that brand. */
  async function family(campaignId: string): Promise<{ campaign: Campaign; root: Campaign; tree: Campaign[] }> {
    const all = await core.campaigns.list();
    const campaign = all.find((c) => c.id === campaignId);
    if (!campaign) throw new Error(`No campaign with id ${campaignId}`);
    const root = all.find((c) => c.id === campaign.rootId) ?? campaign;
    return { campaign, root, tree: all.filter((c) => c.rootId === root.id) };
  }
  const scopeOf = (c: Campaign): "brand" | "campaign" => (c.kind === "always_on" ? "brand" : "campaign");

  /** Store a learning written by code and let it replace what it supersedes; promote campaign findings that agree across campaigns. */
  async function record(l: NewLearning): Promise<Learning> {
    const created = await store.insert(l);
    const existing = await store.list([created.campaignId], { status: "active" });
    await store.supersede(supersededBy(created, existing), created.id);
    await promote(created.campaignId);
    return (await store.get(created.id))!;
  }

  async function promote(campaignId: string) {
    const { root, tree } = await family(campaignId);
    const campaignLevel = await store.list(tree.filter((c) => c.id !== root.id).map((c) => c.id), { status: "active" });
    const brandLevel = await store.list([root.id], { status: "active" });
    for (const group of promotions(campaignLevel, brandLevel)) {
      const best = [...group].sort((a, b) => (a.evidence === b.evidence ? Date.parse(b.decidedAt) - Date.parse(a.decidedAt) : a.evidence === "E1" ? -1 : 1))[0];
      await record({
        campaignId: root.id, scope: "brand", kind: "performance", evidence: best.evidence, result: best.result, statement: best.statement,
        channel: best.channel, lever: best.lever, metric: best.metric, effect: best.effect, ciLow: best.ciLow, ciHigh: best.ciHigh, nPerArm: best.nPerArm,
        method: `promoted: agrees in ${new Set(group.map((g) => g.campaignId)).size} campaigns`, sourceIds: group.map((g) => g.id),
        createdBy: "promotion", decidedAt: best.decidedAt,
      });
    }
  }

  /** How many applications went clearly against each learning; outcomes are measured once the entry matured, then kept. */
  async function contrary(ls: Learning[], asOf: Date): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const perf = ls.filter((l) => l.kind === "performance" && l.result && l.result !== "no_difference");
    if (perf.length === 0) return out;
    const apps = await store.applications({ learningIds: perf.map((l) => l.id) });
    for (const a of apps) {
      const l = perf.find((x) => x.id === a.learningId)!;
      let outcome = a.outcome as (Record<string, unknown> & { contrary?: boolean }) | null;
      if (outcome === null && a.mode !== "test" && deps.measure) {
        const m = await deps.measure.outcome(a.entryId, asOf);
        const baseline = m ? await baselineFor(a.entryId, asOf) : null;
        if (m && baseline !== null) {
          outcome = { rate: m.rate, low: m.low, high: m.high, delivered: m.delivered, baseline, contrary: isContrary(l, { ...m, baseline }) };
          await store.setOutcome(a.learningId, a.entryId, outcome);
        }
      }
      if (outcome?.contrary) out.set(l.id, (out.get(l.id) ?? 0) + 1);
    }
    return out;
  }

  /** The brand's usual rate before the entry: pooled over its other matured sends. */
  async function baselineFor(entryId: string, asOf: Date): Promise<number | null> {
    const entry = await core.calendar.get(entryId);
    if (!entry || !deps.measure) return null;
    const { tree } = await family(entry.campaignId);
    const obs = (await deps.measure.observations(tree.map((c) => c.id), asOf)).filter((o) => o.entryId !== entryId).sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 5);
    const delivered = obs.reduce((t, o) => t + o.delivered, 0);
    return delivered > 0 ? obs.reduce((t, o) => t + o.clicks, 0) / delivered : null;
  }

  /** Learnings that apply to a campaign: its own and its brand's. */
  async function visible(campaignId: string) {
    const { campaign, root } = await family(campaignId);
    return store.list([...new Set([campaign.id, root.id])]);
  }

  return {
    store,
    /** Called by the regulator when an experiment is concluded: the verdict becomes an E1 learning (idempotent per experiment). */
    async fromExperiment(e: { id: string; campaignId: string; hypothesis: string; lever: Lever | null; metric: string; verdict: string; reasons: string[]; stats: { rateA: number; rateB: number; lift: number | null; p: number } | null; arms: { delivered: number; clicks: number }[]; mde: number | null; decidedAt: string; rounds?: number }) {
      const { campaign } = await family(e.campaignId);
      const [a, b] = e.arms;
      const unsafeB = e.verdict === "A" && e.reasons.some((r) => r.startsWith("B is unsafe"));
      const result: Result = e.verdict === "B" ? "better" : e.verdict === "freeze" || unsafeB ? "unsafe" : e.verdict === "A" ? "worse" : "no_difference";
      const ci = a && b && a.delivered > 0 && b.delivered > 0 && a.clicks > 0 ? (() => {
        const pA = a.clicks / a.delivered, pB = b.clicks / b.delivered, se = Math.sqrt((pA * (1 - pA)) / a.delivered + (pB * (1 - pB)) / b.delivered);
        return { low: (pB - pA - 1.96 * se) / pA, high: (pB - pA + 1.96 * se) / pA };
      })() : null;
      const nPerArm = a && b ? Math.min(a.delivered, b.delivered) : null;
      const note = result === "unsafe" ? e.reasons.join(" ").replace(/^B is unsafe: /, "") : result === "no_difference" ? e.reasons[0] : undefined;
      return record({
        campaignId: e.campaignId, scope: scopeOf(campaign), kind: result === "no_difference" ? "null_result" : "performance", evidence: "E1", result,
        statement: statementFor({ lever: e.lever, result, metric: e.metric, effect: e.stats?.lift ?? null, ciLow: ci?.low ?? null, ciHigh: ci?.high ?? null, nPerArm, mde: e.mde, note }),
        channel: "email", lever: e.lever, metric: e.metric, effect: e.stats?.lift ?? null, ciLow: ci?.low ?? null, ciHigh: ci?.high ?? null, nPerArm, mde: e.mde,
        method: e.rounds && e.rounds > 1 ? `A/B series of ${e.rounds} rounds, Cochran-Mantel-Haenszel` : "A/B, two-proportion z-test", context: { hypothesis: e.hypothesis, verdict: e.verdict, p: e.stats?.p ?? null, reasons: e.reasons, rounds: e.rounds ?? 1 },
        experimentId: e.id, createdBy: "regulator", decidedAt: e.decidedAt,
      });
    },

    /**
     * May this lever be tested? Refused while an active null result for it stands at the same sample: the test would end the same way.
     * `expectedPerArm` is what one arm will reach (null when unknown: then only an aged-out null result lets it through).
     */
    async retestGate(campaignId: string, lever: Lever, expectedPerArm: number | null): Promise<{ ok: boolean; reason: string | null }> {
      const asOf = await deps.now();
      const key = leverKey(lever);
      const nulls = (await visible(campaignId)).filter((l) => l.kind === "null_result" && l.lever && leverKey(l.lever) === key && effectiveStatus(l, asOf) === "active");
      const blocking = nulls.find((l) => expectedPerArm === null || l.nPerArm === null || expectedPerArm <= 1.2 * l.nPerArm);
      return blocking
        ? { ok: false, reason: `learning ${blocking.id} found no difference for this lever at n=${blocking.nPerArm ?? "?"} per arm (${blocking.statement}); a test of the same size would end the same way: change something bigger, or test it with a larger sample` }
        : { ok: true, reason: null };
    },

    /** The brief for writing on a campaign and channel: stored, so the entry can cite it. */
    async brief(input: { campaignId: string; channel?: string | null; day?: string; createdBy: string }): Promise<{ id: string; payload: BriefPayload; text: string }> {
      const asOf = await deps.now();
      const { campaign, root, tree } = await family(input.campaignId);
      const ls = await visible(campaign.id);
      const counts = await contrary(ls, asOf);
      const channel = input.channel ?? null;
      const recent = (await Promise.all(tree.map((c) => core.calendar.list(c.id)))).flat()
        .filter((e) => (!channel || e.channel === channel) && e.status !== "cancelled").sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)).slice(0, 8);
      const attrs = await store.attributes(recent.map((e) => e.id));
      const tagged = recent.map((e) => Object.fromEntries(Object.entries(attrs.get(e.id) ?? {}).filter(([k]) => !["weekday", "send_daypart", "length"].includes(k))));
      const payload = composeBrief({
        campaign: campaign.name, campaignId: root.id, channel, day: input.day ?? asOf.toISOString().slice(0, 10), asOf,
        learnings: ls.map((l) => ({ ...l, contrary: counts.get(l.id) ?? 0 })),
        feedback: await store.feedback(tree.map((c) => c.id), 5),
        recentAttributes: tagged,
      });
      const id = await store.insertBrief({ campaignId: campaign.id, channel, payload, createdBy: input.createdBy });
      return { id, payload, text: briefText(id, payload) };
    },

    /**
     * Link an entry to the brief it was written from, the learnings it applies and the one it tests, and store its tags.
     * Learnings must belong to the entry's campaign or brand; an explore slot marks applications as exploration.
     */
    async attach(entryId: string, input: { briefId?: string; applies?: string[]; tests?: string[]; tags?: string; tagSource?: "agent" | "human" }) {
      const entry = await core.calendar.get(entryId);
      if (!entry) throw new Error(`No calendar entry with id ${entryId}`);
      const tags = parseTags(input.tags);
      const known = new Map((await visible(entry.campaignId)).map((l) => [l.id, l]));
      for (const id of [...(input.applies ?? []), ...(input.tests ?? [])]) if (!known.has(id)) throw new Error(`Learning ${id} does not belong to this campaign or its brand`);
      let slot: "exploit" | "explore" = "exploit";
      if (input.briefId) {
        const b = await store.brief(input.briefId);
        if (!b) throw new Error(`No brief ${input.briefId}`);
        slot = b.payload.slot;
        await store.setEntryBrief(entryId, input.briefId);
      }
      await store.apply([
        ...(input.applies ?? []).map((learningId) => ({ learningId, entryId, mode: slot })),
        ...(input.tests ?? []).map((learningId) => ({ learningId, entryId, mode: "test" as const })),
      ]);
      if (Object.keys(tags).length) await store.setAttributes(entryId, tags, input.tagSource ?? "agent");
      return { briefId: input.briefId ?? null, applies: input.applies ?? [], tests: input.tests ?? [], tags };
    },

    /** What an entry was written from (for the approval card). */
    async forEntry(entryId: string) {
      const entry = await core.calendar.get(entryId);
      if (!entry) throw new Error(`No calendar entry with id ${entryId}`);
      const apps = await store.applications({ entryId });
      const ls = await Promise.all(apps.map((a) => store.get(a.learningId)));
      const brief = entry.briefId ? await store.brief(entry.briefId) : null;
      return {
        briefId: entry.briefId, slot: brief?.payload.slot ?? null,
        applied: apps.map((a, i) => ({ id: a.learningId, mode: a.mode, statement: ls[i]?.statement ?? "", evidence: ls[i]?.evidence ?? null })),
        attributes: await core.calendar.attributes(entryId),
      };
    },

    async list(campaignId: string, filter: { status?: string; kind?: string; evidence?: string } = {}) {
      const asOf = await deps.now();
      const ls = await visible(campaignId);
      const counts = await contrary(ls, asOf);
      return ls.map((l) => ({ ...l, effectiveStatus: effectiveStatus(l, asOf, counts.get(l.id) ?? 0), contrary: counts.get(l.id) ?? 0 }))
        .filter((l) => (!filter.status || l.effectiveStatus === filter.status) && (!filter.kind || l.kind === filter.kind) && (!filter.evidence || l.evidence === filter.evidence));
    },
    get: (id: string) => store.get(id),

    /** An agent's observation: E3, a candidate for a test, never applied as evidence. */
    async addObservation(input: { campaignId: string; statement: string; lever?: string; channel?: string | null; createdBy: string }) {
      if (input.statement.trim().length < 10) throw new Error("Write the observation as a sentence");
      const { campaign } = await family(input.campaignId);
      return store.insert({ campaignId: campaign.id, scope: scopeOf(campaign), kind: "performance", evidence: "E3", result: null, statement: input.statement.trim(), channel: input.channel ?? null, lever: input.lever ? parseLever(input.lever) : null, createdBy: input.createdBy, decidedAt: (await deps.now()).toISOString() });
    },
    /** A rule drawn from send-backs: proposed by an agent, in force only after a person confirms it. */
    async proposePreference(input: { campaignId: string; rule: string; fromEntries: string[]; createdBy: string }) {
      if (input.rule.trim().length < 6) throw new Error("Write the rule as a sentence");
      const { root, tree } = await family(input.campaignId);
      const ids = new Set(tree.map((c) => c.id));
      for (const e of input.fromEntries) {
        const entry = await core.calendar.get(e);
        if (!entry || !ids.has(entry.campaignId)) throw new Error(`Entry ${e} is not in this brand`);
        if (!(await core.calendar.history(e)).some((h) => h.kind === "changes_requested")) throw new Error(`Entry ${e} was never sent back: a preference comes from a person's send-backs`);
      }
      if (input.fromEntries.length === 0) throw new Error("Name the sent-back entries the rule comes from (--from-entries)");
      return store.insert({ campaignId: root.id, scope: "brand", kind: "reviewer_preference", evidence: null, result: null, statement: input.rule.trim(), sourceIds: input.fromEntries, status: "proposed", createdBy: input.createdBy, decidedAt: (await deps.now()).toISOString() });
    },
    /** A person's commands. */
    async confirm(id: string, by: string) {
      const l = await store.get(id);
      if (!l || l.status !== "proposed") throw new Error(`Learning ${id} is not waiting for confirmation`);
      return (await store.setStatus(id, "active", by))!;
    },
    async retire(id: string, by: string) {
      const l = await store.get(id);
      if (!l || l.status === "retired") throw new Error(`Learning ${id} is unknown or already retired`);
      return (await store.setStatus(id, "retired", by))!;
    },

    /** E2 from patterns over the brand's matured entries. Returns only what is new; silent when nothing is. */
    async mine(campaignId: string) {
      if (!deps.measure) return [];
      const asOf = await deps.now();
      const { root, tree } = await family(campaignId);
      const obs = await deps.measure.observations(tree.map((c) => c.id), asOf);
      const attrs = await store.attributes(obs.map((o) => o.entryId));
      const patterns = minePatterns(obs.map((o) => ({ ...o, attributes: attrs.get(o.entryId) ?? {} })));
      const current = await store.list([root.id], { status: "active" });
      const created: Learning[] = [];
      for (const p of patterns) {
        const same = current.find((l) => l.lever && leverKey(l.lever) === leverKey(p.lever) && (l.evidence === "E1" || l.evidence === "E2"));
        if (same && (same.evidence === "E1" || (same.result === p.result && same.lever!.to === p.lever.to))) continue; // E1 wins; an unchanged E2 is not repeated
        created.push(await record({
          campaignId: root.id, scope: "brand", kind: "performance", evidence: "E2", result: p.result,
          statement: statementFor({ lever: p.lever, result: p.result, metric: "click_rate", effect: p.effect, ciLow: p.ciLow, ciHigh: p.ciHigh, nPerArm: null, mde: null }) + ` (pattern over ${p.units} entries in ${p.months} months)`,
          channel: "email", lever: p.lever, metric: "click_rate", effect: p.effect, ciLow: p.ciLow, ciHigh: p.ciHigh, nPerArm: p.nPerArm,
          method: "pattern: pooled two-proportion test, same direction in every month", context: { p: p.p, units: p.units, months: p.months },
          createdBy: "miner", decidedAt: asOf.toISOString(),
        }));
      }
      return created;
    },
  };
}
export type Learnings = ReturnType<typeof createLearnings>;
