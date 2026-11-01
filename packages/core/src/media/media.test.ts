// Paid media, pure: limits fail closed, per-ad numbers, fatigue, production in the fully loaded CPL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adNumbers, checkLimits } from "./domain.ts";

const L = { maxPerOrder: 100, dailyLimit: 30, monthlyLimit: 500, currency: "EUR" };
test("spend limits fail closed and count what is already committed", () => {
  assert.match(checkLimits({ budget: 10, days: 1, currency: "EUR" }, { maxPerOrder: null, dailyLimit: 30, monthlyLimit: 500, currency: "EUR" }, { perDay: 0, month: 0 }).reason!, /no ads limits are set/);
  assert.match(checkLimits({ budget: 200, days: 10, currency: "EUR" }, L, { perDay: 0, month: 0 }).reason!, /per order/);
  assert.match(checkLimits({ budget: 60, days: 2, currency: "EUR" }, L, { perDay: 10, month: 0 }).reason!, /daily limit/);
  assert.match(checkLimits({ budget: 90, days: 9, currency: "EUR" }, L, { perDay: 0, month: 450 }).reason!, /monthly limit/);
  assert.match(checkLimits({ budget: 90, days: 9, currency: "USD" }, L, { perDay: 0, month: 0 }).reason!, /USD/);
  assert.match(checkLimits({ budget: 90, days: 9, currency: "EUR" }, { ...L, currency: null }, { perDay: 0, month: 0 }).reason!, /no currency/, "no brand currency: nothing is bought");
  assert.equal(checkLimits({ budget: 70, days: 7, currency: "EUR" }, L, { perDay: 10, month: 100 }).ok, true);
});

test("per ad: CTR, CPC, CPM, frequency, CPL on our leads, ROAS on our orders, fatigue, production when it matters", () => {
  const days = Array.from({ length: 6 }, (_, i) => ({ day: `2026-06-0${i + 1}`, spend: 10, impressions: 2000, reach: 1200 * (i + 1), clicks: Math.round(2000 * 0.012 * Math.pow(0.85, i)), conversions: 1 }));
  const n = adNumbers(days, { leads: 4, qualified: 2, revenue: 180 }, 12);
  assert.equal(n.spend, 60);
  assert.equal(n.cpl, 15);
  assert.equal(n.cpql, 30);
  assert.equal(n.roas, 3);
  assert.equal(n.fatigue, true, "the click-through faded by more than 30 %");
  assert.equal(n.fullyLoadedCpl, 18, "production (12) is over 10 % of the spend (60): it counts");
  assert.equal(adNumbers(days, { leads: 4, qualified: 2, revenue: 180 }, 3).fullyLoadedCpl, null, "under 10 % it does not");
  assert.equal(adNumbers(days, { leads: null, qualified: null, revenue: null }, null).cpl, null, "no lead source: unknown");
  assert.equal(n.platformConversions, 6, "the platform's own count stays separate");
});
