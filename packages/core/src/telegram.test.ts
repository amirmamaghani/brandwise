import assert from "node:assert/strict";
import { campaignSlug } from "./email/domain/render.ts";
import { test } from "node:test";
import { telegram } from "./connector-telegram.ts";
import type { PublishInput } from "./publish.ts";

const entry = (over: Record<string, unknown> = {}) => ({ id: "e1", title: "t", body: "Hello", link: "https://example.com", campaignName: "Spring Sale", ...over }) as PublishInput["entry"];
const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

test("telegram sends text, a photo with caption, and reports API errors", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body) });
    return url.includes("/sendPhoto") && (calls.at(-1)!.body as any).caption === "boom"
      ? new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })
      : reply({ message_id: 7, chat: { id: -100, username: "mychannel" } });
  }) as unknown as typeof fetch;
  const t = telegram({ token: "TOKEN", fetchImpl });
  const target = { chatId: "@mychannel" };

  const text = await t.publish({ idempotencyKey: "k", entry: entry(), asset: null, target });
  assert.deepEqual(text, { externalId: "-100:7", url: "https://t.me/mychannel/7" });
  assert.match(calls[0].url, /botTOKEN\/sendMessage$/);
  assert.deepEqual(calls[0].body, { chat_id: "@mychannel", text: `Hello\n\nhttps://example.com/?utm_source=telegram&utm_medium=messenger&utm_campaign=${campaignSlug(entry().campaignName)}&utm_content=${entry().id}` });

  const asset = { kind: "image", mime: "image/png", name: "a.png", bytes: 3, read: async () => new Uint8Array([1, 2, 3]), url: async () => "" };
  await t.publish({ idempotencyKey: "k", entry: entry(), asset, target });
  assert.match(calls[1].url, /sendPhoto$/);
  assert.match((calls[1].body as any).caption, /^Hello\n\nhttps:\/\/example\.com\/\?utm_source=telegram.*utm_content=/);

  await assert.rejects(t.publish({ idempotencyKey: "k", entry: entry({ body: "boom", link: null }), asset, target }), /chat not found/);
  await assert.rejects(t.publish({ idempotencyKey: "k", entry: entry({ body: "", link: null }), asset: null, target }), /no text/);
  await assert.rejects(t.publish({ idempotencyKey: "k", entry: entry({ body: "x".repeat(4100), link: null }), asset: null, target }), /4096/);
});

test("telegram refuses without a chat target", async () => {
  const t = telegram({ token: "TOKEN", fetchImpl: (async () => { throw new Error("must not call"); }) as unknown as typeof fetch });
  await assert.rejects(t.publish({ idempotencyKey: "k", entry: entry(), asset: null, target: null }), /No chatId/);
});
