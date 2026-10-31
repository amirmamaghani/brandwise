// The hidden "world" of the simulated provider: how real recipients would react to an e-mail. It exists so the whole control loop can
// be tested in minutes, deterministically. The editor agent never sees these numbers, only the events they produce; tests use
// `expectedRates` as the oracle for "which variant is truly better".
//
// Built-in traps on purpose: urgency and ALL CAPS raise opens but also complaints (Goodhart: a goal on opens or clicks alone would
// reward clickbait that damages the list), and a content-independent share of opens comes from privacy proxies (machine opens).
import { createHash } from "node:crypto";

export type Features = { length: number; question: boolean; number: boolean; personal: boolean; urgency: boolean; caps: boolean; exclamations: number; emoji: number; links: number; shortBody: boolean; ctaAction: boolean; list: boolean };

const URGENCY = /\b(last chance|hurry|today only|urgent|don'?t miss|ends tonight|final hours|act now)\b/i;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function features(subject: string, body: string): Features {
  return {
    length: subject.length,
    question: subject.includes("?"),
    number: /\d/.test(subject),
    personal: /\{\{\s*\w+\s*\}\}/.test(subject),
    urgency: URGENCY.test(subject),
    caps: /\b[A-Z]{4,}\b/.test(subject),
    exclamations: (subject.match(/!/g) ?? []).length,
    emoji: (subject.match(/\p{Extended_Pictographic}/gu) ?? []).length,
    links: (body.match(/https?:\/\//g) ?? []).length,
    shortBody: body.replace(/<[^>]+>/g, "").length < 600,
    // the label of the first link, when it starts with an action verb ("Start now", "Get the guide")
    ctaAction: /^(start|get|join|try|book|claim|download|learn|see how)\b/i.test((/<a\s[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(body)?.[1] ?? "").replace(/<[^>]+>/g, "").trim()),
    list: /<li\b/i.test(body),
  };
}

/** True per-recipient probabilities for this e-mail (among delivered recipients unless said otherwise). */
export function expectedRates(subject: string, body: string) {
  const f = features(subject, body);
  const openLogit = -1.2 + (f.personal ? 0.35 : 0) + (f.question ? 0.3 : 0) + (f.number ? 0.25 : 0) + (f.urgency ? 0.5 : 0)
    - (f.caps ? 0.25 : 0) - (f.exclamations > 1 ? 0.15 : 0) + (f.emoji === 1 ? 0.15 : 0) - 0.012 * Math.abs(f.length - 42);
  const open = sigmoid(openLogit);
  const clickGivenOpen = sigmoid(-2.2 + (f.links >= 1 ? 0.5 : 0) + (f.number ? 0.15 : 0) + (f.shortBody ? 0.2 : 0) + (f.ctaAction ? 0.3 : 0) + (f.list ? 0.1 : 0) - (f.urgency ? 0.2 : 0));
  return {
    open,
    clickGivenOpen,
    click: open * clickGivenOpen,                                        // unique clicks per delivered recipient: the metric the loop is judged on
    complaint: 0.0004 + (f.urgency ? 0.006 : 0) + (f.caps ? 0.002 : 0),   // per delivered
    unsubscribe: 0.002 + (f.urgency ? 0.004 : 0),                         // per delivered
    machineOpen: 0.2,                                                     // per delivered, content-independent
    delivered: 0.98,
  };
}

/** Deterministic uniform number in [0, 1) for (seed, parts): the same send always produces the same events. */
export function uniform(...parts: (string | number)[]): number {
  const h = createHash("sha256").update(parts.join("|")).digest();
  return h.readUIntBE(0, 6) / 2 ** 48;
}
/** Exponential draw with the given mean, capped. */
export const expo = (u: number, mean: number, cap: number) => Math.min(cap, -mean * Math.log(1 - u));
