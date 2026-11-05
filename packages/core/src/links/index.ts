// Own short links: issue them when a post is published, resolve them in the redirect route, count clicks as a metrics source.
// E-mail keeps its links as they are: the provider counts clicks there, and redirects through an unknown domain hurt delivery.
import type pg from "pg";
import type { MetricsSource, Snapshot } from "../metrics/domain.ts";
import { codeOf, isBot, MAX_VISITORS_PER_SOURCE, newLinkId, sourceOf, verifyCode, visitorOf } from "./domain.ts";

export { clientAddress, isBot, replaceUrls } from "./domain.ts";

export function createLinks(deps: {
  pool: pg.Pool;
  /** Signs codes and salts visitor hashes; derived from the plugin's secret key. */
  key: string;
  /** The public address of the redirect route (`.../http/l`); null: links are not shortened. */
  baseUrl: () => string | null;
  /** Channels whose connectors shorten their links: the channels this source measures. */
  channels: readonly string[];
}) {
  const q = async (sql: string, params: unknown[] = []) => (await deps.pool.query(sql, params)).rows;
  const links = {
    enabled: () => Boolean(deps.baseUrl()),
    /** The short link of `url` in an entry; the same link again gets the same code. Without a public address, `url` itself. */
    async shorten(entryId: string, url: string): Promise<string> {
      const base = deps.baseUrl();
      if (!base) return url;
      const id = (await q(
        `insert into short_link (id, entry_id, url) values ($1,$2,$3) on conflict (entry_id, url) do update set url = excluded.url returning id`,
        [newLinkId(), entryId, url]))[0].id as string;
      return `${base}${base.includes("?") ? "&" : "?"}c=${codeOf(deps.key, id)}`;
    },
    /** Where a code leads, recording the request (a preview or crawler as a bot); null for a code we did not issue. */
    async resolve(code: string, req: { method: string; userAgent: string | null; ip: string | null }): Promise<string | null> {
      const id = verifyCode(deps.key, code);
      if (!id) return null;
      const row = (await q("select url from short_link where id = $1", [id]))[0];
      if (!row) return null;
      // the visitor goes on even when the click cannot be recorded (a database in recovery): a lost count beats a broken link
      await q("insert into link_click (link_id, visitor, source, bot) values ($1,$2,$3,$4)", [id, visitorOf(deps.key, req.ip, req.userAgent), sourceOf(deps.key, req.ip), isBot(req.method, req.userAgent)])
        .catch((err) => { console.error(`short link ${id}: click not recorded: ${err instanceof Error ? err.message : String(err)}`); });
      return row.url as string;
    },
    /** Per link of an entry: where it leads, people (unique visitors) and bot requests. */
    async stats(entryId: string): Promise<{ url: string; clicks: number; visitors: number; bots: number }[]> {
      return (await q(
        `select l.url, count(c.id) filter (where not c.bot) as clicks, count(distinct c.visitor) filter (where not c.bot) as visitors,
                count(c.id) filter (where c.bot) as bots
         from short_link l left join link_click c on c.link_id = l.id where l.entry_id = $1 group by l.id, l.url order by l.created_at`, [entryId]))
        .map((r: any) => ({ url: r.url, clicks: Number(r.clicks), visitors: Number(r.visitors), bots: Number(r.bots) }));
    },
    /**
     * Clicks as a live metrics source: unique human visitors over all links of an entry, up to the moment asked, with at most
     * MAX_VISITORS_PER_SOURCE counted per address (so one machine rotating its browser string cannot inflate a test).
     */
    metricsSource(): MetricsSource {
      return {
        id: "links",
        channels: deps.channels,
        measures: ["clicks"],
        async at(entries, asOf) {
          if (entries.length === 0) return [];
          const rows = await q(
            `select l.entry_id, coalesce(sum(least(coalesce(v.n, 0), $3)), 0) as visitors
             from (select distinct entry_id from short_link where entry_id = any($1::text[])) l
             left join (select s.entry_id, c.source, count(distinct c.visitor) as n
                        from short_link s join link_click c on c.link_id = s.id
                        where s.entry_id = any($1::text[]) and not c.bot and c.at <= $2 group by s.entry_id, c.source) v on v.entry_id = l.entry_id
             group by l.entry_id`,
            [entries.map((e) => e.id), asOf.toISOString(), MAX_VISITORS_PER_SOURCE]);
          // an entry with short links and no click has 0 clicks (LEAST skips nulls, hence the coalesce); one without short links is unknown
          return rows.map((r: any): Snapshot => ({ entryId: r.entry_id, values: { clicks: Number(r.visitors) } }));
        },
      };
    },
  };
  return links;
}
export type Links = ReturnType<typeof createLinks>;
