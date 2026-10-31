// Higgsfield through its CLI (installed on the host). Spawned without a shell, so prompts cannot inject commands, and every call
// is bounded in time. The CLI signs in with OAuth and keeps the login in $HOME/.config/higgsfield: a settings profile gives a scope
// its own $HOME, so each scope can use its own Higgsfield account; a workspace id picks the billing workspace of an account.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Auth, GenSpec, Job, Provider, ProviderConfig } from "./index.ts";

const FAILED = new Set(["failed", "error", "canceled", "cancelled", "nsfw", "rejected", "expired"]);
export const isFailed = (status: string) => FAILED.has(status.toLowerCase());

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
function setup(cfg: ProviderConfig) {
  const bin = cfg.bin ?? "higgsfield";
  const env: NodeJS.ProcessEnv = { ...process.env };
  const profile = String(cfg.values.profile ?? "");
  let home: string | null = null;
  if (profile !== "") {
    if (!PROFILE.test(profile)) throw new Error(`Invalid profile name "${profile}" (lowercase letters, digits, - and _)`);
    home = join(cfg.profilesDir, "higgsfield", profile);
    mkdirSync(home, { recursive: true });
    env.HOME = home;
  }
  const workspace = String(cfg.values.workspaceId ?? "");
  if (workspace !== "") env.HIGGSFIELD_WORKSPACE_ID = workspace;
  return { bin, env, home };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`higgsfield timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`cannot run "${bin}": ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`higgsfield failed (${code}): ${(err || out).trim().slice(0, 300)}`));
    });
  });
}

const PARAM = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(["prompt", "json", "wait", "help"]);
/** Extra parameters become `--name value`; names and values are checked so none can turn into another flag. */
const extraArgs = (params: Record<string, string>) =>
  Object.entries(params).flatMap(([k, v]) => {
    if (!PARAM.test(k) || RESERVED.has(k)) throw new Error(`Invalid parameter name "${k}"`);
    if (v.length === 0 || v.length > 200 || v.startsWith("-")) throw new Error(`Invalid value for parameter ${k}`);
    return [`--${k}`, v];
  });
// Temporary trouble on Higgsfield's side (gateway errors, dropped connections). Reads are simply repeated; starting a job (which
// spends) is repeated only after the job list shows that the first attempt did not create one.
const TRANSIENT = /HTTP (?:502|503|504)|upstream connect error|connection termination|connection reset|ECONNRESET|temporarily unavailable/i;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function repeated<T>(cfg: ProviderConfig, job: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await job();
    } catch (e) {
      if (i >= tries - 1 || !TRANSIENT.test(message(e))) throw e;
      await pause((cfg.retryDelayMs ?? 3000) * 2 ** i);
    }
  }
}

const modelArgs = (s: GenSpec) => [
  s.model, "--prompt", s.prompt,
  ...(s.aspect ? ["--aspect_ratio", s.aspect] : []),
  ...(s.resolution ? ["--resolution", s.resolution] : []),
  ...(s.refs ?? []).flatMap((r) => ["--image-references", r]),
  ...(s.startImage ? ["--start-image", s.startImage] : []),
  ...(s.endImage ? ["--end-image", s.endImage] : []),
  ...(s.videoRefs ?? []).flatMap((r) => ["--video-references", r]),
  ...(s.audioRefs ?? []).flatMap((r) => ["--audio-references", r]),
  ...extraArgs(s.params ?? {}),
];

const jobFrom = (raw: any): Job => {
  const j = Array.isArray(raw) ? raw[0] : raw;
  if (typeof j === "string") return { id: j, status: "queued", resultUrl: null }; // create without --wait prints just the job ids
  if (!j?.id) throw new Error(`unexpected higgsfield output: ${JSON.stringify(raw).slice(0, 160)}`);
  return { id: String(j.id), status: String(j.status ?? "unknown"), resultUrl: typeof j.result_url === "string" ? j.result_url : null };
};

