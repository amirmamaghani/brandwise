// YouTube connector, pure: the OAuth refresh and the resumable upload, on recorded response shapes (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignSlug } from "./email/domain/render.ts";
import { youtube, youtubeOAuth, youtubeStatus, YOUTUBE_TOKEN_KEY } from "./connector-youtube.ts";
import type { PublishInput, ScopedTokens } from "./publish.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
const entry = (over: Record<string, unknown> = {}) => ({ id: "e1", campaignId: "c1", title: "Fall drop", body: "Hello", link: "https://example.com", campaignName: "Spring Sale", ...over }) as PublishInput["entry"];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const video = { kind: "video", mime: "video/mp4", name: "a.mp4", bytes: 3, read: async () => new Uint8Array([1, 2, 3]), url: async () => "https://s3.example/a.mp4" };

function fakeGoogle(answer: (key: string, call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init: any) => {
    const url = String(input);
    const b = init?.body;
    const body = b instanceof URLSearchParams ? Object.fromEntries(b) : typeof b === "string" ? JSON.parse(b) : b instanceof Blob ? `<${b.size} bytes>` : b ?? null;
    const call: Call = { method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body };
    calls.push(call);
    const u = new URL(url);
    const r = answer(`${call.method} ${u.origin}${u.pathname}`, call);
    return r instanceof Response ? r : json(r);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const memoryTokens = (initial: string | null): ScopedTokens => {
  const saved: Record<string, string> = initial ? { [YOUTUBE_TOKEN_KEY]: initial } : {};
  return { get: async (_c, key) => saved[key] ?? null, set: async (_c, key, value) => { saved[key] = value; } };
};
const app = { clientId: "ID", clientSecret: "SECRET" };

test("a video is uploaded: refresh, a resumable session with the metadata, one PUT with the bytes", async () => {
  const g = fakeGoogle((key) => {
    if (key === "POST https://oauth2.googleapis.com/token") return { access_token: "ACCESS", expires_in: 3599 };
    if (key === "POST https://www.googleapis.com/upload/youtube/v3/videos") return new Response(null, { status: 200, headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=U1" } });
    if (key === "PUT https://www.googleapis.com/upload/youtube/v3/videos") return json({ id: "dQw4w9WgXcQ", snippet: {} }, 201);
    throw new Error(`unexpected ${key}`);
  });
  const c = youtube({ ...app, tokens: memoryTokens("REFRESH"), fetchImpl: g.fetchImpl });
  const r = await c.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: { channelId: "UC1", title: "Demo", privacy: "unlisted" } });
  assert.deepEqual(r, { externalId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.deepEqual(g.calls[0].body, { client_id: "ID", client_secret: "SECRET", grant_type: "refresh_token", refresh_token: "REFRESH" });
  const init = g.calls[1];
  assert.equal(new URL(init.url).search, "?uploadType=resumable&part=snippet,status");
  assert.deepEqual(init.headers, { authorization: "Bearer ACCESS", "content-type": "application/json; charset=UTF-8", "x-upload-content-type": "video/mp4", "x-upload-content-length": "3" });
  assert.deepEqual(init.body, { snippet: { title: "Fall drop", description: `Hello\n\nhttps://example.com/?utm_source=youtube&utm_medium=social&utm_campaign=${campaignSlug("Spring Sale")}&utm_content=e1` }, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false } });
  const put = g.calls[2];
  assert.match(put.url, /upload_id=U1$/);
  assert.deepEqual(put.headers, { "content-type": "video/mp4", "content-length": "3" });
  assert.equal(put.body, "<3 bytes>");
});

test("refusals and Google errors: no video, no title, title too long, bad privacy, no channel, quota", async () => {
  const g = fakeGoogle((key) => {
    if (key === "POST https://oauth2.googleapis.com/token") return { access_token: "ACCESS", expires_in: 3599 };
    if (key === "POST https://www.googleapis.com/upload/youtube/v3/videos") return json({ error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } }, 403);
    throw new Error(`unexpected ${key}`);
  });
  const c = youtube({ ...app, tokens: memoryTokens("REFRESH"), fetchImpl: g.fetchImpl });
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: {} }), /is a video/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry({ title: " " }), asset: video, target: {} }), /needs a title/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry({ title: "x".repeat(101) }), asset: video, target: {} }), /101 characters, YouTube allows 100/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: { privacy: "secret" } }), /must be public, unlisted or private/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: {} }), /videos\.insert: The request cannot be completed.*\(quotaExceeded\)/);
  assert.equal(g.calls.length, 2, "nothing is called before the checks pass");
  const none = youtube({ ...app, tokens: memoryTokens(null), fetchImpl: g.fetchImpl });
  await assert.rejects(none.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: {} }), /no YouTube channel: a person runs bb brandwise youtube connect/);
});

test("oauth: the sign-in address asks for a refresh token; the exchange and refresh are form posts; status names the channel", async () => {
  const u = new URL(youtubeOAuth(app).authorizeUrl("http://localhost:38896/api/v1/plugins/brandwise/http/oauth/youtube", "st8"));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = Object.fromEntries(u.searchParams);
  assert.equal(p.access_type, "offline");
  assert.equal(p.prompt, "consent");
  assert.equal(p.scope, "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");
  assert.equal(p.redirect_uri, "http://localhost:38896/api/v1/plugins/brandwise/http/oauth/youtube");
  assert.equal(p.state, "st8");

  const g = fakeGoogle((key) => {
    if (key === "POST https://oauth2.googleapis.com/token") return { access_token: "ACCESS", refresh_token: "REFRESH", expires_in: 3599 };
    if (key === "GET https://www.googleapis.com/youtube/v3/channels") return { items: [{ id: "UC1", snippet: { title: "Demo Shop", customUrl: "@demoshop" } }] };
    throw new Error(`unexpected ${key}`);
  });
  const t = await youtubeOAuth(app, g.fetchImpl).exchange("the-code", "http://localhost/cb");
  assert.equal(t.refresh_token, "REFRESH");
  assert.deepEqual(g.calls[0].body, { client_id: "ID", client_secret: "SECRET", code: "the-code", grant_type: "authorization_code", redirect_uri: "http://localhost/cb" });
  const s = await youtubeStatus({ ...app, tokens: memoryTokens("REFRESH"), fetchImpl: g.fetchImpl }, "c1", { channelId: "UC1", title: "Demo Shop" });
  assert.deepEqual(s.lines, ["Demo Shop (@demoshop), channel UC1: connected", 'youtube target: {"channelId":"UC1","title":"Demo Shop"} (privacy: public; add privacy=unlisted to the target to upload unlisted)']);
  assert.equal(new URL(g.calls[2].url).search, "?part=snippet&mine=true");

  const bad = fakeGoogle(() => json({ error: "invalid_grant", error_description: "Bad Request" }, 400));
  await assert.rejects(youtubeOAuth(app, bad.fetchImpl).refresh("old"), /oauth token: Bad Request/);
});
