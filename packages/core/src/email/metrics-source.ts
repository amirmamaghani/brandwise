// E-mail as a metrics source: answers from our own event history for any moment, so the rails judge exactly what had arrived by then.
// A number the providers that sent the entry cannot emit is left out (unavailable), never reported as 0: Resend, for example, reports
// unsubscribes as contact events, so its unsubscribe count is unknown, not zero (docs/analytics.md, D1).
import type { MetricName, MetricsSource, Snapshot } from "../metrics/domain.ts";
import { eventsToCounts } from "./domain/counts.ts";
import { commonCapabilities } from "./domain/metrics.ts";
import type { EmailStore } from "./domain/ports.ts";
import type { Counts, EventType } from "./domain/types.ts";

const MAP: [MetricName, EventType, (c: Counts) => number][] = [
  ["sends", "sent", (c) => c.sent],
  ["exposures", "delivered", (c) => c.delivered],
  ["clicks", "clicked", (c) => c.clicked.unique],
  ["complaints", "complained", (c) => c.complained],
  ["unsubscribes", "unsubscribed", (c) => c.unsubscribed],
  ["bounces", "bounced", (c) => c.bounced.hard + c.bounced.soft + c.bounced.unknown],
];

export function emailMetricsSource(store: EmailStore): MetricsSource {
  return {
    id: "email",
    channels: ["email"],
    measures: MAP.map(([m]) => m),
    async at(entries, asOf) {
      const out: Snapshot[] = [];
      for (const e of entries) {
        const sends = await store.sends({ entryId: e.id });
        if (sends.length === 0) continue;
        const caps = commonCapabilities(sends.map((s) => s.capabilities));
        const counts = eventsToCounts(await store.eventsFor(sends.map((s) => s.id), { asOf: asOf.toISOString() }));
        const values: Snapshot["values"] = {};
        for (const [metric, event, read] of MAP) if (caps.emits.includes(event)) values[metric] = read(counts);
        const sent = sends.map((s) => s.sentAt).filter((t): t is string => t !== null && Date.parse(t) <= asOf.getTime()).sort();
        out.push({ entryId: e.id, startedAt: sent[0] ?? null, values });
      }
      return out;
    },
  };
}
