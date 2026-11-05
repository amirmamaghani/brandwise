import assert from "node:assert/strict";
import { test } from "node:test";
import { PartialPullError, type EntryRef } from "../metrics/domain.ts";
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

test("meta: an id Meta refuses fails the batch, so each ad is asked alone; the others keep their numbers, the bad one is reported", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const ids = new URL(url).searchParams.get("ids")!.split(",");
    if (ids.includes("120210000000009")) return Response.json({ error: { message: "(#803) Some of the aliases you requested do not exist: 120210000000009", code: 803 } }, { status: 400 });
    return Response.json(Object.fromEntries(ids.map((id) => [id, { id, insights: { data: [{ impressions: "100", reach: "90", inline_link_clicks: "3", spend: "1.5" }] } }])));
  }) as typeof fetch;
  const src = metaAdsSource({ token: () => "TOKEN", version: () => "v23.0", fetchImpl });
  const err = await src.pull!([ref("a", "120210000000001"), ref("typo", "120210000000009"), ref("b", "120210000000002")], new Date()).then(() => null, (e) => e);
  assert.ok(err instanceof PartialPullError);
  assert.deepEqual(err.snapshots.map((s: any) => s.entryId).sort(), ["a", "b"]);
  assert.match(err.message, /ad 120210000000009 \(entry typo\): .*#803/);
  assert.equal(urls.length, 4, "one batch, then one read per ad");

  // an expired token fails every ad alike: one error, no read per ad
  const calls: string[] = [];
  const expired = (async (url: string) => { calls.push(url); return Response.json({ error: { message: "Error validating access token", code: 190 } }, { status: 400 }); }) as typeof fetch;
  await assert.rejects(metaAdsSource({ token: () => "T", version: () => "v23.0", fetchImpl: expired }).pull!([ref("a", "120210000000001"), ref("b", "120210000000002")], new Date()),
    (e: unknown) => !(e instanceof PartialPullError) && /expired or was revoked/.test(String(e)));
  assert.equal(calls.length, 1);
});
