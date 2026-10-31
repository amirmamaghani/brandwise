// Small pure text helpers: rich-text sanitising, HTML to plain text, escaping.
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const ALLOWED = new Set(["p", "br", "b", "strong", "i", "em", "ul", "ol", "li", "a"]);
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|</g;

/**
 * Keeps a few inline and list tags and links to https or mailto; everything else is dropped (its text stays). Agents write this
 * content, and it reaches the e-mail unescaped, so nothing else may get through: no scripts, styles, events, other attributes.
 */
export function sanitizeRichText(input: string): string {
  let out = "";
  let last = 0;
  for (const m of input.matchAll(TAG)) {
    out += input.slice(last, m.index).replace(/</g, "&lt;");
    last = m.index + m[0].length;
    const name = m[1]?.toLowerCase();
    if (!name) { out += "&lt;"; continue; }   // a lone "<" in the text
    if (!ALLOWED.has(name)) continue;               // any other tag goes, its text stays
    if (m[0].startsWith("</")) { out += `</${name}>`; continue; }
    if (name === "a") {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(m[2]);
      const url = (href?.[1] ?? href?.[2] ?? "").trim();
      out += /^(https:\/\/|mailto:)/i.test(url) ? `<a href="${escapeHtml(url)}">` : "<a>";
    } else out += `<${name}>`;
  }
  return out + input.slice(last).replace(/</g, "&lt;");
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** The plain-text part of an HTML e-mail: links keep their address, blocks become lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|head|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return !text || text === href || href.startsWith("#") ? text || href : `${text} (${href})`;
    })
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e])
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
