import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedRates } from "../email/adapters/sim-model.ts";
import { DEFAULT_RAILS, canPropose, judge, type ArmData } from "./rails.ts";
import { compareRates, normalCdf, wilson } from "./stats.ts";

const R = DEFAULT_RAILS;
const T0 = "2026-01-01T00:00:00.000Z";
const at = (hoursAfter: number) => new Date(Date.parse(T0) + hoursAfter * 3_600_000);
const arm = (over: Partial<ArmData> = {}): ArmData => ({ entryId: "e", sentAt: T0, delivered: 1000, clicks: 30, complaints: 0, unsubscribes: 0, ...over });

test("stats: normal CDF, Wilson interval and the two-proportion test agree with known values", () => {
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3 && Math.abs(normalCdf(0) - 0.5) < 1e-6);
  const w = wilson(30, 1000);
  assert.ok(w.low < 0.03 && w.high > 0.03 && w.high - w.low < 0.025);
  const c = compareRates(30, 1000, 50, 1000);
  assert.ok(c.p < 0.03 && c.p > 0.01 && c.lift !== null && Math.abs(c.lift - 2 / 3) < 1e-9);
  assert.ok(compareRates(30, 1000, 31, 1000).p > 0.8, "a one-click difference is noise");
});

test("judge: waits for maturity, then decides; a keep (A) is the default", () => {
  assert.equal(judge(arm({ sentAt: null }), arm(), at(100), R).verdict, "wait");
  const early = judge(arm(), arm({ clicks: 60 }), at(23), R);
  assert.equal(early.verdict, "wait", "numbers that are still arriving are not judged, however good they look");
  assert.ok(early.readyAt && early.reasons[0].includes("matures in"));
  assert.equal(judge(arm(), arm({ clicks: 60 }), at(24), R).verdict, "B");
  assert.equal(judge(arm({ clicks: 60 }), arm(), at(24), R).verdict, "A", "a clearly worse challenger loses");
});

test("judge: hysteresis. A small or insignificant difference changes nothing, the incumbent stays", () => {
  const same = judge(arm(), arm({ clicks: 33 }), at(48), R);
  assert.equal(same.verdict, "inconclusive");
  // significant but below the minimum lift: p < 0.05 and still not worth a change
  const tiny = judge(arm({ delivered: 200_000, clicks: 6000 }), arm({ delivered: 200_000, clicks: 6400 }), at(48), R);
  assert.ok(tiny.stats!.p < 0.05 && tiny.stats!.lift! < R.minRelativeLift);
  assert.equal(tiny.verdict, "inconclusive");
  assert.equal(judge(arm({ delivered: 150 }), arm({ delivered: 150, clicks: 60 }), at(48), R).verdict, "inconclusive", "too few delivered");
});

test("judge: guards are limits, not goals. A winner that breaks one loses; two unsafe arms freeze", () => {
  const clickbait = arm({ clicks: 90, complaints: 8 });                      // 0.8 % complaints
  assert.equal(judge(arm(), clickbait, at(48), R).verdict, "A");
  assert.match(judge(arm(), clickbait, at(48), R).reasons[0], /unsafe/);
  assert.equal(judge(clickbait, arm({ clicks: 31 }), at(48), R).verdict, "B", "an unsafe control gives way to a safe challenger");
  assert.equal(judge(clickbait, clickbait, at(48), R).verdict, "freeze");
  assert.equal(judge(arm(), arm({ clicks: 90, unsubscribes: 25 }), at(48), R).verdict, "A", "unsubscribes are guarded too");
  assert.equal(judge(arm({ delivered: 50 }), arm({ delivered: 50, complaints: 5 }), at(48), R).verdict, "inconclusive", "a guard needs a minimum sample to count");
});

test("canPropose: frozen, one running at a time, cooldown after an adoption", () => {
  const ok = { frozen: false, frozenReason: null, running: 0, lastAdoptedAt: null };
  assert.equal(canPropose(ok, at(0), R).ok, true);
  assert.match(canPropose({ ...ok, frozen: true, frozenReason: "x" }, at(0), R).reason!, /frozen/);
  assert.match(canPropose({ ...ok, running: 1 }, at(0), R).reason!, /one variable at a time/);
  assert.match(canPropose({ ...ok, lastAdoptedAt: T0 }, at(10), R).reason!, /cooldown/);
  assert.equal(canPropose({ ...ok, lastAdoptedAt: T0 }, at(25), R).ok, true);
});

test("sim world: the oracle ranks variants, and clickbait buys opens with complaints", () => {
  const body = "Hello\n\nhttps://example.com/offer";
  const plain = expectedRates("Our October newsletter", body);
  const good = expectedRates("{{first_name}}, which 3 ideas fit your October?", body);
  const bait = expectedRates("LAST CHANCE: 3 ideas for October", body);
  assert.ok(good.click > plain.click * 1.5, "personal, question and number clearly help");
  assert.ok(bait.open > plain.open, "urgency raises opens");
  assert.ok(bait.complaint > R.guards.complaintRate && plain.complaint < R.guards.complaintRate && good.complaint < R.guards.complaintRate, "and breaks the complaint guard");
});
