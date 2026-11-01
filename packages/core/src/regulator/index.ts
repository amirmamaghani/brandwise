// The regulator: feedback control of an e-mail campaign. Agents (the editor) read signals and propose; this module owns the rules
// (rails.ts), concludes experiments, and keeps goals, journal and tasks. It never sends anything: changes go through the calendar.
import type { Core } from "../index.ts";
import type { createEmail } from "../email/index.ts";
import type { Library } from "../email/templates/library.ts";
import { createLearnings, emailMeasure, type Learnings } from "../learnings/index.ts";
import { parseLever, type Lever } from "../learnings/domain.ts";
import { DEFAULT_RAILS, canPropose, judgeSeries, type ArmData, type PrimaryMetric, type Rails, type Round } from "./rails.ts";
import { minDetectableLift, roundsNeeded } from "./stats.ts";
import { GOAL_METRICS, armOf, buildSignals, type Goal, type GoalMetric, type SendView } from "./signals.ts";
import { regulatorStore, type ExperimentRow } from "./store.ts";

type Email = ReturnType<typeof createEmail>;
/** What the provider of a send reports: a guard on what it does not report is unavailable, not 0 %. */
const measuredOf = (metrics: { id: string; available: boolean }[]) => ({
  complaints: metrics.find((m) => m.id === "complaint_rate")?.available !== false,
  unsubscribes: metrics.find((m) => m.id === "unsubscribe_rate")?.available !== false,
});

