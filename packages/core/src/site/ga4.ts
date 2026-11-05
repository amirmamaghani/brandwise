// Google Analytics 4 as a metrics source (docs/analytics.md, step 4): visits, leads, orders and revenue of the client's own site per
// calendar entry, found by utm_content (the entry id every link carries since step 1). Leads come from the analytics the client
// already has, so nobody sets up a webhook or a CSV export: the client adds our service account to the GA4 property as a Viewer and a
// person names the property on the brand's base campaign (`campaign channel set site propertyId=<id> [leadEvents=generate_lead,...]`).
// Reads the Data API (analyticsdata.googleapis.com, runReport) with a service-account token; nothing is written to Google.
import { createSign } from "node:crypto";
import type { EntryRef, MetricsSource, Snapshot } from "../metrics/domain.ts";

/** The fields of a Google service-account key file this adapter uses. */
export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const API = "https://analyticsdata.googleapis.com/v1beta";
/** GA4 limits a filter's list; ask in chunks. */
const CHUNK = 100;

export function parseServiceAccount(json: string): ServiceAccount {
  let v: any;
  try { v = JSON.parse(json); } catch { throw new Error("The GA4 service account is not valid JSON: paste the whole key file"); }
  if (typeof v?.client_email !== "string" || typeof v?.private_key !== "string") throw new Error("The GA4 service account key has no client_email or private_key");
  return { client_email: v.client_email, private_key: v.private_key, token_uri: typeof v.token_uri === "string" ? v.token_uri : undefined };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The signed assertion Google exchanges for an access token (OAuth 2.0 JWT bearer grant). */
export function assertion(sa: ServiceAccount, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(sig)}`;
}

export function ga4Source(deps: {
  /** The service account, or null when none is set (the source then measures nothing). */
  credentials: () => ServiceAccount | null;
  /** The `site` target of a campaign, inherited from its parent: propertyId and, optionally, leadEvents. */
  targetOf: (campaignId: string) => Promise<Record<string, string> | null>;
  fetchImpl?: typeof fetch;
}): MetricsSource {
  const f = deps.fetchImpl ?? fetch;
  let token: { value: string; until: number; email: string } | null = null;

  async function accessToken(sa: ServiceAccount, now: Date): Promise<string> {
    if (token && token.email === sa.client_email && token.until > now.getTime() + 60_000) return token.value;
    const res = await f(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion(sa, now) }).toString(),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof j.access_token !== "string") throw new Error(`GA4 sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
    token = { value: j.access_token, until: now.getTime() + Number(j.expires_in ?? 3600) * 1000, email: sa.client_email };
    return token.value;
  }

  /** Lead events of a property: the names given in its target, or every key event when none is given. */
  const leadMetrics = (target: Record<string, string>) => {
    const events = (target.leadEvents ?? "").split(",").map((e) => e.trim()).filter((e) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e));
    return events.length ? events.map((e) => `keyEvents:${e}`) : ["keyEvents"];
  };

  return {
    id: "ga4",
    channels: ["*"],
    measures: ["visits", "leads", "orders", "revenue"],
    async pull(entries: EntryRef[], now: Date): Promise<Snapshot[]> {
      const sa = deps.credentials();
      if (!sa || entries.length === 0) return [];
      // entries grouped by the property their campaign names; entries of campaigns without one are not measured
      const byProperty = new Map<string, { target: Record<string, string>; ids: string[] }>();
      const targets = new Map<string, Record<string, string> | null>();
      for (const e of entries) {
        if (!targets.has(e.campaignId)) targets.set(e.campaignId, await deps.targetOf(e.campaignId));
        const t = targets.get(e.campaignId);
        const property = t?.propertyId?.trim();
        if (!t || !property) continue;
        if (!/^\d{5,15}$/.test(property)) throw new Error(`GA4 propertyId "${property}" is not a number (find it under Admin > Property details)`);
        const g = byProperty.get(property) ?? { target: t, ids: [] };
        g.ids.push(e.id);
        byProperty.set(property, g);
      }
      const out: Snapshot[] = [];
      for (const [property, { target, ids }] of byProperty) {
        const leads = leadMetrics(target);
        const metrics = ["sessions", ...leads, "ecommercePurchases", "purchaseRevenue"];
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          const res = await f(`${API}/properties/${property}:runReport`, {
            method: "POST",
            headers: { authorization: `Bearer ${await accessToken(sa, now)}`, "content-type": "application/json" },
            body: JSON.stringify({
              // the whole life of the entries: a session cannot carry an entry's id before the entry was published
              dateRanges: [{ startDate: "2020-01-01", endDate: "today" }],
              dimensions: [{ name: "sessionManualAdContent" }],
              metrics: metrics.map((name) => ({ name })),
              dimensionFilter: { filter: { fieldName: "sessionManualAdContent", inListFilter: { values: chunk, caseSensitive: true } } },
              limit: CHUNK,
            }),
          });
          const j: any = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`GA4 property ${property}: ${j.error?.message ?? res.status}${res.status === 403 ? ` (add ${sa.client_email} to the property as a Viewer)` : ""}`);
          const rows = new Map<string, number[]>();
          for (const r of j.rows ?? []) rows.set(r.dimensionValues?.[0]?.value, (r.metricValues ?? []).map((m: any) => Number(m.value)));
          for (const id of chunk) {
            // GA4 leaves out rows that are all zero: an entry of a measured property with no row had no visit yet
            const v = rows.get(id) ?? metrics.map(() => 0);
            const sum = (from: number, n: number) => v.slice(from, from + n).reduce((t, x) => t + (Number.isFinite(x) ? x : 0), 0);
            out.push({ entryId: id, values: { visits: sum(0, 1), leads: sum(1, leads.length), orders: sum(1 + leads.length, 1), revenue: sum(2 + leads.length, 1) } });
          }
        }
      }
      return out;
    },
  };
}
