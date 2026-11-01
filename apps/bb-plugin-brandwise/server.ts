// bb-plugin-brandwise: backend entry. All data lives in @brandwise/core (Postgres + S3);
// this file only maps it to RPC (UI) and the `bb brandwise` CLI (agents, scripts).
// The calendar is the single path out (docs/architecture.md): agents and humans create/decide entries here.
// Approved entries are fired by `calendar run-due`, which a bb automation runs every minute (infra/bb-instance/provision.sh).
import { defineRpcContract, type BbPluginApi, type PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { cookieJarFor, createCore, downloadResult, isFailed, PROVIDERS, REVIEW_REASONS, sessionFromCookieJar, STATUSES, type Core, type GenSpec, type Provider, type Scope, type SettingValue } from "./core/index.ts";
import { randomBytes } from "node:crypto";
import * as cp from "node:child_process";
import * as fsx from "node:fs";
import * as osx from "node:os";
import * as px from "node:path";
import { agentContract, createAgents, spawnAgentThread } from "./agents.ts";
import { productCli } from "./product.ts";
import { createVideo, videoContract } from "./video.ts";
import { createEmailTemplates, templatesContract } from "./email-templates.ts";
import { sleep, slug } from "./util.ts";
import { connectorsFrom, runDue } from "./core/publish.ts";
import { createEmail } from "./core/email/index.ts";
import { createRegulator } from "./core/regulator/index.ts";
import { regulatorStore } from "./core/regulator/store.ts";
import { createEditorCli } from "./editor.ts";
import { createLearnings, emailMeasure } from "./core/learnings/index.ts";
import { createLearningsCli } from "./learnings-cli.ts";
import { createEconomics } from "./core/economics/index.ts";
import { createConversions } from "./core/conversions/index.ts";
import { createMedia, mockBuyer, mockPayments } from "./core/media/index.ts";
import { createResultsCli } from "./results-cli.ts";
import { randomUUID } from "node:crypto";
import { MODES, allowedModes, applyMode, appliedMode, defHashOf, isModeName, type ModeName } from "./modes.ts";

export type { CalendarEntry, Campaign } from "./core/index.ts";

const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const campaignSchema = z.object({
  id: z.string(), parentId: z.string().nullable(), rootId: z.string(), name: z.string(),
  kind: z.enum(["always_on", "campaign"]), startsAt: z.string().nullable(), endsAt: z.string().nullable(),
});
const entrySchema = z.object({
  id: z.string(), campaignId: z.string(), campaignName: z.string(), title: z.string(), channel: z.string(),
  scheduledAt: z.string(), tier: tierSchema, status: z.enum(STATUSES), assetId: z.string().nullable(), createdBy: z.string(),
  body: z.string(), link: z.string().nullable(), reviewNote: z.string().nullable(),
  attempts: z.number(), externalId: z.string().nullable(), externalUrl: z.string().nullable(), error: z.string().nullable(),
  briefId: z.string().nullable(), approvedAt: z.string().nullable(), approvedBy: z.string().nullable(),
  experimentId: z.string().nullable(), variant: z.enum(["A", "B"]).nullable(),
});
const learningSchema = z.object({
  id: z.string(), scope: z.string(), kind: z.string(), evidence: z.string().nullable(), result: z.string().nullable(), statement: z.string(),
  channel: z.string().nullable(), status: z.string(), effectiveStatus: z.string(), contrary: z.number(), createdBy: z.string(),
  confirmedBy: z.string().nullable(), decidedAt: z.string(), sourceIds: z.array(z.string()),
});
const UI_STATUSES = ["draft", "linted", "approved", "archived"] as const;
const creativeSchema = z.object({
  id: z.string(), name: z.string(), campaignId: z.string(), campaignName: z.string(), role: z.string(), origin: z.string(),
  status: z.string(), aiGenerated: z.boolean(), bytes: z.number(), mime: z.string(), dataUri: z.string().nullable(), thumb: z.string(),
  width: z.number().nullable(), height: z.number().nullable(), createdAt: z.string(),
});
export type Creative = z.infer<typeof creativeSchema>;
const settingValue = z.union([z.string(), z.number(), z.boolean()]);
const settingsViewSchema = z.object({
  sections: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string(),
    fields: z.array(z.object({
      key: z.string(), label: z.string(), description: z.string().nullable(),
      type: z.enum(["string", "number", "boolean", "select"]), secret: z.boolean(),
      options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
      value: settingValue.nullable(), // null for secrets: they are never sent to the page
      isSet: z.boolean(),
    })),
  })),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;
// Scoped settings (providers, limits): the same fields seen from global or from one campaign, with where each value comes from.
const configViewSchema = z.object({
  scopeName: z.string(),
  inheritsFrom: z.array(z.string()),
  groups: z.array(z.object({
    title: z.string(),
    fields: z.array(z.object({
      key: z.string(), label: z.string(), description: z.string().nullable(),
      type: z.enum(["string", "number", "boolean", "select"]), secret: z.boolean(), options: z.array(z.string()).nullable(),
      value: settingValue.nullable(), // null for secrets
      isSet: z.boolean(),
      source: z.enum(["here", "inherited", "default", "unset"]), sourceName: z.string().nullable(),
      widget: z.string().nullable(),
    })),
  })),
});
export type ConfigView = z.infer<typeof configViewSchema>;
const instagramStatusSchema = z.object({
  state: z.enum(["saved", "browser", "none"]),
  /** Where the saved session comes from relative to the scope looked at: "here", or the name of the scope it is inherited from. */
  from: z.string().nullable(),
  browser: z.string().nullable(),
});
export type InstagramStatus = z.infer<typeof instagramStatusSchema>;
const providersStatusSchema = z.object({ providers: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean(), detail: z.string(), loginHint: z.string() })) });
export type ProvidersStatus = z.infer<typeof providersStatusSchema>;
export type ModeView = z.infer<typeof modeViewSchema>;

const modeViewSchema = z.object({
  mode: z.string(), label: z.string(), description: z.string(), css: z.string(),
  /** Modes the operator allows (BW_MODES); a single entry means the switch is locked. */
  allowed: z.array(z.object({ name: z.string(), label: z.string(), description: z.string() })),
  locked: z.boolean(), lastChanges: z.array(z.string()), error: z.string().nullable(),
});

const threadRowSchema = z.object({
  id: z.string(), title: z.string(), campaignId: z.string().nullable(), updatedAt: z.string(), status: z.string(),
});
const overviewSchema = campaignSchema.extend({ threads: z.number(), entries: z.number(), creatives: z.number() });

export const rpcContract = defineRpcContract({
  campaigns_list: { input: z.null(), output: z.object({ campaigns: z.array(campaignSchema) }) },
  /** thread id -> campaign id for the given threads (this plugin's metadata namespace on each thread). */
  thread_campaigns: { input: z.object({ threadIds: z.array(z.string()).max(200) }), output: z.object({ map: z.record(z.string(), z.string()) }) },
  thread_set_campaign: { input: z.object({ threadId: z.string(), campaignId: z.string().nullable() }), output: z.object({ ok: z.boolean() }) },
  campaigns_overview: { input: z.null(), output: z.object({ campaigns: z.array(overviewSchema) }) },
  campaign_threads: { input: z.null(), output: z.object({ threads: z.array(threadRowSchema), unassigned: z.number() }) },
  campaign_add: {
    input: z.object({
      name: z.string().trim().min(1).max(120), kind: z.enum(["always_on", "campaign"]), parentId: z.string().nullable(),
      startsAt: z.string().nullable(), endsAt: z.string().nullable(),
    }),
    output: campaignSchema,
  },
  calendar_list: { input: z.null(), output: z.object({ entries: z.array(entrySchema) }) },
  calendar_add: {
    input: z.object({
      campaignId: z.string(),
      title: z.string().trim().min(1).max(200),
      channel: z.string().trim().min(1).max(40),
      scheduledAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid date"),
      tier: tierSchema,
      assetId: z.string().nullable().optional(),
      body: z.string().max(5000).optional(),
      link: z.string().max(2000).nullable().optional(),
    }),
    output: entrySchema,
  },
  calendar_update: {
    input: z.object({
      id: z.string(),
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(5000).optional(),
      link: z.string().max(2000).nullable().optional(),
      channel: z.string().trim().min(1).max(40).optional(),
      scheduledAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid date").optional(),
    }),
    output: entrySchema,
  },
  calendar_unapprove: { input: z.object({ id: z.string() }), output: entrySchema },
  calendar_request_changes: { input: z.object({ id: z.string(), note: z.string().trim().min(1).max(2000), reason: z.enum(REVIEW_REASONS).nullable().optional(), reviewSeconds: z.number().min(0).max(86_400).nullable().optional() }), output: entrySchema },
  /** Costs, creative economics per format, production, and the brand's economics profile (Results page). */
  results_costs: { input: z.object({ campaignId: z.string(), sinceDays: z.number().int().min(1).max(730) }), output: z.object({ report: z.any() }) },
  economics_get: { input: z.object({ campaignId: z.string() }), output: z.object({ economics: z.any() }) },
  results_funnel: { input: z.object({ campaignId: z.string(), sinceDays: z.number().int().min(1).max(730) }), output: z.object({ funnel: z.any() }) },
  ads_results: { input: z.object({ campaignId: z.string() }), output: z.object({ ads: z.array(z.any()) }) },
  /** A person's action: where a campaign buys media and how it pays (the CLI refuses the ads channel). */
  ads_target: { input: z.object({ campaignId: z.string() }), output: z.object({ target: z.record(z.string(), z.string()).nullable(), platforms: z.array(z.object({ id: z.string(), requiresPayment: z.boolean() })), payments: z.array(z.string()) }) },
  ads_target_set: { input: z.object({ campaignId: z.string(), target: z.object({ provider: z.string(), payment: z.string().nullable().optional(), prepaid: z.boolean().optional() }).nullable() }), output: z.object({ ok: z.boolean() }) },
  conversion_sources: { input: z.object({ campaignId: z.string() }), output: z.object({ sources: z.array(z.object({ id: z.string(), name: z.string(), adapter: z.string(), received: z.number(), createdAt: z.string() })) }) },
  /** A person's actions: add a lead source (the signing secret is shown once), import a CSV export, map a promo code to a campaign. */
  conversion_source_add: { input: z.object({ campaignId: z.string(), name: z.string().trim().min(1).max(120), adapter: z.enum(["generic", "csv"]) }), output: z.object({ id: z.string(), secret: z.string().nullable(), path: z.string() }) },
  conversion_import: { input: z.object({ sourceId: z.string(), csv: z.string().max(5_000_000), mapping: z.record(z.string(), z.string()), kind: z.enum(["lead", "order"]) }), output: z.object({ result: z.any() }) },
  promo_set: { input: z.object({ code: z.string().trim().min(2).max(40), campaignId: z.string() }), output: z.object({ ok: z.boolean() }) },
  /** A person's actions: set the economics profile, state a cost (media spend, an incentive, a tool, sales cost). */
  economics_set: { input: z.object({ campaignId: z.string(), profile: z.record(z.string(), z.unknown()) }), output: z.object({ ok: z.boolean() }) },
  cost_add: { input: z.object({ campaignId: z.string(), kind: z.enum(["media", "incentive", "tool", "sales"]), amount: z.number().min(0), ref: z.string().trim().min(1).max(120), note: z.string().max(500).optional(), entryId: z.string().nullable().optional() }), output: z.object({ ok: z.boolean() }) },
  /** What an entry was written from: its brief, the learnings it applies or tests, its attributes (the approval card). */
  entry_learnings: {
    input: z.object({ id: z.string() }),
    output: z.object({
      briefId: z.string().nullable(), slot: z.string().nullable(),
      applied: z.array(z.object({ id: z.string(), mode: z.string(), statement: z.string(), evidence: z.string().nullable() })),
      attributes: z.record(z.string(), z.object({ value: z.string(), source: z.string() })),
      media: z.object({ action: z.string(), budget: z.number(), currency: z.string(), days: z.number(), status: z.string(), platform: z.string().nullable(), payment: z.string().nullable(), boostOf: z.string().nullable() }).nullable(),
      experiment: z.object({ id: z.string(), hypothesis: z.string(), lever: z.string().nullable(), variant: z.string().nullable(), round: z.number(), plannedRounds: z.number(), expectedLift: z.number().nullable(), mde: z.number().nullable(), status: z.string(), verdict: z.string().nullable() }).nullable(),
    }),
  },
  learnings_list: { input: z.object({ campaignId: z.string() }), output: z.object({ learnings: z.array(learningSchema) }) },
  /** A person's actions on a learning: confirm a proposed reviewer preference, or retire a learning. */
  learning_set_status: { input: z.object({ id: z.string(), action: z.enum(["confirm", "retire"]) }), output: z.object({ ok: z.boolean() }) },
  calendar_decide: { input: z.object({ id: z.string(), decision: z.enum(["approve", "cancel"]), reviewSeconds: z.number().min(0).max(86_400).nullable().optional() }), output: entrySchema },
  creatives_list: { input: z.null(), output: z.object({ creatives: z.array(creativeSchema) }) },
  creatives_upload: {
    input: z.object({ campaignId: z.string(), filename: z.string().trim().min(1).max(200), dataBase64: z.string().min(1).max(14_000_000) }),
    output: creativeSchema,
  },
  creatives_update: {
    input: z.object({ id: z.string(), name: z.string().trim().min(1).max(200).optional(), status: z.enum(UI_STATUSES).optional() }),
    output: creativeSchema,
  },
  creatives_delete: { input: z.object({ id: z.string() }), output: z.object({ deleted: z.boolean() }) },
  /** Creatives by id, in the given order; unknown ids are skipped. Backs the `::creative{ids="..."}` chat directive. */
  creatives_get: { input: z.object({ ids: z.array(z.string()).max(12) }), output: z.object({ creatives: z.array(creativeSchema) }) },
  /** Full-size image for the preview; the list only inlines small files. */
  creatives_full: { input: z.object({ id: z.string() }), output: z.object({ dataUri: z.string() }) },
  /** Facts for the "Connect Claude Code" settings section; everything is read from the running server, nothing is hard-coded. */
  mcp_info: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(), status: z.string(), localUrl: z.string(), serverUrl: z.string(),
      daemonPort: z.string().nullable(), tailnetUrl: z.string().nullable(),
    }),
  },
  ...videoContract,
  ...templatesContract,
  ...agentContract,
  settings_get: { input: z.null(), output: settingsViewSchema },
  config_get: { input: z.object({ campaignId: z.string().nullable() }), output: configViewSchema },
  /** value null = remove the override at this scope, so it inherits again. */
  config_set: { input: z.object({ campaignId: z.string().nullable(), key: z.string(), value: settingValue.nullable() }), output: z.object({ ok: z.literal(true) }) },
  providers_status: { input: z.object({ campaignId: z.string().nullable() }), output: providersStatusSchema },
  instagram_status: { input: z.object({ campaignId: z.string().nullable() }), output: instagramStatusSchema },
  /** Reads the Instagram session out of a browser the user is signed in with, once, and saves it encrypted at this scope. */
  instagram_import: { input: z.object({ campaignId: z.string().nullable(), browser: z.string() }), output: z.object({ ok: z.literal(true) }) },
  /** Does Instagram accept the session this scope downloads with. Spends nothing. */
  instagram_test: { input: z.object({ campaignId: z.string().nullable() }), output: z.object({ ok: z.boolean(), detail: z.string() }) },
  settings_set: { input: z.object({ key: z.string(), value: settingValue.nullable() }), output: z.object({ ok: z.literal(true) }) },
  mode_get: { input: z.null(), output: modeViewSchema },
  mode_set: { input: z.object({ mode: z.string() }), output: modeViewSchema },
});

