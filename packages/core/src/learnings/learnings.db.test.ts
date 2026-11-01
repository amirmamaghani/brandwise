// Learnings and the review history against the database, with a scripted measure and clock (no e-mail provider needed).
// Needs the local stack (DATABASE_URL, S3_*), skipped without.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { purge } from "../testing.ts";
import { createLearnings, type Measure } from "./index.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const DAY = 86_400_000;

async function setup(prefix: string) {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const clock = { now: new Date("2026-06-01T12:00:00Z") };
  const outcomes = new Map<string, { rate: number; low: number; high: number; delivered: number }>();
  let observations: Awaited<ReturnType<Measure["observations"]>> = [];
  const measure: Measure = {
    outcome: async (entryId) => outcomes.get(entryId) ?? null,
    observations: async () => observations,
  };
  const learnings = createLearnings({ core, now: async () => clock.now, measure });
  const base = await core.campaigns.add({ name: `${prefix}-base`, kind: "always_on" });
  const child = await core.campaigns.add({ name: `${prefix}-spring`, kind: "campaign", parentId: base.id });
  const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  return { core, learnings, base, child, clock, outcomes, setObservations: (o: typeof observations) => { observations = o; }, future, cleanup: async () => { await purge(core, prefix); await core.close(); } };
}

run("every action on an entry is kept: who approved, the send-back note and reason, what was edited", async () => {
  const prefix = `test-${Date.now()}-history`;
  const { core, child, future, cleanup } = await setup(prefix);
  try {
    const e = await core.calendar.add({ campaignId: child.id, title: "3 ideas for spring", channel: "email", scheduledAt: future(48), tier: 2, body: "Hello", createdBy: "author-1" });
    await assert.rejects(core.calendar.requestChanges(e.id, "Too pushy", { actor: "ui", reason: "rude" }), /Unknown reason/);
    await core.calendar.requestChanges(e.id, "Too pushy", { actor: "ui", reason: "tone" });
    await core.calendar.update(e.id, { title: "Three ideas for spring" }, "author-1");
    const approved = await core.calendar.decide(e.id, "approve", "ui");
    assert.equal(approved.approvedBy, "ui");
    assert.ok(approved.approvedAt);
    assert.equal((await core.calendar.unapprove(e.id, "ui")).approvedBy, null);
    const h = await core.calendar.history(e.id);
    assert.deepEqual(h.map((x) => x.kind), ["created", "changes_requested", "edited", "approved", "unapproved"]);
    assert.deepEqual([h[1].note, h[1].reason, h[1].actor], ["Too pushy", "tone", "ui"]);
    assert.deepEqual((h[2].data as { fields: string[] }).fields, ["title"]);
    assert.equal(h[2].toStatus, "pending_approval", "the edit resubmitted it");
    const auto = await core.calendar.add({ campaignId: child.id, title: "Tier one", channel: "email", scheduledAt: future(48), tier: 1, body: "x" });
    assert.equal(auto.approvedBy, "auto");
    const attrs = await core.calendar.attributes(e.id);
    assert.equal(attrs.subject_number.value, "no", "derived again after the title lost its digit");
    assert.equal(attrs.subject_number.source, "derived");
  } finally {
    await cleanup();
  }
});

