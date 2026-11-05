// LinkedIn connector, pure: the OAuth exchange, the versioned Posts API calls, image and video uploads, on recorded shapes (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignSlug } from "./email/domain/render.ts";
import { escapeLittleText, linkedin, linkedinConnection, linkedinOAuth, linkedinStatus, LINKEDIN_TOKEN_KEY, type LinkedInConnection } from "./connector-linkedin.ts";
import type { PublishInput, ScopedTokens } from "./publish.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
const entry = (over: Record<string, unknown> = {}) => ({ id: "e1", campaignId: "c1", title: "Fall drop", body: "Hello (all)", link: "https://example.com", campaignName: "Spring Sale", ...over }) as PublishInput["entry"];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const image = { kind: "image", mime: "image/png", name: "a.png", bytes: 3, read: async () => new Uint8Array([1, 2, 3]), url: async () => "" };
const video = { kind: "video", mime: "video/mp4", name: "a.mp4", bytes: 80_000, read: async () => new Uint8Array(80_000), url: async () => "" };
const app = { clientId: "ID", clientSecret: "SECRET" };
const NOW = new Date("2026-11-06T12:00:00Z");
const fresh: LinkedInConnection = { token: "TOKEN", expiresAt: "2027-01-04T12:00:00Z" };

function fakeLinkedIn(answer: (key: string, call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init: any) => {
    const url = String(input);
    const b = init?.body;
    const body = b instanceof URLSearchParams ? Object.fromEntries(b) : typeof b === "string" ? JSON.parse(b) : b instanceof Blob ? `<${b.size} bytes>` : b ?? null;
    const call: Call = { method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body };
    calls.push(call);
    const u = new URL(url);
    const r = answer(`${call.method} ${u.host}${u.pathname}${u.search}`, call);
    return r instanceof Response ? r : json(r);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const memoryTokens = (initial: LinkedInConnection | null): ScopedTokens & { saved: Record<string, string> } => {
  const saved: Record<string, string> = initial ? { [LINKEDIN_TOKEN_KEY]: JSON.stringify(initial) } : {};
  return { saved, get: async (_c, key) => saved[key] ?? null, set: async (_c, key, value) => { saved[key] = value; } };
};
const utm = `utm_source=linkedin&utm_medium=social&utm_campaign=${campaignSlug("Spring Sale")}&utm_content=e1`;

test("little text: formatting characters are escaped, hashtags are not", () => {
  assert.equal(escapeLittleText("Hi (all) #sale @you a_b *x* <y> [z] {w} | ~ \\"), "Hi \\(all\\) #sale \\@you a\\_b \\*x\\* \\<y\\> \\[z\\] \\{w\\} \\| \\~ \\\\");
});

test("a text post: the member is the author, the link is an article card, every call names the API version", async () => {
  const t = fakeLinkedIn((key) => (key === "POST api.linkedin.com/rest/posts" ? new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7000" } }) : (() => { throw new Error(`unexpected ${key}`); })()));
  const c = linkedin({ ...app, tokens: memoryTokens(fresh), fetchImpl: t.fetchImpl, now: () => NOW, version: "202610" });
  const r = await c.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { personId: "AbC", name: "Demo" } });
  assert.deepEqual(r, { externalId: "urn:li:share:7000", url: "https://www.linkedin.com/feed/update/urn:li:share:7000/" });
  const post = t.calls[0];
  assert.deepEqual(post.headers, { authorization: "Bearer TOKEN", "linkedin-version": "202610", "x-restli-protocol-version": "2.0.0", "content-type": "application/json" });
  assert.deepEqual(post.body, {
    author: "urn:li:person:AbC", commentary: "Hello \\(all\\)", visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    content: { article: { source: `https://example.com/?${utm}`, title: "Fall drop" } },
  });
});

test("an image is uploaded first and attached; a company Page author comes from the target", async () => {
  const t = fakeLinkedIn((key) => {
    if (key === "POST api.linkedin.com/rest/images?action=initializeUpload") return { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", image: "urn:li:image:IMG" } };
    if (key === "PUT www.linkedin.com/dms-uploads/x") return new Response(null, { status: 201 });
    if (key === "POST api.linkedin.com/rest/posts") return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7001" } });
    throw new Error(`unexpected ${key}`);
  });
  const c = linkedin({ ...app, tokens: memoryTokens(fresh), fetchImpl: t.fetchImpl, now: () => NOW, shorten: async (id, url) => `https://go.example/l?c=${id}-${new URL(url).hostname}` });
  const r = await c.publish({ idempotencyKey: "k", entry: entry(), asset: image, target: { personId: "AbC", organizationId: "5515715" } });
  assert.equal(r.externalId, "urn:li:share:7001");
  assert.deepEqual(t.calls[0].body, { initializeUploadRequest: { owner: "urn:li:organization:5515715" } });
  assert.equal(t.calls[1].headers["content-type"], "application/octet-stream");
  assert.equal(t.calls[1].body, "<3 bytes>");
  const post = t.calls[2].body as any;
  assert.equal(post.author, "urn:li:organization:5515715");
  assert.equal(post.commentary, "Hello \\(all\\)\n\nhttps://go.example/l?c=e1-example.com", "with media the link goes into the text, escaped");
  assert.deepEqual(post.content, { media: { id: "urn:li:image:IMG", altText: "Fall drop" } });
});

test("a video goes up in the parts LinkedIn names, is finalised with their ETags and waited for", async () => {
  let polls = 0;
  const t = fakeLinkedIn((key) => {
    if (key === "POST api.linkedin.com/rest/videos?action=initializeUpload") return { value: { video: "urn:li:video:V", uploadToken: "tok", uploadInstructions: [{ uploadUrl: "https://up.linkedin.com/p1", firstByte: 0, lastByte: 49_999 }, { uploadUrl: "https://up.linkedin.com/p2", firstByte: 50_000, lastByte: 79_999 }] } };
    if (key === "PUT up.linkedin.com/p1") return new Response(null, { status: 200, headers: { etag: "E1" } });
    if (key === "PUT up.linkedin.com/p2") return new Response(null, { status: 200, headers: { etag: "E2" } });
    if (key === "POST api.linkedin.com/rest/videos?action=finalizeUpload") return new Response(null, { status: 200 });
    if (key === "GET api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3AV") return ++polls < 2 ? { status: "PROCESSING" } : { status: "AVAILABLE" };
    if (key === "POST api.linkedin.com/rest/posts") return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:ugcPost:7002" } });
    throw new Error(`unexpected ${key}`);
  });
  const c = linkedin({ ...app, tokens: memoryTokens(fresh), fetchImpl: t.fetchImpl, now: () => NOW, wait: async () => {} });
  const r = await c.publish({ idempotencyKey: "k", entry: entry({ link: null }), asset: video, target: { personId: "AbC" } });
  assert.equal(r.externalId, "urn:li:ugcPost:7002");
  assert.deepEqual(t.calls[0].body, { initializeUploadRequest: { owner: "urn:li:person:AbC", fileSizeBytes: 80_000, uploadCaptions: false, uploadThumbnail: false } });
  assert.equal(t.calls[1].body, "<50000 bytes>");
  assert.equal(t.calls[2].body, "<30000 bytes>");
  assert.deepEqual(t.calls[3].body, { finalizeUploadRequest: { video: "urn:li:video:V", uploadToken: "tok", uploadedPartIds: ["E1", "E2"] } });
  assert.equal(polls, 2);
  assert.deepEqual((t.calls.at(-1)!.body as any).content, { media: { id: "urn:li:video:V", title: "Fall drop" } });
});

test("refusals and API errors: no target, wrong media, video size, an expired connection, a 403 with LinkedIn's code", async () => {
  const t = fakeLinkedIn(() => json({ status: 403, code: "ACCESS_DENIED", message: "Not enough permissions to access: posts.CREATE.NO_VERSION" }, 403));
  const c = linkedin({ ...app, tokens: memoryTokens(fresh), fetchImpl: t.fetchImpl, now: () => NOW });
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: null }), /No personId/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: { ...image, mime: "image/webp", name: "a.webp" }, target: { personId: "A" } }), /JPEG, PNG or GIF images and MP4 videos; a\.webp/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: { ...video, bytes: 100 }, target: { personId: "A" } }), /75 KB to 500 MB/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { personId: "A" } }), /POST \/rest\/posts: Not enough permissions.*\(ACCESS_DENIED\)/);
  const expired = linkedin({ ...app, tokens: memoryTokens({ token: "T", expiresAt: "2026-11-01T00:00:00Z" }), fetchImpl: t.fetchImpl, now: () => NOW });
  await assert.rejects(expired.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { personId: "A" } }), /expired on 2026-11-01 .*connect again/);
  const none = linkedin({ ...app, tokens: memoryTokens(null), fetchImpl: t.fetchImpl });
  await assert.rejects(none.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { personId: "A" } }), /no LinkedIn member: a person runs bb brandwise linkedin connect/);
});

