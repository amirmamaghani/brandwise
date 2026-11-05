import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRef } from "../metrics/domain.ts";
import { adIdOf, metaAdsSource } from "./meta.ts";

const ref = (id: string, externalId: string | null): EntryRef => ({ id, campaignId: "c", channel: "meta_ads", externalId, externalUrl: null });

test("meta: lifetime insights per ad in one batched read; an ad without delivery has 0; an id Meta did not answer is unknown", async () => {
  const urls: string[] = [], auth: string[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    urls.push(url); auth.push(init.headers.authorization);
    return Response.json({
      "120210000000001": { id: "120210000000001", insights: { data: [{ impressions: "5400", reach: "3100", inline_link_clicks: "81", spend: "42.17", date_start: "2026-11-01", date_stop: "2026-11-04" }] } },
      "120210000000002": { id: "120210000000002" },
    });
  }) as typeof fetch;
  const src = metaAdsSource({ token: () => "TOKEN", version: () => "v23.0", fetchImpl });
  const snaps = await src.pull!([ref("a", "120210000000001"), ref("b", "meta:120210000000002"), ref("c", "120210000000003"), ref("d", "not an ad id"), ref("e", null)], new Date());
  assert.deepEqual(Object.fromEntries(snaps.map((s) => [s.entryId, s.values])), {
    a: { exposures: 5400, reach: 3100, clicks: 81, spend: 42.17 },
    b: { exposures: 0, reach: 0, clicks: 0, spend: 0 },
  });
  assert.equal(urls.length, 1);
  const u = new URL(urls[0]);
  assert.equal(u.pathname, "/v23.0/");
  assert.equal(u.searchParams.get("ids"), "120210000000001,120210000000002,120210000000003");
  assert.equal(u.searchParams.get("fields"), "insights.date_preset(maximum){impressions,reach,inline_link_clicks,spend}");
  assert.equal(auth[0], "Bearer TOKEN", "the token travels in a header, never in the URL");
  assert.ok(!urls[0].includes("TOKEN"));
});

test("meta: no token measures nothing; an expired token and a bad version say what to do", async () => {
  assert.deepEqual(await metaAdsSource({ token: () => null, version: () => "v23.0" }).pull!([ref("a", "120210000000001")], new Date()), []);
  const expired = (async () => Response.json({ error: { message: "Error validating access token", code: 190 } }, { status: 400 })) as typeof fetch;
  await assert.rejects(metaAdsSource({ token: () => "T", version: () => "v23.0", fetchImpl: expired }).pull!([ref("a", "120210000000001")], new Date()), /expired or was revoked/);
  await assert.rejects(metaAdsSource({ token: () => "T", version: () => "23", fetchImpl: expired }).pull!([ref("a", "120210000000001")], new Date()), /should look like v23\.0/);
  assert.equal(adIdOf({ externalId: "meta:120210000000001" }), "120210000000001");
  assert.equal(adIdOf({ externalId: "120210000000001/../x" }), null);
});
