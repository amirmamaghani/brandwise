// Integration test against the local stack (pnpm infra:up). Skipped without DATABASE_URL.
// The life of an ad entry without buying: approved, waits to be published by hand, marked published with its ad id, measured by the
// hourly pull; and an A/B test between two ads concludes on Meta's impressions and link clicks with the same rails.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { createMetrics } from "../metrics/index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { createRegulator } from "../regulator/index.ts";
import { purge } from "../testing.ts";
import { META_CHANNEL, metaAdsSource } from "./meta.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;

run("meta ads: published by hand with the ad id, measured by the pull, tested by the rails", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}-meta`;
  try {
    const base = await core.campaigns.add({ name: `${tag}-base`, kind: "always_on" });
    const armA = await core.campaigns.add({ name: `${tag}-a`, kind: "campaign", parentId: base.id });
    const armB = await core.campaigns.add({ name: `${tag}-b`, kind: "campaign", parentId: base.id });
    const ad = async (campaignId: string, title: string, adId: string) => {
      const e = await core.calendar.add({ campaignId, title, channel: META_CHANNEL, scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1, link: "https://shop.example.com/" });
      await assert.rejects(core.publishing.publishedByHand(e.id, { externalId: adId }, "ui"), /only an entry waiting to be published by hand/, "not before it is due");
      assert.equal((await runDue(core, [], 5, [campaignId])).find((o) => o.id === e.id)?.result, "needs_manual", "no connector buys ads yet");
      await assert.rejects(core.publishing.publishedByHand(e.id, { externalId: "x; drop table" }, "ui"), /platform's id/);
      const p = await core.publishing.publishedByHand(e.id, { externalId: adId, url: "https://www.facebook.com/ads/library/?id=1" }, "ui");
      assert.deepEqual([p.status, p.externalId], ["published", adId]);
      return e;
    };
    const a = await ad(armA.id, "Ad A: plain", "120210000000101"), b = await ad(armB.id, "Ad B: question", "120210000000102");
    assert.deepEqual((await core.calendar.history(a.id)).at(-1)?.actor, "ui");

    const fetchImpl = (async () => Response.json({
      "120210000000101": { insights: { data: [{ impressions: "6000", reach: "4000", inline_link_clicks: "60", spend: "30" }] } },
      "120210000000102": { insights: { data: [{ impressions: "6000", reach: "4100", inline_link_clicks: "120", spend: "30" }] } },
    })) as typeof fetch;
    const metrics = createMetrics({ core, sources: [metaAdsSource({ token: () => "T", version: () => "v23.0", fetchImpl })] });
    const later = new Date(Date.now() + 30 * 3_600_000);
    const pulled = (await metrics.pull(later, { source: "meta" }))[0];
    assert.equal(pulled.error, undefined);
    assert.deepEqual((await metrics.entry(b.id, later)).values, { exposures: 6000, reach: 4100, clicks: 120, spend: 30 });

    const reg = createRegulator({ core, metrics });
    const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: "A question in the headline doubles link clicks on this audience", armA: a.id, armB: b.id, createdBy: "test" });
    const done = await reg.experiments.evaluate(exp.id, later.toISOString());
    assert.equal(done.verdict, "B", done.reasons.join(" "));
  } finally {
    await purge(core, tag);
    await core.close();
  }
});
