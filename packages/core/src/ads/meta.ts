// Meta ads (Facebook, Instagram) as a metrics source, read only (docs/analytics.md, step 5). An ad is a calendar entry on channel
// `meta_ads`: approved like any entry, launched by a person in Ads Manager with the entry's tagged link, then marked published with the
// ad's id (`calendar published <entry> --external <ad id>`). Each pull reads the ad's lifetime totals from the Marketing API insights:
// impressions, reach, link clicks and spend. Buying through the system is step 7; nothing here can spend or change an ad.
import { FETCH_TIMEOUT_MS, PartialPullError, type EntryRef, type MetricsSource, type Snapshot } from "../metrics/domain.ts";

export const META_CHANNEL = "meta_ads";
/** The Graph API limits `ids` to 50 per request. */
const CHUNK = 50;
const FIELDS = "insights.date_preset(maximum){impressions,reach,inline_link_clicks,spend}";

/** The ad id of an entry: what the person gave when marking it published (an optional `meta:` prefix is allowed). */
export const adIdOf = (e: Pick<EntryRef, "externalId">): string | null => {
  const id = e.externalId?.replace(/^meta:/, "").trim() ?? "";
  return /^\d{5,25}$/.test(id) ? id : null;
};

export function metaAdsSource(deps: {
  /** A system-user token with ads_read, or null when none is set (the source then measures nothing). */
  token: () => string | null;
  /** Graph API version, e.g. v23.0: Meta retires versions after about two years, so it is a setting. */
  version: () => string;
  fetchImpl?: typeof fetch;
}): MetricsSource {
  const f = deps.fetchImpl ?? fetch;
  return {
    id: "meta",
    channels: [META_CHANNEL],
    measures: ["exposures", "reach", "clicks", "spend"],
    async pull(entries: EntryRef[]): Promise<Snapshot[]> {
      const token = deps.token();
      if (!token) return [];
      const version = deps.version();
      if (!/^v\d{1,3}\.\d$/.test(version)) throw new Error(`Meta API version "${version}" should look like v23.0`);
      const byAd = new Map<string, string>();
      for (const e of entries) { const ad = adIdOf(e); if (ad) byAd.set(ad, e.id); }
      const ads = [...byAd.keys()];
      /** One Graph read of these ads; an error is the whole request's (Graph answers a batch with one error if any id is bad). */
      const read = async (ids: string[]) => {
        const url = `https://graph.facebook.com/${version}/?ids=${ids.join(",")}&fields=${encodeURIComponent(FIELDS)}`;
        const res = await f(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const j: any = await res.json().catch(() => ({}));
        if (!res.ok || j.error) {
          const err = new Error(`Meta insights: ${j.error?.message ?? res.status}${j.error?.code === 190 ? " (the token expired or was revoked: set a new one)" : ""}`) as Error & { code?: number };
          err.code = j.error?.code;
          throw err;
        }
        return j;
      };
      const out: Snapshot[] = [];
      const errors: string[] = [];
      const take = (j: any, ids: string[]) => {
        for (const ad of ids) {
          if (!(ad in j)) continue;   // Meta did not answer for this id: unknown, not 0
          // an ad that has not delivered yet has no insights row: its totals are 0
          const row = j[ad]?.insights?.data?.[0] ?? {};
          const n = (k: string) => { const v = Number(row[k] ?? 0); return Number.isFinite(v) ? v : 0; };
          out.push({ entryId: byAd.get(ad)!, values: { exposures: n("impressions"), reach: n("reach"), clicks: n("inline_link_clicks"), spend: n("spend") } });
        }
      };
      for (let i = 0; i < ads.length; i += CHUNK) {
        const chunk = ads.slice(i, i + CHUNK);
        try {
          take(await read(chunk), chunk);
        } catch (err) {
          // a bad token fails every ad alike: say so once; otherwise find the ids Meta refuses and keep the rest of the batch
          if ((err as { code?: number }).code === 190) throw err;
          if (chunk.length === 1) { errors.push(`ad ${chunk[0]} (entry ${byAd.get(chunk[0])}): ${err instanceof Error ? err.message : String(err)}`); continue; }
          for (const ad of chunk) {
            try { take(await read([ad]), [ad]); } catch (one) {
              if ((one as { code?: number }).code === 190) throw one;
              errors.push(`ad ${ad} (entry ${byAd.get(ad)}): ${one instanceof Error ? one.message : String(one)}`);
            }
          }
        }
      }
      if (errors.length) throw new PartialPullError(out, errors);
      return out;
    },
  };
}
