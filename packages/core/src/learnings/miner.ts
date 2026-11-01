// The pattern miner: E2 learnings from many entries, where no experiment was run. Observational, so it is strict:
// enough entries on both sides, a significant pooled difference with a minimum lift, and the same direction in at least two months.
// Pure: observations in, candidate learnings out.
import { compareRates } from "../regulator/stats.ts";
import { relativeLift, type Lever, type Result } from "./domain.ts";

export type Observation = { entryId: string; sentAt: string; delivered: number; clicks: number; attributes: Record<string, string> };
export type Pattern = { lever: Lever; result: Result; effect: number; ciLow: number | null; ciHigh: number | null; p: number; units: number; months: number; nPerArm: number };

export const MINER = { minUnits: 10, minUnitsPerMonth: 3, minMonths: 2, significance: 0.05, minRelativeLift: 0.1 };

type Group = { units: number; delivered: number; clicks: number };
const add = (g: Group, o: Observation): Group => ({ units: g.units + 1, delivered: g.delivered + o.delivered, clicks: g.clicks + o.clicks });
const empty = (): Group => ({ units: 0, delivered: 0, clicks: 0 });

export function minePatterns(observations: Observation[], rules = MINER): Pattern[] {
  const keys = new Set(observations.flatMap((o) => Object.keys(o.attributes)));
  const out: Pattern[] = [];
  for (const key of keys) {
    const withKey = observations.filter((o) => o.attributes[key] !== undefined);
    const values = [...new Set(withKey.map((o) => o.attributes[key]))].sort();
    if (values.length < 2) continue;
    // with two values, one comparison says it all ("yes" against the rest, or the first value)
    const tested = values.length === 2 ? [values.includes("yes") ? "yes" : values[0]] : values;
    for (const v of tested) {
      const mine = withKey.filter((o) => o.attributes[key] === v), rest = withKey.filter((o) => o.attributes[key] !== v);
      if (mine.length < rules.minUnits || rest.length < rules.minUnits) continue;
      const a = rest.reduce(add, empty()), b = mine.reduce(add, empty());
      const cmp = compareRates(a.clicks, a.delivered, b.clicks, b.delivered);
      if (!(cmp.p < rules.significance) || cmp.lift === null || Math.abs(cmp.lift) < rules.minRelativeLift) continue;
      const byMonth = new Map<string, { a: Group; b: Group }>();
      for (const o of withKey) {
        const m = o.sentAt.slice(0, 7), cur = byMonth.get(m) ?? { a: empty(), b: empty() };
        byMonth.set(m, o.attributes[key] === v ? { ...cur, b: add(cur.b, o) } : { ...cur, a: add(cur.a, o) });
      }
      const months = [...byMonth.values()].filter((m) => m.a.units >= rules.minUnitsPerMonth && m.b.units >= rules.minUnitsPerMonth && m.a.delivered > 0 && m.b.delivered > 0);
      if (months.length < rules.minMonths) continue;
      const sign = Math.sign(cmp.lift);
      if (!months.every((m) => Math.sign(m.b.clicks / m.b.delivered - m.a.clicks / m.a.delivered) === sign)) continue;
      const ci = relativeLift(a.clicks, a.delivered, b.clicks, b.delivered);
      const from = values.length === 2 ? values.find((x) => x !== v)! : "other";
      out.push({ lever: { attribute: key, from, to: v }, result: cmp.lift > 0 ? "better" : "worse", effect: cmp.lift, ciLow: ci.low, ciHigh: ci.high, p: cmp.p, units: withKey.length, months: months.length, nPerArm: Math.min(a.delivered, b.delivered) });
    }
  }
  return out;
}
