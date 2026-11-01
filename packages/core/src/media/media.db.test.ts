// Paid media against the database with the mock platform and payment: limits before money, one purchase on retry, spend in the ledger,
// CPL per ad on our leads, and no payment token anywhere. Needs the local stack (DATABASE_URL, S3_*), skipped without.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { purge } from "../testing.ts";
import { createEconomics } from "../economics/index.ts";
import { createConversions, sign } from "../conversions/index.ts";
import { createMedia, mockBuyer, mockPayments } from "./index.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const DAY = 86_400_000;

run("paid media: limits before payment, one purchase on retry, spend in the ledger, CPL per ad, no token in any output", async () => {
  const prefix = `test-${Date.now()}-ads`;
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const clock = { t: Date.now() };
  const now = async () => new Date(clock.t);
  const limits = { maxPerOrder: 100 as number | null, dailyLimit: 30 as number | null, monthlyLimit: 500 as number | null, currency: "EUR" };
  const buyer = mockBuyer({ now }), payments = mockPayments();
  const conversions = createConversions({ core, salt: "ads-test", secretKey: randomBytes(32).toString("base64"), now });
  const economics = createEconomics({ core, now, conversions });
  const media = createMedia({ core, economics, conversions, buyers: [buyer], payments: [payments], limits: async () => ({ ...limits }), now });
  const outputs: unknown[] = [];
  try {
    const base = await core.campaigns.add({ name: `${prefix}-base`, kind: "always_on" });
    const child = await core.campaigns.add({ name: `${prefix}-spring`, kind: "campaign", parentId: base.id });
    await core.channels.set(child.id, "ads", { provider: "mock-ads", payment: "mock-pay" });
    const at = new Date(Date.now() + 60_000).toISOString();
    await assert.rejects(core.calendar.add({ campaignId: child.id, title: "x", channel: "ads", scheduledAt: at, tier: 2, body: "x" }), /always tier 3/);
    const order = (budget: number, days: number, extra: Record<string, unknown> = {}) => media.create({ campaignId: child.id, name: "Spring ad", body: "Three ideas for spring", link: "https://example.com/spring", action: "media_buy", budget, days, at, createdBy: "agent", ...extra });

    await assert.rejects(order(200, 10), /per order. Nothing was bought or paid/);
    const first = await order(70, 7);   // 10 a day
    outputs.push(first);
    assert.deepEqual([first.entry.tier, first.entry.status, first.order.status], [3, "pending_approval", "draft"]);
    await assert.rejects(order(100, 4), /daily limit/, "25 a day more would pass the daily limit of 30");
    await assert.rejects(media.create({ campaignId: child.id, name: "Boost", body: "x", action: "boost", budget: 10, days: 1, boostOf: first.entry.id, at, createdBy: "agent" }), /published post/);
    assert.equal(payments.charges.length, 0, "nothing was paid for refused orders");

    // only a person on a page approves money: not the CLI, and the connector checks who approved before paying
    await assert.rejects(core.calendar.decide(first.entry.id, "approve", "cli:agent"), /approved by a person in the Calendar page/);
    const sneaky = await order(20, 2);
    await core.pool.query("update content_calendar set status = 'approved', approved_by = 'cli', scheduled_at = now() - interval '1 minute' where id = $1", [sneaky.entry.id]);
    assert.match((await runDue(core, [media.connector()], 5, [child.id])).find((o) => o.id === sneaky.entry.id)!.detail, /not approved by a person/);
    await core.calendar.decide(sneaky.entry.id, "cancel", "ui").catch(() => core.pool.query("update content_calendar set status = 'cancelled' where id = $1", [sneaky.entry.id]));
    assert.equal(payments.charges.length, 0);
    // another brand's post cannot be boosted from here
    const other = await core.campaigns.add({ name: `${prefix}-other`, kind: "always_on" });
    const foreign = await core.calendar.add({ campaignId: other.id, title: "Theirs", channel: "telegram", scheduledAt: at, tier: 1, body: "x" });
    await core.pool.query("update content_calendar set status = 'published' where id = $1", [foreign.id]);
    await assert.rejects(media.create({ campaignId: child.id, name: "Boost", body: "x", action: "boost", budget: 10, days: 1, boostOf: foreign.id, at, createdBy: "agent" }), /same brand/);

    // approved, then the limits are lowered: the connector checks again before any money moves
    await core.calendar.decide(first.entry.id, "approve", "ui", 60);
    limits.maxPerOrder = 50;
    clock.t = Date.parse(at) + 1000;
    const due = async () => { const r = await runDue(core, [media.connector()], 5, [child.id]); outputs.push(r); return r; };
    const refused = (await core.pool.query("update content_calendar set scheduled_at = now() - interval '1 minute' where id = $1", [first.entry.id]), await due()).find((o) => o.id === first.entry.id)!;
    assert.match(refused.detail, /Over the ads limits/);
    assert.equal(payments.charges.length, 0, "a refused order is never paid");
    limits.maxPerOrder = 100;
    await core.pool.query("update content_calendar set next_attempt_at = null where id = $1", [first.entry.id]);
    const published = (await due()).find((o) => o.id === first.entry.id)!;
    assert.equal(published.result, "published", published.detail);
    // a retry of the same entry (a crash after buying) buys and pays once
    const again = await media.connector().publish({ idempotencyKey: `bw-${first.entry.id}`, entry: (await core.calendar.get(first.entry.id))!, target: { provider: "mock-ads", payment: "mock-pay" }, asset: null });
    outputs.push(again);
    assert.deepEqual([buyer.creates, payments.charges.length, payments.charges[0].amount], [1, 1, 70]);
    const row = (await core.pool.query("select * from media_order where entry_id = $1", [first.entry.id])).rows[0];
    assert.deepEqual([row.status, row.platform, String(row.payment_ref).startsWith("auth_")], ["live", "mock-ads", true]);
    assert.match([...buyer.orders.values()][0].link ?? "", /utm_medium=paid.*utm_content=/, "the ad's link names its entry");

    // three days of reports: metric points and spend in the ledger; a lead from the ad's link gives CPL on our numbers
    clock.t += 3 * DAY;
    outputs.push(await media.pull());
    outputs.push(await media.pull());   // repeated pulls change nothing
    const spend = Number((await core.pool.query("select sum(amount) as s from cost_entry where kind = 'media' and entry_id = $1", [first.entry.id])).rows[0].s);
    assert.ok(Math.abs(spend - 30) < 1e-6, `three days of 10 (got ${spend})`);
    const { source, secret } = await conversions.sources.create({ campaignId: base.id, name: "Site form", adapter: "generic", createdBy: "ui" });
    for (const id of ["a", "b"]) {
      const body = JSON.stringify({ kind: "lead", id: `${prefix}-${id}`, occurredAt: new Date(clock.t).toISOString(), utm: { utm_content: first.entry.id } });
      await conversions.webhook(source.id, { headers: { "x-brandwise-signature": sign(secret!, body, Math.floor(clock.t / 1000)) }, body });
    }
    const [ad] = await media.results(child.id);
    outputs.push(ad);
    assert.deepEqual([ad.spend, ad.leads, ad.cpl], [30, 2, 15]);
    assert.ok(ad.impressions > 0 && ad.ctr! > 0 && ad.frequency! > 0);
    const costs = await economics.costs(child.id);
    assert.equal(costs.rows.find((r) => r.kind === "media")?.money, 30, "media spend is in the campaign's costs");

    await media.pause(first.entry.id);
    assert.equal((await media.order(first.entry.id))?.status, "paused");
    limits.monthlyLimit = 150;
    await assert.rejects(order(100, 10), /monthly limit/, "a paused order still counts this month: 70 + 100 is over 150");
    limits.monthlyLimit = 500;
    const tokens = [...buyer.orders.values()].flatMap((o) => o.tokens);
    assert.ok(tokens.length === 1 && tokens[0].startsWith("tok_"));
    const everything = JSON.stringify(outputs) + JSON.stringify((await core.pool.query("select * from media_order where entry_id = $1", [first.entry.id])).rows) + JSON.stringify((await core.pool.query("select * from entry_event where entry_id = $1", [first.entry.id])).rows);
    assert.equal(everything.includes(tokens[0]), false, "the payment token is in no output, row or event");
  } finally {
    await core.pool.query("delete from metric_point where entity in (select 'calendar:' || id from content_calendar where campaign_id in (select id from campaign where name like $1))", [`${prefix}%`]);
    await core.pool.query("delete from media_order where entry_id in (select id from content_calendar where campaign_id in (select id from campaign where name like $1))", [`${prefix}%`]);
    await purge(core, prefix);
    await core.close();
  }
});
