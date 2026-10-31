// Simulated e-mail provider (development and tests): "sends" to a synthetic audience and answers with the events a real provider
// would, spread over simulated time (opens within hours, clicks minutes after). Time comes from the development clock, so a day of
// delay costs one `sim advance` and the loop's maturity and hysteresis rules can be tested end to end. See sim-model.ts.
import type { EmailProvider } from "../domain/ports.ts";
import type { Capabilities, EmailEvent, EventType, Recipient } from "../domain/types.ts";
import { expectedRates, expo, uniform } from "./sim-model.ts";

export const simCapabilities: Capabilities = {
  emits: ["sent", "delivered", "bounced", "complained", "opened", "clicked", "unsubscribed"],
  details: ["link", "bounceClass", "machine"],
  features: ["drafts", "segments"],
};

const MIN = 60_000, HOUR = 3_600_000;

export function simProvider(cfg: { recipient: (address: string) => Recipient; now: () => Promise<Date> }): EmailProvider {
  const drafts = new Map<string, { subject: string; html: string; target: Record<string, string> }>();
  let sink: ((events: EmailEvent[]) => Promise<unknown>) | null = null;
  let n = 0;

  /** Every event of one send. Pure given (externalId, draft, t0). */
  const world = (externalId: string, d: { subject: string; html: string; target: Record<string, string> }, t0: number): EmailEvent[] => {
    const size = Math.max(1, Number(d.target.audienceSize ?? 400));
    const seed = d.target.seed ?? "sim";
    const p = expectedRates(d.subject, d.html);
    const link = /https?:\/\/[^\s"'<>]+/.exec(d.html)?.[0];
    const events: EmailEvent[] = [];
    for (let i = 0; i < size; i++) {
      // draws depend on the audience seed and the content, not on the send's id: the same campaign setup always reacts the same way
      const u = (stream: string) => uniform(seed, d.subject, i, stream);
      const recipient = cfg.recipient(`sim-${externalId}-${i}@sim.invalid`);
      const emit = (type: EventType, at: number, detail: EmailEvent["detail"] = {}, k = 0) =>
        events.push({ provider: "sim", providerEventId: `${externalId}:${i}:${type}:${k}`, type, at: new Date(at).toISOString(), ref: { externalId }, recipient, detail, raw: { type, sim: true }, schemaVersion: 1 });
      const sentAt = t0 + u("sent") * MIN;
      emit("sent", sentAt);
      if (u("delivered") >= p.delivered) { emit("bounced", sentAt + 2 * MIN, { bounceClass: "hard" }); continue; }
      const deliveredAt = sentAt + (1 + 4 * u("delay")) * MIN;
      emit("delivered", deliveredAt);
      if (u("machine") < p.machineOpen) emit("opened", deliveredAt + MIN, { machine: true }, 1);   // a privacy proxy prefetched it
      const opened = u("open") < p.open;
      const openedAt = deliveredAt + expo(u("opendelay"), 3 * HOUR, 96 * HOUR);
      if (opened) {
        emit("opened", openedAt, { machine: false }, 0);
        if (u("click") < p.clickGivenOpen) emit("clicked", openedAt + (1 + 19 * u("clickdelay")) * MIN, link ? { link } : {});
        if (u("unsub") < p.unsubscribe / p.open) emit("unsubscribed", openedAt + 2 * MIN);
      }
      if (u("complaint") < p.complaint) emit("complained", deliveredAt + expo(u("complaintdelay"), 6 * HOUR, 72 * HOUR));
    }
    return events;
  };

  return {
    id: "sim",
    capabilities: simCapabilities,
    dialect: { unsubscribe: "{{unsubscribe}}", token: (field: string, fallback?: string) => `{{${field}${fallback ? `|${fallback}` : ""}}}`, hostedImagesRequired: false },
    attachSink(s) { sink = s; },
    sender: {
      unsubscribeTag: "{{unsubscribe}}",
      async createCampaign(draft) {
        const externalId = `sim-${Date.now().toString(36)}-${++n}`;
        drafts.set(externalId, { subject: draft.subject, html: draft.html, target: draft.target });
        return { externalId };
      },
      async send(externalId) {
        const d = drafts.get(externalId);
        if (!d) throw new Error(`Unknown simulated campaign ${externalId} (drafts live in memory: a restart between create and send loses them)`);
        if (!sink) throw new Error("The simulated provider has no event sink attached");
        await sink(world(externalId, d, (await cfg.now()).getTime()));
        drafts.delete(externalId);
      },
      async status(externalId) { return drafts.has(externalId) ? "draft" : "sent"; },
    },
  };
}
