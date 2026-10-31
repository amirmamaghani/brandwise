// Test connector: "publishes" to nowhere. A title containing "[fail]" makes it throw, to exercise retries.
import type { Connector } from "./publish.ts";

export const mock: Connector = {
  id: "mock",
  channels: ["mock"],
  async publish({ entry, idempotencyKey }) {
    if (entry.title.includes("[fail]")) throw new Error("mock connector: simulated failure");
    return { externalId: `mock-${idempotencyKey}`, url: `https://example.com/mock/${entry.id}` };
  },
};
