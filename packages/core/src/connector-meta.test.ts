// Meta connectors, pure: the Graph API calls Facebook and Instagram posts make, on recorded response shapes (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignSlug } from "./email/domain/render.ts";
import { meta, metaStatus } from "./connector-meta.ts";
import type { PublishInput } from "./publish.ts";

type Call = { method: string; url: URL; auth: string | null; form: Record<string, unknown> | null };
const entry = (over: Record<string, unknown> = {}) => ({ id: "e1", title: "Fall drop", body: "Hello", link: "https://example.com", campaignName: "Spring Sale", ...over }) as PublishInput["entry"];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const image = { kind: "image", mime: "image/jpeg", name: "a.jpg", bytes: 3, read: async () => new Uint8Array([1, 2, 3]), url: async () => "https://s3.example/a.jpg?sig" };
const video = { ...image, kind: "video", mime: "video/mp4", name: "a.mp4", url: async () => "https://s3.example/a.mp4?sig" };

/** A fake Graph API: `answer` maps "METHOD /path" to a body; records every call. */
function fakeGraph(answer: (key: string, call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init: any) => {
    const url = new URL(String(input));
    const form = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, v instanceof Blob ? `<${v.type} ${v.size}B>` : v])) : null;
    const call: Call = { method: init?.method ?? "GET", url, auth: init?.headers?.authorization ?? null, form };
    calls.push(call);
    const body = answer(`${call.method} ${url.pathname.replace(/^\/v\d+\.\d+/, "")}`, call);
    return body instanceof Response ? body : json(body);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const utmOf = (source: string) => `utm_source=${source}&utm_medium=social&utm_campaign=${campaignSlug("Spring Sale")}&utm_content=e1`;

test("facebook: a text post goes to the Page feed with the Page's own token and the tagged link", async () => {
  const g = fakeGraph((key) => {
    if (key === "GET /123") return { access_token: "PAGE_TOKEN" };
    if (key === "POST /123/feed") return { id: "123_777" };
    throw new Error(`unexpected ${key}`);
  });
  const [fb] = meta({ token: "SYS", fetchImpl: g.fetchImpl });
  const r = await fb.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { pageId: "123" } });
  assert.deepEqual(r, { externalId: "123_777", url: "https://www.facebook.com/123_777" });
  assert.equal(g.calls[0].auth, "Bearer SYS");
  assert.equal(g.calls[1].auth, "Bearer PAGE_TOKEN", "the post is made with the Page token");
  assert.equal(g.calls[1].url.searchParams.get("message"), `Hello\n\nhttps://example.com/?${utmOf("facebook")}`);
  assert.equal(g.calls[1].url.searchParams.get("link"), `https://example.com/?${utmOf("facebook")}`);
  assert.ok(!g.calls.some((c) => c.url.search.includes("SYS") || c.url.search.includes("PAGE_TOKEN")), "tokens never travel in the URL");
});

test("facebook: a photo is uploaded as bytes with the text as caption, a video to the video host; links can be shortened", async () => {
  const g = fakeGraph((key) => {
    if (key === "GET /123") return { access_token: "P" };
    if (key === "POST /123/photos") return { id: "ph1", post_id: "123_ph1" };
    if (key === "POST /123/videos") return { id: "vid1" };
    throw new Error(`unexpected ${key}`);
  });
  const shorten = async (entryId: string, url: string) => `https://go.example/l?c=${entryId}-${new URL(url).hostname}`;
  const [fb] = meta({ token: "SYS", fetchImpl: g.fetchImpl, shorten });
  const photo = await fb.publish({ idempotencyKey: "k", entry: entry(), asset: image, target: { pageId: "123" } });
  assert.equal(photo.externalId, "123_ph1");
  assert.deepEqual(g.calls[1].form, { source: "<image/jpeg 3B>", caption: "Hello\n\nhttps://go.example/l?c=e1-example.com" });
  assert.equal(g.calls[1].url.host, "graph.facebook.com");
  const vid = await fb.publish({ idempotencyKey: "k", entry: entry({ body: "" }), asset: video, target: { pageId: "123" } });
  assert.equal(vid.externalId, "vid1");
  assert.equal(g.calls[3].url.host, "graph-video.facebook.com");
  assert.deepEqual(g.calls[3].form, { source: "<video/mp4 3B>", description: "https://go.example/l?c=e1-example.com", title: "Fall drop" });
});

test("facebook: refusals and Graph errors are reported, nothing is retried silently", async () => {
  const g = fakeGraph((key) => {
    if (key === "GET /123") return { access_token: "P" };
    if (key === "GET /999") return { id: "999" }; // a Page the token has no role on returns no access_token
    if (key === "POST /123/feed") return json({ error: { message: "(#200) Permissions error", code: 200, error_subcode: 1234 } }, 403);
    throw new Error(`unexpected ${key}`);
  });
  const [fb] = meta({ token: "SYS", fetchImpl: g.fetchImpl });
  await assert.rejects(fb.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: null }), /No pageId/);
  await assert.rejects(fb.publish({ idempotencyKey: "k", entry: entry({ body: "", link: null }), asset: null, target: { pageId: "123" } }), /no text and no creative/);
  await assert.rejects(fb.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { pageId: "999" } }), /no role on Page 999/);
  await assert.rejects(fb.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { pageId: "123" } }), /Meta POST \/123\/feed: \(#200\) Permissions error \(code 200\/1234\)/);
  const big = { ...image, bytes: 11_000_000 };
  await assert.rejects(fb.publish({ idempotencyKey: "k", entry: entry(), asset: big, target: { pageId: "123" } }), /too large/);
});