const CALENDAR_CHANGED = "calendar-changed";
const MODE_CHANGED = "mode-changed";
const SETTINGS_CHANGED = "settings-changed";
const CONFIG_CHANGED = "config-changed";
const THREAD_CAMPAIGN_CHANGED = "thread-campaign-changed";
const CAMPAIGNS_CHANGED = "campaigns-changed";
const CAMPAIGN_KEY = "campaignId"; // key in this plugin's metadata namespace on a thread
const ASSETS_CHANGED = "assets-changed";
const MAX_UPLOAD_BYTES = 10_000_000;
const MAX_PREVIEW_BYTES = 15_000_000;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_INLINE_BYTES = 1_500_000;
const MAX_CREATIVES = 24;
const thumbUrl = (id: string) => `/api/v1/plugins/brandwise/http/thumb?id=${encodeURIComponent(id)}`;
const mediaUrl = (id: string) => `/api/v1/plugins/brandwise/http/media?id=${encodeURIComponent(id)}`;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Filled by infra/bb-instance/provision.sh from .env; secrets stay on the server.
  // The settings are data: one entry per section. bb renders the descriptors as one flat form in this order (the label
  // prefix is the heading there); the plugin's Settings page renders the same sections with a navigation. To add a
  // setting, put it in a section (or add a section). Keys stay flat: `bb plugin config`, profile.env and provision.sh use them.
  const section = <const F extends Record<string, PluginSettingDescriptor>>(id: string, title: string, description: string, fields: F) => ({ id, title, description, fields });
  const SECTIONS = [
    section("display", "Display", "How much of bb's own interface is shown next to the BrandWise.", {
      mode: {
        type: "select",
        label: "Mode",
        description: "Full keeps everything bb ships. Minimal shows the marketing tools only. Takes effect immediately.",
        options: allowedModes(),
        experimental_optionLabels: Object.fromEntries(allowedModes().map((n) => [n, MODES[n].label])),
        default: allowedModes().includes("full") ? "full" : allowedModes()[0],
      },
    }),
    section("dev", "Development", "For trying the control loop without sending anything.", {
      simEnabled: { type: "boolean", label: "Simulated e-mail provider", description: "Adds a provider \"sim\" that answers with simulated opens, clicks and complaints, on a development clock (bb brandwise sim advance 24h). Never sends e-mail.", default: false },
    }),
    section("tools", "Tools", "Command-line tools the providers run on this host, outside the agents' sandbox, so only the operator sets them. Account, workspace and limits are set per scope under Providers.", {
      higgsfieldBin: { type: "string", label: "Higgsfield CLI", description: "Name or path of the higgsfield binary.", default: "higgsfield" },
    }),
    section("video", "Video", "The optional Remotion engine behind the Video page.", {
      videoEnginePath: { type: "string", label: "Engine folder", description: "Folder holding render.mjs of @brandwise/video-remotion. Empty = video commands are off.", default: "" },
    }),
    section("email-templates", "E-mail templates", "The optional engine behind the E-mail page: MJML and a headless Chrome for pictures.", {
      emailEnginePath: { type: "string", label: "Engine folder", description: "Folder of @brandwise/email-engine (MJML, puppeteer). Empty = the e-mail template commands are off.", default: "" },
      publicAssetBucket: { type: "string", label: "Public image bucket", description: "A bucket whose objects anyone can read. Images in sent e-mails are copied here once, under a permanent address. Empty = e-mails with stored images cannot be sent yet.", default: "" },
      publicAssetBaseUrl: { type: "string", label: "Public image address", description: "The public address of that bucket or of the CDN in front of it, e.g. https://cdn.example.com.", default: "" },
      chromePath: { type: "string", label: "Chrome", description: "Path of a Chrome or Chrome Headless Shell for pictures of e-mails. Empty = the one of the video engine, or a Chrome installed on this machine.", default: "" },
    }),
    section("telegram", "Telegram", "The channel the BrandWise posts to.", {
      resendApiKey: { type: "string", label: "Resend API key", description: "Switches the e-mail channel on (provider=resend in the campaign target).", default: "", secret: true },
      resendWebhookSecret: { type: "string", label: "Resend webhook signing secret", description: "whsec_... of the webhook that points at /api/v1/plugins/brandwise/http/webhooks/email/resend.", default: "", secret: true },
      telegramBotToken: { type: "string", label: "Telegram bot token", description: "From @BotFather. Switches the telegram channel on; each campaign picks its chat (campaign channel set telegram chatId=...).", default: "", secret: true },
    }),
    section("database", "Database", "Where campaigns, the calendar and asset records live.", {
      databaseUrl: { type: "string", label: "Postgres URL", default: "", secret: true },
    }),
    section("storage", "S3 storage", "Where the creative files live. The bucket itself stays private.", {
      s3Endpoint: { type: "string", label: "Endpoint (empty = AWS)", default: "" },
      s3Region: { type: "string", label: "Region", default: "us-east-1" },
      s3Bucket: { type: "string", label: "Bucket", default: "" },
      s3AccessKeyId: { type: "string", label: "Access key id", default: "", secret: true },
      s3SecretAccessKey: { type: "string", label: "Secret access key", default: "", secret: true },
      s3ForcePathStyle: { type: "boolean", label: "Path-style URLs (MinIO-like stores)", default: true },
    }),
    section("security", "Security", "Keeps the secrets saved under Providers (API keys) encrypted in the database.", {
      secretKey: { type: "string", label: "Encryption key", description: "Generated on first start. Replacing it makes saved secrets unreadable, set them again.", default: "", secret: true },
    }),
  ];
  type Intersect<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
  const settings = bb.settings.define(
    Object.fromEntries(
      SECTIONS.flatMap((s) => Object.entries(s.fields).map(([key, f]) => [key, { ...f, label: `${s.title} · ${f.label}` }])),
    ) as unknown as Intersect<(typeof SECTIONS)[number]["fields"]>,
  );
  let cfg = await settings.get();
  if (cfg.secretKey === "") {
    await settings.experimental_set({ secretKey: randomBytes(32).toString("base64") });
    cfg = await settings.get();
  }
  const buildCore = (c: typeof cfg): Core | null =>
    c.databaseUrl !== "" && c.s3Bucket !== "" && c.s3AccessKeyId !== ""
      ? createCore({
          databaseUrl: c.databaseUrl,
          s3: {
            endpoint: c.s3Endpoint || undefined, region: c.s3Region, bucket: c.s3Bucket,
            accessKeyId: c.s3AccessKeyId, secretAccessKey: c.s3SecretAccessKey, forcePathStyle: c.s3ForcePathStyle,
          },
          secretKey: c.secretKey || undefined,
        })
      : null;
  let core = buildCore(cfg);
  const coreKey = (c: typeof cfg) => JSON.stringify([c.databaseUrl, c.s3Endpoint, c.s3Region, c.s3Bucket, c.s3AccessKeyId, c.s3SecretAccessKey, c.s3ForcePathStyle, c.secretKey]);
  // A change from any place (Settings page, bb's form, `bb plugin config`) applies at once: limits and paths are read per call,
  // a new database or storage setting builds a new core.
  settings.onChange((next) => {
    const rebuild = coreKey(next) !== coreKey(cfg);
    cfg = next;
    if (rebuild) {
      const old = core;
      core = buildCore(next);
      void old?.close();
    }
  });
  const need = (): Core => {
    if (core === null) throw new Error("Not configured: set the database and S3 under Settings, or run infra/bb-instance/provision.sh apply.");
    return core;
  };
  // E-mail: providers with credentials, events in, statistics out (core/email). The salt makes the stored recipient hashes ours alone.
  // The salt lives in Postgres with the data it protects (docs/analytics.md D6): losing bb KV must not change every recipient hash.
  // An install from before keeps its KV salt, copied over once.
  const emailSalt = await (async () => {
    const kv = await bb.storage.kv.get<string>("email_salt");
    if (core === null) return kv ?? (await (async () => { const s = randomUUID(); await bb.storage.kv.set("email_salt", s); return s; })());
    const row = (await core.pool.query("select value from installation where key = 'email.salt'").catch(() => ({ rows: [] as { value: string }[] }))).rows[0];
    if (row) return row.value;
    const s = kv ?? randomUUID();
    await core.pool.query("insert into installation (key, value) values ('email.salt', $1) on conflict (key) do nothing", [s]).catch(() => {});
    return (await core.pool.query("select value from installation where key = 'email.salt'").catch(() => ({ rows: [{ value: s }] }))).rows[0]?.value ?? s;
  })();
  const devClock = async () => new Date(Date.now() + (core ? await regulatorStore(core.pool).clockOffset() : 0) * 1000);
  // Leads and orders (phase 4): signed webhooks and CSV imports; the simulated shop turns simulated clicks into leads.
  const conversions = core === null ? null : createConversions({ core, salt: emailSalt, secretKey: cfg.secretKey || undefined, now: devClock });
  const email = core === null ? null : createEmail({
    pool: core.pool, salt: emailSalt, providers: { resendApiKey: cfg.resendApiKey || undefined, resendWebhookSecret: cfg.resendWebhookSecret || undefined },
    sim: cfg.simEnabled ? { now: devClock, onSent: async (s) => { await conversions?.simShop(s); } } : undefined,
  });
  // Learnings (docs/analytics.md): verdicts and patterns as structured rows, the brief agents read before writing. On the development clock.
  const learnings = core === null ? null : createLearnings({ core, now: devClock, measure: email ? emailMeasure(email) : undefined });
  const learningsCli = createLearningsCli({ core: need, learnings: () => learnings });
  // Costs and the brand's economics: the generation ledger, review minutes, e-mail sends, the profile a person sets.
  const economicsService = core === null ? null : createEconomics({
    core, now: async () => new Date(), conversions: conversions ?? undefined,
    unitPrice: async (provider, campaignId) => { const r = await core!.settings.resolve(campaignId, `${provider}.unitPrice`).catch(() => null); return typeof r?.value === "number" ? r.value : null; },
  });
  const economics = () => { if (!economicsService) throw new Error("Not configured: run infra/bb-instance/provision.sh apply"); return economicsService; };
  const conv = () => { if (!conversions) throw new Error("Not configured: run infra/bb-instance/provision.sh apply"); return conversions; };
  // Paid media (phase 5). Real platforms and ACP payments are adapters still to write; the mock pair comes with the simulated provider.
  const num = async (campaignId: string, key: string) => { const r = await core!.settings.resolve(campaignId, key).catch(() => null); return typeof r?.value === "number" && r.value > 0 ? r.value : null; };
  const media = core === null || economicsService === null ? null : createMedia({
    core, economics: economicsService, conversions: conversions ?? undefined,
    buyers: cfg.simEnabled ? [mockBuyer({ now: async () => new Date() })] : [], payments: cfg.simEnabled ? [mockPayments()] : [],
    limits: async (campaignId) => ({ maxPerOrder: await num(campaignId, "ads.maxPerOrder"), dailyLimit: await num(campaignId, "ads.dailyLimit"), monthlyLimit: await num(campaignId, "ads.monthlyLimit"), currency: (await economicsService.profile.get(campaignId))?.profile.currency ?? null }),
    now: async () => new Date(),
  });
  const ads = () => { if (!media) throw new Error("Not configured: run infra/bb-instance/provision.sh apply"); return media; };
  const resultsCli = createResultsCli({ core: need, economics, conversions: () => conversions });
  // The editor-in-chief regulator (rails, signals, experiments, journal, tasks) and the development clock.
  const regulator = core !== null && email !== null ? createRegulator({ core, email, library: () => emailTemplates.library(), learnings: learnings ?? undefined, conversions: conversions ?? undefined }) : null;
  const editorCli = createEditorCli({
    core: need, regulator: () => regulator,
    autorun: {
      enabled: async (campaignId) => (await need().settings.resolve(campaignId, "editor.autoRun"))?.value === true,
      spawn: async (prompt, campaignId) => { const id = await spawnAgentThread(bb, prompt); await assignThread(id, campaignId); return id; },
      lastRun: async (key) => (await bb.storage.kv.get<number>(key)) ?? null,
      setLastRun: async (key, at) => { await bb.storage.kv.set(key, at); },
    },
  });
  /** Every publishing connector that is switched on. A channel without one waits as "Publish by hand". */
  const allConnectors = () => [...connectorsFrom(cfg), ...(email && email.providers.length > 0 ? [email.connector()] : []), ...(media ? [media.connector()] : [])];
  for (const p of email?.providers ?? []) {
    if (!p.events) continue;
    // the provider signs each call, so the route needs no bb login (a signature failure stores nothing)
    bb.http.route("POST", `/webhooks/email/${p.id}`, async (ctx) => {
      const headers: Record<string, string> = {};
      ctx.req.raw.headers.forEach((value, key) => { headers[key] = value; });
      try {
        const r = await email!.webhook(p.id, { headers, body: await ctx.req.text() });
        return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
      } catch (cause) {
        return new Response(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }), { status: 400, headers: { "content-type": "application/json" } });
      }
    }, { auth: "none" });
  }

  // Conversion sources sign their calls (generic format, docs/analytics.md phase 4), so the route needs no bb login; ?source=<id>.
  bb.http.route("POST", "/webhooks/conversions", async (ctx) => {
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (!conversions) return json(503, { error: "not configured" });
    const source = new URL(ctx.req.raw.url).searchParams.get("source") ?? "";
    const headers: Record<string, string> = {};
    ctx.req.raw.headers.forEach((value, key) => { headers[key] = value; });
    try {
      const r = await conversions.webhook(source, { headers, body: await ctx.req.text() });
      return r.ok ? json(200, r.result) : json(r.status, { error: r.status === 401 ? "bad signature" : "unknown source" });
    } catch (cause) {
      return json(400, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, { auth: "none" });

  const changed = async () => {
    const entries = await need().calendar.list();
    bb.realtime.publish(CALENDAR_CHANGED, { pending: entries.filter((e) => e.status === "pending_approval").length });
  };

  // --- Generation: bb brandwise creative cost|generate|collect (also reachable over MCP `run`) ---
  // The provider, its account and its limits come from the scoped settings of the campaign (core/settings.ts): the campaign, then its
  // always-on base, then global. Spend is counted at every scope of that chain, so a budget set on a base covers all its campaigns.
  type GenJob = { campaignId: string; provider?: string; role: "creative" | "source"; name: string | null; spec: GenSpec; credits: number; startedAt: string; assetId?: string };
  const today = () => new Date().toISOString().slice(0, 10);
  // shortcut: the default data dir of this instance; read it from bb when the SDK offers it
  const PROFILES_DIR = px.join(osx.homedir(), ".bb-brandwise", "providers");
  const host = () => ({ profilesDir: PROFILES_DIR, bins: { higgsfield: cfg.higgsfieldBin } });
  // Spend lives in the cost ledger (Postgres, docs/analytics.md phase 3). The bb KV counter of earlier versions is still read for the
  // day it was written, so a budget is not reset by an upgrade; nothing writes it any more.
  const spendKey = (provider: string, scope: Scope) => `gen_spend:${today()}:${provider}:${scope ?? "global"}`;
  const spentAt = async (provider: string, scope: Scope) => (await economics().spentToday(provider, scope)) + ((await bb.storage.kv.get<number>(spendKey(provider, scope))) ?? 0);
  /** Image or video, as far as the spec tells before the result exists (the result's own kind replaces it). */
  const kindOfSpec = (spec: GenSpec) => (spec.startImage || spec.endImage || spec.videoRefs?.length || spec.audioRefs?.length || spec.params?.duration || /video|veo|kling|seedance|sora|wan|hailuo/i.test(spec.model) ? "video" : "image");
  const scopeName = async (c: Core, scope: Scope) => (scope === null ? "global" : ((await c.campaigns.list()).find((x) => x.id === scope)?.name ?? scope));

  async function costOf(c: Core, spec: GenSpec, scope: Scope, maxArg?: number) {
    const { provider, config } = await c.generation.providerFor(scope, host());
    const credits = await provider.estimate(config, spec);
    const capSet = Number((await c.settings.resolve(scope, `${provider.id}.maxPerGeneration`))!.value);
    const cap = Math.min(maxArg ?? capSet, capSet);
    const budgets = await Promise.all(
      (await c.generation.budgets(scope, provider.id)).map(async (b) => ({ ...b, name: await scopeName(c, b.scope), spent: await spentAt(provider.id, b.scope) })),
    );
    const tight = budgets.reduce((x, y) => (y.limit - y.spent < x.limit - x.spent ? y : x));
    return { provider: provider.id, unit: provider.unit, credits, cap, budgets, spent: tight.spent, daily: tight.limit };
  }
  /** Cost check, then start the job (returns at once). Refuses over the per-call cap or any daily budget of the scope chain. */
  async function startGeneration(c: Core, a: { spec: GenSpec; campaign?: string; role: "creative" | "source"; name: string | null; maxCredits?: number }) {
    const campaign = await c.campaigns.resolve(a.campaign);
    const k = await costOf(c, a.spec, campaign.id, a.maxCredits);
    if (k.credits > k.cap) throw new Error(`Estimated ${k.credits} ${k.unit} is over the limit of ${k.cap} for one generation. Nothing was spent.`);
    for (const b of k.budgets) {
      if (b.spent + k.credits > b.limit) throw new Error(`Daily budget (${b.name}): ${b.spent} of ${b.limit} ${k.unit} already used, this needs ${k.credits}. Nothing was spent.`);
    }
    const { provider, config } = await c.generation.providerFor(campaign.id, host());
    const job = await provider.start(config, a.spec);
    await economics().recordGeneration({ campaignId: campaign.id, provider: provider.id, jobId: job.id, units: k.credits, unit: provider.unit, format: `${kindOfSpec(a.spec)}/${a.spec.model}`, createdBy: "generate" });
    await bb.storage.kv.set(`gen_job:${job.id}`, { campaignId: campaign.id, provider: provider.id, role: a.role, name: a.name, spec: a.spec, credits: k.credits, startedAt: new Date().toISOString() });
    return { jobId: job.id, credits: k.credits, provider: provider.id, unit: provider.unit };
  }
  /** Wait up to waitSeconds for the job; when done, download it and register it as an asset (idempotent per job). */
  async function collectGeneration(c: Core, jobId: string, waitSeconds: number) {
    const meta = await bb.storage.kv.get<GenJob>(`gen_job:${jobId}`);
    if (!meta) throw new Error(`Unknown generation job ${jobId} (only jobs started through this plugin can be collected)`);
    if (meta.assetId) return { state: "done" as const, jobId, status: "completed", credits: meta.credits, asset: await c.assets.get(meta.assetId) };
    const { provider, config } = await c.generation.providerFor(meta.campaignId, host(), meta.provider ?? "higgsfield");
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const job = await provider.get(config, jobId);
      if (isFailed(job.status)) {
        await economics().finishGeneration(provider.id, jobId, { status: "failed" });
        throw new Error(`Generation ${jobId} ended as "${job.status}". ${provider.unit[0].toUpperCase()}${provider.unit.slice(1)} may still have been used.`);
      }
      if (job.status === "completed" && job.resultUrl) {
        const ext = /\.(png|jpe?g|webp|gif|mp4|webm)(?:$|\?)/i.exec(new URL(job.resultUrl).pathname + "?")?.[1]?.toLowerCase() ?? "png";
        const asset = await c.assets.save({
          campaignId: meta.campaignId, bytes: await downloadResult(job.resultUrl), filename: `${slug(meta.name ?? meta.spec.prompt)}.${ext}`,
          role: meta.role, origin: "generated", aiGenerated: true, createdBy: "generate",
          provenance: { tool: provider.id, model: meta.spec.model, jobId, prompt: meta.spec.prompt, aspect: meta.spec.aspect ?? null, resolution: meta.spec.resolution ?? null, refs: (meta.spec.refs ?? []).map((r) => r.split("/").pop()), creditsEstimated: meta.credits },
        });
        await bb.storage.kv.set(`gen_job:${jobId}`, { ...meta, assetId: asset.id });
        await economics().finishGeneration(provider.id, jobId, { status: "done", assetId: asset.id, format: `${asset.kind}/${meta.spec.model}` });
        bb.realtime.publish(ASSETS_CHANGED, {});
        return { state: "done" as const, jobId, status: job.status, credits: meta.credits, asset };
      }
      if (Date.now() >= deadline) return { state: "pending" as const, jobId, status: job.status, credits: meta.credits, asset: null };
      await sleep(2000);
    }
  }

  /** thread id -> campaign id, read from this plugin's namespace on the threads. */
  async function threadCampaigns(threadIds: readonly string[]): Promise<Record<string, string>> {
    const ids = threadIds.slice(0, 200);
    if (ids.length === 0) return {};
    const res: any = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: ids } as never);
    const rows: any[] = Array.isArray(res) ? res : (res.threads ?? res.items ?? []);
    const out: Record<string, string> = {};
    for (const row of rows) {
      const meta = row.metadata ?? row.pluginMetadata ?? row.value ?? {};
      const id = row.threadId ?? row.id;
      if (id && typeof meta[CAMPAIGN_KEY] === "string") out[id] = meta[CAMPAIGN_KEY];
    }
    return out;
  }
  async function assignThread(threadId: string, campaignId: string | null): Promise<void> {
    if (campaignId !== null && !(await need().campaigns.list()).some((c) => c.id === campaignId)) throw new Error(`No campaign with id ${campaignId}`);
    await bb.sdk.threads.updatePluginMetadata((campaignId === null ? { threadId, remove: [CAMPAIGN_KEY] } : { threadId, set: { [CAMPAIGN_KEY]: campaignId } }) as never);
    bb.realtime.publish(THREAD_CAMPAIGN_CHANGED, {});
  }
  async function recentThreads(): Promise<any[]> {
    const res: any = await bb.sdk.threads.list({ limit: 200 } as never);
    return Array.isArray(res) ? res : (res.threads ?? []);
  }

  async function toCreative(c: Core, a: Awaited<ReturnType<Core["assets"]["get"]>>, campaignName: string): Promise<Creative> {
    return {
      id: a.id, name: a.name, campaignId: a.campaignId, campaignName, role: a.role, origin: a.origin, status: a.status,
      aiGenerated: a.aiGenerated, bytes: a.bytes, mime: a.mime, width: a.width, height: a.height, createdAt: a.createdAt,
      // tiles load a small JPEG from the thumb route (browser caches and lazy-loads them); the preview dialog fetches the full image itself
      // video: same-origin stream route below (no S3 URL in the page)
      dataUri: a.mime.startsWith("video/") ? mediaUrl(a.id) : null,
      thumb: thumbUrl(a.id),
    };
  }
  async function listCreatives(): Promise<Creative[]> {
    const c = need();
    const names = new Map((await c.campaigns.list()).map((p) => [p.id, p.name]));
    const rows = (await c.assets.list()).filter((a) => a.role === "creative" && (a.kind === "image" || a.kind === "video")).slice(0, MAX_CREATIVES);
    return Promise.all(rows.map((a) => toCreative(c, a, names.get(a.campaignId) ?? "")));
  }
  async function creativeById(id: string): Promise<Creative> {
    const c = need();
    const a = await c.assets.get(id);
    return toCreative(c, a, (await c.campaigns.list()).find((p) => p.id === a.campaignId)?.name ?? "");
  }

  const video = createVideo({
    bb, need, enginePath: () => cfg.videoEnginePath, assetsChanged: () => bb.realtime.publish(ASSETS_CHANGED, {}),
  });

  const emailTemplates = createEmailTemplates({ need, email: () => email, enginePath: () => cfg.emailEnginePath, chromePath: () => cfg.chromePath, videoEnginePath: () => cfg.videoEnginePath, publicAssets: () => (cfg.publicAssetBucket && cfg.publicAssetBaseUrl ? { bucket: cfg.publicAssetBucket, baseUrl: cfg.publicAssetBaseUrl } : null) });
  const agents = createAgents({ bb, need, video: video.agentContext, email: emailTemplates.agentContext, assignThread });

  // Display mode: applied once per change of the setting, on `mode set` / the Settings switch, and on `mode apply`.
  const allowed = allowedModes();
  const pickAllowed = (m: string): ModeName => (isModeName(m) && allowed.includes(m) ? m : allowed.includes("full") ? "full" : allowed[0]);
  let wantedMode: ModeName = pickAllowed(cfg.mode);
  let lastChanges: string[] = [];
  let modeError: string | null = null;
  // One apply at a time: applying enables/disables plugins, which makes the host reload this plugin, and the
  // reloaded copy runs syncMode again. Serializing plus "persist first" (see setMode) stops the two from fighting.
  let queue: Promise<void> = Promise.resolve();
  function syncMode(force = false): Promise<void> {
    const run = async () => {
      try {
        const done = await appliedMode(bb);
        if (!force && done.mode === wantedMode && done.defHash === defHashOf(wantedMode)) return; // same mode, same definition
        lastChanges = await applyMode(bb, wantedMode);
        modeError = null;
        bb.log.info(`mode ${wantedMode}: ${lastChanges.join(", ") || "no changes"}`);
      } catch (cause) {
        modeError = cause instanceof Error ? cause.message : String(cause);
        bb.log.error(`mode ${wantedMode} failed: ${modeError}`);
      }
      bb.realtime.publish(MODE_CHANGED, {});
    };
    queue = queue.then(run, run);
    return queue;
  }
  async function setMode(name: string): Promise<void> {
    if (!isModeName(name) || !allowed.includes(name)) throw new Error(`Mode "${name}" is not available here (allowed: ${allowed.join(", ")}; set by BW_MODES)`);
    // Persist FIRST. Applying reloads this plugin, and a reloaded copy takes its mode from the setting: if the setting
    // still held the old mode it would apply that one again (this flipped Full back to Minimal). The write fires onChange below.
    await settings.experimental_set({ mode: name });
    wantedMode = name;
    await syncMode(); // waits for the apply the write already queued; no-op when it has run
    if (modeError !== null) throw new Error(modeError);
  }
  // The Select in the plugin's settings form, the buttons, `bb plugin config ... set mode` and provisioning all end up here.
  settings.onChange((next) => {
    const picked = pickAllowed(next.mode);
    if (picked === wantedMode) return;
    wantedMode = picked;
    void syncMode();
  });
  const modeView = async () => ({
    mode: wantedMode, label: MODES[wantedMode].label, description: MODES[wantedMode].description, css: MODES[wantedMode].css,
    allowed: allowed.map((name) => ({ name, label: MODES[name].label, description: MODES[name].description })),
    locked: allowed.length === 1, lastChanges, error: modeError,
  });

  // Streams a creative video from the private bucket, same-origin, with Range so the player can seek.
  // shortcut: reads the whole object per request, fine for a few-MB local clips; stream ranges from S3 when files get large.
  // 480 px JPEG of an image or of a video's first frame, made with ffmpeg once and cached on disk
  bb.http.route("GET", "/thumb", async (ctx) => {
    const id = ctx.req.query("id") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("bad id", { status: 400 });
    const c = need();
    const a = await c.assets.get(id).catch(() => null);
    if (a === null || !(a.mime.startsWith("video/") || a.mime.startsWith("image/"))) return new Response("not found", { status: 404 });
    const cache = px.join(osx.tmpdir(), "bw-thumbs");
    const file = px.join(cache, `${id}.jpg`);
    if (!fsx.existsSync(file)) {
      fsx.mkdirSync(cache, { recursive: true });
      const src = px.join(cache, `${id}.src`);
      fsx.writeFileSync(src, await c.assets.read(id));
      try {
        await new Promise<void>((resolve, reject) => cp.execFile("ffmpeg", ["-v", "error", "-y", ...(a.mime.startsWith("video/") ? ["-ss", "0.3"] : []), "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", file], (e) => (e ? reject(e) : resolve())));
      } catch { return new Response("no thumbnail (is ffmpeg installed?)", { status: 404 }); } finally { fsx.rmSync(src, { force: true }); }
    }
    return new Response(new Uint8Array(fsx.readFileSync(file)), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
  });
  bb.http.route("GET", "/media", async (ctx) => {
    const id = ctx.req.query("id") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("bad id", { status: 400 });
    const c = need();
    const a = await c.assets.get(id).catch(() => null);
    if (a === null || a.role !== "creative" || !a.mime.startsWith("video/")) return new Response("not found", { status: 404 });
    const buf = await c.assets.read(id);
    const len = buf.length;
    const m = /^bytes=(\d*)-(\d*)$/.exec(ctx.req.header("range") ?? "");
    let start = 0, end = len - 1;
    if (m !== null && m[1] !== "") { start = Number(m[1]); if (m[2] !== "") end = Math.min(Number(m[2]), len - 1); }
    else if (m !== null && m[2] !== "") start = Math.max(0, len - Number(m[2]));
    if (start > end || start >= len) return new Response(null, { status: 416, headers: { "content-range": `bytes */${len}` } });
    return new Response(new Uint8Array(buf.subarray(start, end + 1)), {
      status: m === null ? 200 : 206,
      headers: {
        "content-type": a.mime, "accept-ranges": "bytes", "content-length": String(end - start + 1),
        ...(m === null ? {} : { "content-range": `bytes ${start}-${end}/${len}` }), "cache-control": "private, max-age=300",
      },
    });
  });
  bb.rpc.register(rpcContract, {
    campaigns_list: async () => ({ campaigns: await need().campaigns.list() }),
    ...video.rpc,
    ...emailTemplates.rpc,
    ...agents,
    calendar_list: async () => ({ entries: await need().calendar.list() }),
    calendar_add: async (input) => {
      const entry = await need().calendar.add({ ...input, createdBy: "ui" });
      await changed();
      return entry;
    },
    calendar_decide: async ({ id, decision, reviewSeconds }) => {
      const entry = await need().calendar.decide(id, decision, "ui", reviewSeconds ?? null);
      await changed();
      return entry;
    },
    calendar_update: async ({ id, ...patch }) => {
      const entry = await need().calendar.update(id, patch, "ui");
      await changed();
      return entry;
    },
    calendar_unapprove: async ({ id }) => {
      const entry = await need().calendar.unapprove(id, "ui");
      await changed();
      return entry;
    },
    calendar_request_changes: async ({ id, note, reason, reviewSeconds }) => {
      const entry = await need().calendar.requestChanges(id, note, { actor: "ui", reason: reason ?? null, reviewSeconds: reviewSeconds ?? null });
      await changed();
      return entry;
    },
    entry_learnings: async ({ id }) => {
      if (!learnings) throw new Error("Not configured");
      const info = await learnings.forEntry(id);
      const entry = await need().calendar.get(id);
      const e = entry?.experimentId && regulator ? await regulator.store.experiment(entry.experimentId) : null;
      const mo = entry?.channel === "ads" && media ? await media.order(id) : null;
      return {
        ...info,
        media: mo ? { action: mo.action, budget: mo.budget, currency: mo.currency, days: mo.days, status: mo.status, platform: mo.platform, payment: mo.prepaid ? "prepaid account" : mo.payment, boostOf: mo.boostOf } : null,
        experiment: e ? { id: e.id, hypothesis: e.hypothesis, lever: e.lever ? `${e.lever.attribute}: ${e.lever.from} -> ${e.lever.to}` : null, variant: entry!.variant, round: (e.rounds.find((r) => r.armA === id || r.armB === id)?.round) ?? 1, plannedRounds: e.plannedRounds, expectedLift: e.expectedLift, mde: e.mde, status: e.status, verdict: e.verdict } : null,
      };
    },
    learnings_list: async ({ campaignId }) => {
      if (!learnings) throw new Error("Not configured");
      return { learnings: (await learnings.list(campaignId)).map((l) => ({ id: l.id, scope: l.scope, kind: l.kind, evidence: l.evidence, result: l.result, statement: l.statement, channel: l.channel, status: l.status, effectiveStatus: l.effectiveStatus, contrary: l.contrary, createdBy: l.createdBy, confirmedBy: l.confirmedBy, decidedAt: l.decidedAt, sourceIds: l.sourceIds })) };
    },
    results_costs: async ({ campaignId, sinceDays }) => {
      const e = economics();
      return { report: { costs: await e.costs(campaignId, { sinceDays }), formats: await e.formats(campaignId, { sinceDays: Math.max(sinceDays, 90) }), production: await e.production(campaignId, { sinceDays: Math.max(sinceDays, 90) }) } };
    },
    economics_get: async ({ campaignId }) => ({ economics: await economics().economics(campaignId) }),
    results_funnel: async ({ campaignId, sinceDays }) => ({ funnel: await economics().funnel(campaignId, { sinceDays }) }),
    ads_results: async ({ campaignId }) => ({ ads: await ads().results(campaignId) }),
    ads_target: async ({ campaignId }) => ({ target: await need().channels.get(campaignId, "ads"), ...ads().options() }),
    ads_target_set: async ({ campaignId, target }) => { await ads().setTarget(campaignId, target); return { ok: true }; },
    conversion_sources: async ({ campaignId }) => ({ sources: (await conv().sources.list(campaignId)).map((s) => ({ id: s.id, name: s.name, adapter: s.adapter, received: s.received, createdAt: s.createdAt })) }),
    conversion_source_add: async ({ campaignId, name, adapter }) => {
      const r = await conv().sources.create({ campaignId, name, adapter, createdBy: "ui" });
      return { id: r.source.id, secret: r.secret, path: `/api/v1/plugins/brandwise/http/webhooks/conversions?source=${r.source.id}` };
    },
    conversion_import: async ({ sourceId, csv, mapping, kind }) => ({ result: await conv().importCsv(sourceId, csv, mapping, { kind }) }),
    promo_set: async ({ code, campaignId }) => { await conv().promo(code, campaignId); return { ok: true }; },
    economics_set: async ({ campaignId, profile }) => { await economics().profile.set(campaignId, profile, "ui"); return { ok: true }; },
    cost_add: async ({ campaignId, kind, amount, ref, note, entryId }) => { await economics().addCost({ campaignId, kind, amount, ref, note, entryId: entryId ?? null, createdBy: "ui" }); return { ok: true }; },
    learning_set_status: async ({ id, action }) => {
      if (!learnings) throw new Error("Not configured");
      if (action === "confirm") await learnings.confirm(id, "ui"); else await learnings.retire(id, "ui");
      return { ok: true };
    },
    thread_campaigns: async ({ threadIds }) => ({ map: await threadCampaigns(threadIds) }),
    thread_set_campaign: async ({ threadId, campaignId }) => {
      await assignThread(threadId, campaignId);
      return { ok: true };
    },
    campaigns_overview: async () => {
      const c = need();
      const [campaigns, entries, assets, threads] = await Promise.all([c.campaigns.list(), c.calendar.list(), c.assets.list(), recentThreads()]);
      const byThread = await threadCampaigns(threads.map((t) => t.id));
      const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
      const nEntries = count(entries.map((e) => e.campaignId));
      const nCreatives = count(assets.filter((a) => a.role === "creative").map((a) => a.campaignId));
      const nThreads = count(Object.values(byThread));
      return { campaigns: campaigns.map((x) => ({ ...x, threads: nThreads[x.id] ?? 0, entries: nEntries[x.id] ?? 0, creatives: nCreatives[x.id] ?? 0 })) };
    },
    campaign_threads: async () => {
      const threads = await recentThreads();
      const byThread = await threadCampaigns(threads.map((t) => t.id));
      const rows = threads
        .filter((t) => byThread[t.id] !== undefined)
        .map((t) => ({ id: t.id, title: t.title ?? t.titleFallback ?? "Untitled", campaignId: byThread[t.id] ?? null, updatedAt: String(t.updatedAt ?? ""), status: String(t.status ?? "") }));
      return { threads: rows, unassigned: threads.length - rows.length };
    },
    campaign_add: async (input) => {
      const created = await need().campaigns.add(input);
      bb.realtime.publish(CAMPAIGNS_CHANGED, {});
      return created;
    },
    creatives_list: async () => ({ creatives: await listCreatives() }),
    creatives_get: async ({ ids }) => {
      const c = need();
      const names = new Map((await c.campaigns.list()).map((p) => [p.id, p.name]));
      // by id, not through listCreatives(): that list is capped, a chat reference must never miss an older creative
      const rows = await Promise.all(ids.map((id) => c.assets.get(id).catch(() => null)));
      const found = rows.filter((a): a is NonNullable<typeof a> => a !== null && (a.kind === "image" || a.kind === "video")); // any role: previews and references are shown when asked for by id
      return { creatives: await Promise.all(found.map((a) => toCreative(c, a, names.get(a.campaignId) ?? ""))) };
    },
    creatives_full: async ({ id }) => {
      const c = need();
      const a = await c.assets.get(id);
      if (a.mime.startsWith("video/")) return { dataUri: mediaUrl(id) }; // field is the media src
      if (a.bytes > MAX_PREVIEW_BYTES) throw new Error(`${Math.round(a.bytes / 1e6)} MB is too large to preview here; use: bb brandwise assets url ${id}`);
      return { dataUri: `data:${a.mime};base64,${(await c.assets.read(id)).toString("base64")}` };
    },
    mcp_info: async () => {
      const listed: any = await bb.sdk.plugins.list();
      const plugin = (Array.isArray(listed) ? listed : listed.plugins).find((p: { id: string }) => p.id === "bb--mcp");
      const base = bb.server.loopbackBaseUrl;
      const app = bb.server.experimental_appUrl; // set from BB_APP_URL (provisioning sets it when the tailnet is published)
      const path = "/api/v1/plugins/bb--mcp/http/mcp";
      return {
        enabled: plugin?.enabled === true, status: plugin ? String(plugin.status) : "not installed",
        localUrl: `${base}${path}`, serverUrl: base, daemonPort: process.env.BB_HOST_DAEMON_PORT ?? null,
        tailnetUrl: app ? `${app.replace(/\/$/, "")}${path}` : null,
      };
    },
    config_get: async ({ campaignId }) => {
      const c = need();
      const chain = await c.settings.chain(campaignId);
      const groups: ConfigView["groups"] = [];
      for (const v of await c.settings.view(campaignId)) {
        let g = groups.find((x) => x.title === v.field.group);
        if (!g) groups.push((g = { title: v.field.group, fields: [] }));
        g.fields.push({
          key: v.field.key, label: v.field.label, description: v.field.description ?? null, type: v.field.type, secret: v.field.secret === true,
          options: v.field.options ?? null, value: v.value, isSet: v.isSet, widget: v.field.widget ?? null,
          source: v.source === "default" || v.source === "unset" ? v.source : v.source === campaignId ? "here" : "inherited",
          sourceName: v.source === "default" || v.source === "unset" || v.source === campaignId ? null : await scopeName(c, v.source),
        });
      }
      return { scopeName: await scopeName(c, campaignId), inheritsFrom: await Promise.all(chain.slice(1).map((s) => scopeName(c, s))), groups };
    },
    config_set: async ({ campaignId, key, value }) => {
      const c = need();
      if (value === null) await c.settings.unset(campaignId, key);
      else await c.settings.set(campaignId, key, value);
      bb.realtime.publish(CONFIG_CHANGED, {});
      return { ok: true as const };
    },
    instagram_status: async ({ campaignId }) => {
      const c = need();
      const saved = await c.settings.resolve(campaignId, "download.instagramSession");
      if (saved !== undefined && saved.scope !== "default") {
        return { state: "saved" as const, from: saved.scope === campaignId ? "here" : await scopeName(c, saved.scope), browser: null };
      }
      const browser = await cookiesFor(c, campaignId);
      return browser ? { state: "browser" as const, from: null, browser } : { state: "none" as const, from: null, browser: null };
    },
    instagram_import: async ({ campaignId, browser }) => {
      const c = need();
      await c.settings.set(campaignId, "download.instagramSession", await readBrowserSession(browser));
      bb.realtime.publish(CONFIG_CHANGED, {});
      return { ok: true as const };
    },
    instagram_test: async ({ campaignId }) => instagramTest(need(), campaignId),
    providers_status: async ({ campaignId }) => {
      const c = need();
      return {
        providers: await Promise.all(PROVIDERS.map(async (p) => {
          const { provider, config } = await c.generation.providerFor(campaignId, host(), p.id);
          const auth = await provider.status(config);
          let loginHint = "";
          try { loginHint = provider.loginHint(config); } catch { /* an invalid profile name is reported by status */ }
          return { id: provider.id, label: provider.label, ok: auth.ok, detail: auth.detail, loginHint };
        })),
      };
    },
    settings_get: async () => {
      const values = cfg as Record<string, string | number | boolean | undefined>;
      return {
        sections: SECTIONS.map((sec) => ({
          id: sec.id, title: sec.title, description: sec.description,
          fields: Object.entries(sec.fields as Record<string, PluginSettingDescriptor>).map(([key, f]) => {
            const secret = "secret" in f && f.secret === true;
            const v = values[key];
            return {
              key, label: f.label, description: f.description ?? null, type: f.type === "project" ? ("string" as const) : f.type, secret,
              options: f.type === "select" ? f.options.map((value) => ({ value, label: f.experimental_optionLabels?.[value] ?? value })) : null,
              value: secret ? null : (v ?? null), isSet: v !== undefined && v !== "",
            };
          }),
        })),
      };
    },
    settings_set: async ({ key, value }) => {
      const f = SECTIONS.flatMap((sec) => Object.entries(sec.fields as Record<string, PluginSettingDescriptor>)).find(([k]) => k === key)?.[1];
      if (f === undefined) throw new Error(`Unknown setting ${key}`);
      // null puts the default back; secrets can be replaced or cleared here, never read
      const valid =
        value === null ||
        (f.type === "number" ? typeof value === "number" && Number.isFinite(value)
          : f.type === "boolean" ? typeof value === "boolean"
          : typeof value === "string" && (f.type !== "select" || f.options.includes(value)));
      if (!valid) throw new Error(`Invalid value for ${key}`);
      await settings.experimental_set({ [key]: value } as never);
      bb.realtime.publish(SETTINGS_CHANGED, {});
      return { ok: true as const };
    },
    mode_get: modeView,
    mode_set: async ({ mode }) => {
      await setMode(mode);
      return modeView();
    },
    creatives_upload: async ({ campaignId, filename, dataBase64 }) => {
      const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
      if (!IMAGE_EXT.has(ext)) throw new Error(`Unsupported file type ${ext || "(none)"}; use png, jpg, webp or gif`);
      const bytes = Buffer.from(dataBase64, "base64");
      if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`File is ${Math.round(bytes.length / 1e6)} MB, the limit is ${MAX_UPLOAD_BYTES / 1e6} MB`);
      const a = await need().assets.save({ campaignId, bytes, filename, role: "creative", origin: "uploaded", createdBy: "ui" });
      bb.realtime.publish(ASSETS_CHANGED, {});
      return creativeById(a.id);
    },
    creatives_update: async ({ id, name, status }) => {
      await need().assets.update(id, { name, status });
      bb.realtime.publish(ASSETS_CHANGED, {});
      return creativeById(id);
    },
    creatives_delete: async ({ id }) => {
      await need().assets.delete(id);
      bb.realtime.publish(ASSETS_CHANGED, {});
      return { deleted: true };
    },
  });

  /**
   * Who did it, as recorded in the entry's history: always "cli" or "cli:<label>" from the CLI. `--as` is a label agents give
   * themselves, not an identity, so it can never claim a reserved actor ("ui" is a person on a page, "auto" and "scheduler" are code).
   */
  const RESERVED_ACTORS = new Set(["ui", "auto", "scheduler", "regulator", "miner", "promotion"]);
  const cliActor = (args: string[]) => {
    const label = val(args, "--as")?.trim();
    if (!label) return "cli";
    if (RESERVED_ACTORS.has(label.toLowerCase())) throw new Error(`--as ${label} is reserved: it names a person on a page or the system`);
    return `cli:${label.slice(0, 40)}`;
  };
  /** `--brief-id`, `--applies`, `--tests`, `--tag` of calendar add/edit: what the entry was written from (learnings). */
  async function attachFromArgs(entryId: string, args: string[]) {
    const ids = (flag: string) => val(args, flag)?.split(",").map((x) => x.trim()).filter(Boolean);
    const input = { briefId: val(args, "--brief-id"), applies: ids("--applies"), tests: ids("--tests"), tags: val(args, "--tag") };
    if (!learnings || Object.values(input).every((v) => v === undefined)) return null;
    return learnings.attach(entryId, { ...input, tagSource: "agent" });
  }

  const usage = [
    "Usage:",
    "  bb brandwise campaign channel set <channel> <key>=<value>... | unset <channel> | list [--campaign <c>]   (where the campaign publishes, e.g. telegram chatId=@mychannel; a parent campaign's target applies when the campaign has none)",
    "  bb brandwise campaign list|add <name> --kind <always_on|campaign> [--parent <campaign>] [--from <date>] [--to <date>]",
    "  bb brandwise campaign assign <thread-id> <campaign> | campaign unassign <thread-id>   (link a bb thread to a campaign)",
    "  bb brandwise calendar list [--campaign <c>]",
    "  bb brandwise calendar add <title> --channel <c> --at <ISO date> --tier <1|2|3> [--campaign <c>] [--asset <id>] [--body <text>] [--link <url>] [--brief-id <id> --applies <ids> --tests <id> --tag key=value,...]   (cite the brief you wrote from and the learnings you apply)",
    "  bb brandwise calendar edit <id> [--title <t>] [--body <text>] [--link <url>] [--channel <c>] [--at <ISO date>] [--asset <id>] [--brief-id ... --applies ... --tests ... --tag ...]",
    "  bb brandwise calendar request-changes <id> <note> [--reason claims|facts|tone|brand|visual|legal|typo|offer|other]",
    "  bb brandwise calendar history <id>   (every action on the entry: who, when, the send-back notes)",
    "  bb brandwise brief --campaign <c> [--channel <ch>] [--at <ISO>]   (read before writing: learnings in force, what not to re-test, candidates, the reviewer's rules, explore or exploit slot)",
    "  bb brandwise learnings list [--campaign <c>] [--status active|needs_retest|proposed|superseded|retired] [--kind performance|null_result|reviewer_preference] [--evidence E1|E2|E3] | show <id>",
    "  bb brandwise learnings add \"<observation>\" [--lever \"attribute: from -> to\"] [--channel <ch>] [--campaign <c>]   (agents: E3 only, a candidate to test)",
    "  bb brandwise learnings propose-preference \"<rule>\" --from-entries <sent-back entry ids> [--campaign <c>]   (a rule drawn from a person's send-backs; in force once a person confirms it)",
    "  bb brandwise ads order --name \"...\" --budget <n> --days <n> --at <ISO> [--body \"<ad text>\"] [--link <url>] [--asset <id>] [--boost <published entry>] [--order <live order entry> (budget change)] [--currency EUR] [--campaign <c>]   (a tier-3 entry a person approves; refused at once over the ads limits, checked again before payment)",
    "  bb brandwise ads list [--campaign <c>] | pause <entry> | pull   (per ad: spend, CTR, CPC, frequency, fatigue, CPL and ROAS on our leads; pull is run hourly by a bb automation)",
    "  bb brandwise results funnel [--campaign <c>] [--since 30d]   (leads, qualified, won, orders and revenue as attribution ranges; CPL, CPQL, CAC and MER next to the profile's ceilings)",
    "  bb brandwise results sources [--campaign <c>]   (the brand's lead sources and how much each received; adding one and importing are a person's, on the Results page)",
    "  bb brandwise results costs|formats|production|economics [--campaign <c>] [--since 30d]   (read-only: what the campaign cost at the brand's prices, cost per approved asset per format, first-pass approval and send-back reasons, the profile's ceilings; setting the profile and stating costs is a person's, on the Results page)",
    "  bb brandwise learnings mine [--campaign <c>]   (E2 patterns over matured entries; run weekly by a bb automation, silent when nothing is new)",
    "  bb brandwise calendar unapprove <id>   (upcoming approved entry back to pending_approval; entries whose time has passed accept no action)",
    "  bb brandwise calendar approve|cancel <id>",
    "  bb brandwise editor signals [--campaign <c>] [--as-of <ISO>]   (what the editor sees: goals, smoothed rates, experiments, what is allowed now)",
    "  bb brandwise editor experiments list | propose --a <entry> --b <entry> --hypothesis \"...\" --lever \"attribute: from -> to\" --expected-lift <0.3> [--rounds n] [--metric click_rate|lead_rate] | add-round <id> --a <entry> --b <entry> | evaluate <id> | backfill   (A/B on e-mail, registered before the first send; the rails judge, nobody can overrule; an untestable lift or a lever with a standing null result is refused)",
    "  bb brandwise editor journal read [--limit n] | write \"<text>\" [--kind note]",
    "  bb brandwise editor tasks list [--status s] | create --kind <k> --brief \"...\" [--params '<json>'] | claim <id> | submit <id> --subject \"...\" [--content '<json slots to change>'] [--brief-id <id>] [--applies <ids>] [--tests <id>] | complete <id> [--result '<json>']",
    "  bb brandwise editor autorun   (run by a bb automation: starts the editor or the author only on campaigns with editor.autoRun and only when they have work; silent otherwise)",
    "  bb brandwise editor goals [set <metric> <value> --kind target|limit] | unfreeze   (goals and unfreeze are a person's commands)",
    "  bb brandwise sim status | advance <90m|24h|2d> | reset   (development clock for the simulated provider)",
    "  bb brandwise email brand [set --brand '<json>' | --file <f>] | component [set <name> --file <full path of an .mjml file> or --mjml '<inline mjml>' | remove <name>]   (the client's brand kit and MJML components, inherited by child campaigns; add --campaign <c>)",
    "  bb brandwise email template publish <id> [--note \"...\"] | versions <id> | links <id>   (immutable versions; entries use a published version)",
    "  bb brandwise email entry create --template <id> [--version n] --at <ISO> --tier <1|2|3> --content '<json>' [--locale cs] [--campaign <c>] | bind <entry-id> --template <id> --content '<json>' | show <entry-id>",
    "  bb brandwise email template seed <id> | list | render <id> [--target preview|resend] [--raw] | lint <id> | preview <id> [--width 640] | send-test <id> --to <address> [--provider <id>]   (e-mail templates: MJML layout, slots, brand; add --campaign <c>; preview writes a PNG you can open)",
    "  bb brandwise email stats <entry-id> | --campaign <c>   (opens, clicks, bounces... of sent e-mail campaigns, the same for every provider)",
    "  bb brandwise email ingest --provider <id> --file <payload.json>   (replay a saved webhook payload)",
    "  bb brandwise calendar run-due [--limit N]   (publish approved entries whose time has come; run every minute by a bb automation, prints nothing when nothing is due)",
    "  bb brandwise assets add <file> [--campaign <c>] [--role creative|source|brand|reference] [--origin generated|uploaded|imported] [--ai] [--provenance <json>]",
    "  bb brandwise instagram test [--campaign <c>]   (does Instagram accept the session this campaign downloads with; the user connects Instagram in Settings, you never do)",
    "  bb brandwise doctor [--campaign <c>]   (are the host tools there: yt-dlp, gallery-dl, ffmpeg, higgsfield; is the database configured)",
    "  bb brandwise config list [--campaign <c>] | config set <key> <value> [--campaign <c>] | config unset <key> [--campaign <c>]   (provider, account and limits; a campaign overrides its base, which overrides global; no --campaign = global; operator only, agents never change limits or accounts)",
    "  bb brandwise providers status [--campaign <c>]   (is the account of that scope signed in; prints the sign-in command)",
    "  bb brandwise assets download-photos <instagram profile or post url> [--campaign <c>] [--limit 12]    (photos, not videos; Instagram shows them to signed-in sessions only, so the user must have picked a browser session under Settings > Providers > Downloads; max 40; saved as reference assets, prints local paths)",
    "  bb brandwise assets list [--campaign <c>] | assets url <id> [--seconds 300]",
    "  bb brandwise assets download <url> [--campaign <c>]    (Instagram, TikTok, YouTube; runs on the host outside your sandbox, with the browser session the user picked under Settings > Providers > Downloads, if any; saved as a reference asset, prints its local path)",
    "  bb brandwise assets rename <id> <name> | assets set <id> --status <draft|linted|approved|archived> | assets delete <id>",
    "  bb brandwise creative models [--video|--image] [--campaign <c>] | creative model <model-id> [--campaign <c>]   (which models exist, and the parameters and media one model takes)",
    "  bb brandwise creative cost --prompt <text> [--campaign <c>] [--model nano_banana_pro] [--aspect 4:5] [--resolution 2k] [media and parameters as in generate]   (estimate, spends nothing)",
    "  bb brandwise creative generate --prompt <text> [--model ..] [--aspect ..] [--resolution ..] [--campaign <c>] [--role creative|source] [--name <n>] [--ref <image>]... [--start-image <image>] [--end-image <image>] [--video-ref <file>]... [--audio-ref <file>]... [--duration <n>] [--param name=value]... [--max-credits N] [--wait-seconds 18]   (which media and parameters a model takes: creative model <id>)",
    "  bb brandwise creative collect <job-id> [--wait-seconds 18]   (finish a generation that was still running)",
    "  bb brandwise product list|get [<file>]|set <file> (--body <text> | --file <path>) [--campaign <c>]   (product pack: product.md audience.md claims.md constraints.md voice.md derived/<name>.md; shared by the always-on base)",
    "  bb brandwise video seed --dir <empty dir>   (copy the example Remotion project to start from; or --template <id> --campaign <c> = the campaign's project folder, which the Video page opens in Remotion Studio)",
    "  bb brandwise video studio --template <id> [--campaign <c>] [--stop]   (Remotion Studio for that project, 127.0.0.1 only)",
    "  bb brandwise video compositions --dir <project>   (ids, size, duration and defaultProps of each composition)",
    "  bb brandwise video preview --dir <project> [--composition <id>] [--props '<json>' | --props-file <f>] [--frame N] [--campaign <c>]   (one still frame)",
    "  bb brandwise video render --dir <project> [--composition <id>] [--props '<json>' | --props-file <f>] [--campaign <c>] [--name <n>] [--wait-seconds 18]",
    "  bb brandwise video collect <job-id> [--wait-seconds 18]   (props: <name>Asset=<asset id> becomes <name>Url)",
    "  bb brandwise mode [apply | set <name>]   (show the display mode and what it changed; apply re-applies it; set switches it)",
    "  <c> is a campaign id or name; it may be omitted when there is exactly one campaign. All commands take --json.",
  ].join("\n");
  const vals = (argv: string[], name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const val = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const FLAGS_WITH_VALUE = new Set(["--kind", "--parent", "--from", "--to", "--campaign", "--channel", "--at", "--tier", "--asset", "--role", "--origin", "--provenance", "--seconds", "--status", "--prompt", "--model", "--aspect", "--resolution", "--max-credits", "--name", "--ref", "--wait-seconds", "--dir", "--props", "--props-file", "--frame", "--template", "--composition", "--title", "--body", "--link", "--file", "--provider", "--cookies", "--start-image", "--end-image", "--video-ref", "--audio-ref", "--duration", "--param", "--limit", "--a", "--b", "--hypothesis", "--as-of", "--brief", "--params", "--result", "--as", "--subject", "--target", "--width", "--note", "--content", "--content-file", "--locale", "--version", "--brand", "--mjml", "--lever", "--brief-id", "--applies", "--tests", "--tag", "--reason", "--from-entries", "--evidence", "--expected-lift", "--rounds", "--since", "--metric", "--budget", "--days", "--boost", "--order", "--currency"]);
  const KNOWN_FLAGS = new Set([...FLAGS_WITH_VALUE, "--json", "--ai", "--stop", "--video", "--image", "--raw"]);
  /** Positional args = argv without flags and their values. */
  const positional = (argv: string[]) => argv.filter((a, i) => !a.startsWith("--") && !FLAGS_WITH_VALUE.has(argv[i - 1] ?? ""));
  const fmtEntry = (e: { id: string; scheduledAt: string; channel: string; tier: number; status: string; campaignName: string; title: string; reviewNote?: string | null }) =>
    `${e.id}  ${e.scheduledAt.slice(0, 16)}  ${e.channel.padEnd(10)} T${e.tier}  ${e.status.padEnd(18)} [${e.campaignName}] ${e.title}` +
    (e.status === "changes_requested" && e.reviewNote ? `\n    changes requested: ${e.reviewNote}` : "");

  // Sandboxed agents cannot reach Instagram, TikTok or YouTube; the plugin server can, so downloads run here (yt-dlp, no shell).
  const SOCIAL_HOSTS = ["instagram.com", "tiktok.com", "youtube.com", "youtu.be"];
  const COOKIE_BROWSERS = ["chrome", "safari", "firefox", "brave", "edge"];
  /** The browser session downloads use: a setting the user makes (download.cookiesBrowser), never an argument of a call. */
  const cookiesFor = async (c: Core, scope: Scope): Promise<string | undefined> => {
    const v = String((await c.settings.resolve(scope, "download.cookiesBrowser"))?.value ?? "none");
    return v === "none" ? undefined : v;
  };
  /** What a download is signed in with: a saved Instagram session id (written to a private cookie file for the call only) wins over a browser's session. */
  type Session = { browser?: string; cookiesFile?: string };
  async function withSession<T>(c: Core, scope: Scope, use: (s: Session) => Promise<T>): Promise<T> {
    const saved = (await c.settings.resolve(scope, "download.instagramSession"))?.value;
    if (typeof saved !== "string" || saved === "") return use({ browser: await cookiesFor(c, scope) });
    const jar = cookieJarFor(saved); // what was saved: the browser's cookies, a cookies.txt or a sessionid; throws a readable error when unusable
    const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "bw-session-"));
    const file = px.join(dir, "cookies.txt");
    fsx.writeFileSync(file, jar, { mode: 0o600 });
    try { return await use({ cookiesFile: file }); } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
  }
  const hostEnv = () => ({ ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` });
  const INSTAGRAM_PROBE = "https://www.instagram.com/instagram/posts/"; // a public profile Instagram only shows to signed-in sessions
  /** Does Instagram accept this session. Lists one post URL, downloads nothing. */
  const probeInstagram = (session: Session) =>
    new Promise<{ ok: boolean; detail: string }>((resolve) =>
      cp.execFile("gallery-dl", ["--range", "1", "-g", ...sessionArgs(session), "--", INSTAGRAM_PROBE], { env: hostEnv(), timeout: 90_000, maxBuffer: 1 << 20 }, (e, out, err) => {
        if (!e && out.trim() !== "") return resolve({ ok: true, detail: "Instagram accepted the session." });
        if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve({ ok: false, detail: "gallery-dl is not installed on this host (brew install gallery-dl)" });
        const why = String(err || e?.message || "no answer").trim().split("\n").slice(-1)[0];
        resolve({ ok: false, detail: /not ?found|redirect|login|401|403|cookie/i.test(why) ? `Instagram did not accept the session: there is none, it expired or it was signed out. (gallery-dl said: ${why})` : why });
      }),
    );
  /** Tests the session a scope downloads with; when Instagram refuses it, says what the saved value is and what to try. The value is never shown. */
  async function instagramTest(c: Core, scope: Scope) {
    const saved = (await c.settings.resolve(scope, "download.instagramSession"))?.value;
    let r: { ok: boolean; detail: string };
    try {
      r = await withSession(c, scope, (session) => probeInstagram(session));
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    if (r.ok || typeof saved !== "string" || saved === "") return r;
    const bare = !saved.includes("=") && !saved.includes("\t");
    return {
      ok: false,
      detail: `${r.detail} ${bare
        ? "Only a sessionid is saved. Instagram often refuses that on another device, because it also looks at the device cookies of the browser (mid, ig_did...). Save all cookies of instagram.com instead: paste the whole cookie: request header."
        : "Cookies are saved, so Instagram refused that session: it expired, was signed out, or the account is waiting for a confirmation. Sign in to Instagram in your browser (and confirm any prompt), copy the cookies again and paste them here; a dedicated account that is not used elsewhere is the most stable."}`,
    };
  }
  /**
   * Takes the signed-in Instagram session out of a browser (it may ask macOS for Keychain access); only the sessionid is kept.
   * yt-dlp writes the cookie jar when it exits even if the request fails (checked), so a dummy address that never resolves is enough
   * and nothing is sent to Instagram. The jar holds the browser's cookies, so it lives in a private temp folder only for this call.
   */
  async function readBrowserSession(browser: string): Promise<string> {
    if (!COOKIE_BROWSERS.includes(browser)) throw new Error(`The browser must be one of ${COOKIE_BROWSERS.join(", ")}`);
    const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "bw-import-"));
    const jar = px.join(dir, "cookies.txt");
    try {
      await new Promise<void>((resolve) =>
        cp.execFile("yt-dlp", ["--cookies-from-browser", browser, "--cookies", jar, "--skip-download", "-q", "--no-warnings", "--", "https://example.invalid/"], { env: hostEnv(), timeout: 120_000, maxBuffer: 1 << 20 }, () => resolve()),
      );
      const id = fsx.existsSync(jar) ? sessionFromCookieJar(fsx.readFileSync(jar, "utf8")) : null;
      if (id === null) throw new Error(`No signed-in Instagram session found in ${browser}. Sign in to instagram.com in ${browser} first (and allow Keychain access if macOS asks), then try again.`);
      return id;
    } finally {
      fsx.rmSync(dir, { recursive: true, force: true });
    }
  }
  const sessionArgs = (s: Session) => (s.cookiesFile ? ["--cookies", s.cookiesFile] : s.browser ? ["--cookies-from-browser", s.browser] : []);
  const NEEDS_SESSION = "ask the user to connect Instagram under Settings > Providers > Downloads (one click: Import from browser)";
  async function downloadVideo(link: string, session: Session) {
    let u: URL;
    try { u = new URL(link); } catch { throw new Error(`Not a URL: ${link}`); }
    if (u.protocol !== "https:" || !SOCIAL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) throw new Error(`Only https links to ${SOCIAL_HOSTS.join(", ")} are allowed`);
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
    const args = [
      "--no-playlist", "--quiet", "--no-warnings", "--write-info-json", "--restrict-filenames",
      "-S", "vcodec:h264,res,acodec:m4a", "--merge-output-format", "mp4",
      "-o", px.join(osx.tmpdir(), "bw-downloads", "%(extractor)s", "%(id)s.%(ext)s"), "--print", "after_move:filepath",
      ...sessionArgs(session), "--", link,
    ];
    const out = await new Promise<string>((resolve, reject) =>
      cp.execFile("yt-dlp", args, { env, timeout: 180_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) => {
        if (!e) return resolve(stdout);
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("yt-dlp is not installed on this host (brew install yt-dlp ffmpeg)"));
        const why = String(stderr || e.message).trim().split("\n").slice(-2).join(" ");
        reject(new Error(`Download failed: ${why}${/login|cookie|rate-limit|sign in/i.test(why) ? ` (${NEEDS_SESSION}; they must be signed in there)` : ""}`));
      }),
    );
    const file = out.trim().split("\n").pop() ?? "";
    if (file === "" || !fsx.existsSync(file)) throw new Error("Download finished but no file was produced");
    const raw = JSON.parse(fsx.readFileSync(file.replace(/\.[^.]+$/, ".info.json"), "utf8")) as Record<string, unknown>;
    const info = { uploader: raw.uploader, title: raw.title, description: raw.description, durationSeconds: raw.duration, likes: raw.like_count, url: raw.webpage_url };
    return { file, info };
  }

  // Photos (profiles, posts, carousels) are a different tool: yt-dlp only knows videos. Instagram shows them to signed-in sessions only,
  // so without a browser session gallery-dl is told "user not found"; the user picks the session in Settings (download.cookiesBrowser).
  const IG_PHOTO_PATH = /^\/(?:(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel)\/[\w-]{5,30}|[A-Za-z0-9._]{1,30})\/?$/;
  async function downloadPhotos(link: string, opts: { session: Session; limit: number }) {
    let u: URL;
    try { u = new URL(link); } catch { throw new Error(`Not a URL: ${link}`); }
    if (u.protocol !== "https:" || !(u.hostname === "instagram.com" || u.hostname.endsWith(".instagram.com")) || !IG_PHOTO_PATH.test(u.pathname)) {
      throw new Error("Only https links to an Instagram profile (instagram.com/<user>) or post (instagram.com/p/<id>) are allowed");
    }
    const profile = /^\/[A-Za-z0-9._]{1,30}\/?$/.test(u.pathname) && !/^\/(?:p|reel|tv|explore|accounts)\/?$/.test(u.pathname);
    const target = profile ? `https://www.instagram.com${u.pathname.replace(/\/?$/, "/")}posts/` : `https://www.instagram.com${u.pathname}`;
    const dir = px.join(osx.tmpdir(), "bw-downloads", "photos", slug(u.pathname) || "post");
    fsx.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
    const args = [
      "--range", `1-${opts.limit}`, "-D", dir, "--filter", "extension in ('jpg', 'jpeg', 'png', 'webp')",
      ...sessionArgs(opts.session), "--", target,
    ];
    const out = await new Promise<string>((resolve, reject) =>
      cp.execFile("gallery-dl", args, { env, timeout: 180_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) => {
        if (!e) return resolve(stdout);
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("gallery-dl is not installed on this host (brew install gallery-dl)"));
        const why = String(stderr || e.message).trim().split("\n").slice(-2).join(" ");
        reject(new Error(`Download failed: ${why}${/not ?found|login|401|403|redirect|cookie/i.test(why) ? ` (Instagram shows photos to signed-in sessions only: ${NEEDS_SESSION}; they must be signed in there)` : ""}`));
      }),
    );
    const files = out.split("\n").map((l) => l.replace(/^#\s*/, "").trim()).filter((l) => l !== "").map((l) => px.resolve(l)).filter((f) => f.startsWith(dir + px.sep) && fsx.existsSync(f));
    if (files.length === 0) throw new Error("Nothing was downloaded (no photos found, or the profile is private)");
    return { dir, files: [...new Set(files)] };
  }

  /** Generation parameters from CLI flags. Spawned without a shell, but the lengths and the model name are still bounded. */
  // The provider uploads whatever path it is given, so only media files (or ids of already uploaded ones) are passed on.
  const MEDIA_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a"]);
  const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const mediaFile = (v: string) => {
    if (UPLOAD_ID.test(v)) return v;
    const f = px.resolve(v);
    if (!MEDIA_EXT.has(px.extname(f).toLowerCase()) || !fsx.statSync(f, { throwIfNoEntry: false })?.isFile()) throw new Error(`Not an image, video or audio file: ${v}`);
    return f;
  };
  const specFrom = (args: string[]): GenSpec => {
    const prompt = (val(args, "--prompt") ?? "").trim();
    const model = val(args, "--model") ?? "nano_banana_pro";
    if (prompt === "" || prompt.length > 2000) throw new Error("--prompt is required (max 2000 characters)");
    if (!/^[a-z0-9_.-]{2,64}$/.test(model)) throw new Error(`Invalid --model "${model}"`);
    const params: Record<string, string> = {};
    for (const kv of vals(args, "--param")) {
      const i = kv.indexOf("=");
      if (i < 1) throw new Error(`--param takes name=value, got "${kv}"`);
      params[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const duration = val(args, "--duration");
    if (duration !== undefined) params.duration = duration;
    const one = (name: string) => { const v = val(args, name); return v === undefined ? undefined : mediaFile(v); };
    return {
      model, prompt, aspect: val(args, "--aspect"), resolution: val(args, "--resolution"),
      refs: vals(args, "--ref").map(mediaFile), startImage: one("--start-image"), endImage: one("--end-image"),
      videoRefs: vals(args, "--video-ref").map(mediaFile), audioRefs: vals(args, "--audio-ref").map(mediaFile), params,
    };
  };

  bb.cli.register({
    name: "brandwise",
    summary: "Campaigns, content calendar and assets of the BrandWise",
    commands: [
      { name: "editor", summary: "The editor-in-chief regulator: signals, experiments, journal, tasks", usage: "bb brandwise editor signals|experiments|journal|tasks|goals ..." },
      { name: "sim", summary: "Development clock for the simulated e-mail provider", usage: "bb brandwise sim status|advance|reset" },
      { name: "email", summary: "E-mail campaign statistics, event replay and e-mail templates", usage: "bb brandwise email stats|ingest|template|brand|component|entry ..." },
      { name: "campaign", summary: "List or add campaigns (an always-on base or a time-bound campaign)", usage: "bb brandwise campaign list|add|channel|assign|unassign ..." },
      { name: "calendar", summary: "List, add, edit, send back, approve, withdraw approval of or cancel calendar entries", usage: "bb brandwise calendar list|add|edit|request-changes|unapprove|approve|cancel|run-due ..." },
      { name: "assets", summary: "Add, download (Instagram, TikTok, YouTube), list or sign assets stored in S3", usage: "bb brandwise assets add|download|download-photos|list|url ..." },
      { name: "instagram", summary: "Check that the Instagram connection used for downloads works", usage: "bb brandwise instagram test" },
      { name: "doctor", summary: "Check that the host tools BrandWise needs are installed", usage: "bb brandwise doctor" },
      { name: "config", summary: "Provider, account and limits per scope (global or campaign)", usage: "bb brandwise config list|set|unset ..." },
      { name: "providers", summary: "Check that the account of a scope is signed in at each provider", usage: "bb brandwise providers status ..." },
      { name: "creative", summary: "Estimate, generate (Higgsfield) and collect creatives", usage: "bb brandwise creative models|model|cost|generate|collect ..." },
      { name: "product", summary: "Read or write the Markdown product pack of a brand", usage: "bb brandwise product list|get|set ..." },
      { name: "video", summary: "Remotion video projects: seed, compositions, preview, render, collect", usage: "bb brandwise video seed|compositions|preview|render|collect ..." },
      { name: "mode", summary: "Show or re-apply the display mode (full, minimal)", usage: "bb brandwise mode [apply | set <name>]" },
    ],
    async run(argv) {
      const unknown = argv.find((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
      if (unknown !== undefined) return { exitCode: 1, stderr: `Unknown option ${unknown}\n${usage}` };
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const [area, action, ...rest] = positional(args).length ? [args[0], args[1], ...args.slice(2)] : [];
      try {
        if (area === "mode") {
          if (action === "apply") await syncMode(true);
          if (action === "set") {
            if (!rest[0]) return { exitCode: 1, stderr: usage };
            await setMode(rest[0]);
          }
          const v = await modeView();
          return reply(v, [
            `mode: ${v.label} (${v.mode}) - ${v.description}`,
            `available: ${v.allowed.map((m) => m.name).join(", ")}${v.locked ? " (locked by BW_MODES)" : ""}; switch with: bb brandwise mode set <name>`,
            v.lastChanges.length ? `last changes: ${v.lastChanges.join(", ")}` : "last changes: none since load",
            ...(v.error ? [`error: ${v.error}`] : []),
          ].join("\n"));
        }
        const c = need();
        const campaign = async () => (await c.campaigns.resolve(val(args, "--campaign"))).id;
        if (area === "campaign" && action === "list") {
          const ps = await c.campaigns.list();
          return reply(ps, ps.map((p) => `${p.id}  ${p.kind.padEnd(8)} ${p.name}${p.startsAt ? `  ${p.startsAt}..${p.endsAt ?? ""}` : ""}`).join("\n") || "No campaigns.");
        }
        if (area === "campaign" && action === "add") {
          const name = positional(args.slice(2))[0];
          const kind = val(args, "--kind");
          if (!name || !["always_on", "campaign"].includes(kind ?? "")) return { exitCode: 1, stderr: usage };
          const parent = val(args, "--parent");
          const p = await c.campaigns.add({
            name, kind: kind as "always_on", parentId: parent ? (await c.campaigns.resolve(parent)).id : null,
            startsAt: val(args, "--from") ?? null, endsAt: val(args, "--to") ?? null,
          });
          return reply(p, `Added ${p.id}  ${p.kind} ${p.name}`);
        }
        if (area === "campaign" && action === "channel") { // where a campaign publishes on a channel: `channel set|unset|list`
          const [sub, channel, ...pairs] = positional(args.slice(2));
          const target = await c.campaigns.resolve(val(args, "--campaign"));
          if (sub === "list") {
            const own = await c.channels.list(target.id);
            return reply(own, own.map((o) => `${o.channel}  ${JSON.stringify(o.config)}`).join("\n") || `${target.name}: no channel targets of its own (a parent campaign's apply).`);
          }
          if (!channel || (sub !== "set" && sub !== "unset")) return { exitCode: 1, stderr: usage };
          // where money is spent and how it is paid is a person's choice, made on the Results page (Paid), never on the command line
          if (channel === "ads") return { exitCode: 1, stderr: "The ads platform and payment method are set by a person on the Results page (Paid), not on the command line" };
          if (sub === "unset") return reply({ removed: await c.channels.unset(target.id, channel) }, `${target.name}: ${channel} target removed`);
          const config = Object.fromEntries(pairs.map((p) => { const i = p.indexOf("="); return i > 0 ? [p.slice(0, i), p.slice(i + 1)] : [p, ""]; }));
          if (Object.keys(config).length === 0 || Object.values(config).some((x) => x === "")) return { exitCode: 1, stderr: usage };
          await c.channels.set(target.id, channel, config);
          await changed(); // entries parked as "Publish by hand" for want of a target are not retried; the calendar view refreshes anyway
          return reply(config, `${target.name}: ${channel} -> ${JSON.stringify(config)}`);
        }
        if (area === "campaign" && action === "assign") {
          const [threadId, ref] = positional(args.slice(2));
          if (!threadId || !ref) return { exitCode: 1, stderr: usage };
          const target = await c.campaigns.resolve(ref);
          await assignThread(threadId, target.id);
          return reply({ threadId, campaignId: target.id }, `Thread ${threadId} -> ${target.name}`);
        }
        if (area === "campaign" && action === "unassign") {
          const threadId = positional(args.slice(2))[0];
          if (!threadId) return { exitCode: 1, stderr: usage };
          await assignThread(threadId, null);
          return reply({ threadId, campaignId: null }, `Thread ${threadId} has no campaign`);
        }
        if (area === "calendar" && action === "list") {
          const es = await c.calendar.list(val(args, "--campaign") ? await campaign() : undefined);
          return reply(es, es.map(fmtEntry).join("\n") || "No entries.");
        }
        if (area === "calendar" && action === "run-due") { // silent when nothing is due: the automation records that as a skipped tick
          const done = await runDue(c, allConnectors(), Number(val(args, "--limit") ?? 10) || 10);
          if (done.length > 0) await changed();
          return json ? reply(done, "") : { exitCode: done.some((o) => o.result === "failed") ? 1 : 0, stdout: done.map((o) => `${o.result.padEnd(12)} ${o.id}  ${o.channel}  ${o.title}  ${o.detail}`).join("\n") };
        }
        if (area === "email" && (action === "template" || action === "brand" || action === "component" || action === "entry")) return emailTemplates.cli(args, { val, positional, reply, usage });
        if (area === "email" && action === "stats") {
          if (email === null) return { exitCode: 1, stderr: "Not configured: run infra/bb-instance/provision.sh apply" };
          const entryId = positional(args.slice(2))[0];
          const stats = await email.stats(entryId ? { entryId } : { campaignId: (await c.campaigns.resolve(val(args, "--campaign"))).id });
          const pct = (m: { unit: string; value: number | null }) => (m.value === null ? "n/a" : m.unit === "ratio" ? `${(m.value * 100).toFixed(1)} %` : String(m.value));
          const lines = stats.metrics.map((m) => `${m.label.padEnd(52)} ${pct(m).padStart(8)}  ${m.available ? m.reliability : "not provided by " + stats.sends.map((s) => s.provider).join("/")}`);
          return reply(stats, stats.sends.length === 0 ? "No e-mail has been sent for this entry/campaign yet." : `${stats.sends.length} send(s) via ${[...new Set(stats.sends.map((s) => s.provider))].join(", ")}\n${lines.join("\n")}`);
        }
        if (area === "email" && action === "ingest") { // replay a saved webhook payload (trusted file, no signature check)
          const provider = val(args, "--provider"), file = val(args, "--file");
          if (!email || !provider || !file) return { exitCode: 1, stderr: usage };
          const r = await email.replay(provider, fsx.readFileSync(file, "utf8"), `replay-${px.basename(file)}`);
          if (r.stored > 0) await changed();
          return reply(r, `received ${r.received}, stored ${r.stored}, duplicates ${r.duplicates}, not linked to a send ${r.unlinked}`);
        }
        if (area === "calendar" && action === "add") {
          const title = positional(args.slice(2))[0];
          const channel = val(args, "--channel");
          const at = val(args, "--at");
          const tier = Number(val(args, "--tier"));
          if (!title || !channel || !at || ![1, 2, 3].includes(tier)) return { exitCode: 1, stderr: usage };
          const e = await c.calendar.add({ campaignId: await campaign(), title, channel, scheduledAt: at, tier: tier as 1 | 2 | 3, assetId: val(args, "--asset") ?? null, body: val(args, "--body") ?? "", link: val(args, "--link") ?? null, createdBy: cliActor(args) });
          const linked = await attachFromArgs(e.id, args);
          await changed();
          return reply({ ...e, learnings: linked }, `Added ${fmtEntry(e)}${linked ? `\nwritten from brief ${linked.briefId ?? "none"}; applies ${linked.applies.join(", ") || "nothing"}; tests ${linked.tests.join(", ") || "nothing"}` : "\nNo --brief-id: run `bb brandwise brief` before writing and cite what you apply (the reviewer sees it)."}`);
        }
        if (area === "calendar" && action === "edit") {
          const id = positional(args.slice(2))[0];
          if (!id) return { exitCode: 1, stderr: usage };
          const at = val(args, "--at");
          const e = await c.calendar.update(id, {
            title: val(args, "--title"), body: val(args, "--body"), link: val(args, "--link"), channel: val(args, "--channel"),
            scheduledAt: at, assetId: val(args, "--asset"),
          }, cliActor(args));
          await attachFromArgs(e.id, args);
          await changed();
          return reply(e, fmtEntry(e));
        }
        if (area === "calendar" && action === "unapprove") {
          const id = positional(args.slice(2))[0];
          if (!id) return { exitCode: 1, stderr: usage };
          const e = await c.calendar.unapprove(id, cliActor(args));
          await changed();
          return reply(e, fmtEntry(e));
        }
        if (area === "calendar" && action === "request-changes") {
          const [id, ...note] = positional(args.slice(2));
          if (!id || note.length === 0) return { exitCode: 1, stderr: usage };
          const e = await c.calendar.requestChanges(id, note.join(" "), { actor: cliActor(args), reason: val(args, "--reason") ?? null });
          await changed();
          return reply(e, fmtEntry(e));
        }
        if (area === "calendar" && (action === "approve" || action === "cancel")) {
          const id = rest[0];
          if (!id) return { exitCode: 1, stderr: usage };
          const e = await c.calendar.decide(id, action, cliActor(args));
          await changed();
          return reply(e, fmtEntry(e));
        }
        if (area === "calendar" && action === "history") {
          const id = rest[0];
          if (!id) return { exitCode: 1, stderr: usage };
          const h = await c.calendar.history(id);
          return reply(h, h.map((x) => `${x.at.slice(0, 16)}  ${x.kind.padEnd(17)} ${x.actor.padEnd(10)} ${x.fromStatus ?? ""} -> ${x.toStatus ?? ""}${x.reason ? `  [${x.reason}]` : ""}${x.note ? `  ${x.note}` : ""}`).join("\n") || "No history.");
        }
        if (area === "brief") return learningsCli.brief(args, { val, positional, reply, usage });
        if (area === "results") return resultsCli.results(action, args, { val, positional, reply, usage });
        if (area === "ads") {
          const m = ads();
          if (action === "order") { // an agent may draft an order: it is a tier-3 calendar entry a person approves, refused at once over the limits
            const [name, budget, days, at] = [val(args, "--name"), Number(val(args, "--budget")), Number(val(args, "--days")), val(args, "--at")];
            if (!name || !at || !(budget > 0) || !(days > 0)) return { exitCode: 1, stderr: usage };
            const boost = val(args, "--boost"), change = val(args, "--order");
            const r = await m.create({ campaignId: await campaign(), name, body: val(args, "--body") ?? "", link: val(args, "--link") ?? null, assetId: val(args, "--asset") ?? null, action: change ? "budget_change" : boost ? "boost" : "media_buy", budget, currency: val(args, "--currency"), days, boostOf: boost ?? null, orderOf: change ?? null, at, createdBy: cliActor(args) });
            await changed();
            return reply(r, `Order ${r.entry.id}: ${r.order.action} ${r.order.budget} ${r.order.currency} over ${r.order.days} day(s), waiting for a person's approval (tier 3). The limits are checked again before anything is paid.`);
          }
          if (action === "pause") { if (!rest[0]) return { exitCode: 1, stderr: usage }; await m.pause(rest[0]); return reply({ ok: true }, `Ad ${rest[0]} paused.`); }
          if (action === "pull") { const r = await m.pull(); return reply(r, r.points > 0 ? `${r.points} number(s) updated over ${r.orders} live order(s)` : ""); }
          if (action === "list") {
            const rows = await m.results(await campaign());
            const f = (v: number | null, d = 2) => (v === null ? "n/a" : v.toFixed(d));
            return reply(rows, rows.map((a) => `${a.entryId}  ${a.status.padEnd(7)} ${a.action.padEnd(9)} ${a.budget} ${a.currency}/${a.days}d  spend ${f(a.spend)}  CTR ${a.ctr === null ? "n/a" : (100 * a.ctr).toFixed(2) + " %"}  CPC ${f(a.cpc)}  freq ${f(a.frequency, 1)}  leads ${a.leads ?? "n/a"}  CPL ${f(a.cpl)}${a.fullyLoadedCpl !== null ? ` (fully loaded ${f(a.fullyLoadedCpl)})` : ""}  ROAS ${f(a.roas)}${a.fatigue ? "  FATIGUE" : ""}  "${a.name}"`).join("\n") || "No ads.");
          }
          return { exitCode: 1, stderr: usage };
        }
        if (area === "learnings") return learningsCli.learnings(action, args, { val, positional, reply, usage });
        if (area === "assets" && action === "add") {
          const file = positional(args.slice(2))[0];
          if (!file) return { exitCode: 1, stderr: usage };
          const provenance = val(args, "--provenance");
          const a = await c.assets.save({
            campaignId: await campaign(), file, role: (val(args, "--role") ?? "creative") as "creative",
            origin: (val(args, "--origin") ?? "uploaded") as "uploaded", aiGenerated: args.includes("--ai"),
            provenance: provenance ? JSON.parse(provenance) : null, createdBy: "cli",
          });
          bb.realtime.publish(ASSETS_CHANGED, {});
          return reply(a, `${a.id}  ${a.kind}/${a.role}  ${a.bytes} B  ${a.name}`);
        }
        if (area === "assets" && action === "download") {
          const link = positional(args.slice(2))[0];
          if (!link) return { exitCode: 1, stderr: usage };
          if (args.includes("--cookies")) return { exitCode: 1, stderr: `The session is not chosen per call: ${NEEDS_SESSION}` };
          const campaignId = await campaign();
          const got = await withSession(c, campaignId, (session) => downloadVideo(link, session));
          const a = await c.assets.save({
            campaignId, file: got.file, role: "reference", origin: "imported",
            provenance: { source: link, ...got.info }, rights: { note: "third-party content, reference only, do not republish" }, createdBy: "cli",
          });
          bb.realtime.publish(ASSETS_CHANGED, {});
          const caption = String(got.info.description ?? "").replace(/\s+/g, " ").slice(0, 300);
          return reply({ asset: a, path: got.file, info: got.info }, `${a.id}  ${got.file}\n${got.info.uploader ?? "?"}: ${caption}`);
        }
        if (area === "assets" && action === "download-photos") {
          const link = positional(args.slice(2))[0];
          if (!link) return { exitCode: 1, stderr: usage };
          const limit = Math.min(Math.max(Math.floor(Number(val(args, "--limit") ?? 12)) || 12, 1), 40);
          if (args.includes("--cookies")) return { exitCode: 1, stderr: `The session is not chosen per call: ${NEEDS_SESSION}` };
          const campaignId = await campaign();
          const got = await withSession(c, campaignId, (session) => downloadPhotos(link, { session, limit }));
          const saved = [];
          for (const file of got.files) {
            saved.push(await c.assets.save({
              campaignId, file, role: "reference", origin: "imported",
              provenance: { source: link, tool: "gallery-dl" }, rights: { note: "third-party photos, reference only, do not republish; a real person's likeness needs their written consent" }, createdBy: "cli",
            }));
          }
          bb.realtime.publish(ASSETS_CHANGED, {});
          return reply({ assets: saved, paths: got.files }, `${saved.length} photo${saved.length === 1 ? "" : "s"} saved as reference assets:\n${saved.map((a, i) => `${a.id}  ${got.files[i]}`).join("\n")}`);
        }
        if (area === "assets" && action === "list") {
          const as = await c.assets.list(val(args, "--campaign") ? await campaign() : undefined);
          return reply(as, as.map((a) => `${a.id}  ${a.role.padEnd(9)} ${a.status.padEnd(9)} ${a.origin.padEnd(9)} ${a.bytes} B  ${a.name}`).join("\n") || "No assets.");
        }
        if (area === "instagram" && action === "test") {
          const ref = val(args, "--campaign");
          const scope: Scope = ref ? (await c.campaigns.resolve(ref)).id : null;
          const r = await instagramTest(c, scope);
          return reply(r, `${r.ok ? "ok" : "NOT ok"}  ${r.detail}${r.ok ? "" : `\nThe user connects Instagram under Settings > Providers > Downloads (${NEEDS_SESSION}).`}`);
        }
        if (area === "doctor") {
          const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
          const probe = (bin: string, arg: string) => new Promise<string | null>((resolve) =>
            cp.execFile(bin, [arg], { env, timeout: 15_000 }, (e, out, err) => resolve(e ? null : String(out || err).split("\n")[0].trim())));
          const tools = [
            { name: "yt-dlp", bin: "yt-dlp", arg: "--version", for: "videos from Instagram, TikTok, YouTube", install: "brew install yt-dlp" },
            { name: "gallery-dl", bin: "gallery-dl", arg: "--version", for: "photos from Instagram", install: "brew install gallery-dl" },
            { name: "ffmpeg", bin: "ffmpeg", arg: "-version", for: "merging video, thumbnails", install: "brew install ffmpeg" },
            { name: "higgsfield", bin: cfg.higgsfieldBin, arg: "--version", for: "image and video generation", install: "npm i -g @higgsfield/cli" },
          ];
          const rows = await Promise.all(tools.map(async (t) => ({ name: t.name, for: t.for, version: await probe(t.bin, t.arg), install: t.install })));
          const dscope: Scope = val(args, "--campaign") && core !== null ? (await core.campaigns.resolve(val(args, "--campaign"))).id : null;
          const saved = core === null ? undefined : (await core.settings.resolve(dscope, "download.instagramSession"))?.value;
          const browser = core === null ? undefined : await cookiesFor(core, dscope);
          const session = typeof saved === "string" && saved !== "" ? "saved Instagram session id" : browser ? `browser session (${browser})` : "none, downloads are anonymous (Instagram photos need a session)";
          return reply(
            { tools: rows, database: core !== null, session },
            `${core === null ? "NOT configured" : "configured"}  database and S3\nsession      ${session}\n${rows.map((r) => `${r.version ? "ok     " : "MISSING"}  ${r.name.padEnd(11)} ${r.version ?? `${r.install}   (${r.for})`}`).join("\n")}`,
          );
        }
        if (area === "config" && ["list", "set", "unset"].includes(action ?? "")) {
          const ref = val(args, "--campaign");
          const scope: Scope = ref ? (await c.campaigns.resolve(ref)).id : null;
          const where = await scopeName(c, scope);
          if (action === "list") {
            const views = await c.settings.view(scope);
            const text = await Promise.all(views.map(async (v) => {
              const from = v.source === "default" ? "default" : v.source === "unset" ? "not set" : v.source === scope ? `set here (${where})` : `from ${await scopeName(c, v.source)}`;
              return `${v.field.key.padEnd(30)} ${v.field.secret ? (v.isSet ? "[set]" : "[not set]") : String(v.value ?? "")}  (${from})`;
            }));
            return reply(views.map((v) => ({ key: v.field.key, value: v.value, isSet: v.isSet, source: v.source })), `Settings as seen by ${where}:\n${text.join("\n")}`);
          }
          const key = positional(args.slice(2))[0];
          if (!key) return { exitCode: 1, stderr: usage };
          const f = c.settings.fields.find((x) => x.key === key);
          if (!f) return { exitCode: 1, stderr: `Unknown setting ${key}. List them with: bb brandwise config list` };
          if (f.userOnly) return { exitCode: 1, stderr: `${key} is changed by a person on the Settings page (or the campaign page), never from the command line` };
          if (action === "unset") {
            await c.settings.unset(scope, key);
            bb.realtime.publish(CONFIG_CHANGED, {});
            return reply({ key, scope }, `${key} no longer set at ${where}; it inherits again`);
          }
          if (f.secret) return { exitCode: 1, stderr: `${key} is a secret: set it on the Settings page (or the campaign page), not on the command line` };
          const raw = positional(args.slice(2))[1];
          if (raw === undefined) return { exitCode: 1, stderr: usage };
          const value: SettingValue = f.type === "number" ? Number(raw) : f.type === "boolean" ? raw === "true" : raw;
          if (f.type === "boolean" && raw !== "true" && raw !== "false") return { exitCode: 1, stderr: `${key} takes true or false` };
          await c.settings.set(scope, key, value);
          bb.realtime.publish(CONFIG_CHANGED, {});
          return reply({ key, value, scope }, `${key} = ${String(value)} at ${where}`);
        }
        if (area === "providers" && action === "status") {
          const ref = val(args, "--campaign");
          const scope: Scope = ref ? (await c.campaigns.resolve(ref)).id : null;
          const out = await Promise.all(PROVIDERS.map(async (p) => {
            const { provider, config } = await c.generation.providerFor(scope, host(), p.id);
            const auth = await provider.status(config);
            return { id: provider.id, ok: auth.ok, detail: auth.detail, signIn: auth.ok ? null : provider.loginHint(config) };
          }));
          return reply(out, out.map((o) => `${o.id}: ${o.ok ? "signed in" : "NOT signed in"}  ${o.detail}${o.signIn ? `\n  sign in (in a terminal): ${o.signIn}` : ""}`).join("\n"));
        }
        if (area === "creative" && (action === "models" || action === "model")) {
          const ref = val(args, "--campaign");
          const { provider, config } = await c.generation.providerFor(ref ? (await c.campaigns.resolve(ref)).id : null, host());
          const model = action === "model" ? positional(args.slice(2))[0] : undefined;
          if (action === "model" && !model) return { exitCode: 1, stderr: usage };
          const kind = args.includes("--video") ? "video" : args.includes("--image") ? "image" : undefined;
          const text = await provider.models(config, { kind, model });
          return reply({ provider: provider.id, text }, text.trimEnd());
        }
        if (area === "creative" && action === "cost") {
          const spec = specFrom(args);
          const ref = val(args, "--campaign");
          const k = await costOf(c, spec, ref ? (await c.campaigns.resolve(ref)).id : null, Number(val(args, "--max-credits") ?? NaN) || undefined);
          const within = k.credits <= k.cap && k.budgets.every((b) => b.spent + k.credits <= b.limit);
          return reply({ ...k, withinLimit: within }, `${k.credits} ${k.unit} via ${k.provider} (limit per generation ${k.cap}; ${k.budgets.map((b) => `${b.name}: used ${b.spent} of ${b.limit} today`).join(", ")})`);
        }
        if (area === "creative" && (action === "generate" || action === "collect")) {
          const wait = Math.min(Math.max(Number(val(args, "--wait-seconds") ?? 18) || 0, 0), 20); // MCP `run` stops a snippet after 25 s
          let jobId: string;
          if (action === "generate") {
            const role = (val(args, "--role") ?? "creative") as "creative" | "source";
            if (!["creative", "source"].includes(role)) return { exitCode: 1, stderr: usage };
            const started = await startGeneration(c, { spec: specFrom(args), campaign: val(args, "--campaign"), role, name: val(args, "--name") ?? null, maxCredits: Number(val(args, "--max-credits") ?? NaN) || undefined });
            jobId = started.jobId;
          } else {
            jobId = positional(args.slice(2))[0] ?? "";
            if (!jobId) return { exitCode: 1, stderr: usage };
          }
          const r = await collectGeneration(c, jobId, wait);
          return reply(r, r.state === "done"
            ? `Done: asset ${r.asset!.id} (${r.asset!.name}, ${r.asset!.width ?? "?"}x${r.asset!.height ?? "?"}), ~${r.credits} credits. Show it with ::creative{ids="${r.asset!.id}"}`
            : `Still running (status ${r.status}), job ${jobId}. Finish with: bb brandwise creative collect ${jobId}`);
        }
        if (area === "product") return productCli(c, action, args, { val, positional, reply, usage });
        if (area === "video") return video.cli(action, args, { val, positional, reply, usage });
        if (area === "editor") return editorCli.editor(action, args, { val, positional, reply, usage });
        if (area === "sim") return editorCli.sim(action, args, { val, positional, reply, usage });
        if (area === "assets" && action === "rename") {
          const [id, ...nameParts] = positional(args.slice(2));
          if (!id || nameParts.length === 0) return { exitCode: 1, stderr: usage };
          const a = await c.assets.update(id, { name: nameParts.join(" ") });
          bb.realtime.publish(ASSETS_CHANGED, {});
          return reply(a, `${a.id}  ${a.name}`);
        }
        if (area === "assets" && action === "set") {
          const id = positional(args.slice(2))[0];
          const status = val(args, "--status");
          if (!id || !(UI_STATUSES as readonly string[]).includes(status ?? "")) return { exitCode: 1, stderr: usage };
          const a = await c.assets.update(id, { status: status as "draft" });
          bb.realtime.publish(ASSETS_CHANGED, {});
          return reply(a, `${a.id}  ${a.name}  ${a.status}`);
        }
        if (area === "assets" && action === "delete") {
          const id = rest[0];
          if (!id) return { exitCode: 1, stderr: usage };
          await c.assets.delete(id);
          bb.realtime.publish(ASSETS_CHANGED, {});
          return reply({ deleted: id }, `Deleted ${id}`);
        }
        if (area === "assets" && action === "url") {
          if (!rest[0]) return { exitCode: 1, stderr: usage };
          const url = await c.assets.url(rest[0], Number(val(args, "--seconds") ?? 300));
          return reply({ url }, url);
        }
      } catch (cause) {
        return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  void syncMode();

  bb.onDispose(async () => {
    await core?.close();
    bb.log.info("disposed");
  });
}
