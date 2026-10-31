// The template library: what turns template folders into something a campaign can rely on.
//   brand kit and components   per client, inherited down the campaign tree (a child campaign overrides what it sets)
//   published versions         immutable copies of a folder, with the brand kit and components as they were
//   render snapshots           exactly what was rendered for an entry (content-addressed), what approval is about and what is sent
//   entry bindings             a calendar entry that carries a template version, a locale and content
// Pure pipeline and ports are in domain/; this file is the Postgres side and the rules between them.
import { createHash } from "node:crypto";
import type pg from "pg";
import type { Core, CalendarEntry, Tier } from "../../index.ts";
import type { MergeDialect } from "../domain/types.ts";
import { hasErrors, renderTemplate } from "./domain/render.ts";
import type { AssetHost, Renderer } from "./domain/ports.ts";
import type { Brand, Finding, Rendered, TemplateSource } from "./domain/types.ts";
import { mergeBrand, type Templates } from "./index.ts";

export type TemplateVersion = { id: string; campaignId: string; templateId: string; version: number; hash: string; note: string | null; createdBy: string; createdAt: string; files: VersionFiles };
export type VersionFiles = { mjml: string; config: TemplateSource["config"]; brand: Brand; sample: Record<string, unknown>; partials: Record<string, string> };
export type Snapshot = { id: string; hash: string; locale: string; target: string; subject: string; preheader: string; html: string; text: string; size: number; findings: Finding[] };
export type Binding = { entryId: string; templateVersionId: string; locale: string; content: Record<string, unknown>; render: Snapshot };

const versionFrom = (r: any): TemplateVersion => ({ id: r.id, campaignId: r.campaign_id, templateId: r.template_id, version: r.version, hash: r.hash, note: r.note, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), files: r.files });
const snapshotFrom = (r: any): Snapshot => ({ id: r.id, hash: r.hash, locale: r.locale, target: r.target, subject: r.subject, preheader: r.preheader, html: r.html, text: r.text, size: r.size, findings: r.findings });

