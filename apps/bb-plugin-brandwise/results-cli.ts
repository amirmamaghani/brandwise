// CLI of results: `bb brandwise results costs|formats|production|economics`. Read-only for everyone who calls the CLI (agents included):
// setting the economics profile and stating costs are a person's actions on the Results page.
import type { Core } from "./core/index.ts";
import type { Economics } from "./core/economics/index.ts";

type Io = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };
const money = (v: number | null, currency: string | null) => (v === null ? "n/a" : `${v.toFixed(2)}${currency ? ` ${currency}` : ""}`);
const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(100 * v)} %`);

export function createResultsCli(deps: { core: () => Core; economics: () => Economics }) {
  async function results(action: string | undefined, args: string[], io: Io) {
    const c = await deps.core().campaigns.resolve(io.val(args, "--campaign"));
    const since = io.val(args, "--since");
    const days = since ? Number(/^(\d+)d$/.exec(since)?.[1] ?? NaN) : undefined;
    if (since && !Number.isFinite(days)) return { exitCode: 1, stderr: "Give --since as days, e.g. 30d" };
    const e = deps.economics();
    if (action === "costs") {
      const r = await e.costs(c.id, { sinceDays: days });
      return io.reply(r, [
        `${r.campaign}: ${r.since.slice(0, 10)}..${r.until.slice(0, 10)}, total ${money(r.total, r.currency)}${r.partial.length ? ` (not priced yet: ${r.partial.join(", ")})` : ""}`,
        ...r.rows.map((x) => `  ${x.kind.padEnd(13)} ${money(x.money, r.currency).padStart(14)}  ${x.detail}`),
        ...r.needs.map((n) => `Needs: ${n}`),
      ].join("\n"));
    }
    if (action === "formats") {
      const rows = await e.formats(c.id, { sinceDays: days });
      return io.reply(rows, rows.map((f) => `${f.format.padEnd(28)} ${String(f.generations).padStart(3)} generated (${f.failed} failed)  ${f.approvedAssets} approved (${pct(f.approvedShare)} of done)  per approved asset ${f.costPerApprovedAsset === null ? "n/a" : f.costPerApprovedAsset.toFixed(2)}`).join("\n") || "No generations in the window.");
    }
    if (action === "production") {
      const p = await e.production(c.id, { sinceDays: days });
      return io.reply(p, [
        `${p.entries} reviewed entries (tier 2 and 3), ${p.decided} decided: first-pass approval ${pct(p.firstPassRate)}, send-backs per entry ${p.sendBacksPerEntry?.toFixed(2) ?? "n/a"}, median hours to approval ${p.medianHoursToApproval?.toFixed(1) ?? "n/a"}`,
        `Send-back reasons: ${Object.entries(p.reasons).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
      ].join("\n"));
    }
    if (action === "economics") {
      const x = await e.economics(c.id);
      return io.reply(x, [
        x.profile ? `Profile (${x.profile.model}, ${x.profile.currency}) set by ${x.setBy} from ${x.validFrom?.slice(0, 10)}` : "No economics profile: a person sets it on the Results page (Economics).",
        ...x.derived.map((d) => `  ${d.name.padEnd(26)} ${d.value === null ? `needs: ${d.needs.join(", ")}` : d.value.toFixed(2)}   (${d.formula})`),
      ].join("\n"));
    }
    return { exitCode: 1, stderr: io.usage };
  }
  return { results };
}
