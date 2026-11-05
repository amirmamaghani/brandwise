// Connecting creator accounts over OAuth (TikTok, YouTube, Threads, LinkedIn; docs/channels.md). `bb brandwise <platform> connect
// --campaign <c>` prints the address a person opens; the platform sends the browser back to this plugin's route /oauth/<platform> with a
// code; the code becomes the connection's secret (a refresh token, or a long-lived token with its dates) stored as a scoped secret of the
// campaign (packages/core/src/providers, "<platform>.*Token"), and the account becomes the campaign's channel target. The `state`
// parameter is a one-time key in bb's KV store, good for ten minutes, so a stray or replayed callback cannot attach an account to a
// campaign. Agents call none of this: connecting is a person's action.
import { randomUUID } from "node:crypto";
import type { Core } from "./core/index.ts";
import { creatorInfo, TIKTOK_TOKEN_KEY, tiktokOAuth, tiktokStatus, type TikTokOptions } from "./core/connector-tiktok.ts";
import { youtubeChannel, YOUTUBE_TOKEN_KEY, youtubeOAuth, youtubeStatus, type YouTubeOptions } from "./core/connector-youtube.ts";
import { threadsOAuth, threadsProfile, threadsStatus, THREADS_TOKEN_KEY, type ThreadsOptions } from "./core/connector-threads.ts";
import { linkedinOAuth, linkedinProfile, linkedinStatus, LINKEDIN_TOKEN_KEY, type LinkedInOptions } from "./core/connector-linkedin.ts";

type Io = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };
/** What a code exchange yields: a token to ask the platform who signed in, and the secret the campaign keeps. */
type Exchanged = { accessToken: string; secret: string; openId?: string };
type Platform = {
  id: "tiktok" | "youtube" | "threads" | "linkedin"; label: string; channel: string; tokenKey: string;
  /** Most platforms register https return addresses only; Google also takes http://localhost, which needs no public address. */
  httpsOnly: boolean;
  setupHint: string;
  /** null while the app's client id and secret are not set. */
  app: () => null | {
    authorizeUrl(redirect: string, state: string): string;
    exchange(code: string, redirect: string): Promise<Exchanged>;
    identity(t: Exchanged): Promise<{ target: Record<string, string>; label: string }>;
  };
  status: (campaignId: string, target: Record<string, string> | null) => Promise<{ lines: string[] }>;
};
type Pending = { platform: string; campaignId: string; redirect: string; createdAt: number };
type Kv = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };

const TTL_MS = 10 * 60_000;
const ROUTE = (id: string) => `/api/v1/plugins/brandwise/http/oauth/${id}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const page = (status: number, title: string, text: string) => new Response(
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><title>BrandWise</title><body style="font:16px system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem"><h1 style="font-size:1.4rem">${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
);

export function createConnections(deps: {
  core: () => Core;
  kv: Kv;
  /** This bb server as seen from this machine, e.g. http://127.0.0.1:38896. */
  loopbackBaseUrl: () => string;
  /** The public root a proxy or tunnel maps to this plugin's http routes (the short-link address without its /l), or null. */
  publicBaseUrl: () => string | null;
  tiktok: () => TikTokOptions | null;
  youtube: () => YouTubeOptions | null;
  threads: () => ThreadsOptions | null;
  linkedin: () => LinkedInOptions | null;
}) {
  const hint = (what: string) => `a person sets the ${what} under Settings > Social channels (docs/channels.md)`;
  const platforms: Platform[] = [
    {
      id: "tiktok", label: "TikTok", channel: "tiktok", tokenKey: TIKTOK_TOKEN_KEY, httpsOnly: true, setupHint: hint("TikTok client key and secret"),
      app: () => {
        const a = deps.tiktok();
        if (!a) return null;
        const o = tiktokOAuth(a, a.fetchImpl);
        return {
          authorizeUrl: o.authorizeUrl,
          exchange: async (code, redirect) => { const t = await o.exchange(code, redirect); return { accessToken: t.access_token, secret: t.refresh_token, openId: t.open_id }; },
          identity: async (t) => { const ci = await creatorInfo(a.fetchImpl ?? fetch, t.accessToken); return { target: { openId: t.openId ?? "", username: ci.creator_username }, label: `TikTok @${ci.creator_username}` }; },
        };
      },
      status: (campaignId, target) => tiktokStatus(deps.tiktok()!, campaignId, target),
    },
    {
      id: "youtube", label: "YouTube", channel: "youtube", tokenKey: YOUTUBE_TOKEN_KEY, httpsOnly: false, setupHint: hint("Google OAuth client id and secret"),
      app: () => {
        const a = deps.youtube();
        if (!a) return null;
        const o = youtubeOAuth(a, a.fetchImpl);
        return {
          authorizeUrl: o.authorizeUrl,
          exchange: async (code, redirect) => {
            const t = await o.exchange(code, redirect);
            // Google hands out a refresh token once per consent; a repeat sign-in without one is fixed by revoking the app's access
            if (!t.refresh_token) throw new Error("Google returned no refresh token: remove this app at myaccount.google.com/permissions and connect again");
            return { accessToken: t.access_token, secret: t.refresh_token };
          },
          identity: async (t) => { const ch = await youtubeChannel(a.fetchImpl ?? fetch, t.accessToken); return { target: { channelId: ch.id, title: ch.title }, label: `YouTube channel "${ch.title}"` }; },
        };
      },
      status: (campaignId, target) => youtubeStatus(deps.youtube()!, campaignId, target),
    },
    {
      id: "threads", label: "Threads", channel: "threads", tokenKey: THREADS_TOKEN_KEY, httpsOnly: true, setupHint: hint("Threads app id and secret"),
      app: () => {
        const a = deps.threads();
        if (!a) return null;
        const o = threadsOAuth(a, a.fetchImpl);
        return {
          authorizeUrl: o.authorizeUrl,
          exchange: async (code, redirect) => { const c = await o.exchange(code, redirect); return { accessToken: c.token, secret: JSON.stringify(c), openId: c.userId }; },
          identity: async (t) => {
            const p = await threadsProfile(a.fetchImpl ?? fetch, t.accessToken).catch(() => ({ id: t.openId ?? "", username: undefined }));
            return { target: { userId: t.openId ?? p.id, ...(p.username ? { username: p.username } : {}) }, label: `Threads @${p.username ?? p.id}` };
          },
        };
      },
      status: (campaignId, target) => threadsStatus(deps.threads()!, campaignId, target),
    },
    {
      id: "linkedin", label: "LinkedIn", channel: "linkedin", tokenKey: LINKEDIN_TOKEN_KEY, httpsOnly: true, setupHint: hint("LinkedIn client id and secret"),
      app: () => {
        const a = deps.linkedin();
        if (!a) return null;
        const o = linkedinOAuth(a, a.fetchImpl);
        return {
          authorizeUrl: o.authorizeUrl,
          exchange: async (code, redirect) => { const c = await o.exchange(code, redirect); return { accessToken: c.token, secret: JSON.stringify(c) }; },
          identity: async (t) => { const p = await linkedinProfile(a.fetchImpl ?? fetch, t.accessToken); return { target: { personId: p.sub, ...(p.name ? { name: p.name } : {}) }, label: `LinkedIn member ${p.name ?? p.sub}` }; },
        };
      },
      status: (campaignId, target) => linkedinStatus(deps.linkedin()!, campaignId, target),
    },
  ];
  const byId = (id: string) => platforms.find((p) => p.id === id);

  /** Where the platform sends the browser back: a public https address when there is one, else (Google only) this machine's localhost. */
  const redirectFor = (p: Platform, override: string | undefined): string | null => {
    if (override) return override;
    const pub = deps.publicBaseUrl();
    if (p.httpsOnly) return pub ? `${pub}/oauth/${p.id}` : null;
    return `${deps.loopbackBaseUrl().replace("127.0.0.1", "localhost")}${ROUTE(p.id)}`;
  };

  async function connect(p: Platform, args: string[], io: Io) {
    const app = p.app();
    if (!app) return { exitCode: 1, stderr: `${p.label} is not set up: ${p.setupHint}` };
    const campaign = await deps.core().campaigns.resolve(io.val(args, "--campaign"));
    const redirect = redirectFor(p, io.val(args, "--redirect"));
    if (!redirect) {
      return { exitCode: 1, stderr: `${p.label} needs an https return address. Start the public test address (tools/public-test.sh up --links) or set Settings > Short links > Public address, then connect again; or pass --redirect <an https address that reaches this plugin's route ${ROUTE(p.id)}>.` };
    }
    const state = randomUUID();
    await deps.kv.set(`oauth:${state}`, { platform: p.id, campaignId: campaign.id, redirect, createdAt: Date.now() } satisfies Pending);
    const url = app.authorizeUrl(redirect, state);
    return io.reply({ url, redirect, campaignId: campaign.id }, [
      `Open this address in the browser of the person who owns the ${p.label} account, sign in and allow access:`, "", url, "",
      `${p.label} then sends the browser back to ${redirect} (this exact address must be registered in the app's settings), and the account becomes the ${p.channel} target of "${campaign.name}". The link is good for 10 minutes.`,
    ].join("\n"));
  }

  async function status(p: Platform, args: string[], io: Io) {
    if (!p.app()) return { exitCode: 1, stderr: `${p.label} is not set up: ${p.setupHint}` };
    const c = deps.core();
    const campaign = await c.campaigns.resolve(io.val(args, "--campaign"));
    const r = await p.status(campaign.id, await c.channels.get(campaign.id, p.channel));
    return io.reply(r, r.lines.join("\n"));
  }

  /** The platform's redirect: one state, one use; the account lands on the campaign that asked. */
  async function callback(id: string, req: { query(name: string): string | undefined }): Promise<Response> {
    const p = byId(id);
    if (!p) return page(404, "Unknown platform", "");
    const state = req.query("state") ?? "";
    const pending = state ? await deps.kv.get<Pending>(`oauth:${state}`) : undefined;
    if (!pending || pending.platform !== p.id || Date.now() - pending.createdAt > TTL_MS) {
      return page(400, "Unknown or expired sign-in", `Run bb brandwise ${p.id} connect again and open the new address within 10 minutes.`);
    }
    await deps.kv.delete(`oauth:${state}`);
    const code = req.query("code");
    if (!code) return page(400, `${p.label} did not grant access`, req.query("error_description") ?? req.query("error") ?? "No code came back.");
    const app = p.app();
    if (!app) return page(500, `${p.label} is not set up`, p.setupHint);
    try {
      const t = await app.exchange(code, pending.redirect);
      const who = await app.identity(t);
      const c = deps.core();
      await c.settings.set(pending.campaignId, p.tokenKey, t.secret);
      await c.channels.set(pending.campaignId, p.channel, who.target);
      const campaign = await c.campaigns.resolve(pending.campaignId);
      return page(200, `${who.label} is connected`, `It is now the ${p.channel} target of the campaign "${campaign.name}". You can close this tab.`);
    } catch (cause) {
      return page(502, `${p.label} connection failed`, cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function cli(id: string, action: string | undefined, args: string[], io: Io) {
    const p = byId(id);
    if (!p) return { exitCode: 1, stderr: io.usage };
    if (action === "connect") return connect(p, args, io);
    if (action === "status") return status(p, args, io);
    return { exitCode: 1, stderr: io.usage };
  }

  return { platforms: platforms.map((p) => p.id), cli, callback };
}
