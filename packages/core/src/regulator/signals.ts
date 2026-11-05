// Signals: what the regulator agent gets to see instead of raw data. Pure: numbers in, a small structured report out.
// Rates are smoothed over the last few MATURE sends (a filter against noise) and always come with sample size and an interval.
// A send is any published entry of any channel with a metrics source; a rate whose numbers no source reports is null, never 0.
import type { EntryMetrics, MetricName } from "../metrics/domain.ts";
import { brokenGuard, canPropose, isMature, judge, matureAt, type ArmData, type ProposalState, type Rails, type Verdict } from "./rails.ts";
import { minDetectableLift, wilson } from "./stats.ts";

export const GOAL_METRICS = ["click_rate", "complaint_rate", "unsubscribe_rate", "bounce_rate"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export type Goal = { metric: GoalMetric; kind: "target" | "limit"; value: number };

export type SendView = { entryId: string; title: string; campaignId: string; channel: string; sentAt: string | null; metrics: EntryMetrics };
export type ExperimentView = { id: string; hypothesis: string; armA: string; armB: string; status: "running" | "concluded"; verdict: string | null; createdAt: string; concludedAt: string | null; reasons?: string[] };

export const armOf = (v: SendView): ArmData => {
  const m = v.metrics.values;
  return { entryId: v.entryId, sentAt: v.sentAt, exposures: m.exposures ?? 0, clicks: m.clicks ?? 0, complaints: m.complaints ?? null, unsubscribes: m.unsubscribes ?? null };
};

/** Each goal is a rate: numerator over denominator. */
const GOAL_RATES: Record<GoalMetric, [MetricName, MetricName]> = {
  click_rate: ["clicks", "exposures"],
  complaint_rate: ["complaints", "exposures"],
  unsubscribe_rate: ["unsubscribes", "exposures"],
  bounce_rate: ["bounces", "sends"],
};

/** A rate pooled over sends: only sends that report both numbers count, so an unmeasured metric gives null, not a fake 0. */
function pooledRate(sends: SendView[], [k, n]: [MetricName, MetricName]): { value: number | null; sample: number } {
  let num = 0, den = 0;
  for (const s of sends) {
    const a = s.metrics.values[k], b = s.metrics.values[n];
    if (a === undefined || b === undefined) continue;
    num += a; den += b;
  }
  return { value: den > 0 ? num / den : null, sample: den };
}

export type Signals = {
  asOf: string;
  frozen: { frozen: boolean; reason: string | null };
  incumbent: { entryId: string; title: string } | null;
  goals: { metric: GoalMetric; kind: "target" | "limit"; value: number; current: number | null; sample: number; gap: number | null; ok: boolean | null }[];
  recent: { entryId: string; title: string; channel: string; sentAt: string | null; mature: boolean; maturesAt: string | null; /** null: no source reported exposures yet */ exposures: number | null; clickRate: number | null; clickRateCi: [number, number] | null; complaintRate: number | null; unsubscribeRate: number | null; guard: string | null }[];
  experiments: { running: (ExperimentView & { verdict: string; reasons: string[]; readyAt: string | null })[]; recentlyConcluded: ExperimentView[] };
  /** What the current audience size can show: effects smaller than `minDetectableLift` end inconclusive. */
  power: { exposuresPerArm: number; clickRate: number; minDetectableLift: number } | null;
  allowed: { proposeExperiment: { ok: boolean; reason: string | null } };
  notes: string[];
};

export function buildSignals(input: {
  asOf: Date; rails: Rails; goals: Goal[]; sends: SendView[]; state: ProposalState & { incumbentEntryId: string | null };
  experiments: ExperimentView[]; smoothing?: number;
}): Signals {
  const { asOf, rails, goals, experiments } = input;
  const k = input.smoothing ?? 3;
  const byEntry = new Map(input.sends.map((s) => [s.entryId, s]));
  const sorted = [...input.sends].sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""));
  const matured = sorted.filter((s) => isMature(armOf(s), asOf, rails));
  const window = matured.slice(0, k);

  const running = experiments.filter((e) => e.status === "running").map((e) => {
    const a = byEntry.get(e.armA), b = byEntry.get(e.armB);
    const empty: ArmData = { entryId: "", sentAt: null, exposures: 0, clicks: 0, complaints: null, unsubscribes: null };
    const j: Verdict = judge(a ? armOf(a) : { ...empty, entryId: e.armA }, b ? armOf(b) : { ...empty, entryId: e.armB }, asOf, rails);
    return { ...e, verdict: j.verdict, reasons: j.reasons, readyAt: j.readyAt };
  });
  const incumbent = input.state.incumbentEntryId ? byEntry.get(input.state.incumbentEntryId) : undefined;
  const notes: string[] = [];
  if (matured.length === 0) notes.push("No send has matured yet: there is nothing to regulate on. Wait for the first send to age.");
  if (window.length > 0 && window.length < k) notes.push(`Only ${window.length} matured send(s) so far, the smoothed rate is rough.`);

  return {
    asOf: asOf.toISOString(),
    frozen: { frozen: input.state.frozen, reason: input.state.frozenReason },
    incumbent: input.state.incumbentEntryId ? { entryId: input.state.incumbentEntryId, title: incumbent?.title ?? "(not sent yet)" } : null,
    goals: goals.map((g) => {
      const { value: current, sample } = pooledRate(window, GOAL_RATES[g.metric]);
      return { ...g, current, sample, gap: current === null ? null : g.kind === "target" ? g.value - current : current - g.value, ok: current === null ? null : g.kind === "target" ? current >= g.value : current <= g.value };
    }),
    recent: sorted.slice(0, 8).map((s) => {
      const a = armOf(s);
      const has = (m: MetricName) => s.metrics.values[m] !== undefined;
      const per = (k: number | null) => (k !== null && a.exposures > 0 ? k / a.exposures : null);
      const ci = has("clicks") && a.exposures > 0 ? wilson(a.clicks, a.exposures) : null;
      return { entryId: s.entryId, title: s.title, channel: s.channel, sentAt: s.sentAt, mature: isMature(a, asOf, rails), maturesAt: matureAt(s.sentAt, rails), exposures: has("exposures") ? a.exposures : null, clickRate: has("clicks") ? per(a.clicks) : null, clickRateCi: ci ? [ci.low, ci.high] : null, complaintRate: per(a.complaints), unsubscribeRate: per(a.unsubscribes), guard: brokenGuard(a, rails) };
    }),
    experiments: { running, recentlyConcluded: experiments.filter((e) => e.status === "concluded").slice(0, 5) },
    power: (() => {
      const clicks = pooledRate(window, GOAL_RATES.click_rate);
      const counted = window.filter((s) => s.metrics.values.clicks !== undefined && s.metrics.values.exposures !== undefined).length;
      const n = counted ? Math.round(clicks.sample / counted) : 0;
      const mde = minDetectableLift(clicks.value ?? 0, n);
      return mde === null ? null : { exposuresPerArm: n, clickRate: clicks.value!, minDetectableLift: mde };
    })(),
    allowed: { proposeExperiment: canPropose({ ...input.state, running: running.length }, asOf, rails) },
    notes,
  };
}