export function createLibrary(deps: {
  pool: pg.Pool;
  core: Pick<Core, "campaigns" | "calendar" | "channels">;
  templates: Templates;
  renderer: () => Renderer;
  assets: AssetHost;
  dialectOf: (providerId: string) => MergeDialect | null;
}) {
  const q = async (sql: string, p: unknown[] = []) => (await deps.pool.query(sql, p)).rows;

  /** The campaign and its ancestors, root first: what a child inherits from. */
  async function chain(campaignId: string): Promise<string[]> {
    const all = await deps.core.campaigns.list();
    const out: string[] = [];
    for (let c = all.find((x) => x.id === campaignId); c; c = c.parentId ? all.find((x) => x.id === c!.parentId) : undefined) out.unshift(c.id);
    return out;
  }

  const brand = {
    /** The brand kit in effect: the root's, overridden by each campaign down to this one. */
    async resolve(campaignId: string): Promise<{ brand: Brand; hasKit: boolean }> {
      const ids = await chain(campaignId);
      const rows = ids.length ? await q("select campaign_id, brand from email_brand_kit where campaign_id = any($1::uuid[])", [ids]) : [];
      const byId = new Map(rows.map((r: any) => [r.campaign_id, r.brand as Brand]));
      return { brand: ids.reduce<Brand>((acc, id) => (byId.has(id) ? mergeBrand(acc, byId.get(id)!) : acc), {}), hasKit: rows.length > 0 };
    },
    async own(campaignId: string): Promise<{ brand: Brand; version: number } | null> {
      const r = (await q("select brand, version from email_brand_kit where campaign_id = $1", [campaignId]))[0];
      return r ? { brand: r.brand, version: r.version } : null;
    },
    async set(campaignId: string, value: Brand): Promise<void> {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("A brand kit is a JSON object");
      await q(`insert into email_brand_kit (campaign_id, brand) values ($1, $2)
               on conflict (campaign_id) do update set brand = excluded.brand, version = email_brand_kit.version + 1, updated_at = now()`, [campaignId, value]);
    },
  };

  const components = {
    async resolve(campaignId: string): Promise<Record<string, string>> {
      const ids = await chain(campaignId);
      const rows = ids.length ? await q("select campaign_id, name, mjml from email_component where campaign_id = any($1::uuid[])", [ids]) : [];
      const out: Record<string, string> = {};
      for (const id of ids) for (const r of rows.filter((x: any) => x.campaign_id === id)) out[r.name] = r.mjml;   // root first, children override
      return out;
    },
    async set(campaignId: string, name: string, mjml: string): Promise<void> {
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(name)) throw new Error("A component name is 2 to 32 characters of a-z, 0-9 and _, starting with a letter");
      if (mjml.length > 100_000) throw new Error("A component is over 100 KB");
      await q("insert into email_component (campaign_id, name, mjml) values ($1,$2,$3) on conflict (campaign_id, name) do update set mjml = excluded.mjml, updated_at = now()", [campaignId, name, mjml]);
    },
    async remove(campaignId: string, name: string): Promise<boolean> {
      return (await q("delete from email_component where campaign_id = $1 and name = $2 returning 1", [campaignId, name])).length > 0;
    },
    async own(campaignId: string): Promise<{ name: string; mjml: string }[]> {
      return (await q("select name, mjml from email_component where campaign_id = $1 order by name", [campaignId])).map((r: any) => ({ name: r.name, mjml: r.mjml }));
    },
  };

  /** What the template service needs to render a folder with the client's kit and components. */
  const resolve = async (campaignId: string) => ({ ...(await brand.resolve(campaignId)), partials: await components.resolve(campaignId) });

  const versions = {
    async list(campaignId: string, templateId: string): Promise<TemplateVersion[]> {
      return (await q("select * from email_template_version where campaign_id = $1 and template_id = $2 order by version desc", [campaignId, templateId])).map(versionFrom);
    },
    /** The template as published: searched in the campaign and its ancestors, nearest first. `version` omitted means the latest. */
    async find(campaignId: string, templateId: string, version?: number): Promise<TemplateVersion | null> {
      for (const id of (await chain(campaignId)).reverse()) {
        const r = (await q(`select * from email_template_version where campaign_id = $1 and template_id = $2 and ($3::int is null or version = $3) order by version desc limit 1`, [id, templateId, version ?? null]))[0];
        if (r) return versionFrom(r);
      }
      return null;
    },
    /**
     * Freeze the folder as the next version, with the resolved brand kit and components. The sample must render without lint errors,
     * so a published version is one that can be used. Publishing the same content twice returns the existing version.
     */
    async publish(campaignId: string, templateId: string, by: string, note?: string): Promise<{ version: TemplateVersion; created: boolean; findings: Finding[] }> {
      const src = deps.templates.load(campaignId, templateId);
      const kit = await resolve(campaignId);
      const files: VersionFiles = { mjml: src.mjml, config: src.config, brand: mergeBrand(kit.brand, src.brand), sample: src.sample, partials: kit.partials };
      const preview = await renderTemplate({ ...files }, files.sample, { renderer: deps.renderer(), assets: deps.assets }, { id: "preview", dialect: null });
      if (hasErrors(preview)) throw new Error(`Not published: the sample has lint errors\n${preview.findings.filter((f) => f.severity === "error").map((f) => `  ${f.rule}: ${f.message}`).join("\n")}`);
      const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
      const latest = (await versions.list(campaignId, templateId))[0];
      if (latest && latest.hash === hash) return { version: latest, created: false, findings: preview.findings };
      const row = (await q(
        `insert into email_template_version (campaign_id, template_id, version, files, hash, note, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [campaignId, templateId, (latest?.version ?? 0) + 1, files, hash, note ?? null, by],
      ))[0];
      return { version: versionFrom(row), created: true, findings: preview.findings };
    },
  };

  const snapshots = {
    async store(versionId: string | null, r: Rendered, locale: string): Promise<Snapshot> {
      const row = (await q(
        `insert into email_render (hash, template_version_id, locale, target, subject, preheader, html, text, size, findings) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (hash) do update set hash = excluded.hash returning *`,
        [r.hash, versionId, locale, r.target, r.subject, r.preheader, r.html, r.text, r.size, JSON.stringify(r.findings)],
      ))[0];
      return snapshotFrom(row);
    },
    async get(id: string): Promise<Snapshot | null> {
      const r = (await q("select * from email_render where id = $1", [id]))[0];
      return r ? snapshotFrom(r) : null;
    },
  };

  /** Render a published version for the provider of the campaign's e-mail target, with the given content and locale. */
  async function renderVersion(v: TemplateVersion, entryCampaignId: string, content: Record<string, unknown>, locale: string, providerId?: string): Promise<Rendered> {
    const locales = v.files.config.locales;
    if (locales && !locales.includes(locale)) throw new Error(`Locale "${locale}" is not one of the template's locales (${locales.join(", ")})`);
    const target = providerId ?? ((await deps.core.channels.get(entryCampaignId, "email"))?.provider);
    if (!target) throw new Error("The campaign has no e-mail target with provider= (campaign channel set email provider=... ): the e-mail is rendered for that provider");
    const dialect = deps.dialectOf(target);
    if (!dialect) throw new Error(`E-mail provider "${target}" is not configured`);
    return renderTemplate({ ...v.files }, content, { renderer: deps.renderer(), assets: deps.assets }, { id: target, dialect }, locale);
  }

  const entries = {
    /** Everything about a bound entry: the version it uses, its content, and the snapshot that was approved. */
    async get(entryId: string): Promise<(Binding & { version: TemplateVersion }) | null> {
      const r = (await q("select * from email_entry where entry_id = $1", [entryId]))[0];
      if (!r) return null;
      const v = (await q("select * from email_template_version where id = $1", [r.template_version_id]))[0];
      return { entryId, templateVersionId: r.template_version_id, locale: r.locale, content: r.content, render: (await snapshots.get(r.render_id))!, version: versionFrom(v) };
    },
    /**
     * Bind an existing entry to a published version and content. The e-mail is rendered for the campaign's provider and checked: lint
     * errors refuse the bind. The entry gets the subject as its title and the rendered HTML as its body, so editing it goes through
     * the calendar's approval rules like any content change (a tier 2 or 3 entry is sent back for approval).
     */
    async bind(input: { entryId: string; templateId: string; version?: number; locale?: string; content: Record<string, unknown> }): Promise<Binding & { version: TemplateVersion; changed: boolean }> {
      const entry = await deps.core.calendar.get(input.entryId);
      if (!entry) throw new Error(`No calendar entry ${input.entryId}`);
      if (entry.channel !== "email") throw new Error("Only entries of the channel email can carry a template");
      const v = await versions.find(entry.campaignId, input.templateId, input.version);
      if (!v) throw new Error(`Template ${input.templateId}${input.version ? ` version ${input.version}` : ""} is not published for this campaign (publish it first: email template publish ${input.templateId})`);
      const locale = input.locale ?? "en";
      const r = await renderVersion(v, entry.campaignId, input.content, locale);
      if (hasErrors(r)) throw new Error(`Not bound: the e-mail has lint errors\n${r.findings.filter((f) => f.severity === "error").map((f) => `  ${f.rule}: ${f.message}`).join("\n")}`);
      const snap = await snapshots.store(v.id, r, locale);
      const before = await q("select render_id from email_entry where entry_id = $1", [input.entryId]);
      await deps.core.calendar.update(input.entryId, { title: r.subject, body: r.html });
      await q(`insert into email_entry (entry_id, template_version_id, locale, content, render_id) values ($1,$2,$3,$4,$5)
               on conflict (entry_id) do update set template_version_id = excluded.template_version_id, locale = excluded.locale, content = excluded.content, render_id = excluded.render_id, updated_at = now()`,
        [input.entryId, v.id, locale, input.content, snap.id]);
      return { entryId: input.entryId, templateVersionId: v.id, locale, content: input.content, render: snap, version: v, changed: before[0]?.render_id !== snap.id };
    },
    /** A new e-mail entry made from a template: the entry and its binding in one step. */
    async create(input: { campaignId: string; scheduledAt: string; tier: Tier; templateId: string; version?: number; locale?: string; content: Record<string, unknown>; createdBy: string }): Promise<{ entry: CalendarEntry } & Binding & { version: TemplateVersion }> {
      const v = await versions.find(input.campaignId, input.templateId, input.version);
      if (!v) throw new Error(`Template ${input.templateId} is not published for this campaign (publish it first)`);
      const locale = input.locale ?? "en";
      const r = await renderVersion(v, input.campaignId, input.content, locale);
      if (hasErrors(r)) throw new Error(`Not created: the e-mail has lint errors\n${r.findings.filter((f) => f.severity === "error").map((f) => `  ${f.rule}: ${f.message}`).join("\n")}`);
      const snap = await snapshots.store(v.id, r, locale);
      const entry = await deps.core.calendar.add({ campaignId: input.campaignId, title: r.subject, channel: "email", scheduledAt: input.scheduledAt, tier: input.tier, body: r.html, createdBy: input.createdBy });
      await q("insert into email_entry (entry_id, template_version_id, locale, content, render_id) values ($1,$2,$3,$4,$5)", [entry.id, v.id, locale, input.content, snap.id]);
      return { entry, entryId: entry.id, templateVersionId: v.id, locale, content: input.content, render: snap, version: v };
    },
    /** The snapshot a send used: the connector records it with the send. */
    async renderIdFor(entryId: string): Promise<string | null> {
      return (await q("select render_id from email_entry where entry_id = $1", [entryId]))[0]?.render_id ?? null;
    },
  };

  return { brand, components, resolve, versions, snapshots, entries, renderVersion };
}
export type Library = ReturnType<typeof createLibrary>;
