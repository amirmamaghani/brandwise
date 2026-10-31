// E-mail templates in the plugin: working folders per campaign, live preview, lint, pictures and test sends, for the E-mail page, the
// CLI and the agents. Server only; the pure pipeline and the adapters live in packages/core/src/email/templates, server.ts wires this in.
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSpec } from "./agents.ts";
import type { Core } from "./core/index.ts";
import type { createEmail } from "./core/email/index.ts";
import { assetHost } from "./core/email/templates/adapters/asset-host.ts";
import { fetchLinkChecker } from "./core/email/templates/adapters/fetch-link-checker.ts";
import { checkLinks } from "./core/email/templates/domain/links.ts";
import { createLibrary, type Library } from "./core/email/templates/library.ts";
import { chromePreview } from "./core/email/templates/adapters/chrome-preview.ts";
import { mjmlProcess } from "./core/email/templates/adapters/mjml-process.ts";
import { createTemplates, TEMPLATE_FILES } from "./core/email/templates/index.ts";
import type { Rendered } from "./core/email/templates/domain/types.ts";

type Email = ReturnType<typeof createEmail>;
const ID = /^[a-z0-9-]{2,48}$/;
const ref = { campaignId: z.string(), id: z.string() };
const finding = z.object({ rule: z.string(), severity: z.enum(["error", "warn", "info"]), message: z.string() });

export const templatesContract = {
  email_templates: { input: z.null(), output: z.object({ enabled: z.boolean(), templates: z.array(z.object(ref)) }) },
  email_template_create: { input: z.object({ campaignId: z.string(), id: z.string().regex(ID) }), output: z.object({ ok: z.boolean() }) },
  /** What is on disk now; the page polls this and renders again when the hash changes. */
  email_template_state: { input: z.object(ref), output: z.object({ hash: z.string(), files: z.array(z.string()) }) },
  email_template_render: {
    input: z.object({ ...ref, target: z.string().optional() }),
    output: z.object({ html: z.string(), subject: z.string(), preheader: z.string(), size: z.number(), hash: z.string(), findings: z.array(finding) }),
  },
  email_template_file: { input: z.object({ ...ref, name: z.string() }), output: z.object({ content: z.string() }) },
  email_template_save: { input: z.object({ ...ref, name: z.string(), content: z.string().max(300_000) }), output: z.object({ ok: z.boolean() }) },
  email_template_versions: { input: z.object(ref), output: z.object({ versions: z.array(z.object({ version: z.number(), note: z.string().nullable(), createdBy: z.string(), createdAt: z.string() })) }) },
  email_template_publish: { input: z.object({ ...ref, note: z.string().max(200).optional() }), output: z.object({ version: z.number(), created: z.boolean() }) },
  /** The snapshot an e-mail entry was approved on, for the approval card: what the reader will see, and what lint said. */
  email_entry_preview: {
    input: z.object({ entryId: z.string() }),
    output: z.object({ bound: z.boolean(), subject: z.string(), preheader: z.string(), html: z.string(), findings: z.array(finding), template: z.string(), version: z.number(), locale: z.string(), hash: z.string() }),
  },
  email_template_send_test: { input: z.object({ ...ref, to: z.string().email(), provider: z.string().optional() }), output: z.object({ provider: z.string(), from: z.string() }) },
};
type In<K extends keyof typeof templatesContract> = z.infer<(typeof templatesContract)[K]["input"]>;

type Io = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };

