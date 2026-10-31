// In-memory provider for tests and local development: "sends" to nowhere and produces the events a real provider would.
import { createHash } from "node:crypto";
import type { EmailProvider } from "../domain/ports.ts";
import type { Capabilities, EmailEvent, Recipient } from "../domain/types.ts";

export const memoryCapabilities: Capabilities = {
  emits: ["sent", "delivered", "bounced", "complained", "opened", "clicked", "unsubscribed"],
  details: ["link", "bounceClass", "machine"],
  features: ["drafts"],
};

export function memoryProvider(cfg: { id?: string; /** prefix of campaign ids: tests that share a database need ids unique to the run */ idPrefix?: string; recipient: (address: string) => Recipient; recipients?: string[] }): EmailProvider & { campaigns: Map<string, { sent: boolean; subject: string; html: string }>; outbox: EmailEvent[] } {
  const campaigns = new Map<string, { sent: boolean; subject: string; html: string }>();
  const outbox: EmailEvent[] = [];
  const id = cfg.id ?? "memory";
  let n = 0;
  // the memory provider's own wire format: a JSON array of events with a plain "to" address
  const parsePayload = (body: string, eventId: string): EmailEvent[] =>
    (JSON.parse(body) as { type: EmailEvent["type"]; externalId: string; to: string; at?: string; detail?: EmailEvent["detail"] }[]).map((e, i) => ({
      provider: id, providerEventId: `${eventId}:${i}`, type: e.type, at: e.at ?? new Date().toISOString(), ref: { externalId: e.externalId },
      recipient: cfg.recipient(e.to), detail: e.detail ?? {}, raw: { type: e.type }, schemaVersion: 1 as const,
    }));
  const parseWebhook = ({ headers, body }: { headers: Record<string, string | undefined>; body: string }) => {
    if (headers["x-memory-signature"] !== createHash("sha256").update(body).digest("hex")) throw new Error("Invalid webhook signature");
    return parsePayload(body, headers["x-memory-id"] ?? "evt");
  };
  return {
    id,
    capabilities: memoryCapabilities,
    campaigns,
    outbox,
    sender: {
      unsubscribeTag: "{{unsubscribe}}",
      async createCampaign(d) {
        const externalId = `${cfg.idPrefix ?? "mem"}-${++n}`;
        campaigns.set(externalId, { sent: false, subject: d.subject, html: d.html });
        return { externalId };
      },
      async send(externalId) {
        const c = campaigns.get(externalId);
        if (!c) throw new Error(`Unknown campaign ${externalId}`);
        c.sent = true;
        const at = new Date().toISOString();
        for (const [i, address] of (cfg.recipients ?? ["a@example.com"]).entries()) {
          for (const type of ["sent", "delivered"] as const) outbox.push({ provider: id, providerEventId: `${externalId}:${i}:${type}`, type, at, ref: { externalId }, recipient: cfg.recipient(address), detail: {}, raw: { type }, schemaVersion: 1 });
        }
      },
      async status(externalId) {
        const c = campaigns.get(externalId);
        return !c ? "unknown" : c.sent ? "sent" : "draft";
      },
    },
    events: { parsePayload, parseWebhook },
  };
}
