// Settings page of the BrandWise: a navigation of sections on the left, the fields of the chosen section on the right.
// The sections come from the server (SECTIONS in server.ts), so a new setting needs no change here. A section whose content is
// richer than plain fields is registered with addSettingsSection (app.tsx): the same id replaces the server's fields, a new id is added.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { SettingsView, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Field = SettingsView["sections"][number]["fields"][number];
type Draft = Record<string, string | number | boolean>;
type Custom = { id: string; title: string; description: string; component: ComponentType };

const customs: Custom[] = [];
export const addSettingsSection = (custom: Custom) => {
  customs.push(custom);
};

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const SELECT = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function FieldsForm({ fields, onSaved }: { fields: Field[]; onSaved: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const changed = fields.filter((f) => f.key in draft && (f.secret ? draft[f.key] !== "" : draft[f.key] !== f.value));
  const invalid = changed.some((f) => typeof draft[f.key] === "number" && Number.isNaN(draft[f.key]));
  const edit = (key: string, value: string | number | boolean) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setDraft({});
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(async () => { for (const f of changed) await rpc.call("settings_set", { key: f.key, value: draft[f.key] }); });
  const clear = (key: string) => run(() => rpc.call("settings_set", { key, value: null }));
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed.length > 0 && !invalid) void save();
      }}
    >
      {fields.map((f) => {
        const id = `setting-${f.key}`;
        const current = f.key in draft ? draft[f.key] : f.value;
        return (
          <div key={f.key} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">{f.label}</label>
            {f.type === "boolean" ? (
              <input id={id} type="checkbox" className="size-4" checked={current === true} onChange={(e) => edit(f.key, e.target.checked)} />
            ) : f.type === "select" ? (
              <select id={id} className={SELECT} value={String(current ?? "")} onChange={(e) => edit(f.key, e.target.value)}>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === "number" ? (
              <Input id={id} type="number" value={typeof current === "number" && !Number.isNaN(current) ? current : ""} onChange={(e) => edit(f.key, e.target.value === "" ? NaN : Number(e.target.value))} />
            ) : f.secret ? (
              <div className="flex gap-2">
                <Input id={id} type="password" autoComplete="off" value={String(draft[f.key] ?? "")} placeholder={f.isSet ? "Set. Type to replace it." : "Not set"} onChange={(e) => edit(f.key, e.target.value)} />
                {f.isSet && !(f.key in draft) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={armed === f.key ? "destructive" : "ghost"}
                    className="self-center"
                    disabled={busy}
                    onBlur={() => setArmed(null)}
                    onClick={() => (armed === f.key ? void clear(f.key) : setArmed(f.key))}
                  >
                    {armed === f.key ? "Sure?" : "Clear"}
                  </Button>
                ) : null}
              </div>
            ) : (
              <Input id={id} value={String(current ?? "")} onChange={(e) => edit(f.key, e.target.value)} />
            )}
            {f.description === null ? null : <p className="text-xs text-muted-foreground">{f.description}</p>}
          </div>
        );
      })}
      {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy || changed.length === 0 || invalid}>Save</Button>
        {changed.length > 0 ? <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft({})}>Discard</Button> : null}
        <span role="status" className="text-xs text-muted-foreground">
          {saved ? "Saved, applied now." : changed.length > 0 ? `${changed.length} unsaved ${changed.length === 1 ? "change" : "changes"}` : "Changes apply as soon as you save."}
        </span>
      </div>
    </form>
  );
}

/** The sections to navigate: the server's, with custom ones replacing same-id fields or added at the end. */
function useSections() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("settings_get").then((v) => (setView(v), setError(null)), (cause) => setError(message(cause)));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("settings-changed", refetch);
  const items = useMemo(() => {
    if (view === null) return [];
    const known = new Set(view.sections.map((s) => s.id));
    return [
      ...view.sections.map((s) => ({ ...s, Custom: customs.find((c) => c.id === s.id)?.component })),
      ...customs.filter((c) => !known.has(c.id)).map((c) => ({ id: c.id, title: c.title, description: c.description, fields: [] as Field[], Custom: c.component })),
    ];
  }, [view]);
  return { items, error, refetch };
}
type Items = ReturnType<typeof useSections>["items"];

function SectionNav({ items, activeId, onSelect, className }: { items: Items; activeId: string | undefined; onSelect: (id: string) => void; className?: string }) {
  return (
    <nav aria-label="Settings sections" className={className}>
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          aria-current={i.id === activeId ? "page" : undefined}
          onClick={() => onSelect(i.id)}
          className={cn("whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", i.id === activeId && "bg-accent font-medium")}
        >
          {i.title}
        </button>
      ))}
    </nav>
  );
}

function SectionBody({ active, error, refetch }: { active: Items[number] | undefined; error: string | null; refetch: () => void }) {
  return (
    <>
      {error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {active === undefined ? (
        error === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null
      ) : (
        <>
          <h2 className="text-base font-semibold">{active.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{active.description}</p>
          <div className="mt-5">{active.Custom ? <active.Custom /> : <FieldsForm key={active.id} fields={active.fields} onSaved={refetch} />}</div>
        </>
      )}
    </>
  );
}

/** Left navigation in the app's own sidebar (it replaces the thread list while the Settings page is open). */
export function SettingsSidebar({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { items } = useSections();
  return (
    <SectionNav
      items={items}
      activeId={(items.find((i) => i.id === subPath) ?? items[0])?.id}
      onSelect={(id) => navigate.toPluginPanel("settings", { subPath: id })}
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2"
    />
  );
}

/** The page itself: the chosen section. The section is part of the address, the navigation is SettingsSidebar. */
export function SettingsPage({ subPath }: { subPath: string }) {
  const { items, error, refetch } = useSections();
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-5 md:px-6">
        <SectionBody active={items.find((i) => i.id === subPath) ?? items[0]} error={error} refetch={refetch} />
      </div>
    </div>
  );
}

/** The same sections inside bb's system settings page for the plugin (below bb's own flat form), with the navigation beside them. */
export function SettingsSection() {
  const { items, error, refetch } = useSections();
  const [id, setId] = useState("");
  const active = items.find((i) => i.id === id) ?? items[0];
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <SectionNav items={items} activeId={active?.id} onSelect={setId} className="flex shrink-0 gap-1 overflow-x-auto md:w-52 md:flex-col" />
      <div className="min-w-0 max-w-2xl flex-1">
        <SectionBody active={active} error={error} refetch={refetch} />
      </div>
    </div>
  );
}
