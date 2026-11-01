// Pure rules of learnings: levers, decay, which learning wins, promotion, the explore slot, the brief, attributes and the miner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAttributes, parseTags } from "./attributes.ts";
import {
  composeBrief, decay, direction, effectiveStatus, exploreShare, isContrary, isExplore, leverKey, parseLever, promotions, reviewAt,
  supersededBy, weight, type Learning,
} from "./domain.ts";
import { minePatterns, type Observation } from "./miner.ts";

const DAY = 86_400_000;
const T0 = new Date("2026-06-01T00:00:00Z");
let seq = 0;
const L = (p: Partial<Learning>): Learning => ({
  id: `l${++seq}`, campaignId: "brand", scope: "brand", kind: "performance", evidence: "E1", result: "better", statement: "s", channel: "email",
  lever: { attribute: "subject_style", from: "plain", to: "number" }, metric: "click_rate", effect: 0.3, ciLow: 0.1, ciHigh: 0.5, nPerArm: 1000,
  mde: null, method: null, context: {}, experimentId: null, sourceIds: [], status: "active", supersededBy: null, createdBy: "regulator",
  confirmedBy: null, decidedAt: T0.toISOString(), createdAt: T0.toISOString(), ...p,
});

test("a lever is parsed, compared whichever way round, and has a direction", () => {
  assert.deepEqual(parseLever("Subject Style: Plain -> Number"), { attribute: "subject_style", from: "plain", to: "number" });
  assert.deepEqual(parseLever('cta_label:"See the picks"->"Start now"'), { attribute: "cta_label", from: "see the picks", to: "start now" });
  assert.throws(() => parseLever("subject plain number"), /attribute: from -> to/);
  assert.throws(() => parseLever("subject: a -> a"), /same/);
  assert.equal(leverKey(parseLever("x: a -> b")), leverKey(parseLever("x: b -> a")));
  const ab = L({ lever: parseLever("x: a -> b"), result: "better" }), ba = L({ lever: parseLever("x: b -> a"), result: "worse" });
  assert.equal(direction(ab), direction(ba), "b better than a == a worse than b");
  assert.equal(direction(L({ result: "no_difference" })), 0);
  assert.equal(direction(L({ lever: parseLever("x: a -> b"), result: "unsafe" })), -1);
});

test("weight decays by the lever's category; after two half-lives a learning asks for a re-test", () => {
  const trend = L({ lever: parseLever("hook: question -> number") });   // 60 days
  const style = L({ lever: parseLever("tone: formal -> friendly") });   // 365 days
  assert.equal(decay(trend, new Date(T0.getTime() + 60 * DAY)), 0.5);
  assert.ok(Math.abs(decay(style, new Date(T0.getTime() + 365 * DAY)) - 0.5) < 1e-9);
  assert.equal(effectiveStatus(trend, new Date(T0.getTime() + 119 * DAY)), "active");
  assert.equal(effectiveStatus(trend, new Date(T0.getTime() + 121 * DAY)), "needs_retest");
  assert.equal(reviewAt(trend).slice(0, 10), "2026-09-29");
  assert.equal(effectiveStatus(style, new Date(T0.getTime() + 30 * DAY), 5), "needs_retest", "five contrary applications doubt a fresh learning");
  assert.ok(weight(L({ evidence: "E1" }), T0) > weight(L({ evidence: "E2" }), T0));
  assert.equal(weight(L({ status: "superseded" }), T0), 0);
  assert.equal(effectiveStatus(L({ evidence: "E3", decidedAt: "2020-01-01T00:00:00Z" }), T0), "active", "a hypothesis does not age out");
});

