#!/usr/bin/env node
// npx create-brandwise [dir] [--dry-run]: installs bb (npm package bb-app) if missing, clones BrandWise, installs its dependencies,
// starts Postgres and the S3 emulator in Docker and provisions the dedicated bb instance with the plugin. Idempotent: run it again to update.
// shortcut: Docker itself is not installed (needs admin rights) and Windows is not supported (provision.sh is bash); the script says what to do.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "https://github.com/amirmamaghani/brandwise.git";
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? "brandwise");

const say = (m) => console.log(`\n▸ ${m}`);
const die = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
function run(cmd, cmdArgs, cwd) {
  console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
  if (dry) return;
  if (spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" }).status !== 0) die(`failed: ${cmd} ${cmdArgs.join(" ")}`);
}

say("Checking requirements");
if (process.platform === "win32") die("Windows is not supported yet; use WSL2 (Ubuntu) and run this there.");
if (Number(process.versions.node.split(".")[0]) < 24) die(`Node 24 or newer is required (this is ${process.version}).`);
for (const tool of ["git", "rsync", "python3"]) if (!has(tool)) die(`${tool} is required but was not found.`);
if (!has("docker")) die("Docker is required (it runs Postgres and the S3 emulator). Install Docker Desktop or OrbStack, start it, then run this again.");
if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) die("Docker is installed but not running. Start it, then run this again.");

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
if (!dry && !existsSync(resolve(dir, ".env"))) copyFileSync(resolve(dir, ".env.example"), resolve(dir, ".env"));
console.log("  .env (local defaults) is in place");

say("Infrastructure and the bb instance with the plugin");
run("corepack", ["pnpm", "infra:up"], dir);
run("bash", ["infra/bb-instance/provision.sh", "up"], dir);

console.log(`\n✓ Done. Open http://127.0.0.1:38896
  Optional channels (Telegram, Resend): add the keys to ${dir}/.env and run: bash infra/bb-instance/provision.sh apply
  Stop the instance: bash infra/bb-instance/provision.sh down`);
