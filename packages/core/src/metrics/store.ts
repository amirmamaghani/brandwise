// Postgres storage of pulled metrics: snapshots of running totals per source, entry and metric.
import type pg from "pg";
import { isMetricName, type Snapshot } from "./domain.ts";

export function metricsStore(pool: pg.Pool) {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  return {
    /** Store what a source reported at `at`. Idempotent: the same source, entry, metric and moment are stored once. Returns rows written. */
    async write(source: string, snaps: Snapshot[], at: Date): Promise<number> {
      let n = 0;
      for (const s of snaps) {
        for (const [metric, value] of Object.entries(s.values)) {
          if (!isMetricName(metric) || !Number.isFinite(value)) continue;
          n += (await pool.query(
            `insert into entry_metric (source, entry_id, metric, value, observed_at, started_at) values ($1,$2,$3,$4,$5,$6)
             on conflict do nothing`, [source, s.entryId, metric, value, at.toISOString(), s.startedAt ?? null])).rowCount ?? 0;
        }
      }
      return n;
    },
    /** The latest snapshot of each metric at or before `asOf`, per source and entry. */
    async latest(entryIds: string[], asOf: Date): Promise<{ source: string; snap: Snapshot }[]> {
      if (entryIds.length === 0) return [];
      const rows = await q(
        `select distinct on (source, entry_id, metric) source, entry_id, metric, value, started_at from entry_metric
         where entry_id = any($1::text[]) and observed_at <= $2 order by source, entry_id, metric, observed_at desc`, [entryIds, asOf.toISOString()]);
      const by = new Map<string, { source: string; snap: Snapshot }>();
      for (const r of rows as any[]) {
        const key = `${r.source}\u0000${r.entry_id}`;
        const cur: { source: string; snap: Snapshot } = by.get(key) ?? { source: r.source, snap: { entryId: r.entry_id, values: {} } };
        cur.snap.values[r.metric as keyof Snapshot["values"]] = Number(r.value);
        const started = r.started_at ? new Date(r.started_at).toISOString() : null;
        if (started && (!cur.snap.startedAt || started < cur.snap.startedAt)) cur.snap.startedAt = started;
        by.set(key, cur);
      }
      return [...by.values()];
    },
  };
}
