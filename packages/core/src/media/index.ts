// Paid media (docs/analytics.md, phase 5): ad buys, boosts and budget changes as calendar entries on channel "ads" at tier 3. Code checks
// the spend limits when an order is made and again right before money moves; the payment token exists only in the connector's memory.
// Platform reports become metric points and media spend in the cost ledger; per ad, CPL and ROAS use our leads, not the platform's.
import type { Core } from "../index.ts";
import type { Connector } from "../publish.ts";
import type { Economics } from "../economics/index.ts";
import type { Conversions } from "../conversions/index.ts";
import { campaignSlug, withUtm } from "../email/domain/render.ts";
import { adNumbers, checkLimits, type Limits, type MediaBuyer, type PaymentProvider, type PaymentToken } from "./domain.ts";

export { checkLimits, adNumbers } from "./domain.ts";
export type { MediaBuyer, PaymentProvider, Limits } from "./domain.ts";
export { mockBuyer, mockPayments } from "./adapters/mock.ts";

const DAY = 86_400_000;
export type OrderRow = { entryId: string; action: "media_buy" | "boost" | "budget_change"; budget: number; currency: string; days: number; objective: string; boostOf: string | null; orderOf: string | null; platform: string | null; payment: string | null; prepaid: boolean; externalId: string | null; startedAt: string | null; paymentRef: string | null; status: string; createdBy: string; createdAt: string };
const orderFrom = (r: any): OrderRow => ({ entryId: r.entry_id, action: r.action, budget: Number(r.budget), currency: r.currency, days: r.days, objective: r.objective, boostOf: r.boost_of, orderOf: r.order_of, platform: r.platform, payment: r.payment ?? null, prepaid: r.prepaid === true, externalId: r.external_id, startedAt: r.started_at ? new Date(r.started_at).toISOString() : null, paymentRef: r.payment_ref, status: r.status, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() });

