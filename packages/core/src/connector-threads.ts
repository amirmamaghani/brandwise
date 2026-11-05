// Threads connector: posts through the Threads API (https://developers.facebook.com/docs/threads). The Threads app id and secret
// (a Meta app with the Threads use case) are plugin settings; each campaign connects its Threads account once (`bb brandwise threads
// connect`, docs/channels.md). Threads has no refresh tokens: the connection is a long-lived access token (60 days) that is renewed when
// it is at least a day old, so posting at least once in 60 days keeps it alive. It is stored as a scoped secret (`threads.accessToken`,
// JSON with the token and its dates; inherited by child campaigns, never shown to agents), the account is the campaign's `threads`
// target (userId, username).
// A post is text (500 characters) with the entry's link as a link card, or one image (JPEG or PNG, 8 MB) or one video (MP4 or MOV,
// 1 GB, 5 minutes) with the text as caption, through a container Threads fills from the asset's signed URL, so the storage must be
// reachable from the internet (the local emulator is not).
import type { Connector, ScopedTokens } from "./publish.ts";
import { campaignSlug, tagText, withUtm } from "./email/domain/render.ts";
import { replaceUrls } from "./links/domain.ts";

const AUTHORIZE = "https://threads.com/oauth/authorize";
const GRAPH = "https://graph.threads.com";
const VERSION = "v1.0";
export const THREADS_SCOPES = ["threads_basic", "threads_content_publish"];
export const THREADS_TOKEN_KEY = "threads.accessToken";
const TEXT_MAX = 500;
const MB = 1_000_000;
const IMAGE_MAX_MB = 8, VIDEO_MAX_MB = 1000;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png"]), VIDEO_MIMES = new Set(["video/mp4", "video/quicktime"]);
/** Threads asks for about 30 s before publishing a container and for polling no more than once a minute for five minutes. */
const POLL = { everyMs: 20_000, attempts: 12 };
const DAY_MS = 86_400_000;

export type ThreadsApp = { appId: string; appSecret: string };
export type ThreadsOptions = ThreadsApp & {
  tokens: ScopedTokens;
  fetchImpl?: typeof fetch;
  shorten?: (entryId: string, url: string) => Promise<string>;
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
};
/** What the scoped secret holds: the long-lived token and when it was issued or last renewed. */
export type ThreadsConnection = { token: string; userId: string; expiresAt: string; refreshedAt: string };
type ApiError = { error?: { message?: string; type?: string; code?: number }; error_type?: string; error_message?: string; code?: number };

const messageOf = (json: ApiError, status: number) => json.error?.message ?? json.error_message ?? `HTTP ${status}`;