run("brief, attach and preferences: agents cite what they apply, a person confirms rules drawn from send-backs", async () => {
  const prefix = `test-${Date.now()}-brief`;
  const { core, learnings, base, child, future, cleanup } = await setup(prefix);
  try {
    const obs = await learnings.addObservation({ campaignId: child.id, statement: "Questions in the subject may lift clicks", lever: "subject_style: plain -> question", channel: "email", createdBy: "editor" });
    assert.deepEqual([obs.evidence, obs.scope], ["E3", "campaign"]);
    const sentBack = await core.calendar.add({ campaignId: child.id, title: "BUY NOW!!!", channel: "email", scheduledAt: future(48), tier: 2, body: "x" });
    const fresh = await core.calendar.add({ campaignId: child.id, title: "Never sent back", channel: "email", scheduledAt: future(48), tier: 2, body: "x" });
    await assert.rejects(learnings.proposePreference({ campaignId: child.id, rule: "No exclamation marks", fromEntries: [fresh.id], createdBy: "agent" }), /never sent back/);
    await core.calendar.requestChanges(sentBack.id, "No shouting, no exclamation marks", { actor: "ui", reason: "tone" });
    const pref = await learnings.proposePreference({ campaignId: child.id, rule: "No exclamation marks in subjects", fromEntries: [sentBack.id], createdBy: "agent" });
    assert.equal(pref.status, "proposed");
    let b = await learnings.brief({ campaignId: child.id, channel: "email", createdBy: "author" });
    assert.equal(b.payload.styleRules.length, 0, "a proposed rule is not in force");
    assert.equal(b.payload.candidates[0]?.id, obs.id);
    assert.equal(b.payload.recentFeedback[0]?.note, "No shouting, no exclamation marks");
    await learnings.confirm(pref.id, "ui");
    b = await learnings.brief({ campaignId: child.id, channel: "email", createdBy: "author" });
    assert.deepEqual(b.payload.styleRules.map((r) => r.id), [pref.id]);
    assert.match(b.text, /Style rules from reviews/);

    const entry = await core.calendar.add({ campaignId: child.id, title: "Which idea fits your spring?", channel: "email", scheduledAt: future(72), tier: 2, body: "x", createdBy: "author" });
    await assert.rejects(learnings.attach(entry.id, { applies: ["nope1234"] }), /does not belong/);
    await assert.rejects(learnings.attach(entry.id, { tags: "colour=red" }), /Unknown tag/);
    await learnings.attach(entry.id, { briefId: b.id, applies: [pref.id], tests: [obs.id], tags: "hook=question" });
    const card = await learnings.forEntry(entry.id);
    assert.equal(card.briefId, b.id);
    assert.deepEqual(card.applied.map((a) => [a.id, a.mode]).sort(), [[obs.id, "test"], [pref.id, b.payload.slot]].sort());
    assert.equal(card.attributes.hook?.value, "question");
    assert.equal(card.attributes.subject_question.value, "yes");
    const other = await core.campaigns.add({ name: `${prefix}-other-brand`, kind: "always_on" });
    const foreign = await learnings.addObservation({ campaignId: other.id, statement: "Another brand's observation", createdBy: "x" });
    await assert.rejects(learnings.attach(entry.id, { applies: [foreign.id] }), /does not belong/);
    void base;
  } finally {
    await cleanup();
  }
});

run("a null result blocks a re-test of the same size until it ages out; contrary applications put a learning up for re-test", async () => {
  const prefix = `test-${Date.now()}-gate`;
  const { core, learnings, base, child, clock, outcomes, future, cleanup } = await setup(prefix);
  try {
    const nul = await learnings.store.insert({ campaignId: base.id, scope: "brand", kind: "null_result", evidence: "E1", result: "no_difference", statement: "hook question -> number: no difference", channel: "email", lever: { attribute: "hook", from: "question", to: "number" }, nPerArm: 1000, mde: 0.4, createdBy: "regulator", decidedAt: clock.now.toISOString() });
    const lever = { attribute: "hook", from: "number", to: "question" };   // the same lever, the other way round
    assert.match((await learnings.retestGate(child.id, lever, 1000)).reason ?? "", new RegExp(nul.id));
    assert.equal((await learnings.retestGate(child.id, lever, null)).ok, false, "unknown size: the null result stands");
    assert.equal((await learnings.retestGate(child.id, lever, 3000)).ok, true, "a clearly larger sample may try again");
    assert.equal((await learnings.retestGate(child.id, { attribute: "hook", from: "question", to: "story" }, 1000)).ok, true);
    clock.now = new Date(clock.now.getTime() + 125 * DAY);   // hooks are trends: two half-lives of 60 days
    assert.equal((await learnings.retestGate(child.id, lever, 1000)).ok, true, "an aged-out null result no longer blocks");

    const better = await learnings.store.insert({ campaignId: base.id, scope: "brand", kind: "performance", evidence: "E1", result: "better", statement: "tone formal -> friendly: +30 %", channel: "email", lever: { attribute: "tone", from: "formal", to: "friendly" }, effect: 0.3, nPerArm: 2000, createdBy: "regulator", decidedAt: clock.now.toISOString() });
    for (let i = 0; i < 5; i++) {
      const e = await core.calendar.add({ campaignId: child.id, title: `Friendly ${i}`, channel: "email", scheduledAt: future(24 + i), tier: 1, body: "x" });
      await learnings.attach(e.id, { applies: [better.id] });
      outcomes.set(e.id, { rate: 0.01, low: 0.005, high: 0.015, delivered: 1000 });
    }
    // the baseline comes from other matured sends of the brand
    const listed = async () => (await learnings.list(child.id)).find((l) => l.id === better.id)!;
    assert.equal((await listed()).effectiveStatus, "active", "no baseline yet: outcomes are not judged");
  } finally {
    await cleanup();
  }
});

