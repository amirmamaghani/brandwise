// Who has work on a campaign right now: the editor, the author, or nobody. Pure. The `editor autorun` automation asks this first and
// starts an agent thread only when there is something to do, so a quiet campaign costs no agent run.
import type { Signals } from "./signals.ts";
import type { ExperimentRow, TaskRow } from "./store.ts";

export type Due = { editor: boolean; author: boolean; reason: string };

export function whoIsDue(s: Signals, tasks: TaskRow[], experiments: ExperimentRow[]): Due {
  if (s.frozen.frozen) return { editor: false, author: false, reason: `frozen (${s.frozen.reason ?? "a guard was broken"}): a person must clear it` };
  const open = tasks.filter((t) => t.status === "open"), claimed = tasks.filter((t) => t.status === "claimed");
  const author = open.length > 0;
  const judgeable = s.experiments.running.find((e) => e.verdict !== "wait" && e.verdict !== "next_round");
  if (judgeable) return { editor: true, author, reason: `experiment ${judgeable.id} can be judged` };
  const nextRound = s.experiments.running.find((e) => e.verdict === "next_round");
  if (nextRound && open.length + claimed.length === 0) {
    const used = new Set(experiments.flatMap((e) => [e.armA, e.armB, ...e.rounds.flatMap((r) => [r.armA, r.armB])]));
    const written = tasks.filter((t) => t.status === "done" && typeof (t.result as { entry?: unknown } | null)?.entry === "string" && !used.has((t.result as { entry: string }).entry));
    return { editor: true, author: false, reason: written.length >= 2 ? `the next round of ${nextRound.id} is written: add it` : `experiment ${nextRound.id} needs its next round` };
  }
  if (nextRound) return { editor: false, author, reason: `the author is writing the next round of ${nextRound.id}` };
  if (s.experiments.running.length > 0) return { editor: false, author, reason: `experiment ${s.experiments.running[0].id} is waiting for data` };
  if (open.length + claimed.length > 0) return { editor: false, author, reason: `${open.length} open and ${claimed.length} claimed task(s): the author is not done` };
  const arms = new Set(experiments.flatMap((e) => [e.armA, e.armB, ...e.rounds.flatMap((r) => [r.armA, r.armB])]));
  const ready = tasks.filter((t) => t.status === "done" && t.kind === "write_variant" && typeof (t.result as { entry?: unknown } | null)?.entry === "string" && !arms.has((t.result as { entry: string }).entry));
  if (ready.length >= 2) return { editor: true, author: false, reason: `${ready.length} written arm(s) wait to be started as an experiment` };
  const p = s.allowed.proposeExperiment;
  if (p.ok) return { editor: true, author: false, reason: "a new experiment may start" };
  return { editor: false, author: false, reason: p.reason ?? "nothing to do" };
}
