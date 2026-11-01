// The brand's economics, pure: the profile a person sets, what costs are made of, and the formulas over them
// (docs/analytics.md, phase 3; the marketing specification's §0, §2 and §3). Numbers in, numbers out; no database.

export const BUSINESS_MODELS = ["ecommerce", "b2c_leads", "b2b_leads"] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

/** Set by a person on the always-on base; campaigns inherit it. Rates are shares (0.4 = 40 %), money is in `currency`. */
export type Profile = {
  model: BusinessModel;
  currency: string;
  /** Contribution margin share after cost of goods, shipping and fees; what ROMI and break-even ROAS rest on. */
  margin?: number;
  /** E-commerce: average order value. Leads: the value of a won deal. */
  orderValue?: number;
  /** Lead funnel: lead -> qualified, qualified -> customer. */
  leadToQualified?: number;
  qualifiedToCustomer?: number;
  /** What an hour of the reviewer costs. */
  hourlyRate?: number;
  /** Minutes a review takes when nobody timed it (CLI approvals), by tier. */
  reviewMinutes?: Partial<Record<"1" | "2" | "3", number>>;
  /** The e-mail provider's price per 1,000 sent. */
  espPerThousand?: number;
  /** Monthly LLM spend, spread over the campaigns by the entries agents wrote; and tools, kept at period level. */
  llmMonthly?: number;
  toolsMonthly?: number;
  targets?: { cpl?: number; cpql?: number; cac?: number };
};

export const DEFAULT_REVIEW_MINUTES = { "1": 0, "2": 3, "3": 10 } as const;
const MAX_REVIEW_MINUTES = 30;

const share = (v: unknown, name: string) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} is a share between 0 and 1 (0.4 = 40 %)`);
  return n;
};
const money = (v: unknown, name: string) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} is an amount of 0 or more`);
  return n;
};

/** Checks a profile a person entered; unknown keys are refused so a typo does not pass silently. */
export function validateProfile(input: Record<string, unknown>): Profile {
  const known = ["model", "currency", "margin", "orderValue", "leadToQualified", "qualifiedToCustomer", "hourlyRate", "reviewMinutes", "espPerThousand", "llmMonthly", "toolsMonthly", "targets"];
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`Unknown profile field(s): ${unknown.join(", ")} (known: ${known.join(", ")})`);
  if (!(BUSINESS_MODELS as readonly string[]).includes(String(input.model))) throw new Error(`model is one of ${BUSINESS_MODELS.join(", ")}`);
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency is a three-letter code (EUR, USD, CZK...)");
  const rm = (input.reviewMinutes ?? {}) as Record<string, unknown>;
  const t = (input.targets ?? {}) as Record<string, unknown>;
  const p: Profile = {
    model: input.model as BusinessModel, currency,
    margin: share(input.margin, "margin"), orderValue: money(input.orderValue, "orderValue"),
    leadToQualified: share(input.leadToQualified, "leadToQualified"), qualifiedToCustomer: share(input.qualifiedToCustomer, "qualifiedToCustomer"),
    hourlyRate: money(input.hourlyRate, "hourlyRate"), espPerThousand: money(input.espPerThousand, "espPerThousand"),
    llmMonthly: money(input.llmMonthly, "llmMonthly"), toolsMonthly: money(input.toolsMonthly, "toolsMonthly"),
    reviewMinutes: Object.fromEntries((["1", "2", "3"] as const).filter((k) => rm[k] !== undefined).map((k) => [k, money(rm[k], `reviewMinutes.${k}`)!])),
    targets: Object.fromEntries((["cpl", "cpql", "cac"] as const).filter((k) => t[k] !== undefined).map((k) => [k, money(t[k], `targets.${k}`)!])),
  };
  return JSON.parse(JSON.stringify(p));
}

/** Minutes a review took: the timer of the approval dialog when there was one (capped), the profile's default for the tier otherwise. */
export function reviewMinutes(e: { reviewSeconds: number | null; tier: 1 | 2 | 3 }, p: Profile | null): number {
  if (e.reviewSeconds !== null && e.reviewSeconds >= 0) return Math.min(MAX_REVIEW_MINUTES, e.reviewSeconds / 60);
  return p?.reviewMinutes?.[String(e.tier) as "1"] ?? DEFAULT_REVIEW_MINUTES[String(e.tier) as "1"];
}

export type Derived = { name: string; value: number | null; needs: string[]; formula: string };
const d = (name: string, formula: string, needs: string[], f: () => number): Derived => ({ name, formula, needs, value: needs.length ? null : f() });
const missing = (p: Profile | null, keys: (keyof Profile)[]) => (p === null ? ["the economics profile"] : keys.filter((k) => p[k] === undefined).map(String));

