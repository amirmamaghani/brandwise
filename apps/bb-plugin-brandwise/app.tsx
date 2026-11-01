// bb-plugin-brandwise — frontend entry. React and the SDK come from the host.
// Surfaces: Calendar (full-surface calendar + approval sidebar, see calendar.tsx), Creatives, Video and
// Campaigns pages, a pending-approval badge, and a homepage section listing what waits for a human.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, experimental_THREAD_ACTION_GROUPS, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { CalendarEntry, Creative, ModeView, Campaign, rpcContract } from "./server";
import { ScreenAgentTab } from "./agent-tab";
import { SCREENS } from "./agents";
import { VideoPage } from "./video-page";
import { EmailPage } from "./email-page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ApprovalsSidebar, CalendarPage, tookPlace, useCalendar } from "./calendar";
import { ResultsPage } from "./results";
import { GlobalConfig, ScopedConfig } from "./scoped-config";
import { SettingsPage, SettingsSection, SettingsSidebar, addSettingsSection } from "./settings";

function usePendingBadge() {
  const { entries } = useCalendar();
  const count = entries?.filter((e) => e.status === "pending_approval" && !tookPlace(e)).length ?? 0;
  return count > 0 ? { count, label: `${count} waiting for approval` } : null;
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  pending_approval: "text-warning-text",
  approved: "text-success",
  cancelled: "text-muted-foreground line-through",
  failed: "text-destructive-text",
};

function EntryRow({
  entry,
  onDecide,
}: {
  entry: CalendarEntry;
  onDecide: (decision: "approve" | "cancel") => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <span className="w-36 shrink-0 font-mono text-xs text-muted-foreground">
        {entry.scheduledAt.slice(0, 16).replace("T", " ")}
      </span>
      <span className="w-20 shrink-0 text-xs">{entry.channel}</span>
      <span className="w-28 shrink-0 truncate text-xs text-muted-foreground" title={entry.campaignName}>
        {entry.campaignName}
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">T{entry.tier}</span>
      <span className={cn("w-32 shrink-0 text-xs", STATUS_STYLE[entry.status])}>
        {entry.status.replace("_", " ")}
      </span>
      {entry.status === "pending_approval" ? (
        <Button size="sm" onClick={() => onDecide("approve")}>
          Approve
        </Button>
      ) : null}
      {entry.status !== "cancelled" && entry.status !== "published" ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label={`Cancel "${entry.title}"`}
          onClick={() => onDecide("cancel")}
        >
          <Icon name="X" className="size-4" />
        </Button>
      ) : null}
    </li>
  );
}

const CREATIVE_STATUSES = ["draft", "linted", "approved", "archived"];
const MAX_UPLOAD_MB = 8;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** File -> base64 without the data: prefix (the RPC carries JSON, not multipart). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

const kb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "approved" || status === "published"
      ? "text-success"
      : status === "archived"
        ? "text-muted-foreground"
        : status === "linted"
          ? "text-foreground"
          : "text-warning-text";
  return (
    <span className={cn("rounded-full border border-border bg-background/90 px-2 py-0.5 text-[11px] font-medium backdrop-blur", tone)}>
      {status}
    </span>
  );
}

function useCreatives() {
  const rpc = useRpc<typeof rpcContract>();
  const [creatives, setCreatives] = useState<Creative[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("creatives_list").then((r) => {
      setCreatives(r.creatives);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
    rpc.call("campaigns_list").then((r) => setCampaigns(r.campaigns), report);
  }, [rpc, refetch, report]);
  useRealtime("assets-changed", refetch);
  return { rpc, creatives, campaigns, error, setError, report, refetch };
}

/** One tile of the grid: the whole tile opens the preview. */
function CreativeTile({ creative, onOpen }: { creative: Creative; onOpen: () => void }) {
  const isVideo = creative.mime.startsWith("video/");
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition hover:border-foreground/30 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
        creative.status === "archived" && "opacity-60",
      )}
      aria-label={`Open ${creative.name}`}
    >
      <div className="relative flex aspect-[4/5] items-center justify-center bg-muted/40">
        {failed ? (
          <div className="flex flex-col items-center gap-1 px-4 text-center text-xs text-muted-foreground">
            <Icon name={isVideo ? "Film" : "Image"} className="size-6" />
            {kb(creative.bytes)}, open to preview
          </div>
        ) : (
          <img src={creative.thumb} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-contain" />
        )}
        {isVideo ? <span className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-background/90 backdrop-blur"><Icon name="Play" className="size-4" /></span> : null}
        <div className="absolute left-2 top-2"><StatusBadge status={creative.status} /></div>
        {creative.aiGenerated ? (
          <span className="absolute right-2 top-2 rounded-full border border-border bg-background/90 px-2 py-0.5 text-[11px] font-medium backdrop-blur">AI</span>
        ) : null}
      </div>
      <div className="min-w-0 space-y-0.5 p-3">
        <div className="truncate text-sm font-medium group-hover:underline" title={creative.name}>{creative.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {creative.campaignName} · {creative.origin} · {kb(creative.bytes)}
        </div>
      </div>
    </button>
  );
}

