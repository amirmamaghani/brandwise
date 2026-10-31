// Signals: what the regulator agent gets to see instead of raw data. Pure: numbers in, a small structured report out.
// Rates are smoothed over the last few MATURE sends (a filter against noise) and always come with sample size and an interval.
import type { Counts } from "../email/domain/types.ts";
import { brokenGuard, canPropose, isMature, judge, matureAt, type ArmData, type ProposalState, type Rails, type Verdict } from "./rails.ts";
import { minDetectableLift, wilson } from "./stats.ts";

export const GOAL_METRICS = ["click_rate", "complaint_rate", "unsubscribe_rate", "bounce_rate"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export type Goal = { metric: GoalMetric; kind: "target" | "limit"; value: number };

export type SendView = { entryId: string; title: string; campaignId: string; sentAt: string | null; counts: Counts };
export type ExperimentView = { id: string; hypothesis: string; armA: string; armB: string; status: "running" | "concluded"; verdict: string | null; createdAt: string; concludedAt: string | null; reasons?: string[] };

export const armOf = (v: SendView): ArmData => ({ entryId: v.entryId, sentAt: v.sentAt, delivered: v.counts.delivered, clicks: v.counts.clicked.unique, complaints: v.counts.complained, unsubscribes: v.counts.unsubscribed });

const rateOf = (metric: GoalMetric, a: { delivered: number; clicks: number; complaints: number; unsubscribes: number; bounced: number; sent: number }) =>
  metric === "click_rate" ? a.clicks / a.delivered : metric === "complaint_rate" ? a.complaints / a.delivered : metric === "unsubscribe_rate" ? a.unsubscribes / a.delivered : a.bounced / a.sent;

export type Signals = {
  asOf: string;
  frozen: { frozen: boolean; reason: string | null };
  incumbent: { entryId: string; title: string } | null;
  goals: { metric: GoalMetric; kind: "target" | "limit"; value: number; current: number | null; sample: number; gap: number | null; ok: boolean | null }[];
  recent: { entryId: string; title: string; sentAt: string | null; mature: boolean; maturesAt: string | null; delivered: number; clickRate: number | null; clickRateCi: [number, number] | null; complaintRate: number | null; unsubscribeRate: number | null; guard: string | null }[];
  experiments: { running: (ExperimentView & { verdict: string; reasons: string[]; readyAt: string | null })[]; recentlyConcluded: ExperimentView[] };
  /** What the current audience size can show: effects smaller than `minDetectableLift` end inconclusive. */
  power: { deliveredPerArm: number; clickRate: number; minDetectableLift: number } | null;
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
  const pooled = window.reduce((t, s) => ({ delivered: t.delivered + s.counts.delivered, clicks: t.clicks + s.counts.clicked.unique, complaints: t.complaints + s.counts.complained, unsubscribes: t.unsubscribes + s.counts.unsubscribed, bounced: t.bounced + s.counts.bounced.hard + s.counts.bounced.soft + s.counts.bounced.unknown, sent: t.sent + s.counts.sent }), { delivered: 0, clicks: 0, complaints: 0, unsubscribes: 0, bounced: 0, sent: 0 });

  const running = experiments.filter((e) => e.status === "running").map((e) => {
    const a = byEntry.get(e.armA), b = byEntry.get(e.armB);
    const empty: ArmData = { entryId: "", sentAt: null, delivered: 0, clicks: 0, complaints: 0, unsubscribes: 0 };
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
      const current = pooled.delivered > 0 && pooled.sent > 0 ? rateOf(g.metric, pooled) : null;
      return { ...g, current, sample: pooled.delivered, gap: current === null ? null : g.kind === "target" ? g.value - current : current - g.value, ok: current === null ? null : g.kind === "target" ? current >= g.value : current <= g.value };
    }),
    recent: sorted.slice(0, 8).map((s) => {
      const a = armOf(s);
      const ci = a.delivered > 0 ? wilson(a.clicks, a.delivered) : null;
      return { entryId: s.entryId, title: s.title, sentAt: s.sentAt, mature: isMature(a, asOf, rails), maturesAt: matureAt(s.sentAt, rails), delivered: a.delivered, clickRate: a.delivered > 0 ? a.clicks / a.delivered : null, clickRateCi: ci ? [ci.low, ci.high] : null, complaintRate: a.delivered > 0 ? a.complaints / a.delivered : null, unsubscribeRate: a.delivered > 0 ? a.unsubscribes / a.delivered : null, guard: brokenGuard(a, rails) };
    }),
    experiments: { running, recentlyConcluded: experiments.filter((e) => e.status === "concluded").slice(0, 5) },
    power: (() => {
      const n = window.length ? Math.round(pooled.delivered / window.length) : 0;
      const rate = pooled.delivered > 0 ? pooled.clicks / pooled.delivered : 0;
      const mde = minDetectableLift(rate, n);
      return mde === null ? null : { deliveredPerArm: n, clickRate: rate, minDetectableLift: mde };
    })(),
    allowed: { proposeExperiment: canPropose({ ...input.state, running: running.length }, asOf, rails) },
    notes,
  };
}
