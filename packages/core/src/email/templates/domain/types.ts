// E-mail templates: pure types. A template is source files; a render is a pure function of source, content, brand and target.
import type { MergeDialect } from "../../domain/types.ts";

export type SlotDef =
  | { type: "text"; required?: boolean; max?: number }
  | { type: "richtext-lite"; required?: boolean; max?: number }
  | { type: "image"; required?: boolean }
  | { type: "link"; required?: boolean }
  | { type: "list"; required?: boolean; max?: number }
  | { type: "enum"; required?: boolean; values: string[] };

/** `locales` is optional: when set, content may only be written in these languages. */
export type TemplateConfig = { name: string; locales?: string[]; slots: Record<string, SlotDef> };

/** Design tokens and fixed brand content of a client. Free-form for the template; the footer and the link allowlist are checked. */
export type Brand = {
  name?: string;
  colors?: Record<string, string>;
  fonts?: Record<string, string>;
  logo?: { src: string; alt: string; width?: number };
  footer?: { company?: string; address?: string };
  /** When set, every link in a send must point at one of these domains (or a subdomain). */
  allowedLinkDomains?: string[];
  [key: string]: unknown;
};

/** `partials` are the client's components, usable in the layout as {{> name}}. */
export type TemplateSource = { mjml: string; config: TemplateConfig; brand: Brand; sample: Record<string, unknown>; partials?: Record<string, string> };

/** Slot value of an image: an asset id or an http(s) URL, and its alt text. */
export type ImageValue = { asset: string; alt: string };
export type ResolvedImage = { src: string; alt: string; width?: number; height?: number };

export type Severity = "error" | "warn" | "info";
export type Finding = { rule: string; severity: Severity; message: string };

/** preview = for people (sample contact data, images may be inlined); any other id is a provider whose dialect is used. */
export type Target = { id: string; dialect: MergeDialect | null };
export const PREVIEW = "preview";

export type Rendered = {
  html: string;
  text: string;
  subject: string;
  preheader: string;
  /** Size of the HTML in bytes. */
  size: number;
  findings: Finding[];
  target: string;
  /** Hash of everything that went in: the same inputs always give the same hash. */
  hash: string;
};
