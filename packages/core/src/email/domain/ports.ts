// Ports: what the domain needs from the outside. Adapters implement the provider ports, the store implements the storage ports.
import type { CampaignDraft, Capabilities, Counts, Detail, EmailEvent, EventRef, EventType } from "./types.ts";

export type SendStatus = "draft" | "scheduled" | "sent" | "canceled" | "unknown";

/** Outbound: create a campaign at the provider and send it. Always a draft first; sending is a separate call. */
export interface EmailSender {
  /** The provider's merge tag for the per-recipient unsubscribe link; every e-mail we render carries it. */
  readonly unsubscribeTag: string;
  createCampaign(draft: CampaignDraft): Promise<{ externalId: string }>;
  /** Send now, or at `at` when the provider can schedule. */
  send(externalId: string, opts?: { at?: Date }): Promise<void>;
  /** Lets a retry find out whether an earlier attempt already got through. */
  status?(externalId: string): Promise<SendStatus>;
  cancel?(externalId: string): Promise<void>;
}

/** Inbound: turn what the provider sends us into our events. Pure: no database, no side effects. */
export interface EmailEventSource {
  /** Verifies the signature (throws on a bad one) and parses. */
  parseWebhook(req: { headers: Record<string, string | undefined>; body: string }): EmailEvent[];
  /** Parses an already trusted payload (a replayed file); `eventId` stands in for the delivery id the headers carry. */
  parsePayload(body: string, eventId: string): EmailEvent[];
  pull?(since: Date): AsyncIterable<EmailEvent>;
  /** For providers that only give totals per campaign. */
  pullTotals?(externalId: string): Promise<Counts>;
}

export type EmailProvider = {
  id: string;
  capabilities: Capabilities;
  sender?: EmailSender;
  events?: EmailEventSource;
};

export type SendRecord = { id: string; entryId: string; provider: string; externalId: string; capabilities: Capabilities; createdAt: string };
/** The least an event needs to be counted. */
export type CountableEvent = { sendId: string; type: EventType; recipientHash: string; detail: Detail };

/** Storage the domain needs. Postgres in production, in memory in tests. */
export interface EmailStore {
  resolveSend(provider: string, ref: EventRef): Promise<string | null>;
  /** Stores events (send id may be null: linked later); returns how many were new. */
  insertEvents(rows: { event: EmailEvent; sendId: string | null }[]): Promise<number>;
  recordSend(input: { entryId: string; provider: string; externalId: string; capabilities: Capabilities }): Promise<SendRecord>;
  sendForEntry(entryId: string): Promise<SendRecord | null>;
  sends(filter: { entryId?: string; campaignId?: string }): Promise<SendRecord[]>;
  eventsFor(sendIds: string[]): Promise<CountableEvent[]>;
}
