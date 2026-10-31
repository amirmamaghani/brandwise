// The Video page: a Remotion project per campaign, edited in Remotion Studio next to an agent chat, with renders that land in Creatives.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Campaign, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Project = { campaignId: string; id: string };
type Composition = { id: string; width: number; height: number; fps: number; durationInFrames: number; defaultProps: Record<string, unknown> };
type Studio = { running: boolean; ready: boolean; port: number | null };
const NO_STUDIO: Studio = { running: false, ready: false, port: null };
const FIELD = "h-8 rounded-md border border-input bg-background px-2 text-sm";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const pretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

/** The open project lives in the route (`video/<campaign id>/<project id>`): links work, and the agent in the side panel reads the same route. */
export function VideoPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [enabled, setEnabled] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [compositions, setCompositions] = useState<Composition[] | null>(null);
  const [compId, setCompId] = useState("");
  const [propsText, setPropsText] = useState("{}");
  const [showProps, setShowProps] = useState(false);
  const [studio, setStudio] = useState<Studio>(NO_STUDIO);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCampaign, setNewCampaign] = useState("");
  const [newId, setNewId] = useState("");
  const report = useCallback((cause: unknown) => setError(message(cause)), []);
  const [routeCampaign, routeId] = subPath.split("/").map(decodeURIComponent);
  const current = useMemo<Project | null>(() => (routeCampaign && routeId ? { campaignId: routeCampaign, id: routeId } : null), [routeCampaign, routeId]);
  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  const listProjects = useCallback(() => rpc.call("video_projects").then((r) => { setEnabled(r.enabled); setProjects(r.projects); }, report), [rpc, report]);
  useEffect(() => {
    void listProjects();
    rpc.call("campaigns_list").then((r) => { setCampaigns(r.campaigns); setNewCampaign((p) => p || r.campaigns[0]?.id || ""); }, report);
  }, [rpc, listProjects, report]);

  const loadCompositions = useCallback(async (p: Project) => {
    setCompositions(null);
    try {
      const { compositions: list } = await rpc.call("video_compositions", p);
      setCompositions(list);
      setCompId(list[0]?.id ?? "");
      setPropsText(pretty(list[0]?.defaultProps));
    } catch (cause) { report(cause); setCompositions([]); }
  }, [rpc, report]);

  const open = (p: Project) => nav.toPluginPanel("video", { subPath: `${p.campaignId}/${p.id}` });
  // switching project (or arriving by link) loads that project's Studio state and compositions
  useEffect(() => {
    setResult(null); setError(null); setStudio(NO_STUDIO); setCompositions(null);
    if (!current) return;
    let live = true;
    rpc.call("video_studio", { ...current, action: "status" }).then((s) => live && setStudio(s), () => {});
    void loadCompositions(current);
    return () => { live = false; };
  }, [current, rpc, loadCompositions]);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = { campaignId: newCampaign, id: newId.trim() };
      await rpc.call("video_project_create", p);
      setNewId(""); setCreating(false);
      await listProjects();
      open(p);
    } catch (cause) { report(cause); }
  };
  const studioAction = async (action: "start" | "stop") => {
    if (!current) return;
    try { setStudio(await rpc.call("video_studio", { ...current, action })); } catch (cause) { report(cause); }
  };
  // Studio needs a few seconds to build after it starts: poll until it answers
  useEffect(() => {
    if (!current || !studio.running || studio.ready) return;
    const t = setInterval(() => void rpc.call("video_studio", { ...current, action: "status" }).then(setStudio, report), 1500);
    return () => clearInterval(t);
  }, [current, studio.running, studio.ready, rpc, report]);
  const render = async (kind: "render" | "still") => {
    if (!current) return;
    setResult(null); setError(null);
    const label = kind === "still" ? "Rendering frame" : "Rendering video";
    try {
      const props = JSON.parse(propsText);
      setBusy(label);
      const { jobId } = await rpc.call("video_render", { ...current, composition: compId || undefined, props, kind });
      for (;;) {
        const r = await rpc.call("video_collect", { jobId });
        if (r.state === "done") { setResult(`Saved to ${campaignName(current.campaignId)} (asset ${r.assetId}).`); break; }
        setBusy(`${label} ${Math.round(r.progress * 100)}%`);
        await new Promise((res) => setTimeout(res, 1500));
      }
    } catch (cause) { report(cause); } finally { setBusy(null); }
  };

  const studioUrl = studio.port === null ? null : `http://127.0.0.1:${studio.port}`;
  const comp = compositions?.find((c) => c.id === compId);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={cn(FIELD, "min-w-56")} value={current ? `${current.campaignId}/${current.id}` : ""} onChange={(e) => { const [campaignId, id] = e.target.value.split("/"); if (id) open({ campaignId, id }); }} aria-label="Project">
          <option value="">{projects.length === 0 ? "No projects yet" : "Choose a project"}</option>
          {projects.map((p) => <option key={`${p.campaignId}/${p.id}`} value={`${p.campaignId}/${p.id}`}>{campaignName(p.campaignId)} / {p.id}</option>)}
        </select>
        <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => setCreating((v) => !v)}><Icon name="Plus" className="size-4" /> New project</Button>
        {current ? (
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {studio.running ? (
              <>
                <span>{studio.ready ? `Studio on ${studioUrl}` : "Studio starting…"}</span>
                {studioUrl && studio.ready ? <a className="underline" href={studioUrl} target="_blank" rel="noreferrer">new tab</a> : null}
                <Button size="sm" variant="outline" onClick={() => void studioAction("stop")}>Stop Studio</Button>
              </>
            ) : <Button size="sm" onClick={() => void studioAction("start")}>Open Studio</Button>}
          </div>
        ) : null}
      </div>
      {creating ? (
        <form onSubmit={create} className="flex flex-wrap items-center gap-2">
          <select className={cn(FIELD, "max-w-48")} value={newCampaign} onChange={(e) => setNewCampaign(e.target.value)} aria-label="Campaign for the new project">
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Input className="h-8 w-48" value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} placeholder="new-project-id" aria-label="Project id" />
          <Button type="submit" size="sm" variant="outline" disabled={!/^[a-z0-9-]{2,48}$/.test(newId)}>Create from example</Button>
        </form>
      ) : null}
      {!enabled ? <p className="rounded-md border border-border p-2 text-sm text-muted-foreground">The video engine is not installed. Install the dependencies of packages/video-remotion and run provision.sh apply.</p> : null}
      {error ? <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/40 p-2 text-xs text-destructive" role="alert">{error}</pre> : null}

      {current === null ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">Choose or create a project. Remotion Studio opens here; \"Start agent\" in the side panel opens an agent that knows the project.</div>
      ) : (
        <>
          {studio.ready && studioUrl ? (
            <iframe title="Remotion Studio" src={studioUrl} className="min-h-0 w-full flex-1 rounded-xl border border-border bg-background" />
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">{studio.running ? "Studio is starting…" : "Open Studio to see and edit the video here."}</div>
          )}

          <div className="rounded-xl border border-border p-2">
            {showProps ? (
              <div className="mb-2 space-y-1">
                <textarea className="h-40 w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs" spellCheck={false} value={propsText} onChange={(e) => setPropsText(e.target.value)} aria-label="Props as JSON" />
                <p className="text-xs text-muted-foreground">Props override the composition's defaults. A name ending in <code>Asset</code> takes an asset id and reaches the code as the same name ending in <code>Url</code> (<code>imageAsset</code> becomes <code>imageUrl</code>).</p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Render to Creatives</span>
              {compositions === null ? <span className="text-xs text-muted-foreground">Reading compositions…</span> : (
                <select className={cn(FIELD, "min-w-44")} value={compId} onChange={(e) => { setCompId(e.target.value); setPropsText(pretty(compositions.find((c) => c.id === e.target.value)?.defaultProps)); }} aria-label="Composition">
                  {compositions.map((c) => <option key={c.id} value={c.id}>{c.id} ({c.width}x{c.height}, {(c.durationInFrames / c.fps).toFixed(1)} s)</option>)}
                </select>
              )}
              <Button size="sm" variant="ghost" aria-pressed={showProps} onClick={() => setShowProps((v) => !v)}>Props</Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void loadCompositions(current)}>Reload</Button>
              <span className="text-xs text-muted-foreground" aria-live="polite">{busy ? `${busy}…` : result}</span>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={busy !== null || !comp} onClick={() => void render("still")}>Render frame</Button>
                <Button size="sm" disabled={busy !== null || !comp} onClick={() => void render("render")}>Render video</Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
