// Mock platform and payment (development and tests): deterministic, in memory. The platform keeps orders per idempotency key, so a
// retried create buys once; its reports grow by day and the click-through fades (creative fatigue). The payment method authorizes
// once per reference and remembers what it charged; tokens are opaque strings that tests can look for in outputs.
import { randomBytes } from "node:crypto";
import type { AdOrder, MediaBuyer, PaymentProvider, PaymentToken, ReportDay } from "../domain.ts";

const DAY = 86_400_000;

export function mockBuyer(cfg: { now: () => Promise<Date>; requiresPayment?: boolean }): MediaBuyer & { orders: Map<string, AdOrder & { externalId: string; startedAt: string; budgetNow: number; paused: boolean; tokens: string[] }>; creates: number } {
  const orders = new Map<string, AdOrder & { externalId: string; startedAt: string; budgetNow: number; paused: boolean; tokens: string[] }>();
  const byExternal = (id: string) => [...orders.values()].find((o) => o.externalId === id);
  const self = {
    id: "mock-ads", requiresPayment: cfg.requiresPayment ?? true, orders, creates: 0,
    async create(order: AdOrder, payment: PaymentToken | null) {
      const known = orders.get(order.key);
      if (known) return { externalId: known.externalId };
      if (self.requiresPayment && (!payment || payment.amount < order.budget)) throw new Error("mock-ads: the payment does not cover the budget");
      self.creates++;
      const externalId = `mock-ad-${order.key}`;
      orders.set(order.key, { ...order, externalId, startedAt: (await cfg.now()).toISOString(), budgetNow: order.budget, paused: false, tokens: payment ? [payment.token] : [] });
      return { externalId };
    },
    async setBudget(externalId: string, budget: number, payment: PaymentToken | null) {
      const o = byExternal(externalId);
      if (!o) throw new Error(`mock-ads: no ad ${externalId}`);
      if (self.requiresPayment && budget > o.budgetNow && (!payment || payment.amount < budget - o.budgetNow)) throw new Error("mock-ads: the payment does not cover the increase");
      o.budgetNow = budget;
      if (payment) o.tokens.push(payment.token);
    },
    async pause(externalId: string) { const o = byExternal(externalId); if (o) o.paused = true; },
    async report(externalId: string, since: string, until: string): Promise<ReportDay[]> {
      const o = byExternal(externalId);
      if (!o) return [];
      const start = Date.parse(o.startedAt), end = Math.min(Date.parse(until), start + o.days * DAY);
      const out: ReportDay[] = [];
      for (let t = start, i = 0; t < end && !o.paused; t += DAY, i++) {
        if (t < Date.parse(since) - DAY) continue;
        const spend = o.budgetNow / o.days, impressions = Math.round(spend * 200), ctr = 0.012 * Math.pow(0.93, i);
        const clicks = Math.round(impressions * ctr);
        out.push({ day: new Date(t).toISOString().slice(0, 10), spend, impressions, reach: Math.round(impressions * 0.6 * (i + 1)), clicks, conversions: Math.round(clicks * 0.05) });
      }
      return out;
    },
  };
  return self;
}

export function mockPayments(): PaymentProvider & { charges: { reference: string; seller: string; amount: number; currency: string }[] } {
  const issued = new Map<string, PaymentToken>();
  const self = {
    id: "mock-pay", charges: [] as { reference: string; seller: string; amount: number; currency: string }[],
    async authorize(input: { seller: string; amount: number; currency: string; reference: string }): Promise<PaymentToken> {
      const known = issued.get(input.reference);
      if (known) return known;   // a retry pays once
      const t: PaymentToken = { token: `tok_${randomBytes(12).toString("hex")}`, reference: `auth_${input.reference}`, seller: input.seller, amount: input.amount, currency: input.currency, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      issued.set(input.reference, t);
      self.charges.push({ reference: input.reference, seller: input.seller, amount: input.amount, currency: input.currency });
      return t;
    },
  };
  return self;
}
