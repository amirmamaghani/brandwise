// Conversions against the database: a signed lead traced to its entry once, a later qualification, ranges, CPL next to its ceiling.
// Needs the local stack (DATABASE_URL, S3_*), skipped without.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { purge } from "../testing.ts";
import { recipientHasher } from "../email/index.ts";
import { createEconomics } from "../economics/index.ts";
import { createConversions, sign } from "./index.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;

run("a signed lead is traced to its entry once; a qualification later counts as qualified; CPL is a range next to its ceiling", async () => {
  const prefix = `test-${Date.now()}-conv`;
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const key = randomBytes(32).toString("base64");
  const conv = createConversions({ core, salt: "conv-test", secretKey: key, now: async () => new Date() });
  const econ = createEconomics({ core, now: async () => new Date(), conversions: conv });
  try {
    const base = await core.campaigns.add({ name: `${prefix}-base`, kind: "always_on" });
    const child = await core.campaigns.add({ name: `${prefix}-spring`, kind: "campaign", parentId: base.id });
    const entry = await core.calendar.add({ campaignId: child.id, title: "Spring offer", channel: "email", scheduledAt: new Date(Date.now() - 3_600_000).toISOString(), tier: 1, body: "x" });
    assert.equal(await conv.leadsFor(entry.id, new Date()), null, "no source: leads are unknown, not zero");

    const { source, secret } = await conv.sources.create({ campaignId: child.id, name: "Site form", adapter: "generic", createdBy: "ui" });
    assert.equal(source.rootId, base.id, "a source belongs to the brand");
    assert.ok(secret && secret.length > 20);
    assert.equal(await conv.leadsFor(entry.id, new Date()), 0);
    const post = async (payload: unknown, key = secret!) => {
      const body = JSON.stringify(payload);
      return conv.webhook(source.id, { headers: { "x-brandwise-signature": sign(key, body, Math.floor(Date.now() / 1000)) }, body });
    };
    const lead = { kind: "lead", id: `${prefix}-L1`, occurredAt: new Date().toISOString(), email: "Ann@Example.com", utm: { utm_content: entry.id } };
    assert.equal((await post(lead, "wrong")).status, 401, "a bad signature stores nothing");
    // the development clock may run days ahead (sim advance): a real site signs with real time and must still get in
    const ahead = createConversions({ core, salt: "conv-test", secretKey: key, now: async () => new Date(Date.now() + 73 * 3_600_000) });
    const realBody = JSON.stringify({ kind: "lead", id: `${prefix}-L0`, occurredAt: new Date().toISOString() });
    assert.equal((await ahead.webhook(source.id, { headers: { "x-brandwise-signature": sign(secret!, realBody, Math.floor(Date.now() / 1000)) }, body: realBody })).status, 200);
    assert.deepEqual((await post(lead)).result, { received: 1, created: 1, updated: 0, duplicates: 0 });
    assert.deepEqual((await post(lead)).result, { received: 1, created: 0, updated: 0, duplicates: 1 }, "the same payload twice is one lead");
    assert.equal(await conv.leadsFor(entry.id, new Date()), 1);
    const row = (await core.pool.query("select customer_hash, entry_id, campaign_id, raw from conversion where external_id = $1", [lead.id])).rows[0];
    assert.equal(row.customer_hash, recipientHasher("conv-test")("ann@example.com").hash, "the customer is the same salted hash as the e-mail recipient");
    assert.deepEqual([row.entry_id, row.campaign_id], [entry.id, child.id]);
    assert.equal(JSON.stringify(row.raw).includes("Example"), false);

    await conv.promo("spring10", child.id);
    // another brand's codes never move a lead here: the same code there, and a code only it has
    const rival = await core.campaigns.add({ name: `${prefix}-rival`, kind: "always_on" });
    await conv.promo("spring10", rival.id);
    await conv.promo("rival20", rival.id);
    await post({ kind: "lead", id: `${prefix}-L4`, occurredAt: new Date().toISOString(), promo: "RIVAL20" });
    assert.equal((await core.pool.query("select campaign_id from conversion where external_id = $1", [`${prefix}-L4`])).rows[0].campaign_id, null, "another brand's code attributes nothing");
    await post({ kind: "lead", id: `${prefix}-L2`, occurredAt: new Date().toISOString(), promo: "SPRING10" });
    await post({ kind: "lead", id: `${prefix}-L3`, occurredAt: new Date().toISOString(), selfReport: "your e-mail newsletter" });
    let f = await conv.funnel(child.id);
    assert.deepEqual([f.leads, f.qualified], [{ low: 1, high: 3 }, { low: 0, high: 0 }], "SPRING10 is still ours, although the rival has a code of that name");
    assert.deepEqual((await post({ ...lead, status: "qualified" })).result, { received: 1, created: 0, updated: 1, duplicates: 0 }, "a qualification updates the lead");
    f = await conv.funnel(child.id);
    assert.deepEqual([f.leads, f.qualified], [{ low: 1, high: 3 }, { low: 1, high: 1 }], "still three leads, now one qualified");

    await econ.addCost({ campaignId: child.id, kind: "media", amount: 120, ref: `${prefix}-INV`, createdBy: "ui" });
    await econ.profile.set(base.id, { model: "b2c_leads", currency: "EUR", margin: 0.5, orderValue: 400, leadToQualified: 0.5, qualifiedToCustomer: 0.4, hourlyRate: 0, espPerThousand: 0, llmMonthly: 0 }, "ui");
    const x = await econ.funnel(child.id);
    assert.deepEqual([x.cpl.best, x.cpl.worst, x.cpl.max, x.cpl.verdict], [40, 120, 40, "unclear: depends on attribution"]);
    assert.equal(x.cpql.worst, 120);
    assert.equal(x.romi.value, null);
    assert.match(x.romi.needs, /holdout/);

    const csv = await conv.sources.create({ campaignId: base.id, name: "CRM export", adapter: "csv", createdBy: "ui" });
    assert.equal(csv.secret, null, "an import source has no webhook");
    const r = await conv.importCsv(csv.source.id, `Deal,Stage,Created\n${prefix}-D1,won,${new Date().toISOString()}\n`, { id: "Deal", status: "Stage", occurredAt: "Created" }, { kind: "lead" });
    assert.equal(r.created, 1);
    assert.equal((await conv.sources.list(base.id)).find((s) => s.id === csv.source.id)?.received, 1);
  } finally {
    await core.pool.query("delete from conversion_status_event where external_id like $1", [`${prefix}%`]);
    await core.pool.query("delete from conversion where source_id in (select id from conversion_source where root_id in (select id from campaign where name like $1))", [`${prefix}%`]);
    await core.pool.query("delete from conversion_source where root_id in (select id from campaign where name like $1)", [`${prefix}%`]);
    await purge(core, prefix);
    await core.close();
  }
});
