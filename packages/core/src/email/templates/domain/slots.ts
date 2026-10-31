// Content is data checked against the template's slot schema: this is the contract between whoever designs a template and whoever
// (or whatever agent) writes into it. Nothing that does not fit the schema reaches a render.
import type { Finding, ImageValue, SlotDef, TemplateConfig } from "./types.ts";
import { sanitizeRichText } from "./text.ts";

const DEFAULT_MAX = { text: 200, "richtext-lite": 5000, list: 10 } as const;
const err = (slot: string, message: string): Finding => ({ rule: "slot", severity: "error", message: `${slot}: ${message}` });

export function validateContent(config: TemplateConfig, content: Record<string, unknown>): { value: Record<string, unknown>; findings: Finding[] } {
  const findings: Finding[] = [];
  const value: Record<string, unknown> = {};
  for (const key of Object.keys(content)) if (!(key in config.slots)) findings.push({ rule: "slot", severity: "warn", message: `${key}: not a slot of this template, ignored` });
  for (const [key, def] of Object.entries(config.slots) as [string, SlotDef][]) {
    const raw = content[key];
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (empty) { if (def.required) findings.push(err(key, "required but empty")); continue; }
    switch (def.type) {
      case "text": {
        if (typeof raw !== "string") { findings.push(err(key, "must be text")); break; }
        const s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
        if (s.length > (def.max ?? DEFAULT_MAX.text)) findings.push(err(key, `is ${s.length} characters, the limit is ${def.max ?? DEFAULT_MAX.text}`));
        value[key] = s;
        break;
      }
      case "richtext-lite": {
        if (typeof raw !== "string") { findings.push(err(key, "must be text")); break; }
        if (raw.length > (def.max ?? DEFAULT_MAX["richtext-lite"])) findings.push(err(key, `is ${raw.length} characters, the limit is ${def.max ?? DEFAULT_MAX["richtext-lite"]}`));
        value[key] = sanitizeRichText(raw);
        break;
      }
      case "image": {
        const v = raw as Partial<ImageValue>;
        if (typeof v !== "object" || typeof v.asset !== "string" || v.asset === "") { findings.push(err(key, "must be {asset, alt}")); break; }
        if (typeof v.alt !== "string" || v.alt.trim() === "") findings.push(err(key, "image needs alt text"));
        value[key] = { asset: v.asset, alt: (v.alt ?? "").trim() };
        break;
      }
      case "link": {
        if (typeof raw !== "string" || !/^(https:\/\/|mailto:)\S+$/i.test(raw.trim())) { findings.push(err(key, "must be an https:// or mailto: address")); break; }
        value[key] = raw.trim();
        break;
      }
      case "list": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) { findings.push(err(key, "must be a list of texts")); break; }
        if (raw.length > (def.max ?? DEFAULT_MAX.list)) findings.push(err(key, `has ${raw.length} items, the limit is ${def.max ?? DEFAULT_MAX.list}`));
        value[key] = raw.map((s) => String(s).trim());
        break;
      }
      case "enum": {
        if (typeof raw !== "string" || !def.values.includes(raw)) { findings.push(err(key, `must be one of ${def.values.join(", ")}`)); break; }
        value[key] = raw;
        break;
      }
    }
  }
  return { value, findings };
}
