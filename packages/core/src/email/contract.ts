// Contract every e-mail provider must satisfy. Not a test file itself: each provider's test calls `runContract` with its own
// recorded payloads. This is what makes providers interchangeable: if it passes, metrics and ingest work for it unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_TYPES } from "./domain/types.ts";
import type { DetailKey } from "./domain/types.ts";
import type { EmailProvider } from "./domain/ports.ts";

export type ContractCase = {
  name: string;
  provider: EmailProvider;
  /** Recorded payloads of this provider and the event types each must produce ([] = must be ignored). */
  payloads: { body: string; types: string[] }[];
  /** Strings that must never appear in what we keep: recipient addresses, IPs. */
  forbiddenInRaw: string[];
  /** Headers that make `parseWebhook` accept `body`, and headers that must make it throw. */
  signed: (body: string) => Record<string, string>;
  unsigned: Record<string, string>;
  /** After `createCampaign`: assert nothing was sent. */
  assertDraftOnly: (externalId: string) => void;
};

const DETAIL_KEYS: Record<string, DetailKey> = { link: "link", bounceClass: "bounceClass", bounceReason: "bounceReason", failReason: "failReason", machine: "machine", device: "device", client: "client", country: "country" };

export function runContract(c: ContractCase) {
  const caps = c.provider.capabilities;
  test(`${c.name}: events are normalized, declared, and free of personal data`, () => {
    assert.ok(c.provider.events, "provider has an event source");
    const ids = new Set<string>();
    c.payloads.forEach((p, n) => {
      const events = c.provider.events!.parsePayload(p.body, `evt${n}`);
      assert.deepEqual(events.map((e) => e.type), p.types, `payload ${n}`);
      for (const e of events) {
        assert.equal(e.provider, c.provider.id);
        assert.ok((EVENT_TYPES as readonly string[]).includes(e.type));
        assert.ok(caps.emits.includes(e.type), `${e.type} is emitted but not declared in capabilities.emits`);
        assert.ok(e.providerEventId && !ids.has(e.providerEventId), "providerEventId is set and unique");
        ids.add(e.providerEventId);
        assert.ok(!Number.isNaN(Date.parse(e.at)));
        assert.ok(e.ref.externalId || e.ref.sendId, "an event must say which send it belongs to");
        assert.match(e.recipient.hash, /^[0-9a-f]{64}$/);
        for (const k of Object.keys(e.detail)) assert.ok(caps.details.includes(DETAIL_KEYS[k]), `detail "${k}" is used but not declared in capabilities.details`);
        const raw = JSON.stringify(e.raw);
        for (const bad of c.forbiddenInRaw) assert.ok(!raw.includes(bad), `raw keeps personal data: ${bad}`);
      }
    });
  });
  test(`${c.name}: webhook signature is enforced`, () => {
    const body = c.payloads.find((p) => p.types.length > 0)!.body;
    assert.ok(c.provider.events!.parseWebhook({ headers: c.signed(body), body }).length > 0);
    assert.throws(() => c.provider.events!.parseWebhook({ headers: c.unsigned, body }));
    assert.throws(() => c.provider.events!.parseWebhook({ headers: c.signed(body), body: body + " " }), "a changed body must fail");
  });
  test(`${c.name}: a campaign is created as a draft`, async () => {
    const { externalId } = await c.provider.sender!.createCampaign({ name: "n", subject: "s", html: `<p>x</p>${c.provider.sender!.unsubscribeTag}`, from: "A <a@example.com>", target: { segmentId: "seg" }, tags: { bw_entry: "e1" } });
    assert.ok(externalId);
    c.assertDraftOnly(externalId);
  });
}
