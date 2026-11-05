// Meta connectors: Facebook Pages and Instagram professional accounts through the Graph API (https://developers.facebook.com/docs/graph-api).
// One token (plugin setting, META_PUBLISH_TOKEN in .env): a system user of the client's business with pages_manage_posts,
// pages_read_engagement, instagram_basic and instagram_content_publish on the Pages and Instagram accounts it may post to
// (docs/channels.md). Each campaign says where: `campaign channel set facebook pageId=<id>` and `campaign channel set instagram
// accountId=<ig user id>`; targets are inherited from the parent campaign.
// Facebook: text, a photo or a video on the Page; the Page's own token is fetched per post. Instagram: a JPEG photo or a video as a Reel
// (the only video kind the API still publishes), through a media container that Meta fetches from the asset's signed URL, so the storage
// must be reachable from the internet (the local emulator is not).
// shortcut: like Telegram, the Graph API has no idempotency key for posts, so a crash between "posted" and "recorded" can post twice.
import type { Connector, PublishInput } from "./publish.ts";
import { campaignSlug, tagText, withUtm } from "./email/domain/render.ts";
import { replaceUrls } from "./links/domain.ts";

const GRAPH = "https://graph.facebook.com";
const GRAPH_VIDEO = "https://graph-video.facebook.com"; // uploads of video bytes go to this host
const DEFAULT_VERSION = "v23.0";
const FB_TEXT_MAX = 63_206;
const IG_CAPTION_MAX = 2200;
const FB_PHOTO_MAX_MB = 10, FB_VIDEO_MAX_MB = 1000, IG_VIDEO_MAX_MB = 1000;
/** A Reel container is processed by Meta before it can be published: poll its status, up to about three minutes. */
const IG_POLL = { everyMs: 3_000, attempts: 60 };
const MB = 1_000_000;

export type MetaOptions = {
  token: string;
  /** Graph API version, e.g. v23.0 (Meta retires a version about two years after its release). */
  version?: string;
  fetchImpl?: typeof fetch;
  /** Our short link for a link of the entry (docs/analytics.md, step 3), so its clicks are counted; without it links stay as they are. */
  shorten?: (entryId: string, url: string) => Promise<string>;
  /** Sleep, replaced in tests. */
  wait?: (ms: number) => Promise<void>;
};

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; type?: string } };

/** One Graph API call. The token travels in a header, never in the URL; a Graph error becomes an Error that names the call. */
function graph(opts: MetaOptions) {
  const f = opts.fetchImpl ?? fetch;
  const version = opts.version?.trim() || DEFAULT_VERSION;
  return async <T>(path: string, init: { method?: "GET" | "POST"; token?: string; params?: Record<string, string>; form?: FormData; host?: string } = {}): Promise<T> => {
    const url = new URL(`${init.host ?? GRAPH}/${version}/${path}`);
    for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v);
    const method = init.method ?? (init.form ? "POST" : "GET");
    const res = await f(url, { method, headers: { authorization: `Bearer ${init.token ?? opts.token}` }, body: init.form });
    const json = (await res.json().catch(() => ({}))) as T & GraphError;
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      throw new Error(`Meta ${method} /${path}: ${e.message ?? `HTTP ${res.status}`}${e.code !== undefined ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : ""}`);
    }
    return json;
  };
}

/** The post's text: the body with every link tagged (and shortened), the entry's link appended when the body does not have it. */
async function textOf(entry: PublishInput["entry"], source: string, opts: MetaOptions): Promise<{ text: string; link: string | null }> {
  const utm = { entryId: entry.id, campaign: campaignSlug(entry.campaignName), medium: "social", source };
  const short = (url: string) => (opts.shorten ? opts.shorten(entry.id, url) : Promise.resolve(url));
  const body = await replaceUrls(tagText(entry.body.trim(), utm), short);
  const link = entry.link ? await short(withUtm(entry.link, utm)) : null;
  const text = link && !body.includes(link) ? [body, link].filter(Boolean).join("\n\n") : body;
  return { text, link };
}

