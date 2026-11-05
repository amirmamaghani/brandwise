// The metrics service: one way to read the numbers of any calendar entry, whatever measured it. Live sources (e-mail) are asked for
// the moment wanted; pull sources are read from the snapshots `pull` stored. The regulator, the CLI and later the pages read from here,
// never from a channel's own tables.
import type { CalendarEntry, Core } from "../index.ts";
import { measuresChannel, merge, PartialPullError, type EntryMetrics, type EntryRef, type MetricsSource, type Snapshot } from "./domain.ts";
import { metricsStore } from "./store.ts";

export * from "./domain.ts";

const refOf = (e: CalendarEntry): EntryRef => ({ id: e.id, campaignId: e.campaignId, channel: e.channel, externalId: e.externalId, externalUrl: e.externalUrl });

export function createMetrics(deps: { core: Core; sources: MetricsSource[] }) {
  const { core } = deps;
  const store = metricsStore(core.pool);
  const ids = new Set<string>();
  for (const s of deps.sources) {
    if (ids.has(s.id)) throw new Error(`Two metrics sources with the id "${s.id}"`);
    if (!s.at && !s.pull) throw new Error(`Metrics source "${s.id}" has neither at() nor pull()`);
    ids.add(s.id);
  }
  const sourcesFor = (channel: string) => deps.sources.filter((s) => measuresChannel(s, channel));

  /** When each entry was published, from its history: the start of entries whose source cannot tell. */
  async function publishedAt(entryIds: string[]): Promise<Map<string, string>> {
    if (entryIds.length === 0) return new Map();
    const rows = (await core.pool.query("select entry_id, min(at) as at from entry_event where kind = 'published' and entry_id = any($1::text[]) group by entry_id", [entryIds])).rows;
    return new Map(rows.map((r: any) => [r.entry_id, new Date(r.at).toISOString()]));
  }

  /** The numbers of these entries as of `asOf`, in the entries' order. An entry no source measures has empty values. */
  async function forEntries(entries: CalendarEntry[], asOf: Date): Promise<EntryMetrics[]> {
    const live = new Map<string, { source: string; snap: Snapshot }[]>();
    const add = (source: string, snap: Snapshot) => live.set(snap.entryId, [...(live.get(snap.entryId) ?? []), { source, snap }]);
    const order = new Map(deps.sources.map((s, i) => [s.id, i]));
    for (const s of deps.sources) {
      if (!s.at) continue;
      const mine = entries.filter((e) => measuresChannel(s, e.channel));
      if (mine.length) for (const snap of await s.at(mine.map(refOf), asOf)) add(s.id, snap);
    }
    for (const r of await store.latest(entries.map((e) => e.id), asOf)) add(r.source, r.snap);
    const started = await publishedAt(entries.map((e) => e.id));
    return entries.map((e) => {
      const snaps = (live.get(e.id) ?? []).sort((a, b) => (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99));
      return merge(e.id, e.channel, snaps, started.get(e.id) ?? null);
    });
  }

  /** Entries of a campaign (itself and, for an always-on base, every campaign under it) that reached an audience. */
  async function published(campaignId: string): Promise<CalendarEntry[]> {
    const campaigns = (await core.campaigns.list()).filter((c) => c.id === campaignId || c.rootId === campaignId);
    const under = new Set(campaigns.map((c) => c.id));
    return (await core.calendar.list()).filter((e) => under.has(e.campaignId) && e.status === "published");
  }

  return {
    sources: () => deps.sources.map((s) => ({ id: s.id, channels: [...s.channels], measures: [...s.measures], mode: s.at ? "live" as const : "pull" as const })),
    sourcesFor,
    forEntries,
    published,
    async entry(id: string, asOf: Date): Promise<EntryMetrics> {
      const e = await core.calendar.get(id);
      if (!e) throw new Error(`No calendar entry with id ${id}`);
      return (await forEntries([e], asOf))[0];
    },
    async campaign(campaignId: string, asOf: Date): Promise<EntryMetrics[]> {
      return forEntries(await published(campaignId), asOf);
    },
    /**
     * Ask every pull source (or one) for the current totals of the published entries of its channels and store them. Safe to repeat;
     * entries published more than `days` ago are no longer asked (their numbers have settled). One failing source does not stop the others,
     * and a source that failed for only some of its targets (PartialPullError) keeps the numbers it got.
     */
    async pull(now: Date, opts: { source?: string; days?: number } = {}): Promise<{ source: string; entries: number; stored: number; error?: string; partial?: boolean }[]> {
      const pullers = deps.sources.filter((s) => s.pull && (!opts.source || s.id === opts.source));
      if (opts.source && pullers.length === 0) throw new Error(`No pull source "${opts.source}" (pull sources: ${deps.sources.filter((s) => s.pull).map((s) => s.id).join(", ") || "none"})`);
      const since = now.getTime() - (opts.days ?? 30) * 86_400_000;
      const all = (await core.calendar.list()).filter((e) => e.status === "published");
      const started = await publishedAt(all.map((e) => e.id));
      const out = [];
      for (const s of pullers) {
        const mine = all.filter((e) => measuresChannel(s, e.channel) && Date.parse(started.get(e.id) ?? e.scheduledAt) >= since);
        const known = new Set(mine.map((e) => e.id));
        const keep = (snaps: Snapshot[]) => store.write(s.id, snaps.filter((x) => known.has(x.entryId)), now);
        try {
          const snaps = mine.length ? await s.pull!(mine.map(refOf), now) : [];
          out.push({ source: s.id, entries: mine.length, stored: await keep(snaps) });
        } catch (err) {
          if (err instanceof PartialPullError) out.push({ source: s.id, entries: mine.length, stored: await keep(err.snapshots), error: err.message, partial: true });
          else out.push({ source: s.id, entries: mine.length, stored: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    },
  };
}
export type Metrics = ReturnType<typeof createMetrics>;