test("oauth: the sign-in address, the exchange (60 days, no refresh token for ordinary apps), renewal when one exists, status", async () => {
  const u = new URL(linkedinOAuth(app).authorizeUrl("https://x.example/oauth/linkedin", "st8"));
  assert.equal(u.origin + u.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.deepEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: "ID", redirect_uri: "https://x.example/oauth/linkedin", state: "st8", scope: "openid profile w_member_social" });

  const t = fakeLinkedIn((key) => {
    if (key === "POST www.linkedin.com/oauth/v2/accessToken") return { access_token: "TOKEN", expires_in: 5_184_000, scope: "openid,profile,w_member_social" };
    if (key === "GET api.linkedin.com/v2/userinfo") return { sub: "AbC", name: "Demo Person" };
    throw new Error(`unexpected ${key}`);
  });
  const c = await linkedinOAuth(app, t.fetchImpl).exchange("the-code", "https://x.example/oauth/linkedin", NOW);
  assert.deepEqual(t.calls[0].body, { client_id: "ID", client_secret: "SECRET", grant_type: "authorization_code", code: "the-code", redirect_uri: "https://x.example/oauth/linkedin" });
  assert.deepEqual(c, { token: "TOKEN", expiresAt: new Date(NOW.getTime() + 5_184_000_000).toISOString() });
  const s = await linkedinStatus({ ...app, tokens: memoryTokens(c), fetchImpl: t.fetchImpl, now: () => NOW }, "c1", null);
  assert.equal(s.lines[0], "Demo Person (member AbC): connected, token ends in 60 days; LinkedIn gives no refresh token to this app, so connect again before then");

  // a partner app: the token is a week from its end and a refresh token exists, so it is renewed and saved
  const r = fakeLinkedIn(() => ({ access_token: "TOKEN-2", expires_in: 5_184_000, refresh_token: "R-2", refresh_token_expires_in: 31_536_000 }));
  const tokens = memoryTokens({ token: "TOKEN", expiresAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), refreshToken: "R-1", refreshExpiresAt: "2027-06-01T00:00:00Z" });
  const renewed = await linkedinConnection({ ...app, tokens, fetchImpl: r.fetchImpl, now: () => NOW }, "c1");
  assert.equal(renewed.token, "TOKEN-2");
  assert.equal(renewed.refreshToken, "R-2");
  assert.deepEqual(r.calls[0].body, { client_id: "ID", client_secret: "SECRET", grant_type: "refresh_token", refresh_token: "R-1" });
  assert.equal(JSON.parse(tokens.saved[LINKEDIN_TOKEN_KEY]).token, "TOKEN-2");
});
