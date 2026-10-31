// Integration: calendar entry -> run-due -> e-mail connector -> provider, events back through ingest, statistics, provider swap.
// Needs the local stack (DATABASE_URL, S3_*), skipped without.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { memoryProvider } from "./adapters/memory.ts";
import { ingest } from "./domain/ingest.ts";
import { purge } from "../testing.ts";
import { createEmail, recipientHasher } from "./index.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;

run("e-mail end to end, with a retry and a provider swap", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  let tag = "";
  try {
    const recipient = recipientHasher("it-salt");
    const run = `r${Date.now()}`;
    tag = `test-${run}`; // ids and external ids must not collide with an earlier run in the same database
    const a = memoryProvider({ id: "memory", idPrefix: `${run}-a`, recipient, recipients: ["x@example.com", "y@example.com"] });
    const b = memoryProvider({ id: "memory-b", idPrefix: `${run}-b`, recipient, recipients: ["z@example.com"] });
    const email = createEmail({ pool: core.pool, salt: "it-salt", extraProviders: [a, b] });
    const base = await core.campaigns.add({ name: `${tag}-email`, kind: "always_on" });
    await core.channels.set(base.id, "email", { provider: "memory", from: "News <news@example.com>" });
    const add = (title: string) => core.calendar.add({ campaignId: base.id, title, channel: "email", scheduledAt: "2020-01-01T08:00", tier: 1, body: "Hello", link: "https://example.com/x" });

    // 1) first attempt fails after the draft was created: the retry must reuse the draft, not create a second campaign
    const one = await add("one");
    const send = a.sender!.send;
    a.sender!.send = async () => { throw new Error("provider down"); };
    assert.equal((await runDue(core, [email.connector()], 50, [base.id])).find((o) => o.id === one.id)?.result, "retry");
    assert.equal(a.campaigns.size, 1);
    a.sender!.send = send;
    await core.pool.query("update content_calendar set next_attempt_at = now() - interval '1 second' where id = $1", [one.id]);
    const retried = (await runDue(core, [email.connector()], 50, [base.id])).find((o) => o.id === one.id);
    assert.deepEqual([retried?.result, a.campaigns.size], ["published", 1], "one campaign only");
    assert.match((await core.calendar.get(one.id))!.externalId ?? "", new RegExp(`^memory:${run}-a-`));
    assert.ok([...a.campaigns.values()][0].html.includes("{{unsubscribe}}") && [...a.campaigns.values()][0].html.includes(`utm_campaign=${one.id}`));

    // 2) events come back: stored once, duplicates ignored, statistics are ours
    const r1 = await ingest(a.outbox, email.store);
    assert.deepEqual([r1.stored, r1.duplicates, r1.unlinked], [4, 0, 0]);
    assert.equal((await ingest(a.outbox, email.store)).stored, 0, "a repeated webhook adds nothing");
    const externalId = [...a.campaigns.keys()][0];
    await email.replay("memory", JSON.stringify([{ type: "opened", externalId, to: "x@example.com", detail: { machine: false } }, { type: "opened", externalId, to: "x@example.com" }, { type: "clicked", externalId, to: "y@example.com", detail: { link: "https://example.com/x" } }]), `${run}-w1`);
    const s1 = await email.stats({ entryId: one.id });
    assert.deepEqual([s1.counts.sent, s1.counts.delivered, s1.counts.opened.unique, s1.counts.opened.total, s1.counts.clicked.unique], [2, 2, 1, 2, 1]);
    assert.equal(s1.metrics.find((m) => m.id === "click_rate")!.value, 0.5);

    // 3) an event that arrives before its send is known is kept and linked once the send exists
    const early = await email.replay("memory-b", JSON.stringify([{ type: "delivered", externalId: `${run}-b-1`, to: "w@example.com" }]), `${run}-early`);
    assert.equal(early.unlinked, 1);

    // 4) swap the provider for the next campaign: the old statistics stay, the report adds both
    await core.channels.set(base.id, "email", { provider: "memory-b", from: "News <news@example.com>" });
    const two = await add("two");
    assert.equal((await runDue(core, [email.connector()], 50, [base.id])).find((o) => o.id === two.id)?.result, "published");
    await ingest(b.outbox, email.store);
    const all = await email.stats({ campaignId: base.id });
    assert.deepEqual(all.sends.map((s) => s.provider), ["memory", "memory-b"]);
    assert.deepEqual([all.counts.sent, all.counts.delivered], [3, 4], "sums over both providers, and the early event was linked when its send appeared");
    assert.equal((await email.stats({ entryId: one.id })).counts.sent, 2, "the first campaign is unchanged");
  } finally {
    if (tag) await purge(core, tag);
    await core.close();
  }
});
