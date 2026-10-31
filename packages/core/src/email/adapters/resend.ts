// Resend provider (https://resend.com/docs). Campaigns are Resend "Broadcasts"; events arrive as signed (Svix) webhooks.
// Docs read 2026-10-30: broadcasts cannot be tagged, so events are matched to our send by `data.broadcast_id`.
// Open and click tracking are switched on per sending domain in the Resend dashboard (off by default, needs a tracking subdomain).
// Not given by Resend as far as the docs go: machine-open flag, device, client, country, unsubscribe events (those are contact events).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailEventSource, EmailProvider, EmailSender, SendStatus } from "../domain/ports.ts";
import type { CampaignDraft, Capabilities, Detail, EmailEvent, EventType, Recipient } from "../domain/types.ts";

const API = "https://api.resend.com";
const TOLERANCE_SECONDS = 5 * 60; // Svix's usual window; the Resend page does not state one

export type ResendConfig = {
  apiKey: string;
  /** whsec_... from the webhook's page in the Resend dashboard. */
  webhookSecret?: string;
  /** Hashes an address into what we store (salted, injected so this file never sees the salt). */
  recipient: (address: string) => Recipient;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export const resendCapabilities: Capabilities = {
  emits: ["sent", "delivered", "deferred", "bounced", "complained", "opened", "clicked", "failed", "suppressed"],
  details: ["link", "bounceClass", "bounceReason", "failReason"],
  features: ["drafts", "scheduling", "cancel", "segments"],
};

const EVENT_TYPE: Record<string, EventType> = {
  "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "deferred", "email.bounced": "bounced",
  "email.complained": "complained", "email.opened": "opened", "email.clicked": "clicked", "email.failed": "failed", "email.suppressed": "suppressed",
};
const BOUNCE_CLASS: Record<string, Detail["bounceClass"]> = { permanent: "hard", temporary: "soft", transient: "soft", undetermined: "unknown" };

export function resendProvider(cfg: ResendConfig): EmailProvider {
  const http = cfg.fetchImpl ?? fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await http(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", "user-agent": "brandwise" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${method} ${path}: ${json.message ?? json.name ?? res.status}`);
    return json;
  };

  const sender: EmailSender = {
    unsubscribeTag: "{{{RESEND_UNSUBSCRIBE_URL}}}",
    async createCampaign(d: CampaignDraft) {
      const segmentId = d.target.segmentId;
      if (!segmentId) throw new Error("The campaign's email target has no segmentId");
      // a draft: no `send`, so nothing leaves until `send()`
      const r = await call("POST", "/broadcasts", { segment_id: segmentId, from: d.from, subject: d.subject, html: d.html, name: d.name, ...(d.text ? { text: d.text } : {}), ...(d.replyTo ? { reply_to: d.replyTo } : {}) });
      return { externalId: String(r.id) };
    },
    async send(externalId, opts) {
      await call("POST", `/broadcasts/${externalId}/send`, opts?.at ? { scheduled_at: opts.at.toISOString() } : {});
    },
    async status(externalId): Promise<SendStatus> {
      const s = (await call("GET", `/broadcasts/${externalId}`)).status;
      return s === "draft" ? "draft" : s === "scheduled" ? "scheduled" : s === "sent" || s === "queued" ? "sent" : s === "canceled" ? "canceled" : "unknown";
    },
    async cancel(externalId) {
      await call("POST", `/broadcasts/${externalId}/cancel`, {});
    },
  };

  const parsePayload = (body: string, eventId: string): EmailEvent[] => {
    const p = JSON.parse(body);
    const type = EVENT_TYPE[p?.type];
    const d = p?.data;
    if (!type || !d?.broadcast_id) return []; // other event kinds, and mail that is not one of our broadcasts, are not ours
    const addresses: string[] = Array.isArray(d.to) ? d.to : [];
    const detail: Detail = {};
    if (type === "clicked" && d.click?.link) detail.link = String(d.click.link);
    if (type === "bounced") {
      detail.bounceClass = BOUNCE_CLASS[String(d.bounce?.type ?? "").toLowerCase()] ?? "unknown";
      if (d.bounce?.message) detail.bounceReason = String(d.bounce.message);
    }
    if (type === "failed" && d.failed?.reason) detail.failReason = String(d.failed.reason);
    // personal data stays out of what we keep: addresses and IPs
    const raw = { ...p, data: { ...d, to: addresses.map(() => "[redacted]"), ...(d.click ? { click: { ...d.click, ipAddress: undefined } } : {}) } };
    return addresses.map((address, i) => ({
      provider: "resend",
      providerEventId: addresses.length > 1 ? `${eventId}:${i}` : eventId,
      type,
      at: new Date(type === "clicked" && d.click?.timestamp ? d.click.timestamp : p.created_at).toISOString(),
      ref: { externalId: String(d.broadcast_id) },
      recipient: cfg.recipient(address),
      detail,
      raw,
      schemaVersion: 1,
    }));
  };

  const events: EmailEventSource = {
    parsePayload,
    parseWebhook({ headers, body }) {
      const get = (name: string) => headers[name] ?? headers[name.toLowerCase()];
      const id = get("svix-id"), timestamp = get("svix-timestamp"), signature = get("svix-signature");
      if (!cfg.webhookSecret) throw new Error("Resend webhook secret is not configured");
      if (!id || !timestamp || !signature) throw new Error("Missing Svix signature headers");
      if (Math.abs((cfg.now?.() ?? Date.now()) / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) throw new Error("Webhook timestamp is outside the tolerance");
      const key = Buffer.from(cfg.webhookSecret.replace(/^whsec_/, ""), "base64");
      const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
      const ok = signature.split(" ").some((part) => {
        const given = Buffer.from(part.replace(/^v1,/, ""), "base64");
        return part.startsWith("v1,") && given.length === expected.length && timingSafeEqual(given, expected);
      });
      if (!ok) throw new Error("Invalid webhook signature");
      return parsePayload(body, id);
    },
  };

  return { id: "resend", capabilities: resendCapabilities, sender, events };
}
