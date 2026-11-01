// CLI of the editor-in-chief regulator and of the development clock: `bb brandwise editor ...` and `bb brandwise sim ...`.
// The regulator itself (rails, signals, experiments) lives in packages/core/src/regulator; this file only parses arguments and prints.
import type { Core } from "./core/index.ts";
import type { Regulator } from "./core/regulator/index.ts";
import type { Signals } from "./core/regulator/signals.ts";
import { whoIsDue } from "./core/regulator/autorun.ts";

/** What `editor autorun` needs from the host: which campaigns opted in, how to start an agent thread, and when it last did. */
export type AutoRunHost = {
  enabled: (campaignId: string) => Promise<boolean>;
  spawn: (prompt: string, campaignId: string) => Promise<string>;
  lastRun: (key: string) => Promise<number | null>;
  setLastRun: (key: string, at: number) => Promise<void>;
};
/** An agent that was started less than this ago is still working or just finished: do not start another. */
const AUTORUN_GAP_MS = 2 * 3_600_000;

type Io = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };

const pct = (v: number | null, digits = 1) => (v === null ? "n/a" : `${(100 * v).toFixed(digits)} %`);
const DURATION = /^(\d+(?:\.\d+)?)(m|h|d)$/;
/** "90m", "24h", "2d" to milliseconds. */
export const parseDuration = (s: string): number => {
  const m = DURATION.exec(s);
  if (!m) throw new Error(`Give a duration like 90m, 24h or 2d (got "${s}")`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
};

export function fmtSignals(s: Signals): string {
  const lines = [`As of ${s.asOf}${s.frozen.frozen ? `   FROZEN: ${s.frozen.reason}` : ""}`];
  lines.push(s.incumbent ? `Incumbent: ${s.incumbent.title} (entry ${s.incumbent.entryId})` : "Incumbent: none yet");
  lines.push("", "Goals (smoothed over the last matured sends):");
  for (const g of s.goals) lines.push(`  ${g.metric.padEnd(17)} ${g.kind === "target" ? "target >=" : "limit  <="} ${pct(g.value)}   now ${pct(g.current)} (n=${g.sample})   ${g.ok === null ? "no data" : g.ok ? "OK" : `gap ${pct(g.gap)}`}`);
  if (s.goals.length === 0) lines.push("  none set: ask a person to set goals (editor goals set ...)");
  lines.push("", "Recent sends (newest first):");
  for (const r of s.recent) lines.push(`  ${r.entryId}  ${r.mature ? "mature " : `matures ${r.maturesAt?.slice(0, 16) ?? "?"}`}  delivered ${String(r.delivered).padStart(5)}  click ${pct(r.clickRate)} [${r.clickRateCi ? `${pct(r.clickRateCi[0])}..${pct(r.clickRateCi[1])}` : "n/a"}]  complaints ${pct(r.complaintRate, 2)}  "${r.title}"${r.guard ? `   GUARD: ${r.guard}` : ""}`);
  if (s.recent.length === 0) lines.push("  nothing sent yet");
  lines.push("", "Experiments:");
  for (const e of s.experiments.running) lines.push(`  RUNNING ${e.id}: "${e.hypothesis}" (A ${e.armA}, B ${e.armB}) -> ${e.verdict}${e.reasons.length ? ": " + e.reasons.join("; ") : ""}${e.readyAt ? `   look again after ${e.readyAt.slice(0, 16)}` : ""}`);
  for (const e of s.experiments.recentlyConcluded) lines.push(`  done    ${e.id}: "${e.hypothesis}" -> ${e.verdict}`);
  if (s.experiments.running.length + s.experiments.recentlyConcluded.length === 0) lines.push("  none");
  if (s.power?.leadRate != null) lines.push("", `Leads are measured: ${pct(s.power.leadRate, 2)} of delivered. A click win has to bring leads (the rails keep the control otherwise); a lead experiment (--metric lead_rate) can only show ${s.power.leadMinDetectableLift === null ? "very large effects" : `about ${pct(s.power.leadMinDetectableLift, 0)} or more per send`}.`);
  if (s.power) lines.push("", `Power: with about ${s.power.deliveredPerArm} delivered per arm at a ${pct(s.power.clickRate)} click rate, one send can only show a lift of about ${pct(s.power.minDetectableLift, 0)} or more; a smaller real effect will end inconclusive. A series of rounds shows less: ${s.power.roundsFor.map((r) => `+${Math.round(100 * r.lift)} % needs ${r.rounds ?? "more than 20"} round(s)`).join(", ")}.`);
  const p = s.allowed.proposeExperiment;
  lines.push("", `May start a new experiment now: ${p.ok ? "yes" : `no, ${p.reason}`}`);
  for (const n of s.notes) lines.push(`Note: ${n}`);
  return lines.join("\n");
}

export function createEditorCli(deps: { core: () => Core; regulator: () => Regulator | null; autorun?: AutoRunHost }) {
  /** The regulator works on the always-on base: a campaign (or a child of it) given on the command line resolves to its base. */
  async function base(args: string[], io: Io) {
    const c = await deps.core().campaigns.resolve(io.val(args, "--campaign"));
    return deps.core().campaigns.list().then((all) => all.find((x) => x.id === c.rootId) ?? c);
  }

  async function editor(action: string | undefined, args: string[], io: Io) {
    const reg = deps.regulator();
    if (!reg) return { exitCode: 1, stderr: "The regulator needs the database and the e-mail module: run infra/bb-instance/provision.sh apply" };
    const { val, positional, reply, usage } = io;
    const rest = positional(args.slice(2));
    const who = val(args, "--as")?.trim() || "agent";
    // a label agents give themselves, never a reserved actor: "ui" is a person on a page, the others are code
    if (["ui", "auto", "scheduler", "regulator", "miner", "promotion"].includes(who.toLowerCase())) return { exitCode: 1, stderr: `--as ${who} is reserved: it names a person on a page or the system` };
    const bad = { exitCode: 1, stderr: usage };
    if (action === "autorun") return autorun(reg, io);
    if (!action || !["signals", "goals", "unfreeze", "experiments", "journal", "tasks"].includes(action)) return bad;   // no campaign lookup for a bare command
    const b = await base(args, io);
    const asOf = val(args, "--as-of");

    if (action === "signals") { const s = await reg.signals(b.id, asOf); return reply(s, fmtSignals(s)); }
    if (action === "goals") {
      if (rest[0] === "set") { // a person's command: goals are the setpoint, the agent does not move them
        const [, metric, value] = rest;
        const kind = val(args, "--kind");
        if (!metric || value === undefined || (kind !== "target" && kind !== "limit")) return bad;
        await reg.goals.set(b.id, metric, kind, Number(value));
      }
      const goals = await reg.goals.list(b.id);
      return reply(goals, goals.map((g) => `${g.metric}  ${g.kind}  ${pct(g.value)}`).join("\n") || "No goals set.");
    }
    if (action === "unfreeze") { await reg.unfreeze(b.id); return reply({ ok: true }, `${b.name}: unfrozen (a person's command)`); }
    if (action === "experiments") {
      const sub = rest[0];
      if (sub === "propose") {
        const [armA, armB, hypothesis, lever, expected] = [val(args, "--a"), val(args, "--b"), val(args, "--hypothesis"), val(args, "--lever"), val(args, "--expected-lift")];
        if (!armA || !armB || !hypothesis) return bad;
        if (!lever) return { exitCode: 1, stderr: 'Name the one thing the experiment changes: --lever "attribute: from -> to", e.g. --lever "subject_style: plain -> number"' };
        if (!expected || !Number.isFinite(Number(expected))) return { exitCode: 1, stderr: "Register what you expect before the first send: --expected-lift 0.3 (+30 %). Code checks it against what the audience can show and says how many --rounds it needs." };
        const rounds = Number(val(args, "--rounds") ?? 1);
        const metric = val(args, "--metric") as "click_rate" | "lead_rate" | undefined;
        const e = await reg.experiments.propose({ campaignId: b.id, armA, armB, hypothesis, lever, createdBy: who, expectedLift: Number(expected), rounds, metric });
        return reply(e, `Experiment ${e.id} registered and started: A ${e.armA} (control) against B ${e.armB} (challenger), lever ${e.lever ? `${e.lever.attribute}: ${e.lever.from} -> ${e.lever.to}` : "?"}, expected ${pct(e.expectedLift, 0)}, ${e.plannedRounds} round(s)${e.mde !== null ? `, can show ${pct(e.mde, 0)} or more` : ""}. The arms mature 24 h after sending; judge it with: editor experiments evaluate ${e.id}${e.plannedRounds > 1 ? `; after each mature round write the next pair and add it with: editor experiments add-round ${e.id} --a <control entry> --b <challenger entry>` : ""}`);
      }
      if (sub === "add-round") {
        const [a, bb] = [val(args, "--a"), val(args, "--b")];
        if (!rest[1] || !a || !bb) return bad;
        const e = await reg.experiments.addRound({ experimentId: rest[1], armA: a, armB: bb });
        return reply(e, `Round ${e.rounds.length} of ${e.plannedRounds} added to experiment ${e.id}: A ${a}, B ${bb}.`);
      }
      if (sub === "backfill") { const n = await reg.experiments.backfill(b.id); return reply({ created: n }, `${n} structured learning(s) made from earlier verdicts.`); }
      if (sub === "evaluate") {
        if (!rest[1]) return bad;
        const r = await reg.experiments.evaluate(rest[1], asOf);
        return reply(r, r.verdict === "wait" ? `Not ready: ${r.reasons.join("; ")}${r.readyAt ? ` (look again after ${r.readyAt.slice(0, 16)})` : ""}`
          : r.verdict === "next_round" ? `Next round: ${r.reasons.join(" ")} Create the two write_variant tasks for it, then: editor experiments add-round ${rest[1]} --a <control entry> --b <challenger entry>`
          : `Verdict ${r.verdict}${r.final ? " (final)" : ""}: ${r.reasons.join(" ") || "recorded earlier"}`);
      }
      const list = await reg.experiments.list(b.id, val(args, "--status"));
      return reply(list, list.map((e) => `${e.id}  ${e.status}${e.verdict ? " -> " + e.verdict : ""}  round ${e.rounds.length}/${e.plannedRounds}  expected ${pct(e.expectedLift, 0)}  A ${e.rounds.map((r) => r.armA).join(",")}  B ${e.rounds.map((r) => r.armB).join(",")}  "${e.hypothesis}"`).join("\n") || "No experiments.");
    }
    if (action === "journal") {
      if (rest[0] === "write") {
        const text = rest.slice(1).join(" ");
        if (!text) return bad;
        await reg.journal.write(b.id, who, text, val(args, "--kind") === "note" ? "note" : "run");
        return reply({ ok: true }, "Written to the journal.");
      }
      const rows = await reg.journal.read(b.id, Number(val(args, "--limit") ?? 12) || 12, val(args, "--kind"));
      return reply(rows, rows.map((r) => `${r.at.slice(0, 16)}  [${r.kind}] ${r.author}: ${r.body}`).join("\n") || "The journal is empty.");
    }
    if (action === "tasks") {
      const sub = rest[0];
      if (sub === "create") {
        const kind = val(args, "--kind"), brief = val(args, "--brief");
        if (!kind || !brief) return bad;
        const params = val(args, "--params") ? JSON.parse(val(args, "--params")!) : {};
        const t = await reg.tasks.create(b.id, who, { kind, brief, params });
        return reply(t, `Task ${t.id} created (${t.kind}). An author agent will claim it.`);
      }
      if (sub === "claim") { if (!rest[1]) return bad; const t = await reg.tasks.claim(rest[1], who); return reply(t, `Task ${t.id} is yours: ${t.brief}\nparams: ${JSON.stringify(t.params)}`); }
      if (sub === "submit") { // an author's way to finish a write_variant task: only the subject is theirs, the rest comes from the task
        const subject = val(args, "--subject"), content = val(args, "--content");
        if (!rest[1] || (subject === undefined && content === undefined)) return bad;
        const ids = (flag: string) => val(args, flag)?.split(",").map((x) => x.trim()).filter(Boolean);
        const t = await reg.tasks.submitVariant(rest[1], { subject, content: content ? (JSON.parse(content) as Record<string, unknown>) : undefined, briefId: val(args, "--brief-id"), applies: ids("--applies"), tests: ids("--tests"), tags: val(args, "--tag") }, who);
        const r = t.result as { entry: string; subject: string; status: string; brief?: string };
        return reply(t, `Task ${t.id} done: entry ${r.entry} "${r.subject}" is in the calendar (${r.status}), written from brief ${r.brief ?? "?"}.`);
      }
      if (sub === "complete") { if (!rest[1]) return bad; const t = await reg.tasks.complete(rest[1], val(args, "--result") ? JSON.parse(val(args, "--result")!) : {}); return reply(t, `Task ${t.id} done.`); }
      const list = await reg.tasks.list(b.id, val(args, "--status"));
      return reply(list, list.map((t) => `${t.id}  ${t.status}${t.claimedBy ? " by " + t.claimedBy : ""}  ${t.kind}: ${t.brief}  ${JSON.stringify(t.params)}`).join("\n") || "No tasks.");
    }
    return bad;
  }

  /**
   * The editor's alarm clock (a bb automation every few hours): for each always-on campaign that opted in (setting editor.autoRun),
   * code decides who has work, and only then an agent thread is started. Prints nothing when nobody is due (a silent tick).
   */
  async function autorun(reg: Regulator, io: Io) {
    const host = deps.autorun;
    if (!host) return { exitCode: 1, stderr: "autorun needs the bb host (threads); it runs inside the plugin" };
    const lines: string[] = [];
    const started: { campaign: string; role: string; thread: string; reason: string }[] = [];
    for (const c of (await deps.core().campaigns.list()).filter((x) => x.kind === "always_on")) {
      if (!(await host.enabled(c.id))) continue;
      const [s, tasks, experiments] = await Promise.all([reg.signals(c.id), reg.tasks.list(c.id), reg.experiments.list(c.id)]);
      const due = whoIsDue(s, tasks, experiments);
      for (const role of ["editor", "author"] as const) {
        if (!due[role]) continue;
        const key = `autorun:${role}:${c.id}`, last = await host.lastRun(key);
        if (last !== null && Date.now() - last < AUTORUN_GAP_MS) continue;
        const prompt = role === "editor"
          ? `Run your editor loop once for the campaign "${c.name}" (use the editor skill). Be brief in your final answer.`
          : `Do the open tasks of the campaign "${c.name}" (use the author skill). Be brief in your final answer.`;
        const thread = await host.spawn(prompt, c.id);
        await host.setLastRun(key, Date.now());
        started.push({ campaign: c.name, role, thread, reason: due.reason });
        lines.push(`${c.name}: started the ${role} (thread ${thread}): ${due.reason}`);
      }
    }
    return io.reply(started, lines.join("\n"));
  }

  /** The development clock: lets a simulated provider and the rails live days in minutes. Only affects reports and simulated sends. */
  async function sim(action: string | undefined, args: string[], io: Io) {
    const reg = deps.regulator();
    if (!reg) return { exitCode: 1, stderr: "Not configured" };
    const step = io.positional(args.slice(2))[0];
    if (action === "advance") {
      if (!step) return { exitCode: 1, stderr: io.usage };
      const now = await reg.clock.advance(parseDuration(step));
      return io.reply({ now: now.toISOString() }, `Simulated time is now ${now.toISOString()}`);
    }
    if (action === "reset") { await reg.clock.reset(); return io.reply({ ok: true }, "Development clock back to real time."); }
    const now = await reg.clock.now();
    return io.reply({ now: now.toISOString(), offsetSeconds: Math.round((now.getTime() - Date.now()) / 1000) }, `Simulated time ${now.toISOString()} (real time plus ${Math.round((now.getTime() - Date.now()) / 3_600_000)} h)`);
  }
  return { editor, sim };
}
