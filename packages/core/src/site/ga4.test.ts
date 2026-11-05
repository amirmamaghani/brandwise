import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { EntryRef } from "../metrics/domain.ts";
import { assertion, ga4Source, parseServiceAccount, type ServiceAccount } from "./ga4.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa: ServiceAccount = { client_email: "bw@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const ref = (id: string, campaignId: string, channel = "telegram"): EntryRef => ({ id, campaignId, channel, externalId: null, externalUrl: null });
const NOW = new Date("2026-11-04T12:00:00.000Z");

test("assertion: a JWT for the read-only Analytics scope, signed with the service account's key", () => {
  const [h, c, s] = assertion(sa, NOW).split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.deepEqual([claims.iss, claims.scope, claims.aud, claims.exp - claims.iat], [sa.client_email, "https://www.googleapis.com/auth/analytics.readonly", "https://oauth2.googleapis.com/token", 3600]);
  assert.equal(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url")), true);
  assert.throws(() => parseServiceAccount("{"), /not valid JSON/);
  assert.throws(() => parseServiceAccount('{"client_email":"x"}'), /private_key/);
});

test("pull: one report per property by utm_content; leads are the named key events; an entry with no row had no visit; one token", async () => {
  const calls: { url: string; body: any; auth?: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    if (url.includes("oauth2")) { calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) }); return Response.json({ access_token: "tok", expires_in: 3600 }); }
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.authorization });
    if (url.includes("/properties/398765432:")) return Response.json({ rows: [{ dimensionValues: [{ value: "e3" }], metricValues: [{ value: "7" }, { value: "1" }, { value: "0" }, { value: "0" }] }] });
    return Response.json({ rows: [{ dimensionValues: [{ value: "e1" }], metricValues: [{ value: "40" }, { value: "3" }, { value: "2" }, { value: "1" }, { value: "59.5" }] }] });
  }) as typeof fetch;
  const targets: Record<string, Record<string, string> | null> = { brandA: { propertyId: "312345678", leadEvents: "generate_lead, sign_up" }, brandB: { propertyId: "398765432" }, none: null };
  const src = ga4Source({ credentials: () => sa, targetOf: async (c) => targets[c], fetchImpl });
  const snaps = await src.pull!([ref("e1", "brandA"), ref("e2", "brandA", "email"), ref("e3", "brandB"), ref("e4", "none")], NOW);

  assert.deepEqual(Object.fromEntries(snaps.map((s) => [s.entryId, s.values])), {
    e1: { visits: 40, leads: 5, orders: 1, revenue: 59.5 },
    e2: { visits: 0, leads: 0, orders: 0, revenue: 0 },
    e3: { visits: 7, leads: 1, orders: 0, revenue: 0 },
  }, "e4's brand names no property: not measured at all");
  const tokenCalls = calls.filter((c) => c.url.includes("oauth2"));
  assert.equal(tokenCalls.length, 1, "the token is reused for the second property");
  assert.equal(tokenCalls[0].body.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const a = calls.find((c) => c.url.endsWith("/properties/312345678:runReport"))!;
  assert.equal(a.auth, "Bearer tok");
  assert.deepEqual(a.body.metrics.map((m: any) => m.name), ["sessions", "keyEvents:generate_lead", "keyEvents:sign_up", "ecommercePurchases", "purchaseRevenue"]);
  assert.deepEqual(a.body.dimensionFilter.filter, { fieldName: "sessionManualAdContent", inListFilter: { values: ["e1", "e2"], caseSensitive: true } });
  assert.deepEqual(calls.find((c) => c.url.includes("/properties/398765432:"))!.body.metrics.map((m: any) => m.name)[1], "keyEvents", "no lead events named: every key event");
});

test("pull: no service account measures nothing; a bad property id or a missing permission says what to do", async () => {
  assert.deepEqual(await ga4Source({ credentials: () => null, targetOf: async () => ({ propertyId: "312345678" }) }).pull!([ref("e1", "c")], NOW), []);
  const denied = (async (url: string) => (url.includes("oauth2") ? Response.json({ access_token: "t", expires_in: 3600 }) : Response.json({ error: { message: "User does not have sufficient permissions" } }, { status: 403 }))) as typeof fetch;
  await assert.rejects(ga4Source({ credentials: () => sa, targetOf: async () => ({ propertyId: "312345678" }), fetchImpl: denied }).pull!([ref("e1", "c")], NOW), /add bw@proj\.iam\.gserviceaccount\.com to the property as a Viewer/);
  await assert.rejects(ga4Source({ credentials: () => sa, targetOf: async () => ({ propertyId: "../../x" }), fetchImpl: denied }).pull!([ref("e1", "c")], NOW), /is not a number/);
});
