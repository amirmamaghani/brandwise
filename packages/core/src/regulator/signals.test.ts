// Signals, pure: which sends the goals are measured on when a campaign publishes on several channels.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MetricName } from "../metrics/domain.ts";
import { DEFAULT_RAILS } from "./rails.ts";
import { buildSignals, type SendView } from "./signals.ts";

const ASOF = new Date("2026-11-10T12:00:00Z");
const send = (id: string, channel: string, sentAt: string, values: Partial<Record<MetricName, number>>): SendView =>
  ({ entryId: id, title: id, campaignId: "c", channel, sentAt, metrics: { entryId: id, channel, startedAt: sentAt, values, sources: {} } });
const signals = (sends: SendView[]) => buildSignals({
  asOf: ASOF, rails: DEFAULT_RAILS, goals: [{ metric: "click_rate", kind: "target", value: 0.05 }], sends,
  state: { frozen: false, frozenReason: null, running: 0, lastAdoptedAt: null, incumbentEntryId: null }, experiments: [],
});

test("goals skip newer sends whose exposures nobody measures, so a campaign that also posts keeps its e-mail goals", () => {
  const s = signals([
    send("m1", "email", "2026-11-01T09:00:00Z", { exposures: 1500, clicks: 60 }),
    send("m2", "email", "2026-11-02T09:00:00Z", { exposures: 1416, clicks: 74 }),
    // newer than the e-mails, matured, with clicks (short links) or site visits (GA4) but no views
    send("t1", "telegram", "2026-11-05T09:00:00Z", { clicks: 12 }),
    send("w1", "web", "2026-11-06T09:00:00Z", { visits: 30 }),
    send("w2", "web", "2026-11-07T09:00:00Z", { visits: 4 }),
  ]);
  assert.equal(s.goals[0].sample, 2916);
  assert.equal(s.goals[0].current, 134 / 2916);
  assert.equal(s.power?.exposuresPerArm, 1458);
  assert.equal(s.recent.length, 5, "every send is still listed");
});

test("goals are measured on one channel: e-mail CTR and ad CTR are not pooled; the note says so", () => {
  const s = signals([
    send("m1", "email", "2026-11-01T09:00:00Z", { exposures: 1500, clicks: 60 }),
    send("a1", "meta_ads", "2026-11-03T09:00:00Z", { exposures: 20000, clicks: 180 }),
    send("a2", "meta_ads", "2026-11-04T09:00:00Z", { exposures: 10000, clicks: 70 }),
  ]);
  assert.equal(s.goals[0].sample, 30000, "the latest measured channel (ads) alone");
  assert.equal(s.goals[0].current, 250 / 30000);
  assert.ok(s.notes.some((n) => /measured on the latest meta_ads sends/.test(n)));
});

test("nothing measured: goals are unknown and the note says why, not that nothing matured", () => {
  const s = signals([send("t1", "telegram", "2026-11-05T09:00:00Z", { clicks: 12 })]);
  assert.equal(s.goals[0].current, null);
  assert.equal(s.power, null);
  assert.ok(s.notes.some((n) => /No matured send has measured exposures/.test(n)));
});
