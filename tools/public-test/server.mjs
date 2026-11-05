#!/usr/bin/env node
// Public test front of the BrandWise instance on this Mac (docs/analytics.md, step 3; test only). It serves a test page and
// forwards two things to the plugin's routes: the short-link redirect (`/l?c=...`) and the OAuth return addresses of connected
// accounts (`/oauth/<platform>`, docs/channels.md). A Cloudflare quick tunnel can then expose these and nothing else of bb: the bb UI
// and API stay on loopback (bb answers 403 to a foreign Host header anyway; this front talks to it as 127.0.0.1). Started by
// tools/public-test.sh; no dependencies.
//   PORT (default 38909; bb's own proxy sits on 38899), BW_SERVER_URL (default http://127.0.0.1:38896)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 38909);
const BB = (process.env.BW_SERVER_URL ?? "http://127.0.0.1:38896").replace(/\/+$/, "");
const ROUTES = `${BB}/api/v1/plugins/brandwise/http`;
/** Public paths and the plugin routes behind them. */
const FORWARD = [/^\/l$/, /^\/oauth\/[a-z]+$/];
const page = await readFile(new URL("./index.html", import.meta.url), "utf8");

const text = (res, status, body) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(body); };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : page.replaceAll("{{now}}", new Date().toISOString()).replaceAll("{{host}}", req.headers.host ?? ""));
  }
  if (url.pathname === "/health") return text(res, 200, "ok");
  if (FORWARD.some((re) => re.test(url.pathname)) && (req.method === "GET" || req.method === "HEAD")) {
    // the plugin trusts only the last x-forwarded-for entry, the one its own proxy appended: that is us, so append the real
    // client (Cloudflare gives it as cf-connecting-ip; without the tunnel it is the socket's peer)
    const client = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "");
    const forwarded = [req.headers["x-forwarded-for"], client].filter(Boolean).join(", ");
    try {
      const r = await fetch(`${ROUTES}${url.pathname}${url.search}`, { method: req.method, redirect: "manual", headers: { "user-agent": String(req.headers["user-agent"] ?? ""), "x-forwarded-for": forwarded } });
      const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer-when-downgrade", "content-type": r.headers.get("content-type") ?? "text/plain; charset=utf-8" };
      const location = r.headers.get("location");
      if (location) headers.location = location;
      res.writeHead(r.status, headers);
      return res.end(req.method === "HEAD" ? undefined : Buffer.from(await r.arrayBuffer()));
    } catch (cause) {
      return text(res, 502, `The BrandWise instance did not answer (${cause instanceof Error ? cause.message : String(cause)}).`);
    }
  }
  return text(res, 404, "Not found.");
}).listen(PORT, "127.0.0.1", () => console.log(`public test front on http://127.0.0.1:${PORT}, /l and /oauth/* -> ${ROUTES}`));
