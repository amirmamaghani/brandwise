// Editor of the scoped settings (provider, account, limits) of one scope: global, or one campaign that overrides its base and global.
// The fields come from the server (core/providers), so a new provider or setting needs no change here.
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ConfigView, InstagramStatus, ProvidersStatus, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Field = ConfigView["groups"][number]["fields"][number];
type Draft = Record<string, string | number | boolean>;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const SELECT = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

const BROWSERS = ["chrome", "safari", "firefox", "brave", "edge"];

/** Connect Instagram in two clicks: import the session of a browser the user is signed in with, then test it. Pasting the id by hand is the fallback. */
function InstagramConnect({ campaignId, field, onChanged }: { campaignId: string | null; field: Field; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [browser, setBrowser] = useState("chrome");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Downloads run on the machine bb runs on, and Import reads a browser on that machine. Opened from another device (e.g. over Tailscale)
  // the browser the user is signed in with is not that one, so pasting the session id is the way.
  const remote = typeof location !== "undefined" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const [paste, setPaste] = useState(remote);
  const [value, setValue] = useState("");
  const [armed, setArmed] = useState(false);
  const refresh = useCallback(() => rpc.call("instagram_status", { campaignId }).then(setStatus, () => {}), [rpc, campaignId]);
  useEffect(() => {
    setResult(null);
    void refresh();
  }, [refresh, field.isSet, field.source]);
  const work = async (kind: string, job: () => Promise<void>) => {
    setBusy(kind);
    setResult(null);
    try {
      await job();
    } catch (cause) {
      setResult({ ok: false, text: message(cause) });
    } finally {
      setBusy(null);
    }
  };
  const test = (prefix = "") => async () => {
    const r = await rpc.call("instagram_test", { campaignId });
    setResult({ ok: r.ok, text: `${prefix}${r.detail}` });
  };
  const importFrom = () =>
    work("import", async () => {
      await rpc.call("instagram_import", { campaignId, browser });
      onChanged();
      await refresh();
      await test("Connected. ")();
    });
  const save = () =>
    work("save", async () => {
      await rpc.call("config_set", { campaignId, key: field.key, value: value.trim() });
      setValue("");
      setPaste(false);
      onChanged();
      await refresh();
      await test("Saved. ")();
    });
  const disconnect = () =>
    work("clear", async () => {
      await rpc.call("config_set", { campaignId, key: field.key, value: null });
      setArmed(false);
      onChanged();
      await refresh();
    });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <p className="text-sm">
        {status === null ? "Checking…" : status.state === "saved" ? (
          <><span className="text-success">Connected</span> with a saved session{status.from !== "here" ? ` (from ${status.from})` : ""}.</>
        ) : status.state === "browser" ? (
          <>Using the session of {status.browser} (not saved).</>
        ) : (
          <><span className="text-warning-text">Not connected.</span> Instagram photos need a session.</>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select className={cn(SELECT, "h-8 w-auto text-xs capitalize")} value={browser} onChange={(e) => setBrowser(e.target.value)} aria-label="Browser to import the session from">
          {BROWSERS.map((b) => <option key={b}>{b}</option>)}
        </select>
        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void importFrom()}>{busy === "import" ? "Importing…" : "Import from browser"}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void work("test", test())}>{busy === "test" ? "Testing…" : "Test"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setPaste((p) => !p)}>{remote ? "Paste cookies" : "Paste cookies instead"}</Button>
        {status?.state === "saved" && status.from === "here" ? (
          <Button type="button" size="sm" variant={armed ? "destructive" : "ghost"} className={cn(!armed && "text-muted-foreground")} disabled={busy !== null} onBlur={() => setArmed(false)} onClick={() => (armed ? void disconnect() : setArmed(true))}>
            {armed ? "Sure?" : "Disconnect"}
          </Button>
        ) : null}
      </div>
      {remote ? (
        <p className="rounded-md border border-dashed border-border p-2 text-xs">
          You are on another device than the one bb runs on. Import reads a browser on that machine, so from here paste your cookies (below).
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Sign in to Instagram in the browser first. Importing reads the session once (macOS may ask for Keychain access) and saves it encrypted here; downloads then use it without a browser. It is a login, so prefer a dedicated account.
      </p>
      {paste ? (
        <div className="flex flex-col gap-2">
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>In your own browser, signed in to Instagram, open instagram.com and press F12 (DevTools), tab <strong>Network</strong>, then reload the page.</li>
            <li>Click the first request to <code>www.instagram.com</code>, find <strong>Request Headers</strong> and copy the whole value of <code>cookie:</code> (right click, Copy value).</li>
            <li>Paste it here and Save. Pasting only the <code>sessionid</code> or a cookies.txt export also works, but the whole header is the most reliable.</li>
          </ol>
          <textarea
            className="w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs"
            style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder="mid=…; ig_did=…; sessionid=…; csrftoken=…"
            aria-label="Instagram cookies"
            onChange={(e) => setValue(e.target.value)}
          />
          <div><Button type="button" size="sm" disabled={busy !== null || value.trim() === ""} onClick={() => void save()}>Save and test</Button></div>
        </div>
      ) : null}
      {result === null ? null : <p role="status" className={cn("text-sm", result.ok ? "text-success" : "text-destructive-text")}>{result.text}</p>}
    </div>
  );
}

const badge = (f: Field, global: boolean) =>
  f.source === "here" ? (global ? "Set" : "Set here") : f.source === "inherited" ? `From ${f.sourceName}` : f.source === "default" ? "Default" : "Not set";

export function ScopedConfig({ campaignId }: { campaignId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<ConfigView | null>(null);
  const [status, setStatus] = useState<ProvidersStatus | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("config_get", { campaignId }).then((v) => (setView(v), setError(null)), (cause) => setError(message(cause)));
  }, [rpc, campaignId]);
  useEffect(() => {
    setDraft({});
    setStatus(null);
    setSaved(false);
    refetch();
  }, [refetch]);
  useRealtime("config-changed", refetch);

  const fields = view?.groups.flatMap((g) => g.fields) ?? [];
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
      setStatus(null);
      refetch();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(async () => { for (const f of changed) await rpc.call("config_set", { campaignId, key: f.key, value: draft[f.key] }); });
  const reset = (key: string) => run(() => rpc.call("config_set", { campaignId, key, value: null }));
  const check = async () => {
    setChecking(true);
    try {
      setStatus(await rpc.call("providers_status", { campaignId }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setChecking(false);
    }
  };

  if (view === null) return error === null ? <p className="text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="text-sm text-destructive">{error}</p>;
  const global = campaignId === null;
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed.length > 0 && !invalid) void save();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {global
          ? "Global defaults. A campaign, or the always-on base it belongs to, can override any of these on its page under Campaigns."
          : `Applies to ${view.scopeName}. Anything not set here comes from ${view.inheritsFrom.join(", then ")}.`}
      </p>
      {view.groups.map((g) => (
        <section key={g.title} className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold">{g.title}</h3>
          {g.fields.map((f) => {
            const id = `config-${f.key}`;
            const current = f.key in draft ? draft[f.key] : f.value;
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={id} className="text-sm font-medium">{f.label}</label>
                  <span className={cn("rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground", f.source === "here" && "border-foreground/40 text-foreground")}>
                    {f.secret && f.isSet && f.source !== "here" ? `${badge(f, global)}, secret` : badge(f, global)}
                  </span>
                  {f.source === "here" ? (
                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground" disabled={busy} onClick={() => void reset(f.key)}>
                      {global ? "Reset to default" : "Use inherited"}
                    </Button>
                  ) : null}
                </div>
                {f.widget === "instagram-session" ? (
                  <InstagramConnect campaignId={campaignId} field={f} onChanged={refetch} />
                ) : f.type === "boolean" ? (
                  <input id={id} type="checkbox" className="size-4" checked={current === true} onChange={(e) => edit(f.key, e.target.checked)} />
                ) : f.type === "select" ? (
                  <select id={id} className={SELECT} value={String(current ?? "")} onChange={(e) => edit(f.key, e.target.value)}>
                    {f.options?.map((o) => <option key={o}>{o}</option>)}
                  </select>
                ) : f.type === "number" ? (
                  <Input id={id} type="number" value={typeof current === "number" && !Number.isNaN(current) ? current : ""} onChange={(e) => edit(f.key, e.target.value === "" ? NaN : Number(e.target.value))} />
                ) : f.secret ? (
                  <Input id={id} type="password" autoComplete="off" value={String(draft[f.key] ?? "")} placeholder={f.isSet ? "Set. Type to replace it." : "Not set"} onChange={(e) => edit(f.key, e.target.value)} />
                ) : (
                  <Input id={id} value={String(current ?? "")} onChange={(e) => edit(f.key, e.target.value)} />
                )}
                {f.description === null ? null : <p className="text-xs text-muted-foreground">{f.description}</p>}
              </div>
            );
          })}
        </section>
      ))}
      {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || changed.length === 0 || invalid}>Save</Button>
        {changed.length > 0 ? <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft({})}>Discard</Button> : null}
        <Button type="button" variant="outline" disabled={checking || busy} onClick={() => void check()}>{checking ? "Checking…" : "Check accounts"}</Button>
        <span role="status" className="text-xs text-muted-foreground">
          {saved ? "Saved, applied now." : changed.length > 0 ? `${changed.length} unsaved ${changed.length === 1 ? "change" : "changes"}` : ""}
        </span>
      </div>
      {status === null ? null : (
        <ul className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
          {status.providers.map((p) => (
            <li key={p.id} className="flex flex-col gap-1">
              <span><strong>{p.label}</strong> {p.ok ? <span className="text-success">signed in</span> : <span className="text-destructive-text">not signed in</span>}</span>
              <span className="text-xs text-muted-foreground">{p.detail}</span>
              {p.ok || p.loginHint === "" ? null : (
                <span className="text-xs">Sign in by running this in a terminal: <code className="select-all rounded bg-muted/40 px-1 py-0.5 font-mono">{p.loginHint}</code></span>
              )}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** Global scope, as a section of the Settings page. */
export function GlobalConfig() {
  return <ScopedConfig campaignId={null} />;
}
