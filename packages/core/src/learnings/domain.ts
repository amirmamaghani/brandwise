// Learnings, pure: levers, decay, weights, which learning wins, the explore/exploit slot and the brief an agent reads before writing.
// No database, no clock: numbers and rows in, decisions out. The rules are in docs/analytics.md (phase 1).
import { createHash } from "node:crypto";

export type Lever = { attribute: string; from: string; to: string };
export type Evidence = "E1" | "E2" | "E3";
export type Kind = "performance" | "null_result" | "reviewer_preference";
export type Result = "better" | "worse" | "unsafe" | "no_difference";
export type StoredStatus = "proposed" | "active" | "superseded" | "retired";
/** What a reader sees: `needs_retest` is computed (aged out, or contradicted by what happened when it was applied). */
export type Status = StoredStatus | "needs_retest";

export type Learning = {
  id: string; campaignId: string; scope: "campaign" | "brand"; kind: Kind; evidence: Evidence | null; result: Result | null;
  statement: string; channel: string | null; lever: Lever | null; metric: string | null; effect: number | null;
  ciLow: number | null; ciHigh: number | null; nPerArm: number | null; mde: number | null; method: string | null;
  context: Record<string, unknown>; experimentId: string | null; sourceIds: string[]; status: StoredStatus;
  supersededBy: string | null; createdBy: string; confirmedBy: string | null; decidedAt: string; createdAt: string;
};

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const value = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();

/** "subject_style: plain -> number" (or "subject_style:plain->number") into a lever. One variable per experiment. */
export function parseLever(text: string): Lever {
  const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*->\s*(.+?)\s*$/.exec(text);
  if (!m) throw new Error(`Give the lever as "attribute: from -> to", e.g. "subject_style: plain -> number" (got "${text}")`);
  const lever = { attribute: slug(m[1]), from: value(m[2]), to: value(m[3]) };
  if (!lever.attribute || !lever.from || !lever.to) throw new Error(`The lever needs an attribute, a from and a to value (got "${text}")`);
  if (lever.from === lever.to) throw new Error("A lever changes something: from and to are the same");
  return lever;
}
export const leverText = (l: Lever) => `${l.attribute}: ${l.from} -> ${l.to}`;
/** The same lever whichever way round it was tested. */
export const leverKey = (l: Lever) => `${l.attribute}|${[l.from, l.to].sort().join("|")}`;
const canonical = (l: Lever) => [l.from, l.to].sort()[0] === l.from;
/** +1 when `to` won, -1 when it lost or was unsafe, 0 for no difference; expressed in the lever's canonical orientation. */
export function direction(l: Pick<Learning, "lever" | "result">): number {
  if (!l.lever || !l.result) return 0;
  if (l.result === "no_difference") return 0;
  const raw = l.result === "better" ? 1 : -1;
  return canonical(l.lever) ? raw : -raw;
}

/** How fast a kind of finding goes stale (days to half weight). Trends fade fast, tone and style slowly. */
export const HALF_LIFE_DAYS = { trend: 60, offer: 135, timing: 180, style: 365, default: 180 } as const;
const CATEGORY: Record<string, keyof typeof HALF_LIFE_DAYS> = {
  hook: "trend", visual_style: "trend", format: "trend", angle: "trend",
  offer: "offer", price: "offer", discount: "offer", incentive: "offer",
  send_time: "timing", send_daypart: "timing", weekday: "timing", frequency: "timing",
  subject: "style", subject_style: "style", subject_number: "style", subject_personal: "style", subject_question: "style", subject_caps: "style",
  tone: "style", style: "style", length: "style", cta: "style", cta_label: "style", headline: "style", greeting: "style", template: "style", body: "style",
};
export const categoryOf = (attribute: string | undefined) => (attribute && CATEGORY[attribute]) || "default";
export const halfLifeDays = (l: Pick<Learning, "lever" | "kind">) => (l.kind === "reviewer_preference" ? HALF_LIFE_DAYS.style : HALF_LIFE_DAYS[categoryOf(l.lever?.attribute)]);

