// The whole feedback loop against the simulated provider, driven by a scripted controller (no LLM): propose an A/B experiment, let the
// simulated days pass, let the rails judge. Needs the local stack (DATABASE_URL, S3_*), skipped without.
// What it proves: the loop converges on a better variant, never acts on immature data, never adopts a variant that breaks a guard,
// keeps the incumbent when the evidence is weak (hysteresis), and respects cooldown and freeze.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { purge } from "../testing.ts";
import { expectedRates } from "../email/adapters/sim-model.ts";
import { createEmail } from "../email/index.ts";
import { createRegulator } from "./index.ts";
import { judge } from "./rails.ts";
import { createConversions } from "../conversions/index.ts";
import { regulatorStore } from "./store.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const BODY = "Hello,\n\nhttps://example.com/offer";
const HOUR = 3_600_000;

async function setup(prefix: string) {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const rstore = regulatorStore(core.pool);
  const before = await rstore.clockOffset();
  await rstore.setClockOffset(0); // every test starts from real time; the previous offset comes back afterwards
  const email = createEmail({ pool: core.pool, salt: "loop-test", sim: { now: async () => new Date(Date.now() + (await rstore.clockOffset()) * 1000) } });
  const reg = createRegulator({ core, email });
  const base = await core.campaigns.add({ name: `${prefix}-base`, kind: "always_on" });
  await reg.goals.set(base.id, "click_rate", "target", 0.06);
  await reg.goals.set(base.id, "complaint_rate", "limit", 0.003);
  let n = 0;
  /** Send a variant to its own child campaign (its own simulated audience) and return the entry. */
  const sendArm = async (subject: string, tag: string) => {
    const child = await core.campaigns.add({ name: `${prefix}-${++n}-${tag}`, kind: "campaign", parentId: base.id });
    await core.channels.set(child.id, "email", { provider: "sim", from: "Test <test@example.com>", audienceSize: "600", seed: `loop-${tag}-${n}` });
    const entry = await core.calendar.add({ campaignId: child.id, title: subject, channel: "email", scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1, body: BODY });
    const out = (await runDue(core, [email.connector()], 5, [child.id])).find((o) => o.id === entry.id);
    assert.equal(out?.result, "published", out?.detail);
    return entry;
  };
  return { core, rstore, reg, email, base, sendArm, before, cleanup: async () => { await rstore.setClockOffset(before); await purge(core, prefix); await core.close(); } };
}

const CANDIDATES = [
  "Our October newsletter",                                      // baseline
  "{{first_name}}, 3 ideas for your October",                   // clearly better: personal + number
  "{{first_name}}, 3 ideas for your October!!",                 // practically the same: must NOT replace the incumbent
  "LAST CHANCE: 3 ideas for your October",                      // opens up, complaints over the guard: must never win
  "{{first_name}}, which 3 ideas fit your October?",            // the best safe one
];