export function createMedia(deps: {
  core: Core; economics: Economics; conversions?: Conversions; buyers: MediaBuyer[]; payments: PaymentProvider[];
  /** The spend limits a person set for the campaign's scope (ads.maxPerOrder, ads.dailyLimit, ads.monthlyLimit) and the brand's currency. */
  limits: (campaignId: string) => Promise<Limits>;
  now: () => Promise<Date>;
}) {
  const { core } = deps;
  const q = async (sql: string, params: unknown[] = []) => (await core.pool.query(sql, params)).rows;
  const order = async (entryId: string) => { const r = (await q("select * from media_order where entry_id = $1", [entryId]))[0]; return r ? orderFrom(r) : null; };

  /**
   * What the brand's orders already commit. Per day: drafts and live orders still running (budget over days). This month: every order
   * scheduled this month whatever became of it (live, paused, ended), or its actual media spend if that is more; only refused orders and
   * cancelled or never-bought entries are left out. A pending budget change commits its increase; an executed one lives in its order.
   */
  async function committed(campaignId: string, except: string[] = []) {
    const all = await core.campaigns.list();
    const c = all.find((x) => x.id === campaignId);
    const ids = all.filter((x) => x.rootId === (c?.rootId ?? campaignId)).map((x) => x.id);
    const now = await deps.now(), month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const rows = await q(
      `select o.*, e.scheduled_at, e.status as entry_status, prev.budget as prev_budget,
              (select coalesce(sum(amount), 0) from cost_entry ce where ce.kind = 'media' and ce.entry_id = o.entry_id) as spent
       from media_order o join content_calendar e on e.id = o.entry_id left join media_order prev on prev.entry_id = o.order_of
       where e.campaign_id = any($1::uuid[]) and o.status <> 'refused' and not (o.entry_id = any($2::text[]))`, [ids, except]);
    let perDay = 0, monthTotal = 0;
    for (const r of rows) {
      const bought = r.status === "live" || r.status === "paused" || r.status === "ended";
      if (!bought && (r.entry_status === "cancelled" || r.entry_status === "failed")) continue;
      if (r.action === "budget_change") {
        if (r.status === "draft") { const inc = Math.max(0, Number(r.budget) - Number(r.prev_budget ?? 0)); perDay += inc / r.days; monthTotal += inc; }
        continue;
      }
      const start = Date.parse(r.started_at ?? r.scheduled_at), end = start + r.days * DAY;
      if ((r.status === "draft" || r.status === "live") && end > now.getTime()) perDay += Number(r.budget) / r.days;
      if (new Date(r.scheduled_at).toISOString() >= month || r.status === "live") monthTotal += Math.max(Number(r.budget), Number(r.spent));
    }
    return { perDay, month: monthTotal };
  }

  /** A boosted post or a changed order must be the same brand's. */
  async function sameBrand(campaignId: string, entryId: string) {
    const all = await core.campaigns.list();
    const e = await core.calendar.get(entryId);
    const root = (id: string) => all.find((x) => x.id === id)?.rootId;
    return e !== null && root(e.campaignId) !== undefined && root(e.campaignId) === root(campaignId);
  }

  /** `except`: orders the checked one replaces in the count (itself; for a budget change also the order it changes). */
  async function ensureLimits(campaignId: string, o: { budget: number; days: number; currency: string }, except: string[] = []) {
    const v = checkLimits(o, await deps.limits(campaignId), await committed(campaignId, except));
    if (!v.ok) throw new Error(`Over the ads limits: ${v.reason}. Nothing was bought or paid.`);
  }

  return {
    order,
    /**
     * An ad buy, a boost of a published post, or a budget change, as a calendar entry on channel "ads" at tier 3 (a person approves it).
     * Refused at once when it breaks a limit.
     */
    async create(input: { campaignId: string; name: string; body: string; link?: string | null; assetId?: string | null; action: OrderRow["action"]; budget: number; currency?: string; days: number; objective?: string; boostOf?: string | null; orderOf?: string | null; at: string; createdBy: string }) {
      if (!(input.budget > 0)) throw new Error("The budget is more than 0");
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > 90) throw new Error("An order runs 1 to 90 days");
      const limits = await deps.limits(input.campaignId);
      const currency = (input.currency ?? limits.currency ?? "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Give the currency (or set it in the brand's economics profile)");
      if (input.action === "boost") {
        const post = input.boostOf ? await core.calendar.get(input.boostOf) : null;
        if (!post || post.status !== "published") throw new Error("A boost promotes a published post: give its entry with --boost");
        if (!(await sameBrand(input.campaignId, post.id))) throw new Error("A boost promotes a post of the same brand");
      }
      if (input.action === "budget_change") {
        const prev = input.orderOf ? await order(input.orderOf) : null;
        if (!prev || prev.status !== "live") throw new Error("A budget change changes a live order: give its entry with --order");
        if (!(await sameBrand(input.campaignId, prev.entryId))) throw new Error("A budget change changes an order of the same brand");
      }
      // a budget change is checked as the order's new total over its days, in place of the order it changes (not on top of it)
      const prevOrder = input.action === "budget_change" ? await order(input.orderOf!) : null;
      await ensureLimits(input.campaignId, { budget: input.budget, days: prevOrder?.days ?? input.days, currency }, prevOrder ? [prevOrder.entryId] : []);
      // the platform and the payment method are fixed in the order now, so the person approves exactly how it will be bought
      const target = await core.channels.get(input.campaignId, "ads");
      const buyer = deps.buyers.find((b) => b.id === target?.provider);
      if (!buyer) throw new Error(`The campaign has no ads platform${target?.provider ? ` "${target.provider}" that is configured` : ""}: a person sets it on the Results page (Paid)`);
      const prepaid = target?.prepaid === "true";
      if (buyer.requiresPayment && !prepaid && !deps.payments.some((p) => p.id === target?.payment)) throw new Error(`${buyer.id} takes payment per order: a person sets a payment method on the Results page (Paid)`);
      if (input.action === "budget_change" && (await order(input.orderOf!))?.platform !== buyer.id) throw new Error("A budget change goes to the platform of the order it changes");
      const entry = await core.calendar.add({ campaignId: input.campaignId, title: input.name, channel: "ads", scheduledAt: input.at, tier: 3, body: input.body, link: input.link ?? null, assetId: input.assetId ?? null, createdBy: input.createdBy });
      await q(`insert into media_order (entry_id, action, budget, currency, days, objective, boost_of, order_of, platform, payment, prepaid, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [entry.id, input.action, input.budget, currency, input.days, input.objective ?? "traffic", input.boostOf ?? null, input.orderOf ?? null, buyer.id, prepaid ? null : target?.payment ?? null, prepaid, input.createdBy]);
      return { entry, order: (await order(entry.id))! };
    },

    /** The connector for channel "ads": checks the limits again, pays when the seller needs it, buys (idempotent per entry). */
    connector(): Connector {
      return {
        id: "ads", channels: ["ads"],
        targetHint: "a person sets the campaign's ads platform on the Results page (Paid)",
        // the live target only decides whether the channel is set up at all; platform and payment come from the order as approved
        async publish({ entry, asset, idempotencyKey }) {
          const o = await order(entry.id);
          if (!o) throw new Error(`Entry ${entry.id} has no media order`);
          // money moves only for what a person approved on a page, and only for the brand's own posts and orders
          if (entry.approvedBy !== "ui") throw new Error(`Entry ${entry.id} was not approved by a person in the UI: nothing is bought`);
          for (const ref of [o.boostOf, o.orderOf]) if (ref && !(await sameBrand(entry.campaignId, ref))) throw new Error(`Entry ${ref} belongs to another brand: nothing is bought`);
          const buyer = deps.buyers.find((b) => b.id === o.platform);
          if (!buyer) throw new Error(`The order's ads platform "${o.platform ?? ""}" is not configured: nothing is bought`);
          const changes = o.action === "budget_change" ? await order(o.orderOf!) : null;
          // a budget change only for a running ad: a person may have paused it after approving the change
          if (changes && changes.status !== "live") throw new Error(`Order ${changes.entryId} is ${changes.status}: its budget is not changed and nothing is paid`);
          // limits may have changed since the order was made; a budget change counts in place of the order it changes
          await ensureLimits(entry.campaignId, changes ? { ...o, days: changes.days } : o, changes ? [entry.id, changes.entryId] : [entry.id]);
          // the token is created here, handed to the platform and dropped: only its reference is stored
          const pay = async (amount: number): Promise<PaymentToken | null> => {
            if (!buyer.requiresPayment || o.prepaid || amount <= 0) return null;
            const method = deps.payments.find((p) => p.id === o.payment);
            if (!method) throw new Error(`The order's payment method "${o.payment ?? ""}" is not configured: nothing is paid`);
            const token = await method.authorize({ seller: buyer.id, amount, currency: o.currency, reference: idempotencyKey });
            await q("update media_order set payment_ref = $2 where entry_id = $1", [entry.id, token.reference]);
            return token;
          };
          const link = entry.link ? withUtm(entry.link, { entryId: entry.id, campaign: campaignSlug(entry.campaignName), medium: "paid", source: buyer.id }) : null;
          if (o.action === "budget_change") {
            const prev = (await order(o.orderOf!))!;
            if (prev.platform !== buyer.id) throw new Error(`Order ${prev.entryId} runs on ${prev.platform}, not ${buyer.id}: nothing is bought`);
            await buyer.setBudget(prev.externalId!, o.budget, await pay(o.budget - prev.budget));
            await q("update media_order set budget = $2, updated_at = now() where entry_id = $1", [prev.entryId, o.budget]);
            await q("update media_order set status = 'ended', platform = $2, external_id = $3, updated_at = now() where entry_id = $1", [entry.id, buyer.id, prev.externalId]);
            return { externalId: prev.externalId! };
          }
          const boosted = o.boostOf ? await core.calendar.get(o.boostOf) : null;
          const r = await buyer.create({
            key: idempotencyKey, name: entry.title, text: entry.body, link, assetUrl: asset ? await asset.url() : null, budget: o.budget, currency: o.currency, days: o.days,
            objective: o.objective, boostOf: boosted?.externalId ?? null,
          }, await pay(o.budget));
          await q("update media_order set status = 'live', platform = $2, external_id = $3, started_at = coalesce(started_at, $4), updated_at = now() where entry_id = $1", [entry.id, buyer.id, r.externalId, (await deps.now()).toISOString()]);
          return { externalId: r.externalId };
        },
      };
    },

    /** Pull the platforms' reports of live orders: metric points per day, media spend into the cost ledger (idempotent). Silent when nothing changed. */
    async pull() {
      const now = await deps.now();
      const live = (await q("select o.*, e.campaign_id from media_order o join content_calendar e on e.id = o.entry_id where o.status = 'live' and o.action <> 'budget_change'")).map((r: any) => ({ ...orderFrom(r), campaignId: r.campaign_id as string }));
      let points = 0;
      for (const o of live) {
        const buyer = deps.buyers.find((b) => b.id === o.platform);
        if (!buyer || !o.externalId) continue;
        const days = await buyer.report(o.externalId, new Date(now.getTime() - 90 * DAY).toISOString(), now.toISOString());
        for (const d of days) {
          const at = `${d.day}T00:00:00.000Z`;
          for (const [metric, value] of [["spend", d.spend], ["impressions", d.impressions], ["reach", d.reach], ["clicks", d.clicks], ["conversions", d.conversions]] as const) {
            const r = await q(`insert into metric_point (source, entity, metric, at, value) values ($1,$2,$3,$4,$5)
                               on conflict (source, entity, metric, at) do update set value = excluded.value where metric_point.value <> excluded.value returning 1`, [buyer.id, `calendar:${o.entryId}`, metric, at, value]);
            points += r.length;
          }
          await deps.economics.store.upsertCost({ campaignId: o.campaignId, kind: "media", units: d.spend, unit: "money", amount: d.spend, source: buyer.id, sourceRef: `${o.externalId}:${d.day}`, entryId: o.entryId, createdBy: "media pull", at });
          await q("update cost_entry set units = $3, amount = $3 where source = $1 and source_ref = $2 and amount <> $3", [buyer.id, `${o.externalId}:${d.day}`, d.spend]);
        }
        // its days run from when it went live, not from when the draft was made
        if (Date.parse(o.startedAt ?? o.createdAt) + (o.days + 1) * DAY < now.getTime()) await q("update media_order set status = 'ended', updated_at = now() where entry_id = $1", [o.entryId]);
      }
      return { orders: live.length, points };
    },

    /** Platforms and payment methods this installation has, for the person who sets a campaign's ads target. */
    options: () => ({ platforms: deps.buyers.map((b) => ({ id: b.id, requiresPayment: b.requiresPayment })), payments: deps.payments.map((p) => p.id) }),
    /** A person's action (UI only): where a campaign buys media and how it pays. Orders keep what was set when they were made. */
    async setTarget(campaignId: string, t: { provider: string; payment?: string | null; prepaid?: boolean } | null) {
      if (t === null) { await core.channels.unset(campaignId, "ads"); return; }
      const buyer = deps.buyers.find((b) => b.id === t.provider);
      if (!buyer) throw new Error(`No ads platform "${t.provider}" is configured`);
      if (buyer.requiresPayment && !t.prepaid && !deps.payments.some((p) => p.id === t.payment)) throw new Error(`${buyer.id} takes payment per order: pick a payment method, or mark the account prepaid`);
      await core.channels.set(campaignId, "ads", t.prepaid ? { provider: buyer.id, prepaid: "true" } : { provider: buyer.id, payment: t.payment! });
    },

    /** Stop an ad (a protective action: anyone who may read the campaign may pause it). */
    async pause(entryId: string) {
      const o = await order(entryId);
      if (!o || o.status !== "live" || !o.externalId) throw new Error(`Entry ${entryId} is no live ad`);
      const buyer = deps.buyers.find((b) => b.id === o.platform);
      // never mark an ad paused that keeps running: without its platform adapter it cannot be stopped from here
      if (!buyer) throw new Error(`The ad runs on ${o.platform}, which is not configured here: pause it on the platform`);
      await buyer.pause(o.externalId);
      await q("update media_order set status = 'paused', updated_at = now() where entry_id = $1", [entryId]);
    },

    /** Per ad of a campaign: spend, reach, CTR, CPC, frequency, fatigue, and CPL, CPQL and ROAS on our leads and orders. */
    async results(campaignId: string) {
      const all = await core.campaigns.list();
      const c = all.find((x) => x.id === campaignId);
      const under = (id: string): string[] => [id, ...all.filter((x) => x.parentId === id).flatMap((x) => under(x.id))];
      const rows = await q("select o.*, e.title, e.asset_id, e.campaign_id from media_order o join content_calendar e on e.id = o.entry_id where e.campaign_id = any($1::uuid[]) and o.action <> 'budget_change' order by o.created_at", [under(c?.id ?? campaignId)]);
      const formats = await deps.economics.formats(campaignId, { sinceDays: 365 });
      const out = [];
      for (const r of rows) {
        const points = await q("select metric, at, value from metric_point where entity = $1", [`calendar:${r.entry_id}`]);
        const days = [...new Set(points.map((p: any) => new Date(p.at).toISOString().slice(0, 10)))].map((day) => {
          const v = (m: string) => Number(points.find((p: any) => p.metric === m && new Date(p.at).toISOString().slice(0, 10) === day)?.value ?? 0);
          return { day, spend: v("spend"), impressions: v("impressions"), reach: v("reach"), clicks: v("clicks"), conversions: v("conversions") };
        });
        const ours = await q("select kind, status, value, (select bool_or(e.status in ('qualified', 'sql', 'won')) from conversion_status_event e where e.source_id = c.source_id and e.external_id = c.external_id) as qualified from conversion c where entry_id = $1", [r.entry_id]);
        const measured = deps.conversions ? await deps.conversions.leadsFor(r.entry_id, await deps.now()) !== null : false;
        const asset = r.asset_id ? (await q("select kind from asset where id = $1", [r.asset_id]))[0] : null;
        const fmt = asset ? formats.find((f) => f.format.startsWith(`${asset.kind}/`) && f.costPerApprovedAsset !== null) : null;
        out.push({
          entryId: r.entry_id, name: r.title, action: r.action, status: r.status, platform: r.platform, budget: Number(r.budget), currency: r.currency, days: r.days,
          ...adNumbers(days, {
            leads: measured ? ours.filter((x: any) => x.kind === "lead").length : null,
            qualified: measured ? ours.filter((x: any) => x.kind === "lead" && x.qualified).length : null,
            revenue: measured ? ours.filter((x: any) => x.kind === "order" && x.status === "paid").reduce((t: number, x: any) => t + Number(x.value ?? 0), 0) : null,
          }, fmt?.costPerApprovedAsset ?? null),
        });
      }
      return out;
    },
  };
}
export type Media = ReturnType<typeof createMedia>;
