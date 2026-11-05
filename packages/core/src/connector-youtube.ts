// YouTube connector: uploads through the Data API v3 (https://developers.google.com/youtube/v3/docs/videos/insert). The Google Cloud
// OAuth client (id and secret) are plugin settings; each campaign connects its channel once (`bb brandwise youtube connect`,
// docs/channels.md): the refresh token becomes a scoped secret setting (`youtube.refreshToken`, inherited by child campaigns, never shown
// to agents) and the channel the campaign's `youtube` target (channelId, title; optional privacy=public|unlisted|private). Google does not
// rotate refresh tokens; a short-lived access token is fetched per upload.
// A post is one video (any video/* type, up to 256 GB) sent with the resumable protocol in a single PUT. Title = the entry's title
// (100 characters), description = the body with tagged links (5000 bytes). A vertical video of up to three minutes is shown as a Short by
// YouTube itself; there is no flag. Uploads have their own quota bucket: 100 a day per Google Cloud project.
import type { Connector, ScopedTokens } from "./publish.ts";
import { campaignSlug, tagText, withUtm } from "./email/domain/render.ts";
import { replaceUrls } from "./links/domain.ts";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
/** upload for the video, readonly to name the channel at connection time. */
export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
export const YOUTUBE_TOKEN_KEY = "youtube.refreshToken";
const TITLE_MAX = 100, DESCRIPTION_MAX_BYTES = 5000;
const PRIVACY = new Set(["public", "unlisted", "private"]);