export const EVIDENCE_FACTOR: Record<Evidence, number> = { E1: 1, E2: 0.6, E3: 0.2 };
const DAY = 86_400_000;
/** 1 when new, 0.5 after one half-life. */
export const decay = (l: Pick<Learning, "decidedAt" | "lever" | "kind">, asOf: Date) =>
  Math.pow(0.5, Math.max(0, asOf.getTime() - Date.parse(l.decidedAt)) / DAY / halfLifeDays(l));
/** When to look again: after two half-lives the weight is a quarter and the learning asks for a re-test. */
export const reviewAt = (l: Pick<Learning, "decidedAt" | "lever" | "kind">) => new Date(Date.parse(l.decidedAt) + 2 * halfLifeDays(l) * DAY).toISOString();
/** Applications that went clearly the other way before a learning is doubted. */
export const CONTRARY_LIMIT = 5;

export function effectiveStatus(l: Learning, asOf: Date, contrary = 0): Status {
  if (l.status !== "active") return l.status;
  if (l.kind === "reviewer_preference" || l.evidence === "E3") return "active";
  if (decay(l, asOf) < 0.25 || contrary >= CONTRARY_LIMIT) return "needs_retest";
  return "active";
}

/** Weight for ordering: evidence x age x status. A reviewer preference is a rule, not evidence: it weighs by age only. */
export function weight(l: Learning, asOf: Date, contrary = 0): number {
  const s = effectiveStatus(l, asOf, contrary);
  const statusFactor = s === "active" ? 1 : s === "needs_retest" ? 0.5 : 0;
  return (l.evidence ? EVIDENCE_FACTOR[l.evidence] : 1) * decay(l, asOf) * statusFactor;
}

const RANK: Record<Evidence, number> = { E1: 3, E2: 2, E3: 1 };
/**
 * Which existing learnings a new one replaces: the same lever in the same owner, decided earlier, with evidence no stronger than the
 * new one. E3 replaces nothing (it is a hypothesis). Agreeing results are replaced too, so each lever has one current answer.
 */
export function supersededBy(newer: Learning, existing: Learning[]): string[] {
  if (!newer.lever || !newer.evidence || newer.evidence === "E3" || newer.kind === "reviewer_preference") return [];
  const key = leverKey(newer.lever);
  return existing.filter((o) => o.id !== newer.id && o.status === "active" && o.campaignId === newer.campaignId && o.lever && leverKey(o.lever) === key
    && o.kind !== "reviewer_preference" && o.evidence !== null && RANK[o.evidence] <= RANK[newer.evidence!] && Date.parse(o.decidedAt) <= Date.parse(newer.decidedAt))
    .map((o) => o.id);
}

/**
 * Campaign-level findings that agree in at least two campaigns of a brand become a brand learning (the code makes the copy).
 * Returns groups of learning ids to promote; a lever that already has a current brand learning is skipped.
 */
