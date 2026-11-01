// Attributes of a calendar entry: the vocabulary learnings are mined over. Code derives what it can see in the entry itself;
// the rest (hook, angle, offer...) is tagged by the agent that writes the entry or by a person. Pure.

/** Set by the author (agent or person). Values are short lowercase slugs. */
export const TAGGED_KEYS = ["hook", "angle", "offer", "visual_style", "cta", "subject_style", "tone", "template"] as const;
/** Derived by code on every add and content edit; a tag cannot overwrite them. */
export const DERIVED_KEYS = ["format", "length", "subject_number", "subject_personal", "subject_question", "subject_caps", "send_daypart", "weekday"] as const;
export const ATTRIBUTE_KEYS: readonly string[] = [...TAGGED_KEYS, ...DERIVED_KEYS];

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "hook=question,offer=free_trial" into checked pairs. Unknown keys are refused, so the vocabulary stays small. */
export function parseTags(text: string | undefined): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = {};
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) throw new Error(`A tag is key=value (got "${part}")`);
    const key = slug(part.slice(0, i)), value = slug(part.slice(i + 1));
    if ((DERIVED_KEYS as readonly string[]).includes(key)) throw new Error(`${key} is derived by the system, do not tag it`);
    if (!(TAGGED_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown tag "${key}" (use ${TAGGED_KEYS.join(", ")})`);
    if (!value) throw new Error(`Tag ${key} has no value`);
    out[key] = value;
  }
  return out;
}

/** What code can tell from the entry itself. The subject features matter for e-mail, where the title is the subject line. */
export function deriveAttributes(e: { channel: string; title: string; body: string; scheduledAt: string; assetKind?: string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  out.format = e.assetKind === "video" ? "video" : e.assetKind === "image" ? "image" : "text";
  const len = e.body.replace(/<[^>]+>/g, " ").trim().length;
  out.length = len < 280 ? "short" : len < 1200 ? "medium" : "long";
  if (e.channel === "email") {
    const s = e.title;
    out.subject_number = /\d/.test(s) ? "yes" : "no";
    out.subject_personal = /\{\{\s*first_name|\[\[\s*first_name/i.test(s) ? "yes" : "no";
    out.subject_question = /\?\s*$/.test(s.trim()) ? "yes" : "no";
    const letters = s.replace(/\{\{[^}]*\}\}/g, "").replace(/[^A-Za-z]/g, "");
    out.subject_caps = /\b[A-Z]{4,}\b/.test(s) || (letters.length >= 8 && letters === letters.toUpperCase()) ? "yes" : "no";
  }
  const at = new Date(e.scheduledAt);
  const h = at.getUTCHours();
  out.send_daypart = h < 6 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  out.weekday = WEEKDAYS[at.getUTCDay()];
  return out;
}
