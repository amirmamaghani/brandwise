import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedRates } from "../email/adapters/sim-model.ts";
import { DEFAULT_RAILS, canPropose, judge, judgeSeries, type ArmData } from "./rails.ts";
import { cmh, compareRates, eventsNeeded, minDetectableLift, normalCdf, requiredPerArm, roundsNeeded, wilson, worseOneSided } from "./stats.ts";

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

test("power: what an audience can show, and that the test agrees with it", () => {
  // the specification's numbers (docs/analytics.md D2): each arm with its own variance
  assert.deepEqual([[0.02, 0.03], [0.02, 0.025], [0.005, 0.01], [0.005, 0.0075]].map(([a, b]) => Math.round(requiredPerArm(a, b) / 100) * 100), [3800, 13800, 4700, 15600]);
  assert.equal(Math.round(100 * minDetectableLift(0.02, 1500)!), 85, "a 3,000 list split in two at a 2 % click rate shows +85 %, not +72 %");
  assert.deepEqual([1, 0.5, 0.25, 0.2].map((r) => Math.round(eventsNeeded(r))), [24, 78, 283, 432]);
  const mde = minDetectableLift(0.03, 600)!;
  assert.ok(mde > 1.0 && mde < 1.2, `about +110 % at 600 per arm and a 3 % rate, got ${mde}`);
  assert.ok(minDetectableLift(0.03, 6000)! < mde / 2.5, "ten times the audience, well under half the lift");
  assert.equal(roundsNeeded(0.035, 600, 0.6), 3, "a series makes a +60 % change testable on 600 per arm");
  assert.equal(roundsNeeded(0.035, 600, 0.05), null, "and a 5 % change never is");
  assert.equal(minDetectableLift(0, 600), null);
  // a lift just above the minimum is significant with that audience, one well below it is not
  const n = 2000, base = 60, k = (lift: number) => Math.round(base * (1 + lift));
  const mdeN = minDetectableLift(base / n, n)!;
  assert.ok(compareRates(base, n, k(mdeN * 1.2), n).p < 0.05);
  assert.ok(compareRates(base, n, k(mdeN * 0.4), n).p > 0.05);
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

test("sim world: the button label and a list matter, not only the subject", () => {
  const html = (label: string, list = "") => `<p>Hello</p>${list}<a href="https://example.com/x">${label}</a>`;
  const plain = expectedRates("Our October newsletter", html("See the picks"));
  assert.ok(expectedRates("Our October newsletter", html("Start the picks")).click > plain.click * 1.1, "an action verb on the button helps");
  assert.ok(expectedRates("Our October newsletter", html("See the picks", "<ul><li>a</li></ul>")).click > plain.click, "a list helps a little");
  assert.equal(expectedRates("Our October newsletter", html("See the picks")).open, plain.open, "and neither changes who opens");
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

test("series: no verdict before the planned rounds; pooled over rounds a moderate effect shows where single rounds do not", () => {
  const round = (clicksB: number, sentAt = T0) => ({ a: arm({ delivered: 600, clicks: 21, sentAt }), b: arm({ delivered: 600, clicks: clicksB, sentAt }) });
  const rounds = [round(31), round(32), round(30), round(33)];
  for (const r of rounds) assert.equal(judge(r.a, r.b, at(48), R).verdict, "inconclusive", "each round alone is too small");
  assert.equal(judgeSeries(rounds.slice(0, 2), 4, at(48), R).verdict, "next_round", "fixed horizon: two of four rounds give no verdict");
  const pooled = judgeSeries(rounds, 4, at(48), R);
  assert.equal(pooled.verdict, "B", pooled.reasons.join(" "));
  assert.match(pooled.reasons[0], /4 rounds \(Cochran-Mantel-Haenszel\)/);
  assert.equal(pooled.stats?.rounds, 4);
  assert.equal(judgeSeries([round(31), round(31, "2026-01-02T12:00:00.000Z")], 2, at(48), R).verdict, "wait", "the last round must mature too");
  // CMH agrees with the z-test on one stratum and does not mix up strata of different base rates
  assert.ok(Math.abs(cmh([{ kA: 30, nA: 1000, kB: 45, nB: 1000 }]).p - compareRates(30, 1000, 45, 1000).p) < 0.002);
  const simpson = cmh([{ kA: 10, nA: 100, kB: 2, nB: 20 }, { kA: 1, nA: 20, kB: 5, nB: 100 }]);
  assert.ok(Math.abs(simpson.lift!) < 0.05, `the same rate in each stratum is no effect, whatever the mix (${simpson.lift})`);
});

test("guards: the 0.3 % ceiling, complaints clearly above 0.1 %, a significantly worse challenger, and guards the provider cannot measure", () => {
  assert.equal(judge(arm(), arm({ clicks: 60, complaints: 4 }), at(48), R).verdict, "A", "0.4 % complaints: over the ceiling");
  assert.equal(judge(arm(), arm({ clicks: 60, complaints: 2 }), at(48), R).verdict, "B", "two complaints in 1,000 are not clearly above 0.1 %");
  const target = judge(arm({ delivered: 5000, clicks: 150 }), arm({ delivered: 5000, clicks: 300, complaints: 10 }), at(48), R);
  assert.deepEqual([target.verdict, /clearly above the 0.10 % target/.test(target.reasons[0])], ["A", true], "0.2 % in 5,000: clearly above the target");
  assert.ok(worseOneSided(2, 1000, 9, 1000) < 0.05);
  const moreUnsubs = judge(arm({ unsubscribes: 1 }), arm({ clicks: 60, unsubscribes: 10 }), at(48), R);
  assert.deepEqual([moreUnsubs.verdict, /significantly more unsubscribes/.test(moreUnsubs.reasons[0])], ["A", true], "under the 1 % limit but clearly worse than the control");
  const blind = judge(arm({ measured: { unsubscribes: false } }), arm({ clicks: 60, unsubscribes: 0, measured: { unsubscribes: false } }), at(48), R);
  assert.equal(blind.verdict, "B");
  assert.ok(blind.reasons.some((r) => /unsubscribe guard unavailable/.test(r)), "an unmeasured guard is said, not read as 0 %");
  const early = judgeSeries([{ a: arm(), b: arm({ clicks: 90, complaints: 8 }) }], 4, at(48), R);
  assert.equal(early.verdict, "A", "a broken guard stops a series at once");
});
