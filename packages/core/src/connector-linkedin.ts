// LinkedIn connector: posts through the Posts API (https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api).
// The app's client id and secret are plugin settings; each campaign connects a member once (`bb brandwise linkedin connect`,
// docs/channels.md). LinkedIn gives a 60-day access token and, to approved Marketing Developer Platform partners only, a refresh token;
// the connection (token and dates) is a scoped secret (`linkedin.accessToken`, inherited by child campaigns, never shown to agents), the
// member the campaign's `linkedin` target (personId, name). Without a refresh token the person connects again every 60 days.
// A post is text with the entry's link as an article card, or text with one image (JPEG, PNG or GIF) or one video (MP4, 75 KB to
// 500 MB, uploaded in 4 MB parts, finalised and processed before posting). The author is the member; a company Page as author
// (`organizationId` in the target) needs the Community Management API, which LinkedIn grants per application. Every call names the API
// month (`Linkedin-Version`, a setting): LinkedIn retires a version about a year after its release.
import type { Connector, ScopedTokens } from "./publish.ts";
import { campaignSlug, tagText, withUtm } from "./email/domain/render.ts";
import { replaceUrls } from "./links/domain.ts";

const AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const API = "https://api.linkedin.com";
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"];
export const LINKEDIN_TOKEN_KEY = "linkedin.accessToken";
export const LINKEDIN_DEFAULT_VERSION = "202610";
const COMMENTARY_MAX = 3000;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif"]);
const VIDEO_MIN = 75_000, VIDEO_MAX = 500_000_000;
/** A video is processed after its upload; posting before AVAILABLE fails. */
const POLL = { everyMs: 5_000, attempts: 36 };
const DAY_MS = 86_400_000;
/** Renew this close to the end, when LinkedIn gave a refresh token at all. */
const RENEW_BEFORE_MS = 7 * DAY_MS;

export type LinkedInApp = { clientId: string; clientSecret: string };
export type LinkedInOptions = LinkedInApp & {
  tokens: ScopedTokens;
  /** `Linkedin-Version`, YYYYMM. */
  version?: string;
  fetchImpl?: typeof fetch;
  shorten?: (entryId: string, url: string) => Promise<string>;
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
};
/** What the scoped secret holds. */
export type LinkedInConnection = { token: string; expiresAt: string; refreshToken?: string; refreshExpiresAt?: string };
type TokenReply = { access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string; error?: string; error_description?: string };
type RestError = { message?: string; code?: string; serviceErrorCode?: number; status?: number };

/**
 * LinkedIn's "little text" reads these characters as formatting; a backslash makes them literal. Hashtags (#) and mentions stay as they
 * are, which is what a post wants.
 */
export const escapeLittleText = (s: string) => s.replace(/[\\()[\]{}<>@|~_*]/g, (c) => `\\${c}`);