function PreviewDialog({
  items,
  index,
  onIndex,
  onChanged,
  onError,
}: {
  items: Creative[];
  index: number | null;
  onIndex: (i: number | null) => void;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const current = index === null ? null : (items[index] ?? null);
  const [full, setFull] = useState<{ id: string; dataUri: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);

  // new item: reset the panel and fetch the full-size image when the list only had a placeholder
  useEffect(() => {
    setEditing(false);
    setConfirming(false);
    setLoadError(null);
    setName(current?.name ?? "");
    if (current === null || current.dataUri !== null) return;
    let live = true;
    rpc.call("creatives_full", { id: current.id }).then(
      (r) => live && setFull({ id: current.id, dataUri: r.dataUri }),
      (c) => live && setLoadError(c instanceof Error ? c.message : String(c)),
    );
    return () => {
      live = false;
    };
  }, [current?.id, current?.dataUri, rpc]);

  const go = useCallback(
    (delta: number) => index !== null && items.length > 0 && onIndex((index + delta + items.length) % items.length),
    [index, items.length, onIndex],
  );
  useEffect(() => {
    if (current === null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, go]);

  const src = current === null ? null : (current.dataUri ?? (full?.id === current.id ? full.dataUri : null));
  const save = async () => {
    setEditing(false);
    if (current === null || name.trim() === "" || name === current.name) return setName(current?.name ?? "");
    try {
      await rpc.call("creatives_update", { id: current.id, name });
      onChanged();
    } catch (cause) {
      setName(current.name);
      onError(cause);
    }
  };

  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && onIndex(null)}>
      <DialogContent className="h-[90vh] w-[96vw] max-w-[96rem] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 md:grid-cols-[minmax(0,1fr)_21rem]">
        {current === null ? null : (
          <>
            <div className="relative flex min-h-0 items-center justify-center bg-muted/40 p-4">
              {src !== null && current.mime.startsWith("video/") ? (
                <video src={src} controls autoPlay muted loop playsInline className="max-h-full max-w-full object-contain" />
              ) : src !== null ? (
                <img src={src} alt={current.name} className="max-h-full max-w-full object-contain" />
              ) : loadError !== null ? (
                <p role="alert" className="max-w-sm text-center text-sm text-destructive">{loadError}</p>
              ) : (
                <p className="text-sm text-muted-foreground">Loading preview…</p>
              )}
              {items.length > 1 ? (
                <>
                  <Button variant="secondary" size="icon" className="absolute left-3 top-1/2 size-9 -translate-y-1/2 rounded-full" aria-label="Previous" onClick={() => go(-1)}>
                    <Icon name="ChevronLeft" className="size-5" />
                  </Button>
                  <Button variant="secondary" size="icon" className="absolute right-3 top-1/2 size-9 -translate-y-1/2 rounded-full" aria-label="Next" onClick={() => go(1)}>
                    <Icon name="ChevronRight" className="size-5" />
                  </Button>
                  <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background/90 px-3 py-1 text-xs backdrop-blur">
                    {(index ?? 0) + 1} / {items.length}
                  </span>
                </>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-t border-border p-5 md:border-l md:border-t-0">
              <DialogDescription className="sr-only">Creative preview and details</DialogDescription>
              {editing ? (
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={save}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setName(current.name);
                      setEditing(false);
                    }
                  }}
                  aria-label="Creative name"
                />
              ) : (
                <DialogTitle className="pr-6 text-base leading-snug">
                  <button type="button" className="text-left hover:underline" title="Click to rename" onClick={() => setEditing(true)}>
                    {current.name}
                  </button>
                </DialogTitle>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Campaign</dt><dd className="truncate">{current.campaignName}</dd>
                <dt className="text-muted-foreground">Origin</dt><dd>{current.origin}{current.aiGenerated ? " · AI-generated" : ""}</dd>
                <dt className="text-muted-foreground">Size</dt><dd>{kb(current.bytes)}</dd>
                <dt className="text-muted-foreground">Dimensions</dt><dd>{current.width && current.height ? `${current.width} × ${current.height}` : "—"}</dd>
                <dt className="text-muted-foreground">Added</dt><dd>{current.createdAt.slice(0, 16).replace("T", " ")}</dd>
              </dl>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Status</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={current.status}
                  onChange={(e) =>
                    rpc.call("creatives_update", { id: current.id, status: e.target.value as "draft" }).then(onChanged, onError)
                  }
                >
                  {[...new Set([...CREATIVE_STATUSES, current.status])].map((st) => (
                    <option key={st} value={st} disabled={!CREATIVE_STATUSES.includes(st)}>{st}</option>
                  ))}
                </select>
              </label>
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                {src !== null ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={src} download={current.name}>
                      <Icon name="Download" className="size-4" /> Download
                    </a>
                  </Button>
                ) : null}
                {confirming ? (
                  <>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        const gone = current.id;
                        rpc.call("creatives_delete", { id: gone }).then(() => {
                          onIndex(items.length <= 1 ? null : Math.min(index ?? 0, items.length - 2));
                          onChanged();
                        }, (c) => { setConfirming(false); onError(c); });
                      }}
                    >
                      Delete for good?
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setConfirming(true)}>
                    <Icon name="Trash2" className="size-4" /> Delete
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreativesTab() {
  const { rpc, creatives, campaigns, error, setError, report, refetch } = useCreatives();
  const [query, setQuery] = useState("");
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState<"newest" | "oldest" | "name">("newest");
  const [uploadCampaign, setUploadCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    setUploadCampaign((current) => current || campaigns[0]?.id || "");
  }, [campaigns]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (creatives ?? []).filter(
      (c) =>
        (campaignFilter === "all" || c.campaignId === campaignFilter) &&
        (statusFilter === "all" || c.status === statusFilter) &&
        (q === "" || c.name.toLowerCase().includes(q)),
    );
    const by = { newest: (a: Creative, b: Creative) => b.createdAt.localeCompare(a.createdAt), oldest: (a: Creative, b: Creative) => a.createdAt.localeCompare(b.createdAt), name: (a: Creative, b: Creative) => a.name.localeCompare(b.name) };
    return [...list].sort(by[sort]);
  }, [creatives, query, campaignFilter, statusFilter, sort]);

  const upload = async (files: FileList | File[] | null) => {
    const images = Array.from(files ?? []).filter((f) => IMAGE_TYPES.includes(f.type));
    if (images.length === 0 || uploadCampaign === "") return;
    setBusy(true);
    setError(null);
    try {
      for (const file of images) {
        if (file.size > MAX_UPLOAD_MB * 1e6) throw new Error(`${file.name} is over ${MAX_UPLOAD_MB} MB`);
        await rpc.call("creatives_upload", { campaignId: uploadCampaign, filename: file.name, dataBase64: await readBase64(file) });
      }
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  const select = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  const filtered = shown.length !== (creatives?.length ?? 0);
  return (
    <div
      className="relative"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <Input className="h-9 w-56" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" aria-label="Search creatives" />
        <select className={select} value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} aria-label="Filter by campaign">
          <option value="all">All campaigns</option>
          {campaigns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className={select} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {CREATIVE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={select} value={sort} onChange={(e) => setSort(e.target.value as "newest")} aria-label="Sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name</option>
        </select>
        <span className="text-xs text-muted-foreground">{filtered ? `${shown.length} of ${creatives?.length ?? 0}` : `${shown.length}`} creatives</span>
        <div className="ml-auto flex items-center gap-2">
          <select className={cn(select, "max-w-44")} value={uploadCampaign} onChange={(e) => setUploadCampaign(e.target.value)} aria-label="Campaign for uploads" title="Uploads go to this campaign">
            {campaigns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className={cn("inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground", (busy || uploadCampaign === "") && "pointer-events-none opacity-50")}>
            <Icon name="Upload" className="size-4" />
            {busy ? "Uploading…" : "Upload"}
            <input
              type="file"
              multiple
              accept={IMAGE_TYPES.join(",")}
              className="sr-only"
              disabled={busy || uploadCampaign === ""}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {error === null ? null : <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4">
        {creatives === null ? (
          <EmptyState>Loading creatives…</EmptyState>
        ) : creatives.length === 0 ? (
          <EmptyState>
            No creatives yet. Drop images here or press Upload, or run <code>bb brandwise assets add &lt;file&gt;</code>.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState>Nothing matches these filters.</EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] gap-4">
            {shown.map((c, i) => <CreativeTile key={c.id} creative={c} onOpen={() => setOpen(i)} />)}
          </div>
        )}
      </div>
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-ring bg-background/80 text-sm font-medium">
          Drop images to upload to the selected campaign
        </div>
      ) : null}
      <PreviewDialog items={shown} index={open} onIndex={setOpen} onChanged={refetch} onError={report} />
    </div>
  );
}

/** Injects the active mode's CSS (host UI that has no setting to switch it off). Renders nothing when the mode has no CSS. */
function ModeStyles() {
  const rpc = useRpc<typeof rpcContract>();
  const [css, setCss] = useState("");
  const refetch = useCallback(() => {
    rpc.call("mode_get").then((m) => setCss(m.css), () => setCss(""));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("mode-changed", refetch);
  return css === "" ? null : <style>{css}</style>;
}

/** Settings switch for the display mode. The server only offers the modes the operator allows (BW_MODES). */
function ModeSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<ModeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("mode_get").then(setView, report);
  }, [rpc, report]);
  useEffect(refetch, [refetch]);
  useRealtime("mode-changed", refetch);
  if (view === null) return error === null ? <EmptyState>Loading…</EmptyState> : <p role="alert" className="text-sm text-destructive">{error}</p>;
  const choose = async (mode: string) => {
    setBusy(true);
    setError(null);
    try {
      setView(await rpc.call("mode_set", { mode }));
    } catch (cause) {
      // the host reloads this plugin while the mode is applied, which can cut the reply short: look again before reporting
      await new Promise((r) => setTimeout(r, 2500));
      const now = await rpc.call("mode_get").catch(() => null);
      if (now !== null) setView(now);
      if (now === null || now.mode !== mode) report(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Display mode">
        {view.allowed.map((m) => (
          <Button
            key={m.name}
            role="radio"
            aria-checked={view.mode === m.name}
            variant={view.mode === m.name ? "secondary" : "ghost"}
            size="sm"
            disabled={busy || view.locked}
            onClick={() => view.mode !== m.name && void choose(m.name)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{view.description}</p>
      {view.locked ? <p className="text-xs text-muted-foreground">Locked by the operator (BW_MODES).</p> : null}
      {view.mode !== "full" ? (
        <p className="text-xs text-muted-foreground">
          Plugins, Skills and developer tools are hidden in this mode. Switch to Full to manage them.
        </p>
      ) : null}
      {view.lastChanges.length > 0 ? (
        <p className="text-xs text-muted-foreground">Last switch: {view.lastChanges.join(", ")}</p>
      ) : null}
      {view.error !== null ? <p role="alert" className="text-sm text-destructive">{view.error}</p> : null}
      {error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/** Same frame as BB's own nav-panel pages: scrolling page, centered column. */
function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto box-border w-full px-4 pb-6 pt-3 md:pt-4", wide ? "max-w-[120rem] md:px-6" : "max-w-4xl md:px-5")}>{children}</div>
    </div>
  );
}

function CreativesPage() {
  return (
    <Page wide>
      <CreativesTab />
    </Page>
  );
}

/** Chat renderer for `::creative{ids="<asset id>,..."}` (or `id=`): the same tiles and preview as the Creatives page. */
function CreativeDirective({ attributes }: { attributes: Readonly<Record<string, string>> }) {
  const rpc = useRpc<typeof rpcContract>();
  const key = (attributes.ids ?? attributes.id ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12).join(",");
  const [items, setItems] = useState<Creative[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("creatives_get", { ids: key === "" ? [] : key.split(",") }).then((r) => {
      setItems(r.creatives);
      setError(null);
    }, report);
  }, [rpc, key, report]);
  useEffect(refetch, [refetch]);
  useRealtime("assets-changed", refetch);
  if (error !== null) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (items === null) return <p className="text-sm text-muted-foreground">Loading creatives…</p>;
  if (items.length === 0) return <EmptyState>Creative not found: {key || "no id given"}</EmptyState>;
  return (
    <>
      <div className="my-2 flex flex-wrap gap-3">
        {items.map((creative, i) => (
          <div key={creative.id} className="w-56"><CreativeTile creative={creative} onOpen={() => setOpen(i)} /></div>
        ))}
      </div>
      <PreviewDialog items={items} index={open} onIndex={setOpen} onChanged={refetch} onError={report} />
    </>
  );
}

function PendingApprovals() {
  const { rpc, entries, report, refetch } = useCalendar();
  const pending = entries?.filter((e) => e.status === "pending_approval" && !tookPlace(e)) ?? [];
  if (pending.length === 0) return null;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
      {pending.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          onDecide={(decision) =>
            rpc.call("calendar_decide", { id: entry.id, decision }).then(refetch, report)
          }
        />
      ))}
    </ul>
  );
}

// --- Campaigns: link bb threads to campaigns without touching bb's own thread list ---

/** Set by the hooks below so thread-action handlers (plain functions, no hooks) can reach the plugin RPC. */
let rpcClient: ReturnType<typeof useRpc<typeof rpcContract>> | null = null;

type ThreadCampaigns = { map: Record<string, string>; campaigns: Campaign[] };

/** thread -> campaign for the given threads plus all campaigns; refreshed over realtime. */
function useThreadCampaigns(threadIds: readonly string[]): ThreadCampaigns {
  const rpc = useRpc<typeof rpcContract>();
  rpcClient = rpc;
  const [state, setState] = useState<ThreadCampaigns>({ map: {}, campaigns: [] });
  const key = threadIds.join(",");
  const refetch = useCallback(() => {
    Promise.all([rpc.call("thread_campaigns", { threadIds: threadIds.slice(0, 200) as string[] }), rpc.call("campaigns_list")]).then(
      ([m, c]) => setState({ map: m.map, campaigns: c.campaigns }),
      () => {},
    );
  }, [rpc, key]);
  useEffect(refetch, [refetch]);
  useRealtime("thread-campaign-changed", refetch);
  useRealtime("campaigns-changed", refetch);
  return state;
}

/** Bases first, each followed by its campaigns. */
function ordered(campaigns: Campaign[]): Campaign[] {
  const bases = campaigns.filter((c) => c.parentId === null);
  return bases.flatMap((b) => [b, ...campaigns.filter((c) => c.parentId === b.id)]);
}

function assignCampaign(threadId: string, campaignId: string | null) {
  return rpcClient?.call("thread_set_campaign", { threadId, campaignId }).then(() => undefined);
}

function CampaignBadge({ thread, data }: { thread: { id: string }; data: ThreadCampaigns | undefined }) {
  const campaign = data?.campaigns.find((c) => c.id === data.map[thread.id]);
  if (!campaign) return null;
  return (
    <span
      className="inline-flex max-w-28 items-center gap-1 truncate rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground"
      title={`Campaign: ${campaign.name}`}
    >
      <Icon name="brandwise/campaign" className="size-2.5 shrink-0" />
      <span className="truncate">{campaign.name}</span>
    </span>
  );
}

/** Sidebar of the Campaigns page: threads grouped by campaign ("by campaign" without replacing bb's thread list). */
function CampaignsSidebar() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [data, setData] = useState<{ threads: ThreadRow[]; unassigned: number } | null>(null);
  const refetch = useCallback(() => {
    rpc.call("campaigns_list").then((r) => setCampaigns(r.campaigns), () => {});
    rpc.call("campaign_threads").then(setData, () => {});
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("thread-campaign-changed", refetch);
  useRealtime("campaigns-changed", refetch);
  const list = ordered(campaigns);
  return (
    <nav aria-label="Threads by campaign" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2 text-sm">
      {list.length === 0 ? <p className="px-2 text-xs text-muted-foreground">No campaigns yet.</p> : null}
      {list.map((c) => {
        const threads = (data?.threads ?? []).filter((t) => t.campaignId === c.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return (
          <section key={c.id} className={cn(c.parentId !== null && "ml-3")}>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left font-medium hover:bg-accent"
              onClick={() => navigate.toPluginPanel("campaigns", { subPath: c.id })}
            >
              <Icon name="brandwise/campaign" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{c.name}</span>
              <span className="ml-auto text-xs font-normal text-muted-foreground">{threads.length}</span>
            </button>
            <ul className="mt-0.5 space-y-0.5">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="block w-full truncate rounded-md px-2 py-1 pl-6 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={t.title}
                    onClick={() => navigate.toThread(t.id)}
                  >
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {data !== null && data.unassigned > 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          {data.unassigned} thread{data.unassigned === 1 ? "" : "s"} without a campaign. Use Campaign in a thread's menu.
        </p>
      ) : null}
    </nav>
  );
}
type ThreadRow = { id: string; title: string; campaignId: string | null; updatedAt: string; status: string };

function CampaignsPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [rows, setRows] = useState<Overview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"always_on" | "campaign">("campaign");
  const [parentId, setParentId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("campaigns_overview").then((r) => {
      setRows(r.campaigns);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(refetch, [refetch]);
  for (const channel of ["campaigns-changed", "thread-campaign-changed", "calendar-changed", "assets-changed"]) useRealtime(channel, refetch); // eslint-disable-line react-hooks/rules-of-hooks
  const bases = (rows ?? []).filter((c) => c.parentId === null);
  useEffect(() => {
    setParentId((cur) => cur || bases[0]?.id || "");
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = ordered(rows ?? []) as Overview[];
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await rpc.call("campaign_add", {
        name, kind, parentId: kind === "campaign" ? parentId || null : null, startsAt: kind === "campaign" && from ? from : null, endsAt: kind === "campaign" && to ? to : null,
      });
      setName("");
      refetch();
    } catch (cause) {
      report(cause);
    }
  };
  const field = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <Page>
      <p className="text-sm text-muted-foreground">
        An always-on base holds a brand's or product's permanent look. Campaigns are time-bound runs under it. Link a thread to a
        campaign from its menu (Campaign), and the sidebar groups threads by campaign.
      </p>
      <form onSubmit={add} className="mt-4 flex flex-wrap items-center gap-2">
        <Input className="min-w-48 flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" aria-label="Name" />
        <select className={field} value={kind} onChange={(e) => setKind(e.target.value as "campaign")} aria-label="Kind">
          <option value="campaign">Campaign</option>
          <option value="always_on">Always-on base</option>
        </select>
        {kind === "campaign" ? (
          <>
            <select className={cn(field, "max-w-44")} value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Always-on base">
              {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <Input className="w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <Input className="w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </>
        ) : null}
        <Button type="submit" disabled={name.trim() === "" || (kind === "campaign" && parentId === "")}>
          <Icon name="Plus" className="size-4" /> Add
        </Button>
      </form>
      {error === null ? null : <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 overflow-hidden rounded-lg border border-border">
        {rows === null ? (
          <EmptyState>Loading campaigns…</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="px-3 py-2 font-medium">Campaign</th><th className="px-3 py-2 font-medium">Period</th><th className="px-3 py-2 text-right font-medium">Threads</th><th className="px-3 py-2 text-right font-medium">Calendar</th><th className="px-3 py-2 text-right font-medium">Creatives</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((c) => (
                <tr key={c.id} className={cn(subPath === c.id && "bg-accent/60")}>
                  <td className={cn("px-3 py-2", c.parentId !== null && "pl-8")}>
                    <button type="button" className="font-medium hover:underline" onClick={() => navigate.toPluginPanel("campaigns", { subPath: c.id })}>{c.name}</button>
                    <span className="ml-2 text-xs text-muted-foreground">{c.kind === "always_on" ? "always-on" : "campaign"}</span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{c.startsAt ? `${c.startsAt} – ${c.endsAt ?? "…"}` : "no end"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.threads}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.entries}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.creatives}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {list.some((c) => c.id === subPath) ? (
        <section className="mt-8 max-w-2xl" aria-label="Campaign settings">
          <h2 className="text-base font-semibold">Settings: {list.find((c) => c.id === subPath)?.name}</h2>
          <div className="mt-4"><ScopedConfig campaignId={subPath} /></div>
        </section>
      ) : (
        <p className="mt-6 text-xs text-muted-foreground">Select a campaign to set its provider, account and limits. They override its always-on base and the global settings.</p>
      )}
    </Page>
  );
}
type Overview = Campaign & { threads: number; entries: number; creatives: number };

/** A command block with a Copy button. */
function CopyBlock({ label, text, note }: { label: string; text: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
    else {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      done();
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{text}</pre>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** Settings section: everything needed to connect Claude Code to this instance over MCP, ready to paste. */
function McpSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("mcp_info").then(setInfo, (c) => setError(c instanceof Error ? c.message : String(c)));
  }, [rpc]);
  if (error !== null) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (info === null) return <EmptyState>Loading…</EmptyState>;
  const name = "bb-marketing";
  const env = `export BB_SERVER_URL=${info.serverUrl}${info.daemonPort ? ` BB_HOST_DAEMON_PORT=${info.daemonPort}` : ""}`;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        MCP server status: <strong className={info.enabled ? "text-success" : "text-warning-text"}>{info.enabled ? info.status : "off"}</strong>.
        {info.enabled ? " Paste the commands below into a terminal or into Claude Code." : " Turn it on first (command below), then connect."}
      </p>
      {info.enabled ? null : <CopyBlock label="Turn the MCP server on" text={`${env}\nbb plugin enable bb--mcp`} />}
      <CopyBlock
        label="1. Add this instance to Claude Code (this Mac)"
        text={`claude mcp add --transport http ${name} ${info.localUrl}`}
        note="Available in the current project. To have it in every project, add --scope user right after 'claude mcp add'."
      />
      <CopyBlock
        label="Same, for every project"
        text={`claude mcp add --transport http --scope user ${name} ${info.localUrl}`}
      />
      <CopyBlock
        label="Or as a shared file: .mcp.json in the project root"
        text={JSON.stringify({ mcpServers: { [name]: { type: "http", url: info.localUrl } } }, null, 2)}
      />
      <CopyBlock
        label="2. Check it"
        text={`claude mcp list\nclaude mcp get ${name}`}
        note="Inside Claude Code, /mcp shows the connection and its tools: search, read and run."
      />
      <CopyBlock
        label="3. First prompt to try in Claude Code"
        text={`Use the ${name} MCP server. First call search to find the brandwise commands, then list the campaigns and the calendar.`}
      />
      <CopyBlock
        label="A snippet for the run tool"
        text={`const campaigns = await bb.json(["brandwise", "campaign", "list", "--json"]);\nconst calendar = await bb.json(["brandwise", "calendar", "list", "--json"]);\nreturn { campaigns, calendar };`}
        note="Plugin commands only work through run (read accepts bb's own read-only commands). Claude will usually ask before it runs."
      />
      <CopyBlock
        label="Terminal helpers for this instance"
        text={`${env}\nbb mcp status\nbb brandwise campaign list\nbb brandwise calendar list\nbb plugin disable bb--mcp   # switch MCP off\nbb plugin enable bb--mcp    # and on again\nclaude mcp remove ${name}   # forget it in Claude Code`}
      />
      {info.tailnetUrl !== null ? (
        <CopyBlock
          label="From another device in your tailnet"
          text={`claude mcp add --transport http ${name}-tailnet ${info.tailnetUrl}`}
          note="This address is open to every device in your tailnet without a sign-in."
        />
      ) : null}
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        An app connected over MCP can run any bb command, including terminals on this Mac. Access is all or nothing, and the calendar rule
        that agents never approve is only a convention. Connect clients you trust only.
      </p>
    </div>
  );
}
type McpInfo = { enabled: boolean; status: string; localUrl: string; serverUrl: string; daemonPort: string | null; tailnetUrl: string | null };

// Sections with their own interface: the Settings page navigation (sidebar page and bb's plugin page) shows them next to the plain fields.
addSettingsSection({ id: "providers", title: "Providers", description: "Which provider generates creatives, with which account, and the limits. These are the global defaults; a campaign overrides them on its page under Campaigns.", component: GlobalConfig });
addSettingsSection({ id: "display", title: "Display", description: "How much of bb's own interface is shown next to the BrandWise.", component: ModeSettings });
addSettingsSection({ id: "connect", title: "Connect Claude Code", description: "Commands to paste into Claude Code or a terminal. Uses this instance's real addresses (MCP).", component: McpSettings });

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "calendar",
    title: "Calendar",
    icon: "brandwise/calendar",
    path: "calendar",
    component: CalendarPage,
    experimental_sidebar: ApprovalsSidebar,
    experimental_useBadge: usePendingBadge,
  });
  app.slots.navPanel({
    id: "creatives",
    title: "Creatives",
    icon: "brandwise/creatives",
    path: "creatives",
    component: CreativesPage,
  });
  app.slots.navPanel({
    id: "video",
    title: "Video",
    icon: "brandwise/video",
    path: "video",
    component: VideoPage,
  });
  app.slots.navPanel({
    id: "email",
    title: "E-mail",
    icon: "brandwise/email",
    path: "email",
    component: EmailPage,
  });
  app.slots.navPanel({
    id: "results",
    title: "Results",
    icon: "brandwise/results",
    path: "results",
    component: ResultsPage,
  });
  // "Start agent" in the side panel of every page above: the tab reads the page's route, so the agent knows where the user is
  for (const screen of SCREENS) {
    app.slots.experimental_tab({
      id: "agent",
      context: { kind: "nav-panel", panelId: screen },
      availability: "action",
      title: "Start agent",
      icon: "Sparkles",
      component: (props) => <ScreenAgentTab screen={screen} subPath={props.subPath} />,
    });
  }
  app.slots.messageDirective({ id: "creative", component: CreativeDirective });
  app.slots.navPanel({
    id: "campaigns",
    title: "Campaigns",
    icon: "brandwise/campaign",
    path: "campaigns",
    component: CampaignsPage,
    experimental_sidebar: CampaignsSidebar,
  });
  app.slots.navPanel({
    id: "settings",
    title: "Settings",
    icon: "brandwise/settings",
    path: "settings",
    component: SettingsPage,
    experimental_sidebar: SettingsSidebar,
  });
  // In every thread's menu (also the sidebar row menu): Campaign > pick one. Lives in bb's "organize" group.
  app.slots.experimental_threadAction<ThreadCampaigns>({
    id: "campaign",
    title: "Campaign",
    icon: "brandwise/campaign",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    order: 50,
    useData: ({ threadIds }) => useThreadCampaigns(threadIds),
    item: ({ thread, data }) => {
      if (data.campaigns.length === 0) return null;
      const current = data.map[thread.id];
      return {
        label: "Campaign",
        detail: data.campaigns.find((c) => c.id === current)?.name ?? "None",
        icon: "brandwise/campaign",
        choices: {
          items: [
            { id: "__none__", label: "No campaign", selected: current === undefined },
            ...ordered(data.campaigns).map((c) => ({ id: c.id, label: c.parentId ? `· ${c.name}` : c.name, selected: c.id === current })),
          ],
        },
        run: ({ value }) => assignCampaign(thread.id, value === "__none__" || value === undefined ? null : value),
      };
    },
  });
  // Optional badge under the row title; bb shows it when Organize > Rows > Metadata is on (needs the threadRowMetadata experiment)
  app.slots.experimental_threadRowMetadata<ThreadCampaigns>({
    id: "campaign",
    order: 20,
    useData: ({ threads }) => useThreadCampaigns(threads.map((t) => t.id)),
    component: CampaignBadge,
  });
  app.slots.experimental_appOverlay({ id: "mode-styles", component: ModeStyles });
  // Plugins is hidden in Minimal, so the mode switch (on this plugin's detail page) needs its own way in
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "mode",
    label: "Display mode",
    icon: "SlidersHorizontal",
    onActivate: ({ openPluginDetails }) => openPluginDetails(),
  });
  // On bb's plugin page the declarative form above is flat; this section adds the sections with a navigation (also holds Display mode and MCP)
  app.slots.settingsSection({
    id: "brandwise",
    title: "BrandWise",
    description: "Settings by section. The form above lists the same values in one list.",
    component: SettingsSection,
  });
  app.slots.homepageSection({
    id: "approvals",
    title: "Waiting for approval",
    component: PendingApprovals,
  });
});
