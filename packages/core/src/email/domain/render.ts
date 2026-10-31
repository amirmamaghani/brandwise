// Turns an approved calendar entry (title, text, link) into the e-mail we hand to a provider. Provider-neutral: the only
// provider-specific piece is the unsubscribe merge tag, passed in.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Adds UTM parameters so web analytics can tell which e-mail a visit came from (existing parameters are kept). */
export function withUtm(link: string, entryId: string): string {
  const url = new URL(link);
  for (const [k, v] of [["utm_source", "brandwise"], ["utm_medium", "email"], ["utm_campaign", entryId]] as const) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Plain text becomes paragraphs; a body that starts with "<" is taken as HTML as it is. Either way the unsubscribe link is
 * guaranteed: it is appended when the HTML lacks the provider's tag.
 */
export function renderEmail(input: { body: string; link: string | null; entryId: string; unsubscribeTag: string }): { html: string; text: string } {
  const body = input.body.trim();
  const link = input.link ? withUtm(input.link, input.entryId) : null;
  const footerHtml = `<p style="font-size:12px;color:#666666"><a href="${input.unsubscribeTag}">Unsubscribe</a></p>`;
  if (body.startsWith("<")) return { html: body.includes(input.unsubscribeTag) ? body : body + footerHtml, text: "" };
  const paragraphs = body.split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`);
  if (link) paragraphs.push(`<p><a href="${esc(link)}">${esc(link)}</a></p>`);
  return {
    html: [...paragraphs, footerHtml].join("\n"),
    text: [body, link, `Unsubscribe: ${input.unsubscribeTag}`].filter(Boolean).join("\n\n"),
  };
}