const blobOf = async (asset: NonNullable<PublishInput["asset"]>) => new Blob([(await asset.read()).slice()], { type: asset.mime });
const tooLarge = (asset: NonNullable<PublishInput["asset"]>, maxMb: number, where: string) => {
  if (asset.bytes > maxMb * MB) throw new Error(`${asset.name} is too large for ${where} (${maxMb} MB limit)`);
};

/** The Facebook Page connector: `campaign channel set facebook pageId=<page id>`. */
function facebook(opts: MetaOptions): Connector {
  const call = graph(opts);
  return {
    id: "meta-facebook",
    channels: ["facebook"],
    targetHint: "bb brandwise campaign channel set facebook pageId=<page id>   (bb brandwise meta test lists the Pages the token can post to)",
    async publish({ entry, asset, target }) {
      const pageId = target?.pageId?.trim();
      if (!pageId) throw new Error("No pageId in the campaign's facebook target");
      const { text, link } = await textOf(entry, "facebook", opts);
      if (text === "" && !asset) throw new Error("Entry has no text and no creative to post");
      if (text.length > FB_TEXT_MAX) throw new Error(`Text is ${text.length} characters, Facebook allows ${FB_TEXT_MAX}`);
      // posting needs the Page's own token; the system-user token gets it from the Page (which also proves the role on it)
      const page = await call<{ access_token?: string }>(pageId, { params: { fields: "access_token" } });
      if (!page.access_token) throw new Error(`The Meta token has no role on Page ${pageId}: assign the Page to the system user (docs/channels.md)`);
      const token = page.access_token;
      let postId: string;
      if (asset && asset.kind === "image") {
        tooLarge(asset, FB_PHOTO_MAX_MB, "a Facebook photo");
        const form = new FormData();
        form.set("source", await blobOf(asset), asset.name);
        if (text) form.set("caption", text);
        const r = await call<{ id: string; post_id?: string }>(`${pageId}/photos`, { token, form });
        postId = r.post_id ?? r.id;
      } else if (asset && asset.kind === "video") {
        tooLarge(asset, FB_VIDEO_MAX_MB, "a Facebook video");
        const form = new FormData();
        form.set("source", await blobOf(asset), asset.name);
        if (text) form.set("description", text);
        if (entry.title) form.set("title", entry.title.slice(0, 255));
        postId = (await call<{ id: string }>(`${pageId}/videos`, { token, form, host: GRAPH_VIDEO })).id;
      } else {
        const params: Record<string, string> = { message: text };
        if (link) params.link = link; // Facebook renders the preview from `link`
        postId = (await call<{ id: string }>(`${pageId}/feed`, { method: "POST", token, params })).id;
      }
      return { externalId: postId, url: `https://www.facebook.com/${postId}` };
    },
  };
}

