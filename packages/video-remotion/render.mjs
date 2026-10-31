#!/usr/bin/env node
// Remotion engine for the BrandWise. A video project is a normal Remotion project folder (index.ts calling
// registerRoot, any number of <Composition>s, ./public for assets); the agent or the human (in Remotion Studio) edits it.
//   node render.mjs seed         --dir <empty dir>                          # copy the example project to start from
//   node render.mjs compositions --dir <project>                            # JSON: id, size, fps, duration, defaultProps of each composition
//   node render.mjs render       --dir <project> [--composition <id>] --props-file <json> --out <file.mp4> [--status-file <json>]
//   node render.mjs still        --dir <project> [--composition <id>] --props-file <json> --out <file.png> [--frame N] [--status-file <json>]
//   node render.mjs studio       --dir <project> --port <n>                 # Remotion Studio in the foreground
// The project resolves its imports through a node_modules symlink to this package, so every @remotion/* package installed
// here is available and nothing is installed per project. Progress and result go to --status-file
// ({state: running|done|failed}) so a caller can start this detached and poll. Limits keep a render bounded.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const LIMITS = { seconds: 120, fps: 60, side: 4096, pixels: 3840 * 2160, dirBytes: 200_000_000 };
const statusFile = flag("--status-file");
const status = (o) => {
  if (!statusFile) return;
  mkdirSync(dirname(resolve(statusFile)), { recursive: true });
  writeFileSync(statusFile + ".tmp", JSON.stringify(o));
  renameSync(statusFile + ".tmp", statusFile); // atomic: a poller never reads half a file
};

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

/** A project folder with its imports wired up; refuses oversized folders. */
function project(dirArg) {
  const dir = resolve(dirArg ?? "");
  if (!dirArg || !existsSync(join(dir, "index.ts"))) throw new Error(`"${dirArg}" must be a Remotion project folder with index.ts (start from: seed --dir <dir>)`);
  if (walk(dir).reduce((n, f) => n + statSync(f).size, 0) > LIMITS.dirBytes) throw new Error(`project folder is over ${LIMITS.dirBytes / 1e6} MB`);
  const modules = join(dir, "node_modules");
  if (!existsSync(modules) && !lstatSync(dir).isSymbolicLink()) symlinkSync(join(here, "node_modules"), modules);
  return dir;
}

async function load(dir, inputProps = {}) {
  const { bundle } = await import("@remotion/bundler");
  const { ensureBrowser, getCompositions } = await import("@remotion/renderer");
  await ensureBrowser(); // first run downloads Chrome Headless Shell
  const serveUrl = await bundle({ entryPoint: join(dir, "index.ts") });
  return { serveUrl, compositions: await getCompositions(serveUrl, { inputProps }) };
}

/** Defaults overlaid with the given props; unknown names and wrong types are errors, not silent no-ops. */
function mergeProps(defaults, given) {
  for (const [k, v] of Object.entries(given)) {
    if (!(k in defaults)) throw new Error(`unknown prop "${k}" (defaultProps has: ${Object.keys(defaults).join(", ")})`);
    if (typeof v !== typeof defaults[k]) throw new Error(`prop "${k}" should be a ${typeof defaults[k]}`);
  }
  return { ...defaults, ...given };
}

function checkLimits(c) {
  if (c.width < 64 || c.height < 64 || c.width > LIMITS.side || c.height > LIMITS.side || c.width * c.height > LIMITS.pixels) throw new Error(`composition "${c.id}" is ${c.width}x${c.height}; allowed are 64..${LIMITS.side} per side and at most 3840x2160 pixels`);
  if (c.fps > LIMITS.fps) throw new Error(`composition "${c.id}" runs at ${c.fps} fps; the maximum is ${LIMITS.fps}`);
  if (c.durationInFrames > c.fps * LIMITS.seconds) throw new Error(`composition "${c.id}" is longer than ${LIMITS.seconds} s`);
}

try {
  if (cmd === "seed") {
    const out = resolve(flag("--dir") ?? "");
    if (!flag("--dir")) throw new Error("--dir is required");
    if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
    cpSync(join(here, "seed", "post-reel"), out, { recursive: true });
    project(out);
    console.log(JSON.stringify({ state: "done", dir: out, files: walk(out).map((f) => f.slice(out.length + 1)) }));
  } else if (cmd === "compositions") {
    const { compositions } = await load(project(flag("--dir")));
    console.log(JSON.stringify(compositions.map((c) => ({ id: c.id, width: c.width, height: c.height, fps: c.fps, durationInFrames: c.durationInFrames, defaultProps: c.defaultProps ?? {} }))));
  } else if (cmd === "studio") {
    const dir = project(flag("--dir"));
    const port = String(Number(flag("--port")) || 3100);
    // detached from the engine's cwd on purpose: the studio resolves the project root from the folder it runs in
    const child = spawn(process.execPath, ["--import", join(here, "loopback.mjs"), join(here, "node_modules", "@remotion", "cli", "remotion-cli.js"), "studio", "index.ts", "--port", port, "--no-open", "--ipv4", "--disable-git-source"], { cwd: dir, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  } else if (cmd === "render" || cmd === "still") {
    const dir = project(flag("--dir"));
    const given = JSON.parse(readFileSync(flag("--props-file") ?? "", "utf8"));
    const out = resolve(flag("--out") ?? "");
    if (!flag("--out")) throw new Error("--out is required");
    status({ state: "running", progress: 0 });
    const { renderMedia, renderStill, selectComposition } = await import("@remotion/renderer");
    const { serveUrl, compositions } = await load(dir);
    const wanted = flag("--composition") ?? (compositions.length === 1 ? compositions[0].id : undefined);
    const base = compositions.find((c) => c.id === wanted);
    if (!base) throw new Error(`pass --composition <id>; this project has: ${compositions.map((c) => c.id).join(", ")}`);
    const inputProps = mergeProps(base.defaultProps ?? {}, given);
    const composition = await selectComposition({ serveUrl, id: base.id, inputProps });
    checkLimits(composition);
    mkdirSync(dirname(out), { recursive: true });
    if (cmd === "still") {
      const frame = Math.min(Math.max(Number(flag("--frame") ?? 0) || 0, 0), composition.durationInFrames - 1);
      await renderStill({ composition, serveUrl, output: out, frame, inputProps });
    } else {
      let last = -1;
      await renderMedia({
        composition, serveUrl, codec: "h264", outputLocation: out, inputProps,
        onProgress: ({ progress }) => { const p = Math.round(progress * 20) / 20; if (p !== last) { last = p; status({ state: "running", progress: p }); } },
      });
    }
    const done = { state: "done", out, template: composition.id, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames };
    status(done);
    console.log(JSON.stringify(done));
  } else {
    console.error("usage: render.mjs seed --dir <dir> | compositions --dir <dir> | studio --dir <dir> --port <n> | render|still --dir <dir> [--composition <id>] --props-file <json> --out <file> [--frame N] [--status-file <json>]");
    process.exit(2);
  }
} catch (cause) {
  const failed = { state: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  status(failed);
  console.error(failed.error);
  process.exit(1);
}
