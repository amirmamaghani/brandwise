// Integration test against the local stack (pnpm infra:up). Skipped without DATABASE_URL.
// Proves that a channel other than e-mail can be measured and tested: a pull source stores snapshots, reads are "as of", and the
// regulator runs an experiment on that channel with the same rails.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { mock } from "../connector-mock.ts";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { createRegulator } from "../regulator/index.ts";
import { purge } from "../testing.ts";
import { createMetrics, PartialPullError, type MetricsSource, type Snapshot } from "./index.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const HOUR = 3_600_000;

/** A platform that only knows current totals: what it reports is set by the test. */
function fakePlatform(id: string, measures: MetricsSource["measures"]) {
  let totals = new Map<string, Snapshot["values"]>();
  const src: MetricsSource = {
    id, channels: ["mock"], measures,
    async pull(entries) { return entries.flatMap((e) => (totals.has(e.id) ? [{ entryId: e.id, values: totals.get(e.id)! }] : [])); },
  };
  return { src, set: (m: Record<string, Snapshot["values"]>) => { totals = new Map(Object.entries(m)); } };
}

run("pull sources: snapshots as of a moment, idempotent, publish time as the start, an experiment on a non-e-mail channel", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}-metrics`;
  try {
    const base = await core.campaigns.add({ name: `${tag}-base`, kind: "always_on" });
    const armA = await core.campaigns.add({ name: `${tag}-a`, kind: "campaign", parentId: base.id });
    const armB = await core.campaigns.add({ name: `${tag}-b`, kind: "campaign", parentId: base.id });
    const post = async (campaignId: string, title: string) => {
      const e = await core.calendar.add({ campaignId, title, channel: "mock", scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1 });
      assert.equal((await runDue(core, [mock], 5, [campaignId])).find((o) => o.id === e.id)?.result, "published");
      return e;
    };
    const a = await post(armA.id, "Post A"), b = await post(armB.id, "Post B");
    const platform = fakePlatform("platform", ["exposures", "clicks"]);
    const metrics = createMetrics({ core, sources: [platform.src] });

    const t1 = new Date(Date.now() + 2 * HOUR), t2 = new Date(Date.now() + 30 * HOUR);
    platform.set({ [a.id]: { exposures: 400, clicks: 8 }, [b.id]: { exposures: 400, clicks: 9 }, "not-an-entry-of-this-source": { clicks: 1 } });
    const first = await metrics.pull(t1);
    assert.deepEqual(first.map((r) => [r.source, r.stored]), [["platform", 4]], "two entries, two numbers each; a foreign id is ignored");
    assert.deepEqual((await metrics.pull(t1)).map((r) => r.stored), [0], "the same moment again stores nothing");
    platform.set({ [a.id]: { exposures: 2000, clicks: 40 }, [b.id]: { exposures: 2000, clicks: 90 } });
    await metrics.pull(t2);
    const mid = await metrics.entry(b.id, new Date(t1.getTime() + HOUR));
    assert.deepEqual(mid.values, { exposures: 400, clicks: 9 }, "as of a moment between the pulls: the earlier snapshot");
    assert.deepEqual((await metrics.entry(b.id, t2)).values, { exposures: 2000, clicks: 90 });
    assert.ok(mid.startedAt !== null && Math.abs(Date.parse(mid.startedAt) - Date.now()) < 5 * 60_000, "the platform cannot tell the start: the publish time from the entry's history");
    assert.deepEqual((await metrics.campaign(base.id, t2)).map((m) => m.entryId).sort(), [a.id, b.id].sort());

    // a channel whose sources cannot count clicks cannot host an experiment that could never conclude
    const reg = createRegulator({ core, metrics });
    const viewsOnly = createRegulator({ core, metrics: createMetrics({ core, sources: [fakePlatform("views", ["exposures"]).src] }) });
    const c = await post(armA.id, "Post C"), d = await post(armB.id, "Post D");
    await assert.rejects(viewsOnly.experiments.propose({ campaignId: base.id, hypothesis: "Shorter captions get more views here", armA: c.id, armB: d.id, createdBy: "test" }), /measures exposures and clicks/);
    const email = await core.calendar.add({ campaignId: armB.id, title: "mail", channel: "email", scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), tier: 2 });
    await assert.rejects(reg.experiments.propose({ campaignId: base.id, hypothesis: "Mail beats posts for this offer, clearly", armA: c.id, armB: email.id, createdBy: "test" }), /same channel/);

    // the same rails judge a test on this channel: wait until mature, then decide on the platform's numbers
    const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: "A question in the first line raises clicks on posts", armA: a.id, armB: b.id, createdBy: "test" });
    assert.equal((await reg.experiments.evaluate(exp.id, new Date(Date.now() + 2 * HOUR).toISOString())).verdict, "wait");
    const done = await reg.experiments.evaluate(exp.id, t2.toISOString());
    assert.equal(done.verdict, "B", done.reasons.join(" "));
    const s = await reg.signals(base.id, t2.toISOString());
    assert.equal(s.recent.find((r) => r.entryId === b.id)?.complaintRate, null, "complaints are not measured on this channel: unknown, not 0");
  } finally {
    await purge(core, tag);
    await core.close();
  }
});

run("pull: a source that fails for some targets keeps the numbers it got, and a broken source does not stop the others", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}-partial`;
  try {
    const base = await core.campaigns.add({ name: `${tag}-base`, kind: "always_on" });
    const e1 = await core.calendar.add({ campaignId: base.id, title: "One", channel: "mock", scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1 });
    const e2 = await core.calendar.add({ campaignId: base.id, title: "Two", channel: "mock", scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1 });
    await runDue(core, [mock], 5, [base.id]);
    const partial: MetricsSource = { id: "partial", channels: ["mock"], measures: ["clicks"], async pull() { throw new PartialPullError([{ entryId: e1.id, values: { clicks: 5 } }], [`brand X refused access`]); } };
    const broken: MetricsSource = { id: "broken", channels: ["mock"], measures: ["visits"], async pull() { throw new Error("token expired"); } };
    const metrics = createMetrics({ core, sources: [partial, broken] });
    const r = await metrics.pull(new Date(Date.now() + HOUR));
    const mine = (id: string) => r.find((x) => x.source === id)!;
    assert.deepEqual([mine("partial").stored, mine("partial").partial, mine("partial").error], [1, true, "brand X refused access"]);
    assert.deepEqual([mine("broken").stored, mine("broken").partial, mine("broken").error], [0, undefined, "token expired"]);
    assert.equal((await metrics.entry(e1.id, new Date(Date.now() + 2 * HOUR))).values.clicks, 5);
    assert.deepEqual((await metrics.entry(e2.id, new Date(Date.now() + 2 * HOUR))).values, {}, "the target that failed is unknown, not 0");
  } finally {
    await purge(core, tag);
    await core.close();
  }
});
