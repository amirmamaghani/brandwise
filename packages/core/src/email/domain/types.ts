// E-mail domain types. Pure: nothing here knows a provider, the database or the plugin.

export const EVENT_TYPES = ["sent", "delivered", "deferred", "bounced", "dropped", "suppressed", "failed", "opened", "clicked", "unsubscribed", "complained", "replied", "unknown"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Optional facts an event can carry. A provider declares which it can deliver. */
export type DetailKey = "link" | "bounceClass" | "bounceReason" | "failReason" | "machine" | "device" | "client" | "country";
export type Feature = "drafts" | "scheduling" | "cancel" | "segments" | "abTest" | "sendTest" | "subAccounts";

export type Detail = {
  bounceClass?: "hard" | "soft" | "unknown";
  bounceReason?: string;
  failReason?: string;
  link?: string;
  /** true = opened by a machine (mail privacy proxy), false = a person, undefined = the provider cannot tell. */
  machine?: boolean;
  device?: string;
  client?: string;
  country?: string;
};

export type Recipient = { hash: string; domain: string };
/** How an event finds its send: our own id when the provider echoes a tag, else the provider's campaign id. */
export type EventRef = { sendId?: string; externalId?: string };

export type EmailEvent = {
  provider: string;
  /** Unique per provider (webhooks arrive at least once): provider + this = one stored event. */
  providerEventId: string;
  type: EventType;
  /** ISO, UTC. */
  at: string;
  ref: EventRef;
  recipient: Recipient;
  detail: Detail;
  /** The provider's payload with personal data (addresses, IPs) removed. */
  raw: unknown;
  schemaVersion: 1;
};

export type CampaignDraft = {
  name: string;
  subject: string;
  html: string;
  text?: string;
  /** "Name <address@domain>" */
  from: string;
  replyTo?: string;
  /** The campaign's settings for this channel (segment, list...), as set with `campaign channel set email`. */
  target: Record<string, string>;
  /** For adapters whose provider can tag a campaign: echoed back in events. */
  tags: Record<string, string>;
};

export type Capabilities = {
  emits: EventType[];
  details: DetailKey[];
  features: Feature[];
};

/** What the formulas work on. Built from events, or taken from a provider's totals. */
export type Counts = {
  sent: number;
  delivered: number;
  deferred: number;
  dropped: number;
  suppressed: number;
  failed: number;
  bounced: { hard: number; soft: number; unknown: number };
  opened: { total: number; unique: number; humanUnique: number };
  clicked: { total: number; unique: number; perLink: Record<string, { total: number; unique: number }> };
  unsubscribed: number;
  complained: number;
};
