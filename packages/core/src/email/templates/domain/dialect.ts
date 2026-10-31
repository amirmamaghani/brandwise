// Templates write personalisation in neutral tokens, [[first_name|there]] and [[unsubscribe_url]]. The provider's dialect turns them
// into what that provider understands; for a preview the tokens are filled with sample data. (Slots use {{ }}, tokens use [[ ]], so
// the two never meet.)
import type { MergeDialect } from "../../domain/types.ts";

const TOKEN = /\[\[\s*([a-z_]+)\s*(?:\|([^\]]*))?\]\]/g;

export function applyDialect(text: string, dialect: MergeDialect): string {
  return text.replace(TOKEN, (_m, field: string, fallback?: string) => (field === "unsubscribe_url" ? dialect.unsubscribe : dialect.token(field, fallback?.trim() || undefined)));
}

/** Sample contact for previews. */
export const SAMPLE_CONTACT: Record<string, string> = { first_name: "Alex", last_name: "Novak", email: "alex@example.com" };

export const previewDialect = (contact: Record<string, string> = SAMPLE_CONTACT): MergeDialect => ({
  unsubscribe: "#unsubscribe",
  token: (field, fallback) => contact[field] ?? fallback ?? "",
  hostedImagesRequired: false,
});

/** The fields a template asks for, and whether each has a fallback. */
export function tokensIn(text: string): { field: string; fallback: boolean }[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ field: m[1], fallback: !!m[2]?.trim() }));
}
