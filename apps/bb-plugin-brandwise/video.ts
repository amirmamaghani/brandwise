// Video side of the plugin: Remotion projects per campaign, rendering through the engine package (@brandwise/video-remotion),
// Remotion Studio per project and the agent thread that edits one. Server only; server.ts wires it into RPC and the CLI.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Core } from "./core/index.ts";
import type { AgentSpec } from "./agents.ts";
import { sleep, slug } from "./util.ts";

const MAX_RENDERS = 2;
const MAX_STUDIOS = 2;
const PROJECT_ID = /^[a-z0-9-]{2,48}$/;

const ref = { campaignId: z.string(), id: z.string() };
export const videoContract = {
  video_projects: { input: z.null(), output: z.object({ enabled: z.boolean(), projects: z.array(z.object(ref)) }) },
  video_project_create: { input: z.object({ campaignId: z.string(), id: z.string().regex(PROJECT_ID) }), output: z.object({ ok: z.boolean() }) },
  video_compositions: {
    input: z.object(ref),
    output: z.object({ compositions: z.array(z.object({ id: z.string(), width: z.number(), height: z.number(), fps: z.number(), durationInFrames: z.number(), defaultProps: z.record(z.string(), z.unknown()) })) }),
  },
  /** Remotion Studio for one project on a loopback port: start it, poll `status` until ready, stop it when done. */
  video_studio: {
    input: z.object({ ...ref, action: z.enum(["start", "status", "stop"]) }),
    output: z.object({ running: z.boolean(), ready: z.boolean(), port: z.number().nullable() }),
  },
  video_render: {
    input: z.object({ ...ref, composition: z.string().optional(), props: z.record(z.string(), z.unknown()), kind: z.enum(["render", "still"]), frame: z.number().int().min(0).optional() }),
    output: z.object({ jobId: z.string() }),
  },
  video_collect: { input: z.object({ jobId: z.string() }), output: z.object({ state: z.enum(["done", "pending"]), progress: z.number(), assetId: z.string().nullable() }) },
};
type In<K extends keyof typeof videoContract> = z.infer<(typeof videoContract)[K]["input"]>;

type RenderJob = { kind: "render" | "still"; campaignId: string; name: string | null; dir: string; props: Record<string, unknown>; inputAssets: string[]; aiGenerated: boolean; pid: number; work: string; out: string; startedAt: number; assetId?: string };
type StudioRef = { pid: number; port: number };
type CliIo = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const portOpen = (port: number) => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

