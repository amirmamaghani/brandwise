import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { memoryProvider } from "./adapters/memory.ts";
import { resendCapabilities, resendProvider } from "./adapters/resend.ts";
import { runContract } from "./contract.ts";
import { eventsToCounts } from "./domain/counts.ts";
import { commonCapabilities, computeMetrics, METRICS } from "./domain/metrics.ts";
import { renderEmail, withUtm } from "./domain/render.ts";
import { recipientHasher } from "./index.ts";

const recipient = recipientHasher("test-salt");
const here = dirname(fileURLToPath(import.meta.url));

// ---- metrics: one definition, derived availability -------------------------------------------------------------------------

const ev = (type: string, who: string, detail: object = {}, sendId = "s1") => ({ sendId, type: type as never, recipientHash: who, detail });

test("counts: unique is decided by us, per recipient and send; duplicates and repeats do not inflate", () => {
  const c = eventsToCounts([
    ev("sent", "a"), ev("sent", "b"), ev("sent", "b"), // duplicate webhook
    ev("delivered", "a"), ev("delivered", "b"),
    ev("opened", "a", { machine: false }), ev("opened", "a", { machine: false }), ev("opened", "b", { machine: true }),
    ev("clicked", "a", { link: "https://x/1" }), ev("clicked", "a", { link: "https://x/1" }), ev("clicked", "a", { link: "https://x/2" }),
    ev("bounced", "c", { bounceClass: "hard" }), ev("complained", "a"),
    ev("opened", "a", { machine: false }, "s2"), // same person, another send: counts again
  ]);
  assert.deepEqual([c.sent, c.delivered], [2, 2]);
  assert.deepEqual(c.opened, { total: 4, unique: 3, humanUnique: 2 });
  assert.deepEqual([c.clicked.total, c.clicked.unique], [3, 1]);
  assert.deepEqual(c.clicked.perLink["https://x/1"], { total: 2, unique: 1 });
  assert.deepEqual(c.bounced, { hard: 1, soft: 0, unknown: 0 });
});

test("metrics: unavailable when the provider cannot emit what they need, never a fake zero", () => {
  const c = eventsToCounts([ev("sent", "a"), ev("delivered", "a"), ev("clicked", "a")]);
  const byId = Object.fromEntries(computeMetrics(c, resendCapabilities).map((m) => [m.id, m]));
  assert.equal(byId.click_rate.value, 1);
  assert.equal(byId.click_rate.available, true);
  assert.equal(byId.unsubscribe_rate.available, false, "Resend declares no unsubscribe events");
  assert.equal(byId.unsubscribe_rate.value, null);
  assert.equal(byId.human_open_rate.available, false, "Resend cannot tell machine opens");
  assert.equal(byId.open_rate.value, 0, "emitted, nobody opened: a real 0");
  assert.equal(computeMetrics(c, memoryProvider({ recipient }).capabilities).find((m) => m.id === "human_open_rate")!.available, true);
  assert.ok(METRICS.every((m) => m.requires.events.length > 0));
});

test("a report over sends of two providers shows only what both can do", () => {
  const both = commonCapabilities([resendCapabilities, memoryProvider({ recipient }).capabilities]);
  assert.ok(both.emits.includes("opened") && !both.emits.includes("deferred") && !both.emits.includes("unsubscribed"));
  assert.ok(!both.details.includes("machine"));
});