export function createRegulator(deps: { core: Core; email: Email; rails?: Partial<Rails>; /** The template library: lets an experiment vary a slot or a template version, not only the subject. */ library?: () => Library | null; /** Where verdicts become learnings; one is made on the development clock when not given. */ learnings?: Learnings; /** Leads traced to an entry (null: not measured); arms then carry leads, and the lead guard applies. */ conversions?: { leadsFor(entryId: string, asOf: Date): Promise<number | null> } }) {
  const { core, email } = deps;
  const rails: Rails = { ...DEFAULT_RAILS, ...deps.rails, guards: { ...DEFAULT_RAILS.guards, ...deps.rails?.guards } };
  const store = regulatorStore(core.pool);

  /** The development clock: real time plus an offset, so a simulated provider and the rails can live days in minutes. */
  const clock = {
    async now(): Promise<Date> { return new Date(Date.now() + (await store.clockOffset()) * 1000); },
    async advance(ms: number): Promise<Date> { await store.setClockOffset((await store.clockOffset()) + Math.round(ms / 1000)); return clock.now(); },
    async reset(): Promise<void> { await store.setClockOffset(0); },
  };
  const asOfDate = async (asOf?: string) => (asOf ? new Date(asOf) : clock.now());
  const learnings = deps.learnings ?? createLearnings({ core, now: () => clock.now(), measure: emailMeasure(email, rails.matureAfterHours) });

  /** A concluded experiment becomes an E1 learning: the verdict, the effect with its interval, and what the test could show. */
  async function learn(e: ExperimentRow, verdict: string, reasons: string[], stats: { rateA: number; rateB: number; lift: number | null; p: number } | null, a: ArmData, b: ArmData, at: string, leads?: { a: number; b: number; lift: number | null } | null) {
    const n = Math.min(a.delivered, b.delivered);
    const k = (x: ArmData) => (e.metric === "lead_rate" ? x.leads ?? 0 : x.clicks);
    return learnings.fromExperiment({
      id: e.id, campaignId: e.campaignId, hypothesis: e.hypothesis, lever: e.lever, metric: e.metric, verdict, reasons, stats,
      arms: [{ delivered: a.delivered, clicks: k(a) }, { delivered: b.delivered, clicks: k(b) }],
      mde: a.delivered > 0 ? minDetectableLift(k(a) / a.delivered, n) : null, decidedAt: at, rounds: e.rounds.length, leads: leads ?? null,
    });
  }

  /** Every e-mail send under the campaign (base or itself), as numbers at the given time. */
  async function sendViews(campaignId: string, asOf: Date): Promise<SendView[]> {
    const campaigns = (await core.campaigns.list()).filter((c) => c.id === campaignId || c.rootId === campaignId);
    const views: SendView[] = [];
    for (const c of campaigns) {
      for (const send of await email.store.sends({ campaignId: c.id })) {
        const s = await email.stats({ entryId: send.entryId, asOf: asOf.toISOString() });
        const leads = deps.conversions ? await deps.conversions.leadsFor(send.entryId, asOf) : null;
        views.push({ entryId: send.entryId, title: (await core.calendar.get(send.entryId))?.title ?? send.entryId, campaignId: c.id, sentAt: send.sentAt && Date.parse(send.sentAt) <= asOf.getTime() ? send.sentAt : null, counts: s.counts, measured: measuredOf(s.metrics), leads: leads ?? undefined });
      }
    }
    return views;
  }

  const view = (e: ExperimentRow) => ({ id: e.id, hypothesis: e.hypothesis, armA: e.armA, armB: e.armB, status: e.status, verdict: e.verdict, createdAt: e.createdAt, concludedAt: e.concludedAt, rounds: e.rounds, plannedRounds: e.plannedRounds, metric: e.metric });

  async function signals(campaignId: string, asOf?: string) {
    const at = await asOfDate(asOf);
    const [goals, state, experiments, sends] = await Promise.all([store.goals(campaignId), store.state(campaignId), store.experiments(campaignId), sendViews(campaignId, at)]);
    return buildSignals({ asOf: at, rails, goals, sends, state: { ...state, running: experiments.filter((e) => e.status === "running").length }, experiments: experiments.map(view) });
  }

  async function armData(entryId: string, at: Date) {
    const s = await email.stats({ entryId, asOf: at.toISOString() });
    const sentAt = s.sends[0]?.sentAt ?? null;
    const leads = deps.conversions ? await deps.conversions.leadsFor(entryId, at) : null;
    return armOf({ entryId, title: "", campaignId: "", sentAt: sentAt && Date.parse(sentAt) <= at.getTime() ? sentAt : null, counts: s.counts, measured: s.sends.length ? measuredOf(s.metrics) : undefined, leads: leads ?? undefined });
  }
  const roundData = async (e: ExperimentRow, at: Date): Promise<Round[]> => Promise.all(e.rounds.map(async (r) => ({ a: await armData(r.armA, at), b: await armData(r.armB, at) })));
  const pooled = (arms: ArmData[]): ArmData => ({ ...arms[0], delivered: arms.reduce((t, a) => t + a.delivered, 0), clicks: arms.reduce((t, a) => t + a.clicks, 0), complaints: arms.reduce((t, a) => t + a.complaints, 0), unsubscribes: arms.reduce((t, a) => t + a.unsubscribes, 0), leads: arms.every((a) => a.leads !== undefined) ? arms.reduce((t, a) => t + a.leads!, 0) : undefined });

  /** Which e-mail entry may be an arm: e-mail, under the campaign, in no experiment yet. */
  async function armEntry(campaignId: string, id: string, used: Set<string>) {
    const e = await core.calendar.get(id);
    if (!e) throw new Error(`Entry ${id} does not exist`);
    if (e.channel !== "email") throw new Error("Experiments run on e-mail entries only (channel email)");
    const campaigns = await core.campaigns.list();
    const c = campaigns.find((x) => x.id === e.campaignId);
    if (!c || (c.id !== campaignId && c.rootId !== campaignId)) throw new Error("Both arms must belong to the campaign (or its child campaigns)");
    if (used.has(e.id)) throw new Error("An entry can be in one experiment only");
    return e;
  }

  return {
    rails,
    store,
    clock,
    learnings,
    goals: {
      list: (campaignId: string) => store.goals(campaignId),
      /** Goals are the human's: this is called by people (CLI/UI), the agent's skill forbids it and the editor persona has no reason to. */
      async set(campaignId: string, metric: string, kind: "target" | "limit", value: number) {
        if (!(GOAL_METRICS as readonly string[]).includes(metric)) throw new Error(`Unknown goal metric "${metric}" (use ${GOAL_METRICS.join(", ")})`);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("A goal value is a rate between 0 and 1 (0.04 = 4 %)");
        await store.setGoal(campaignId, { metric: metric as GoalMetric, kind, value });
      },
    },
    signals,
    async unfreeze(campaignId: string) { await store.patchState(campaignId, { frozen: false, frozenReason: null }); },
    experiments: {
      list: (campaignId: string, status?: string) => store.experiments(campaignId, status),
      /**
       * Start an A/B experiment between two calendar entries. It names its lever, the one variable it changes ("subject_style: plain ->
       * number"). The rails decide whether it may start, and a lever that already showed no difference at this size is refused.
       */
      async propose(input: { campaignId: string; hypothesis: string; lever: string | Lever; armA: string; armB: string; createdBy: string; /** The lift the editor expects (0.3 = +30 %); checked against what the planned sample can show. */ expectedLift?: number; /** Rounds of the series (1 = a single A/B). */ rounds?: number; /** What decides: clicks (default) or leads (needs a conversion source and a large audience). */ metric?: PrimaryMetric }): Promise<ExperimentRow> {
        const at = await clock.now();
        if (input.hypothesis.trim().length < 10) throw new Error("Write the hypothesis: what you change and what you expect (at least a sentence)");
        const lever = typeof input.lever === "string" ? parseLever(input.lever) : input.lever;
        const [state, running, used, a, b] = await Promise.all([store.state(input.campaignId), store.experiments(input.campaignId, "running"), store.usedArms(), core.calendar.get(input.armA), core.calendar.get(input.armB)]);
        const ok = canPropose({ ...state, running: running.length }, at, rails);
        if (!ok.ok) throw new Error(`Cannot start an experiment: ${ok.reason}`);
        if (!a || !b) throw new Error(`Entry ${!a ? input.armA : input.armB} does not exist`);
        if (a.id === b.id) throw new Error("The two arms must be two different entries");
        if (a.channel !== "email" || b.channel !== "email") throw new Error("Experiments run on e-mail entries only (channel email)");
        const campaigns = await core.campaigns.list();
        const base = campaigns.find((c) => c.id === input.campaignId);
        if (!base) throw new Error("Unknown campaign");
        const under = (id: string) => { const c = campaigns.find((x) => x.id === id); return c !== undefined && (c.id === base.id || c.rootId === base.id); };
        if (!under(a.campaignId) || !under(b.campaignId)) throw new Error("Both arms must belong to the campaign (or its child campaigns)");
        if (a.campaignId === b.campaignId) throw new Error("The arms must be in different child campaigns: each arm needs its own audience, or the same people would get both variants and the result would be contaminated");
        if (used.has(a.id) || used.has(b.id)) throw new Error("An entry can be in one experiment only");
        const rounds = input.rounds ?? 1;
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("Rounds are 1 to 20");
        const expected = input.expectedLift ?? null;
        if (expected !== null && !(expected >= rails.minRelativeLift)) throw new Error(`Cannot start an experiment: an expected lift of ${Math.round(100 * expected)} % is below the ${Math.round(100 * rails.minRelativeLift)} % a win needs to be adopted; test a bigger change`);
        const metric = input.metric ?? "click_rate";
        if (metric !== "click_rate" && metric !== "lead_rate") throw new Error("The metric is click_rate or lead_rate");
        if (metric === "lead_rate" && (!deps.conversions || (await deps.conversions.leadsFor(a.id, at)) === null)) throw new Error("Cannot start a lead experiment: no conversion source measures this brand's leads");
        const power = (await signals(input.campaignId)).power;
        const perArm = power?.deliveredPerArm ?? null, rate = metric === "lead_rate" ? power?.leadRate ?? null : power?.clickRate ?? null;
        // a lead experiment cannot be sized without a measured lead rate: it would start blind and almost surely end inconclusive
        if (metric === "lead_rate" && !(rate && rate > 0)) throw new Error("Cannot start a lead experiment: no lead rate is measured yet (leads of earlier sends arrive within 72 h); decide on clicks, the lead guard still applies");
        const mde = perArm && rate ? minDetectableLift(rate, perArm * rounds) : null;
        if (expected !== null && perArm && rate) {
          if (mde === null || mde > expected) {
            const need = roundsNeeded(rate, perArm, expected);
            throw new Error(`Cannot start an experiment: with about ${perArm} delivered per arm and round at a ${(100 * rate).toFixed(metric === "lead_rate" ? 2 : 1)} % ${metric === "lead_rate" ? "lead" : "click"} rate, ${rounds} round(s) can only show a lift of ${mde === null ? "more than double" : `${Math.round(100 * mde)} %`}; your expected ${Math.round(100 * expected)} % ${need === null ? "is not testable within 20 rounds: change something bigger" : `needs ${need} rounds (--rounds ${need})`}`);
          }
        }
        const gate = await learnings.retestGate(input.campaignId, lever, perArm ? perArm * rounds : null);
        if (!gate.ok) throw new Error(`Cannot start an experiment: ${gate.reason}`);
        return store.insertExperiment({
          campaignId: input.campaignId, hypothesis: input.hypothesis.trim(), lever, metric, armA: a.id, armB: b.id, createdBy: input.createdBy,
          expectedLift: expected, plannedRounds: rounds, plannedPerArm: perArm, mde, guardrails: rails.guards,
          decisionRule: { method: "frequentist", alpha: rails.significance, minRelativeLift: rails.minRelativeLift, test: rounds > 1 ? "cochran-mantel-haenszel" : "two-proportion z" },
        });
      },
      /**
       * Add the next pair of a series: the same change, A to the control's audience and B to the challenger's, after the previous
       * round was sent. No verdict comes before the planned rounds are mature.
       */
      async addRound(input: { experimentId: string; armA: string; armB: string }): Promise<ExperimentRow> {
        const e = await store.experiment(input.experimentId);
        if (!e) throw new Error(`No experiment ${input.experimentId}`);
        if (e.status !== "running") throw new Error(`Experiment ${e.id} is ${e.status}`);
        if (e.rounds.length >= e.plannedRounds) throw new Error(`Experiment ${e.id} has all its ${e.plannedRounds} round(s)`);
        const at = await clock.now();
        const last = e.rounds[e.rounds.length - 1];
        if ((await armData(last.armA, at)).sentAt === null || (await armData(last.armB, at)).sentAt === null) throw new Error(`Round ${last.round} has not been sent yet: wait for it before adding the next one`);
        const used = await store.usedArms();
        const [a, b] = [await armEntry(e.campaignId, input.armA, used), await armEntry(e.campaignId, input.armB, used)];
        const [firstA, firstB] = [await core.calendar.get(e.rounds[0].armA), await core.calendar.get(e.rounds[0].armB)];
        if (a.campaignId !== firstA?.campaignId || b.campaignId !== firstB?.campaignId) throw new Error("Each round goes to the same audiences: A to the control's arm campaign, B to the challenger's");
        await store.addRound(e.id, last.round + 1, a.id, b.id);
        return (await store.experiment(e.id))!;
      },
      /**
       * Judge a running experiment with the rails. While data is still arriving it only reports what to wait for; once it can
       * be judged the verdict is final and recorded (idempotent). The agent cannot change a verdict.
       */
      async evaluate(id: string, asOf?: string) {
        const e = await store.experiment(id);
        if (!e) throw new Error(`No experiment ${id}`);
        if (e.status === "concluded") return { experiment: e, verdict: e.verdict!, reasons: [] as string[], readyAt: null, final: true };
        const at = await asOfDate(asOf);
        const rounds = await roundData(e, at);
        const [armA, armB] = [pooled(rounds.map((r) => r.a)), pooled(rounds.map((r) => r.b))];
        const j = judgeSeries(rounds, e.plannedRounds, at, rails, e.metric as PrimaryMetric);
        if (j.verdict === "wait" || j.verdict === "next_round") return { experiment: e, verdict: j.verdict, reasons: j.reasons, readyAt: j.readyAt, final: false };
        await store.conclude(id, j.verdict, { reasons: j.reasons, stats: j.stats, asOf: at.toISOString() }, at.toISOString());
        const st = await store.state(e.campaignId);
        if (j.verdict === "B") await store.patchState(e.campaignId, { incumbentEntryId: e.armB, lastAdoptedAt: at.toISOString() });
        else if (j.verdict === "A" && st.incumbentEntryId === null) await store.patchState(e.campaignId, { incumbentEntryId: e.armA });
        else if (j.verdict === "freeze") await store.patchState(e.campaignId, { frozen: true, frozenReason: j.reasons.join("; ") });
        await learn(e, j.verdict, j.reasons, j.stats, armA, armB, at.toISOString(), j.leads);
        await store.journalWrite(e.campaignId, "learning", "regulator", `Experiment ${id} "${e.hypothesis}": ${j.verdict === "B" ? "the challenger (B) won and is now the incumbent" : j.verdict === "A" ? "the control (A) stays" : j.verdict === "freeze" ? "FROZEN" : "inconclusive, nothing changes"}. ${j.reasons.join(" ")}`, { experiment: id, verdict: j.verdict, stats: j.stats });
        return { experiment: (await store.experiment(id))!, verdict: j.verdict, reasons: j.reasons, readyAt: null, final: true };
      },
      /** Structured learnings for experiments concluded before learnings existed (one-off; idempotent). */
      async backfill(campaignId: string): Promise<number> {
        let n = 0;
        for (const e of await store.experiments(campaignId, "concluded")) {
          if (await learnings.store.byExperiment(e.id)) continue;
          const r = (e.result ?? {}) as { reasons?: string[]; stats?: { rateA: number; rateB: number; lift: number | null; p: number } | null; asOf?: string };
          const at = new Date(r.asOf ?? e.concludedAt ?? e.createdAt);
          const rounds = await roundData(e, at);
          await learn(e, e.verdict ?? "inconclusive", r.reasons ?? [], r.stats ?? null, pooled(rounds.map((x) => x.a)), pooled(rounds.map((x) => x.b)), e.concludedAt ?? at.toISOString());
          n++;
        }
        return n;
      },
    },
    journal: {
      read: (campaignId: string, limit = 20, kind?: string) => store.journal(campaignId, limit, kind),
      write: (campaignId: string, author: string, body: string, kind: "run" | "note" = "run") => store.journalWrite(campaignId, kind, author, body.trim()),
    },
    tasks: {
      create: (campaignId: string, createdBy: string, t: { kind: string; brief: string; params?: Record<string, unknown> }) => store.taskInsert({ campaignId, createdBy, kind: t.kind, brief: t.brief, params: t.params ?? {} }),
      list: (campaignId: string, status?: string) => store.tasks(campaignId, status),
      get: (id: string) => store.task(id),
      claim: async (id: string, by: string) => { const t = await store.taskClaim(id, by); if (!t) throw new Error(`Task ${id} is not open (already claimed, finished or unknown)`); return t; },
      /**
       * Fulfil a write_variant task: the author supplies only what is theirs (the subject, or the slots to change), code does the rest
       * (arm campaign, body, tier, time), so an arm can never be mis-scheduled or mis-addressed. The control always uses what the task
       * gives exactly. With `params.template` the arm is built from a published template and content (slots), otherwise from plain text.
       */
      async submitVariant(id: string, input: { subject?: string; content?: Record<string, unknown>; briefId?: string; applies?: string[]; tests?: string[]; tags?: string }, by: string) {
        const t = await store.task(id);
        if (!t || t.kind !== "write_variant") throw new Error(`Task ${id} is not a write_variant task`);
        if (t.status !== "claimed") throw new Error(`Task ${id} is ${t.status}: claim it first (and only once)`);
        const p = t.params as { arm?: string; role?: string; subject?: string; baseSubject?: string; body?: string; tier?: number; locale?: string; content?: Record<string, unknown>; template?: { id?: string; version?: number } };
        if (!p.arm || (p.role !== "control" && p.role !== "challenger")) throw new Error("The task has no arm or role: ask the editor to create it again");
        const arm = await core.campaigns.resolve(p.arm);
        const now = (await clock.now()).toISOString();
        const tier = (p.tier as 1 | 2 | 3) ?? 1;
        /** Every arm entry is linked to the brief it was written from (made here when the author did not pass one) and to what it applies. */
        const link = async (entryId: string) => {
          const briefId = input.briefId ?? (typeof t.params.brief === "string" ? t.params.brief : (await learnings.brief({ campaignId: arm.id, channel: "email", createdBy: by })).id);
          return learnings.attach(entryId, { briefId, applies: input.applies, tests: input.tests, tags: input.tags });
        };

        if (p.template?.id) {   // a template experiment: the variable can be any slot
          const lib = deps.library?.();
          if (!lib) throw new Error("Template experiments need the e-mail template library");
          const base = p.content ?? {};
          const content = p.role === "control" ? base : { ...base, ...(input.content ?? {}), ...(input.subject ? { subject: input.subject.trim() } : {}) };
          if (p.role === "challenger" && JSON.stringify(content) === JSON.stringify(base)) throw new Error("The challenger must differ from the control: change a slot (--content '{\"cta_label\": ...}') or the subject");
          const made = await lib.entries.create({ campaignId: arm.id, scheduledAt: now, tier, templateId: p.template.id, version: p.template.version, locale: p.locale, content, createdBy: by });
          const linked = await link(made.entry.id);
          return store.taskFinish(id, "done", { entry: made.entry.id, subject: made.render.subject, status: made.entry.status, templateVersion: made.version.version, brief: linked.briefId }) as Promise<NonNullable<Awaited<ReturnType<typeof store.taskFinish>>>>;
        }

        if (!p.body) throw new Error("The task has no body: ask the editor to create it again");
        const title = p.role === "control" ? p.subject : (input.subject ?? "").trim();
        if (!title) throw new Error(p.role === "control" ? "The control task needs a subject in its params" : "Give the challenger a subject (--subject)");
        if (p.role === "challenger") {
          if (title.length < 3 || title.length > 70) throw new Error("A subject line is 3 to 70 characters");
          if (title === (p.baseSubject ?? p.subject)) throw new Error("The challenger must differ from the incumbent subject");
        }
        const entry = await core.calendar.add({ campaignId: arm.id, title, channel: "email", scheduledAt: now, tier, body: p.body, createdBy: by });
        const linked = await link(entry.id);
        return store.taskFinish(id, "done", { entry: entry.id, subject: title, status: entry.status, brief: linked.briefId }) as Promise<NonNullable<Awaited<ReturnType<typeof store.taskFinish>>>>;
      },
      complete: async (id: string, result: unknown) => { const t = await store.taskFinish(id, "done", result); if (!t) throw new Error(`Task ${id} is already finished or unknown`); return t; },
    },
  };
}
export type Regulator = ReturnType<typeof createRegulator>;