export function createEmailTemplates(deps: { need: () => Core; email: () => Email | null; enginePath: () => string; chromePath: () => string; videoEnginePath: () => string; /** The public image bucket, or null until one exists. */ publicAssets: () => { bucket: string; baseUrl: string } | null }) {
  const root = () => process.env.BW_EMAIL_TEMPLATES_DIR || path.join(os.homedir(), ".bb-brandwise", "email-templates");
  const engine = () => deps.enginePath() || process.env.BW_EMAIL_ENGINE_DIR || "";
  const enabled = () => engine() !== "" && fs.existsSync(path.join(engine(), "node_modules", "mjml"));

  const dialectOf = (id: string) => deps.email()?.providers.find((p) => p.id === id)?.dialect ?? null;

  const templateAssets = assetHost({
    read: async (id) => { const c = deps.need(); const a = await c.assets.get(id).catch(() => null); return a ? { bytes: await c.assets.read(id), mime: a.mime } : null; },
    // stored images go to the public bucket when there is one; without it a real send with a stored image is refused, previews inline it
    publish: async (id) => {
      const pub = deps.publicAssets();
      if (!pub) throw new Error(`asset ${id} has no public address yet: set the public bucket (publicAssetBucket and publicAssetBaseUrl in the settings) or use an https:// address`);
      return deps.need().assets.publishPublic(id, pub);
    },
  });
  const templates = createTemplates({
    root,
    renderer: () => mjmlProcess(engine()),
    preview: () => chromePreview({ enginePath: engine(), chromePath: deps.chromePath(), videoEnginePath: deps.videoEnginePath() }),
    assets: templateAssets,
    dialectOf,
    resolve: (campaignId) => library().resolve(campaignId),
  });
  let cached: { core: Core; lib: Library } | null = null;
  /** The library follows the core: a new database setting builds a new core, and the library with it. */
  function library(): Library {
    const core = deps.need();
    if (!cached || cached.core !== core) cached = { core, lib: createLibrary({ pool: core.pool, core, templates, renderer: () => mjmlProcess(engine()), assets: templateAssets, dialectOf }) };
    return cached.lib;
  }

  const out = (r: Rendered) => ({ html: r.html, subject: r.subject, preheader: r.preheader, size: r.size, hash: r.hash, findings: r.findings });
  const summary = (r: Rendered) => {
    const n = (s: string) => r.findings.filter((f) => f.severity === s).length;
    return `${r.subject ? `"${r.subject}"` : "(no subject)"}  ${(r.size / 1000).toFixed(1)} KB  ${n("error")} error(s), ${n("warn")} warning(s), ${n("info")} hint(s)`;
  };
  const listFindings = (r: Rendered) => r.findings.map((f) => `  ${f.severity.toUpperCase().padEnd(5)} ${f.rule}: ${f.message}`).join("\n");

  /** Briefing of the agent for the E-mail page; `subPath` is "<campaign id>/<template id>". */
  async function agentContext(subPath: string): Promise<AgentSpec | null> {
    const [campaignId, id] = subPath.split("/").map(decodeURIComponent);
    if (!campaignId || !id) return null;
    const dir = templates.dir(campaignId, id);
    const campaign = (await deps.need().campaigns.list()).find((x) => x.id === campaignId);
    return {
      key: `email/${campaignId}/${id}`, cwd: fs.existsSync(dir) ? dir : null, campaignId,
      prompt: [
        "You are the BrandWise e-mail template agent. You work through the `bb brandwise` CLI, following the brandwise skill (E-mail templates). Agents never approve content and never publish. Reply in the language the user writes in.",
        `The user is on the E-mail screen with the template "${id}" of the campaign "${campaign?.name ?? campaignId}" (id ${campaignId}) open. It is the folder ${dir}: template.mjml (the layout, MJML), template.json (the slots: what content the template takes), brand.json (colours, fonts, footer), sample.json (example content). They see a live preview next to this chat and every change you make to the files shows up there.`,
        `Edit the files. Slots are written {{slot}} (escaped; {{{slot}}} only for richtext-lite slots), merge tags [[first_name|there]] and [[unsubscribe_url]]. Keep the unsubscribe link and the postal address in the footer. Images need an https address. Check your work with \`bb brandwise email template lint ${id} --campaign ${campaignId}\` and look at it with \`email template preview ${id} --campaign ${campaignId}\`: open the PNG it prints and look at the picture before you report anything as done.`,
        "For now just read the template, say in one sentence what it is, and wait for instructions.",
      ].join("\n\n"),
    };
  }

  const rpc = {
    email_templates: async () => ({ enabled: enabled(), templates: templates.list() }),
    email_template_create: async ({ campaignId, id }: In<"email_template_create">) => {
      await deps.need().campaigns.resolve(campaignId);
      await templates.seed(campaignId, id);
      return { ok: true };
    },
    // a template that is gone or not valid has an empty state, so a page that keeps polling it does not fill the log with errors
    email_template_state: async ({ campaignId, id }: In<"email_template_state">) => { try { return templates.state(campaignId, id); } catch { return { hash: "", files: [] as string[] }; } },
    email_template_render: async ({ campaignId, id, target }: In<"email_template_render">) => out(await templates.render(campaignId, id, { target })),
    email_template_file: async ({ campaignId, id, name }: In<"email_template_file">) => ({ content: templates.file(campaignId, id, name) }),
    email_template_save: async ({ campaignId, id, name, content }: In<"email_template_save">) => { templates.saveFile(campaignId, id, name, content); return { ok: true }; },
    email_template_send_test: async ({ campaignId, id, to, provider }: In<"email_template_send_test">) => sendTest(campaignId, id, to, provider),
    email_template_versions: async ({ campaignId, id }: In<"email_template_versions">) => ({ versions: (await library().versions.list(campaignId, id)).map((v) => ({ version: v.version, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt })) }),
    email_template_publish: async ({ campaignId, id, note }: In<"email_template_publish">) => { const r = await library().versions.publish(campaignId, id, "ui", note); return { version: r.version.version, created: r.created }; },
    email_entry_preview: async ({ entryId }: In<"email_entry_preview">) => {
      const b = await library().entries.get(entryId);
      if (!b) return { bound: false, subject: "", preheader: "", html: "", findings: [], template: "", version: 0, locale: "", hash: "" };
      return { bound: true, subject: b.render.subject, preheader: b.render.preheader, html: b.render.html, findings: b.render.findings, template: b.version.templateId, version: b.version.version, locale: b.locale, hash: b.render.hash };
    },
  };

  /** One test e-mail through a provider, from the sender of the campaign's e-mail target. Lint errors do not stop it: it is for looking. */
  async function sendTest(campaignId: string, id: string, to: string, providerId?: string) {
    const email = deps.email();
    if (!email) throw new Error("E-mail is not configured");
    const target = (await deps.need().channels.get(campaignId, "email")) ?? {};
    const provider = email.providers.find((p) => p.id === (providerId ?? target.provider) && p.sender?.sendTest);
    if (!provider?.sender?.sendTest) throw new Error(`No e-mail provider that can send a test${providerId ?? target.provider ? ` named "${providerId ?? target.provider}"` : " (name one with --provider, or set provider= in the campaign's e-mail target)"}`);
    if (!target.from) throw new Error("The campaign's e-mail target has no from= (campaign channel set email provider=... from=\"Name <a@b.c>\")");
    const r = await templates.render(campaignId, id);
    await provider.sender.sendTest({ from: target.from, to, subject: `[TEST] ${r.subject}`, html: r.html, text: r.text });
    return { provider: provider.id, from: target.from };
  }

  const json = (text: string | undefined, what: string): Record<string, unknown> => {
    try { const v = JSON.parse(text ?? ""); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* falls through */ }
    throw new Error(`${what} must be a JSON object`);
  };
  /** The CLI runs inside the plugin and does not see the caller's working directory, so a file must be given by its full path. */
  const readFile = (file: string) => {
    if (!path.isAbsolute(file)) throw new Error(`${file}: give the full path of the file (this command cannot see your working directory)`);
    if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
    return fs.readFileSync(file, "utf8");
  };
  const contentOf = (args: string[], val: Io["val"]) => {
    const file = val(args, "--content-file");
    return json(file ? readFile(file) : val(args, "--content"), "--content (or --content-file)");
  };

  /** `bb brandwise email <template|brand|component|entry> ...` */
  async function cli(args: string[], { val, positional, reply, usage }: Io) {
    const bad = { exitCode: 1, stderr: usage };
    const area = args[1];                                  // args = ["email", area, sub, id, ...flags]
    const [sub, id] = positional(args.slice(2));
    const c = deps.need();
    const lib = () => library();
    const campaign = async () => (await c.campaigns.resolve(val(args, "--campaign"))).id;
    const showBinding = (b: Awaited<ReturnType<Library["entries"]["get"]>> & {}) =>
      `entry ${b.entryId}: template ${b.version.templateId} version ${b.version.version}, locale ${b.locale}, snapshot ${b.render.hash.slice(0, 12)}\ncontent: ${JSON.stringify(b.content)}\n"${b.render.subject}"  ${(b.render.size / 1000).toFixed(1)} KB (the rendered HTML is the entry body, see calendar list --json)\n${b.render.findings.map((f) => `  ${f.severity.toUpperCase().padEnd(5)} ${f.rule}: ${f.message}`).join("\n") || "  no findings"}`;

    if (area === "brand") {
      const campaignId = await campaign();
      if (sub === "set") {
        const file = val(args, "--file");
        await lib().brand.set(campaignId, json(file ? readFile(file) : val(args, "--brand"), "--brand (or --file)"));
      }
      const own = await lib().brand.own(campaignId);
      const resolved = await lib().brand.resolve(campaignId);
      return reply({ own, resolved: resolved.brand }, `Own brand kit${own ? ` (version ${own.version})` : ""}: ${own ? JSON.stringify(own.brand, null, 2) : "none, this campaign inherits"}\nIn effect here (inherited and merged): ${JSON.stringify(resolved.brand, null, 2)}`);
    }
    if (area === "component") {
      const campaignId = await campaign();
      if (sub === "set") {
        const file = val(args, "--file"), inline = val(args, "--mjml");
        if (!id || (!file && !inline)) return bad;
        await lib().components.set(campaignId, id, file ? readFile(file) : inline!);
      } else if (sub === "remove") {
        if (!id) return bad;
        await lib().components.remove(campaignId, id);
      }
      const all = await lib().components.resolve(campaignId);
      return reply(all, Object.keys(all).map((n) => `{{> ${n}}}`).join("  ") || "No components. Add one: email component set <name> --file <mjml file> (used in templates as {{> name}}).");
    }
    if (area === "entry") {
      if (sub === "show") { if (!id) return bad; const b = await lib().entries.get(id); return b ? reply({ ...b, render: { ...b.render, html: undefined } }, showBinding(b)) : { exitCode: 1, stderr: `Entry ${id} has no template` }; }
      const template = val(args, "--template");
      if (!template) return bad;
      const version = val(args, "--version") ? Number(val(args, "--version")) : undefined;
      const locale = val(args, "--locale");
      if (sub === "create") {
        const at = val(args, "--at"), tier = Number(val(args, "--tier"));
        if (!at || ![1, 2, 3].includes(tier)) return bad;
        const r = await lib().entries.create({ campaignId: await campaign(), scheduledAt: at, tier: tier as 1 | 2 | 3, templateId: template, version, locale, content: contentOf(args, val), createdBy: val(args, "--as") ?? "cli" });
        return reply({ entryId: r.entryId }, `Created ${r.entry.id} (${r.entry.status}) from ${template} v${r.version.version}\n${showBinding({ ...r, entryId: r.entry.id })}`);
      }
      if (sub === "bind") {
        if (!id) return bad;
        const r = await lib().entries.bind({ entryId: id, templateId: template, version, locale, content: contentOf(args, val) });
        return reply({ entryId: r.entryId, changed: r.changed }, `${r.changed ? "Updated" : "Unchanged"}\n${showBinding(r)}`);
      }
      return bad;
    }

    // area === "template"
    if (sub === "list") {
      const list = templates.list();
      const names = new Map((await c.campaigns.list()).map((x) => [x.id, x.name]));
      return reply(list, list.map((t) => `${t.id}  (${names.get(t.campaignId) ?? t.campaignId})  ${templates.dir(t.campaignId, t.id)}`).join("\n") || "No templates yet: bb brandwise email template seed <id> --campaign <c>");
    }
    if (!sub || !id) return bad;
    if (sub !== "seed" && !enabled()) return { exitCode: 1, stderr: "The e-mail engine is not installed: run npm install in packages/email-engine and set the plugin setting emailEnginePath." };
    const campaignId = await campaign();
    if (sub === "seed") {
      const dir = await templates.seed(campaignId, id);
      return reply({ dir }, `Template written to ${dir}: template.mjml, template.json, brand.json, sample.json. Edit them, then run: bb brandwise email template preview ${id} --campaign ${campaignId}`);
    }
    const target = val(args, "--target");
    if (sub === "render" || sub === "lint") {
      const r = await templates.render(campaignId, id, { target, locale: val(args, "--locale") });
      if (sub === "render" && args.includes("--raw")) return { exitCode: 0, stdout: r.html };
      const failed = r.findings.some((f) => f.severity === "error");
      return { ...reply(out(r), `${summary(r)}\n${listFindings(r) || "  no findings"}${sub === "render" ? `\nhash ${r.hash.slice(0, 12)}; the HTML with --raw` : ""}`), exitCode: sub === "lint" && failed ? 1 : 0 };
    }
    if (sub === "links") {
      const r = await templates.render(campaignId, id, { target });
      const found = await checkLinks(r.html, fetchLinkChecker());
      return { ...reply(found, found.map((f) => `  ${f.severity.toUpperCase().padEnd(5)} ${f.message}`).join("\n") || "All links answer."), exitCode: found.some((f) => f.severity === "error") ? 1 : 0 };
    }
    if (sub === "preview") {
      const width = Number(val(args, "--width") ?? 640) || 640;
      const { png, rendered } = await templates.picture(campaignId, id, { width });
      const dir = path.join(templates.dir(campaignId, id), ".previews");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}-${width}-${rendered.hash.slice(0, 8)}.png`);
      fs.writeFileSync(file, png);
      return reply({ file, ...out(rendered) }, `Picture: ${file}\n${summary(rendered)}\n${listFindings(rendered) || "  no findings"}\nOpen the PNG and look at it.`);
    }
    if (sub === "publish") {
      const r = await lib().versions.publish(campaignId, id, val(args, "--as") ?? "cli", val(args, "--note"));
      return reply({ version: r.version.version, created: r.created }, r.created ? `Published ${id} version ${r.version.version}. Entries use it with: email entry create|bind --template ${id}` : `Nothing changed since version ${r.version.version}.`);
    }
    if (sub === "versions") {
      const list = await lib().versions.list(campaignId, id);
      return reply(list.map((x) => ({ version: x.version, note: x.note, createdAt: x.createdAt })), list.map((x) => `v${x.version}  ${x.createdAt.slice(0, 16)}  ${x.createdBy}  ${x.note ?? ""}`).join("\n") || "Not published yet: email template publish <id>");
    }
    if (sub === "send-test") {
      const to = val(args, "--to");
      if (!to) return bad;
      const r = await sendTest(campaignId, id, to, val(args, "--provider"));
      return reply(r, `Test e-mail sent to ${to} through ${r.provider} from ${r.from}.`);
    }
    return bad;
  }

  return { rpc, cli, agentContext, templates, enabled, library };
}