run("the loop converges, waits for maturity, resists noise and clickbait", async (t) => {
  const prefix = `test-${Date.now()}-loop`;
  const { reg, base, sendArm, cleanup } = await setup(prefix);
  try {
    let incumbent = CANDIDATES[0];
    const path: string[] = [];
    for (const challenger of CANDIDATES.slice(1)) {
      // the rails say when a new experiment may start (cooldown after an adoption); the controller just waits
      const gate = (await reg.signals(base.id)).allowed.proposeExperiment;
      if (!gate.ok) {
        assert.match(gate.reason!, /cooldown/);
        await reg.clock.advance(24 * HOUR);
      }
      const a = await sendArm(incumbent, "A"), b = await sendArm(challenger, "B");
      const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: `Replace "${incumbent}" with "${challenger}" to raise the click rate`, lever: { attribute: "subject", from: incumbent.toLowerCase(), to: challenger.toLowerCase() }, armA: a.id, armB: b.id, createdBy: "test-controller" });
      await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "a second experiment at the same time", lever: "subject: a -> b", armA: a.id, armB: b.id, createdBy: "t" }), /one variable at a time/);

      // first look, 6 simulated hours after sending: the numbers are still arriving, so the rails refuse to judge
      await reg.clock.advance(6 * HOUR);
      const early = await reg.experiments.evaluate(exp.id);
      assert.equal(early.verdict, "wait", "must not decide on immature data");
      assert.ok(early.reasons.some((r) => r.includes("matures in")));
      // after maturity the verdict is final
      await reg.clock.advance(19 * HOUR);
      const done = await reg.experiments.evaluate(exp.id);
      assert.ok(done.final && done.verdict !== "wait");
      assert.equal((await reg.experiments.evaluate(exp.id)).verdict, done.verdict, "a verdict is final and idempotent");
      path.push(`${challenger} -> ${done.verdict}: ${done.reasons[0]}`);
      if (done.verdict === "B") incumbent = challenger;
    }
    t.diagnostic(path.join("\n"));

    // the incumbent is the true best of the SAFE candidates, found only through noisy measurements and the rails
    const safe = CANDIDATES.filter((s) => expectedRates(s, BODY).complaint <= reg.rails.guards.complaintRate);
    const best = Math.max(...safe.map((s) => expectedRates(s, BODY).click));
    assert.ok(expectedRates(incumbent, BODY).complaint <= reg.rails.guards.complaintRate, "never adopts an unsafe variant");
    assert.notEqual(incumbent, CANDIDATES[3], "clickbait never wins");
    assert.ok(expectedRates(incumbent, BODY).click >= 0.75 * best, `ended on ${incumbent}, true click ${expectedRates(incumbent, BODY).click.toFixed(3)} vs best safe ${best.toFixed(3)}`);
    assert.ok(expectedRates(incumbent, BODY).click > 1.5 * expectedRates(CANDIDATES[0], BODY).click, "and clearly improved on the baseline");

    const verdicts = (await reg.experiments.list(base.id, "concluded")).map((e) => e.verdict);
    assert.equal(verdicts.length, CANDIDATES.length - 1);
    assert.equal(verdicts.filter((v) => v === "B").length, new Set(path.filter((p) => p.includes("-> B")).map((p) => p)).size, "adoptions are recorded");
    assert.ok(path.some((p) => p.includes("{{first_name}}, 3 ideas for your October!! -> inconclusive")), `hysteresis: a near-identical variant must not replace the incumbent\n${path.join("\n")}`);
    assert.ok(path.some((p) => p.includes("LAST CHANCE") && p.includes("-> A") && p.includes("unsafe")), `the guard stops clickbait\n${path.join("\n")}`);
    assert.equal((await reg.journal.read(base.id, 50, "learning")).length, verdicts.length, "every conclusion is written to the journal");
    const learned = await reg.learnings.list(base.id);
    assert.equal(learned.filter((l) => l.evidence === "E1").length, verdicts.length, "every conclusion is a structured E1 learning");
    assert.ok(learned.some((l) => l.kind === "null_result"), "the near-identical variant is recorded as a null result");
    assert.ok(learned.some((l) => l.result === "unsafe"), "the clickbait variant is recorded as unsafe");
    const s = await reg.signals(base.id);
    assert.equal(s.incumbent?.title, incumbent);
    assert.ok(s.goals.find((g) => g.metric === "click_rate")!.current! > 0);
  } finally {
    await cleanup();
  }
});

run("two unsafe arms freeze the campaign until a person clears it", async () => {
  const prefix = `test-${Date.now()}-freeze`;
  const { reg, base, sendArm, cleanup } = await setup(prefix);
  try {
    const a = await sendArm("LAST CHANCE: act now", "A"), b = await sendArm("URGENT: final hours", "B");
    const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: "Two urgent subject lines against each other", lever: "subject_style: urgent -> urgent_caps", armA: a.id, armB: b.id, createdBy: "t" });
    await reg.clock.advance(25 * HOUR);
    assert.equal((await reg.experiments.evaluate(exp.id)).verdict, "freeze");
    const gate = (await reg.signals(base.id)).allowed.proposeExperiment;
    assert.deepEqual([gate.ok, /frozen/.test(gate.reason ?? "")], [false, true]);
    await reg.unfreeze(base.id);
    assert.equal((await reg.signals(base.id)).allowed.proposeExperiment.ok, true);
  } finally {
    await cleanup();
  }
});

