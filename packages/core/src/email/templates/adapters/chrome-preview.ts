// PreviewService adapter: a full-page PNG of the e-mail, taken by @brandwise/email-engine (puppeteer-core) in a child process with a
// Chrome that is found in this order: the configured path, the Chrome Headless Shell that the optional video engine downloaded, a Chrome
// installed on the machine. (Driving the browser directly with --screenshot hangs on a machine without a display; puppeteer does not.)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewService } from "../domain/ports.ts";

const dirs = (p: string) => readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory());

export function findChrome(configured: string, videoEngine: string): string | null {
  if (configured && existsSync(configured)) return configured;
  const shellRoot = videoEngine ? join(videoEngine, "node_modules", ".remotion", "chrome-headless-shell") : "";
  if (shellRoot && existsSync(shellRoot)) {
    for (const platform of dirs(shellRoot)) for (const sub of dirs(join(shellRoot, platform))) {
      const bin = join(shellRoot, platform, sub, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  }
  return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync) ?? null;
}

export function chromePreview(opts: { enginePath: string; chromePath?: string; videoEnginePath?: string }): PreviewService {
  const script = join(opts.enginePath, "shot.mjs");
  return {
    screenshot: (html, { width }) => new Promise((resolve, reject) => {
      if (!opts.enginePath || !existsSync(script) || !existsSync(join(opts.enginePath, "node_modules", "puppeteer-core"))) return reject(new Error("The e-mail engine is not installed: run npm install in packages/email-engine."));
      const chrome = findChrome(opts.chromePath ?? "", opts.videoEnginePath ?? "");
      if (!chrome) return reject(new Error("No Chrome found for previews: set the plugin setting chromePath, or install the video engine (it brings a headless Chrome)."));
      const dir = mkdtempSync(join(tmpdir(), "bw-mail-"));
      const file = join(dir, "mail.html"), png = join(dir, "mail.png");
      writeFileSync(file, html);
      let err = "";
      const child = spawn(process.execPath, [script, chrome, file, png, String(width)], { cwd: opts.enginePath, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (d) => (err += d));
      const finish = (fn: () => void) => { clearTimeout(timer); fn(); rmSync(dir, { recursive: true, force: true }); };
      const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error("The preview took more than 40 seconds"))); }, 40_000);
      child.on("error", (e) => finish(() => reject(e)));
      child.on("close", () => finish(() => (existsSync(png) ? resolve(new Uint8Array(readFileSync(png))) : reject(new Error(`No picture was made: ${err.trim().slice(0, 300) || "no output"}`)))));
    }),
  };
}
