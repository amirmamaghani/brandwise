// Helpers for host side downloads (the plugin runs yt-dlp and gallery-dl; docs/settings.md "Downloads").

/**
 * The Instagram `sessionid` out of a Netscape cookie file (what gallery-dl exports). Lines are tab separated:
 * domain, subdomains, path, secure, expiry, name, value; HttpOnly cookies carry a "#HttpOnly_" prefix on the domain.
 */
export function sessionFromCookieJar(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/^#HttpOnly_/, "");
    if (line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length >= 7 && /(^|\.)instagram\.com$/.test(f[0]) && f[5] === "sessionid" && f[6].trim() !== "") return f[6].trim();
  }
  return null;
}

const IG_DOMAIN = /(^|\.)instagram\.com$/;
const MAX_COOKIES_TEXT = 20_000;

/**
 * Netscape cookie jar text for gallery-dl and yt-dlp, from what the user saved for Instagram. Three forms are accepted, because a
 * single sessionid is often not enough on another device (Instagram also looks at the device cookies such as mid and ig_did):
 *  - the whole `cookie:` request header copied from the browser (`mid=..; sessionid=..; csrftoken=..`),
 *  - a cookies.txt export (only the instagram.com lines are kept),
 *  - a bare sessionid.
 * Expiry is rewritten to 30 days ahead, because session cookies exported with expiry 0 would be dropped as already expired.
 */
export function cookieJarFor(saved: string, now = Date.now()): string {
  const text = saved.trim();
  if (text === "") throw new Error("No Instagram cookies are saved");
  if (text.length > MAX_COOKIES_TEXT) throw new Error("The saved Instagram cookies are too long: save only the cookies of instagram.com");
  const expiry = Math.floor(now / 1000) + 30 * 86400;
  const header = "# Netscape HTTP Cookie File\n";
  const row = (name: string, value: string) => `.instagram.com\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${value}\n`;
  const need = (jar: string) => {
    if (sessionFromCookieJar(jar) === null) throw new Error("The saved Instagram cookies have no sessionid: copy them while signed in to Instagram");
    return jar;
  };
  if (text.includes("\t")) {
    const rows = text.split(/\r?\n/).map((l) => l.replace(/^#HttpOnly_/, "").split("\t")).filter((f) => f.length >= 7 && IG_DOMAIN.test(f[0]));
    return need(header + rows.map((f) => [...f.slice(0, 4), String(expiry), f[5], f[6]].join("\t") + "\n").join(""));
  }
  if (text.includes("=")) {
    const pairs = text.replace(/^cookie:\s*/i, "").split(";").map((p) => p.trim()).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as const);
    if (pairs.length === 0 || pairs.some(([n, v]) => !/^[A-Za-z0-9_.-]+$/.test(n) || v === "" || /\s/.test(v))) throw new Error("The saved Instagram cookies are not in the form name=value; name=value");
    return need(header + pairs.map(([n, v]) => row(n, v)).join(""));
  }
  if (!/^[A-Za-z0-9%_.:-]{10,300}$/.test(text)) throw new Error("The saved Instagram session id looks wrong");
  return header + row("sessionid", text);
}