test("a newer learning on the same lever replaces older ones of no stronger evidence; E3 replaces nothing", () => {
  const old1 = L({ evidence: "E1", decidedAt: "2026-01-01T00:00:00Z" });
  const old2 = L({ evidence: "E2", kind: "performance", decidedAt: "2026-02-01T00:00:00Z", lever: parseLever("subject_style: number -> plain"), result: "worse" });
  const otherLever = L({ lever: parseLever("hook: a -> b"), decidedAt: "2026-01-01T00:00:00Z" });
  const otherOwner = L({ campaignId: "other", decidedAt: "2026-01-01T00:00:00Z" });
  const newerE2 = L({ evidence: "E2", decidedAt: "2026-03-01T00:00:00Z" });
  assert.deepEqual(supersededBy(newerE2, [old1, old2, otherLever, otherOwner]), [old2.id], "E2 does not replace E1");
  const newerE1 = L({ evidence: "E1", kind: "null_result", result: "no_difference", decidedAt: "2026-03-01T00:00:00Z" });
  assert.deepEqual(supersededBy(newerE1, [old1, old2, otherLever, otherOwner]).sort(), [old1.id, old2.id].sort());
  assert.deepEqual(supersededBy(L({ evidence: "E3" }), [old1]), []);
});

test("campaign findings that agree in two campaigns are promoted to the brand", () => {
  const a = L({ scope: "campaign", campaignId: "c1" }), b = L({ scope: "campaign", campaignId: "c2" });
  const disagree = L({ scope: "campaign", campaignId: "c3", lever: parseLever("hook: a -> b"), result: "better" });
  const disagree2 = L({ scope: "campaign", campaignId: "c4", lever: parseLever("hook: a -> b"), result: "worse" });
  const groups = promotions([a, b, disagree, disagree2], []);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((l) => l.id).sort(), [a.id, b.id].sort());
  assert.equal(promotions([a, b], [L({ campaignId: "brand" })]).length, 0, "the brand already has an answer for this lever");
  assert.equal(promotions([a, L({ scope: "campaign", campaignId: "c1" })], []).length, 0, "two findings in one campaign are not two campaigns");
});

test("the explore slot is deterministic and its share shrinks as knowledge grows", () => {
  assert.equal(exploreShare(0), 0.5);
  assert.equal(exploreShare(5), 0.5);
  assert.equal(exploreShare(8), 0.2);
  assert.equal(isExplore("c", "2026-06-01", 0.3), isExplore("c", "2026-06-01", 0.3));
  const days = Array.from({ length: 400 }, (_, i) => new Date(T0.getTime() + i * DAY).toISOString().slice(0, 10));
  const share = days.filter((d) => isExplore("campaign-x", d, 0.25)).length / days.length;
  assert.ok(share > 0.18 && share < 0.32, `about a quarter of days explore (${share})`);
});

test("an application that went clearly against a learning counts as contrary", () => {
  assert.equal(isContrary({ result: "better" }, { rate: 0.02, low: 0.015, high: 0.025, baseline: 0.04 }), true);
  assert.equal(isContrary({ result: "better" }, { rate: 0.035, low: 0.025, high: 0.045, baseline: 0.04 }), false, "inside the noise is not contrary");
  // following "to is worse" means keeping `from`: doing clearly better is consistent, doing clearly worse goes against it
  assert.equal(isContrary({ result: "worse" }, { rate: 0.06, low: 0.05, high: 0.07, baseline: 0.04 }), false);
  assert.equal(isContrary({ result: "worse" }, { rate: 0.02, low: 0.015, high: 0.025, baseline: 0.04 }), true);
  assert.equal(isContrary({ result: "unsafe" }, { rate: 0.02, low: 0.015, high: 0.025, baseline: 0.04 }), false, "an unsafe finding is about complaints, not clicks");
});

