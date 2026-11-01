// The rails: deterministic rules that make the regulator stable. Code, not prompt: an agent can ask, it cannot overrule.
// Each rule answers a known way a feedback loop goes wrong:
//   maturity            react only to data that has finished arriving (delay), otherwise the loop oscillates
//   minimum sample      do not decide on noise
//   significance + lift hysteresis: change the incumbent only for a clear and sizeable win
//   cooldown            let an adoption settle before the next change (one change at a time)
//   one running         one variable at a time, so a result has one cause
//   guards              complaints and unsubscribes are limits, not goals (Goodhart): breaking them stops the loop
import { cmh, compareRates, exactRateTest, wilson, worseOneSided, type RateComparison } from "./stats.ts";

export type Rails = {
  matureAfterHours: number;
  /** Leads come hours to days after the click: when an arm's leads are measured, it is judged this long after sending. */
  leadMatureAfterHours: number;
  /** A challenger with significantly fewer leads than the control is unsafe, however it clicks (the proxy trap); needs some leads at all. */
  leadGuard: { significance: number; minControlLeads: number };
  minDeliveredPerArm: number;
  significance: number;      // two-sided p-value must be below this
  minRelativeLift: number;   // and the winner must be at least this much better (0.1 = 10 %)
  cooldownHours: number;     // after an adoption
  maxRunning: number;
  /**
   * Limits, not goals. An arm is unsafe at the complaint ceiling (complaintRate, point estimate, at least complaintMinEvents events), when
   * its complaints are clearly above complaintTarget (the lower end of their 95 % interval is), or above unsubscribeRate. The challenger
   * is also unsafe when it has significantly more complaints or unsubscribes than the control (worseSignificance, worseMinEvents).
   * Guards are checked at every look of a series, so they are strict about evidence: a false alarm stops a good variant.
   */
  guards: { complaintRate: number; complaintMinEvents: number; complaintTarget: number; unsubscribeRate: number; worseSignificance: number; worseMinEvents: number };
};

export const DEFAULT_RAILS: Rails = {
  matureAfterHours: 24,
  leadMatureAfterHours: 72,
  leadGuard: { significance: 0.05, minControlLeads: 3 },
  minDeliveredPerArm: 200,
  significance: 0.05,
  minRelativeLift: 0.1,
  cooldownHours: 24,
  maxRunning: 1,
  guards: { complaintRate: 0.003, complaintMinEvents: 2, complaintTarget: 0.001, unsubscribeRate: 0.01, worseSignificance: 0.01, worseMinEvents: 3 },
};

/** `measured` says what the provider reports; a guard on something it does not report is unavailable, never a 0 %. */
export type ArmData = { entryId: string; sentAt: string | null; delivered: number; clicks: number; complaints: number; unsubscribes: number; measured?: { complaints?: boolean; unsubscribes?: boolean }; /** leads traced to the entry; undefined when no conversion source measures them */ leads?: number };
/** What an experiment is decided on: clicks (the proxy) or leads (closer to money, rarer). */
export type PrimaryMetric = "click_rate" | "lead_rate";
/** One pair of sends of a series; a single A/B test is a series of one round. */
export type Round = { a: ArmData; b: ArmData };

const hours = (ms: number) => ms / 3_600_000;
const measures = (a: ArmData, what: "complaints" | "unsubscribes") => a.measured?.[what] !== false;

/** When an arm's numbers are final enough to judge: null before it was sent. Arms whose leads are measured wait for their leads. */
export const matureAt = (sentAt: string | null, rails: Rails, leads = false): string | null =>
  sentAt === null ? null : new Date(Date.parse(sentAt) + (leads ? rails.leadMatureAfterHours : rails.matureAfterHours) * 3_600_000).toISOString();

export const isMature = (a: ArmData, asOf: Date, rails: Rails) => {
  const at = matureAt(a.sentAt, rails);
  return at !== null && Date.parse(at) <= asOf.getTime();
};