export function createVideo(deps: { bb: BbPluginApi; need: () => Core; enginePath: () => string; assetsChanged: () => void }) {
  const { bb, need } = deps;
  const kv = bb.storage.kv;

  function engine(): string {
    const dir = deps.enginePath() || process.env.BW_VIDEO_DIR || "";
    if (dir === "" || !fs.existsSync(path.join(dir, "render.mjs"))) throw new Error("No video engine: install @brandwise/video-remotion and set the plugin setting videoEnginePath to its folder (or BW_VIDEO_DIR).");
    return dir;
  }
  /** Runs one short engine command and returns its stdout. */
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    const root = engine();
    const child = cp.spawn(process.execPath, [path.join(root, "render.mjs"), ...args], { stdio: ["ignore", "pipe", "pipe"], cwd: root });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error((err || out).trim().slice(0, 400) || `engine exited with ${code}`))));
  });
  /** Starts a long engine command that outlives the caller, in its own process group; its output goes to `logFile`. */
  const runDetached = (args: string[], logFile: string) => {
    const root = engine();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const child = cp.spawn(process.execPath, [path.join(root, "render.mjs"), ...args], { cwd: root, detached: true, stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")] });
    child.unref();
    return child.pid ?? 0;
  };

  const projectsRoot = () => process.env.BW_VIDEO_PROJECTS_DIR || path.join(os.homedir(), ".bb-brandwise", "video");
  /** A project's folder; ids are validated so a campaign or project name can never leave the projects dir. */
  const projectDir = (campaignId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(campaignId) || !PROJECT_ID.test(id)) throw new Error("invalid campaign or project id");
    return path.join(projectsRoot(), campaignId, id);
  };

  function listProjects() {
    let enabled = true;
    try { engine(); } catch { enabled = false; }
    const root = projectsRoot();
    const projects = fs.existsSync(root)
      ? fs.readdirSync(root).flatMap((campaignId) => fs.readdirSync(path.join(root, campaignId)).filter((id) => fs.existsSync(path.join(root, campaignId, id, "index.ts"))).map((id) => ({ campaignId, id })))
      : [];
    return { enabled, projects };
  }

  async function studio(campaignId: string, id: string, action: "start" | "status" | "stop") {
    const dir = projectDir(campaignId, id);
    const key = `studio:${campaignId}/${id}`;
    let cur: StudioRef | null | undefined = await kv.get<StudioRef>(key);
    if (cur && !alive(cur.pid)) { await kv.delete(key); cur = null; }
    if (action === "stop") {
      if (cur) { try { process.kill(-cur.pid, "SIGTERM"); } catch { /* already gone */ } await kv.delete(key); } // the engine leads its process group: Studio is its child
      return { running: false, ready: false, port: null };
    }
    if (!cur && action === "start") {
      if (!fs.existsSync(path.join(dir, "index.ts"))) throw new Error(`${dir} is not a video project`);
      const others: StudioRef[] = [];
      for (const k of await kv.list("studio:")) { const o = await kv.get<StudioRef>(k); if (o && alive(o.pid)) others.push(o); }
      if (others.length >= MAX_STUDIOS) throw new Error(`${others.length} Studios are already running (limit ${MAX_STUDIOS}); stop one first`);
      let port = 3100;
      while (others.some((o) => o.port === port) || (await portOpen(port))) port += 1;
      cur = { pid: runDetached(["studio", "--dir", dir, "--port", String(port)], path.join(os.tmpdir(), "bw-render", `studio-${port}.log`)), port };
      await kv.set(key, cur);
    }
    return cur ? { running: true, ready: await portOpen(cur.port), port: cur.port } : { running: false, ready: false, port: null };
  }

  /** Briefing of the agent for the video page; `subPath` is "<campaign id>/<project id>". */
  async function agentContext(subPath: string): Promise<AgentSpec | null> {
    const [campaignId, id] = subPath.split("/").map(decodeURIComponent);
    if (!campaignId || !id) return null;
    const dir = projectDir(campaignId, id);
    const campaign = (await need().campaigns.list()).find((x) => x.id === campaignId);
    return {
      key: `video/${campaignId}/${id}`, cwd: dir, campaignId,
      prompt: [
        "You are the BrandWise video agent. You work through the `bb brandwise` CLI, following the brandwise skill (Video section). Agents never approve content and never publish. Reply in the language the user writes in.",
        `The user is on the Video screen with the Remotion project "${id}" of the campaign "${campaign?.name ?? campaignId}" (id ${campaignId}) open. The project is the folder ${dir}. They have it open in Remotion Studio next to this chat and see every change you make to the files live.`,
        `Edit src/Root.tsx and the components, check the build with \`bb brandwise video compositions --dir ${dir}\` and look at the result with \`video preview --dir ${dir} --campaign ${campaignId} --frame N\` (open the PNG and look at the image before you report anything as done). Render to Creatives only when the user asks for it.`,
        "For now just read the project, say in one sentence what is in it (compositions, sizes, duration), and wait for instructions.",
      ].join("\n\n"),
    };
  }

  /** Every `<name>Asset: "<asset id>"` prop becomes `<name>Url` (a signed URL); the asset ids are remembered as inputs. */
  async function resolveProps(c: Core, raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("props must be a JSON object");
    const props: Record<string, unknown> = {};
    const inputAssets: string[] = [];
    let aiGenerated = false;
    for (const [k, value] of Object.entries(raw as Record<string, unknown>)) {
      if (k.endsWith("Asset") && typeof value === "string") {
        const asset = await c.assets.get(value);
        props[`${k.slice(0, -5)}Url`] = await c.assets.url(value, 3600);
        inputAssets.push(asset.id);
        aiGenerated ||= asset.aiGenerated;
      } else props[k] = value;
    }
    return { props, inputAssets, aiGenerated };
  }

  async function startRender(a: { kind: "render" | "still"; dir: string; props: unknown; campaign?: string; name: string | null; frame?: number; composition?: string }) {
    const c = need();
    const dir = path.resolve(a.dir);
    if (!fs.existsSync(path.join(dir, "index.ts"))) throw new Error(`${dir} is not a video project (start with: bb brandwise video seed --dir <dir>)`);
    const campaign = await c.campaigns.resolve(a.campaign);
    let running = 0;
    for (const key of await kv.list("render_job:")) {
      const j = await kv.get<RenderJob>(key);
      if (j && !j.assetId && alive(j.pid) && Date.now() - j.startedAt < 30 * 60_000) running += 1;
    }
    if (running >= MAX_RENDERS) throw new Error(`${running} renders are already running (limit ${MAX_RENDERS}); collect or wait for one to finish`);
    const { props, inputAssets, aiGenerated } = await resolveProps(c, a.props);
    const id = `vid_${randomUUID().slice(0, 8)}`;
    const work = path.join(os.tmpdir(), "bw-render", id);
    fs.mkdirSync(work, { recursive: true });
    const out = path.join(work, a.kind === "still" ? "frame.png" : "video.mp4");
    fs.writeFileSync(path.join(work, "props.json"), JSON.stringify(props));
    const pid = runDetached(
      [a.kind, "--dir", dir, "--props-file", path.join(work, "props.json"), "--out", out, "--status-file", path.join(work, "status.json"),
        ...(a.frame !== undefined ? ["--frame", String(a.frame)] : []), ...(a.composition ? ["--composition", a.composition] : [])],
      path.join(work, "engine.log"),
    );
    // props are stored with the signed URLs: they expire, the asset ids in `inputAssets` are what lasts
    await kv.set(`render_job:${id}`, { kind: a.kind, campaignId: campaign.id, name: a.name, dir, props, inputAssets, aiGenerated, pid, work, out, startedAt: Date.now() } satisfies RenderJob);
    return { jobId: id };
  }

  async function collectRender(jobId: string, waitSeconds: number) {
    const c = need();
    const job = await kv.get<RenderJob>(`render_job:${jobId}`);
    if (!job) throw new Error(`Unknown render job ${jobId}`);
    if (job.assetId) return { state: "done" as const, jobId, asset: await c.assets.get(job.assetId), file: null, progress: 1 };
    const statusPath = path.join(job.work, "status.json");
    const log = path.join(job.work, "engine.log");
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const st = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf8")) : null;
      if (st?.state === "failed") throw new Error(`Render failed: ${st.error}`);
      if (st?.state === "done") {
        const asset = await c.assets.save({
          campaignId: job.campaignId, bytes: fs.readFileSync(job.out), filename: `${slug(job.name ?? st.template ?? "video")}.${job.kind === "still" ? "png" : "mp4"}`,
          role: job.kind === "still" ? "reference" : "creative", origin: "generated", aiGenerated: job.aiGenerated, createdBy: "render",
          provenance: { tool: "remotion", kind: job.kind, composition: st.template, width: st.width, height: st.height, fps: st.fps, durationInFrames: st.durationInFrames, props: job.props, inputAssets: job.inputAssets },
        });
        await kv.set(`render_job:${jobId}`, { ...job, assetId: asset.id });
        let file: string | null = null;
        if (job.kind === "still") { // a copy inside the project: an agent working there can open it, the tmp dir is outside its sandbox
          file = path.join(job.dir, ".previews", `${slug(job.name ?? "frame")}-${jobId}.png`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.copyFileSync(job.out, file);
        }
        deps.assetsChanged();
        return { state: "done" as const, jobId, asset, file, progress: 1 };
      }
      if (st === null && !alive(job.pid) && Date.now() - job.startedAt > 5000) throw new Error(`Render process ended without a result, see ${log}`);
      if (st?.state === "running" && !alive(job.pid)) throw new Error(`Render process died at ${Math.round((st.progress ?? 0) * 100)}%, see ${log}`);
      if (Date.now() >= deadline) return { state: "pending" as const, jobId, asset: null, file: null, progress: st?.progress ?? 0 };
      await sleep(1000);
    }
  }

  /** RPC handlers for `videoContract`, spread into the plugin's handler table. */
  const rpc = {
    video_projects: async () => listProjects(),
    video_project_create: async ({ campaignId, id }: In<"video_project_create">) => {
      await need().campaigns.resolve(campaignId);
      await run(["seed", "--dir", projectDir(campaignId, id)]);
      return { ok: true };
    },
    video_compositions: async ({ campaignId, id }: In<"video_compositions">) => ({ compositions: JSON.parse(await run(["compositions", "--dir", projectDir(campaignId, id)])) }),
    video_studio: ({ campaignId, id, action }: In<"video_studio">) => studio(campaignId, id, action),
    video_render: ({ campaignId, id, composition, props, kind, frame }: In<"video_render">) =>
      startRender({ kind, dir: projectDir(campaignId, id), props, campaign: campaignId, name: id, frame, composition }),
    video_collect: async ({ jobId }: In<"video_collect">) => {
      const r = await collectRender(jobId, 0);
      return { state: r.state, progress: r.progress, assetId: r.asset?.id ?? null };
    },
  };

  /** `bb brandwise video <action> ...` */
  async function cli(action: string | undefined, args: string[], { val, positional, reply, usage }: CliIo) {
    const bad = { exitCode: 1, stderr: usage };
    const wait = Math.min(Math.max(Number(val(args, "--wait-seconds") ?? 18) || 0, 0), 20); // MCP `run` stops a snippet after 25 s
    // --template <id> [--campaign <c>] stands for the campaign's project folder, the one the Video page opens
    const templateId = val(args, "--template");
    const campaignId = templateId ? (await need().campaigns.resolve(val(args, "--campaign"))).id : "";
    const dir = val(args, "--dir") ?? (templateId ? projectDir(campaignId, templateId) : undefined);
    if (action === "studio") { // Remotion Studio on 127.0.0.1 only; --stop closes it
      if (!templateId) return bad;
      const st = await studio(campaignId, templateId, args.includes("--stop") ? "stop" : "start");
      return reply(st, st.running ? `Studio ${st.ready ? "ready" : "starting"} at http://127.0.0.1:${st.port} (this Mac only). Close it with --stop.` : "Studio stopped.");
    }
    if (action === "seed" || action === "compositions") {
      if (!dir) return bad;
      const text = await run([action, "--dir", dir]);
      return reply(JSON.parse(text), action === "seed" ? `Project written to ${dir}. Edit src/Root.tsx and the components, then run: bb brandwise video preview --dir ${dir}` : text);
    }
    let jobId: string;
    if (action === "preview" || action === "render") {
      if (!dir) return bad;
      const file = val(args, "--props-file");
      const props = JSON.parse(file ? fs.readFileSync(file, "utf8") : val(args, "--props") ?? "{}");
      const frame = val(args, "--frame");
      jobId = (await startRender({ kind: action === "preview" ? "still" : "render", dir, props, campaign: val(args, "--campaign"), name: val(args, "--name") ?? null, frame: frame ? Number(frame) : undefined, composition: val(args, "--composition") })).jobId;
    } else if (action === "collect") {
      jobId = positional(args.slice(2))[0] ?? "";
      if (!jobId) return bad;
    } else return bad;
    const r = await collectRender(jobId, wait);
    return reply(r, r.state === "done"
      ? `Done: asset ${r.asset!.id} (${r.asset!.name}, ${r.asset!.width ?? "?"}x${r.asset!.height ?? "?"}, ${Math.round(r.asset!.bytes / 1024)} KB)${r.file ? `, file ${r.file}` : ""}. Show it with ::creative{ids="${r.asset!.id}"}`
      : `Still rendering (${Math.round(r.progress * 100)}%), job ${jobId}. Finish with: bb brandwise video collect ${jobId}`);
  }

  return { rpc, cli, agentContext };
}
