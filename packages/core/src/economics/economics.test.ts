// Economics, pure: the profile, the ceilings it implies, review minutes, cost per approved asset per format, production.
import assert from "node:assert/strict";
import { test } from "node:test";
import { derived, formats, production, reviewMinutes, validateProfile } from "./domain.ts";

test("the profile is checked: known fields only, shares between 0 and 1, a currency code", () => {
  assert.throws(() => validateProfile({ model: "shop", currency: "EUR" }), /model is one of/);
  assert.throws(() => validateProfile({ model: "ecommerce", currency: "EUR", margn: 0.4 }), /Unknown profile field\(s\): margn/);
  assert.throws(() => validateProfile({ model: "ecommerce", currency: "EUR", margin: 40 }), /share between 0 and 1/);
  assert.throws(() => validateProfile({ model: "ecommerce", currency: "euro" }), /three-letter/);
  assert.deepEqual(validateProfile({ model: "b2c_leads", currency: "czk", margin: "0.3", reviewMinutes: { 3: 12 } }), { model: "b2c_leads", currency: "CZK", margin: 0.3, reviewMinutes: { 3: 12 }, targets: {} });
});

test("what the profile alone tells: break-even ROAS, the value of a lead, and what is missing", () => {
  const none = derived(null);
  assert.ok(none.every((x) => x.value === null && x.needs.includes("the economics profile")));
  const shop = derived(validateProfile({ model: "ecommerce", currency: "EUR", margin: 0.4, orderValue: 85 }));
  assert.equal(shop.find((x) => x.name === "break_even_roas")?.value, 2.5);
  assert.equal(shop.find((x) => x.name === "cpa_max")?.value, 34);
  const leads = derived(validateProfile({ model: "b2b_leads", currency: "EUR", margin: 0.5, orderValue: 10_000, leadToQualified: 0.3 }));
  assert.deepEqual(leads.find((x) => x.name === "value_per_lead")?.needs, ["qualifiedToCustomer"]);
  const full = derived(validateProfile({ model: "b2b_leads", currency: "EUR", margin: 0.5, orderValue: 10_000, leadToQualified: 0.3, qualifiedToCustomer: 0.2 }));
  assert.equal(full.find((x) => x.name === "value_per_lead")?.value, 300);
  assert.equal(full.find((x) => x.name === "value_per_qualified_lead")?.value, 1000);
});

test("review minutes: the dialog's timer (capped at 30), or the tier's default", () => {
  assert.equal(reviewMinutes({ reviewSeconds: 150, tier: 2 }, null), 2.5);
  assert.equal(reviewMinutes({ reviewSeconds: 7200, tier: 2 }, null), 30, "a dialog left open is not two hours of work");
  assert.equal(reviewMinutes({ reviewSeconds: null, tier: 3 }, null), 10);
  assert.equal(reviewMinutes({ reviewSeconds: null, tier: 3 }, validateProfile({ model: "ecommerce", currency: "EUR", reviewMinutes: { 3: 20 } })), 20);
});

test("cost per approved asset counts rejected and failed generations of the format", () => {
  const rows = formats([
    { format: "video/veo", status: "done", units: 10, money: 5, assetId: "a1" },      // approved
    { format: "video/veo", status: "done", units: 10, money: 5, assetId: "a2" },      // rejected at review
    { format: "video/veo", status: "failed", units: 10, money: 5, assetId: null },    // failed at the provider
    { format: "image/nano", status: "done", units: 2, money: null, assetId: "a3" },   // no unit price yet
  ], new Set(["a1", "a3"]));
  const video = rows.find((r) => r.format === "video/veo")!;
  assert.deepEqual([video.generations, video.failed, video.approvedAssets, video.costPerApprovedAsset, video.approvedShare], [3, 1, 1, 15, 0.5]);
  assert.equal(rows.find((r) => r.format === "image/nano")!.costPerApprovedAsset, null, "no price, no money");
});

test("production: first-pass approval, send-backs per entry, time to approval and reasons", () => {
  const ev = (kind: string, h: number, reason: string | null = null) => ({ entryId: "", kind, at: new Date(Date.UTC(2026, 5, 1, h)).toISOString(), reason });
  const p = production([
    { id: "e1", createdAt: new Date(Date.UTC(2026, 5, 1, 0)).toISOString(), events: [ev("created", 0), ev("approved", 2)] },
    { id: "e2", createdAt: new Date(Date.UTC(2026, 5, 1, 0)).toISOString(), events: [ev("created", 0), ev("changes_requested", 1, "tone"), ev("edited", 3), ev("approved", 6)] },
    { id: "e3", createdAt: new Date(Date.UTC(2026, 5, 1, 0)).toISOString(), events: [ev("created", 0)] },
  ]);
  assert.deepEqual([p.entries, p.decided, p.firstPassRate, p.sendBacksPerEntry, p.medianHoursToApproval, p.reasons], [3, 2, 0.5, 0.5, 6, { tone: 1 }]);
});
