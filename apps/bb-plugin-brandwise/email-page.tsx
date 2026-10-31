// The E-mail page: a template folder per campaign with a live preview, the lint report, a plain editor for the files and a test send.
// The agent (side panel, "Start agent") edits the same folder; the page polls the folder and shows every change as it lands.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Campaign, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Ref = { campaignId: string; id: string };
type Finding = { rule: string; severity: "error" | "warn" | "info"; message: string };
type Version = { version: number; note: string | null; createdBy: string; createdAt: string };
type Render = { html: string; subject: string; preheader: string; size: number; hash: string; findings: Finding[] };
const FILES = ["template.mjml", "template.json", "brand.json", "sample.json"];
const FIELD = "h-8 rounded-md border border-input bg-background px-2 text-sm";
const TONE = { error: "text-destructive-text", warn: "text-warning-text", info: "text-muted-foreground" } as const;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The open template lives in the route (`email/<campaign id>/<template id>`): links work, and the agent in the side panel reads the same route. */
export function EmailPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [enabled, setEnabled] = useState(true);
  const [templates, setTemplates] = useState<Ref[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [render, setRender] = useState<Render | null>(null);
  const [width, setWidth] = useState<640 | 375>(640);
  const [file, setFile] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newCampaign, setNewCampaign] = useState("");
  const [newId, setNewId] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionNote, setVersionNote] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef("");
  const report = useCallback((cause: unknown) => setError(message(cause)), []);

  const [routeCampaign, routeId] = subPath.split("/").map(decodeURIComponent);
  const current = useMemo<Ref | null>(() => (routeCampaign && routeId ? { campaignId: routeCampaign, id: routeId } : null), [routeCampaign, routeId]);
  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  const list = useCallback(() => rpc.call("email_templates").then((r) => { setEnabled(r.enabled); setTemplates(r.templates); }, report), [rpc, report]);
  useEffect(() => {
    void list();
    rpc.call("campaigns_list").then((r) => { setCampaigns(r.campaigns); setNewCampaign((p) => p || r.campaigns[0]?.id || ""); }, report);
  }, [rpc, list, report]);

  const open = (t: Ref) => nav.toPluginPanel("email", { subPath: `${t.campaignId}/${t.id}` });
  const draw = useCallback(async (t: Ref) => {
    try { setRender(await rpc.call("email_template_render", t)); setError(null); } catch (cause) { report(cause); }
  }, [rpc, report]);

  // follow the folder: the agent (or a person) changes files, the preview changes with them
  useEffect(() => {
    seen.current = "";
    setRender(null); setFile(null); setNote(null);
    if (!current) return;
    let live = true;
    const tick = () => rpc.call("email_template_state", current).then((s) => {
      if (!live || s.hash === seen.current) return;
      seen.current = s.hash;
      void draw(current);
    }, () => {});
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => { live = false; clearInterval(t); };
  }, [current, rpc, draw]);

  const loadVersions = useCallback(async (t: Ref) => { try { setVersions((await rpc.call("email_template_versions", t)).versions); } catch (cause) { report(cause); } }, [rpc, report]);
  useEffect(() => { setVersions([]); if (current) void loadVersions(current); }, [current, loadVersions]);
  const publish = async () => {
    if (!current) return;
    setBusy(true); setNote(null);
    try {
      const r = await rpc.call("email_template_publish", { ...current, note: versionNote.trim() || undefined });
      setNote(r.created ? `Published version ${r.version}` : `Nothing changed since version ${r.version}`);
      setVersionNote(""); setError(null); await loadVersions(current);
    } catch (cause) { report(cause); } finally { setBusy(false); }
  };
  const pick = async (name: string) => {
    if (!current) return;
    setFile(name); setDirty(false);
    try { setDraft((await rpc.call("email_template_file", { ...current, name })).content); } catch (cause) { report(cause); }
  };
  const save = async () => {
    if (!current || !file) return;
    setBusy(true);
    try { await rpc.call("email_template_save", { ...current, name: file, content: draft }); setDirty(false); seen.current = ""; setError(null); } catch (cause) { report(cause); } finally { setBusy(false); }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const t = { campaignId: newCampaign, id: newId.trim() };
      await rpc.call("email_template_create", t);
      setNewId(""); setCreating(false); await list(); open(t);
    } catch (cause) { report(cause); }
  };
  const sendTest = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    setBusy(true); setNote(null);
    try { const r = await rpc.call("email_template_send_test", { ...current, to }); setNote(`Sent to ${to} through ${r.provider} from ${r.from}`); setError(null); } catch (cause) { report(cause); } finally { setBusy(false); }
  };

  const counts = render ? (["error", "warn", "info"] as const).map((s) => render.findings.filter((f) => f.severity === s).length) : [0, 0, 0];
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={cn(FIELD, "min-w-56")} value={current ? `${current.campaignId}/${current.id}` : ""} onChange={(e) => { const [campaignId, id] = e.target.value.split("/"); if (id) open({ campaignId, id }); }} aria-label="Template">
          <option value="">{templates.length === 0 ? "No templates yet" : "Choose a template"}</option>
          {templates.map((t) => <option key={`${t.campaignId}/${t.id}`} value={`${t.campaignId}/${t.id}`}>{campaignName(t.campaignId)} / {t.id}</option>)}
        </select>
        <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => setCreating((v) => !v)}><Icon name="Plus" className="size-4" /> New template</Button>
        {current ? (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Preview width">
            <Button size="sm" variant={width === 640 ? "secondary" : "ghost"} onClick={() => setWidth(640)}>Desktop</Button>
            <Button size="sm" variant={width === 375 ? "secondary" : "ghost"} onClick={() => setWidth(375)}>Mobile</Button>
          </div>
        ) : null}
      </div>
      {creating ? (
        <form onSubmit={create} className="flex flex-wrap items-center gap-2">
          <select className={cn(FIELD, "max-w-48")} value={newCampaign} onChange={(e) => setNewCampaign(e.target.value)} aria-label="Campaign for the new template">
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Input className="h-8 w-48" value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} placeholder="new-template-id" aria-label="Template id" />
          <Button type="submit" size="sm" variant="outline" disabled={!/^[a-z0-9-]{2,48}$/.test(newId)}>Create from example</Button>
        </form>
      ) : null}
      {!enabled ? <p className="rounded-md border border-border p-2 text-sm text-muted-foreground">The e-mail engine is not installed. Run npm install in packages/email-engine and provision.sh apply.</p> : null}
      {error ? <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/40 p-2 text-xs text-destructive" role="alert">{error}</pre> : null}

      {current === null ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Choose or create a template. The preview opens here; "Start agent" in the side panel opens an agent that knows the template.</div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          <div className="flex min-h-0 flex-col gap-1">
            {render ? <p className="truncate text-xs text-muted-foreground" title={render.preheader}>Subject: <span className="text-foreground">{render.subject}</span> · {(render.size / 1000).toFixed(1)} KB · preview with sample content</p> : null}
            <div className="flex min-h-0 flex-1 justify-center overflow-auto rounded-xl border border-border bg-muted/40 p-2">
              {render ? <iframe title="E-mail preview" sandbox="" srcDoc={render.html} style={{ width }} className="h-full min-h-96 shrink-0 rounded-md border-0 bg-white" /> : <p className="self-center text-sm text-muted-foreground">Rendering…</p>}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-2 overflow-auto">
            <section className="rounded-xl border border-border p-2" aria-label="Checks">
              <h2 className="text-sm font-medium">Checks <span className="text-xs font-normal text-muted-foreground">{counts[0]} errors, {counts[1]} warnings, {counts[2]} hints</span></h2>
              <ul className="mt-1 space-y-1 text-xs">
                {render?.findings.map((f, i) => <li key={i} className={TONE[f.severity]}><b>{f.severity}</b> {f.rule}: {f.message}</li>)}
                {render && render.findings.length === 0 ? <li className="text-muted-foreground">No findings.</li> : null}
              </ul>
            </section>
            <section className="flex min-h-0 flex-col gap-1 rounded-xl border border-border p-2" aria-label="Files">
              <div className="flex flex-wrap gap-1">
                {FILES.map((f) => <Button key={f} size="sm" variant={file === f ? "secondary" : "ghost"} onClick={() => void pick(f)}>{f}</Button>)}
              </div>
              {file ? (
                <>
                  <textarea className="h-64 w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs" spellCheck={false} value={draft} onChange={(e) => { setDraft(e.target.value); setDirty(true); }} aria-label={file} />
                  <div className="flex items-center gap-2"><Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>Save</Button><span className="text-xs text-muted-foreground">The agent edits these files too; reload a file to see its changes.</span></div>
                </>
              ) : <p className="text-xs text-muted-foreground">Pick a file to edit it by hand.</p>}
            </section>
            <section className="flex flex-col gap-1 rounded-xl border border-border p-2" aria-label="Versions">
              <h2 className="text-sm font-medium">Versions <span className="text-xs font-normal text-muted-foreground">{versions.length === 0 ? "not published yet" : `latest v${versions[0].version}`}</span></h2>
              <p className="text-xs text-muted-foreground">Entries use a published version, which never changes. Publishing checks the sample first.</p>
              <ul className="space-y-0.5 text-xs">
                {versions.slice(0, 5).map((v) => <li key={v.version}><b>v{v.version}</b> {v.createdAt.slice(0, 16).replace("T", " ")} {v.note ?? ""}</li>)}
              </ul>
              <div className="flex items-center gap-2">
                <Input className="h-8 flex-1" value={versionNote} onChange={(e) => setVersionNote(e.target.value)} placeholder="what changed (optional)" aria-label="Version note" />
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void publish()}>Publish</Button>
              </div>
            </section>
            <form onSubmit={sendTest} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-2" aria-label="Test e-mail">
              <Input className="h-8 min-w-40 flex-1" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="send a test to…" aria-label="Test address" />
              <Button type="submit" size="sm" variant="outline" disabled={busy || to === ""}>Send test</Button>
              {note ? <span className="w-full text-xs text-muted-foreground">{note}</span> : null}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/** On the approval card of an e-mail entry made from a template: what the reader will see, exactly as it will be sent, and what lint said. */
export function EntryEmailPreview({ entryId }: { entryId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [r, setR] = useState<Awaited<ReturnType<typeof rpc.call<"email_entry_preview">>> | null>(null);
  useEffect(() => { let live = true; rpc.call("email_entry_preview", { entryId }).then((x) => live && setR(x), () => {}); return () => { live = false; }; }, [rpc, entryId]);
  if (!r || !r.bound) return null;
  const errors = r.findings.filter((f) => f.severity === "error").length, warns = r.findings.filter((f) => f.severity === "warn").length;
  return (
    <details className="rounded-md border border-border p-2" open>
      <summary className="cursor-pointer text-sm font-medium">E-mail preview <span className="text-xs font-normal text-muted-foreground">template {r.template} v{r.version}, {r.locale}, {errors} errors, {warns} warnings</span></summary>
      <p className="mt-1 text-xs text-muted-foreground">Subject: <span className="text-foreground">{r.subject}</span></p>
      <iframe title="E-mail preview" sandbox="" srcDoc={r.html} className="mt-1 h-80 w-full rounded-md border border-border bg-white" />
      <ul className="mt-1 space-y-0.5 text-xs">
        {r.findings.filter((f) => f.severity !== "info").map((f, i) => <li key={i} className={TONE[f.severity]}><b>{f.severity}</b> {f.rule}: {f.message}</li>)}
      </ul>
    </details>
  );
}