export function promotions(campaignLevel: Learning[], brandLevel: Learning[]): Learning[][] {
  const known = new Set(brandLevel.filter((l) => l.status === "active" && l.lever).map((l) => leverKey(l.lever!)));
  const groups = new Map<string, Learning[]>();
  for (const l of campaignLevel) {
    if (l.status !== "active" || l.kind !== "performance" || !l.lever || (l.evidence !== "E1" && l.evidence !== "E2")) continue;
    const k = `${leverKey(l.lever)}#${direction(l)}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.values()].filter((g) => new Set(g.map((l) => l.campaignId)).size >= 2 && !known.has(leverKey(g[0].lever!)));
}

/** Share of slots for trying new things: half while little is known, down to a fifth once ten things are confirmed. */
export const exploreShare = (confirmed: number) => Math.min(0.5, Math.max(0.2, 1 - confirmed / 10));
/** Deterministic: the same campaign and day always get the same answer, so a brief can be reproduced. */
export function isExplore(campaignId: string, day: string, share: number): boolean {
  const h = createHash("sha256").update(`${campaignId}|${day}|explore`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < share;
}

/**
 * An entry that follows a learning (uses `to` when it is better, keeps `from` when `to` is worse) and does clearly worse than the brand's
 * baseline counts against it. "unsafe" learnings are about complaints and unsubscribes, which a click outcome cannot contradict.
 */
export function isContrary(l: Pick<Learning, "result">, outcome: { rate: number; high: number; low: number; baseline: number }): boolean {
  if (l.result === "better" || l.result === "worse") return outcome.high < outcome.baseline;
  return false;
}

export type BriefLine = { id: string; evidence: Evidence | null; scope: string; weight: number; statement: string; lever: string | null; reviewAt: string | null };
export type BriefPayload = {
  campaign: string; channel: string | null; day: string; slot: "exploit" | "explore"; exploreShare: number;
  inForce: BriefLine[]; doNotRetest: BriefLine[]; needsRetest: BriefLine[]; candidates: BriefLine[]; styleRules: BriefLine[];
  recentFeedback: { entryId: string; at: string; note: string; reason: string | null }[];
  diversity: string[];
};

/** The brief: what is known (strongest first), what not to test again, what to test, and the reviewer's rules. Specific beats general. */
export function composeBrief(input: {
  campaign: string; campaignId: string; channel: string | null; day: string; asOf: Date;
  learnings: (Learning & { contrary: number })[];
  feedback: BriefPayload["recentFeedback"];
  recentAttributes: Record<string, string>[];
}): BriefPayload {
  const { asOf } = input;
  const usable = input.learnings.filter((l) => !input.channel || !l.channel || l.channel === input.channel);
  // campaign scope beats brand scope on the same lever
  const campaignKeys = new Set(usable.filter((l) => l.scope === "campaign" && l.lever && l.status === "active").map((l) => leverKey(l.lever!)));
  const visible = usable.filter((l) => !(l.scope === "brand" && l.lever && campaignKeys.has(leverKey(l.lever))));
  const line = (l: Learning & { contrary: number }): BriefLine => ({ id: l.id, evidence: l.evidence, scope: l.scope, weight: Math.round(weight(l, asOf, l.contrary) * 100) / 100, statement: l.statement, lever: l.lever ? leverText(l.lever) : null, reviewAt: l.kind === "reviewer_preference" || l.evidence === "E3" ? null : reviewAt(l) });
  const status = (l: Learning & { contrary: number }) => effectiveStatus(l, asOf, l.contrary);
  const byWeight = (a: BriefLine, b: BriefLine) => b.weight - a.weight;
  const confirmed = visible.filter((l) => l.kind === "performance" && l.evidence === "E1" && status(l) === "active").length;
  const share = exploreShare(confirmed);

  const counts = new Map<string, number>();
  for (const attrs of input.recentAttributes) for (const [k, v] of Object.entries(attrs)) counts.set(`${k}=${v}`, (counts.get(`${k}=${v}`) ?? 0) + 1);
  const n = input.recentAttributes.length;
  const diversity = n >= 4 ? [...counts.entries()].filter(([, c]) => c / n >= 0.75 && c >= 4).map(([kv, c]) => `${kv} was used in ${c} of the last ${n} entries: vary something else this time`) : [];

  return {
    campaign: input.campaign, channel: input.channel, day: input.day,
    slot: isExplore(input.campaignId, input.day, share) ? "explore" : "exploit", exploreShare: Math.round(share * 100) / 100,
    inForce: visible.filter((l) => l.kind === "performance" && l.evidence !== "E3" && status(l) === "active").map(line).sort(byWeight).slice(0, 12),
    doNotRetest: visible.filter((l) => l.kind === "null_result" && status(l) === "active").map(line).sort(byWeight).slice(0, 12),
    needsRetest: visible.filter((l) => l.kind !== "reviewer_preference" && status(l) === "needs_retest").map(line).sort(byWeight).slice(0, 6),
    candidates: visible.filter((l) => l.evidence === "E3" && status(l) === "active").map(line).sort(byWeight).slice(0, 8),
    styleRules: visible.filter((l) => l.kind === "reviewer_preference" && status(l) === "active").map(line).sort(byWeight).slice(0, 12),
    recentFeedback: input.feedback.slice(0, 5),
    diversity,
  };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)} %`);
export function briefText(id: string, b: BriefPayload): string {
  const out = [`Brief ${id} for "${b.campaign}"${b.channel ? ` / ${b.channel}` : ""} (${b.day}): ${b.slot} slot (explore share ${Math.round(b.exploreShare * 100)} %)`];
  const section = (title: string, rows: BriefLine[], extra = "") => {
    if (rows.length === 0) return;
    out.push("", `${title}${extra}`);
    for (const r of rows) out.push(`  ${r.id}  ${r.evidence ?? "rule"}  w=${r.weight.toFixed(2)}  ${r.scope.padEnd(8)} ${r.statement}${r.reviewAt ? `   (review ${r.reviewAt.slice(0, 10)})` : ""}`);
  };
  section("Learnings in force (apply these, cite their ids):", b.inForce);
  section("Do not test again at the same size (no difference found):", b.doNotRetest);
  section("Aged or contradicted, worth a re-test:", b.needsRetest);
  section("Candidates to test (E3: only in explore slots or as an experiment):", b.candidates);
  section("Style rules from reviews (a person's preference, not evidence):", b.styleRules);
  if (b.recentFeedback.length) {
    out.push("", "Recent send-backs:");
    for (const f of b.recentFeedback) out.push(`  ${f.at.slice(0, 10)}  ${f.entryId}${f.reason ? ` [${f.reason}]` : ""}: ${f.note}`);
  }
  for (const d of b.diversity) out.push("", `Diversity: ${d}`);
  if (b.inForce.length + b.doNotRetest.length + b.candidates.length + b.styleRules.length === 0) out.push("", "Nothing is known yet for this campaign: write from the product pack, and test ideas through experiments.");
  out.push("", b.slot === "explore"
    ? "This is an explore slot: try one untested idea (an E3 candidate or your own), name it with --tests."
    : "This is an exploit slot: apply what is known, do not spend it on an untested idea.");
  out.push(`When you add the entry: --brief-id ${id} --applies <ids> [--tests <id>] [--tag key=value,...]`);
  return out.join("\n");
}

/** How a learning is written for people and agents. */
export function statementFor(l: { lever: Lever | null; result: Result; metric: string; effect: number | null; ciLow: number | null; ciHigh: number | null; nPerArm: number | null; mde: number | null; note?: string }): string {
  const lever = l.lever ? `${l.lever.attribute} "${l.lever.from}" -> "${l.lever.to}"` : "the challenger";
  const n = l.nPerArm ? `, n=2x${l.nPerArm.toLocaleString("en-US")}` : "";
  const metric = l.metric.replace(/_/g, " ");
  if (l.result === "no_difference") return `${lever}: no difference in ${metric} above ${pct(l.mde)}${n}${l.note ? ` (${l.note})` : ""}`;
  if (l.result === "unsafe") return `${lever}: unsafe, ${l.note ?? "it broke a guard"}${n}`;
  const ci = l.ciLow !== null && l.ciHigh !== null ? ` (95 % CI ${pct(l.ciLow)}..${pct(l.ciHigh)})` : "";
  return `${lever}: ${pct(l.effect)} ${metric}${ci}${n}${l.result === "worse" ? ", keep the old one" : ""}`;
}

/** Relative difference of B against A with a normal 95 % interval (an approximation; fine for reporting, not for deciding). */
export function relativeLift(kA: number, nA: number, kB: number, nB: number): { effect: number | null; low: number | null; high: number | null } {
  if (nA === 0 || nB === 0) return { effect: null, low: null, high: null };
  const pA = kA / nA, pB = kB / nB;
  if (pA === 0) return { effect: null, low: null, high: null };
  const se = Math.sqrt((pA * (1 - pA)) / nA + (pB * (1 - pB)) / nB);
  return { effect: (pB - pA) / pA, low: (pB - pA - 1.96 * se) / pA, high: (pB - pA + 1.96 * se) / pA };
}
