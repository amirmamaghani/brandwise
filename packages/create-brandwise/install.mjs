#!/usr/bin/env node
// npx create-brandwise [dir] [--infra=local|remote|manual] [--yes] [--dry-run]
// A short wizard, then: installs bb (npm package bb-app) if missing, clones BrandWise, installs its dependencies, writes .env and
// provisions the dedicated bb instance with the plugin. Postgres and S3 run in Docker only if you choose "local". Idempotent: run again to update.
// shortcut: Docker is not installed (needs admin rights), Windows is not supported (provision.sh is bash), secrets echo while typed; upgrade when users ask.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const REPO = "https://github.com/amirmamaghani/brandwise.git";
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const yes = args.includes("--yes") || !process.stdin.isTTY; // no questions: defaults and environment variables
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? "brandwise");

const say = (m) => console.log(`\n▸ ${m}`);
const die = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
function run(cmd, cmdArgs, cwd) {
  console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
  if (dry) return;
  if (spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" }).status !== 0) die(`failed: ${cmd} ${cmdArgs.join(" ")}`);
}

const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
async function ask(question, def = "") {
  if (!rl) return def;
  const a = (await rl.question(`  ${question}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def;
}
async function choose(question, options, def) {
  if (!rl) return def;
  console.log(`\n  ${question}`);
  options.forEach(([key, label], i) => console.log(`    ${i + 1}) ${label}${key === def ? "  (default)" : ""}`));
  const a = await ask("Choose", String(options.findIndex(([k]) => k === def) + 1));
  return options[Number(a) - 1]?.[0] ?? def;
}

say("Checking requirements");
if (process.platform === "win32") die("Windows is not supported yet; use WSL2 (Ubuntu) and run this there.");
if (Number(process.versions.node.split(".")[0]) < 24) die(`Node 24 or newer is required (this is ${process.version}).`);
for (const tool of ["git", "rsync", "python3"]) if (!has(tool)) die(`${tool} is required but was not found.`);

say("Setup");
const infra = flag("infra") ?? await choose("Where do Postgres and S3 storage live?", [
  ["local", "Local: the installer starts Postgres and an S3 emulator in Docker (good for trying it out)"],
  ["remote", "Remote: I have a Postgres database and an S3-compatible bucket (AWS S3, Cloudflare R2, ...)"],
  ["manual", "Already running: I start my own services and edit .env myself"],
], "local");
if (!["local", "remote", "manual"].includes(infra)) die(`--infra must be local, remote or manual (got "${infra}")`);
const envFile = resolve(dir, ".env");
const keepEnv = existsSync(envFile);
const set = {};
if (keepEnv) console.log("  .env already exists in the target folder: it is kept and no questions about it are asked");
else {
  if (infra === "remote") {
    set.DATABASE_URL = await ask("DATABASE_URL (postgres://user:pass@host:5432/db)", process.env.DATABASE_URL ?? "");
    set.S3_ENDPOINT = await ask("S3_ENDPOINT (empty for AWS S3)", process.env.S3_ENDPOINT ?? "");
    set.S3_REGION = await ask("S3_REGION", process.env.S3_REGION ?? "auto");
    set.S3_BUCKET = await ask("S3_BUCKET", process.env.S3_BUCKET ?? "");
    set.S3_ACCESS_KEY_ID = await ask("S3_ACCESS_KEY_ID", process.env.S3_ACCESS_KEY_ID ?? "");
    set.S3_SECRET_ACCESS_KEY = await ask("S3_SECRET_ACCESS_KEY", process.env.S3_SECRET_ACCESS_KEY ?? "");
    set.S3_FORCE_PATH_STYLE = (await ask("Path-style S3 URLs (true for MinIO-like, false for AWS and R2)", "false"));
    for (const k of ["DATABASE_URL", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) if (!set[k]) die(`${k} is required for a remote setup`);
  }
  if (rl && (await ask("Add publishing channels now? (Telegram, e-mail via Resend; can be done later in .env) y/N", "n")).toLowerCase().startsWith("y")) {
    set.TELEGRAM_BOT_TOKEN = await ask("Telegram bot token (empty to skip)");
    set.RESEND_API_KEY = await ask("Resend API key (empty to skip)");
    if (set.RESEND_API_KEY) set.RESEND_WEBHOOK_SECRET = await ask("Resend webhook secret, whsec_... (empty to add later)");
  }
}
const mode = flag("mode") ?? await choose("Which display mode?", [["minimal", "Minimal: marketing only, bb's developer features hidden"], ["full", "Full: all of bb's interface"]], "minimal");
rl?.close();
if (infra === "local" && !has("docker")) die("Docker is required for the local option (Postgres and the S3 emulator). Install Docker Desktop or OrbStack and start it, or choose remote / manual.");
if (infra === "local" && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) die("Docker is installed but not running. Start it, then run this again.");

say("bb");
if (has("bb") && has("bb-app")) console.log("  already installed");
else run("npm", ["install", "-g", "bb-app@latest"]);

say(`BrandWise in ${dir}`);
if (existsSync(resolve(dir, ".git"))) run("git", ["pull", "--ff-only"], dir);
else run("git", ["clone", "--depth", "1", REPO, dir]);

say("Dependencies");
run("corepack", ["pnpm", "install"], dir);
run("npm", ["install"], resolve(dir, "apps/bb-plugin-brandwise"));

say("Configuration");
if (!dry && !keepEnv) {
  copyFileSync(resolve(dir, ".env.example"), envFile);
  let text = readFileSync(envFile, "utf8");
  for (const [k, v] of Object.entries(set)) if (v) text = text.replace(new RegExp(`^#?\\s*${k}=.*$`, "m"), () => `${k}=${v}`);
  writeFileSync(envFile, text, { mode: 0o600 });
}
console.log(`  .env ${keepEnv ? "kept" : "written"}`);

if (infra === "local") { say("Local infrastructure (Docker)"); run("corepack", ["pnpm", "infra:up"], dir); }
say("bb instance and plugin");
run("env", [`BW_MODE=${mode}`, "bash", "infra/bb-instance/provision.sh", "up"], dir);

console.log(`\n✓ Done. Open http://127.0.0.1:38896
  Change keys or channels: edit ${envFile}, then run: bash infra/bb-instance/provision.sh apply
  Stop the instance: bash infra/bb-instance/provision.sh down${infra === "local" ? "   (and: pnpm infra:down)" : ""}`);