run("the scheduler follows the development clock: an entry in the simulated future is sent when that time comes", async () => {
  const prefix = `test-${Date.now()}-clock`;
  const { core, reg, base, sendArm, cleanup } = await setup(prefix);
  try {
    const a = await sendArm("Subject for the clock test", "A");   // a normal send first: the connector and target exist
    const later = await core.calendar.add({ campaignId: a.campaignId, title: "Scheduled for later", channel: "email", scheduledAt: new Date(Date.now() + 5 * HOUR).toISOString(), tier: 1, body: BODY });
    const email = createEmail({ pool: core.pool, salt: "loop-test", sim: { now: () => reg.clock.now() } });
    assert.equal((await runDue(core, [email.connector()], 5, [a.campaignId])).length, 0, "not due yet");
    await reg.clock.advance(6 * HOUR);
    const done = await runDue(core, [email.connector()], 5, [a.campaignId]);
    assert.deepEqual(done.map((o) => [o.id, o.result]), [[later.id, "published"]]);
    void base;
  } finally {
    await cleanup();
  }
});

run("arms must have separate audiences; tasks are claimed once", async () => {
  const prefix = `test-${Date.now()}-rules`;
  const { core, reg, base, sendArm, cleanup } = await setup(prefix);
  try {
    const a = await sendArm("Subject one for the test", "A");
    const sameCampaign = await core.calendar.add({ campaignId: a.campaignId, title: "Subject two", channel: "email", scheduledAt: new Date(Date.now() + HOUR).toISOString(), tier: 1, body: BODY });
    await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "Same audience gets both variants", lever: "subject: one -> two", armA: a.id, armB: sameCampaign.id, createdBy: "t" }), /different child campaigns/);
    await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "short", lever: "subject: one -> two", armA: a.id, armB: sameCampaign.id, createdBy: "t" }), /hypothesis/);
    await assert.rejects(reg.goals.set(base.id, "open_rate", "target", 0.3), /Unknown goal metric/);
    const task = await reg.tasks.create(base.id, "editor", { kind: "write_variant", brief: "Write a subject line with a number" });
    assert.equal((await reg.tasks.claim(task.id, "author-1")).status, "claimed");
    await assert.rejects(reg.tasks.claim(task.id, "author-2"), /not open/);
    assert.equal((await reg.tasks.complete(task.id, { entry: a.id })).status, "done");
    await assert.rejects(reg.tasks.complete(task.id, {}), /already finished/);

    // a variant task: the author supplies only the subject, code addresses the arm, body, tier and time
    const arm = await core.campaigns.add({ name: `${prefix}-arm`, kind: "campaign", parentId: base.id });
    const params = { arm: arm.name, role: "challenger", tier: 1, baseSubject: "Our October newsletter", body: BODY };
    const v1 = await reg.tasks.create(base.id, "editor", { kind: "write_variant", brief: "b", params });
    await assert.rejects(reg.tasks.submitVariant(v1.id, { subject: "A subject" }, "author-1"), /claim it first/);
    await reg.tasks.claim(v1.id, "author-1");
    await assert.rejects(reg.tasks.submitVariant(v1.id, { subject: "Our October newsletter" }, "author-1"), /must differ/);
    await assert.rejects(reg.tasks.submitVariant(v1.id, { subject: "x".repeat(71) }, "author-1"), /3 to 70/);
    const done = await reg.tasks.submitVariant(v1.id, { subject: "3 ideas for your October" }, "author-1");
    const entry = await core.calendar.get((done.result as { entry: string }).entry);
    assert.deepEqual([entry?.campaignId, entry?.channel, entry?.tier, entry?.body, entry?.status], [arm.id, "email", 1, BODY, "approved"]);
    assert.ok(entry?.briefId, "every arm entry is linked to the brief it was written from");
    assert.equal((done.result as { brief: string }).brief, entry?.briefId);
    const ctl = await reg.tasks.create(base.id, "editor", { kind: "write_variant", brief: "b", params: { ...params, role: "control", subject: "Our October newsletter" } });
    await reg.tasks.claim(ctl.id, "author-1");
    const c = await reg.tasks.submitVariant(ctl.id, { subject: "something else entirely" }, "author-1");
    assert.equal((c.result as { subject: string }).subject, "Our October newsletter", "the control always uses the incumbent subject");
  } finally {
    await cleanup();
  }
});

