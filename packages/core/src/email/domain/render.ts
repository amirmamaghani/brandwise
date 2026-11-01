// Turns an approved calendar entry (title, text, link) into the e-mail we hand to a provider. Provider-neutral: the only
// provider-specific piece is the unsubscribe merge tag, passed in.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type UtmContext = { entryId: string; /** the campaign's slug; the entry id when unknown */ campaign?: string; medium?: string; source?: string };
const slugOf = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
export const campaignSlug = (name: string | undefined) => slugOf(name ?? "") || "campaign";

/**
 * Adds UTM parameters so web analytics, forms and lead sources can tell which calendar entry a visit came from: utm_content is the
 * entry id (docs/analytics.md D6), utm_campaign the campaign. Parameters already on the link are kept.
 */
export function withUtm(link: string, ctx: UtmContext | string): string {
  const c = typeof ctx === "string" ? { entryId: ctx } : ctx;
  const url = new URL(link);
  const params = [["utm_source", c.source ?? "brandwise"], ["utm_medium", c.medium ?? "email"], ["utm_campaign", c.campaign ?? c.entryId], ["utm_content", c.entryId]] as const;
  for (const [k, v] of params) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  return url.toString();
}

/** Every http(s) link of an HTML body gets the UTM parameters; merge tokens, mailto and the unsubscribe link are left alone. */
export function tagLinks(html: string, ctx: UtmContext, skip: string[] = []): string {
  return html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (all, q: string, href: string) => {
    if (href.includes("{{") || href.includes("[[") || skip.some((s) => s && href.includes(s))) return all;
    try { return `href=${q}${withUtm(href.replace(/&amp;/g, "&"), ctx).replace(/&/g, "&amp;")}${q}`; } catch { return all; }
  });
}

/** Bare http(s) URLs in plain text (an e-mail or a post) get the UTM parameters too. */
export function tagText(text: string, ctx: UtmContext): string {
  // punctuation that ends a sentence ("see https://shop.com/sale.") is not part of the link
  return text.replace(/https?:\/\/[^\s<>"')]+/g, (match) => {
    const url = match.replace(/[.,;:!?]+$/, ""), tail = match.slice(url.length);
    try { return withUtm(url, ctx) + tail; } catch { return match; }
  });
}

/**
 * Plain text becomes paragraphs; a body that starts with "<" is taken as HTML as it is. Either way the unsubscribe link is
 * guaranteed: it is appended when the HTML lacks the provider's tag.
 */
export function renderEmail(input: { body: string; link: string | null; entryId: string; unsubscribeTag: string; campaign?: string }): { html: string; text: string } {
  const ctx: UtmContext = { entryId: input.entryId, campaign: input.campaign };
  const body = input.body.trim();
  const link = input.link ? withUtm(input.link, ctx) : null;
  const footerHtml = `<p style="font-size:12px;color:#666666"><a href="${input.unsubscribeTag}">Unsubscribe</a></p>`;
  if (body.startsWith("<")) {
    const tagged = tagLinks(body, ctx, [input.unsubscribeTag]);
    return { html: tagged.includes(input.unsubscribeTag) ? tagged : tagged + footerHtml, text: "" };
  }
  const paragraphs = tagText(body, ctx).split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`);
  if (link) paragraphs.push(`<p><a href="${esc(link)}">${esc(link)}</a></p>`);
  return {
    html: [...paragraphs, footerHtml].join("\n"),
    text: [tagText(body, ctx), link, `Unsubscribe: ${input.unsubscribeTag}`].filter(Boolean).join("\n\n"),
  };
}
