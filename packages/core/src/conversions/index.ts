// Conversions (docs/analytics.md, phase 4): leads and orders from a site, a CRM or a shop, traced to the calendar entry they came from.
// Sources sign their webhooks (generic format) or a person imports a CSV; customers are hashed with the installation salt at once and
// never stored as given. Agents read counts and ranges only.
import { createHash, randomBytes } from "node:crypto";
import type { Core } from "../index.ts";
import { recipientHasher } from "../email/index.ts";
import type { SimSent } from "../email/adapters/sim.ts";
import { expectedRates, expo, uniform } from "../email/adapters/sim-model.ts";
import { open, seal } from "../settings.ts";
import { attributionRange, entryRef, normalizeEmail, normalizePhone, parseCsv, parseGeneric, verifySignature, type ConversionEvent } from "./domain.ts";

export { sign, parseGeneric, parseCsv, LEAD_STATUSES, ORDER_STATUSES } from "./domain.ts";
export type { ConversionEvent } from "./domain.ts";

const HOUR = 3_600_000;
export type Source = { id: string; rootId: string; name: string; adapter: "generic" | "csv" | "sim"; createdBy: string; createdAt: string; received: number };

export function createConversions(deps: { core: Core; salt: string; /** the plugin's encryption key: seals webhook secrets */ secretKey?: string; now: () => Promise<Date> }) {
  const { core } = deps;
  const q = async (sql: string, params: unknown[] = []) => (await core.pool.query(sql, params)).rows;
  const emailHash = recipientHasher(deps.salt);
  const hashOf = (c: ConversionEvent["customer"]) =>
    c?.email ? emailHash(normalizeEmail(c.email)).hash : c?.phone ? createHash("sha256").update(`${deps.salt}:tel:${normalizePhone(c.phone)}`).digest("hex") : null;

  async function rootOf(campaignId: string) {
    const all = await core.campaigns.list();
    const c = all.find((x) => x.id === campaignId);
    if (!c) throw new Error(`No campaign with id ${campaignId}`);
    return { root: all.find((x) => x.id === c.rootId) ?? c, all };
  }
  const sourceFrom = (r: any): Source => ({ id: r.id, rootId: r.root_id, name: r.name, adapter: r.adapter, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), received: Number(r.received ?? 0) });

  /** Store events of a source: one row per (source, external id), a status change updates it and adds to the history. */
  async function ingest(sourceId: string, events: ConversionEvent[]) {
    const src = (await q("select * from conversion_source where id = $1", [sourceId]))[0];
    if (!src) throw new Error(`No conversion source ${sourceId}`);
    let created = 0, updated = 0, duplicates = 0;
    for (const e of events) {
      const ref = entryRef(e);
      const entry = ref ? (await q("select c.id, c.campaign_id, p.root_id from content_calendar c join campaign p on p.id = c.campaign_id where c.id = $1", [ref]))[0] : undefined;
      const sameBrand = entry && entry.root_id === src.root_id;
      // promo codes of the source's own brand only: another brand's code never moves a lead here
      const promo = e.promoCode ? (await q("select campaign_id from promo_code where root_id = $1 and code = $2", [src.root_id, e.promoCode]))[0]?.campaign_id ?? null : null;
      const before = (await q("select status, version from conversion where source_id = $1 and external_id = $2", [sourceId, e.externalId]))[0];
      if (before && before.status === e.status) { duplicates++; continue; }
      await q(
        `insert into conversion (source_id, external_id, kind, status, occurred_at, root_id, entry_id, campaign_id, customer_hash, value, currency, utm, promo_code, self_report, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict (source_id, external_id) do update set status = excluded.status, value = coalesce(excluded.value, conversion.value),
           version = conversion.version + 1, updated_at = now()`,
        [sourceId, e.externalId, e.kind, e.status, e.occurredAt, src.root_id, sameBrand ? entry.id : null, sameBrand ? entry.campaign_id : promo, hashOf(e.customer),
         e.value ?? null, e.currency ?? null, e.utm ?? null, e.promoCode ?? null, e.selfReport ?? null, e.raw ?? null]);
      await q("insert into conversion_status_event (source_id, external_id, status, at) values ($1,$2,$3,$4) on conflict do nothing", [sourceId, e.externalId, e.status, before ? (await deps.now()).toISOString() : e.occurredAt]);
      if (before) updated++; else created++;
    }
    return { received: events.length, created, updated, duplicates };
  }

  /** Is anything measuring conversions for this brand? Without a source, leads are unknown, not zero. */
  const measured = async (rootId: string) => (await q("select 1 from conversion_source where root_id = $1 limit 1", [rootId])).length > 0;

  return {
    sources: {
      /** A person's action: a new source; its signing secret is returned once and stored sealed. */
      async create(input: { campaignId: string; name: string; adapter: "generic" | "csv"; createdBy: string }): Promise<{ source: Source; secret: string | null }> {
        const { root } = await rootOf(input.campaignId);
        if (!input.name.trim()) throw new Error("Name the source (the form, CRM or shop it is)");
        let secret: string | null = null, sealed: string | null = null;
        if (input.adapter === "generic") {
          if (!deps.secretKey) throw new Error("A signed source needs the plugin's encryption key (Settings)");
          secret = randomBytes(24).toString("base64url");
          sealed = seal(deps.secretKey, secret);
        }
        const r = (await q("insert into conversion_source (root_id, name, adapter, secret_sealed, created_by) values ($1,$2,$3,$4,$5) returning *", [root.id, input.name.trim(), input.adapter, sealed, input.createdBy]))[0];
        return { source: sourceFrom(r), secret };
      },
      async list(campaignId: string): Promise<Source[]> {
        const { root } = await rootOf(campaignId);
        return (await q("select s.*, (select count(*) from conversion c where c.source_id = s.id) as received from conversion_source s where s.root_id = $1 order by s.created_at", [root.id])).map(sourceFrom);
      },
    },
    ingest,
    /** The webhook of a generic source: nothing is stored without a valid signature. */
    async webhook(sourceId: string, req: { headers: Record<string, string | undefined>; body: string }) {
      const src = (await q("select * from conversion_source where id = $1 and adapter = 'generic'", [sourceId]))[0];
      if (!src || !src.secret_sealed || !deps.secretKey) return { ok: false as const, status: 404 };
      const secret = open(deps.secretKey, src.secret_sealed);
      const header = req.headers["x-brandwise-signature"] ?? req.headers["X-BrandWise-Signature"];
      if (!verifySignature(header, req.body, secret, Math.floor((await deps.now()).getTime() / 1000))) return { ok: false as const, status: 401 };
      return { ok: true as const, status: 200, result: await ingest(sourceId, parseGeneric(req.body)) };
    },
    /** A person's action: a CSV export of leads or orders, mapped column by column. */
    async importCsv(sourceId: string, text: string, mapping: Record<string, string>, defaults: { kind?: "lead" | "order" } = {}) {
      return ingest(sourceId, parseCsv(text, mapping, defaults));
    },
    /** A person's action: a promo code of a campaign, unique within its brand. */
    async promo(code: string, campaignId: string) {
      const { root } = await rootOf(campaignId);
      await q("insert into promo_code (root_id, code, campaign_id) values ($1,$2,$3) on conflict (root_id, code) do update set campaign_id = excluded.campaign_id", [root.id, code.trim().toUpperCase(), campaignId]);
    },
    measured,

    /** Leads traced to an entry by its last click, by `asOf`; null when the brand has no conversion source (unknown, not zero). */
    async leadsFor(entryId: string, asOf: Date): Promise<number | null> {
      const e = (await q("select p.root_id from content_calendar c join campaign p on p.id = c.campaign_id where c.id = $1", [entryId]))[0];
      if (!e || !(await measured(e.root_id))) return null;
      return Number((await q("select count(*) as n from conversion where entry_id = $1 and kind = 'lead' and occurred_at <= $2", [entryId, asOf.toISOString()]))[0].n);
    },

    /** Leads, qualified, won, orders and revenue of a campaign (and what is under it) in a window, each as an attribution range. */
    async funnel(campaignId: string, opts: { sinceDays?: number } = {}) {
      const { root, all } = await rootOf(campaignId);
      const under = (id: string): string[] => [id, ...all.filter((c) => c.parentId === id).flatMap((c) => under(c.id))];
      const ids = new Set(under(campaignId));
      const until = await deps.now(), since = new Date(until.getTime() - (opts.sinceDays ?? 30) * 24 * HOUR);
      const rows = await q(
        `select c.*, e.campaign_id as entry_campaign, e.channel, pc.campaign_id as promo_campaign from conversion c
         left join content_calendar e on e.id = c.entry_id left join promo_code pc on pc.root_id = c.root_id and pc.code = c.promo_code
         where c.root_id = $1 and c.occurred_at >= $2 and c.occurred_at < $3`, [root.id, since.toISOString(), until.toISOString()]);
      const channels = [...new Set((await q("select distinct channel from content_calendar where campaign_id = any($1::uuid[])", [[...ids]])).map((r: any) => r.channel as string))];
      const reached = async (status: string) => new Set((await q("select e.external_id, e.source_id from conversion_status_event e join conversion c using (source_id, external_id) where e.status = $1 and c.root_id = $2", [status, root.id])).map((r: any) => `${r.source_id}:${r.external_id}`));
      const [qualified, sql, won] = [await reached("qualified"), await reached("sql"), await reached("won")];
      const pick = (f: (r: any) => boolean) => rows.filter(f).map((r: any) => ({ entryCampaign: r.entry_campaign ?? null, promoCampaign: r.promo_campaign ?? null, selfReport: r.self_report }));
      const key = (r: any) => `${r.source_id}:${r.external_id}`;
      const leads = rows.filter((r: any) => r.kind === "lead");
      const orders = rows.filter((r: any) => r.kind === "order" && r.status === "paid");
      const revenueOf = (sel: any[]) => {
        const lowIds = new Set(sel.filter((r) => r.entry_campaign && ids.has(r.entry_campaign)).map(key));
        const highIds = new Set(sel.filter((r) => (r.entry_campaign && ids.has(r.entry_campaign)) || (r.promo_campaign && ids.has(r.promo_campaign))).map(key));
        const sum = (s: Set<string>) => sel.filter((r) => s.has(key(r))).reduce((t, r) => t + Number(r.value ?? 0), 0);
        return { low: sum(lowIds), high: sum(highIds) };
      };
      return {
        measured: await measured(root.id), since: since.toISOString(), until: until.toISOString(),
        leads: attributionRange(pick((r) => r.kind === "lead"), ids, channels),
        qualified: attributionRange(pick((r) => r.kind === "lead" && (qualified.has(key(r)) || sql.has(key(r)) || won.has(key(r)))), ids, channels),
        won: attributionRange(pick((r) => r.kind === "lead" && won.has(key(r))), ids, channels),
        orders: attributionRange(pick((r) => r.kind === "order" && r.status === "paid"), ids, channels),
        revenue: revenueOf([...orders, ...leads.filter((r: any) => won.has(key(r)))]),
        unattributed: rows.filter((r: any) => !r.entry_campaign && !r.promo_campaign).length,
      };
    },

    /**
     * The simulated shop (development): turns the clicks of a simulated send into leads, following the hidden model of sim-model.ts
     * (bait brings clicks, not leads). Deterministic per audience seed; leads come hours after the click, through the same ingest.
     */
    async simShop(s: SimSent) {
      const entryId = /utm_content=([0-9a-f]{8})/.exec(s.html)?.[1];
      if (!entryId) return null;
      const e = (await q("select p.root_id from content_calendar c join campaign p on p.id = c.campaign_id where c.id = $1", [entryId]))[0];
      if (!e) return null;
      let src = (await q("select id from conversion_source where root_id = $1 and adapter = 'sim'", [e.root_id]))[0];
      if (!src) src = (await q("insert into conversion_source (root_id, name, adapter, created_by) values ($1, 'Simulated shop', 'sim', 'sim') returning id", [e.root_id]))[0];
      const p = expectedRates(s.subject, s.html), seed = s.target.seed ?? "sim";
      const events: ConversionEvent[] = [];
      for (const ev of s.events.filter((x) => x.type === "clicked")) {
        const i = Number(ev.providerEventId.split(":")[1]);
        if (!(uniform(seed, s.subject, i, "lead") < p.leadGivenClick)) continue;
        const at = new Date(Date.parse(ev.at) + expo(uniform(seed, s.subject, i, "leaddelay"), 2 * HOUR, 48 * HOUR)).toISOString();
        events.push({ externalId: `${s.externalId}:${i}`, kind: "lead", status: "new", occurredAt: at, customer: { email: `sim-${s.externalId}-${i}@sim.invalid` }, utm: { last: { content: entryId } }, raw: { sim: true } });
      }
      return ingest(src.id, events);
    },
  };
}
export type Conversions = ReturnType<typeof createConversions>;
