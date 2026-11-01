// Results page: what the system has learned and, as the analytics phases land, costs, economics and paid media
// (docs/analytics.md). Tab "Learnings": every learning of a brand with its evidence, status and age; a person confirms reviewer
// preferences and retires learnings here. Numbers come from code; nothing on this page changes goals, budgets or approvals.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Campaign, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Learning = { id: string; scope: string; kind: string; evidence: string | null; result: string | null; statement: string; channel: string | null; status: string; effectiveStatus: string; contrary: number; createdBy: string; confirmedBy: string | null; decidedAt: string; sourceIds: string[] };

const SELECT = "h-9 rounded-md border border-input bg-transparent px-2 text-sm";
const STATUS_TONE: Record<string, string> = { active: "", needs_retest: "text-amber-600", proposed: "text-sky-600", superseded: "text-muted-foreground", retired: "text-muted-foreground" };
const GROUPS: { title: string; hint: string; pick: (l: Learning) => boolean }[] = [
  { title: "Waiting for you", hint: "Rules drawn from your send-backs. They are in force for the agents once you confirm them.", pick: (l) => l.status === "proposed" },
  { title: "In force", hint: "Experiment verdicts (E1) and patterns over many entries (E2). Agents apply them; E1 and E2 are written by code only.", pick: (l) => l.kind === "performance" && l.evidence !== "E3" && l.effectiveStatus === "active" },
  { title: "No difference found", hint: "Not worth testing again at the same audience size.", pick: (l) => l.kind === "null_result" && l.effectiveStatus === "active" },
  { title: "Worth a re-test", hint: "Aged out, or applications went clearly the other way.", pick: (l) => l.effectiveStatus === "needs_retest" },
  { title: "Style rules", hint: "Your preferences from reviews, confirmed.", pick: (l) => l.kind === "reviewer_preference" && l.status === "active" },
  { title: "Candidates", hint: "Agents' observations (E3): tested only in explore slots or experiments.", pick: (l) => l.evidence === "E3" && l.status === "active" },
  { title: "History", hint: "Replaced by a newer learning, or retired.", pick: (l) => l.status === "superseded" || l.status === "retired" },
];

function LearningsTab({ campaigns }: { campaigns: Campaign[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const bases = useMemo(() => campaigns.filter((c) => c.kind === "always_on"), [campaigns]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [rows, setRows] = useState<Learning[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = campaignId || bases[0]?.id || "";

  const load = useCallback(() => {
    if (!current) return;
    rpc.call("learnings_list", { campaignId: current }).then((r) => { setRows(r.learnings); setError(null); }, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [current, rpc]);
  useEffect(load, [load]);

  const act = async (id: string, action: "confirm" | "retire") => {
    setBusy(true);
    try { await rpc.call("learning_set_status", { id, action }); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (bases.length === 0) return <p className="text-sm text-muted-foreground">No brand yet: create an always-on campaign first.</p>;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <select className={SELECT} value={current} onChange={(e) => setCampaignId(e.target.value)} aria-label="Brand">
          {bases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">Learnings of the brand and its campaigns</span>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {rows === null ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing learned yet. Learnings appear when experiments conclude, when the weekly miner finds a pattern, or when an agent notes an observation.</p>
      ) : GROUPS.map((g) => {
        const items = rows.filter(g.pick);
        if (items.length === 0) return null;
        return (
          <section key={g.title} className="flex flex-col gap-2">
            <div>
              <h3 className="text-sm font-medium">{g.title} <span className="text-muted-foreground">({items.length})</span></h3>
              <p className="text-xs text-muted-foreground">{g.hint}</p>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {items.map((l) => (
                <li key={l.id} className="flex items-start gap-3 p-2 text-sm">
                  <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{l.evidence ?? "rule"}</span>
                  <div className="min-w-0 flex-1">
                    <p>{l.statement}</p>
                    <p className="text-xs text-muted-foreground">
                      {l.id} · {l.scope}{l.channel ? ` · ${l.channel}` : ""} · {l.decidedAt.slice(0, 10)} · by {l.createdBy}
                      {l.contrary > 0 ? ` · ${l.contrary} contrary application(s)` : ""}
                      {" · "}<span className={cn(STATUS_TONE[l.effectiveStatus])}>{l.effectiveStatus.replace("_", " ")}</span>
                    </p>
                  </div>
                  {l.status === "proposed" ? <Button size="sm" disabled={busy} onClick={() => act(l.id, "confirm")}>Confirm</Button> : null}
                  {l.status === "proposed" || l.status === "active" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act(l.id, "retire")}>Retire</Button> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const TABS = [{ id: "learnings", title: "Learnings" }] as const;

export function ResultsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("learnings");
  useEffect(() => { rpc.call("campaigns_list").then((r) => setCampaigns(r.campaigns), () => {}); }, [rpc]);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border flex w-full max-w-4xl flex-col gap-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm", tab === t.id ? "border-foreground font-medium" : "border-transparent text-muted-foreground")}>
              {t.title}
            </button>
          ))}
        </div>
        {tab === "learnings" ? <LearningsTab campaigns={campaigns} /> : null}
      </div>
    </div>
  );
}
