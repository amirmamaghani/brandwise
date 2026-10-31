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
  email_template_send_test: { input: z.object({ ...ref, to: z.string().email(), provider: z.string().optional() }), output: z.object({ provider: z.string(), from: z.string() }) },
};
type In<K extends keyof typeof templatesContract> = z.infer<(typeof templatesContract)[K]["input"]>;

type Io = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };

export function createEmailTemplates(deps: { need: () => Core; email: () => Email | null; enginePath: () => string; chromePath: () => string; videoEnginePath: () => string }) {
  const root = () => process.env.BW_EMAIL_TEMPLATES_DIR || path.join(os.homedir(), ".bb-brandwise", "email-templates");
  const engine = () => deps.enginePath() || process.env.BW_EMAIL_ENGINE_DIR || "";
  const enabled = () => engine() !== "" && fs.existsSync(path.join(engine(), "node_modules", "mjml"));

  const templates = createTemplates({
    root,
    renderer: () => mjmlProcess(engine()),
    preview: () => chromePreview({ enginePath: engine(), chromePath: deps.chromePath(), videoEnginePath: deps.videoEnginePath() }),
    // Stored images are inlined for previews. For a real send they need a public address: pass `publish` here when the public bucket exists.
    assets: assetHost({ read: async (id) => { const c = deps.need(); const a = await c.assets.get(id).catch(() => null); return a ? { bytes: await c.assets.read(id), mime: a.mime } : null; } }),
    dialectOf: (id) => deps.email()?.providers.find((p) => p.id === id)?.dialect ?? null,
  });

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
      templates.seed(campaignId, id);
      return { ok: true };
    },
    // a template that is gone or not valid has an empty state, so a page that keeps polling it does not fill the log with errors
    email_template_state: async ({ campaignId, id }: In<"email_template_state">) => { try { return templates.state(campaignId, id); } catch { return { hash: "", files: [] as string[] }; } },
    email_template_render: async ({ campaignId, id, target }: In<"email_template_render">) => out(await templates.render(campaignId, id, { target })),
    email_template_file: async ({ campaignId, id, name }: In<"email_template_file">) => ({ content: templates.file(campaignId, id, name) }),
    email_template_save: async ({ campaignId, id, name, content }: In<"email_template_save">) => { templates.saveFile(campaignId, id, name, content); return { ok: true }; },
    email_template_send_test: async ({ campaignId, id, to, provider }: In<"email_template_send_test">) => sendTest(campaignId, id, to, provider),
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

  /** `bb brandwise email template <seed|list|render|lint|preview|send-test> ...` */
  async function cli(args: string[], { val, positional, reply, usage }: Io) {
    const bad = { exitCode: 1, stderr: usage };
    const [sub, id] = positional(args.slice(2));   // args = ["email", "template", sub, id, ...flags]
    const c = deps.need();
    if (sub === "list") {
      const list = templates.list();
      const names = new Map((await c.campaigns.list()).map((x) => [x.id, x.name]));
      return reply(list, list.map((t) => `${t.id}  (${names.get(t.campaignId) ?? t.campaignId})  ${templates.dir(t.campaignId, t.id)}`).join("\n") || "No templates yet: bb brandwise email template seed <id> --campaign <c>");
    }
    if (!sub || !id) return bad;
    if (sub !== "seed" && !enabled()) return { exitCode: 1, stderr: "The e-mail engine is not installed: run npm install in packages/email-engine and set the plugin setting emailEnginePath." };
    const campaignId = (await c.campaigns.resolve(val(args, "--campaign"))).id;
    if (sub === "seed") {
      const dir = templates.seed(campaignId, id);
      return reply({ dir }, `Template written to ${dir}: template.mjml, template.json, brand.json, sample.json. Edit them, then run: bb brandwise email template preview ${id} --campaign ${campaignId}`);
    }
    const target = val(args, "--target");
    if (sub === "render" || sub === "lint") {
      const r = await templates.render(campaignId, id, { target });
      if (sub === "render" && args.includes("--raw")) return { exitCode: 0, stdout: r.html };
      const failed = r.findings.some((f) => f.severity === "error");
      return { ...reply(out(r), `${summary(r)}\n${listFindings(r) || "  no findings"}${sub === "render" ? `\nhash ${r.hash.slice(0, 12)}; the HTML with --raw` : ""}`), exitCode: sub === "lint" && failed ? 1 : 0 };
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
    if (sub === "send-test") {
      const to = val(args, "--to");
      if (!to) return bad;
      const r = await sendTest(campaignId, id, to, val(args, "--provider"));
      return reply(r, `Test e-mail sent to ${to} through ${r.provider} from ${r.from}.`);
    }
    return bad;
  }

  return { rpc, cli, agentContext, templates, enabled };
}
