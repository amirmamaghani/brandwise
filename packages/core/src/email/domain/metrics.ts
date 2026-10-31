// The metric catalog: ONE definition per metric, shared by every provider. A metric says which events it needs; whether it can be
// shown for a send is derived from what the provider that sent it declares (Capabilities), never from provider-specific code.
import type { Capabilities, Counts, DetailKey, EventType } from "./types.ts";

export type MetricDef = {
  id: string;
  label: string;
  unit: "count" | "ratio";
  /** reliable = safe to decide on; indicative = skewed by mail clients (opens: pixels are blocked or pre-fetched by privacy proxies). */
  reliability: "reliable" | "indicative";
  requires: { events: EventType[]; details?: DetailKey[] };
  compute(c: Counts): number | null;
};

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const bounced = (c: Counts) => c.bounced.hard + c.bounced.soft + c.bounced.unknown;

export const METRICS: MetricDef[] = [
  { id: "sent", label: "Sent", unit: "count", reliability: "reliable", requires: { events: ["sent"] }, compute: (c) => c.sent },
  { id: "delivered", label: "Delivered", unit: "count", reliability: "reliable", requires: { events: ["delivered"] }, compute: (c) => c.delivered },
  { id: "delivery_rate", label: "Delivery rate (delivered / sent)", unit: "ratio", reliability: "reliable", requires: { events: ["sent", "delivered"] }, compute: (c) => ratio(c.delivered, c.sent) },
  { id: "bounce_rate", label: "Bounce rate (bounced / sent)", unit: "ratio", reliability: "reliable", requires: { events: ["sent", "bounced"] }, compute: (c) => ratio(bounced(c), c.sent) },
  { id: "hard_bounce_rate", label: "Hard bounce rate (hard bounced / sent)", unit: "ratio", reliability: "reliable", requires: { events: ["sent", "bounced"], details: ["bounceClass"] }, compute: (c) => ratio(c.bounced.hard, c.sent) },
  { id: "complaint_rate", label: "Spam complaint rate (complaints / delivered)", unit: "ratio", reliability: "reliable", requires: { events: ["delivered", "complained"] }, compute: (c) => ratio(c.complained, c.delivered) },
  { id: "unsubscribe_rate", label: "Unsubscribe rate (unsubscribed / delivered)", unit: "ratio", reliability: "reliable", requires: { events: ["delivered", "unsubscribed"] }, compute: (c) => ratio(c.unsubscribed, c.delivered) },
  { id: "unique_opens", label: "Unique opens", unit: "count", reliability: "indicative", requires: { events: ["opened"] }, compute: (c) => c.opened.unique },
  { id: "open_rate", label: "Open rate (unique opens / delivered)", unit: "ratio", reliability: "indicative", requires: { events: ["delivered", "opened"] }, compute: (c) => ratio(c.opened.unique, c.delivered) },
  { id: "human_open_rate", label: "Open rate without machine opens", unit: "ratio", reliability: "indicative", requires: { events: ["delivered", "opened"], details: ["machine"] }, compute: (c) => ratio(c.opened.humanUnique, c.delivered) },
  { id: "unique_clicks", label: "Unique clicks", unit: "count", reliability: "reliable", requires: { events: ["clicked"] }, compute: (c) => c.clicked.unique },
  { id: "total_clicks", label: "Total clicks", unit: "count", reliability: "reliable", requires: { events: ["clicked"] }, compute: (c) => c.clicked.total },
  { id: "click_rate", label: "Click rate (unique clicks / delivered)", unit: "ratio", reliability: "reliable", requires: { events: ["delivered", "clicked"] }, compute: (c) => ratio(c.clicked.unique, c.delivered) },
  { id: "click_to_open_rate", label: "Click-to-open rate (unique clicks / unique opens)", unit: "ratio", reliability: "indicative", requires: { events: ["opened", "clicked"] }, compute: (c) => ratio(c.clicked.unique, c.opened.unique) },
];

/** A metric can be shown when the provider emits every event and detail it needs. */
export const isAvailable = (m: MetricDef, caps: Capabilities) =>
  m.requires.events.every((e) => caps.emits.includes(e)) && (m.requires.details ?? []).every((d) => caps.details.includes(d));

/** What several sends can all do: a report over sends from different providers only shows what every one of them supports. */
export const commonCapabilities = (all: Capabilities[]): Capabilities => ({
  emits: all.length === 0 ? [] : all[0].emits.filter((e) => all.every((c) => c.emits.includes(e))),
  details: all.length === 0 ? [] : all[0].details.filter((d) => all.every((c) => c.details.includes(d))),
  features: all.length === 0 ? [] : all[0].features.filter((f) => all.every((c) => c.features.includes(f))),
});

export type MetricResult = { id: string; label: string; unit: MetricDef["unit"]; reliability: MetricDef["reliability"]; available: boolean; value: number | null };

/** value is null when unavailable (provider cannot tell) or when the denominator is zero: never a made-up 0. */
export function computeMetrics(counts: Counts, caps: Capabilities): MetricResult[] {
  return METRICS.map((m) => {
    const available = isAvailable(m, caps);
    return { id: m.id, label: m.label, unit: m.unit, reliability: m.reliability, available, value: available ? m.compute(counts) : null };
  });
}