/** What the profile alone tells: the ceilings a campaign's costs must stay under to pay for themselves. */
export function derived(p: Profile | null): Derived[] {
  const leadToCustomer = p && p.leadToQualified !== undefined && p.qualifiedToCustomer !== undefined ? p.leadToQualified * p.qualifiedToCustomer : undefined;
  const leads = p?.model !== "ecommerce";
  return [
    d("break_even_roas", "1 / margin", missing(p, ["margin"]), () => 1 / p!.margin!),
    d("margin_per_order", "orderValue x margin", missing(p, ["orderValue", "margin"]), () => p!.orderValue! * p!.margin!),
    ...(leads ? [
      d("value_per_lead", "orderValue x margin x leadToQualified x qualifiedToCustomer", missing(p, ["orderValue", "margin", "leadToQualified", "qualifiedToCustomer"]), () => p!.orderValue! * p!.margin! * leadToCustomer!),
      d("value_per_qualified_lead", "orderValue x margin x qualifiedToCustomer", missing(p, ["orderValue", "margin", "qualifiedToCustomer"]), () => p!.orderValue! * p!.margin! * p!.qualifiedToCustomer!),
      d("cpl_max", "the value per lead: a lead may cost this much and still pay back", missing(p, ["orderValue", "margin", "leadToQualified", "qualifiedToCustomer"]), () => p!.orderValue! * p!.margin! * leadToCustomer!),
    ] : [
      d("cpa_max", "orderValue x margin: an order may cost this much and still pay back", missing(p, ["orderValue", "margin"]), () => p!.orderValue! * p!.margin!),
    ]),
  ];
}

export type GenCost = { format: string | null; status: string | null; units: number; money: number | null; assetId: string | null };
export type FormatRow = { format: string; generations: number; failed: number; done: number; units: number; money: number | null; approvedAssets: number; approvedShare: number | null; costPerApprovedAsset: number | null };

/**
 * Cost per approved asset per format: everything generated in the format (rejected and failed included) over the assets of that
 * format that made it into an approved entry. The specification's answer to "is creative economics needed": not per creative, per format.
 */
export function formats(costs: GenCost[], approved: Set<string>): FormatRow[] {
  const by = new Map<string, GenCost[]>();
  for (const c of costs) by.set(c.format ?? "unknown", [...(by.get(c.format ?? "unknown") ?? []), c]);
  return [...by.entries()].map(([format, rows]) => {
    const done = rows.filter((r) => r.status === "done").length, failed = rows.filter((r) => r.status === "failed").length;
    const approvedAssets = new Set(rows.filter((r) => r.assetId && approved.has(r.assetId)).map((r) => r.assetId!)).size;
    const money = rows.every((r) => r.money !== null) ? rows.reduce((t, r) => t + r.money!, 0) : null;
    return {
      format, generations: rows.length, failed, done, units: rows.reduce((t, r) => t + r.units, 0), money, approvedAssets,
      approvedShare: done > 0 ? approvedAssets / done : null, costPerApprovedAsset: money !== null && approvedAssets > 0 ? money / approvedAssets : null,
    };
  }).sort((a, b) => b.generations - a.generations);
}

export type ReviewEvent = { entryId: string; kind: string; at: string; reason: string | null };
/** Production: how much of what agents write passes first time, how many rounds it takes, how long until approval, and why it comes back. */
export function production(entries: { id: string; createdAt: string; events: ReviewEvent[] }[]) {
  const decided = entries.filter((e) => e.events.some((x) => x.kind === "approved" || x.kind === "cancelled"));
  const sendBacks = (e: (typeof entries)[number]) => e.events.filter((x) => x.kind === "changes_requested").length;
  const approved = decided.filter((e) => e.events.some((x) => x.kind === "approved"));
  const hours = approved.map((e) => (Date.parse(e.events.find((x) => x.kind === "approved")!.at) - Date.parse(e.createdAt)) / 3_600_000).sort((a, b) => a - b);
  const reasons: Record<string, number> = {};
  for (const e of entries) for (const x of e.events) if (x.kind === "changes_requested") reasons[x.reason ?? "unspecified"] = (reasons[x.reason ?? "unspecified"] ?? 0) + 1;
  return {
    entries: entries.length, decided: decided.length, approved: approved.length,
    firstPassRate: decided.length ? approved.filter((e) => sendBacks(e) === 0).length / decided.length : null,
    sendBacksPerEntry: decided.length ? decided.reduce((t, e) => t + sendBacks(e), 0) / decided.length : null,
    medianHoursToApproval: hours.length ? hours[Math.floor(hours.length / 2)] : null,
    reasons,
  };
}
