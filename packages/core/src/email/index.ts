// E-mail module entry: wires domain, store, providers and the calendar connector. The plugin calls only this.
import type pg from "pg";
import { createHash } from "node:crypto";
import type { Connector } from "../publish.ts";
import { providersFrom, type ProviderConfig } from "./adapters/index.ts";
import { eventsToCounts } from "./domain/counts.ts";
import { ingest } from "./domain/ingest.ts";
import { commonCapabilities, computeMetrics } from "./domain/metrics.ts";
import type { EmailProvider } from "./domain/ports.ts";
import type { Recipient } from "./domain/types.ts";
import { simProvider } from "./adapters/sim.ts";
import { emailConnector } from "./connector.ts";
import { pgEmailStore } from "./store.ts";

/** Salted hash of an address: stable for one installation (so uniques work) and useless elsewhere. The salt is a secret of the plugin. */
export const recipientHasher = (salt: string) => (address: string): Recipient => {
  const a = address.trim().toLowerCase();
  return { hash: createHash("sha256").update(`${salt}:${a}`).digest("hex"), domain: a.split("@")[1] ?? "" };
};

export function createEmail(deps: { pool: pg.Pool; salt: string; providers?: Omit<ProviderConfig, "recipient">; extraProviders?: EmailProvider[]; /** Switches the simulated provider on (development): `now` is the development clock. */ sim?: { now: () => Promise<Date> } }) {
  const recipient = recipientHasher(deps.salt);
  const providers = [...providersFrom({ ...deps.providers, recipient }), ...(deps.sim ? [simProvider({ recipient, now: deps.sim.now })] : []), ...(deps.extraProviders ?? [])];
  const store = pgEmailStore(deps.pool);
  for (const p of providers) p.attachSink?.((events) => ingest(events, store));
  const provider = (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p?.events) throw new Error(`No e-mail provider "${id}" with events (configured: ${providers.map((x) => x.id).join(", ") || "none"})`);
    return p.events;
  };
  return {
    providers,
    store,
    recipient,
    /** `renderIdFor` links a send to the render snapshot of a template-based entry (from the template library). */
    connector: (renderIdFor?: (entryId: string) => Promise<string | null>): Connector => emailConnector(providers, store, renderIdFor),
    /** A webhook call: verify, parse, store. A bad signature throws and nothing is stored. */
    webhook: async (providerId: string, req: { headers: Record<string, string | undefined>; body: string }) => ingest(provider(providerId).parseWebhook(req), store),
    /** Replay a saved payload (trusted: no signature check). */
    replay: async (providerId: string, body: string, eventId: string) => ingest(provider(providerId).parsePayload(body, eventId), store),
    /** Metrics for one calendar entry or a whole campaign, over every provider that sent them. */
    async stats(filter: { entryId?: string; campaignId?: string; /** ISO: count only what had happened by then */ asOf?: string }) {
      const sends = await store.sends(filter);
      const counts = eventsToCounts(await store.eventsFor(sends.map((s) => s.id), { asOf: filter.asOf }));
      return { sends, counts, metrics: computeMetrics(counts, commonCapabilities(sends.map((s) => s.capabilities))) };
    },
  };
}
