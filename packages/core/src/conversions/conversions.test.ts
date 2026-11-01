// Conversions, pure: the signature, the generic format and CSV, personal data, which entry a lead came from, attribution ranges.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exactRateTest } from "../regulator/stats.ts";
import { attributionRange, classifySelfReport, entryRef, keepKnown, normalizePhone, parseCsv, parseGeneric, sign, verifySignature } from "./domain.ts";

test("the webhook signature: right secret and fresh time only", () => {
  const body = '{"kind":"lead","id":"f1","occurredAt":"2026-06-01T10:00:00Z"}';
  const now = 1_780_000_000;
  assert.equal(verifySignature(sign("s3cret", body, now), body, "s3cret", now), true);
  assert.equal(verifySignature(sign("other", body, now), body, "s3cret", now), false);
  assert.equal(verifySignature(sign("s3cret", body, now - 600), body, "s3cret", now), false, "an old signature is a replay");
  assert.equal(verifySignature(sign("s3cret", body, now), body + " ", "s3cret", now), false);
  assert.equal(verifySignature(undefined, body, "s3cret", now), false);
});

test("the generic format: checked fields, personal data out of raw, statuses from a closed list", () => {
  const [e] = parseGeneric(JSON.stringify({ kind: "lead", id: "f1", occurredAt: "2026-06-01T10:00:00Z", email: "Ann@Example.com", name: "Ann", message: "call me on +420 601 123 456", notes: { who: "Ann Smith" }, utm: { utm_source: "brandwise", utm_content: "ab12cd34", visitor: "Ann" }, promo: "spring10", selfReport: "Ann's newsletter from my friend Bob" }));
  assert.deepEqual([e.status, e.customer?.email, e.utm?.last?.content, e.promoCode], ["new", "Ann@Example.com", "ab12cd34", "SPRING10"]);
  assert.equal(JSON.stringify(e.raw).includes("Ann"), false, "no e-mail, name, message or custom field kept in raw");
  assert.equal(JSON.stringify(e.raw).includes("601"), false);
  assert.equal(e.selfReport, "email,friend", "a self-report keeps the channels it names, never the text");
  assert.equal(classifySelfReport("saw it somewhere"), "other");
  assert.throws(() => parseGeneric(JSON.stringify({ kind: "lead", id: "f1", status: "maybe", occurredAt: "2026-06-01T10:00:00Z" })), /status of a lead/);
  assert.throws(() => parseGeneric(JSON.stringify({ kind: "visit", id: "f1", occurredAt: "2026-06-01" })), /kind is/);
  assert.throws(() => parseGeneric("{nope"), /not JSON/);
  assert.equal(normalizePhone(" +420 601-123 456 "), "+420601123456");
  assert.deepEqual(keepKnown({ kind: "lead", id: "x", customerEmail: "x", comment: "free text", value: 3, utm: { utm_content: "ab12cd34", other: "y" } }), { kind: "lead", id: "x", value: 3, utm: { utm_content: "ab12cd34" } });
});

test("CSV export: columns mapped to fields, quotes and semicolons", () => {
  const csv = 'Deal;Stage;Created;Mail;Content\n"D-1";qualified;2026-06-01T10:00:00Z;a@b.c;ab12cd34\n"D-2";won;2026-06-02T10:00:00Z;"c@d.e";\n';
  const rows = parseCsv(csv, { id: "Deal", status: "Stage", occurredAt: "Created", email: "Mail", utm_content: "Content" }, { kind: "lead" });
  assert.deepEqual(rows.map((r) => [r.externalId, r.status, entryRef(r)]), [["D-1", "qualified", "ab12cd34"], ["D-2", "won", null]]);
});

test("attribution is a range: last click only, or with promo codes and self-reports", () => {
  const ids = new Set(["c1"]);
  const r = attributionRange([
    { entryCampaign: "c1", promoCampaign: null, selfReport: null },          // clicked an e-mail of the campaign
    { entryCampaign: null, promoCampaign: "c1", selfReport: null },          // used the campaign's promo code
    { entryCampaign: null, promoCampaign: null, selfReport: "email" },
    { entryCampaign: "c2", promoCampaign: null, selfReport: "email" },  // another campaign's click wins over a self-report
    { entryCampaign: null, promoCampaign: null, selfReport: "friend" },
  ], ids, ["email"]);
  assert.deepEqual(r, { low: 1, high: 3 });
});

test("the exact test for rare events: leads of two arms", () => {
  const even = exactRateTest(10, 1000, 10, 1000);
  assert.ok(even.p > 0.9 && even.fewer > 0.5);
  const fewer = exactRateTest(25, 8000, 12, 8000);
  assert.ok(fewer.fewer < 0.05, `12 against 25 leads on equal audiences is significantly fewer (p = ${fewer.fewer})`);
  assert.ok(exactRateTest(4, 600, 1, 600).fewer > 0.05, "4 against 1 is not");
  assert.ok(Math.abs(exactRateTest(30, 1000, 45, 1000).p - 0.105) < 0.02, "close to the z-test on larger counts");
});
