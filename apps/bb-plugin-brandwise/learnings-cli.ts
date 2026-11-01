// CLI of learnings: `bb brandwise brief ...` and `bb brandwise learnings ...`. The logic lives in packages/core/src/learnings;
// this file parses arguments and prints. Confirming a reviewer preference and retiring a learning are a person's actions and exist
// only in the UI (RPC learning_set_status), not here: the CLI is what agents call.
import type { Core } from "./core/index.ts";
import type { Learnings } from "./core/learnings/index.ts";

type Io = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };
type Listed = Awaited<ReturnType<Learnings["list"]>>[number];

const ids = (v: string | undefined) => v?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
const fmt = (l: Listed) => `${l.id}  ${(l.evidence ?? "rule").padEnd(4)} ${l.kind.padEnd(19)} ${l.effectiveStatus.padEnd(12)} ${l.scope.padEnd(8)} ${l.statement}`;

export function createLearningsCli(deps: { core: () => Core; learnings: () => Learnings | null }) {
  async function brief(args: string[], io: Io) {
    const l = deps.learnings();
    if (!l) return { exitCode: 1, stderr: "Learnings need the database: run infra/bb-instance/provision.sh apply" };
    const c = await deps.core().campaigns.resolve(io.val(args, "--campaign"));
    const at = io.val(args, "--at");
    const b = await l.brief({ campaignId: c.id, channel: io.val(args, "--channel") ?? null, day: at ? new Date(at).toISOString().slice(0, 10) : undefined, createdBy: io.val(args, "--as") ?? "agent" });
    return io.reply({ id: b.id, ...b.payload }, b.text);
  }

  async function learnings(action: string | undefined, args: string[], io: Io) {
    const l = deps.learnings();
    if (!l) return { exitCode: 1, stderr: "Learnings need the database: run infra/bb-instance/provision.sh apply" };
    const { val, positional, reply, usage } = io;
    const rest = positional(args.slice(2));
    const who = val(args, "--as")?.trim() || "agent";
    if (["ui", "auto", "scheduler", "regulator", "miner", "promotion"].includes(who.toLowerCase())) return { exitCode: 1, stderr: `--as ${who} is reserved: it names a person on a page or the system` };
    const campaign = async () => deps.core().campaigns.resolve(val(args, "--campaign"));

    if (action === "list") {
      const rows = await l.list((await campaign()).id, { status: val(args, "--status"), kind: val(args, "--kind"), evidence: val(args, "--evidence") });
      return reply(rows, rows.map(fmt).join("\n") || "No learnings yet.");
    }
    if (action === "show") {
      if (!rest[0]) return { exitCode: 1, stderr: usage };
      const x = await l.get(rest[0]);
      if (!x) return { exitCode: 1, stderr: `No learning ${rest[0]}` };
      return reply(x, JSON.stringify(x, null, 2));
    }
    if (action === "add") { // an agent's observation: E3, a test candidate only
      const statement = rest.join(" ");
      if (!statement) return { exitCode: 1, stderr: usage };
      if (val(args, "--evidence") && val(args, "--evidence") !== "E3") return { exitCode: 1, stderr: "Agents add E3 observations only: E1 comes from experiments, E2 from the pattern miner" };
      const x = await l.addObservation({ campaignId: (await campaign()).id, statement, lever: val(args, "--lever"), channel: val(args, "--channel") ?? null, createdBy: who });
      return reply(x, `Learning ${x.id} added as E3 (a candidate to test, not evidence).`);
    }
    if (action === "propose-preference") {
      const rule = rest.join(" ");
      if (!rule) return { exitCode: 1, stderr: usage };
      const x = await l.proposePreference({ campaignId: (await campaign()).id, rule, fromEntries: ids(val(args, "--from-entries")), createdBy: who });
      return reply(x, `Preference ${x.id} proposed; it is in force once a person confirms it on the Results page (Learnings).`);
    }
    if (action === "confirm" || action === "retire") { // a person's actions: only on the Results page, never from the CLI an agent can call
      return { exitCode: 1, stderr: "Confirming or retiring a learning is a person's action: do it on the Results page (Learnings)." };
    }
    if (action === "mine") { // automation: silent when nothing is new
      const bases = val(args, "--campaign") ? [await campaign()] : (await deps.core().campaigns.list()).filter((c) => c.kind === "always_on");
      const created = (await Promise.all(bases.map((b) => l.mine(b.id)))).flat();
      return reply(created, created.map((x) => `new ${x.evidence} ${x.id}: ${x.statement}`).join("\n"));
    }
    return { exitCode: 1, stderr: usage };
  }
  return { brief, learnings };
}
