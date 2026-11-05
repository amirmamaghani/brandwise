import assert from "node:assert/strict";
import { test } from "node:test";
import { telegram } from "../connector-telegram.ts";
import type { PublishInput } from "../publish.ts";
import { clientAddress, codeOf, isBot, newLinkId, replaceUrls, verifyCode } from "./domain.ts";
import { createLinks } from "./index.ts";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

test("codes: only a code we signed resolves", () => {
  const id = newLinkId(), code = codeOf("key", id);
  assert.equal(verifyCode("key", code), id);
  assert.equal(verifyCode("other key", code), null, "another installation's code");
  assert.equal(verifyCode("key", code.slice(0, -1) + (code.endsWith("A") ? "B" : "A")), null, "a changed signature");
  assert.equal(verifyCode("key", `${newLinkId()}.${code.split(".")[1]}`), null, "a guessed id with a real signature");
  for (const junk of ["", "x", "../../etc", `${id}.`, `${code}x`]) assert.equal(verifyCode("key", junk), null, junk);
});

test("bots: previews, crawlers, scripts and HEAD requests are not clicks; a browser is", () => {
  for (const ua of ["TelegramBot (like TwitterBot)", "facebookexternalhit/1.1", "Slackbot-LinkExpanding 1.0", "WhatsApp/2.23", "LinkedInBot/1.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.4.0", "", "Mozilla/5.0 HeadlessChrome/120"])
    assert.equal(isBot("GET", ua), true, ua);
  assert.equal(isBot("HEAD", CHROME), true);
  assert.equal(isBot("GET", CHROME), false);
  assert.equal(isBot("GET", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Telegram-iOS"), false, "a person in Telegram's in-app browser");
});

test("the client address is the one our proxy appended, never what the client wrote before it", () => {
  assert.equal(clientAddress("6.6.6.6, 203.0.113.5"), "203.0.113.5", "a forged left entry is ignored");
  assert.equal(clientAddress("203.0.113.5"), "203.0.113.5");
  assert.equal(clientAddress(undefined), null);
  assert.equal(clientAddress(""), null);
});

test("replaceUrls keeps sentence punctuation outside the link", async () => {
  const out = await replaceUrls("See https://a.com/x. Or (https://b.com/y?z=1)!", async (u) => `<${u}>`);
  assert.equal(out, "See <https://a.com/x>. Or (<https://b.com/y?z=1>)!");
});

test("telegram posts our short links, made from the UTM-tagged links of the entry", async () => {
  const sent: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: -1, username: "c" } } })); }) as typeof fetch;
  const asked: string[] = [];
  const t = telegram({ token: "T", fetchImpl, shorten: async (entryId, url) => { asked.push(`${entryId} ${url}`); return `https://go.example.com/l?c=${asked.length}`; } });
  const entry = { id: "e1", title: "t", body: "New drop: https://shop.com/drop.", link: "https://shop.com/", campaignName: "Fall" } as PublishInput["entry"];
  await t.publish({ idempotencyKey: "k", entry, asset: null, target: { chatId: "@c" } });
  assert.equal(sent[0].text, "New drop: https://go.example.com/l?c=1.\n\nhttps://go.example.com/l?c=2");
  assert.ok(asked.every((a) => a.startsWith("e1 ") && a.includes("utm_content=e1")), "the target keeps the entry's UTM tags");
});

test("resolve: a click that cannot be recorded (database in recovery) still sends the visitor on", async () => {
  const id = newLinkId();
  const pool = { query: async (sql: string) => {
    if (sql.startsWith("select url")) return { rows: [{ url: "https://shop.example/?utm_content=e1" }] };
    throw new Error("the database system is in recovery mode");
  } } as unknown as import("pg").Pool;
  const links = createLinks({ pool, key: "key", baseUrl: () => "https://go.example/l", channels: ["telegram"] });
  const quiet = console.error; console.error = () => {};
  try {
    assert.equal(await links.resolve(codeOf("key", id), { method: "GET", userAgent: "Mozilla/5.0", ip: "203.0.113.9" }), "https://shop.example/?utm_content=e1");
  } finally { console.error = quiet; }
  assert.equal(await links.resolve("forged.code", { method: "GET", userAgent: "Mozilla/5.0", ip: null }), null, "a code we did not issue is still unknown");
});
