// Metrics of calendar entries, whatever the channel. Pure: no database, no provider. A source (e-mail, a link redirect, web analytics, an
// ad or social platform) reports numbers for the entries of the channels it measures, in one fixed vocabulary, so experiments, guards
// and summaries are written once for every channel (docs/analytics.md, step 2).

/**
 * The vocabulary. Every metric is a count; rates are computed from counts (clicks / exposures), never stored.
 * `exposures` is the denominator of every rate: delivered e-mails, post views, ad impressions. `visits` are sessions on the
 * client's site that arrived from the entry's links; `leads` are the site's key events (sign-ups, forms) in those sessions.
 * `reach` is the number of people who saw it (exposures / reach = frequency); `spend` is in the ad account's currency.
 */
export const METRIC_NAMES = ["sends", "exposures", "reach", "clicks", "visits", "complaints", "unsubscribes", "bounces", "reactions", "comments", "shares", "saves", "video_views", "leads", "orders", "revenue", "spend"] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export const isMetricName = (s: string): s is MetricName => (METRIC_NAMES as readonly string[]).includes(s);

/** What a source knows about one entry at one moment. A metric missing from `values` is unknown: unavailable, never a zero. */
export type Snapshot = {
  entryId: string;
  /**
   * When the entry reached its audience (sent, posted). null: the source knows it has not yet (as of the moment asked);
   * undefined: the source cannot tell, and the entry's publish time is used.
   */
  startedAt?: string | null;
  values: Partial<Record<MetricName, number>>;
};

/** The entry as a source sees it: its channel and what the connector got back when it published. */
export type EntryRef = { id: string; campaignId: string; channel: string; externalId: string | null; externalUrl: string | null };

export interface MetricsSource {
  id: string;
  /** Calendar channels this source measures (`email`, `telegram`, ...); `*` for every channel (web analytics sees visits from any). */
  channels: readonly string[];
  /** Metrics it can report at all; per entry it may report fewer (a provider that cannot see unsubscribes). */
  measures: readonly MetricName[];
  /** Sources that keep their own event history answer for any moment (e-mail: events up to `asOf`). */
  at?(entries: EntryRef[], asOf: Date): Promise<Snapshot[]>;
  /** Sources that only report current totals (platform APIs): the caller stores the answer as points, so history builds up. */
  pull?(entries: EntryRef[], now: Date): Promise<Snapshot[]>;
}

export const measuresChannel = (s: Pick<MetricsSource, "channels">, channel: string) => s.channels.includes("*") || s.channels.includes(channel);

/** An entry's numbers merged over every source that measures its channel; `sources` says where each number came from. */
export type EntryMetrics = { entryId: string; channel: string; startedAt: string | null; values: Partial<Record<MetricName, number>>; sources: Partial<Record<MetricName, string>> };

/**
 * Merge snapshots of one entry from several sources. One number per metric: the first source in `order` that reports it wins
 * (sources are not added up, they would count the same clicks twice). The earliest known start wins; when no source can tell,
 * `fallbackStart` (the publish time) is used.
 */
export function merge(entryId: string, channel: string, snaps: { source: string; snap: Snapshot }[], fallbackStart: string | null = null): EntryMetrics {
  const out: EntryMetrics = { entryId, channel, startedAt: null, values: {}, sources: {} };
  let told = false;
  for (const { source, snap } of snaps) {
    for (const [k, v] of Object.entries(snap.values) as [MetricName, number][]) {
      if (out.values[k] === undefined && Number.isFinite(v)) { out.values[k] = v; out.sources[k] = source; }
    }
    if (snap.startedAt !== undefined) told = true;
    if (snap.startedAt && (out.startedAt === null || snap.startedAt < out.startedAt)) out.startedAt = snap.startedAt;
  }
  if (!told) out.startedAt = fallbackStart;
  return out;
}

/** k / n, null when either is unknown or n is 0: a rate is never made up. */
export const rate = (m: EntryMetrics, k: MetricName, n: MetricName = "exposures"): number | null => {
  const a = m.values[k], b = m.values[n];
  return a === undefined || b === undefined || b <= 0 ? null : a / b;
};
