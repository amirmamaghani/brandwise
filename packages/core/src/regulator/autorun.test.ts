// Who is due on a campaign: the automation starts an agent only when there is work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { whoIsDue } from "./autorun.ts";
import type { Signals } from "./signals.ts";
import type { ExperimentRow, TaskRow } from "./store.ts";

const signals = (p: { frozen?: boolean; running?: { id: string; verdict: string }[]; ok?: boolean; reason?: string } = {}): Signals => ({
  asOf: "2026-06-01T00:00:00Z", frozen: { frozen: p.frozen ?? false, reason: p.frozen ? "complaints" : null }, incumbent: null, goals: [], recent: [],
  experiments: { running: (p.running ?? []).map((r) => ({ id: r.id, hypothesis: "h", armA: "a", armB: "b", status: "running" as const, verdict: r.verdict, createdAt: "", concludedAt: null, reasons: [], readyAt: null })), recentlyConcluded: [] },
  power: null, allowed: { proposeExperiment: { ok: p.ok ?? true, reason: p.reason ?? null } }, notes: [],
});
const task = (status: TaskRow["status"], entry?: string): TaskRow => ({ id: Math.random().toString(36).slice(2, 8), campaignId: "c", kind: "write_variant", brief: "b", params: {}, status, claimedBy: null, result: entry ? { entry } : null, createdBy: "editor", createdAt: "" });
const exp = (a: string, b: string): ExperimentRow => ({ id: "e1", campaignId: "c", hypothesis: "h", lever: null, metric: "click_rate", armA: a, armB: b, status: "concluded", verdict: "A", result: null, createdBy: "editor", createdAt: "", concludedAt: "", expectedLift: null, plannedRounds: 1, plannedPerArm: null, mde: null, rounds: [{ round: 1, armA: a, armB: b }] });

test("nobody runs on a frozen campaign or while an experiment waits for data", () => {
  assert.deepEqual([whoIsDue(signals({ frozen: true }), [], []).editor, whoIsDue(signals({ frozen: true }), [task("open")], []).author], [false, false]);
  assert.equal(whoIsDue(signals({ running: [{ id: "x", verdict: "wait" }] }), [], []).editor, false);
});

test("the editor runs to judge, to start written arms, or to propose; the author runs for open tasks", () => {
  assert.equal(whoIsDue(signals({ running: [{ id: "x", verdict: "B" }] }), [], []).editor, true);
  const writing = whoIsDue(signals(), [task("open"), task("claimed")], []);
  assert.deepEqual([writing.editor, writing.author], [false, true]);
  assert.equal(whoIsDue(signals({ ok: false, reason: "cooldown" }), [task("done", "e1"), task("done", "e2")], []).editor, true, "two written arms wait");
  assert.equal(whoIsDue(signals({ ok: false, reason: "cooldown" }), [task("done", "e1"), task("done", "e2")], [exp("e1", "e2")]).editor, false, "already used in an experiment");
  assert.equal(whoIsDue(signals({ ok: true }), [], []).editor, true);
  assert.equal(whoIsDue(signals({ running: [{ id: "x", verdict: "next_round" }] }), [], []).editor, true, "a series needs its next round");
  assert.deepEqual(Object.values(whoIsDue(signals({ running: [{ id: "x", verdict: "next_round" }] }), [task("open")], [])).slice(0, 2), [false, true], "the author writes it first");
  const quiet = whoIsDue(signals({ ok: false, reason: "cooldown after the last change: 5 h left" }), [], []);
  assert.deepEqual([quiet.editor, quiet.author, quiet.reason], [false, false, "cooldown after the last change: 5 h left"]);
});