test("render: text becomes escaped paragraphs with the unsubscribe tag; html keeps its own; utm is added once", () => {
  const r = renderEmail({ body: "Hi <b>\n\nSecond", link: "https://example.com/p?a=1", entryId: "e1", unsubscribeTag: "{{TAG}}" });
  assert.match(r.html, /<p>Hi &lt;b&gt;<\/p>/);
  assert.match(r.html, /utm_campaign=e1/);
  assert.match(r.html, /utm_content=e1/, "the entry id is in utm_content (docs/analytics.md D6)");
  const tagged = renderEmail({ body: '<p><a href="https://e.com/a?x=1">A</a> <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">u</a> <a href="mailto:a@b.c">m</a> <a href="https://e.com/{{token}}">t</a></p>', link: null, entryId: "e2", unsubscribeTag: "{{{RESEND_UNSUBSCRIBE_URL}}}", campaign: "spring" });
  assert.match(tagged.html, /href="https:\/\/e\.com\/a\?x=1&amp;utm_source=brandwise&amp;utm_medium=email&amp;utm_campaign=spring&amp;utm_content=e2"/, "HTML and template bodies are tagged too");
  assert.ok(tagged.html.includes('href="{{{RESEND_UNSUBSCRIBE_URL}}}"') && tagged.html.includes('href="mailto:a@b.c"') && tagged.html.includes('href="https://e.com/{{token}}"'), "merge tokens, mailto and the unsubscribe link stay as they are");
  assert.match(renderEmail({ body: "See https://e.com/x today", link: null, entryId: "e3", unsubscribeTag: "{{u}}" }).html, /https:\/\/e\.com\/x\?utm_source=brandwise.*utm_content=e3/, "bare URLs in plain text too");
  assert.ok(r.html.includes("{{TAG}}") && r.text.includes("{{TAG}}"));
  assert.ok(renderEmail({ body: "<p>x</p>", link: null, entryId: "e", unsubscribeTag: "{{TAG}}" }).html.includes("{{TAG}}"), "footer added to html without one");
  assert.equal(renderEmail({ body: "<p>{{TAG}}</p>", link: null, entryId: "e", unsubscribeTag: "{{TAG}}" }).html, "<p>{{TAG}}</p>");
  assert.equal(withUtm("https://e.com/?utm_source=keep", "e1").match(/utm_source=keep/)?.length, 1);
});

// ---- dependency rules ------------------------------------------------------------------------------------------------------

test("dependency rule: domain imports only domain; adapters import only domain and node built-ins", () => {
  const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  for (const f of readdirSync(join(here, "domain"))) {
    for (const i of imports(join(here, "domain", f))) assert.ok(!i.startsWith("../") && !i.startsWith("node:") && i !== "pg", `domain/${f} must not import ${i}`);
  }
  for (const f of readdirSync(join(here, "adapters")).filter((x) => x !== "index.ts")) {
    for (const i of imports(join(here, "adapters", f))) assert.ok(i.startsWith("../domain/") || i.startsWith("./") || i.startsWith("node:crypto"), `adapters/${f} imports ${i}`);
  }
});

// ---- the contract, for every provider --------------------------------------------------------------------------------------

