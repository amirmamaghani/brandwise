// TikTok connector, pure: the OAuth refresh, the Direct Post calls and the chunked upload, on recorded response shapes (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkPlan, privacyFor, tiktok, tiktokOAuth, tiktokStatus, TIKTOK_TOKEN_KEY } from "./connector-tiktok.ts";
import type { PublishInput, ScopedTokens } from "./publish.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
const entry = (over: Record<string, unknown> = {}) => ({ id: "e1", campaignId: "c1", title: "Fall drop", body: "Hello", link: "https://example.com", campaignName: "Spring Sale", ...over }) as PublishInput["entry"];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const video = { kind: "video", mime: "video/mp4", name: "a.mp4", bytes: 3, read: async () => new Uint8Array([1, 2, 3]), url: async () => "https://s3.example/a.mp4" };
const creator = { creator_username: "demoshop", creator_nickname: "Demo Shop", privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 };
const tokensReply = { access_token: "ACCESS", expires_in: 7200, refresh_token: "REFRESH-2", refresh_expires_in: 15_552_000, open_id: "open-1", scope: "user.info.basic,video.publish" };

/** A fake TikTok: `answer` maps "METHOD <path or full url>" to a body or Response; records every call with its parsed body. */
function fakeTikTok(answer: (key: string, call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init: any) => {
    const url = String(input);
    const b = init?.body;
    const body = b instanceof URLSearchParams ? Object.fromEntries(b) : typeof b === "string" ? JSON.parse(b) : b instanceof Blob ? `<${b.size} bytes>` : b ?? null;
    const call: Call = { method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body };
    calls.push(call);
    const key = `${call.method} ${url.startsWith("https://open.tiktokapis.com") ? new URL(url).pathname : url}`;
    const r = answer(key, call);
    return r instanceof Response ? r : json(r);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
/** Tokens of one campaign, in memory. */
const memoryTokens = (initial: string | null): ScopedTokens & { saved: Record<string, string> } => {
  const saved: Record<string, string> = initial ? { [TIKTOK_TOKEN_KEY]: initial } : {};
  return { saved, get: async (_c, key) => saved[key] ?? null, set: async (_c, key, value) => { saved[key] = value; } };
};

test("chunk plan: one chunk up to 64 MB, 32 MB chunks above, the last one takes the remainder", () => {
  assert.deepEqual(chunkPlan(3), { size: 3, count: 1 });
  assert.deepEqual(chunkPlan(64_000_000), { size: 64_000_000, count: 1 });
  assert.deepEqual(chunkPlan(100_000_000), { size: 32_000_000, count: 3 });
});

test("privacy: the target's choice when allowed, otherwise the most public level; a refused choice names what TikTok allows", () => {
  assert.equal(privacyFor(undefined, creator.privacy_level_options), "PUBLIC_TO_EVERYONE");
  assert.equal(privacyFor(undefined, ["SELF_ONLY"]), "SELF_ONLY");
  assert.equal(privacyFor("SELF_ONLY", creator.privacy_level_options), "SELF_ONLY");
  assert.throws(() => privacyFor("PUBLIC_TO_EVERYONE", ["SELF_ONLY"]), /not audited by TikTok yet/);
  assert.throws(() => privacyFor("FOLLOWER_OF_CREATOR", creator.privacy_level_options), /allows PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY/);
});

test("a video is posted: refresh (the rotated token is saved), creator info, init, one chunk, status until complete", async () => {
  let statusCalls = 0;
  const t = fakeTikTok((key) => {
    if (key === "POST /v2/oauth/token/") return tokensReply;
    if (key === "POST /v2/post/publish/creator_info/query/") return { data: creator, error: { code: "ok", message: "" } };
    if (key === "POST /v2/post/publish/video/init/") return { data: { publish_id: "v_pub_1", upload_url: "https://upload.tiktok/x?y=1" }, error: { code: "ok" } };
    if (key === "PUT https://upload.tiktok/x?y=1") return new Response(null, { status: 201 });
    if (key === "POST /v2/post/publish/status/fetch/") return ++statusCalls < 2 ? { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } } : { data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7355608] }, error: { code: "ok" } };
    throw new Error(`unexpected ${key}`);
  });
  const tokens = memoryTokens("REFRESH-1");
  const waited: number[] = [];
  const c = tiktok({ clientKey: "K", clientSecret: "S", tokens, fetchImpl: t.fetchImpl, wait: async (ms) => { waited.push(ms); }, shorten: async (id, url) => `https://go.example/l?c=${id}-${new URL(url).hostname}` });
  const r = await c.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: { openId: "open-1", username: "demoshop" } });
  assert.deepEqual(r, { externalId: "7355608", url: "https://www.tiktok.com/@demoshop/video/7355608" });
  assert.deepEqual(t.calls[0].body, { client_key: "K", client_secret: "S", grant_type: "refresh_token", refresh_token: "REFRESH-1" });
  assert.equal(tokens.saved[TIKTOK_TOKEN_KEY], "REFRESH-2", "TikTok rotates the refresh token; the new one is kept");
  assert.equal(t.calls[1].headers.authorization, "Bearer ACCESS");
  assert.deepEqual(t.calls[2].body, {
    post_info: { title: "Hello\n\nhttps://go.example/l?c=e1-example.com", privacy_level: "PUBLIC_TO_EVERYONE", disable_duet: true, disable_comment: false, disable_stitch: false },
    source_info: { source: "FILE_UPLOAD", video_size: 3, chunk_size: 3, total_chunk_count: 1 },
  });
  assert.equal(t.calls[3].method, "PUT");
  assert.deepEqual(t.calls[3].headers, { "content-type": "video/mp4", "content-length": "3", "content-range": "bytes 0-2/3" });
  assert.equal(t.calls[3].body, "<3 bytes>");
  assert.deepEqual(t.calls[4].body, { publish_id: "v_pub_1" });
  assert.equal(statusCalls, 2);
  assert.equal(waited.length, 2);
});