run("a series pools its rounds: no verdict before the last one, a pooled win where single rounds are inconclusive", async (t) => {
  const prefix = `test-${Date.now()}-series`;
  const { core, reg, email, base, cleanup } = await setup(prefix);
  try {
    const armA = await core.campaigns.add({ name: `${prefix}-arm-A`, kind: "campaign", parentId: base.id });
    const armB = await core.campaigns.add({ name: `${prefix}-arm-B`, kind: "campaign", parentId: base.id });
    // each round is a new send to the arm's audience: a new seed, or the simulated world would repeat the same draws
    const send = async (arm: { id: string }, subject: string, seed: string) => {
      await core.channels.set(arm.id, "email", { provider: "sim", from: "Test <test@example.com>", audienceSize: "600", seed });
      const entry = await core.calendar.add({ campaignId: arm.id, title: subject, channel: "email", scheduledAt: new Date(Date.now() + (await reg.clock.now()).getTime() - Date.now() - 60_000).toISOString(), tier: 1, body: BODY });
      assert.equal((await runDue(core, [email.connector()], 5, [arm.id])).find((o) => o.id === entry.id)?.result, "published");
      return entry;
    };
    const control = "Our October newsletter", challenger = "{{first_name}}, our October newsletter";   // true +51 %
    // A fixed scenario (the world is deterministic per seed): every round alone is too noisy, the pool is not. Over 20 seeds the pooled
    // verdict was B in 16, a false alarm stopped one early (unsubscribes 6 against 0), and single rounds were significant in about a fifth.
    const SEED = process.env.SERIES_SEED ?? "s4";
    const pair = async (round: number) => [await send(armA, control, `${SEED}-a-${round}`), await send(armB, challenger, `${SEED}-b-${round}`)];
    const [a1, b1] = await pair(1);
    const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: "Addressing the reader by name lifts clicks", lever: "subject_personal: no -> yes", armA: a1.id, armB: b1.id, createdBy: "t", expectedLift: 0.5, rounds: 4 });
    assert.deepEqual([exp.plannedRounds, exp.expectedLift, exp.rounds.length], [4, 0.5, 1]);
    assert.deepEqual([(await core.calendar.get(b1.id))?.experimentId, (await core.calendar.get(b1.id))?.variant], [exp.id, "B"]);
    const [early] = await pair(99);
    await assert.rejects(reg.experiments.addRound({ experimentId: exp.id, armA: early.id, armB: b1.id }), /one experiment only|same audiences/);
    const singles: string[] = [];
    for (let round = 2; round <= 4; round++) {
      await reg.clock.advance(25 * HOUR);
      const mid = await reg.experiments.evaluate(exp.id);
      assert.equal(mid.verdict, "next_round", `round ${round - 1}: ${mid.reasons.join(" ")}`);
      assert.equal(mid.final, false);
      const [a, b] = await pair(round);
      await reg.experiments.addRound({ experimentId: exp.id, armA: a.id, armB: b.id });
    }
    await assert.rejects(reg.experiments.addRound({ experimentId: exp.id, armA: early.id, armB: b1.id }), /all its 4 round/);
    await reg.clock.advance(25 * HOUR);
    const now = await reg.clock.now();
    for (const r of (await reg.store.experiment(exp.id))!.rounds) {
      const arm = async (id: string) => { const s = await email.stats({ entryId: id, asOf: now.toISOString() }); return { entryId: id, sentAt: s.sends[0]!.sentAt, delivered: s.counts.delivered, clicks: s.counts.clicked.unique, complaints: s.counts.complained, unsubscribes: s.counts.unsubscribed }; };
      const [ra, rb] = [await arm(r.armA), await arm(r.armB)];
      t.diagnostic(`round ${r.round}: A ${ra.clicks}/${ra.delivered}  B ${rb.clicks}/${rb.delivered}`);
      singles.push(judge(ra, rb, now, reg.rails).verdict);
    }
    const done = await reg.experiments.evaluate(exp.id);
    t.diagnostic(`single rounds: ${singles.join(", ")}; pooled: ${done.verdict}: ${done.reasons[0]}`);
    assert.equal(done.verdict, "B", done.reasons.join(" "));
    assert.ok(singles.every((v) => v === "inconclusive"), `every round alone is inconclusive: ${singles.join(", ")}`);
    const learned = (await reg.learnings.list(base.id)).find((l) => l.experimentId === exp.id)!;
    assert.match(learned.method ?? "", /series of 4 rounds/);
    assert.ok((learned.nPerArm ?? 0) > 2000, "the learning counts every round");

    // the power gate: with about 590 per arm and round, a +20 % change needs more rounds than one
    await reg.clock.advance(25 * HOUR);   // past the cooldown after the adoption
    const [a5, b5] = await pair(5);
    await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "A small tweak of the greeting", lever: "greeting: hi -> hello", armA: a5.id, armB: b5.id, createdBy: "t", expectedLift: 0.2, rounds: 1 }), /needs \d+ rounds|not testable/);
    await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "A small tweak of the greeting", lever: "greeting: hi -> hello", armA: a5.id, armB: b5.id, createdBy: "t", expectedLift: 0.05 }), /below the 10 %/);
  } finally {
    await cleanup();
  }
});