const SECRET = "whsec_" + Buffer.from("test-signing-secret").toString("base64");
const NOW = Date.parse("2026-10-30T12:00:00Z");
const svix = (body: string, id = "msg_1", ts = String(Math.floor(NOW / 1000))) => ({ "svix-id": id, "svix-timestamp": ts, "svix-signature": "v1," + createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64") });

const base = (type: string, extra: object = {}, to = ["person@example.com"]) =>
  JSON.stringify({ type, created_at: "2026-10-30T11:00:00.000Z", data: { broadcast_id: "bc-1", created_at: "2026-10-30T11:00:00.000Z", email_id: "em-1", message_id: "m-1", from: "News <news@brand.com>", to, subject: "Hi", template_id: null, tags: {}, ...extra } });

export const resendFixtures = {
  sent: base("email.sent"), delivered: base("email.delivered"), opened: base("email.opened"),
  clicked: base("email.clicked", { click: { ipAddress: "203.0.113.7", link: "https://brand.com/offer", timestamp: "2026-10-30T11:05:00.000Z", userAgent: "UA" } }),
  bounced: base("email.bounced", { bounce: { message: "Mailbox full", type: "Temporary", subType: "General" } }),
  hardBounced: base("email.bounced", { bounce: { message: "No such user", type: "Permanent", subType: "General" } }),
  complained: base("email.complained"), failed: base("email.failed", { failed: { reason: "reached_daily_quota" } }),
  notBroadcast: JSON.stringify({ type: "email.delivered", created_at: "2026-10-30T11:00:00.000Z", data: { email_id: "x", to: ["p@example.com"], tags: {} } }),
  otherKind: JSON.stringify({ type: "domain.updated", created_at: "2026-10-30T11:00:00.000Z", data: {} }),
};

const calls: { method: string; path: string; body: any }[] = [];
const resend = resendProvider({
  apiKey: "re_test", webhookSecret: SECRET, recipient, now: () => NOW,
  fetchImpl: (async (url: string, init: any) => {
    calls.push({ method: init.method, path: url.replace("https://api.resend.com", ""), body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ id: "bc-new", status: "draft" }), { status: 200 });
  }) as unknown as typeof fetch,
});

runContract({
  name: "resend", provider: resend, forbiddenInRaw: ["person@example.com", "203.0.113.7"],
  payloads: [
    { body: resendFixtures.sent, types: ["sent"] }, { body: resendFixtures.delivered, types: ["delivered"] }, { body: resendFixtures.opened, types: ["opened"] },
    { body: resendFixtures.clicked, types: ["clicked"] }, { body: resendFixtures.bounced, types: ["bounced"] }, { body: resendFixtures.complained, types: ["complained"] },
    { body: resendFixtures.failed, types: ["failed"] }, { body: base("email.opened", {}, ["a@example.com", "b@example.com"]), types: ["opened", "opened"] },
    { body: resendFixtures.notBroadcast, types: [] }, { body: resendFixtures.otherKind, types: [] },
  ],
  signed: svix, unsigned: { "svix-id": "msg_1", "svix-timestamp": String(Math.floor(NOW / 1000)), "svix-signature": "v1,AAAA" },
  assertDraftOnly: () => {
    const created = calls.find((c) => c.path === "/broadcasts")!;
    assert.equal(created.method, "POST");
    assert.equal(created.body.send, undefined, "must not ask Resend to send on create");
    assert.ok(!calls.some((c) => c.path.endsWith("/send")));
  },
});

test("resend: details, bounce class, signature tolerance and send call", async () => {
  const [click] = resend.events!.parsePayload(resendFixtures.clicked, "e");
  assert.equal(click.detail.link, "https://brand.com/offer");
  assert.equal(click.at, "2026-10-30T11:05:00.000Z");
  assert.equal(resend.events!.parsePayload(resendFixtures.bounced, "e")[0].detail.bounceClass, "soft");
  assert.equal(resend.events!.parsePayload(resendFixtures.hardBounced, "e")[0].detail.bounceClass, "hard");
  assert.deepEqual(resend.events!.parsePayload(base("email.opened", {}, ["a@example.com", "b@example.com"]), "e").map((e) => e.providerEventId), ["e:0", "e:1"]);
  assert.throws(() => resend.events!.parseWebhook({ headers: svix(resendFixtures.sent, "m", String(Math.floor(NOW / 1000) - 3600)), body: resendFixtures.sent }), /tolerance/);
  calls.length = 0;
  await resend.sender!.send("bc-1");
  assert.deepEqual([calls[0].method, calls[0].path], ["POST", "/broadcasts/bc-1/send"]);
});

const mem = memoryProvider({ recipient });
runContract({
  name: "memory", provider: mem, forbiddenInRaw: ["a@example.com"],
  payloads: [{ body: JSON.stringify([{ type: "opened", externalId: "mem-1", to: "a@example.com" }, { type: "clicked", externalId: "mem-1", to: "a@example.com", detail: { link: "https://x" } }]), types: ["opened", "clicked"] }],
  signed: (body) => ({ "x-memory-signature": createHash("sha256").update(body).digest("hex"), "x-memory-id": "e" }), unsigned: { "x-memory-signature": "bad" },
  assertDraftOnly: (id) => assert.equal(mem.campaigns.get(id)!.sent, false),
});
