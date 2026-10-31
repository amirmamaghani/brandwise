// Publishing: connectors and the run that hands due calendar entries to them (`bb brandwise calendar run-due`, fired every
// minute by a bb automation). A connector is the only code that talks to a platform; to add a network, add a connector to
// `connectorsFrom`. Later capabilities (metrics, comments) become optional methods on the same type.
import type { CalendarEntry, Core } from "./index.ts";
import { mock } from "./connector-mock.ts";
import { telegram } from "./connector-telegram.ts";

export type PublishInput = {
  /** Stable per entry: the platform (or the connector) drops a second publish with the same key. */
  idempotencyKey: string;
  entry: CalendarEntry;
  /** The campaign's settings for this channel (e.g. the Telegram chat), inherited from its parent; null if none set. */
  target: Record<string, string> | null;
  /** The entry's creative, or null. Connectors upload the bytes or pass a signed URL, whichever the platform accepts (local storage is not reachable from the internet). */
  asset: { kind: string; mime: string; name: string; bytes: number; read(): Promise<Uint8Array>; url(): Promise<string> } | null;
};
export type Connector = {
  id: string;
  /** The `channel` values of calendar entries this connector publishes. */
  channels: string[];
  /** Set when the connector cannot post without a per-campaign target: the entry waits as `needs_manual` and this says how to set it. */
  targetHint?: string;
  publish(input: PublishInput): Promise<{ externalId: string; url?: string }>;
};

/** Connectors that are configured. A connector without credentials is left out, so its channel ends up as `needs_manual`. */
export type ConnectorConfig = { telegramBotToken?: string };
export const connectorsFrom = (cfg: ConnectorConfig = {}): Connector[] => [
  mock,
  ...(cfg.telegramBotToken ? [telegram({ token: cfg.telegramBotToken })] : []),
];

export type Outcome = { id: string; title: string; channel: string; result: "published" | "retry" | "failed" | "needs_manual"; detail: string };

/** Claim due entries and publish each through its connector. Returns what happened; nothing due returns an empty list. */
export async function runDue(core: Core, connectors: Connector[] = connectorsFrom(), limit = 10): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const entry of await core.publishing.claimDue(limit)) {
    const base = { id: entry.id, title: entry.title, channel: entry.channel };
    const connector = connectors.find((c) => c.channels.includes(entry.channel));
    if (!connector) {
      await core.publishing.markManual(entry.id, `No connector for channel "${entry.channel}": publish it by hand`);
      out.push({ ...base, result: "needs_manual", detail: `no connector for "${entry.channel}"` });
      continue;
    }
    const target = await core.channels.get(entry.campaignId, entry.channel);
    if (connector.targetHint && !target) {
      await core.publishing.markManual(entry.id, `Campaign "${entry.campaignName}" has no ${entry.channel} target: ${connector.targetHint}`);
      out.push({ ...base, result: "needs_manual", detail: "no target for this campaign" });
      continue;
    }
    try {
      const a = entry.assetId ? await core.assets.get(entry.assetId) : null;
      const asset = a && { kind: a.kind, mime: a.mime, name: a.name, bytes: a.bytes, read: () => core.assets.read(a.id), url: () => core.assets.url(a.id, 3600) };
      const r = await connector.publish({ idempotencyKey: `bw-${entry.id}`, entry, target, asset });
      await core.publishing.markPublished(entry.id, r);
      out.push({ ...base, result: "published", detail: `${connector.id}: ${r.externalId}` });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const next = await core.publishing.markFailed(entry.id, message);
      out.push({ ...base, result: next === "failed" ? "failed" : "retry", detail: message });
    }
  }
  return out;
}
