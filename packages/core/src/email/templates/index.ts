// Template service: working folders on disk, rendering, pictures. Wires the pure pipeline (domain/) to the file system and the adapters.
// A template is a folder `<root>/<campaign id>/<template id>/` with template.mjml, template.json (slot schema), brand.json, sample.json.
// Agents and people edit those files; everything here reads them fresh, so a preview always shows what is on disk.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeDialect } from "../domain/types.ts";
import type { Brand } from "./domain/types.ts";
import type { AssetHost, PreviewService, Renderer } from "./domain/ports.ts";
import { renderTemplate, hasErrors } from "./domain/render.ts";
import { PREVIEW, type Rendered, type TemplateConfig, type TemplateSource } from "./domain/types.ts";
import { SEED_BRAND, SEED_CONFIG, SEED_MJML, SEED_SAMPLE } from "./seed.ts";

/** Brand values of the template win over the kit's; objects merge key by key, everything else is replaced. */
export function mergeBrand(kit: Brand, own: Brand): Brand {
  const out: Record<string, unknown> = { ...kit };
  for (const [k, v] of Object.entries(own)) {
    const base = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base && typeof base === "object" && !Array.isArray(base) ? mergeBrand(base as Brand, v as Brand) : v;
  }
  return out as Brand;
}

export const TEMPLATE_FILES = ["template.mjml", "template.json", "brand.json", "sample.json"] as const;
export type TemplateFile = (typeof TEMPLATE_FILES)[number];
const ID = /^[a-z0-9-]{2,48}$/;
const MAX_FILE = 300_000;

export function createTemplates(deps: {
  root: () => string;
  renderer: () => Renderer;
  preview: () => PreviewService;
  assets: AssetHost;
  dialectOf: (providerId: string) => MergeDialect | null;
  /** The client's brand kit and components for a campaign (inherited down the campaign tree). Without it a template stands alone. */
  resolve?: (campaignId: string) => Promise<{ brand: Brand; partials: Record<string, string>; hasKit: boolean }>;
}) {
  /** The folder of a template; ids are checked so a name can never leave the root. */
  const dir = (campaignId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(campaignId) || !ID.test(id)) throw new Error("invalid campaign or template id");
    return join(deps.root(), campaignId, id);
  };
  const readJson = (file: string, what: string, fallback?: unknown) => {
    if (!existsSync(file)) { if (fallback !== undefined) return fallback; throw new Error(`${what} is missing`); }
    try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`${what} is not valid JSON: ${(e as Error).message}`); }
  };

  function load(campaignId: string, id: string): TemplateSource & { hash: string } {
    const d = dir(campaignId, id);
    if (!existsSync(join(d, "template.mjml"))) throw new Error(`Template ${id} does not exist (start one with: bb brandwise email template seed ${id})`);
    for (const f of TEMPLATE_FILES) if (existsSync(join(d, f)) && statSync(join(d, f)).size > MAX_FILE) throw new Error(`${f} is over ${MAX_FILE / 1000} KB`);
    const mjml = readFileSync(join(d, "template.mjml"), "utf8");
    const config = readJson(join(d, "template.json"), "template.json") as TemplateConfig;
    if (typeof config?.slots !== "object" || config.slots === null) throw new Error('template.json needs a "slots" object');
    const brand = readJson(join(d, "brand.json"), "brand.json", {}) as TemplateSource["brand"];
    const sample = readJson(join(d, "sample.json"), "sample.json", {}) as Record<string, unknown>;
    const hash = createHash("sha256").update(JSON.stringify([mjml, config, brand, sample])).digest("hex");
    return { mjml, config, brand, sample, hash };
  }

  return {
    dir,
    list(): { campaignId: string; id: string }[] {
      const root = deps.root();
      if (!existsSync(root)) return [];
      return readdirSync(root).filter((c) => /^[0-9a-f-]{36}$/.test(c)).flatMap((campaignId) =>
        readdirSync(join(root, campaignId)).filter((id) => existsSync(join(root, campaignId, id, "template.mjml"))).map((id) => ({ campaignId, id })));
    },
    /** A new template folder with the starter template. Never overwrites. */
    async seed(campaignId: string, id: string): Promise<string> {
      const d = dir(campaignId, id);
      const kit = await deps.resolve?.(campaignId);
      if (existsSync(d) && readdirSync(d).length > 0) throw new Error(`Template ${id} already exists`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "template.mjml"), SEED_MJML);
      writeFileSync(join(d, "template.json"), JSON.stringify(SEED_CONFIG, null, 2) + "\n");
      // with a brand kit the template starts without brand values of its own and inherits the client's; without one it carries a starter brand
      writeFileSync(join(d, "brand.json"), JSON.stringify(kit?.hasKit ? {} : SEED_BRAND, null, 2) + "\n");
      writeFileSync(join(d, "sample.json"), JSON.stringify(SEED_SAMPLE, null, 2) + "\n");
      return d;
    },
    load,
    /** What is on disk now: a hash that changes with any of the files, and the file names. The preview page polls it. */
    state(campaignId: string, id: string) {
      const d = dir(campaignId, id);
      const files = TEMPLATE_FILES.filter((f) => existsSync(join(d, f)));
      return { hash: createHash("sha256").update(files.map((f) => readFileSync(join(d, f))).join("\u0000")).digest("hex"), files };
    },
    file(campaignId: string, id: string, name: string): string {
      if (!(TEMPLATE_FILES as readonly string[]).includes(name)) throw new Error(`Not a template file: ${name}`);
      const p = join(dir(campaignId, id), name);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    },
    /** A person's edit from the page. Agents write the files themselves. JSON files must stay valid. */
    saveFile(campaignId: string, id: string, name: string, content: string) {
      if (!(TEMPLATE_FILES as readonly string[]).includes(name)) throw new Error(`Not a template file: ${name}`);
      if (content.length > MAX_FILE) throw new Error(`${name} is over ${MAX_FILE / 1000} KB`);
      if (name.endsWith(".json")) JSON.parse(content);
      writeFileSync(join(dir(campaignId, id), name), content);
    },
    /** Render the template with its sample content (or the given content) for a target: "preview" or a provider id. */
    async render(campaignId: string, id: string, opts: { target?: string; content?: Record<string, unknown>; locale?: string } = {}): Promise<Rendered> {
      const src = load(campaignId, id);
      const target = opts.target ?? PREVIEW;
      const dialect = target === PREVIEW ? null : deps.dialectOf(target);
      if (target !== PREVIEW && !dialect) throw new Error(`Unknown or unconfigured e-mail provider "${target}"`);
      const r = await deps.resolve?.(campaignId);
      const source: TemplateSource = { ...src, brand: mergeBrand(r?.brand ?? {}, src.brand), partials: r?.partials ?? {} };
      return renderTemplate(source, opts.content ?? src.sample, { renderer: deps.renderer(), assets: deps.assets }, { id: target, dialect }, opts.locale);
    },
    /** A PNG of the preview render, for an agent (or a person) to look at. */
    async picture(campaignId: string, id: string, opts: { width?: number } = {}): Promise<{ png: Uint8Array; rendered: Rendered }> {
      const rendered = await this.render(campaignId, id);
      const width = Math.min(Math.max(opts.width ?? 640, 320), 1200);
      return { png: await deps.preview().screenshot(rendered.html, { width }), rendered };
    },
  };
}
export type Templates = ReturnType<typeof createTemplates>;
export { hasErrors };