run("the proxy trap: bait that wins on clicks is rejected on leads, once the leads have arrived", async (t) => {
  const prefix = `test-${Date.now()}-bait`;
  const { core, reg: plain, base, cleanup } = await setup(prefix);
  try {
    const conversions = createConversions({ core, salt: "loop-test", now: () => plain.clock.now() });
    const email = createEmail({ pool: core.pool, salt: "loop-test", sim: { now: () => plain.clock.now(), onSent: async (s) => { await conversions.simShop(s); } } });
    const reg = createRegulator({ core, email, conversions });
    const arm = async (tag: string) => {
      const c = await core.campaigns.add({ name: `${prefix}-arm-${tag}`, kind: "campaign", parentId: base.id });
      await core.channels.set(c.id, "email", { provider: "sim", from: "Test <test@example.com>", audienceSize: "8000", seed: `bait-${tag}` });
      return c;
    };
    const [armA, armB] = [await arm("A"), await arm("B")];
    const send = async (c: { id: string }, subject: string) => {
      const entry = await core.calendar.add({ campaignId: c.id, title: subject, channel: "email", scheduledAt: new Date((await reg.clock.now()).getTime() - 60_000).toISOString(), tier: 1, body: BODY });
      assert.equal((await runDue(core, [email.connector()], 5, [c.id])).find((o) => o.id === entry.id)?.result, "published");
      return entry;
    };
    const control = "Our October newsletter", bait = "A free gift inside your October newsletter";
    assert.ok(expectedRates(bait, BODY).click > 2 * expectedRates(control, BODY).click && expectedRates(bait, BODY).lead < 0.6 * expectedRates(control, BODY).lead, "the world: more clicks, fewer leads");
    const a = await send(armA, control), b = await send(armB, bait);
    const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: "A gift in the subject lifts clicks", lever: "subject_style: plain -> bait", armA: a.id, armB: b.id, createdBy: "t", expectedLift: 0.5 });

    await reg.clock.advance(25 * HOUR);
    const early = await reg.experiments.evaluate(exp.id);
    assert.equal(early.verdict, "wait", "clicks are mature, leads are not");
    assert.ok(early.reasons.some((r) => /leads are still coming/.test(r)), early.reasons.join(" "));
    const now = await reg.clock.now();
    const stat = async (id: string) => { const s = await email.stats({ entryId: id, asOf: now.toISOString() }); return { entryId: id, sentAt: s.sends[0]!.sentAt, delivered: s.counts.delivered, clicks: s.counts.clicked.unique, complaints: s.counts.complained, unsubscribes: s.counts.unsubscribed }; };
    assert.equal(judge(await stat(a.id), await stat(b.id), now, reg.rails).verdict, "B", "on clicks alone the bait would win");

    await reg.clock.advance(48 * HOUR);
    const done = await reg.experiments.evaluate(exp.id);
    t.diagnostic(`${done.verdict}: ${done.reasons.join(" ")}; leads A ${await conversions.leadsFor(a.id, await reg.clock.now())}, B ${await conversions.leadsFor(b.id, await reg.clock.now())}`);
    assert.equal(done.verdict, "A", done.reasons.join(" "));
    assert.match(done.reasons[0], /fewer leads/);
    const learned = (await reg.learnings.list(base.id)).find((l) => l.experimentId === exp.id)!;
    assert.ok(["unsafe", "worse"].includes(learned.result ?? ""), "and the brand learns it");
    assert.equal(learned.metric, "lead_rate", "as a finding about leads");
    assert.match(learned.statement, /leads .* although \+\d+ % clicks/);
    const f = await conversions.funnel(base.id, { sinceDays: 30 });
    assert.ok(f.measured && f.leads.low > 0);
  } finally {
    await cleanup();
  }
});