/** Which absolute limit a set of numbers breaks, if any. Needs a minimum sample to count (rare events are noisy). */
export function brokenGuard(a: ArmData, rails: Rails): string | null {
  if (a.delivered < rails.minDeliveredPerArm) return null;
  const g = rails.guards;
  if (measures(a, "complaints") && a.complaints >= g.complaintMinEvents && a.complaints / a.delivered >= g.complaintRate) return `complaint rate ${(100 * a.complaints / a.delivered).toFixed(2)} % is at or over the ${(100 * g.complaintRate).toFixed(2)} % limit`;
  if (measures(a, "complaints") && wilson(a.complaints, a.delivered).low >= g.complaintTarget) return `complaint rate ${(100 * a.complaints / a.delivered).toFixed(2)} % is clearly above the ${(100 * g.complaintTarget).toFixed(2)} % target (95 % interval from ${(100 * wilson(a.complaints, a.delivered).low).toFixed(2)} %)`;
  if (measures(a, "unsubscribes") && a.unsubscribes / a.delivered > g.unsubscribeRate) return `unsubscribe rate ${(100 * a.unsubscribes / a.delivered).toFixed(2)} % is over the ${(100 * g.unsubscribeRate).toFixed(2)} % limit`;
  return null;
}

/** The challenger is unsafe too when it is significantly worse than the control on a guarded rate. */
function worseThanControl(a: ArmData, b: ArmData, rails: Rails): string | null {
  const g = rails.guards;
  for (const [what, label] of [["complaints", "complaints"], ["unsubscribes", "unsubscribes"]] as const) {
    if (!measures(a, what) || !measures(b, what) || b[what] < g.worseMinEvents) continue;
    const p = worseOneSided(a[what], a.delivered, b[what], b.delivered);
    if (p < g.worseSignificance) return `significantly more ${label} than the control (${(100 * b[what] / b.delivered).toFixed(2)} % against ${(100 * a[what] / (a.delivered || 1)).toFixed(2)} %, p = ${p.toFixed(3)})`;
  }
  return null;
}

/** Guards the provider cannot report: said, so nobody reads them as 0 %. */
export function unavailableGuards(arms: ArmData[]): string[] {
  const out: string[] = [];
  if (arms.some((a) => !measures(a, "complaints"))) out.push("complaint guard unavailable: the provider does not report complaints");
  if (arms.some((a) => !measures(a, "unsubscribes"))) out.push("unsubscribe guard unavailable: the provider does not report unsubscribes");
  return out;
}

export type Verdict = {
  /** wait: data still arriving; next_round: every round so far is mature, the series needs its next pair; the rest are final. */
  verdict: "wait" | "next_round" | "A" | "B" | "inconclusive" | "freeze";
  reasons: string[];
  /** For "wait": when to look again, if known. */
  readyAt: string | null;
  stats: (RateComparison & { ciA: { low: number; high: number }; ciB: { low: number; high: number }; rounds: number }) | null;
  /** When leads are measured on a click experiment: what the arms brought, which a click win must not lose. */
  leads?: { a: number; b: number; rateA: number; rateB: number; lift: number | null; fewerP: number } | null;
};

const pool = (arms: ArmData[], entryId: string): ArmData => ({
  entryId, sentAt: arms.map((a) => a.sentAt).filter((x): x is string => x !== null).sort().at(-1) ?? null,
  delivered: arms.reduce((t, a) => t + a.delivered, 0), clicks: arms.reduce((t, a) => t + a.clicks, 0),
  complaints: arms.reduce((t, a) => t + a.complaints, 0), unsubscribes: arms.reduce((t, a) => t + a.unsubscribes, 0),
  measured: { complaints: arms.every((a) => measures(a, "complaints")), unsubscribes: arms.every((a) => measures(a, "unsubscribes")) },
  leads: arms.every((a) => a.leads !== undefined) ? arms.reduce((t, a) => t + a.leads!, 0) : undefined,
});

