// Calendar page of the BrandWise: a full-surface month/week calendar, and the approval queue as the
// page's sidebar. The calendar is the only way anything leaves the system (docs/architecture.md), so
// "what waits for me" stays visible next to it and a decision is one click (tier 2) or a review (tier 3).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { CalendarEntry, Campaign, Creative, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EntryEmailPreview } from "./email-page";

export const CHANNELS = ["instagram", "facebook", "linkedin", "tiktok", "email", "web"];

export function useCalendar() {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("calendar_list").then((r) => {
      setEntries(r.entries);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  // server.ts publishes after every write (UI, CLI or agent), so the page never goes stale
  useRealtime("calendar-changed", refetch);
  return { rpc, entries, error, report, refetch };
}

// --- dates: everything is shown in local time, weeks start on Monday ---

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const whenOf = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const toLocalInput = (d: Date) => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const at9 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0);

// --- state shared by the page and its sidebar (two separate React trees in bb's slots) ---

type Shared = { openId: string | null; mode: "view" | "changes"; day: Date | null };
let shared: Shared = { openId: null, mode: "view", day: null };
const listeners = new Set<() => void>();
function setShared(patch: Partial<Shared>) {
  shared = { ...shared, ...patch };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const useShared = () => useSyncExternalStore(subscribe, () => shared);
const openEntry = (e: CalendarEntry, mode: Shared["mode"] = "view", jump = false) =>
  setShared({ openId: e.id, mode, ...(jump ? { day: new Date(e.scheduledAt) } : {}) });
const closeEntry = () => setShared({ openId: null, mode: "view" });

/** Creatives (thumbnail and preview) of the given asset ids, fetched once each. */
function useCreatives(ids: readonly string[]) {
  const rpc = useRpc<typeof rpcContract>();
  const [map, setMap] = useState<Record<string, Creative>>({});
  const key = ids.join(",");
  useEffect(() => {
    const need = ids.filter((id) => !(id in map));
    for (let i = 0; i < need.length; i += 12) {
      rpc.call("creatives_get", { ids: need.slice(i, i + 12) }).then(
        (r) => setMap((m) => ({ ...m, ...Object.fromEntries(r.creatives.map((c) => [c.id, c])) })),
        () => {},
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rpc]);
  return map;
}

// --- presentation of a status: dashed = still needs a human or the agent ---

const STATUS: Record<string, { label: string; tone: string; dashed?: boolean }> = {
  pending_approval: { label: "Needs approval", tone: "text-warning-text", dashed: true },
  changes_requested: { label: "Changes requested", tone: "text-warning-text", dashed: true },
  draft: { label: "Draft", tone: "text-muted-foreground", dashed: true },
  approved: { label: "Approved", tone: "text-success" },
  scheduled: { label: "Scheduled", tone: "text-success" },
  publishing: { label: "Publishing", tone: "text-success" },
  needs_manual: { label: "Publish by hand", tone: "text-warning-text", dashed: true },
  published: { label: "Published", tone: "text-muted-foreground" },
  failed: { label: "Failed", tone: "text-destructive-text" },
  cancelled: { label: "Cancelled", tone: "text-muted-foreground" },
};
const statusOf = (s: string) => STATUS[s] ?? { label: s, tone: "text-muted-foreground" };
const TIER_HINT: Record<number, string> = {
  1: "Tier 1, goes out automatically",
  2: "Tier 2, one click",
  3: "Tier 3, check claims, price and budget yourself",
};
/** The publish time has come (now counts). Such an entry accepts no action; the server enforces it, this only hides the buttons. */
export const tookPlace = (e: CalendarEntry) => Date.parse(e.scheduledAt) <= Date.now();
/** Cancelled, published and past entries are frozen. */
const editable = (e: CalendarEntry) => e.status !== "published" && e.status !== "cancelled" && !tookPlace(e);

function Dot({ status }: { status: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current", statusOf(status).tone)} />;
}

/** Two-step reject: a cancelled entry cannot be brought back, so the first click only arms the button. */
function RejectButton({ label = "Reject", onConfirm, className }: { label?: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      size="sm"
      variant={armed ? "destructive" : "ghost"}
      className={cn(!armed && "text-muted-foreground", className)}
      onBlur={() => setArmed(false)}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? "Sure?" : label}
    </Button>
  );
}

// --- the calendar ---

const DRAG_TYPE = "application/x-brandwise-entry";

/** Drag an entry onto another day to reschedule it (same time of day). A wrapper, because buttons do not drag everywhere. */
function Draggable({ entry, children }: { entry: CalendarEntry; children: ReactNode }) {
  return (
    <div
      className="min-w-0"
      draggable={editable(entry)}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(DRAG_TYPE, entry.id);
        ev.dataTransfer.effectAllowed = "move";
      }}
    >
      {children}
    </div>
  );
}

function MonthChip({ entry, active }: { entry: CalendarEntry; active: boolean }) {
  const st = statusOf(entry.status);
  return (
    <Draggable entry={entry}>
      <button
        type="button"
        onClick={() => openEntry(entry)}
        title={`${timeOf(entry.scheduledAt)} ${entry.title} (${entry.channel}, ${st.label})`}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded border bg-card px-1.5 py-0.5 text-left text-xs hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
          st.dashed ? "border-dashed border-foreground/40" : "border-border",
          entry.status === "published" && "opacity-70",
          entry.status === "cancelled" && "line-through opacity-60",
          active && "ring-2 ring-ring",
        )}
      >
        <Dot status={entry.status} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{timeOf(entry.scheduledAt)}</span>
        <span className="truncate">{entry.title}</span>
      </button>
    </Draggable>
  );
}

