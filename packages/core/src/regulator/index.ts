// The regulator: feedback control of an e-mail campaign. Agents (the editor) read signals and propose; this module owns the rules
// (rails.ts), concludes experiments, and keeps goals, journal and tasks. It never sends anything: changes go through the calendar.
import type { Core } from "../index.ts";
import type { createEmail } from "../email/index.ts";
import { DEFAULT_RAILS, canPropose, judge, type Rails } from "./rails.ts";
import { GOAL_METRICS, armOf, buildSignals, type Goal, type GoalMetric, type SendView } from "./signals.ts";
import { regulatorStore, type ExperimentRow } from "./store.ts";

type Email = ReturnType<typeof createEmail>;

export function createRegulator(deps: { core: Core; email: Email; rails?: Partial<Rails> }) {
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

  /** Every e-mail send under the campaign (base or itself), as numbers at the given time. */
  async function sendViews(campaignId: string, asOf: Date): Promise<SendView[]> {
    const campaigns = (await core.campaigns.list()).filter((c) => c.id === campaignId || c.rootId === campaignId);
    const views: SendView[] = [];
    for (const c of campaigns) {
      for (const send of await email.store.sends({ campaignId: c.id })) {
        const s = await email.stats({ entryId: send.entryId, asOf: asOf.toISOString() });
        views.push({ entryId: send.entryId, title: (await core.calendar.get(send.entryId))?.title ?? send.entryId, campaignId: c.id, sentAt: send.sentAt && Date.parse(send.sentAt) <= asOf.getTime() ? send.sentAt : null, counts: s.counts });
      }
    }
    return views;
  }

  const view = (e: ExperimentRow) => ({ id: e.id, hypothesis: e.hypothesis, armA: e.armA, armB: e.armB, status: e.status, verdict: e.verdict, createdAt: e.createdAt, concludedAt: e.concludedAt });

  async function signals(campaignId: string, asOf?: string) {
    const at = await asOfDate(asOf);
    const [goals, state, experiments, sends] = await Promise.all([store.goals(campaignId), store.state(campaignId), store.experiments(campaignId), sendViews(campaignId, at)]);
    return buildSignals({ asOf: at, rails, goals, sends, state: { ...state, running: experiments.filter((e) => e.status === "running").length }, experiments: experiments.map(view) });
  }

  async function armData(entryId: string, at: Date) {
    const s = await email.stats({ entryId, asOf: at.toISOString() });
    const sentAt = s.sends[0]?.sentAt ?? null;
    return armOf({ entryId, title: "", campaignId: "", sentAt: sentAt && Date.parse(sentAt) <= at.getTime() ? sentAt : null, counts: s.counts });
  }

  return {
    rails,
    store,
    clock,
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
      /** Start an A/B experiment between two calendar entries. The rails decide whether it may start. */
      async propose(input: { campaignId: string; hypothesis: string; armA: string; armB: string; createdBy: string }): Promise<ExperimentRow> {
        const at = await clock.now();
        if (input.hypothesis.trim().length < 10) throw new Error("Write the hypothesis: what you change and what you expect (at least a sentence)");
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
        return store.insertExperiment({ campaignId: input.campaignId, hypothesis: input.hypothesis.trim(), metric: "click_rate", armA: a.id, armB: b.id, createdBy: input.createdBy });
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
        const j = judge(await armData(e.armA, at), await armData(e.armB, at), at, rails);
        if (j.verdict === "wait") return { experiment: e, verdict: "wait" as const, reasons: j.reasons, readyAt: j.readyAt, final: false };
        await store.conclude(id, j.verdict, { reasons: j.reasons, stats: j.stats, asOf: at.toISOString() }, at.toISOString());
        const st = await store.state(e.campaignId);
        if (j.verdict === "B") await store.patchState(e.campaignId, { incumbentEntryId: e.armB, lastAdoptedAt: at.toISOString() });
        else if (j.verdict === "A" && st.incumbentEntryId === null) await store.patchState(e.campaignId, { incumbentEntryId: e.armA });
        else if (j.verdict === "freeze") await store.patchState(e.campaignId, { frozen: true, frozenReason: j.reasons.join("; ") });
        await store.journalWrite(e.campaignId, "learning", "regulator", `Experiment ${id} "${e.hypothesis}": ${j.verdict === "B" ? "the challenger (B) won and is now the incumbent" : j.verdict === "A" ? "the control (A) stays" : j.verdict === "freeze" ? "FROZEN" : "inconclusive, nothing changes"}. ${j.reasons.join(" ")}`, { experiment: id, verdict: j.verdict, stats: j.stats });
        return { experiment: (await store.experiment(id))!, verdict: j.verdict, reasons: j.reasons, readyAt: null, final: true };
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
      complete: async (id: string, result: unknown) => { const t = await store.taskFinish(id, "done", result); if (!t) throw new Error(`Task ${id} is already finished or unknown`); return t; },
    },
  };
}
export type Regulator = ReturnType<typeof createRegulator>;
