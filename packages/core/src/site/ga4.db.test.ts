// Integration test against the local stack (pnpm infra:up). Skipped without DATABASE_URL.
// The brand names its GA4 property once on its base campaign; every published entry under it, on any channel, gets its site visits and
// leads from the hourly pull, stored as snapshots and read "as of" a moment.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { mock } from "../connector-mock.ts";
import { createCore, configFromEnv } from "../index.ts";
import { createMetrics } from "../metrics/index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { purge } from "../testing.ts";
import { ga4Source } from "./ga4.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

run("GA4: the base campaign's property measures entries of its child campaigns; snapshots build up per pull", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}-ga4`;
  try {
    const base = await core.campaigns.add({ name: `${tag}-base`, kind: "always_on" });
    const spring = await core.campaigns.add({ name: `${tag}-spring`, kind: "campaign", parentId: base.id });
    await core.channels.set(base.id, "site", { propertyId: "312345678", leadEvents: "generate_lead" });
    const e = await core.calendar.add({ campaignId: spring.id, title: "Spring post", channel: "mock", scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1 });
    assert.equal((await runDue(core, [mock], 5, [spring.id])).find((o) => o.id === e.id)?.result, "published");

    let visits = 12, leads = 1;
    const fetchImpl = (async (url: string, init: any) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
      const ids: string[] = JSON.parse(init.body).dimensionFilter.filter.inListFilter.values;
      return Response.json({ rows: ids.filter((id) => id === e.id).map((id) => ({ dimensionValues: [{ value: id }], metricValues: [{ value: String(visits) }, { value: String(leads) }, { value: "0" }, { value: "0" }] })) });
    }) as typeof fetch;
    const ga4 = ga4Source({ credentials: () => ({ client_email: "bw@x.iam.gserviceaccount.com", private_key: key }), targetOf: (c) => core.channels.get(c, "site"), fetchImpl });
    const metrics = createMetrics({ core, sources: [ga4] });

    const t1 = new Date(Date.now() + 3_600_000), t2 = new Date(Date.now() + 2 * 3_600_000);
    const r1 = (await metrics.pull(t1, { source: "ga4" })).find((r) => r.source === "ga4")!;
    assert.equal(r1.error, undefined);
    assert.ok(r1.stored >= 4, "visits, leads, orders and revenue of our entry");
    visits = 30; leads = 4;
    await metrics.pull(t2, { source: "ga4" });
    assert.deepEqual((await metrics.entry(e.id, t1)).values, { visits: 12, leads: 1, orders: 0, revenue: 0 });
    assert.deepEqual((await metrics.entry(e.id, t2)).values, { visits: 30, leads: 4, orders: 0, revenue: 0 });
    assert.deepEqual((await metrics.campaign(base.id, t2)).find((m) => m.entryId === e.id)?.sources.leads, "ga4");
  } finally {
    await purge(core, tag);
    await core.close();
  }
});
