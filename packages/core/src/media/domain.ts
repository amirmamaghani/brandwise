// Paid media, pure: the ports a platform and a payment method implement, the spend limits, and the per-ad numbers (docs/analytics.md,
// phase 5). No database, no network.

/** One day of a platform's report for an ad. Platform conversions are its own count: indicative, reconciled with our leads. */
export type ReportDay = { day: string; spend: number; impressions: number; reach: number; clicks: number; conversions: number };
export type AdOrder = { key: string; name: string; text: string; link: string | null; assetUrl: string | null; budget: number; currency: string; days: number; objective: string; boostOf: string | null };

/** A platform that sells media: create (idempotent per key), change the budget, pause, report. */
export interface MediaBuyer {
  readonly id: string;
  /** Whether money has to be paid per order (an agent-payment seller); prepaid or invoiced accounts need no payment step. */
  readonly requiresPayment: boolean;
  create(order: AdOrder, payment: PaymentToken | null): Promise<{ externalId: string }>;
  setBudget(externalId: string, budget: number, payment: PaymentToken | null): Promise<void>;
  pause(externalId: string): Promise<void>;
  report(externalId: string, since: string, until: string): Promise<ReportDay[]>;
}
/** A token scoped to one seller and one amount, issued after approval; it lives only in the connector's memory. */
export type PaymentToken = { token: string; reference: string; seller: string; amount: number; currency: string; expiresAt: string };
/** A way to pay sellers that take agent payments (ACP: a token scoped to seller and amount). Idempotent per reference. */
export interface PaymentProvider {
  readonly id: string;
  authorize(input: { seller: string; amount: number; currency: string; reference: string }): Promise<PaymentToken>;
}

export type Limits = { maxPerOrder: number | null; dailyLimit: number | null; monthlyLimit: number | null; currency: string | null };
/**
 * May an order go ahead? Fails closed: without limits a person set, nothing is bought. `daily` is the order's budget spread over its
 * days, against what live orders already commit per day; `monthly` adds its whole budget to what started this month.
 */
export function checkLimits(o: { budget: number; days: number; currency: string }, l: Limits, committed: { perDay: number; month: number }): { ok: boolean; reason: string | null } {
  if (!l.maxPerOrder || !l.dailyLimit || !l.monthlyLimit) return { ok: false, reason: "no ads limits are set: a person sets ads.maxPerOrder, ads.dailyLimit and ads.monthlyLimit first" };
  if (!l.currency) return { ok: false, reason: "the brand has no currency: a person sets it in the economics profile, which the limits are counted in" };
  if (o.currency !== l.currency) return { ok: false, reason: `the order is in ${o.currency}, the brand's limits in ${l.currency}` };
  if (o.budget > l.maxPerOrder) return { ok: false, reason: `the budget ${o.budget} is over the limit of ${l.maxPerOrder} per order` };
  const perDay = o.budget / o.days;
  if (committed.perDay + perDay > l.dailyLimit) return { ok: false, reason: `${committed.perDay.toFixed(2)} a day is already committed; with ${perDay.toFixed(2)} more it would be over the daily limit of ${l.dailyLimit}` };
  if (committed.month + o.budget > l.monthlyLimit) return { ok: false, reason: `${committed.month.toFixed(2)} is already committed this month; with ${o.budget} more it would be over the monthly limit of ${l.monthlyLimit}` };
  return { ok: true, reason: null };
}

/**
 * Per ad: what the platform reports and what we measure. CPL and ROAS use media spend; the creative's production cost is added when it
 * is a real share of the spend (over 10 %), as the fully loaded CPL. Fatigue: the click-through of the last three days fell under 70 % of
 * the first three (with enough impressions to tell).
 */
export function adNumbers(days: ReportDay[], ours: { leads: number | null; qualified: number | null; revenue: number | null }, productionCost: number | null) {
  const sum = (k: keyof Omit<ReportDay, "day">) => days.reduce((t, d) => t + d[k], 0);
  const spend = sum("spend"), impressions = sum("impressions"), clicks = sum("clicks"), reach = days.reduce((m, d) => Math.max(m, d.reach), 0);
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const ctr = (ds: ReportDay[]) => { const i = ds.reduce((t, d) => t + d.impressions, 0); return i > 0 ? ds.reduce((t, d) => t + d.clicks, 0) / i : null; };
  const first = sorted.slice(0, 3), last = sorted.slice(-3);
  const enough = sorted.length >= 6 && first.reduce((t, d) => t + d.impressions, 0) >= 1000 && last.reduce((t, d) => t + d.impressions, 0) >= 1000;
  const fatigue = enough && ctr(first)! > 0 && ctr(last)! < 0.7 * ctr(first)!;
  const production = productionCost !== null && spend > 0 && productionCost > 0.1 * spend ? productionCost : 0;
  return {
    spend, impressions, clicks, reach, platformConversions: sum("conversions"),
    ctr: impressions > 0 ? clicks / impressions : null, cpc: clicks > 0 ? spend / clicks : null, cpm: impressions > 0 ? (1000 * spend) / impressions : null,
    frequency: reach > 0 ? impressions / reach : null, fatigue,
    leads: ours.leads, cpl: ours.leads ? spend / ours.leads : null, cpql: ours.qualified ? spend / ours.qualified : null, roas: ours.revenue !== null && spend > 0 ? ours.revenue / spend : null,
    productionCost: productionCost, fullyLoadedCpl: production > 0 && ours.leads ? (spend + production) / ours.leads : null,
  };
}