/** One Graph call to Threads; the token travels in a header. */
function graph(f: typeof fetch) {
  return async <T>(method: "GET" | "POST", path: string, token: string, params: Record<string, string> = {}): Promise<T> => {
    const url = new URL(`${GRAPH}/${VERSION}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await f(url, { method, headers: { authorization: `Bearer ${token}` } });
    const json = (await res.json().catch(() => ({}))) as T & ApiError;
    if (!res.ok || json.error) throw new Error(`Threads ${method} /${path}: ${messageOf(json, res.status)}${json.error?.code ? ` (code ${json.error.code})` : ""}`);
    return json;
  };
}

/** The OAuth side: the address a person opens, the code exchange (ending with a 60-day token), the renewal. */
export function threadsOAuth(app: ThreadsApp, fetchImpl: typeof fetch = fetch) {
  const call = async <T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> => {
    const url = new URL(`${GRAPH}/${path}`);
    const init: RequestInit = { method };
    if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    else { init.headers = { "content-type": "application/x-www-form-urlencoded" }; init.body = new URLSearchParams(params); }
    const res = await fetchImpl(url, init);
    const json = (await res.json().catch(() => ({}))) as T & ApiError & { access_token?: string };
    if (!res.ok || !json.access_token) throw new Error(`Threads ${path}: ${messageOf(json, res.status)}`);
    return json;
  };
  return {
    authorizeUrl(redirectUri: string, state: string): string {
      const u = new URL(AUTHORIZE);
      for (const [k, v] of Object.entries({ client_id: app.appId, redirect_uri: redirectUri, scope: THREADS_SCOPES.join(","), response_type: "code", state })) u.searchParams.set(k, v);
      return u.toString();
    },
    /** Code -> one-hour token -> 60-day token. */
    async exchange(code: string, redirectUri: string, now = new Date()): Promise<ThreadsConnection> {
      const short = await call<{ access_token: string; user_id: number | string }>("POST", "oauth/access_token", { client_id: app.appId, client_secret: app.appSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri });
      const long = await call<{ access_token: string; expires_in: number }>("GET", "access_token", { grant_type: "th_exchange_token", client_secret: app.appSecret, access_token: short.access_token });
      return { token: long.access_token, userId: String(short.user_id), expiresAt: new Date(now.getTime() + long.expires_in * 1000).toISOString(), refreshedAt: now.toISOString() };
    },
    /** A token at least a day old and not expired gets another 60 days. */
    async refresh(c: ThreadsConnection, now = new Date()): Promise<ThreadsConnection> {
      const r = await call<{ access_token: string; expires_in: number }>("GET", "refresh_access_token", { grant_type: "th_refresh_token", access_token: c.token });
      return { ...c, token: r.access_token, expiresAt: new Date(now.getTime() + r.expires_in * 1000).toISOString(), refreshedAt: now.toISOString() };
    },
  };
}

export type ThreadsProfile = { id: string; username?: string };
export const threadsProfile = (fetchImpl: typeof fetch, token: string) => graph(fetchImpl)<ThreadsProfile>("GET", "me", token, { fields: "id,username" });

/** The campaign's connection, renewed when it is a day old (so it never reaches its 60-day end while the account posts). */
export async function threadsConnection(opts: ThreadsOptions, campaignId: string): Promise<ThreadsConnection> {
  const saved = await opts.tokens.get(campaignId, THREADS_TOKEN_KEY);
  if (!saved) throw new Error("This campaign has no Threads account: a person runs bb brandwise threads connect --campaign <c> (docs/channels.md)");
  let c: ThreadsConnection;
  try { c = JSON.parse(saved) as ThreadsConnection; } catch { throw new Error("The stored Threads connection is unreadable: connect the account again"); }
  const now = (opts.now ?? (() => new Date()))();
  if (now.getTime() >= Date.parse(c.expiresAt)) throw new Error(`The Threads connection expired on ${c.expiresAt.slice(0, 10)} (no post for 60 days): a person runs bb brandwise threads connect again`);
  if (now.getTime() - Date.parse(c.refreshedAt) >= DAY_MS) {
    c = await threadsOAuth(opts, opts.fetchImpl ?? fetch).refresh(c, now);
    await opts.tokens.set(campaignId, THREADS_TOKEN_KEY, JSON.stringify(c));
  }
  return c;
}

export function threads(opts: ThreadsOptions): Connector {
  const f = opts.fetchImpl ?? fetch;
  const call = graph(f);
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "threads",
    channels: ["threads"],
    targetHint: "bb brandwise threads connect --campaign <c>   (a person signs in to the Threads account once; it becomes the campaign's threads target)",
    async publish({ entry, asset, target }) {
      const userId = target?.userId?.trim();
      if (!userId) throw new Error("No userId in the campaign's threads target");
      if (asset && !((asset.kind === "image" && IMAGE_MIMES.has(asset.mime)) || (asset.kind === "video" && VIDEO_MIMES.has(asset.mime)))) {
        throw new Error(`Threads takes JPEG or PNG images and MP4 or MOV videos; ${asset.name} is ${asset.mime}`);
      }
      if (asset && asset.bytes > (asset.kind === "video" ? VIDEO_MAX_MB : IMAGE_MAX_MB) * MB) throw new Error(`${asset.name} is too large for Threads (${asset.kind === "video" ? VIDEO_MAX_MB : IMAGE_MAX_MB} MB limit)`);
      const utm = { entryId: entry.id, campaign: campaignSlug(entry.campaignName), medium: "social", source: "threads" };
      const short = (url: string) => (opts.shorten ? opts.shorten(entry.id, url) : Promise.resolve(url));
      const body = await replaceUrls(tagText(entry.body.trim(), utm), short);
      const link = entry.link ? await short(withUtm(entry.link, utm)) : null;
      // a text post carries the link as a card; a post with media has no card, so the link goes into the text
      const text = asset && link && !body.includes(link) ? [body, link].filter(Boolean).join("\n\n") : body;
      if (!text && !asset) throw new Error("Entry has no text and no creative to post");
      if (text.length > TEXT_MAX) throw new Error(`Text is ${text.length} characters, Threads allows ${TEXT_MAX}`);

      const { token } = await threadsConnection(opts, entry.campaignId);
      const params: Record<string, string> = asset ? { media_type: asset.kind === "video" ? "VIDEO" : "IMAGE", [asset.kind === "video" ? "video_url" : "image_url"]: await asset.url() } : { media_type: "TEXT" };
      if (text) params.text = text;
      if (!asset && link) params.link_attachment = link;
      const container = (await call<{ id: string }>("POST", `${userId}/threads`, token, params)).id;
      // Threads processes the container (a video for a while); publishing before FINISHED fails
      let status = "IN_PROGRESS", detail: string | undefined;
      for (let i = 0; i < POLL.attempts && status === "IN_PROGRESS"; i++) {
        if (i > 0) await wait(POLL.everyMs);
        const s = await call<{ status?: string; error_message?: string }>("GET", container, token, { fields: "status,error_message" });
        status = s.status ?? "IN_PROGRESS"; detail = s.error_message;
        if (status === "ERROR" || status === "EXPIRED") throw new Error(`Threads did not accept the post: ${detail ?? status}`);
      }
      if (status !== "FINISHED") throw new Error("Threads is still processing the post after four minutes; the entry is retried");
      const mediaId = (await call<{ id: string }>("POST", `${userId}/threads_publish`, token, { creation_id: container })).id;
      const permalink = await call<{ permalink?: string }>("GET", mediaId, token, { fields: "permalink" }).then((r) => r.permalink, () => undefined);
      return { externalId: mediaId, url: permalink };
    },
  };
}

/** What the campaign's Threads connection is, for a person (`bb brandwise threads status`). */
export async function threadsStatus(opts: ThreadsOptions, campaignId: string, target: Record<string, string> | null): Promise<{ connected: boolean; profile: ThreadsProfile | null; lines: string[] }> {
  if (!(await opts.tokens.get(campaignId, THREADS_TOKEN_KEY))) return { connected: false, profile: null, lines: ["No Threads account connected to this campaign: bb brandwise threads connect --campaign <c>"] };
  const c = await threadsConnection(opts, campaignId);
  const profile = await threadsProfile(opts.fetchImpl ?? fetch, c.token);
  const days = Math.max(0, Math.floor((Date.parse(c.expiresAt) - (opts.now ?? (() => new Date()))().getTime()) / DAY_MS));
  return { connected: true, profile, lines: [
    `@${profile.username ?? profile.id} (${profile.id}): connected; the token is renewed at each post and ends in ${days} days without one`,
    target ? `threads target: ${JSON.stringify(target)}` : "threads target: none (connect sets it; without it entries wait as Publish by hand)",
  ] };
}
