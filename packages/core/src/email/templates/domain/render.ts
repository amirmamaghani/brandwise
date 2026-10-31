// The render pipeline. A pure function of its inputs (the ports do the outside work): same source, content, brand and target give
// the same result and the same hash.
//
//   content --validate--> bound slots (+ images resolved) --template--> MJML --compile--> HTML --dialect--> final HTML --lint--> report
import Mustache from "mustache";
import { createHash } from "node:crypto";
import { previewDialect, applyDialect } from "./dialect.ts";
import { lint } from "./lint.ts";
import type { AssetHost, Renderer } from "./ports.ts";
import { validateContent } from "./slots.ts";
import { escapeHtml, htmlToText } from "./text.ts";
import { PREVIEW, type Finding, type ImageValue, type Rendered, type TemplateSource, type Target } from "./types.ts";

// only the characters that matter in HTML text and attributes (Mustache's default also rewrites "/" and "=", which breaks URLs)
const MUSTACHE = { escape: (s: unknown) => escapeHtml(String(s)) } as unknown as Record<string, unknown>;

export async function renderTemplate(
  source: TemplateSource,
  content: Record<string, unknown>,
  deps: { renderer: Renderer; assets: AssetHost },
  target: Target,
): Promise<Rendered> {
  const preview = target.id === PREVIEW;
  const dialect = preview || !target.dialect ? previewDialect() : target.dialect;
  const { value, findings } = validateContent(source.config, content);
  const out: Finding[] = [...findings];

  // images: asset reference to the address the e-mail will use
  const view: Record<string, unknown> = { ...value, brand: source.brand };
  for (const [key, def] of Object.entries(source.config.slots)) {
    if (def.type !== "image" || !value[key]) continue;
    const img = value[key] as ImageValue;
    try {
      const r = await deps.assets.resolve(img.asset, preview);
      view[key] = { src: r.src, alt: img.alt, width: r.width, height: r.height };
    } catch (cause) {
      out.push({ rule: "image-hosted", severity: "error", message: `${key}: ${cause instanceof Error ? cause.message : String(cause)}` });
      delete view[key];
    }
  }

  const mjml = Mustache.render(source.mjml, view, undefined, MUSTACHE as never);
  const compiled = await deps.renderer.compile(mjml);
  for (const e of compiled.errors) out.push({ rule: "mjml", severity: "warn", message: `line ${e.line}: ${e.message}` });
  if (compiled.html === "") out.push({ rule: "mjml", severity: "error", message: "the template did not compile" });

  const html = applyDialect(compiled.html, dialect);
  const subject = applyDialect(String(value.subject ?? ""), dialect);
  const preheader = applyDialect(String(value.preheader ?? ""), dialect);
  const text = htmlToText(html);
  out.push(...lint({ html, text, subject, preheader, mjml: source.mjml, config: source.config, brand: source.brand, target: target.id, dialect }));

  const hash = createHash("sha256").update(JSON.stringify([source.mjml, source.config, source.brand, value, target.id])).digest("hex");
  return { html, text, subject, preheader, size: Buffer.byteLength(html), findings: out, target: target.id, hash };
}

export const hasErrors = (r: Rendered) => r.findings.some((x) => x.severity === "error");