test("the brief: strongest first, campaign beats brand on a lever, null results, candidates, rules, feedback and diversity", () => {
  const asOf = new Date(T0.getTime() + 10 * DAY);
  const brandRule = L({ lever: parseLever("hook: question -> number"), result: "better", statement: "brand: numbers win" });
  const campaignRule = L({ scope: "campaign", campaignId: "c1", lever: parseLever("hook: number -> question"), result: "better", statement: "campaign: questions win" });
  const nul = L({ kind: "null_result", result: "no_difference", lever: parseLever("greeting: hi -> none"), statement: "no difference" });
  const e3 = L({ evidence: "E3", result: null, statement: "questions may help" });
  const pref = L({ kind: "reviewer_preference", evidence: null, result: null, lever: null, statement: "No exclamation marks" });
  const old = L({ lever: parseLever("visual_style: photo -> drawing"), decidedAt: "2025-01-01T00:00:00Z", statement: "old trend" });
  const telegram = L({ channel: "telegram", lever: parseLever("format: text -> image"), statement: "telegram only" });
  const b = composeBrief({
    campaign: "Spring", campaignId: "brand", channel: "email", day: "2026-06-11", asOf,
    learnings: [brandRule, campaignRule, nul, e3, pref, old, telegram].map((l) => ({ ...l, contrary: 0 })),
    feedback: [{ entryId: "e1", at: asOf.toISOString(), note: "too pushy", reason: "tone" }],
    recentAttributes: [{ hook: "number" }, { hook: "number" }, { hook: "number" }, { hook: "number" }, { hook: "question" }],
  });
  assert.deepEqual(b.inForce.map((l) => l.statement), ["campaign: questions win"]);
  assert.deepEqual(b.doNotRetest.map((l) => l.statement), ["no difference"]);
  assert.deepEqual(b.needsRetest.map((l) => l.statement), ["old trend"]);
  assert.deepEqual(b.candidates.map((l) => l.statement), ["questions may help"]);
  assert.deepEqual(b.styleRules.map((l) => l.statement), ["No exclamation marks"]);
  assert.equal(b.recentFeedback[0].note, "too pushy");
  assert.match(b.diversity[0], /hook=number was used in 4 of the last 5/);
  assert.ok(b.slot === "exploit" || b.slot === "explore");
});

test("attributes: tags are checked against the vocabulary, derived features come from the entry", () => {
  assert.deepEqual(parseTags("hook=Question, offer=free trial"), { hook: "question", offer: "free_trial" });
  assert.throws(() => parseTags("colour=red"), /Unknown tag/);
  assert.throws(() => parseTags("format=video"), /derived/);
  const d = deriveAttributes({ channel: "email", title: "{{first_name}}, 3 ideas for you?", body: "short", scheduledAt: "2026-06-01T09:00:00Z", assetKind: null });
  assert.deepEqual([d.subject_number, d.subject_personal, d.subject_question, d.subject_caps, d.format, d.send_daypart, d.weekday], ["yes", "yes", "yes", "no", "text", "morning", "monday"]);
  assert.equal(deriveAttributes({ channel: "email", title: "LAST CHANCE to join", body: "", scheduledAt: "2026-06-01T20:00:00Z" }).subject_caps, "yes");
  assert.equal(deriveAttributes({ channel: "telegram", title: "x", body: "y".repeat(2000), scheduledAt: "2026-06-01T20:00:00Z", assetKind: "video" }).subject_number, undefined);
});

test("the miner finds a pattern only when it is significant, sizeable and holds in every month", () => {
  const obs = (month: string, n: number, attrs: Record<string, string>, rate: number): Observation[] =>
    Array.from({ length: n }, (_, i) => ({ entryId: `${month}-${attrs.subject_number}-${i}`, sentAt: `${month}-1${i % 9}T10:00:00Z`, delivered: 1000, clicks: Math.round(1000 * rate), attributes: attrs }));
  const steady = [...obs("2026-04", 6, { subject_number: "yes" }, 0.05), ...obs("2026-04", 6, { subject_number: "no" }, 0.03),
    ...obs("2026-05", 6, { subject_number: "yes" }, 0.05), ...obs("2026-05", 6, { subject_number: "no" }, 0.03)];
  const found = minePatterns(steady);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].lever, found[0].result, found[0].months], [{ attribute: "subject_number", from: "no", to: "yes" }, "better", 2]);
  const flipping = [...obs("2026-04", 6, { subject_number: "yes" }, 0.06), ...obs("2026-04", 6, { subject_number: "no" }, 0.03),
    ...obs("2026-05", 6, { subject_number: "yes" }, 0.03), ...obs("2026-05", 6, { subject_number: "no" }, 0.035)];
  assert.equal(minePatterns(flipping).length, 0, "a direction that flips between months is no pattern");
  assert.equal(minePatterns(steady.slice(0, 12)).length, 0, "one month is not enough");
  const tiny = steady.map((o) => ({ ...o, clicks: o.attributes.subject_number === "yes" ? 31 : 30 }));
  assert.equal(minePatterns(tiny).length, 0, "a lift under 10 % is not reported");
});
