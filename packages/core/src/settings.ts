// Scoped settings (docs/settings.md): one value per (scope, key). Scope = a campaign, or global (null).
// A campaign sees its own value, else its parent's (the always-on base), else the global one, else the field's default.
// What can be set is declared in code (SettingField); unknown keys are refused. Secrets are encrypted at rest.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SettingValue = string | number | boolean;
export type SettingField = {
  key: string; // "<namespace>.<name>", e.g. "higgsfield.workspaceId"
  label: string;
  description?: string;
  group: string; // heading in the UI
  type: "string" | "number" | "boolean" | "select";
  options?: string[];
  secret?: boolean;
  default?: SettingValue;
  /** Tells the UI to draw a purpose built control instead of a plain input (e.g. "instagram-session"). */
  widget?: string;
  /** Changed only by a person in the UI, never from the CLI (which agents call): money limits and switches that start agents. */
  userOnly?: boolean;
};
/** null = global. */
export type Scope = string | null;
export type Resolved = { value: SettingValue; scope: Scope | "default" };
export type FieldView = { field: SettingField; value: SettingValue | null; isSet: boolean; source: Scope | "default" | "unset" };

type Row = { campaign_id: string | null; key: string; value: any; secret: boolean };
type Deps = {
  q: (text: string, params?: unknown[]) => Promise<any[]>;
  /** The scope and its ancestors, nearest first, ending with the global scope: [campaign, parent, null]. */
  chain: (scope: Scope) => Promise<Scope[]>;
  fields: SettingField[];
  secretKey?: string;
};

const ALGO = "aes-256-gcm";
const keyBytes = (key: string) => {
  const b = Buffer.from(key, "base64");
  if (b.length !== 32) throw new Error("The encryption key must be 32 bytes, base64 encoded");
  return b;
};
export const seal = (key: string, text: string): string => {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, keyBytes(key), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
};
export const open = (key: string, sealed: string): string => {
  const raw = Buffer.from(sealed, "base64");
  const d = createDecipheriv(ALGO, keyBytes(key), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
};

export function createSettings(deps: Deps) {
  const field = (key: string): SettingField => {
    const f = deps.fields.find((x) => x.key === key);
    if (!f) throw new Error(`Unknown setting ${key}`);
    return f;
  };
  const check = (f: SettingField, v: SettingValue) => {
    const ok = f.type === "number" ? typeof v === "number" && Number.isFinite(v)
      : f.type === "boolean" ? typeof v === "boolean"
      : typeof v === "string" && v.length <= 20_000 && (f.type !== "select" || (f.options ?? []).includes(v));
    if (!ok) throw new Error(`Invalid value for ${f.key}`);
  };
  const read = (row: Row): SettingValue => {
    if (!row.secret) return row.value as SettingValue;
    if (!deps.secretKey) throw new Error(`${row.key} is a secret but no encryption key is configured`);
    try { return open(deps.secretKey, row.value.enc); } catch { throw new Error(`Cannot decrypt ${row.key}: the encryption key changed. Set it again.`); }
  };
  const rowsFor = (scopes: Scope[]) =>
    deps.q("select campaign_id, key, value, secret from setting where campaign_id = any($1::uuid[]) or ($2 and campaign_id is null)", [scopes.filter((s): s is string => s !== null), scopes.includes(null)]) as Promise<Row[]>;

  return {
    fields: deps.fields,
    chain: deps.chain,
    /** The value set exactly at this scope (no inheritance), decrypted. */
    async own(scope: Scope, key: string): Promise<SettingValue | undefined> {
      field(key);
      const rows = (await deps.q("select campaign_id, key, value, secret from setting where campaign_id is not distinct from $1 and key = $2", [scope, key])) as Row[];
      return rows[0] ? read(rows[0]) : undefined;
    },
    /** The value this scope works with, and where it comes from; undefined when nothing sets it and there is no default. */
    async resolve(scope: Scope, key: string): Promise<Resolved | undefined> {
      const f = field(key);
      const chain = await deps.chain(scope);
      const rows = await rowsFor(chain);
      for (const s of chain) {
        const row = rows.find((r) => r.campaign_id === s && r.key === key);
        if (row) return { value: read(row), scope: s };
      }
      return f.default === undefined ? undefined : { value: f.default, scope: "default" };
    },
    async set(scope: Scope, key: string, value: SettingValue): Promise<void> {
      const f = field(key);
      check(f, value);
      if (f.secret && !deps.secretKey) throw new Error("No encryption key is configured, so secrets cannot be saved");
      const stored = f.secret ? { enc: seal(deps.secretKey!, String(value)) } : value;
      await deps.q(
        `insert into setting (campaign_id, key, value, secret) values ($1, $2, $3, $4)
         on conflict (campaign_id, key) do update set value = excluded.value, secret = excluded.secret, updated_at = now()`,
        [scope, key, JSON.stringify(stored), f.secret === true],
      );
    },
    /** Remove the value at this scope, so it inherits again. */
    async unset(scope: Scope, key: string): Promise<void> {
      field(key);
      await deps.q("delete from setting where campaign_id is not distinct from $1 and key = $2", [scope, key]);
    },
    /** Every field as seen from this scope. Secret values are never returned, only whether one is set. */
    async view(scope: Scope): Promise<FieldView[]> {
      const chain = await deps.chain(scope);
      const rows = await rowsFor(chain);
      return deps.fields.map((f) => {
        for (const s of chain) {
          const row = rows.find((r) => r.campaign_id === s && r.key === f.key);
          if (row) return { field: f, value: f.secret ? null : (row.value as SettingValue), isSet: true, source: s };
        }
        return { field: f, value: f.secret ? null : (f.default ?? null), isSet: f.default !== undefined, source: f.default === undefined ? "unset" : "default" };
      });
    },
  };
}
export type Settings = ReturnType<typeof createSettings>;
