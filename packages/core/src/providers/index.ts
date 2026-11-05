// Providers that generate creatives (docs/settings.md). A provider is one file that implements `Provider` and is listed
// in PROVIDERS; its settings (account, workspace, limits) are declared here, so the Settings page, the campaign page and the
// CLI pick it up without further code. Anything that talks to a service lives in the provider, nothing else does.
import type { SettingField, SettingValue } from "../settings.ts";
import { higgsfield } from "./higgsfield.ts";

export type GenSpec = {
  model: string;
  prompt: string;
  aspect?: string;
  resolution?: string;
  /** Reference images: image models, Seedance, Genjutsu. Video models such as Veo and Kling do not take these, they take startImage. */
  refs?: string[];
  /** First and last frame of a video. */
  startImage?: string;
  endImage?: string;
  videoRefs?: string[];
  audioRefs?: string[];
  /** Any other parameter of the model (duration, sound, mode, quality...), by its name. */
  params?: Record<string, string>;
};
export type Job = { id: string; status: string; resultUrl: string | null };
export type Auth = { ok: boolean; detail: string };
/** What a provider call works with: the resolved settings of one scope, plus things only the host knows. */
export type ProviderConfig = {
  /** Executable of CLI based providers; set by the operator on the host, never per campaign (it would run outside the sandbox). */
  bin?: string;
  /** Folder under which providers keep one sub-folder per account profile. */
  profilesDir: string;
  values: Record<string, SettingValue>;
  /** Base wait between retries of a temporary provider error (doubles each time). Default 3000; tests set it low. */
  retryDelayMs?: number;
};
export type ProviderField = Omit<SettingField, "group">;

export interface Provider {
  id: string;
  label: string;
  /** What costs are counted in: "credits", "usd"... */
  unit: string;
  /** Short keys; the stored setting key is `${id}.${key}`. Budgets are added for every provider (see budgetFields). */
  fields: ProviderField[];
  /** Is the account of this configuration signed in, and as whom. Spends nothing. */
  status(cfg: ProviderConfig): Promise<Auth>;
  /** The exact command a person runs to sign in for this configuration. */
  loginHint(cfg: ProviderConfig): string;
  /** The models of the provider, or the parameters of one model, as text. Which media a model takes differs per model. */
  models(cfg: ProviderConfig, query?: { kind?: "image" | "video"; model?: string }): Promise<string>;
  estimate(cfg: ProviderConfig, spec: GenSpec): Promise<number>;
  /** Starts the job and returns at once. This spends. */
  start(cfg: ProviderConfig, spec: GenSpec): Promise<Job>;
  get(cfg: ProviderConfig, jobId: string): Promise<Job>;
}

export const PROVIDERS: Provider[] = [higgsfield];
export const providerById = (id: string): Provider => {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider "${id}" (known: ${PROVIDERS.map((x) => x.id).join(", ")})`);
  return p;
};

/** Limits every provider has. Counted in the provider's unit. */
const budgetFields = (p: Provider): ProviderField[] => [
  { key: "maxPerGeneration", label: `Max ${p.unit} per generation`, description: "Hard ceiling for one image or video. Callers (CLI, MCP) can only ask for less.", type: "number", default: 5 },
  { key: "dailyBudget", label: `Daily budget (${p.unit})`, description: "Generation is refused for the rest of the day once everything under this scope has spent this much. A campaign's budget counts its own spend, the global one counts all.", type: "number", default: 40 },
];

export const SETTING_FIELDS: SettingField[] = [
  {
    key: "download.instagramSession", label: "Instagram connection", group: "Downloads", type: "string", secret: true, widget: "instagram-session",
    description: "Instagram shows photos to signed-in sessions only. Sign in to Instagram in your browser, then import the session here: it is saved encrypted and downloads use it, so no browser is needed afterwards. It is a login: prefer a dedicated account. Only the user sets this.",
  },
  {
    key: "download.cookiesBrowser", label: "Browser session", group: "Downloads", type: "select",
    options: ["none", "chrome", "safari", "firefox", "brave", "edge"], default: "none",
    description: "Instagram shows photos and many posts to signed-in sessions only. Pick the browser you are signed in to Instagram in and downloads use its session (macOS may ask for Keychain access). None = anonymous downloads. Only the user sets this, agents never choose a session.",
  },
  // Connected accounts of channels that sign in over OAuth (docs/channels.md): written by `bb brandwise <platform> connect`, read by the
  // connector per post. A child campaign inherits its parent's account. Only the user connects or replaces one.
  {
    key: "tiktok.refreshToken", label: "TikTok account", group: "TikTok", type: "string", secret: true,
    description: "The refresh token of the creator account this campaign posts to, stored by bb brandwise tiktok connect. TikTok replaces it on every refresh; the connector saves the new one. Only the user connects an account.",
  },
  {
    key: "youtube.refreshToken", label: "YouTube channel", group: "YouTube", type: "string", secret: true,
    description: "The refresh token of the Google account whose channel this campaign uploads to, stored by bb brandwise youtube connect. Only the user connects a channel.",
  },
  {
    key: "threads.accessToken", label: "Threads account", group: "Threads", type: "string", secret: true,
    description: "The 60-day token of the Threads account this campaign posts to (with its dates), stored by bb brandwise threads connect and renewed at each post. Only the user connects an account.",
  },
  {
    key: "linkedin.accessToken", label: "LinkedIn member", group: "LinkedIn", type: "string", secret: true,
    description: "The 60-day token of the LinkedIn member this campaign posts as (with its dates), stored by bb brandwise linkedin connect. LinkedIn gives refresh tokens to approved partners only; otherwise connect again before it ends. Only the user connects a member.",
  },
  { key: "generation.provider", label: "Provider", description: "Which provider generates creatives.", group: "Generation", type: "select", options: PROVIDERS.map((p) => p.id), default: PROVIDERS[0].id },
  ...PROVIDERS.flatMap((p) => [...p.fields, ...budgetFields(p)].map((f) => ({ ...f, key: `${p.id}.${f.key}`, group: p.label }))),
];
