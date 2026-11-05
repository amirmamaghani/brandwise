// Integration test against the local stack (pnpm infra:up). Skipped without DATABASE_URL.
// A post goes out with our short links; people and previews open them; clicks become a metric of the entry.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { telegram } from "../connector-telegram.ts";
import { createCore, configFromEnv } from "../index.ts";
import { createMetrics } from "../metrics/index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { purge } from "../testing.ts";
import { createLinks } from "./index.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

run("short links: issued on publishing, resolved once per request, counted as unique human clicks of the entry", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}-links`;
  try {
    const links = createLinks({ pool: core.pool, key: "test-key", baseUrl: () => "https://go.example.com/l", channels: ["telegram"] });
    const base = await core.campaigns.add({ name: `${tag}-base`, kind: "always_on" });
    await core.channels.set(base.id, "telegram", { chatId: "@test" });
    const posted: string[] = [];
    const fetchImpl = (async (_u: string, init: any) => { posted.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: -1, username: "test" } } })); }) as typeof fetch;
    const entry = await core.calendar.add({ campaignId: base.id, title: "Drop", channel: "telegram", scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1, body: "Out now: https://shop.example.com/drop" });
    assert.equal((await runDue(core, [telegram({ token: "T", fetchImpl, shorten: links.shorten })], 5, [base.id])).find((o) => o.id === entry.id)?.result, "published");

    const short = /https:\/\/go\.example\.com\/l\?c=(\S+)/.exec(posted[0]);
    assert.ok(short, posted[0]);
    const code = short[1];
    assert.equal(await links.shorten(entry.id, (await links.stats(entry.id))[0].url), short[0], "the same link of the same entry keeps its code");
    const before = new Date();

    const target = await links.resolve(code, { method: "GET", userAgent: "TelegramBot (like TwitterBot)", ip: null });
    assert.match(target ?? "", /^https:\/\/shop\.example\.com\/drop\?utm_source=telegram.*utm_content=/, "the preview is redirected too");
    await links.resolve(code, { method: "GET", userAgent: CHROME, ip: "203.0.113.5" });
    await links.resolve(code, { method: "GET", userAgent: CHROME, ip: "203.0.113.5" });
    await links.resolve(code, { method: "GET", userAgent: CHROME, ip: "198.51.100.7" });
    assert.equal(await links.resolve(code.slice(0, -2) + "zz", { method: "GET", userAgent: CHROME, ip: null }), null, "a forged code");
    assert.deepEqual((await links.stats(entry.id)).map((r) => [r.clicks, r.visitors, r.bots]), [[3, 2, 1]]);

    const metrics = createMetrics({ core, sources: [links.metricsSource()] });
    assert.deepEqual((await metrics.entry(entry.id, new Date(Date.now() + 1000))).values, { clicks: 2 }, "unique people, not requests or previews");
    // one machine rotating its browser string adds at most three visitors
    for (let i = 0; i < 6; i++) await links.resolve(code, { method: "GET", userAgent: `${CHROME} r${i}`, ip: "192.0.2.9" });
    assert.deepEqual((await metrics.entry(entry.id, new Date(Date.now() + 1000))).values, { clicks: 5 }, "2 people + 3 of the six from one address");
    assert.deepEqual((await metrics.entry(entry.id, new Date(before.getTime() - 60_000))).values, { clicks: 0 }, "as of before the clicks");
    const raw = (await core.pool.query("select c.* from link_click c join short_link l on l.id = c.link_id where l.entry_id = $1", [entry.id])).rows;
    assert.ok(raw.every((r: any) => !JSON.stringify(r).includes("203.0.113.5") && !JSON.stringify(r).includes("Chrome")), "no address or browser string is stored");
  } finally {
    await purge(core, tag);
    await core.close();
  }
});
