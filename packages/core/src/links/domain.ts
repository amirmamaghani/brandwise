// Own short links: every link of a post points at our redirect, so each click is counted for the calendar entry it came from, in
// any channel, with nothing to set up on the client's side (docs/analytics.md, step 3). Pure: codes, signatures, bot detection.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const b62 = (bytes: Uint8Array) => [...bytes].map((b) => B62[b % 62]).join("");

/** A link id is random; the code that travels is `<id>.<signature>`, so only links we issued resolve and guessing is pointless. */
export const newLinkId = () => b62(randomBytes(8));
const sign = (key: string, id: string) => b62(createHmac("sha256", key).update(`link:${id}`).digest().subarray(0, 6));
export const codeOf = (key: string, id: string) => `${id}.${sign(key, id)}`;

/** The id of a code whose signature is ours, else null. */
export function verifyCode(key: string, code: string): string | null {
  const m = /^([0-9A-Za-z]{8})\.([0-9A-Za-z]{6})$/.exec(code);
  if (!m) return null;
  const want = Buffer.from(sign(key, m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}

/**
 * Link previews and crawlers fetch a link without a person behind it (Telegram fetches every link of a post for its preview).
 * They are recorded but never counted as clicks.
 */
const BOTS = /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|facebookcatalog|embedly|slackbot|discordbot|whatsapp|telegrambot|twitterbot|linkedinbot|skypeuripreview|pinterest|vkshare|googlebot|bingbot|yandex|applebot|duckduckbot|headless|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios|^$/i;
export const isBot = (method: string, userAgent: string | null | undefined) => method.toUpperCase() === "HEAD" || BOTS.test((userAgent ?? "").trim());

/** A visitor is a salted hash of address and browser, so unique clicks can be counted without storing either. */
export const visitorOf = (key: string, ip: string | null, userAgent: string | null) =>
  createHmac("sha256", key).update(`visitor:${ip ?? ""}:${userAgent ?? ""}`).digest("hex").slice(0, 24);
/** The address alone, salted: one address adds at most MAX_VISITORS_PER_SOURCE visitors to an entry (a household, an office). */
export const sourceOf = (key: string, ip: string | null) => createHmac("sha256", key).update(`source:${ip ?? ""}`).digest("hex").slice(0, 24);
export const MAX_VISITORS_PER_SOURCE = 3;

/**
 * The client's address as our own proxy saw it: the right-most X-Forwarded-For entry, which the proxy in front of the instance
 * appends. Entries left of it are whatever the client sent and are never trusted.
 */
export const clientAddress = (forwardedFor: string | null | undefined): string | null => forwardedFor?.split(",").at(-1)?.trim() || null;

/** Replace every http(s) URL of a text with what `fn` returns for it (sentence punctuation after a URL stays outside it). */
export async function replaceUrls(text: string, fn: (url: string) => Promise<string>): Promise<string> {
  const parts: (string | Promise<string>)[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    parts.push(text.slice(last, m.index), fn(url));
    last = m.index! + url.length;
  }
  parts.push(text.slice(last));
  return (await Promise.all(parts)).join("");
}
