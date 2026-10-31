// Lint rules: small deterministic checks of a rendered e-mail. An `error` blocks approval, a `warn` is shown, an `info` is a hint.
// A rule gets everything it may need and returns findings; adding a rule is adding a function to RULES.
import type { MergeDialect } from "../../domain/types.ts";
import { contrast } from "./color.ts";
import { tokensIn } from "./dialect.ts";
import type { Brand, Finding, TemplateConfig } from "./types.ts";

export type LintContext = {
  html: string;
  text: string;
  subject: string;
  preheader: string;
  /** The MJML source of the template, to check how it was written. */
  mjml: string;
  config: TemplateConfig;
  brand: Brand;
  /** preview, or the provider id the e-mail is rendered for. */
  target: string;
  dialect: MergeDialect;
};

const f = (rule: string, severity: Finding["severity"], message: string): Finding => ({ rule, severity, message });
const GMAIL_CLIP = 102_000;
const SPAM = ["act now", "100% free", "click here", "winner", "guarantee", "risk-free", "buy now", "urgent", "!!!"];

const hrefs = (html: string) => [...html.matchAll(/<a\s[^>]*href="([^"]*)"/gi)].map((m) => m[1]);
const imgs = (html: string) => [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];

export const RULES: ((c: LintContext) => Finding[])[] = [
  (c) => (c.subject.trim() === "" ? [f("subject", "error", "the subject is empty")] : c.subject.length > 70 ? [f("subject", "warn", `the subject is ${c.subject.length} characters, mail apps cut it around 60 to 70`)] : []),
  (c) => (c.preheader.trim() === "" ? [f("preheader", "warn", "no preheader text (the preview line after the subject)")] : !/<mj-preview/i.test(c.mjml) ? [f("preheader", "warn", "the template has no <mj-preview>, so the preheader is not shown")] : []),
  (c) => (c.html.includes(c.dialect.unsubscribe) ? [] : [f("unsubscribe", "error", "no unsubscribe link: put [[unsubscribe_url]] in the footer")]),
  (c) => {
    const address = c.brand.footer?.address?.trim();
    if (!address) return [f("footer-address", "error", "the brand has no postal address in footer.address (required for marketing e-mail)")];
    return c.html.includes(address.replace(/&/g, "&amp;")) || c.html.includes(address) ? [] : [f("footer-address", "error", "the postal address of the brand is not in the e-mail: use {{brand.footer.address}} in the footer")];
  },
  (c) => {
    const size = Buffer.byteLength(c.html);
    return size > GMAIL_CLIP ? [f("size", "error", `the HTML is ${Math.round(size / 1000)} KB; Gmail clips messages over about 102 KB and hides the unsubscribe link`)] : size > 90_000 ? [f("size", "warn", `the HTML is ${Math.round(size / 1000)} KB, close to the 102 KB Gmail clips at`)] : [];
  },
  (c) => (c.text.trim() === "" ? [f("plain-text", "warn", "the plain-text part is empty")] : []),
  (c) => (/<(script|form|iframe|object|embed)\b/i.test(c.html) ? [f("forbidden-tags", "error", "scripts, forms, iframes and embeds do not belong in an e-mail")] : []),
  (c) => imgs(c.html).flatMap((tag) => {
    const out: Finding[] = [];
    const src = attr(tag, "src") ?? "";
    if (attr(tag, "alt") === undefined) out.push(f("image-alt", "error", `an image has no alt attribute (${src.slice(0, 40)})`));
    else if (attr(tag, "alt") === "" && !/width="1"|height="1"/.test(tag)) out.push(f("image-alt", "warn", `an image has empty alt text (${src.slice(0, 40)})`));
    if (!/\bwidth\s*=/.test(tag) && !/width:/i.test(tag)) out.push(f("image-width", "warn", `an image has no width (${src.slice(0, 40)})`));
    const hosted = /^https:\/\//i.test(src) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(src);
    if (!hosted) out.push(c.dialect.hostedImagesRequired && c.target !== "preview"
      ? f("image-hosted", "error", `an image is not on a public https address, it would not load in the reader's mail app (${src.slice(0, 40)})`)
      : f("image-hosted", "info", "an image is inlined for the preview; it needs a public address before a real send"));
    return out;
  }),
  (c) => {
    const allowed = c.brand.allowedLinkDomains?.map((d) => d.toLowerCase()) ?? [];
    return hrefs(c.html).flatMap((h) => {
      if (h.startsWith("#") || h.startsWith("mailto:") || h.startsWith("tel:") || h.includes("{{") || h.includes("[[")) return [];
      if (!/^https:\/\//i.test(h)) return [f("links", /^http:\/\//i.test(h) ? "warn" : "error", `a link is not https: ${h.slice(0, 60)}`)];
      const host = new URL(h).hostname.toLowerCase();
      return allowed.length > 0 && !allowed.some((d) => host === d || host.endsWith(`.${d}`)) ? [f("links", "error", `a link points outside the allowed domains (${host})`)] : [];
    });
  },
  (c) => tokensIn(c.mjml).filter((t) => t.field !== "unsubscribe_url" && !t.fallback).map((t) => f("merge-fallback", "warn", `[[${t.field}]] has no fallback: write [[${t.field}|there]] so an empty field does not leave a hole`)),
  (c) => {
    const raw = [...c.mjml.matchAll(/\{\{\{\s*([\w.]+)\s*\}\}\}/g)].map((m) => m[1]).filter((name) => c.config.slots[name]?.type !== "richtext-lite" && !name.startsWith("brand."));
    return raw.map((n) => f("raw-slot", "error", `{{{${n}}}} prints a slot without escaping; only richtext-lite slots may be written with three braces`));
  },
  (c) => {
    const colors = c.brand.colors ?? {};
    const pairs: [string, string | undefined, string, string][] = [
      ["text", colors.text, "#ffffff", "the text colour on the white card"],
      ["text", colors.text, colors.background ?? "", "the text colour on the page background"],
      ["primary", "#ffffff", colors.primary ?? "", "white button text on the primary colour"],
    ];
    return pairs.flatMap(([, fg, bg, what]) => {
      const ratio = fg && bg ? contrast(fg, bg) : null;
      return ratio !== null && ratio < 4.5 ? [f("contrast", "warn", `${what} has a contrast of ${ratio.toFixed(1)}:1; accessibility asks for 4.5:1`)] : [];
    });
  },
  (c) => SPAM.filter((w) => c.subject.toLowerCase().includes(w)).map((w) => f("spam-words", "warn", `the subject contains "${w}", a phrase spam filters dislike`)),
];

export const lint = (c: LintContext): Finding[] => RULES.flatMap((rule) => rule(c));
