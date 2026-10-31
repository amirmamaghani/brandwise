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
  return { core, rstore, reg, base, sendArm, before, cleanup: async () => { await rstore.setClockOffset(before); await purge(core, prefix); await core.close(); } };
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
      const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: `Replace "${incumbent}" with "${challenger}" to raise the click rate`, armA: a.id, armB: b.id, createdBy: "test-controller" });
      await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "a second experiment at the same time", armA: a.id, armB: b.id, createdBy: "t" }), /one variable at a time/);

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
    const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: "Two urgent subject lines against each other", armA: a.id, armB: b.id, createdBy: "t" });
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
    await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "Same audience gets both variants", armA: a.id, armB: sameCampaign.id, createdBy: "t" }), /different child campaigns/);
    await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "short", armA: a.id, armB: sameCampaign.id, createdBy: "t" }), /hypothesis/);
    await assert.rejects(reg.goals.set(base.id, "open_rate", "target", 0.3), /Unknown goal metric/);
    const task = await reg.tasks.create(base.id, "editor", { kind: "write_variant", brief: "Write a subject line with a number" });
    assert.equal((await reg.tasks.claim(task.id, "author-1")).status, "claimed");
    await assert.rejects(reg.tasks.claim(task.id, "author-2"), /not open/);
    assert.equal((await reg.tasks.complete(task.id, { entry: a.id })).status, "done");
    await assert.rejects(reg.tasks.complete(task.id, {}), /already finished/);
  } finally {
    await cleanup();
  }
});