function WeekCard({ entry, active }: { entry: CalendarEntry; active: boolean }) {
  const st = statusOf(entry.status);
  return (
    <Draggable entry={entry}>
      <button
        type="button"
        onClick={() => openEntry(entry)}
        className={cn(
          "flex w-full min-w-0 flex-col gap-0.5 rounded-md border bg-card p-2 text-left text-xs hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
          st.dashed ? "border-dashed border-foreground/40" : "border-border",
          entry.status === "published" && "opacity-70",
          entry.status === "cancelled" && "line-through opacity-60",
          active && "ring-2 ring-ring",
        )}
      >
        <span className="flex items-center gap-1.5">
          <Dot status={entry.status} />
          <span className="font-mono text-[11px] text-muted-foreground">{timeOf(entry.scheduledAt)}</span>
          <span className={cn("ml-auto", st.tone)}>{st.label}</span>
        </span>
        <span className="line-clamp-2 text-sm font-medium">{entry.title}</span>
        <span className="truncate text-muted-foreground">
          {entry.channel} · {entry.campaignName}
        </span>
      </button>
    </Draggable>
  );
}

const MAX_CHIPS = 4;

export function CalendarPage() {
  const { rpc, entries, error, report, refetch } = useCalendar();
  const { openId, mode, day } = useShared();
  const [view, setView] = useState<"month" | "week">("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [creating, setCreating] = useState<Date | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // filters narrow the calendar only; the approval queue in the sidebar always shows everything that waits
  const [campaign, setCampaign] = useState("");
  const [channel, setChannel] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const campaignOptions = useMemo(() => [...new Map((entries ?? []).map((e) => [e.campaignId, e.campaignName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [entries]);
  const channelOptions = useMemo(() => [...new Set((entries ?? []).map((e) => e.channel))].sort(), [entries]);
  const filtered = campaign !== "" || channel !== "" || showCancelled;

  // the sidebar asked to show a day
  useEffect(() => {
    if (day !== null) setCursor(day);
  }, [day]);

  const today = new Date();
  const todayKey = dayKey(today);
  const first = view === "month" ? mondayOf(new Date(cursor.getFullYear(), cursor.getMonth(), 1)) : mondayOf(cursor);
  const count =
    view === "week"
      ? 7
      : Math.ceil(((new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay() + 6) % 7 + new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()) / 7) * 7;
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries ?? []) {
      if (e.status === "cancelled" && !showCancelled) continue;
      if ((campaign !== "" && e.campaignId !== campaign) || (channel !== "" && e.channel !== channel)) continue;
      const key = dayKey(new Date(e.scheduledAt));
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    for (const list of map.values()) list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return map;
  }, [entries, campaign, channel, showCancelled]);

  const step = (dir: 1 | -1) =>
    setCursor(view === "month" ? new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1) : addDays(cursor, 7 * dir));
  const title =
    view === "month"
      ? cursor.toLocaleDateString([], { month: "long", year: "numeric" })
      : `${days[0].toLocaleDateString([], { day: "numeric", month: "short" })} – ${days[6].toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`;
  const open = openId === null ? null : ((entries ?? []).find((e) => e.id === openId) ?? null);

  const drop = (target: Date, id: string) => {
    const entry = (entries ?? []).find((e) => e.id === id);
    if (entry === undefined || !editable(entry)) return;
    const was = new Date(entry.scheduledAt);
    if (dayKey(was) === dayKey(target)) return;
    const moved = new Date(target.getFullYear(), target.getMonth(), target.getDate(), was.getHours(), was.getMinutes());
    rpc.call("calendar_update", { id, scheduledAt: moved.toISOString() }).then(refetch, report);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <h1 className="mr-1 min-w-40 text-base font-semibold capitalize">{title}</h1>
        <Button variant="outline" size="icon" aria-label="Previous" onClick={() => step(-1)}>
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCursor(new Date())}>
          Today
        </Button>
        <Button variant="outline" size="icon" aria-label="Next" onClick={() => step(1)}>
          <Icon name="ChevronRight" className="size-4" />
        </Button>
        {entries === null ? <span className="text-xs text-muted-foreground">Loading…</span> : null}
        <div role="group" aria-label="Filters" className="ml-2 flex flex-wrap items-center gap-2">
          <select className={cn(SELECT, "h-8 w-auto max-w-44 text-xs")} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label="Filter by campaign">
            <option value="">All campaigns</option>
            {campaignOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select className={cn(SELECT, "h-8 w-auto max-w-36 text-xs capitalize")} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Filter by channel">
            <option value="">All channels</option>
            {channelOptions.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Cancelled
          </label>
          {filtered ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                setCampaign("");
                setChannel("");
                setShowCancelled(false);
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <div role="group" aria-label="View" className="ml-auto flex items-center gap-1">
          {(["month", "week"] as const).map((v) => (
            <Button key={v} size="sm" variant="ghost" aria-pressed={view === v} onClick={() => setView(v)} className="capitalize">
              {v}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={() => setCreating(at9(cursor))}>
          <Icon name="Plus" className="size-4" />
          New entry
        </Button>
      </header>
      {error === null ? null : (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {entries !== null && entries.length === 0 ? (
        <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Nothing scheduled yet. Use New entry, or let an agent add one with <code>bb brandwise calendar add</code>.
        </p>
      ) : null}
      <div className="grid shrink-0 grid-cols-7 border-b border-border text-xs text-muted-foreground" aria-hidden>
        {days.slice(0, 7).map((d) => (
          <div key={d.getDay()} className="px-2 py-1 text-right uppercase tracking-wide">
            {d.toLocaleDateString([], { weekday: "short" })}
          </div>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))` }}
      >
        {days.map((d) => {
          const key = dayKey(d);
          const list = byDay.get(key) ?? [];
          const inMonth = view === "week" || d.getMonth() === cursor.getMonth();
          const shown = view === "week" ? list : list.slice(0, MAX_CHIPS);
          return (
            <div
              key={key}
              onDragOver={(ev) => {
                if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
                ev.preventDefault();
                setOver(key);
              }}
              onDragLeave={(ev) => {
                if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver((o) => (o === key ? null : o));
              }}
              onDrop={(ev) => {
                ev.preventDefault();
                setOver(null);
                drop(d, ev.dataTransfer.getData(DRAG_TYPE));
              }}
              className={cn(
                "group flex min-h-0 flex-col gap-1 overflow-hidden border-b border-r border-border p-1.5",
                !inMonth && "bg-muted/30",
                over === key && "bg-accent/60",
              )}
            >
              <div className="flex shrink-0 items-center justify-between">
                <button
                  type="button"
                  aria-label={`Add entry on ${d.toLocaleDateString([], { day: "numeric", month: "long" })}`}
                  onClick={() => setCreating(at9(d))}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Icon name="Plus" className="size-3.5" />
                </button>
                <span
                  className={cn(
                    "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs",
                    key === todayKey ? "bg-foreground font-semibold text-background" : inMonth ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {d.getDate()}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {shown.map((e) =>
                  view === "week" ? <WeekCard key={e.id} entry={e} active={e.id === openId} /> : <MonthChip key={e.id} entry={e} active={e.id === openId} />,
                )}
                {list.length > shown.length ? (
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      setCursor(d);
                      setView("week");
                    }}
                  >
                    +{list.length - shown.length} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <EntryDialog entry={open} mode={mode} onChanged={refetch} onError={report} />
      <NewEntryDialog start={creating} onClose={() => setCreating(null)} onCreated={refetch} />
    </div>
  );
}

// --- one entry: what will be published, and what you can do with it ---

const SELECT = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const TEXTAREA = "w-full resize-y rounded-md border border-input bg-background p-2 text-sm";

const REVIEW_REASONS = ["claims", "facts", "tone", "brand", "visual", "legal", "typo", "offer", "other"] as const;

/** What the entry was written from: its brief (explore or exploit slot), the learnings it applies or tests, and its tags. */
function EntryLearnings({ entry }: { entry: CalendarEntry }) {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<{ briefId: string | null; slot: string | null; applied: { id: string; mode: string; statement: string; evidence: string | null }[]; attributes: Record<string, { value: string; source: string }>; experiment: { id: string; hypothesis: string; lever: string | null; variant: string | null; round: number; plannedRounds: number; expectedLift: number | null; mde: number | null; status: string; verdict: string | null } | null } | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("entry_learnings", { id: entry.id }).then((r) => live && setInfo(r), () => live && setInfo(null));
    return () => { live = false; };
  }, [entry.id, rpc]);
  if (info === null) return null;
  const tags = Object.entries(info.attributes).filter(([, a]) => a.source !== "derived");
  const byAgent = entry.createdBy !== "ui";
  const exp = info.experiment;
  const experimentBlock = exp ? (
    <div className="flex flex-col gap-0.5 rounded-md border border-border p-2 text-xs">
      <p><span className="font-medium">Experiment {exp.id}</span>, variant {exp.variant === "A" ? "A (control)" : "B (challenger)"}, round {exp.round} of {exp.plannedRounds}{exp.verdict ? ` · verdict ${exp.verdict}` : ""}</p>
      <p>{exp.hypothesis}{exp.lever ? ` (${exp.lever})` : ""}</p>
      <p className="text-muted-foreground">Registered before the first send: expected {exp.expectedLift === null ? "n/a" : `+${Math.round(100 * exp.expectedLift)} %`}{exp.mde === null ? "" : `, the planned sample can show +${Math.round(100 * exp.mde)} % or more`}. Approve both variants as they are: the test compares them.</p>
    </div>
  ) : null;
  if (info.briefId === null && info.applied.length === 0 && tags.length === 0) {
    if (experimentBlock) return experimentBlock;
    return byAgent ? <p className="text-xs text-muted-foreground">No learnings declared: the author did not say which brief it wrote from.</p> : null;
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2 text-sm">
      {experimentBlock}
      <p className="text-xs text-muted-foreground">
        Written from brief {info.briefId ?? "none"}{info.slot ? ` · ${info.slot} slot` : ""}
      </p>
      {info.applied.map((a) => (
        <p key={a.id} className="text-xs">
          <span className="font-medium">{a.mode === "test" ? "Tests" : "Applies"}</span> {a.id} ({a.evidence ?? "rule"}): {a.statement}
        </p>
      ))}
      {tags.length ? <p className="text-xs text-muted-foreground">Tags: {tags.map(([k, a]) => `${k}=${a.value}`).join(", ")}</p> : null}
    </div>
  );
}

function EntryDialog({
  entry,
  mode,
  onChanged,
  onError,
}: {
  entry: CalendarEntry | null;
  mode: Shared["mode"];
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const creatives = useCreatives(entry?.assetId ? [entry.assetId] : []);
  const creative = entry?.assetId ? creatives[entry.assetId] : undefined;
  const preview = creative === undefined ? null : (creative.dataUri ?? creative.thumb);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<string>("");
  // how long the reviewer had the entry open: the review's cost is counted from it (capped on the server side of the report)
  const openedAt = useRef<number>(Date.now());
  const reviewSeconds = () => Math.round((Date.now() - openedAt.current) / 1000);
  const [form, setForm] = useState({ title: "", body: "", link: "", channel: CHANNELS[0], at: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEditing(false);
    setNote("");
    setReason("");
    setError(null);
    openedAt.current = Date.now();
    if (entry !== null) {
      setForm({ title: entry.title, body: entry.body, link: entry.link ?? "", channel: entry.channel, at: toLocalInput(new Date(entry.scheduledAt)) });
    }
    // reset only when another entry or mode is opened, not on every refetch of the same one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, mode]);

  const run = async (work: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    try {
      await work();
      onChanged();
      done?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      onError(cause);
    } finally {
      setBusy(false);
    }
  };
  const decide = (decision: "approve" | "cancel") => entry && run(() => rpc.call("calendar_decide", { id: entry.id, decision, reviewSeconds: reviewSeconds() }), closeEntry);
  const sendBack = () => entry && run(() => rpc.call("calendar_request_changes", { id: entry.id, note, reason: reason === "" ? null : (reason as (typeof REVIEW_REASONS)[number]), reviewSeconds: reviewSeconds() }), closeEntry);
  const save = () => {
    if (entry === null) return;
    const timeChanged = form.at !== toLocalInput(new Date(entry.scheduledAt));
    return run(
      () =>
        rpc.call("calendar_update", {
          id: entry.id,
          title: form.title,
          body: form.body,
          link: form.link.trim() === "" ? null : form.link.trim(),
          channel: form.channel,
          ...(timeChanged ? { scheduledAt: new Date(form.at).toISOString() } : {}),
        }),
      () => setEditing(false),
    );
  };

  const changing = mode === "changes" && entry?.status === "pending_approval" && editable(entry);
  const resetsApproval = entry !== null && entry.tier > 1 && (entry.status === "approved" || entry.status === "scheduled");
  return (
    <Dialog open={entry !== null} onOpenChange={(o) => !o && closeEntry()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        {entry === null ? null : (
          <div className="flex flex-col gap-4">
            <div>
              <DialogTitle>{entry.title}</DialogTitle>
              <DialogDescription>
                <span className={statusOf(entry.status).tone}>{statusOf(entry.status).label}</span> · {TIER_HINT[entry.tier]}
              </DialogDescription>
            </div>
            {entry.status === "changes_requested" && entry.reviewNote ? (
              <p className="rounded-md border border-dashed border-foreground/40 p-2 text-sm">
                <span className="font-medium">Sent back:</span> {entry.reviewNote}
              </p>
            ) : null}
            {entry.error && ["approved", "failed", "needs_manual"].includes(entry.status) ? (
              <p className="rounded-md border border-dashed border-destructive/50 p-2 text-sm text-destructive-text" role="status">
                {entry.status === "approved" ? `Attempt ${entry.attempts} failed, retrying: ` : entry.status === "failed" ? `Failed after ${entry.attempts} attempts: ` : ""}{entry.error}
              </p>
            ) : null}
            {entry.channel === "email" ? <EntryEmailPreview key={`${entry.id}:${entry.body.length}`} entryId={entry.id} /> : null}
            {entry.status === "published" && entry.externalUrl ? (
              <p className="text-sm"><a className="underline" href={entry.externalUrl} target="_blank" rel="noreferrer">Published post</a></p>
            ) : null}
            {editing ? (
              <div className="flex flex-col gap-2">
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Title" />
                <textarea
                  className={TEXTAREA}
                  rows={6}
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  placeholder="Text as it will be published"
                  aria-label="Text"
                />
                <Input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="Link (https://…)" aria-label="Link" />
                <div className="grid grid-cols-2 gap-2">
                  <select className={SELECT} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} aria-label="Channel">
                    {[...new Set([...CHANNELS, form.channel])].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                  <Input type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} aria-label="When" />
                </div>
                {resetsApproval ? (
                  <p className="text-xs text-muted-foreground">Changing the title, text, link or channel sends it back for approval. Moving the time does not.</p>
                ) : entry.status === "changes_requested" ? (
                  <p className="text-xs text-muted-foreground">Saving resubmits it for approval.</p>
                ) : null}
              </div>
            ) : (
              <>
                {preview === null ? null : (
                  <div className="flex max-h-72 items-center justify-center overflow-hidden rounded-lg bg-muted/40">
                    {creative?.mime.startsWith("video/") ? (
                      <video src={preview} controls muted playsInline className="max-h-72 max-w-full object-contain" />
                    ) : (
                      <img src={preview} alt={creative?.name ?? ""} className="max-h-72 max-w-full object-contain" />
                    )}
                  </div>
                )}
                {entry.body === "" ? (
                  <p className="rounded-md border border-dashed border-border p-2 text-sm text-muted-foreground">No text yet.</p>
                ) : (
                  <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm">{entry.body}</p>
                )}
                <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">When</dt>
                  <dd>{whenOf(entry.scheduledAt)}</dd>
                  <dt className="text-muted-foreground">Channel</dt>
                  <dd className="capitalize">{entry.channel}</dd>
                  <dt className="text-muted-foreground">Campaign</dt>
                  <dd>{entry.campaignName}</dd>
                  {entry.link === null ? null : (
                    <>
                      <dt className="text-muted-foreground">Link</dt>
                      <dd className="min-w-0 truncate">
                        <a href={entry.link} target="_blank" rel="noreferrer" className="underline">
                          {entry.link}
                        </a>
                      </dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Created by</dt>
                  <dd>{entry.createdBy}</dd>
                  {entry.approvedBy === null ? null : (
                    <>
                      <dt className="text-muted-foreground">Approved by</dt>
                      <dd>{entry.approvedBy}{entry.approvedAt ? ` · ${whenOf(entry.approvedAt)}` : ""}</dd>
                    </>
                  )}
                </dl>
                <EntryLearnings key={`${entry.id}:${entry.briefId ?? ""}`} entry={entry} />
              </>
            )}
            {changing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  className={TEXTAREA}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What should change? The agent gets this note and revises the entry."
                  aria-label="What should change"
                  autoFocus
                />
                <select className={SELECT} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
                  <option value="">Reason (optional)</option>
                  {REVIEW_REASONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">The reason is counted: send-backs with the same reason become a rule the agents keep, once you confirm it on the Learnings page.</p>
              </div>
            ) : null}
            {entry.status === "pending_approval" && entry.tier === 3 && !editing && !changing ? (
              <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
                Tier 3 changes something sensitive (claims, price, budget or a new market). Approve only after you checked it yourself.
              </p>
            ) : null}
            {tookPlace(entry) && entry.status !== "cancelled" ? (
              <p className="text-xs text-muted-foreground">This entry already took place. It can no longer be changed, approved or cancelled.</p>
            ) : null}
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {editing ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button disabled={busy || form.title.trim() === ""} onClick={save}>
                    Save
                  </Button>
                </>
              ) : changing ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => setShared({ mode: "view" })}>
                    Back
                  </Button>
                  <Button disabled={busy || note.trim() === ""} onClick={sendBack}>
                    Send back
                  </Button>
                </>
              ) : (
                <>
                  {editable(entry) ? (
                    <RejectButton
                      label={entry.status === "pending_approval" ? "Reject" : "Cancel entry"}
                      className="mr-auto"
                      onConfirm={() => decide("cancel")}
                    />
                  ) : null}
                  {editable(entry) ? (
                    <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                  ) : null}
                  {entry.status === "approved" && editable(entry) ? (
                    <Button variant="outline" disabled={busy} onClick={() => run(() => rpc.call("calendar_unapprove", { id: entry.id }))}>
                      Withdraw approval
                    </Button>
                  ) : null}
                  {entry.status === "pending_approval" && editable(entry) ? (
                    <>
                      <Button variant="outline" disabled={busy} onClick={() => setShared({ mode: "changes" })}>
                        Request changes
                      </Button>
                      <Button disabled={busy} onClick={() => decide("approve")}>
                        Approve
                      </Button>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- new entry ---

function NewEntryDialog({ start, onClose, onCreated }: { start: Date | null; onClose: () => void; onCreated: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [channel, setChannel] = useState(CHANNELS[0]);
  const [at, setAt] = useState("");
  const [tier, setTier] = useState<1 | 2 | 3>(2);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (start === null) return;
    setAt(toLocalInput(start));
    setTitle("");
    setBody("");
    setLink("");
    setError(null);
    rpc.call("campaigns_list").then((r) => {
      setCampaigns(r.campaigns);
      setCampaignId((current) => current || r.campaigns[0]?.id || "");
    }, () => {});
  }, [start, rpc]);
  const valid = title.trim() !== "" && at !== "" && campaignId !== "";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    try {
      // the local wall-clock time of the picker, as an absolute instant (the server and Postgres may run in another zone)
      await rpc.call("calendar_add", {
        campaignId, title, channel, scheduledAt: new Date(at).toISOString(), tier, body,
        link: link.trim() === "" ? null : link.trim(),
      });
      onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Dialog open={start !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogTitle>New calendar entry</DialogTitle>
          <DialogDescription>Tier 1 goes out on its own, tier 2 and 3 wait in the approval queue.</DialogDescription>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" autoFocus />
          <textarea className={TEXTAREA} rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Text as it will be published" aria-label="Text" />
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link (https://…)" aria-label="Link" />
          <select className={SELECT} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
            {campaigns.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <select className={SELECT} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
              {CHANNELS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select className={SELECT} value={tier} onChange={(e) => setTier(Number(e.target.value) as 1 | 2 | 3)} aria-label="Approval tier">
              <option value={1}>Tier 1 (auto)</option>
              <option value={2}>Tier 2 (one click)</option>
              <option value={3}>Tier 3 (manual)</option>
            </select>
          </div>
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="When" />
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Add
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- sidebar: what waits for a human, soonest first; below it what waits for the agent ---

export function ApprovalsSidebar() {
  const { rpc, entries, error, report, refetch } = useCalendar();
  const byTime = (a: CalendarEntry, b: CalendarEntry) => a.scheduledAt.localeCompare(b.scheduledAt);
  const upcoming = (entries ?? []).filter((e) => !tookPlace(e));
  const pending = upcoming.filter((e) => e.status === "pending_approval").sort(byTime);
  const sentBack = upcoming.filter((e) => e.status === "changes_requested").sort(byTime);
  const missed = (entries ?? []).filter((e) => e.status === "pending_approval" && tookPlace(e)).length;
  const creatives = useCreatives(pending.flatMap((e) => (e.assetId ? [e.assetId] : [])));
  const approve = (id: string) => rpc.call("calendar_decide", { id, decision: "approve" }).then(refetch, report);
  return (
    <nav aria-label="Waiting for approval" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-2 text-sm">
      <h2 className="flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Waiting for approval
        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">{pending.length}</span>
      </h2>
      {error === null ? null : (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {entries === null ? (
        <p className="px-1 text-xs text-muted-foreground">Loading…</p>
      ) : pending.length === 0 ? (
        <p role="status" className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          All clear. Entries from agents that need you show up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.map((e) => {
            const thumb = e.assetId ? creatives[e.assetId]?.thumb : undefined;
            return (
              <li key={e.id} className="rounded-lg border border-dashed border-foreground/40 bg-card p-2">
                <button
                  type="button"
                  onClick={() => openEntry(e, "view", true)}
                  className="flex w-full min-w-0 gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40 text-muted-foreground">
                    {thumb ? <img src={thumb} alt="" className="size-full object-cover" /> : <Icon name="FileText" className="size-5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 font-medium">{e.title}</span>
                    {e.body === "" ? (
                      <span className="block text-xs italic text-muted-foreground">No text yet</span>
                    ) : (
                      <span className="line-clamp-2 text-xs text-muted-foreground">{e.body}</span>
                    )}
                    <span className="block truncate text-xs text-muted-foreground">
                      {e.channel} · {e.campaignName}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {whenOf(e.scheduledAt)} · T{e.tier}
                    </span>
                  </span>
                </button>
                <div className="mt-2 flex gap-1.5">
                  {e.tier === 2 ? (
                    <Button size="sm" className="flex-1" onClick={() => approve(e.id)}>
                      Approve
                    </Button>
                  ) : (
                    <Button size="sm" className="flex-1" onClick={() => openEntry(e, "view", true)}>
                      Review…
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => openEntry(e, "changes", true)}>
                    Changes…
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {missed === 0 ? null : (
        <p className="px-1 text-xs text-muted-foreground">
          {missed} {missed === 1 ? "entry" : "entries"} passed its time without approval and can no longer be changed.
        </p>
      )}
      {sentBack.length === 0 ? null : (
        <>
          <h2 className="mt-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            With the agent
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">{sentBack.length}</span>
          </h2>
          <ul className="flex flex-col gap-1">
            {sentBack.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => openEntry(e, "view", true)}
                  className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="block truncate">{e.title}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{e.reviewNote}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