/**
 * Judge an A/B series (A = control, B = challenger) on click rate (unique clicks / delivered). Pure: same numbers, same verdict.
 * Fixed horizon: no verdict on the primary metric before all `plannedRounds` rounds are mature (no peeking), but a broken guard stops
 * the series at once. One round is a two-proportion z-test; several are pooled with Cochran-Mantel-Haenszel. A (keep) is the safe
 * default; B needs to be clearly better AND safe.
 */
export function judgeSeries(rounds: Round[], plannedRounds: number, asOf: Date, rails: Rails, metric: PrimaryMetric = "click_rate"): Verdict {
  if (rounds.length === 0) return { verdict: "wait", reasons: ["no round has been started yet"], readyAt: null, stats: null };
  const leadsMeasured = rounds.every((r) => r.a.leads !== undefined && r.b.leads !== undefined);
  if (metric === "lead_rate" && !leadsMeasured) return { verdict: "inconclusive", reasons: ["leads are not measured for this brand (no conversion source): a lead experiment cannot be judged"], readyAt: null, stats: null };
  const waits: string[] = [];
  const pending: string[] = [];
  rounds.forEach((r, i) => {
    for (const [name, arm] of [["A", r.a], ["B", r.b]] as const) {
      const at = matureAt(arm.sentAt, rails, leadsMeasured), tag = rounds.length > 1 ? `round ${i + 1} arm ${name}` : `arm ${name}`;
      if (at === null) waits.push(`${tag} has not been sent yet`);
      else if (Date.parse(at) > asOf.getTime()) {
        waits.push(`${tag} matures in ${hours(Date.parse(at) - asOf.getTime()).toFixed(1)} h (${leadsMeasured ? `${rails.leadMatureAfterHours} h after sending: its leads are still coming` : `${rails.matureAfterHours} h after sending`})`);
        pending.push(at);
      }
    }
  });
  if (waits.length > 0) return { verdict: "wait", reasons: waits, readyAt: pending.length > 0 ? pending.sort().at(-1)! : null, stats: null };

  const a = pool(rounds.map((r) => r.a), rounds[0].a.entryId), b = pool(rounds.map((r) => r.b), rounds[0].b.entryId);
  const single = rounds.length === 1;
  const k = (x: ArmData) => (metric === "lead_rate" ? x.leads ?? 0 : x.clicks);
  const c = single ? (metric === "lead_rate" ? (() => {
    const x = exactRateTest(k(a), a.delivered, k(b), b.delivered), rateA = a.delivered ? k(a) / a.delivered : 0, rateB = b.delivered ? k(b) / b.delivered : 0;
    return { rateA, rateB, lift: x.rateRatio === null ? null : x.rateRatio - 1, z: 0, p: x.p };
  })() : compareRates(k(a), a.delivered, k(b), b.delivered)) : (() => {
    const m = cmh(rounds.map((r) => ({ kA: k(r.a), nA: r.a.delivered, kB: k(r.b), nB: r.b.delivered })));
    return { rateA: a.delivered ? k(a) / a.delivered : 0, rateB: b.delivered ? k(b) / b.delivered : 0, lift: m.lift, z: m.z, p: m.p };
  })();
  const stats = { ...c, ciA: wilson(k(a), a.delivered), ciB: wilson(k(b), b.delivered), rounds: rounds.length };
  const notes = unavailableGuards([a, b]);
  if (metric === "click_rate" && !leadsMeasured) notes.push("leads are not measured: a clickbait winner can only be caught by complaints and unsubscribes");
  const leadCheck = metric === "click_rate" && leadsMeasured && (a.leads ?? 0) >= rails.leadGuard.minControlLeads ? (() => {
    const x = exactRateTest(a.leads!, a.delivered, b.leads!, b.delivered);
    return { a: a.leads!, b: b.leads!, rateA: a.leads! / (a.delivered || 1), rateB: b.leads! / (b.delivered || 1), lift: x.rateRatio === null ? null : x.rateRatio - 1, fewerP: x.fewer };
  })() : null;
  const leadGuard = leadCheck && leadCheck.fewerP < rails.leadGuard.significance
    ? `significantly fewer leads than the control (${leadCheck.b} against ${leadCheck.a}, ${(100 * leadCheck.rateB).toFixed(2)} % against ${(100 * leadCheck.rateA).toFixed(2)} % of delivered, p = ${leadCheck.fewerP.toFixed(3)})` : null;
  const guardA = brokenGuard(a, rails), guardB = brokenGuard(b, rails) ?? (a.delivered >= rails.minDeliveredPerArm && b.delivered >= rails.minDeliveredPerArm ? worseThanControl(a, b, rails) ?? leadGuard : null);
  if (guardA && guardB) return { verdict: "freeze", reasons: [`both arms break a guard: A ${guardA}; B ${guardB}`, ...notes], readyAt: null, stats };
  if (guardB) return { verdict: "A", reasons: [`B is unsafe: ${guardB}`, ...notes], readyAt: null, stats, leads: leadCheck };
  if (guardA) return { verdict: "B", reasons: [`A is unsafe (${guardA}), B is the safe arm`, ...notes], readyAt: null, stats };
  if (rounds.length < plannedRounds) return { verdict: "next_round", reasons: [`round ${rounds.length} of ${plannedRounds} is mature: send the next pair with the same change (no verdict before round ${plannedRounds})`, ...notes], readyAt: null, stats: null };
  const small = [["A", a], ["B", b]].filter(([, arm]) => (arm as ArmData).delivered < rails.minDeliveredPerArm).map(([n]) => n);
  if (small.length > 0) return { verdict: "inconclusive", reasons: [`too few delivered in arm ${small.join(" and ")} (minimum ${rails.minDeliveredPerArm})`, ...notes], readyAt: null, stats };
  const how = (metric === "lead_rate" ? " on leads" : "") + (single ? "" : ` over ${rounds.length} rounds (Cochran-Mantel-Haenszel)`);
  const clear = c.p < rails.significance && c.lift !== null && Math.abs(c.lift) >= rails.minRelativeLift;
  if (!clear) return { verdict: "inconclusive", reasons: [`no clear difference${how}: lift ${c.lift === null ? "n/a" : (100 * c.lift).toFixed(1) + " %"}, p = ${c.p.toFixed(3)} (needs p < ${rails.significance} and a lift of at least ${100 * rails.minRelativeLift} %)`, ...notes], readyAt: null, stats };
  if (c.lift! > 0 && leadCheck && leadCheck.lift !== null && leadCheck.lift <= -rails.minRelativeLift) {
    // the proxy trap: a click win that brings fewer leads is not adopted, even before the difference in leads is significant
    return { verdict: "A", reasons: [`B is not adopted: it wins on clicks${how} (+${(100 * c.lift!).toFixed(1)} %) but brings fewer leads (${leadCheck.b} against ${leadCheck.a}, ${(100 * leadCheck.lift).toFixed(0)} %); a click win has to bring leads`, ...notes], readyAt: null, stats, leads: leadCheck };
  }
  return c.lift! > 0
    ? { verdict: "B", reasons: [`B is clearly better${how}: lift ${(100 * c.lift!).toFixed(1)} %, p = ${c.p.toFixed(4)}`, ...notes], readyAt: null, stats, leads: leadCheck }
    : { verdict: "A", reasons: [`A is clearly better${how}: B is ${(100 * -c.lift!).toFixed(1)} % lower, p = ${c.p.toFixed(4)}`, ...notes], readyAt: null, stats, leads: leadCheck };
}

/** A single A/B test: a series of one round. */
export const judge = (a: ArmData, b: ArmData, asOf: Date, rails: Rails): Verdict => judgeSeries([{ a, b }], 1, asOf, rails);

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