test("a post TikTok is still processing is recorded by its publish id, a failed one is an error with TikTok's reason", async () => {
  const slow = fakeTikTok((key) => {
    if (key === "POST /v2/oauth/token/") return tokensReply;
    if (key.endsWith("/creator_info/query/")) return { data: creator, error: { code: "ok" } };
    if (key.endsWith("/video/init/")) return { data: { publish_id: "v_pub_2", upload_url: "https://upload.tiktok/x" }, error: { code: "ok" } };
    if (key.startsWith("PUT ")) return new Response(null, { status: 201 });
    if (key.endsWith("/status/fetch/")) return { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } };
    throw new Error(`unexpected ${key}`);
  });
  const c = tiktok({ clientKey: "K", clientSecret: "S", tokens: memoryTokens("R"), fetchImpl: slow.fetchImpl, wait: async () => {} });
  assert.deepEqual(await c.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: {} }), { externalId: "v_pub_2", url: undefined });
  assert.equal(slow.calls.filter((x) => x.url.endsWith("/status/fetch/")).length, 24, "two minutes of polling, then it stops without posting again");

  const failed = fakeTikTok((key) => {
    if (key === "POST /v2/oauth/token/") return tokensReply;
    if (key.endsWith("/creator_info/query/")) return { data: creator, error: { code: "ok" } };
    if (key.endsWith("/video/init/")) return { data: { publish_id: "v_pub_3", upload_url: "https://upload.tiktok/x" }, error: { code: "ok" } };
    if (key.startsWith("PUT ")) return new Response(null, { status: 201 });
    return { data: { status: "FAILED", fail_reason: "duration_check_failed" }, error: { code: "ok" } };
  });
  const c2 = tiktok({ clientKey: "K", clientSecret: "S", tokens: memoryTokens("R"), fetchImpl: failed.fetchImpl, wait: async () => {} });
  await assert.rejects(c2.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: {} }), /did not publish the video: duration_check_failed/);
});

test("refusals: no video, a wrong type, a campaign without an account, an API error with TikTok's code", async () => {
  const t = fakeTikTok((key) => {
    if (key === "POST /v2/oauth/token/") return tokensReply;
    if (key.endsWith("/creator_info/query/")) return json({ error: { code: "access_token_invalid", message: "The access token is invalid" } }, 401);
    throw new Error(`unexpected ${key}`);
  });
  const c = tiktok({ clientKey: "K", clientSecret: "S", tokens: memoryTokens("R"), fetchImpl: t.fetchImpl, wait: async () => {} });
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: {} }), /is a video/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: { ...video, mime: "video/x-msvideo", name: "a.avi" }, target: {} }), /MP4, MOV or WebM; a\.avi/);
  await assert.rejects(c.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: {} }), /creator_info\/query\/: The access token is invalid \(access_token_invalid\)/);
  const none = tiktok({ clientKey: "K", clientSecret: "S", tokens: memoryTokens(null), fetchImpl: t.fetchImpl });
  await assert.rejects(none.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: {} }), /no TikTok account: a person runs bb brandwise tiktok connect/);
});

test("oauth: the sign-in address carries the scopes and state; a token error is reported; status tells what the account may post", async () => {
  const o = tiktokOAuth({ clientKey: "K", clientSecret: "S" });
  const u = new URL(o.authorizeUrl("https://x.example/oauth/tiktok", "st8"));
  assert.equal(u.origin + u.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.deepEqual(Object.fromEntries(u.searchParams), { client_key: "K", scope: "user.info.basic,video.publish", response_type: "code", redirect_uri: "https://x.example/oauth/tiktok", state: "st8" });

  const bad = fakeTikTok(() => json({ error: "invalid_grant", error_description: "Authorization code is expired." }, 400));
  await assert.rejects(tiktokOAuth({ clientKey: "K", clientSecret: "S" }, bad.fetchImpl).exchange("code", "https://x"), /Authorization code is expired/);
  assert.deepEqual(bad.calls[0].body, { client_key: "K", client_secret: "S", code: "code", grant_type: "authorization_code", redirect_uri: "https://x" });

  const t = fakeTikTok((key) => (key === "POST /v2/oauth/token/" ? tokensReply : { data: { ...creator, privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }));
  const s = await tiktokStatus({ clientKey: "K", clientSecret: "S", tokens: memoryTokens("R"), fetchImpl: t.fetchImpl }, "c1", null);
  assert.equal(s.connected, true);
  assert.match(s.lines[0], /^@demoshop \(Demo Shop\): connected, refresh token good for 180 days/);
  assert.match(s.lines[2], /not audited the app yet/);
  assert.match(s.lines[3], /target: none/);
  assert.deepEqual((await tiktokStatus({ clientKey: "K", clientSecret: "S", tokens: memoryTokens(null), fetchImpl: t.fetchImpl }, "c1", null)).lines, ["No TikTok account connected to this campaign: bb brandwise tiktok connect --campaign <c>"]);
});
