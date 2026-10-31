// The rails: deterministic rules that make the regulator stable. Code, not prompt: an agent can ask, it cannot overrule.
// Each rule answers a known way a feedback loop goes wrong:
//   maturity            react only to data that has finished arriving (delay), otherwise the loop oscillates
//   minimum sample      do not decide on noise
//   significance + lift hysteresis: change the incumbent only for a clear and sizeable win
//   cooldown            let an adoption settle before the next change (one change at a time)
//   one running         one variable at a time, so a result has one cause
//   guards              complaints and unsubscribes are limits, not goals (Goodhart): breaking them stops the loop
import { compareRates, wilson, type RateComparison } from "./stats.ts";

export type Rails = {
  matureAfterHours: number;
  minDeliveredPerArm: number;
  significance: number;      // two-sided p-value must be below this
  minRelativeLift: number;   // and the winner must be at least this much better (0.1 = 10 %)
  cooldownHours: number;     // after an adoption
  maxRunning: number;
  guards: { complaintRate: number; unsubscribeRate: number };
};

export const DEFAULT_RAILS: Rails = {
  matureAfterHours: 24,
  minDeliveredPerArm: 200,
  significance: 0.05,
  minRelativeLift: 0.1,
  cooldownHours: 24,
  maxRunning: 1,
  guards: { complaintRate: 0.003, unsubscribeRate: 0.01 },
};

export type ArmData = { entryId: string; sentAt: string | null; delivered: number; clicks: number; complaints: number; unsubscribes: number };

const hours = (ms: number) => ms / 3_600_000;

/** When an arm's numbers are final enough to judge: null before it was sent. */
export const matureAt = (sentAt: string | null, rails: Rails): string | null =>
  sentAt === null ? null : new Date(Date.parse(sentAt) + rails.matureAfterHours * 3_600_000).toISOString();

export const isMature = (a: ArmData, asOf: Date, rails: Rails) => {
  const at = matureAt(a.sentAt, rails);
  return at !== null && Date.parse(at) <= asOf.getTime();
};

/** Which guard a set of numbers breaks, if any. Needs a minimum sample to count (rare events are noisy). */
export function brokenGuard(a: ArmData, rails: Rails): string | null {
  if (a.delivered < rails.minDeliveredPerArm) return null;
  if (a.complaints / a.delivered > rails.guards.complaintRate) return `complaint rate ${(100 * a.complaints / a.delivered).toFixed(2)} % is over the ${(100 * rails.guards.complaintRate).toFixed(2)} % limit`;
  if (a.unsubscribes / a.delivered > rails.guards.unsubscribeRate) return `unsubscribe rate ${(100 * a.unsubscribes / a.delivered).toFixed(2)} % is over the ${(100 * rails.guards.unsubscribeRate).toFixed(2)} % limit`;
  return null;
}

export type Verdict = {
  verdict: "wait" | "A" | "B" | "inconclusive" | "freeze";
  reasons: string[];
  /** For "wait": when to look again, if known. */
  readyAt: string | null;
  stats: (RateComparison & { ciA: { low: number; high: number }; ciB: { low: number; high: number } }) | null;
};

/**
 * Judge an A/B experiment (A = control, B = challenger) on click rate (unique clicks / delivered). Pure: same numbers, same verdict.
 * A (keep) is always the safe default; B needs to be clearly better AND safe.
 */
export function judge(a: ArmData, b: ArmData, asOf: Date, rails: Rails): Verdict {
  const waits: string[] = [];
  const pending: string[] = [];
  for (const [name, arm] of [["A", a], ["B", b]] as const) {
    const at = matureAt(arm.sentAt, rails);
    if (at === null) waits.push(`arm ${name} has not been sent yet`);
    else if (Date.parse(at) > asOf.getTime()) {
      waits.push(`arm ${name} matures in ${hours(Date.parse(at) - asOf.getTime()).toFixed(1)} h (${rails.matureAfterHours} h after sending)`);
      pending.push(at);
    }
  }
  if (waits.length > 0) return { verdict: "wait", reasons: waits, readyAt: pending.length > 0 ? pending.sort().at(-1)! : null, stats: null };

  const cmp = compareRates(a.clicks, a.delivered, b.clicks, b.delivered);
  const stats = { ...cmp, ciA: wilson(a.clicks, a.delivered), ciB: wilson(b.clicks, b.delivered) };
  const guardA = brokenGuard(a, rails), guardB = brokenGuard(b, rails);
  if (guardA && guardB) return { verdict: "freeze", reasons: [`both arms break a guard: A ${guardA}; B ${guardB}`], readyAt: null, stats };
  if (guardB) return { verdict: "A", reasons: [`B is unsafe: ${guardB}`], readyAt: null, stats };
  if (guardA) return { verdict: "B", reasons: [`A is unsafe (${guardA}), B is the safe arm`], readyAt: null, stats };
  const small = [["A", a], ["B", b]].filter(([, arm]) => (arm as ArmData).delivered < rails.minDeliveredPerArm).map(([n]) => n);
  if (small.length > 0) return { verdict: "inconclusive", reasons: [`too few delivered in arm ${small.join(" and ")} (minimum ${rails.minDeliveredPerArm})`], readyAt: null, stats };
  const clear = cmp.p < rails.significance && cmp.lift !== null && Math.abs(cmp.lift) >= rails.minRelativeLift;
  if (!clear) return { verdict: "inconclusive", reasons: [`no clear difference: lift ${cmp.lift === null ? "n/a" : (100 * cmp.lift).toFixed(1) + " %"}, p = ${cmp.p.toFixed(3)} (needs p < ${rails.significance} and a lift of at least ${100 * rails.minRelativeLift} %)`], readyAt: null, stats };
  return cmp.rateB > cmp.rateA
    ? { verdict: "B", reasons: [`B is clearly better: lift ${(100 * cmp.lift!).toFixed(1)} %, p = ${cmp.p.toFixed(4)}`], readyAt: null, stats }
    : { verdict: "A", reasons: [`A is clearly better: B is ${(100 * -cmp.lift!).toFixed(1)} % lower, p = ${cmp.p.toFixed(4)}`], readyAt: null, stats };
}

export type ProposalState = { frozen: boolean; frozenReason: string | null; running: number; lastAdoptedAt: string | null };

/** May a new experiment start now? One answer with the reason, so the agent can explain it. */
export function canPropose(s: ProposalState, asOf: Date, rails: Rails): { ok: boolean; reason: string | null } {
  if (s.frozen) return { ok: false, reason: `the campaign is frozen: ${s.frozenReason ?? "a guard was broken"}; a person must clear it` };
  if (s.running >= rails.maxRunning) return { ok: false, reason: `${s.running} experiment(s) already running (one variable at a time)` };
  if (s.lastAdoptedAt !== null) {
    const waitMs = Date.parse(s.lastAdoptedAt) + rails.cooldownHours * 3_600_000 - asOf.getTime();
    if (waitMs > 0) return { ok: false, reason: `cooldown after the last change: ${hours(waitMs).toFixed(1)} h left` };
  }
  return { ok: true, reason: null };
}
