// @brandwise/core: campaigns, content calendar and assets on Postgres + S3.
// The BB plugin, agent tools and CLI all go through this; nothing else touches the tables.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";
import { createSettings, type Scope, type SettingValue } from "./settings.ts";
import { SETTING_FIELDS, providerById, type ProviderConfig } from "./providers/index.ts";
import { deriveAttributes } from "./learnings/attributes.ts";

export { PROVIDERS, SETTING_FIELDS, providerById } from "./providers/index.ts";
export type { Auth, GenSpec, Job, Provider, ProviderConfig } from "./providers/index.ts";
export { downloadResult, higgsfield, isFailed } from "./providers/higgsfield.ts";
export { cookieJarFor, sessionFromCookieJar } from "./download.ts";
export type { FieldView, Resolved, Scope, SettingField, SettingValue, Settings } from "./settings.ts";

export type CoreConfig = {
  databaseUrl: string;
  s3: { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
  /** 32 bytes, base64. Encrypts secret settings (provider keys); without it secrets cannot be saved. */
  secretKey?: string;
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): CoreConfig {
  const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is not set`); })();
  return {
    databaseUrl: need("DATABASE_URL"),
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION ?? "us-east-1",
      bucket: need("S3_BUCKET"),
      accessKeyId: need("S3_ACCESS_KEY_ID"),
      secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    },
    secretKey: env.BW_SECRET_KEY || undefined,
  };
}

export const ASSET_STATUSES = ["draft", "linted", "approved", "published", "archived"] as const;
export const STATUSES = ["draft", "pending_approval", "changes_requested", "approved", "scheduled", "publishing", "published", "needs_manual", "failed", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export type Tier = 1 | 2 | 3;

export type Campaign = { id: string; parentId: string | null; rootId: string; name: string; kind: "always_on" | "campaign"; startsAt: string | null; endsAt: string | null };
export type CalendarEntry = { id: string; campaignId: string; campaignName: string; title: string; channel: string; scheduledAt: string; tier: Tier; status: Status; assetId: string | null; createdBy: string; body: string; link: string | null; reviewNote: string | null; attempts: number; externalId: string | null; externalUrl: string | null; error: string | null; briefId: string | null; approvedAt: string | null; approvedBy: string | null };
/** Why an entry was sent back: a closed list, so production metrics and reviewer preferences can be counted. */
export const REVIEW_REASONS = ["claims", "facts", "tone", "brand", "visual", "legal", "typo", "offer", "other"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export type EntryEvent = { id: number; entryId: string; kind: string; actor: string; fromStatus: string | null; toStatus: string | null; note: string | null; reason: ReviewReason | null; data: unknown; at: string };
export type Asset = { id: string; campaignId: string; name: string; kind: string; role: string; origin: string; storageKey: string; sha256: string; mime: string; bytes: number; width: number | null; height: number | null; status: string; aiGenerated: boolean; provenance: unknown; createdBy: string; createdAt: string };

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf", ".woff": "font/woff", ".ttf": "font/ttf",
};
const kindOf = (mime: string) =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : mime.startsWith("font/") ? "font" : "document";

/** Links are published as given, so only http(s) passes; empty means none. */
const cleanLink = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  if (t === "") return null;
  if (!/^https?:\/\/\S+$/i.test(t)) throw new Error(`Link must be an http(s) URL: ${t}`);
  return t;
};

/**
 * One rule for every action on an entry (edit, send back, approve, withdraw approval, cancel): cancelled and
 * published entries, and entries whose time has come (now counts as taken place), are frozen. Enforced here so
 * the UI, the CLI and agents all get it.
 */
const assertActionable = (e: CalendarEntry, now = Date.now()) => {
  if (e.status === "cancelled" || e.status === "published") throw new Error(`Entry ${e.id} is ${e.status}, no actions allowed`);
  if (Date.parse(e.scheduledAt) <= now) throw new Error(`Entry ${e.id} already took place, no actions allowed`);
};

const campaignFrom = (r: any): Campaign => ({ id: r.id, parentId: r.parent_id, rootId: r.root_id, name: r.name, kind: r.kind, startsAt: r.starts_at ?? null, endsAt: r.ends_at ?? null });
const entryFrom = (r: any): CalendarEntry => ({ id: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, title: r.title, channel: r.channel, scheduledAt: new Date(r.scheduled_at).toISOString(), tier: r.tier, status: r.status, assetId: r.asset_id, createdBy: r.created_by, body: r.body, link: r.link, reviewNote: r.review_note, attempts: r.attempts, externalId: r.external_id, externalUrl: r.external_url, error: r.error, briefId: r.brief_id ?? null, approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null, approvedBy: r.approved_by ?? null });
const assetFrom = (r: any): Asset => ({ id: r.id, campaignId: r.campaign_id, name: r.name, kind: r.kind, role: r.role, origin: r.origin, storageKey: r.storage_key, sha256: r.sha256, mime: r.mime, bytes: Number(r.bytes), width: r.width, height: r.height, status: r.status, aiGenerated: r.ai_generated, provenance: r.provenance, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() });

export function createCore(cfg: CoreConfig) {
  // DATE columns stay plain 'YYYY-MM-DD' strings: pg's default turns them into local-midnight Dates, which shift a day when printed as UTC
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: 4,
    types: { getTypeParser: ((oid: number, format?: "text" | "binary") => (oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, format as "text"))) as never },
  });
  const s3 = new S3Client({
    endpoint: cfg.s3.endpoint,
    region: cfg.s3.region,
    forcePathStyle: cfg.s3.forcePathStyle,
    credentials: { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey },
    // S3-compatible stores (R2, RustFS) reject the newer default checksums
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

  const campaigns = {
    async list(): Promise<Campaign[]> {
      return (await q("select * from campaign order by root_id, created_at")).map(campaignFrom);
    },
    async add(input: { name: string; kind: Campaign["kind"]; parentId?: string | null; startsAt?: string | null; endsAt?: string | null }): Promise<Campaign> {
      if (input.kind === "campaign" && !input.parentId) throw new Error("A campaign needs a parent: the always-on base it belongs to");
      const id = randomUUID();
      let rootId = id;
      if (input.parentId) {
        const parent = (await q("select root_id from campaign where id = $1", [input.parentId]))[0];
        if (!parent) throw new Error(`No campaign with id ${input.parentId}`);
        rootId = parent.root_id;
      }
      const row = (await q(
        "insert into campaign (id, parent_id, root_id, name, kind, starts_at, ends_at) values ($1,$2,$3,$4,$5,$6,$7) returning *",
        [id, input.parentId ?? null, rootId, input.name, input.kind, input.startsAt ?? null, input.endsAt ?? null],
      ))[0];
      return campaignFrom(row);
    },
    /** Accepts an id or a unique name; with exactly one campaign and no hint, returns it. */
    async resolve(hint?: string | null): Promise<Campaign> {
      const all = await this.list();
      const hit = hint ? all.filter((p) => p.id === hint || p.name.toLowerCase() === hint.toLowerCase()) : all.length === 1 ? all : [];
      if (hit.length !== 1) throw new Error(hint ? `Campaign "${hint}" matches ${hit.length} campaigns` : "Pass a campaign (id or name): there are " + all.length + " campaigns");
      return hit[0];
    },
  };

  /** One row per action on an entry (docs/analytics.md D4): send-back notes are kept, approvals say who and when. */
  const event = (entryId: string, kind: string, actor: string, from: string | null, to: string | null, extra: { note?: string | null; reason?: string | null; data?: unknown } = {}) =>
    q("insert into entry_event (entry_id, kind, actor, from_status, to_status, note, reason, data) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [entryId, kind, actor, from, to, extra.note ?? null, extra.reason ?? null, extra.data === undefined ? null : JSON.stringify(extra.data)]);
  /** Attributes code can see in the entry; refreshed on every add and content edit. */
  const derive = async (e: CalendarEntry) => {
    const assetKind = e.assetId ? (await q("select kind from asset where id = $1", [e.assetId]))[0]?.kind ?? null : null;
    for (const [k, v] of Object.entries(deriveAttributes({ ...e, assetKind }))) {
      await q(`insert into entry_attribute (entry_id, key, value, source) values ($1,$2,$3,'derived')
               on conflict (entry_id, key) do update set value = excluded.value, source = 'derived'`, [e.id, k, v]);
    }
  };

  const calendar = {
    async list(campaignId?: string): Promise<CalendarEntry[]> {
      const rows = await q(
        `select c.*, p.name as campaign_name from content_calendar c join campaign p on p.id = c.campaign_id
         where ($1::uuid is null or c.campaign_id = $1) order by c.scheduled_at`,
        [campaignId ?? null],
      );
      return rows.map(entryFrom);
    },
    async add(input: { campaignId: string; title: string; channel: string; scheduledAt: string; tier: Tier; assetId?: string | null; body?: string; link?: string | null; createdBy?: string }): Promise<CalendarEntry> {
      if (Number.isNaN(Date.parse(input.scheduledAt))) throw new Error(`Invalid date: ${input.scheduledAt}`);
      const link = cleanLink(input.link);
      // tier 1 passes automatically, tier 2 and 3 wait for a human (docs/architecture.md)
      const status: Status = input.tier === 1 ? "approved" : "pending_approval";
      const id = (await q(
        `insert into content_calendar (campaign_id, title, channel, scheduled_at, tier, status, asset_id, created_by, body, link, approved_at, approved_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $6 = 'approved' then now() end, case when $6 = 'approved' then 'auto' end) returning id`,
        [input.campaignId, input.title, input.channel, new Date(input.scheduledAt).toISOString(), input.tier, status, input.assetId ?? null, input.createdBy ?? "unknown", input.body ?? "", link],
      ))[0].id;
      await event(id, "created", input.createdBy ?? "unknown", null, status);
      const entry = (await calendar.get(id))!;
      await derive(entry);
      return entry;
    },
    async get(id: string): Promise<CalendarEntry | null> {
      const rows = await q("select c.*, p.name as campaign_name from content_calendar c join campaign p on p.id = c.campaign_id where c.id = $1", [id]);
      return rows[0] ? entryFrom(rows[0]) : null;
    },
    async decide(id: string, decision: "approve" | "cancel", actor = "unknown"): Promise<CalendarEntry> {
      const entry = await calendar.get(id);
      if (!entry) throw new Error(`No calendar entry with id ${id}`);
      assertActionable(entry);
      if (decision === "approve" && entry.status !== "pending_approval") throw new Error(`Entry ${id} is ${entry.status}, only pending_approval can be approved`);
      const to = decision === "approve" ? "approved" : "cancelled";
      await q(`update content_calendar set status = $2, approved_at = case when $2 = 'approved' then now() else approved_at end,
                 approved_by = case when $2 = 'approved' then $3 else approved_by end where id = $1`, [id, to, actor]);
      await event(id, to, actor, entry.status, to);
      return (await calendar.get(id))!;
    },
    /**
     * Take an upcoming approved entry back to pending_approval. Approval stays a manual step: nothing re-approves it,
     * not even tier 1 (that is automatic only when the entry is created).
     */
    async unapprove(id: string, actor = "unknown"): Promise<CalendarEntry> {
      const entry = await calendar.get(id);
      if (!entry) throw new Error(`No calendar entry with id ${id}`);
      assertActionable(entry);
      if (entry.status !== "approved") throw new Error(`Entry ${id} is ${entry.status}, only approved entries can go back to pending_approval`);
      await q("update content_calendar set status = 'pending_approval', approved_at = null, approved_by = null where id = $1", [id]);
      await event(id, "unapproved", actor, entry.status, "pending_approval");
      return (await calendar.get(id))!;
    },
    /** Send a pending entry back to its author with a note (and, best, a reason from REVIEW_REASONS). Any later edit resubmits it. */
    async requestChanges(id: string, note: string, opts: { actor?: string; reason?: string | null } = {}): Promise<CalendarEntry> {
      const entry = await calendar.get(id);
      if (!entry) throw new Error(`No calendar entry with id ${id}`);
      assertActionable(entry);
      if (entry.status !== "pending_approval") throw new Error(`Entry ${id} is ${entry.status}, only pending_approval can be sent back`);
      if (note.trim() === "") throw new Error("Say what should change (note is empty)");
      if (opts.reason && !(REVIEW_REASONS as readonly string[]).includes(opts.reason)) throw new Error(`Unknown reason "${opts.reason}" (use ${REVIEW_REASONS.join(", ")})`);
      await q("update content_calendar set status = 'changes_requested', review_note = $2 where id = $1", [id, note.trim()]);
      await event(id, "changes_requested", opts.actor ?? "unknown", entry.status, "changes_requested", { note: note.trim(), reason: opts.reason ?? null });
      return (await calendar.get(id))!;
    },
    /**
     * Edit an entry. Approval is about the content, so changing text, link, channel or creative of an approved entry
     * (tier 2 and 3) sends it back to pending_approval; moving it in time keeps the approval. An edit of an entry
     * that was sent back resubmits it. Frozen entries (see assertActionable) cannot be edited.
     */
    async update(id: string, patch: { title?: string; body?: string; link?: string | null; channel?: string; scheduledAt?: string; assetId?: string | null }, actor = "unknown"): Promise<CalendarEntry> {
      const entry = await calendar.get(id);
      if (!entry) throw new Error(`No calendar entry with id ${id}`);
      assertActionable(entry);
      const next = {
        title: patch.title ?? entry.title,
        body: patch.body ?? entry.body,
        link: patch.link === undefined ? entry.link : cleanLink(patch.link),
        channel: patch.channel ?? entry.channel,
        assetId: patch.assetId === undefined ? entry.assetId : patch.assetId,
        scheduledAt: patch.scheduledAt === undefined ? entry.scheduledAt : new Date(patch.scheduledAt).toISOString(),
      };
      if (next.title.trim() === "" || next.channel.trim() === "") throw new Error("Title and channel cannot be empty");
      if (Number.isNaN(Date.parse(next.scheduledAt))) throw new Error(`Invalid date: ${patch.scheduledAt}`);
      const changed = (["title", "body", "link", "channel", "assetId", "scheduledAt"] as const).filter((k) => next[k] !== entry[k]);
      const contentChanged = changed.some((k) => k !== "scheduledAt");
      const timeChanged = changed.includes("scheduledAt");
      let status: Status = entry.status;
      if (entry.status === "changes_requested" && (contentChanged || timeChanged)) status = "pending_approval";
      else if (contentChanged && entry.tier > 1 && (entry.status === "approved" || entry.status === "scheduled")) status = "pending_approval";
      await q(
        `update content_calendar set title = $2, body = $3, link = $4, channel = $5, asset_id = $6, scheduled_at = $7, status = $8,
           review_note = case when $8 = 'changes_requested' then review_note else null end,
           approved_at = case when $8 = 'pending_approval' then null else approved_at end,
           approved_by = case when $8 = 'pending_approval' then null else approved_by end where id = $1`,
        [id, next.title, next.body, next.link, next.channel, next.assetId, next.scheduledAt, status],
      );
      if (changed.length > 0) await event(id, "edited", actor, entry.status, status, { data: { fields: changed } });
      const updated = (await calendar.get(id))!;
      if (contentChanged || timeChanged) await derive(updated);
      return updated;
    },
    /** Every action on the entry, oldest first. */
    async history(id: string): Promise<EntryEvent[]> {
      return (await q("select * from entry_event where entry_id = $1 order by at, id", [id])).map((r: any) => ({
        id: Number(r.id), entryId: r.entry_id, kind: r.kind, actor: r.actor, fromStatus: r.from_status, toStatus: r.to_status, note: r.note, reason: r.reason, data: r.data, at: new Date(r.at).toISOString(),
      }));
    },
    /** The entry's attributes (derived by code, tagged by an agent or a person). */
    async attributes(id: string): Promise<Record<string, { value: string; source: string }>> {
      return Object.fromEntries((await q("select key, value, source from entry_attribute where entry_id = $1 order by key", [id])).map((r: any) => [r.key, { value: r.value, source: r.source }]));
    },
  };

  /** Per-campaign publishing targets (the Telegram chat, later an e-mail list...), inherited from the parent campaign. */
  const channels = {
    async set(campaignId: string, channel: string, config: Record<string, string>): Promise<void> {
      await q("insert into campaign_channel (campaign_id, channel, config) values ($1,$2,$3) on conflict (campaign_id, channel) do update set config = excluded.config", [campaignId, channel, config]);
    },
    async unset(campaignId: string, channel: string): Promise<boolean> {
      return (await q("delete from campaign_channel where campaign_id = $1 and channel = $2 returning 1", [campaignId, channel])).length > 0;
    },
    /** The campaign's own targets. */
    async list(campaignId: string): Promise<{ channel: string; config: Record<string, string> }[]> {
      return (await q("select channel, config from campaign_channel where campaign_id = $1 order by channel", [campaignId])).map((r: any) => ({ channel: r.channel, config: r.config }));
    },
    /** The target in effect: the campaign's own, else the nearest parent's; null when none is set. */
    async get(campaignId: string, channel: string): Promise<Record<string, string> | null> {
      const rows = await q(
        `with recursive up as (select id, parent_id, 0 as depth from campaign where id = $1
                               union all select c.id, c.parent_id, up.depth + 1 from campaign c join up on c.id = up.parent_id)
         select cc.config from up join campaign_channel cc on cc.campaign_id = up.id and cc.channel = $2 order by up.depth limit 1`,
        [campaignId, channel],
      );
      return rows[0]?.config ?? null;
    },
  };

  /** The scheduler's clock: the database time plus the development offset (0 in production), so a simulated world runs on one time. */
  const NOW = "(now() + coalesce((select offset_seconds from sim_clock where id = 1), 0) * interval '1 second')";

  /** What `publish.ts` drives: claim due entries, record the outcome. Bypasses assertActionable on purpose: due entries are frozen for people. */
  const publishing = {
    MAX_ATTEMPTS: 3,
    /**
     * Take up to `limit` approved entries whose time has come (and whose retry time has passed), set them to `publishing`
     * and count the attempt. Entries stuck in `publishing` for over 10 minutes (a run that died) are taken again; the
     * connector's idempotency key makes that safe. SKIP LOCKED: two runs never get the same entry.
     */
    async claimDue(limit = 10, campaignIds?: string[]): Promise<CalendarEntry[]> {
      const ids = await q(
        `update content_calendar set status = 'publishing', attempts = attempts + 1, claimed_at = now(), error = null
         where id in (
           select id from content_calendar
           where ((status = 'approved' and scheduled_at <= ${NOW} and coalesce(next_attempt_at, scheduled_at) <= ${NOW})
              or (status = 'publishing' and claimed_at < now() - interval '10 minutes'))
             and ($2::uuid[] is null or campaign_id = any($2::uuid[]))
           order by scheduled_at limit $1 for update skip locked)
         returning id`,
        [limit, campaignIds ?? null],
      );
      return (await Promise.all(ids.map((r: any) => calendar.get(r.id)))).filter((e): e is CalendarEntry => e !== null);
    },
    async markPublished(id: string, result: { externalId: string; url?: string }): Promise<void> {
      await q("update content_calendar set status = 'published', external_id = $2, external_url = $3, error = null where id = $1", [id, result.externalId, result.url ?? null]);
      await event(id, "published", "scheduler", "publishing", "published", { data: { externalId: result.externalId } });
    },
    /** Retry later with a growing delay (2, 4 min), and `failed` after MAX_ATTEMPTS. Returns the new status. */
    async markFailed(id: string, error: string): Promise<"approved" | "failed"> {
      const row = (await q(
        `update content_calendar set error = $2,
           status = case when attempts >= $3 then 'failed' else 'approved' end,
           next_attempt_at = case when attempts >= $3 then null else ${NOW} + (power(2, attempts) * interval '1 minute') end
         where id = $1 returning status`,
        [id, error.slice(0, 500), publishing.MAX_ATTEMPTS],
      ))[0];
      if (row.status === "failed") await event(id, "failed", "scheduler", "publishing", "failed", { note: error.slice(0, 500) });
      return row.status;
    },
    /** No connector for the channel: the entry waits for a human to publish it by hand. */
    async markManual(id: string, reason: string): Promise<void> {
      await q("update content_calendar set status = 'needs_manual', error = $2 where id = $1", [id, reason]);
      await event(id, "needs_manual", "scheduler", "publishing", "needs_manual", { note: reason });
    },
  };

  const assets = {
    /** Hash, upload to S3 under p/<campaign>/<sha256>.<ext> if missing, record in Postgres. Idempotent per (campaign, content). */
    async save(input: { campaignId: string; file?: string; bytes?: Uint8Array; filename?: string; role: Asset["role"]; origin: Asset["origin"]; kind?: string; aiGenerated?: boolean; provenance?: unknown; rights?: unknown; createdBy?: string }): Promise<Asset> {
      const bytes = input.bytes ?? (input.file ? await readFile(input.file) : undefined);
      if (!bytes) throw new Error("save needs file or bytes");
      const name = input.filename ?? (input.file ? basename(input.file) : "asset");
      const ext = extname(name).toLowerCase();
      const mime = MIME[ext] ?? "application/octet-stream";
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `c/${input.campaignId}/${sha256}${ext}`;
      const exists = await s3.send(new HeadObjectCommand({ Bucket: cfg.s3.bucket, Key: key })).then(() => true, () => false);
      if (!exists) await s3.send(new PutObjectCommand({ Bucket: cfg.s3.bucket, Key: key, Body: bytes, ContentType: mime }));
      const buf = Buffer.from(bytes);
      const isPng = mime === "image/png" && buf.length > 24;
      const inserted = await q(
        `insert into asset (campaign_id, name, kind, role, origin, storage_key, sha256, mime, bytes, width, height, ai_generated, rights, provenance, created_by)
         values ($1,$15,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (campaign_id, sha256) do nothing returning *`,
        [input.campaignId, input.kind ?? kindOf(mime), input.role, input.origin, key, sha256, mime, buf.length,
         isPng ? buf.readUInt32BE(16) : null, isPng ? buf.readUInt32BE(20) : null, input.aiGenerated ?? false,
         JSON.stringify(input.rights ?? null), JSON.stringify(input.provenance ?? null), input.createdBy ?? "unknown", name],
      );
      return assetFrom(inserted[0] ?? (await q("select * from asset where campaign_id = $1 and sha256 = $2", [input.campaignId, sha256]))[0]);
    },
    async list(campaignId?: string): Promise<Asset[]> {
      return (await q("select * from asset where ($1::uuid is null or campaign_id = $1) order by created_at desc", [campaignId ?? null])).map(assetFrom);
    },
    /** Rename, change status or role. Everything else is immutable (content-addressed). */
    async update(id: string, patch: { name?: string; status?: (typeof ASSET_STATUSES)[number]; role?: Asset["role"] }): Promise<Asset> {
      if (patch.name !== undefined && patch.name.trim() === "") throw new Error("Name must not be empty");
      if (patch.status !== undefined && !ASSET_STATUSES.includes(patch.status)) throw new Error(`Invalid status ${patch.status}`);
      await assets.get(id);
      await q("update asset set name = coalesce($2, name), status = coalesce($3, status), role = coalesce($4, role) where id = $1",
        [id, patch.name?.trim() ?? null, patch.status ?? null, patch.role ?? null]);
      return assets.get(id);
    },
    /** Refuses while a calendar entry uses it. Removes links and, last, the S3 object (keys are per campaign, so nothing else shares it). */
    async delete(id: string): Promise<void> {
      const a = await assets.get(id);
      const used = Number((await q("select count(*) as n from content_calendar where asset_id = $1", [id]))[0].n);
      if (used > 0) throw new Error(`Asset ${id} is used by ${used} calendar ${used === 1 ? "entry" : "entries"}; cancel or change them first`);
      await q("delete from asset_link where parent_id = $1 or child_id = $1", [id]);
      await q("delete from asset where id = $1", [id]);
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.s3.bucket, Key: a.storageKey }));
    },
    async get(id: string): Promise<Asset> {
      const row = (await q("select * from asset where id = $1", [id]))[0];
      if (!row) throw new Error(`No asset with id ${id}`);
      return assetFrom(row);
    },
    /** Short-lived signed URL; the bucket itself stays private. */
    async url(id: string, expiresSec = 300): Promise<string> {
      const a = await assets.get(id);
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: a.storageKey }), { expiresIn: expiresSec });
    },
    /**
     * Copy an image to the public bucket under a permanent, content-addressed key and return its public address. E-mails need this:
     * a signed link expires, an e-mail is read for weeks. Only images, only on request; the private bucket stays private.
     */
    async publishPublic(id: string, pub: { bucket: string; baseUrl: string }): Promise<string> {
      const a = await assets.get(id);
      if (!a.mime.startsWith("image/")) throw new Error(`Only images are published to the public bucket (${a.name} is ${a.mime})`);
      const key = `e/${a.sha256}${extname(a.storageKey)}`;
      const exists = await s3.send(new HeadObjectCommand({ Bucket: pub.bucket, Key: key })).then(() => true, () => false);
      if (!exists) {
        const source = await s3.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: a.storageKey }));
        await s3.send(new PutObjectCommand({ Bucket: pub.bucket, Key: key, Body: await source.Body!.transformToByteArray(), ContentType: a.mime, CacheControl: "public, max-age=31536000, immutable" }));
      }
      return `${pub.baseUrl.replace(/\/+$/, "")}/${key}`;
    },
    async read(id: string): Promise<Buffer> {
      const a = await assets.get(id);
      const res = await s3.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: a.storageKey }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
  };

  // Scoped settings: the scope chain of a campaign is itself, its parent (the always-on base), then global.
  const settings = createSettings({
    q,
    fields: SETTING_FIELDS,
    secretKey: cfg.secretKey,
    chain: async (scope: Scope) => {
      if (scope === null) return [null];
      const all = await campaigns.list();
      const out: Scope[] = [];
      let cur = all.find((c) => c.id === scope);
      if (!cur) throw new Error(`No campaign with id ${scope}`);
      while (cur && out.length < 10) {
        out.push(cur.id);
        const parent: string | null = cur.parentId;
        cur = parent ? all.find((c) => c.id === parent) : undefined;
      }
      return [...out, null];
    },
  });

  const generation = {
    /** The provider a scope generates with (or the given one), and its settings as that scope sees them. */
    async providerFor(scope: Scope, host: { profilesDir: string; bins?: Record<string, string> }, providerId?: string) {
      const id = providerId ?? String((await settings.resolve(scope, "generation.provider"))?.value);
      const provider = providerById(id);
      const values: Record<string, SettingValue> = {};
      for (const f of provider.fields) {
        const r = await settings.resolve(scope, `${provider.id}.${f.key}`);
        if (r) values[f.key] = r.value;
      }
      const config: ProviderConfig = { bin: host.bins?.[provider.id], profilesDir: host.profilesDir, values };
      return { provider, config };
    },
    /** Daily budgets that apply to a scope: every scope of its chain that sets one (the global one falls back to the default). */
    async budgets(scope: Scope, providerId: string): Promise<{ scope: Scope; limit: number }[]> {
      const key = `${providerId}.dailyBudget`;
      const out: { scope: Scope; limit: number }[] = [];
      for (const s of await settings.chain(scope)) {
        const limit = (await settings.own(s, key)) ?? (s === null ? settings.fields.find((f) => f.key === key)?.default : undefined);
        if (typeof limit === "number") out.push({ scope: s, limit });
      }
      return out;
    },
  };

  return { campaigns, calendar, publishing, channels, assets, settings, generation, pool, close: async () => { await pool.end(); s3.destroy(); } };
}
export type Core = ReturnType<typeof createCore>;
