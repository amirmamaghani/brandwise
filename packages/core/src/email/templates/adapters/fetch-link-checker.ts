// LinkChecker adapter: HEAD (then GET if the server dislikes HEAD) over https, with a short timeout. It refuses to call private addresses
// (localhost, internal networks): the URLs come from content that agents write, so the checker must not become a way to probe the network.
// shortcut: the address is checked before the request, not pinned for it, so a DNS answer that changes in between is not caught; fine for a
// check run by the operator, pin the address in the connection if links ever come from outsiders.
import { lookup as dnsLookup } from "node:dns/promises";
import type { LinkChecker } from "../domain/links.ts";

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function fetchLinkChecker(opts: { fetchImpl?: typeof fetch; lookup?: (host: string) => Promise<{ address: string }[]>; timeoutMs?: number } = {}): LinkChecker {
  const lookup = opts.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  return {
    async check(url) {
      let u: URL;
      try { u = new URL(url); } catch { return { status: null, error: "not a valid address" }; }
      if (u.protocol !== "https:") return { status: null, error: "not https" };
      try {
        if (u.hostname === "localhost" || (await lookup(u.hostname)).some((a) => isPrivateAddress(a.address))) return { status: null, error: "a private address is not checked" };
      } catch { return { status: null, error: "the domain does not exist" }; }
      for (const method of ["HEAD", "GET"]) {
        try {
          const res = await (opts.fetchImpl ?? fetch)(url, { method, redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs ?? 8000), headers: { "user-agent": "BrandWise link check" } });
          if (method === "HEAD" && (res.status === 405 || res.status === 501 || res.status === 403)) continue;
          return { status: res.status };
        } catch (e) {
          if (method === "GET") return { status: null, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return { status: null, error: "no answer" };
    },
  };
}
