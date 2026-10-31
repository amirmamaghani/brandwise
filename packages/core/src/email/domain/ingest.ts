// The one place events enter the system, whether a webhook or a poll delivered them. Adapters only parse; this stores.
import type { EmailStore } from "./ports.ts";
import type { EmailEvent } from "./types.ts";

export type IngestResult = { received: number; stored: number; duplicates: number; unlinked: number };

export async function ingest(events: EmailEvent[], store: EmailStore): Promise<IngestResult> {
  const rows: { event: EmailEvent; sendId: string | null }[] = [];
  for (const event of events) rows.push({ event, sendId: await store.resolveSend(event.provider, event.ref) });
  const stored = rows.length === 0 ? 0 : await store.insertEvents(rows);
  return { received: events.length, stored, duplicates: events.length - stored, unlinked: rows.filter((r) => r.sendId === null).length };
}