/** The Instagram connector: `campaign channel set instagram accountId=<ig user id>` (the professional account linked to a Page). */
function instagram(opts: MetaOptions): Connector {
  const call = graph(opts);
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "meta-instagram",
    channels: ["instagram"],
    targetHint: "bb brandwise campaign channel set instagram accountId=<ig user id>   (bb brandwise meta test lists the accounts the token can post to)",
    async publish({ entry, asset, target }) {
      const igId = target?.accountId?.trim();
      if (!igId) throw new Error("No accountId in the campaign's instagram target");
      if (!asset || (asset.kind !== "image" && asset.kind !== "video")) throw new Error("An Instagram post needs an image or a video: attach a creative to the entry");
      if (asset.kind === "image" && asset.mime !== "image/jpeg") throw new Error(`Instagram takes JPEG photos only; ${asset.name} is ${asset.mime}`);
      if (asset.kind === "video") tooLarge(asset, IG_VIDEO_MAX_MB, "an Instagram Reel");
      const { text } = await textOf(entry, "instagram", opts);
      if (text.length > IG_CAPTION_MAX) throw new Error(`Caption is ${text.length} characters, Instagram allows ${IG_CAPTION_MAX}`);
      // 1. a container that Meta fills from a URL it can reach (the asset's signed URL; the local emulator is not reachable)
      const mediaUrl = await asset.url();
      const params: Record<string, string> = asset.kind === "video" ? { media_type: "REELS", video_url: mediaUrl } : { image_url: mediaUrl };
      if (text) params.caption = text;
      const container = (await call<{ id: string }>(`${igId}/media`, { method: "POST", params })).id;
      // 2. a video is processed first; a photo is ready at once
      if (asset.kind === "video") {
        let status = "IN_PROGRESS";
        for (let i = 0; i < IG_POLL.attempts && status === "IN_PROGRESS"; i++) {
          await wait(IG_POLL.everyMs);
          const s = await call<{ status_code?: string; status?: string }>(container, { params: { fields: "status_code,status" } });
          status = s.status_code ?? "IN_PROGRESS";
          if (status === "ERROR" || status === "EXPIRED") throw new Error(`Instagram did not accept the video: ${s.status ?? status}`);
        }
        if (status !== "FINISHED") throw new Error("Instagram is still processing the video after three minutes; the entry is retried");
      }
      // 3. publish the container
      const mediaId = (await call<{ id: string }>(`${igId}/media_publish`, { method: "POST", params: { creation_id: container } })).id;
      const permalink = await call<{ permalink?: string }>(mediaId, { params: { fields: "permalink" } }).then((r) => r.permalink, () => undefined);
      return { externalId: mediaId, url: permalink };
    },
  };
}

/** Both Meta connectors on one token. */
export const meta = (opts: MetaOptions): Connector[] => [facebook(opts), instagram(opts)];

export type MetaStatus = {
  me: { id: string; name?: string };
  pages: { id: string; name: string; instagram?: { id: string; username?: string } }[];
  lines: string[];
};

/**
 * What the token can do, for a person setting a channel up (`bb brandwise meta test`): who the token belongs to, the Pages it can post
 * to with their Instagram accounts (the ids to put in the campaign targets), and whether the campaign's targets are among them.
 */
export async function metaStatus(opts: MetaOptions, targets: { facebook: Record<string, string> | null; instagram: Record<string, string> | null } | null): Promise<MetaStatus> {
  const call = graph(opts);
  const me = await call<{ id: string; name?: string }>("me", { params: { fields: "id,name" } });
  const raw = await call<{ data?: { id: string; name: string; instagram_business_account?: { id: string; username?: string } }[] }>("me/accounts", { params: { fields: "id,name,instagram_business_account{id,username}", limit: "100" } });
  const pages = (raw.data ?? []).map((p) => ({ id: p.id, name: p.name, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : undefined }));
  const lines = [`Token of ${me.name ?? "a system user"} (${me.id}): ${pages.length} Page${pages.length === 1 ? "" : "s"} it can post to`];
  for (const p of pages) lines.push(`  facebook pageId=${p.id}  ${p.name}${p.instagram ? `   instagram accountId=${p.instagram.id}  @${p.instagram.username ?? "?"}` : "   (no Instagram account linked to this Page)"}`);
  if (pages.length === 0) lines.push("  No Pages: assign the client's Page (and its Instagram account) to the system user in Business Settings, then generate the token again.");
  if (targets) {
    const pageId = targets.facebook?.pageId?.trim(), igId = targets.instagram?.accountId?.trim();
    lines.push(!pageId ? "facebook target: none (bb brandwise campaign channel set facebook pageId=<id>)" : pages.some((p) => p.id === pageId) ? `facebook target ${pageId}: ok` : `facebook target ${pageId}: NOT among the Pages of this token`);
    lines.push(!igId ? "instagram target: none (bb brandwise campaign channel set instagram accountId=<id>)" : pages.some((p) => p.instagram?.id === igId) ? `instagram target ${igId}: ok` : `instagram target ${igId}: NOT among the Instagram accounts of this token`);
  }
  return { me, pages, lines };
}