test("instagram: a photo becomes a container from the asset's URL and is published; the permalink is the post's address", async () => {
  const g = fakeGraph((key) => {
    if (key === "POST /178/media") return { id: "c1" };
    if (key === "POST /178/media_publish") return { id: "m1" };
    if (key === "GET /m1") return { permalink: "https://www.instagram.com/p/ABC/" };
    throw new Error(`unexpected ${key}`);
  });
  const [, ig] = meta({ token: "SYS", fetchImpl: g.fetchImpl });
  const r = await ig.publish({ idempotencyKey: "k", entry: entry(), asset: image, target: { accountId: "178" } });
  assert.deepEqual(r, { externalId: "m1", url: "https://www.instagram.com/p/ABC/" });
  assert.equal(g.calls[0].url.searchParams.get("image_url"), "https://s3.example/a.jpg?sig");
  assert.equal(g.calls[0].url.searchParams.get("caption"), `Hello\n\nhttps://example.com/?${utmOf("instagram")}`);
  assert.equal(g.calls[1].url.searchParams.get("creation_id"), "c1");
});

test("instagram: a video is a Reel whose container is polled until finished; a failed container is an error", async () => {
  let polls = 0;
  const g = fakeGraph((key) => {
    if (key === "POST /178/media") return { id: "c2" };
    if (key === "GET /c2") return ++polls < 3 ? { status_code: "IN_PROGRESS" } : { status_code: "FINISHED" };
    if (key === "POST /178/media_publish") return { id: "m2" };
    if (key === "GET /m2") return json({ error: { message: "nope" } }, 400); // no permalink is not a failure
    throw new Error(`unexpected ${key}`);
  });
  const waited: number[] = [];
  const [, ig] = meta({ token: "SYS", fetchImpl: g.fetchImpl, wait: async (ms) => { waited.push(ms); } });
  const r = await ig.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: { accountId: "178" } });
  assert.deepEqual(r, { externalId: "m2", url: undefined });
  assert.equal(g.calls[0].url.searchParams.get("media_type"), "REELS");
  assert.equal(g.calls[0].url.searchParams.get("video_url"), "https://s3.example/a.mp4?sig");
  assert.equal(polls, 3);
  assert.equal(waited.length, 3);

  const bad = fakeGraph((key) => (key === "POST /178/media" ? { id: "c3" } : { status_code: "ERROR", status: "Media is too long" }));
  const [, ig2] = meta({ token: "SYS", fetchImpl: bad.fetchImpl, wait: async () => {} });
  await assert.rejects(ig2.publish({ idempotencyKey: "k", entry: entry(), asset: video, target: { accountId: "178" } }), /did not accept the video: Media is too long/);
});

test("instagram: refuses without a target, without media, and with a non-JPEG photo", async () => {
  const g = fakeGraph(() => { throw new Error("must not call"); });
  const [, ig] = meta({ token: "SYS", fetchImpl: g.fetchImpl });
  await assert.rejects(ig.publish({ idempotencyKey: "k", entry: entry(), asset: image, target: null }), /No accountId/);
  await assert.rejects(ig.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: { accountId: "178" } }), /needs an image or a video/);
  await assert.rejects(ig.publish({ idempotencyKey: "k", entry: entry(), asset: { ...image, mime: "image/png", name: "a.png" }, target: { accountId: "178" } }), /JPEG photos only; a\.png is image\/png/);
  assert.equal(g.calls.length, 0);
});

test("meta test: lists the Pages and Instagram accounts of the token and checks the campaign's targets", async () => {
  const g = fakeGraph((key) => {
    if (key === "GET /me") return { id: "su1", name: "BrandWise publisher" };
    if (key === "GET /me/accounts") return { data: [{ id: "123", name: "Demo Shop", instagram_business_account: { id: "178", username: "demoshop" } }, { id: "456", name: "Other Page" }] };
    throw new Error(`unexpected ${key}`);
  });
  const s = await metaStatus({ token: "SYS", fetchImpl: g.fetchImpl }, { facebook: { pageId: "123" }, instagram: { accountId: "999" } });
  assert.equal(s.pages.length, 2);
  assert.deepEqual(s.lines, [
    "Token of BrandWise publisher (su1): 2 Pages it can post to",
    "  facebook pageId=123  Demo Shop   instagram accountId=178  @demoshop",
    "  facebook pageId=456  Other Page   (no Instagram account linked to this Page)",
    "facebook target 123: ok",
    "instagram target 999: NOT among the Instagram accounts of this token",
  ]);
  assert.equal(g.calls[1].url.searchParams.get("fields"), "id,name,instagram_business_account{id,username}");
});