export const higgsfield: Provider = {
  id: "higgsfield",
  label: "Higgsfield",
  unit: "credits",
  fields: [
    {
      key: "profile", label: "Account profile", type: "string", default: "",
      description: "Empty = the account signed in on this host. A name keeps a separate Higgsfield login for this scope, so a campaign can use another account.",
    },
    {
      key: "workspaceId", label: "Workspace id", type: "string", default: "",
      description: "Billing workspace of the account (from `higgsfield workspace list`). Empty = the one the CLI has selected.",
    },
  ],
  async status(cfg): Promise<Auth> {
    try {
      const { bin, env } = setup(cfg);
      const text = (await repeated(cfg, () => run(bin, ["account", "status"], env, 30_000))).trim();
      return { ok: true, detail: text };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
  loginHint(cfg) {
    const { bin, home } = setup(cfg);
    return `${home === null ? "" : `HOME=${JSON.stringify(home)} `}${bin} auth login`;
  },
  async models(cfg, query) {
    const { bin, env } = setup(cfg);
    if (query?.model !== undefined) {
      if (!/^[a-z0-9_.-]{2,64}$/.test(query.model)) throw new Error(`Invalid model "${query.model}"`);
      return repeated(cfg, () => run(bin, ["model", "get", query.model!], env, 30_000));
    }
    return repeated(cfg, () => run(bin, ["model", "list", ...(query?.kind ? [`--${query.kind}`] : [])], env, 30_000));
  },
  async estimate(cfg, spec) {
    const { bin, env } = setup(cfg);
    const text = await repeated(cfg, () => run(bin, ["generate", "cost", ...modelArgs(spec)], env));
    const m = /(\d+(?:\.\d+)?)\s*credits?/i.exec(text);
    if (!m) throw new Error(`could not read the cost from: ${text.trim().slice(0, 120)}`);
    return Number(m[1]);
  },
  async start(cfg, spec) {
    const { bin, env } = setup(cfg);
    const since = Date.now() - 10_000; // margin for clock differences
    for (let attempt = 0; ; attempt++) {
      try {
        return jobFrom(JSON.parse(await run(bin, ["generate", "create", ...modelArgs(spec), "--json"], env)));
      } catch (e) {
        if (!TRANSIENT.test(message(e))) throw e;
        if (attempt >= 2) throw new Error(`${message(e)}\nHiggsfield kept failing (temporary, on their side) and the job list shows no job for this request, so nothing was started or spent. Try again in a few minutes.`);
        await pause((cfg.retryDelayMs ?? 3000) * 2 ** attempt);
        // the request may have gone through although the answer did not arrive: never start a second job if the first exists
        let recent: any[];
        try {
          recent = JSON.parse(await repeated(cfg, () => run(bin, ["generate", "list", "--json", "--size", "20"], env, 30_000)));
        } catch (listError) {
          throw new Error(`${message(e)}\nIt is not known whether this started a job (the job list could not be read either: ${message(listError)}). Check the Higgsfield job list before trying again; nothing was recorded as spent.`);
        }
        const existing = recent.find((j) => Date.parse(j?.created_at) >= since && j?.job_type === spec.model && String(j?.params?.prompt ?? "").trim() === spec.prompt.trim());
        if (existing) return jobFrom({ id: existing.id, status: existing.status ?? "queued", result_url: existing.result_url });
      }
    }
  },
  async get(cfg, jobId) {
    const { bin, env } = setup(cfg);
    return jobFrom(JSON.parse(await repeated(cfg, () => run(bin, ["generate", "get", jobId, "--json"], env), 2)));
  },
};

const MAX_RESULT_BYTES = 40_000_000;
/** Result files come from a CDN; only https and a size cap are accepted. */
export async function downloadResult(url: string): Promise<Uint8Array> {
  if (!url.startsWith("https://")) throw new Error("refusing a non-https result URL");
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`result download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_RESULT_BYTES) throw new Error("result is too large");
  return bytes;
}
