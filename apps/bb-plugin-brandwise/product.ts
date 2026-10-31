// Product pack of a brand: a few Markdown files per always-on campaign (what is sold, to whom, what may be claimed).
// Agents read it with `product get`, the onboarding wizard (skills/product-onboarding) writes it with `product set`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Core } from "./core/index.ts";

export const PACK_FILES = ["product.md", "audience.md", "claims.md", "constraints.md", "voice.md"] as const;
const DERIVED = /^derived\/[a-z0-9-]{1,48}\.md$/;
const MAX_BYTES = 200_000;

const root = () => process.env.BW_PRODUCT_DIR || path.join(os.homedir(), ".bb-brandwise", "product");
const validName = (n: string) => (PACK_FILES as readonly string[]).includes(n) || DERIVED.test(n);

/** The pack belongs to the always-on base: a campaign under it shares its base's pack. */
async function packDir(c: Core, hint: string | undefined) {
  const campaign = await c.campaigns.resolve(hint);
  return path.join(root(), campaign.parentId ?? campaign.id);
}

type Io = { val: (argv: string[], name: string) => string | undefined; positional: (argv: string[]) => string[]; reply: (value: unknown, text: string) => { exitCode: number; stdout: string }; usage: string };

/** `bb brandwise product get [<file>] | set <file> (--body <text> | --file <path>) | list` */
export async function productCli(c: Core, action: string | undefined, args: string[], { val, positional, reply, usage }: Io) {
  const dir = await packDir(c, val(args, "--campaign"));
  const [name] = positional(args.slice(2));
  if (action === "list" || (action === "get" && !name)) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md")).sort() : [];
    const missing = PACK_FILES.filter((f) => !files.includes(f));
    return reply({ dir, files, missing }, `${dir}\nfiles: ${files.join(", ") || "none"}\nmissing: ${missing.join(", ") || "none"}`);
  }
  if (!name || !validName(name)) return { exitCode: 1, stderr: `File must be one of ${PACK_FILES.join(", ")} or derived/<name>.md\n${usage}` };
  const file = path.join(dir, name);
  if (action === "get") {
    if (!fs.existsSync(file)) return { exitCode: 1, stderr: `${name} does not exist yet` };
    return reply({ name, content: fs.readFileSync(file, "utf8") }, fs.readFileSync(file, "utf8"));
  }
  if (action === "set") {
    const from = val(args, "--file");
    const body = from ? fs.readFileSync(from, "utf8") : val(args, "--body");
    if (body === undefined || body.trim() === "") return { exitCode: 1, stderr: `Give the content with --body '<text>' or --file <path>\n${usage}` };
    if (Buffer.byteLength(body) > MAX_BYTES) return { exitCode: 1, stderr: `${name} is over ${MAX_BYTES} bytes` };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
    return reply({ name, bytes: Buffer.byteLength(body) }, `Saved ${name} in ${dir}`);
  }
  return { exitCode: 1, stderr: usage };
}