export type GoogleApp = { clientId: string; clientSecret: string };
export type YouTubeOptions = GoogleApp & {
  tokens: ScopedTokens;
  fetchImpl?: typeof fetch;
  /** Our short link for a link of the entry (docs/analytics.md, step 3); without it links stay as they are. */
  shorten?: (entryId: string, url: string) => Promise<string>;
};
export type GoogleTokens = { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
type GoogleError = { error?: { code?: number; message?: string; errors?: { reason?: string }[] } | string; error_description?: string };

const errorOf = (what: string, status: number, json: GoogleError) => {
  const e = json.error;
  const message = typeof e === "string" ? (json.error_description ?? e) : e?.message;
  const reason = typeof e === "object" ? e?.errors?.[0]?.reason : undefined;
  return new Error(`YouTube ${what}: ${message ?? `HTTP ${status}`}${reason ? ` (${reason})` : ""}`);
};

/** The OAuth side: the address a person opens (asks for a refresh token), the code exchange, the refresh. */
export function youtubeOAuth(app: GoogleApp, fetchImpl: typeof fetch = fetch) {
  const token = async (params: Record<string, string>): Promise<GoogleTokens> => {
    const res = await fetchImpl(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params }) });
    const json = (await res.json().catch(() => ({}))) as GoogleTokens & GoogleError;
    if (!res.ok || !json.access_token) throw errorOf("oauth token", res.status, json);
    return json;
  };
  return {
    authorizeUrl(redirectUri: string, state: string): string {
      const u = new URL(AUTHORIZE);
      // access_type=offline and prompt=consent are what makes Google return a refresh token
      for (const [k, v] of Object.entries({ client_id: app.clientId, redirect_uri: redirectUri, response_type: "code", scope: YOUTUBE_SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state })) u.searchParams.set(k, v);
      return u.toString();
    },
    exchange: (code: string, redirectUri: string) => token({ code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    refresh: (refreshToken: string) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
  };
}

export type ChannelInfo = { id: string; title: string; customUrl?: string };
/** The channel behind an access token (`channels.list?mine=true`). */
export async function youtubeChannel(fetchImpl: typeof fetch, accessToken: string): Promise<ChannelInfo> {
  const res = await fetchImpl(`${API}/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as { items?: { id: string; snippet?: { title?: string; customUrl?: string } }[] } & GoogleError;
  if (!res.ok) throw errorOf("channels.list", res.status, json);
  const ch = json.items?.[0];
  if (!ch) throw new Error("This Google account has no YouTube channel: create one on youtube.com first");
  return { id: ch.id, title: ch.snippet?.title ?? ch.id, customUrl: ch.snippet?.customUrl };
}

/** A fresh access token for the campaign's channel. */
export async function youtubeAccessToken(opts: YouTubeOptions, campaignId: string): Promise<string> {
  const saved = await opts.tokens.get(campaignId, YOUTUBE_TOKEN_KEY);
  if (!saved) throw new Error("This campaign has no YouTube channel: a person runs bb brandwise youtube connect --campaign <c> (docs/channels.md)");
  return (await youtubeOAuth(opts, opts.fetchImpl ?? fetch).refresh(saved)).access_token;
}

export function youtube(opts: YouTubeOptions): Connector {
  const f = opts.fetchImpl ?? fetch;
  return {
    id: "youtube",
    channels: ["youtube"],
    targetHint: "bb brandwise youtube connect --campaign <c>   (a person signs in to the Google account of the channel once; it becomes the campaign's youtube target)",
    async publish({ entry, asset, target }) {
      if (!asset || asset.kind !== "video") throw new Error("A YouTube post is a video: attach one to the entry");
      const title = entry.title.trim();
      if (!title) throw new Error("A YouTube video needs a title: the entry's title is empty");
      if (title.length > TITLE_MAX) throw new Error(`Title is ${title.length} characters, YouTube allows ${TITLE_MAX}`);
      const privacy = target?.privacy?.trim() || "public";
      if (!PRIVACY.has(privacy)) throw new Error(`youtube target privacy must be public, unlisted or private, not "${privacy}"`);
      const utm = { entryId: entry.id, campaign: campaignSlug(entry.campaignName), medium: "social", source: "youtube" };
      const short = (url: string) => (opts.shorten ? opts.shorten(entry.id, url) : Promise.resolve(url));
      const body = await replaceUrls(tagText(entry.body.trim(), utm), short);
      const link = entry.link ? await short(withUtm(entry.link, utm)) : null;
      const description = link && !body.includes(link) ? [body, link].filter(Boolean).join("\n\n") : body;
      const bytesOfDescription = Buffer.byteLength(description, "utf8");
      if (bytesOfDescription > DESCRIPTION_MAX_BYTES) throw new Error(`Description is ${bytesOfDescription} bytes, YouTube allows ${DESCRIPTION_MAX_BYTES}`);

      const accessToken = await youtubeAccessToken(opts, entry.campaignId);
      // 1. open a resumable session with the metadata; 2. one PUT with the bytes; 201 carries the video resource
      const init = await f(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": asset.mime, "x-upload-content-length": String(asset.bytes) },
        body: JSON.stringify({ snippet: { title, description }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } }),
      });
      if (!init.ok) throw errorOf("videos.insert", init.status, (await init.json().catch(() => ({}))) as GoogleError);
      const session = init.headers.get("location");
      if (!session) throw new Error("YouTube videos.insert: no upload session address in the answer");
      const bytes = await asset.read();
      const up = await f(session, { method: "PUT", headers: { "content-type": asset.mime, "content-length": String(asset.bytes) }, body: new Blob([bytes.slice()], { type: asset.mime }) });
      const json = (await up.json().catch(() => ({}))) as { id?: string } & GoogleError;
      if (!up.ok || !json.id) throw errorOf("upload", up.status, json);
      return { externalId: json.id, url: `https://www.youtube.com/watch?v=${json.id}` };
    },
  };
}

/** What the campaign's YouTube connection is, for a person (`bb brandwise youtube status`). */
export async function youtubeStatus(opts: YouTubeOptions, campaignId: string, target: Record<string, string> | null): Promise<{ connected: boolean; channel: ChannelInfo | null; lines: string[] }> {
  if (!(await opts.tokens.get(campaignId, YOUTUBE_TOKEN_KEY))) return { connected: false, channel: null, lines: ["No YouTube channel connected to this campaign: bb brandwise youtube connect --campaign <c>"] };
  const channel = await youtubeChannel(opts.fetchImpl ?? fetch, await youtubeAccessToken(opts, campaignId));
  const lines = [
    `${channel.title}${channel.customUrl ? ` (${channel.customUrl})` : ""}, channel ${channel.id}: connected`,
    target ? `youtube target: ${JSON.stringify(target)}${target.privacy ? "" : " (privacy: public; add privacy=unlisted to the target to upload unlisted)"}` : "youtube target: none (connect sets it; without it entries wait as Publish by hand)",
  ];
  return { connected: true, channel, lines };
}