run("contrary outcomes against the brand baseline doubt a learning; the miner finds a steady pattern once and replaces it when it turns", async () => {
  const prefix = `test-${Date.now()}-mine`;
  const { core, learnings, base, child, outcomes, setObservations, future, cleanup } = await setup(prefix);
  try {
    // 24 matured sends in two months: subject lines with a number get 5 %, without 3 %
    const sends: { id: string; month: string; withNumber: boolean }[] = [];
    for (const month of ["2026-04", "2026-05"]) for (let i = 0; i < 12; i++) {
      const withNumber = i % 2 === 0;
      const e = await core.calendar.add({ campaignId: child.id, title: withNumber ? `${i + 2} ideas for you` : "Ideas for you", channel: "email", scheduledAt: future(24 * (i + 1)), tier: 1, body: "x" });
      sends.push({ id: e.id, month, withNumber });
    }
    const observe = (yes: number, no: number) => setObservations(sends.map((s, i) => ({ entryId: s.id, sentAt: `${s.month}-${String(10 + (i % 12)).padStart(2, "0")}T10:00:00Z`, delivered: 1000, clicks: Math.round(1000 * (s.withNumber ? yes : no)) })));
    observe(0.05, 0.03);
    const first = await learnings.mine(base.id);
    assert.equal(first.length, 1);
    assert.deepEqual([first[0].evidence, first[0].lever, first[0].result, first[0].scope], ["E2", { attribute: "subject_number", from: "no", to: "yes" }, "better", "brand"]);
    assert.equal((await learnings.mine(base.id)).length, 0, "an unchanged pattern is not repeated");
    observe(0.03, 0.05);
    const turned = await learnings.mine(base.id);
    assert.equal(turned.length, 1);
    assert.equal(turned[0].result, "worse");
    assert.equal((await learnings.get(first[0].id))?.status, "superseded");

    // contrary applications: five entries applied the current learning and did clearly worse than the brand baseline (4 %)
    observe(0.04, 0.04);
    const applied: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await core.calendar.add({ campaignId: child.id, title: `Applied ${i}`, channel: "email", scheduledAt: future(400 + i), tier: 1, body: "x" });
      await learnings.attach(e.id, { applies: [turned[0].id] });
      outcomes.set(e.id, { rate: 0.02, low: 0.015, high: 0.025, delivered: 1000 });   // they followed "numbers hurt" (no number) and did clearly worse
      applied.push(e.id);
    }
    const l = (await learnings.list(child.id)).find((x) => x.id === turned[0].id)!;
    assert.deepEqual([l.contrary, l.effectiveStatus], [5, "needs_retest"]);
    const b = await learnings.brief({ campaignId: child.id, channel: "email", createdBy: "t" });
    assert.ok(b.payload.needsRetest.some((x) => x.id === turned[0].id));
  } finally {
    await cleanup();
  }
});