/** One versioned REST call; `raw` keeps the Response for callers that read headers. */
function rest(f: typeof fetch, version: string) {
  return async (method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<Response> => {
    const res = await f(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "linkedin-version": version, "x-restli-protocol-version": "2.0.0", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as RestError;
      throw new Error(`LinkedIn ${method} ${path}: ${json.message ?? `HTTP ${res.status}`}${json.code ? ` (${json.code})` : ""}`);
    }
    return res;
  };
}
const asJson = async <T>(res: Response): Promise<T> => (await res.json().catch(() => ({}))) as T;

/** The OAuth side. */
export function linkedinOAuth(app: LinkedInApp, fetchImpl: typeof fetch = fetch) {
  const token = async (params: Record<string, string>): Promise<TokenReply> => {
    const res = await fetchImpl(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params }) });
    const json = (await res.json().catch(() => ({}))) as TokenReply;
    if (!res.ok || !json.access_token) throw new Error(`LinkedIn accessToken: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
    return json;
  };
  const connection = (t: TokenReply, now: Date): LinkedInConnection => ({
    token: t.access_token, expiresAt: new Date(now.getTime() + t.expires_in * 1000).toISOString(),
    ...(t.refresh_token ? { refreshToken: t.refresh_token, refreshExpiresAt: new Date(now.getTime() + (t.refresh_token_expires_in ?? 0) * 1000).toISOString() } : {}),
  });
  return {
    authorizeUrl(redirectUri: string, state: string): string {
      const u = new URL(AUTHORIZE);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: app.clientId, redirect_uri: redirectUri, state, scope: LINKEDIN_SCOPES.join(" ") })) u.searchParams.set(k, v);
      return u.toString();
    },
    exchange: async (code: string, redirectUri: string, now = new Date()) => connection(await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri }), now),
    refresh: async (c: LinkedInConnection, now = new Date()) => ({ ...c, ...connection(await token({ grant_type: "refresh_token", refresh_token: c.refreshToken ?? "" }), now) }),
  };
}

export type LinkedInProfile = { sub: string; name?: string };
/** The signed-in member (OpenID Connect); `sub` is the member id of `urn:li:person:{id}`. */
export async function linkedinProfile(fetchImpl: typeof fetch, token: string): Promise<LinkedInProfile> {
  const res = await fetchImpl(`${API}/v2/userinfo`, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as LinkedInProfile & RestError;
  if (!res.ok || !json.sub) throw new Error(`LinkedIn userinfo: ${json.message ?? `HTTP ${res.status}`}`);
  return { sub: json.sub, name: json.name };
}

/** The campaign's connection; renewed when a refresh token exists and the access token is a week from its end. */
export async function linkedinConnection(opts: LinkedInOptions, campaignId: string): Promise<LinkedInConnection> {
  const saved = await opts.tokens.get(campaignId, LINKEDIN_TOKEN_KEY);
  if (!saved) throw new Error("This campaign has no LinkedIn member: a person runs bb brandwise linkedin connect --campaign <c> (docs/channels.md)");
  let c: LinkedInConnection;
  try { c = JSON.parse(saved) as LinkedInConnection; } catch { throw new Error("The stored LinkedIn connection is unreadable: connect again"); }
  const now = (opts.now ?? (() => new Date()))();
  const left = Date.parse(c.expiresAt) - now.getTime();
  const canRefresh = Boolean(c.refreshToken) && (!c.refreshExpiresAt || now.getTime() < Date.parse(c.refreshExpiresAt));
  if (left <= 0 && !canRefresh) throw new Error(`The LinkedIn connection expired on ${c.expiresAt.slice(0, 10)} (LinkedIn tokens live 60 days): a person runs bb brandwise linkedin connect again`);
  if (left < RENEW_BEFORE_MS && canRefresh) {
    c = await linkedinOAuth(opts, opts.fetchImpl ?? fetch).refresh(c, now);
    await opts.tokens.set(campaignId, LINKEDIN_TOKEN_KEY, JSON.stringify(c));
  }
  return c;
}

export function linkedin(opts: LinkedInOptions): Connector {
  const f = opts.fetchImpl ?? fetch;
  const call = rest(f, opts.version?.trim() || LINKEDIN_DEFAULT_VERSION);
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "linkedin",
    channels: ["linkedin"],
    targetHint: "bb brandwise linkedin connect --campaign <c>   (a person signs in to LinkedIn once; the member becomes the campaign's linkedin target)",
    async publish({ entry, asset, target }) {
      const personId = target?.personId?.trim(), organizationId = target?.organizationId?.trim();
      if (!personId && !organizationId) throw new Error("No personId in the campaign's linkedin target");
      const author = organizationId ? `urn:li:organization:${organizationId}` : `urn:li:person:${personId}`;
      if (asset && !((asset.kind === "image" && IMAGE_MIMES.has(asset.mime)) || (asset.kind === "video" && asset.mime === "video/mp4"))) {
        throw new Error(`LinkedIn takes JPEG, PNG or GIF images and MP4 videos; ${asset.name} is ${asset.mime}`);
      }
      if (asset?.kind === "video" && (asset.bytes < VIDEO_MIN || asset.bytes > VIDEO_MAX)) throw new Error(`${asset.name} is ${asset.bytes} bytes; LinkedIn videos are 75 KB to 500 MB`);
      const utm = { entryId: entry.id, campaign: campaignSlug(entry.campaignName), medium: "social", source: "linkedin" };
      const short = (url: string) => (opts.shorten ? opts.shorten(entry.id, url) : Promise.resolve(url));
      const body = await replaceUrls(tagText(entry.body.trim(), utm), short);
      const link = entry.link ? await short(withUtm(entry.link, utm)) : null;
      // a text post carries the link as an article card; a post with media has no card, so the link goes into the text
      const text = asset && link && !body.includes(link) ? [body, link].filter(Boolean).join("\n\n") : body;
      if (!text && !asset) throw new Error("Entry has no text and no creative to post");
      if (text.length > COMMENTARY_MAX) throw new Error(`Text is ${text.length} characters, LinkedIn allows ${COMMENTARY_MAX}`);

      const { token } = await linkedinConnection(opts, entry.campaignId);
      let content: Record<string, unknown> | undefined;
      if (asset?.kind === "image") {
        const init = await asJson<{ value: { uploadUrl: string; image: string } }>(await call("POST", "/rest/images?action=initializeUpload", token, { initializeUploadRequest: { owner: author } }));
        const put = await f(init.value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: new Blob([(await asset.read()).slice()]) });
        if (!put.ok) throw new Error(`LinkedIn image upload: HTTP ${put.status}`);
        content = { media: { id: init.value.image, altText: entry.title } };
      } else if (asset?.kind === "video") {
        const init = await asJson<{ value: { video: string; uploadToken: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] } }>(
          await call("POST", "/rest/videos?action=initializeUpload", token, { initializeUploadRequest: { owner: author, fileSizeBytes: asset.bytes, uploadCaptions: false, uploadThumbnail: false } }));
        const bytes = await asset.read();
        const etags: string[] = [];
        for (const part of init.value.uploadInstructions) { // 4 MB parts, in order; each answers with an ETag the finalisation needs
          const put = await f(part.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: new Blob([bytes.slice(part.firstByte, part.lastByte + 1)]) });
          if (!put.ok) throw new Error(`LinkedIn video upload: HTTP ${put.status} on bytes ${part.firstByte}-${part.lastByte}`);
          etags.push(put.headers.get("etag") ?? "");
        }
        await call("POST", "/rest/videos?action=finalizeUpload", token, { finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken, uploadedPartIds: etags } });
        let status = "PROCESSING";
        for (let i = 0; i < POLL.attempts && status !== "AVAILABLE"; i++) {
          await wait(POLL.everyMs);
          const v = await asJson<{ status?: string; processingFailureReason?: string }>(await call("GET", `/rest/videos/${encodeURIComponent(init.value.video)}`, token));
          status = v.status ?? "PROCESSING";
          if (status === "PROCESSING_FAILED") throw new Error(`LinkedIn did not accept the video: ${v.processingFailureReason ?? "processing failed"}`);
        }
        if (status !== "AVAILABLE") throw new Error("LinkedIn is still processing the video after three minutes; the entry is retried");
        content = { media: { id: init.value.video, title: entry.title } };
      } else if (link) {
        content = { article: { source: link, title: entry.title.trim() || new URL(link).hostname } }; // LinkedIn does not read the page: the card's title comes from us
      }
      const res = await call("POST", "/rest/posts", token, {
        author, commentary: escapeLittleText(text), visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, ...(content ? { content } : {}),
      });
      const urn = res.headers.get("x-restli-id");
      if (!urn) throw new Error("LinkedIn POST /rest/posts: no post id in the answer");
      return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
    },
  };
}

/** What the campaign's LinkedIn connection is, for a person (`bb brandwise linkedin status`). */
export async function linkedinStatus(opts: LinkedInOptions, campaignId: string, target: Record<string, string> | null): Promise<{ connected: boolean; profile: LinkedInProfile | null; lines: string[] }> {
  if (!(await opts.tokens.get(campaignId, LINKEDIN_TOKEN_KEY))) return { connected: false, profile: null, lines: ["No LinkedIn member connected to this campaign: bb brandwise linkedin connect --campaign <c>"] };
  const c = await linkedinConnection(opts, campaignId);
  const profile = await linkedinProfile(opts.fetchImpl ?? fetch, c.token);
  const days = Math.max(0, Math.floor((Date.parse(c.expiresAt) - (opts.now ?? (() => new Date()))().getTime()) / DAY_MS));
  return { connected: true, profile, lines: [
    `${profile.name ?? profile.sub} (member ${profile.sub}): connected, token ends in ${days} days${c.refreshToken ? " and is renewed by itself" : "; LinkedIn gives no refresh token to this app, so connect again before then"}`,
    target ? `linkedin target: ${JSON.stringify(target)}` : "linkedin target: none (connect sets it; without it entries wait as Publish by hand)",
  ] };
}
