// Conversions, pure: the generic signed webhook format, CSV import, normalization, which entry a conversion came from, and
// attribution as a range (docs/analytics.md, phase 4). No database, no clock.
import { createHmac, timingSafeEqual } from "node:crypto";

export const LEAD_STATUSES = ["new", "qualified", "sql", "won", "lost"] as const;
export const ORDER_STATUSES = ["paid", "refunded"] as const;
export type Utm = { source?: string; medium?: string; campaign?: string; content?: string };
export type ConversionEvent = {
  externalId: string; kind: "lead" | "order"; status: string; occurredAt: string;
  /** Hashed with the installation salt at ingest, never stored as given. */
  customer?: { email?: string; phone?: string };
  value?: number; currency?: string; utm?: { last?: Utm; first?: Utm }; bw?: string; promoCode?: string; selfReport?: string;
  raw: unknown;
};

const ENTRY_ID = /^[0-9a-f]{8}$/;

/** `X-BrandWise-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`; a signature older than the tolerance fails. */
export function sign(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}
export function verifySignature(header: string | undefined, body: string, secret: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds || !parts.v1) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const given = Buffer.from(parts.v1);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
/** Digits with a leading + when there was one; good enough to match the same number written two ways. */
export const normalizePhone = (p: string) => { const t = p.trim(); return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, ""); };

/** Keys that hold personal data are dropped from what is kept as `raw`. */
const PII = /e-?mail|phone|tel|name|address|street|city|zip|postal|ip|birth|card|iban/i;
export function stripPersonal(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripPersonal);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !PII.test(k)).map(([k, x]) => [k, stripPersonal(x)]));
  return v;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const utmOf = (v: unknown): Utm | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const u = { source: str(o.source ?? o.utm_source), medium: str(o.medium ?? o.utm_medium), campaign: str(o.campaign ?? o.utm_campaign), content: str(o.content ?? o.utm_content) };
  return Object.values(u).some(Boolean) ? JSON.parse(JSON.stringify(u)) : undefined;
};

/** One event of the generic format (an object, or an array of them). Unknown statuses are refused, so a typo does not count. */
export function parseGeneric(body: string): ConversionEvent[] {
  let data: unknown;
  try { data = JSON.parse(body); } catch { throw new Error("The body is not JSON"); }
  const items = Array.isArray(data) ? data : [data];
  return items.map((x, i) => {
    if (!x || typeof x !== "object") throw new Error(`Item ${i} is not an object`);
    const o = x as Record<string, unknown>;
    const kind = o.kind === "order" ? "order" : o.kind === "lead" ? "lead" : null;
    if (!kind) throw new Error(`Item ${i}: kind is "lead" or "order"`);
    const externalId = str(o.id ?? o.externalId);
    if (!externalId) throw new Error(`Item ${i}: id is required (the form submission, deal or order id)`);
    const status = str(o.status) ?? (kind === "lead" ? "new" : "paid");
    if (!(kind === "lead" ? LEAD_STATUSES : ORDER_STATUSES).includes(status as never)) throw new Error(`Item ${i}: status of a ${kind} is one of ${(kind === "lead" ? LEAD_STATUSES : ORDER_STATUSES).join(", ")}`);
    const occurredAt = str(o.occurredAt ?? o.at) ?? "";
    if (Number.isNaN(Date.parse(occurredAt))) throw new Error(`Item ${i}: occurredAt is an ISO date`);
    const value = o.value === undefined || o.value === null || o.value === "" ? undefined : Number(o.value);
    if (value !== undefined && !(value >= 0)) throw new Error(`Item ${i}: value is 0 or more`);
    const utm = o.utm && typeof o.utm === "object" ? { last: utmOf((o.utm as Record<string, unknown>).last ?? o.utm), first: utmOf((o.utm as Record<string, unknown>).first) } : undefined;
    return JSON.parse(JSON.stringify({
      externalId, kind, status, occurredAt: new Date(occurredAt).toISOString(),
      customer: { email: str(o.email ?? (o.customer as Record<string, unknown> | undefined)?.email), phone: str(o.phone ?? (o.customer as Record<string, unknown> | undefined)?.phone) },
      value, currency: str(o.currency)?.toUpperCase(), utm, bw: str(o.bw), promoCode: str(o.promoCode ?? o.promo)?.toUpperCase(), selfReport: str(o.selfReport ?? o.howDidYouHear),
      raw: stripPersonal(o),
    })) as ConversionEvent;
  });
}

/** A CSV export (first row: headers) mapped to the generic fields: `mapping` names the column of each field (id, kind, status, ...). */
export function parseCsv(text: string, mapping: Record<string, string>, defaults: { kind?: "lead" | "order" } = {}): ConversionEvent[] {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const col = (field: string) => { const name = mapping[field] ?? field; const i = header.indexOf(name); return i; };
  const items = rows.slice(1).filter((r) => r.some((c) => c.trim() !== "")).map((r) => {
    const get = (f: string) => { const i = col(f); return i >= 0 ? r[i] : undefined; };
    return {
      id: get("id"), kind: get("kind") ?? defaults.kind, status: get("status"), occurredAt: get("occurredAt"), value: get("value"), currency: get("currency"),
      email: get("email"), phone: get("phone"), promoCode: get("promoCode"), selfReport: get("selfReport"), bw: get("bw"),
      utm: { last: { source: get("utm_source"), medium: get("utm_medium"), campaign: get("utm_campaign"), content: get("utm_content") } },
    };
  });
  return parseGeneric(JSON.stringify(items));
}
function csvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

/** The calendar entry a conversion came from: the last click's utm_content, or the `bw` the site snippet kept. */
export function entryRef(e: Pick<ConversionEvent, "utm" | "bw">): string | null {
  for (const v of [e.utm?.last?.content, e.bw]) if (v && ENTRY_ID.test(v)) return v;
  return null;
}

export type Attributable = { entryCampaign: string | null; promoCampaign: string | null; selfReport: string | null };
/**
 * Attribution as a range, never one number: `low` counts only last clicks traced to the campaign's entries; `high` also counts promo
 * codes of the campaign and self-reports that name one of its channels. Decide on the range, not on a point.
 */
export function attributionRange(conversions: Attributable[], campaignIds: Set<string>, channels: string[]): { low: number; high: number } {
  const said = (t: string | null) => !!t && channels.some((c) => new RegExp(`\\b(${c === "email" ? "e-?mail|newsletter" : c})\\b`, "i").test(t));
  let low = 0, high = 0;
  for (const c of conversions) {
    const click = c.entryCampaign !== null && campaignIds.has(c.entryCampaign);
    if (click) low++;
    if (click || (c.promoCampaign !== null && campaignIds.has(c.promoCampaign)) || (c.entryCampaign === null && said(c.selfReport))) high++;
  }
  return { low, high };
}
