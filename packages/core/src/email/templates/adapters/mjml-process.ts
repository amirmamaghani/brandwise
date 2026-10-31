// Renderer adapter: MJML compiled by @brandwise/email-engine in a child process. Keeps MJML and its dependency tree out of the
// plugin bundle, and out of every process that does not render e-mail.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Renderer } from "../domain/ports.ts";

export function mjmlProcess(enginePath: string): Renderer {
  const script = join(enginePath, "mjml.mjs");
  return {
    compile: (mjml) => new Promise((resolve, reject) => {
      if (!enginePath || !existsSync(script) || !existsSync(join(enginePath, "node_modules", "mjml"))) {
        return reject(new Error("The e-mail engine is not installed: run npm install in packages/email-engine and set the plugin setting emailEnginePath to that folder."));
      }
      const child = spawn(process.execPath, [script], { cwd: enginePath, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("MJML took more than 30 seconds")); }, 30_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(out)); } catch { reject(new Error(`MJML failed: ${(err || out).trim().slice(0, 300) || "no output"}`)); }
      });
      child.stdin.end(mjml);
    }),
  };
}
