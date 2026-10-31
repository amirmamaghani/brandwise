// Link checking: which links an e-mail has, and what a checker says about them. The checker is a port, so this stays pure.
import type { Finding } from "./types.ts";

export interface LinkChecker {
  check(url: string): Promise<{ status: number | null; error?: string }>;
}

/** The http(s) addresses in the HTML that a reader can click: no tokens, anchors, mailto or tel. */
export function extractLinks(html: string): string[] {
  const urls = [...html.matchAll(/<a\s[^>]*href="([^"]*)"/gi)].map((m) => m[1].replace(/&amp;/g, "&")).filter((h) => /^https?:\/\//i.test(h) && !h.includes("{{") && !h.includes("[["));
  return [...new Set(urls)];
}

export async function checkLinks(html: string, checker: LinkChecker, limit = 25): Promise<Finding[]> {
  const urls = extractLinks(html);
  const findings: Finding[] = urls.length > limit ? [{ rule: "link-check", severity: "info", message: `${urls.length} links, only the first ${limit} were checked` }] : [];
  for (const url of urls.slice(0, limit)) {
    const r = await checker.check(url);
    if (r.status === null) findings.push({ rule: "link-check", severity: "error", message: `${url} could not be reached (${r.error ?? "no answer"})` });
    else if (r.status >= 400) findings.push({ rule: "link-check", severity: "error", message: `${url} answers ${r.status}` });
    else if (r.status >= 300) findings.push({ rule: "link-check", severity: "warn", message: `${url} answers ${r.status} (a redirect that was not followed)` });
  }
  return findings;
}
