// Costs against the database: the generation ledger behind daily budgets and cost per approved asset, review minutes, the profile.
// Needs the local stack (DATABASE_URL, S3_*), skipped without.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { purge } from "../testing.ts";
import { createEconomics } from "./index.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;

run("rejected and failed generations count in the cost per approved video; budgets read the ledger by scope", async () => {
  const prefix = `test-${Date.now()}-costs`;
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const econ = createEconomics({ core, now: async () => new Date(), unitPrice: async () => 0.5 });
  try {
    const base = await core.campaigns.add({ name: `${prefix}-base`, kind: "always_on" });
    const child = await core.campaigns.add({ name: `${prefix}-spring`, kind: "campaign", parentId: base.id });
    const other = await core.campaigns.add({ name: `${prefix}-other`, kind: "always_on" });
    const job = (n: string) => `${prefix}-${n}`;
    for (const n of ["v1", "v2", "v3"]) await econ.recordGeneration({ campaignId: child.id, provider: "higgsfield", jobId: job(n), units: 10, unit: "credits", format: "video/veo", createdBy: "agent" });
    await econ.recordGeneration({ campaignId: other.id, provider: "higgsfield", jobId: job("o1"), units: 7, unit: "credits", format: "image/nano", createdBy: "agent" });
    await econ.recordGeneration({ campaignId: child.id, provider: "higgsfield", jobId: job("v1"), units: 10, unit: "credits", format: "video/veo", createdBy: "agent" });   // a retry of the same job is one row
    const a1 = await core.assets.save({ campaignId: child.id, bytes: new TextEncoder().encode(`${prefix}-video-1`), filename: "one.mp4", role: "creative", origin: "generated" });
    const a2 = await core.assets.save({ campaignId: child.id, bytes: new TextEncoder().encode(`${prefix}-video-2`), filename: "two.mp4", role: "creative", origin: "generated" });
    await econ.finishGeneration("higgsfield", job("v1"), { status: "done", assetId: a1.id });
    await econ.finishGeneration("higgsfield", job("v2"), { status: "done", assetId: a2.id });
    await econ.finishGeneration("higgsfield", job("v3"), { status: "failed" });
    const e = await core.calendar.add({ campaignId: child.id, title: "Spring reel", channel: "telegram", scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), tier: 2, body: "x", assetId: a1.id, createdBy: "agent" });
    await core.calendar.decide(e.id, "approve", "ui", 300);   // five minutes by the dialog's timer; a2 is never used: rejected

    assert.equal(await econ.spentToday("higgsfield", child.id), 30);
    assert.equal(await econ.spentToday("higgsfield", base.id), 30, "a base's budget covers its campaigns");
    assert.ok((await econ.spentToday("higgsfield", null)) >= 37, "the global budget counts everything");
    const video = (await econ.formats(base.id)).find((f) => f.format === "video/veo")!;
    assert.deepEqual([video.generations, video.failed, video.approvedAssets, video.costPerApprovedAsset], [3, 1, 1, 15]);

    let costs = await econ.costs(child.id);
    assert.equal(costs.rows.find((r) => r.kind === "gen")?.money, 15);
    assert.equal(costs.rows.find((r) => r.kind === "human")?.money, null);
    assert.ok(costs.needs.some((n) => n.includes("hourlyRate")));
    assert.match(costs.rows.find((r) => r.kind === "human")!.detail, /^5 review minute/);

    assert.deepEqual((await econ.economics(child.id)).derived.find((d) => d.name === "break_even_roas")?.needs, ["the economics profile"]);
    await assert.rejects(econ.profile.set(child.id, { model: "ecommerce", currency: "EUR", margin: 1.4 }, "ui"), /share between 0 and 1/);
    await econ.profile.set(child.id, { model: "ecommerce", currency: "EUR", margin: 0.4, orderValue: 85, hourlyRate: 60, reviewMinutes: { 2: 4 } }, "ui");
    assert.equal((await econ.economics(child.id)).derived.find((d) => d.name === "break_even_roas")?.value, 2.5, "set on the base, read by its campaign");
    assert.equal(await econ.profile.get(base.id, "2000-01-01T00:00:00Z"), null, "a report for an earlier date uses the profile valid then");
    const untimed = await core.calendar.add({ campaignId: child.id, title: "CLI approved", channel: "telegram", scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), tier: 2, body: "x" });
    await core.calendar.decide(untimed.id, "approve", "cli");
    costs = await econ.costs(child.id);
    assert.equal(costs.rows.find((r) => r.kind === "human")?.money, 9, "5 timed minutes and the tier's 4 default minutes at 60 an hour");
    await econ.addCost({ campaignId: child.id, kind: "media", amount: 120, ref: `${prefix}-INV-1`, createdBy: "ui" });
    await econ.addCost({ campaignId: child.id, kind: "media", amount: 120, ref: `${prefix}-INV-1`, createdBy: "ui" });
    assert.equal((await econ.costs(child.id)).rows.find((r) => r.kind === "media")?.money, 120, "the same invoice is recorded once");

    const prod = await econ.production(base.id);
    assert.deepEqual([prod.decided, prod.firstPassRate], [2, 1]);
  } finally {
    await core.pool.query("delete from cost_entry where source_ref like $1", [`${prefix}%`]);
    await purge(core, prefix);
    await core.close();
  }
});
