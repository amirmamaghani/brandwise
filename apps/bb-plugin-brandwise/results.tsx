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

/** Brand picker shared by the tabs: reports are per always-on base (its campaigns included). */
function useBrand(campaigns: Campaign[]) {
  const bases = useMemo(() => campaigns.filter((c) => c.kind === "always_on"), [campaigns]);
  const [id, setId] = useState("");
  const current = id || bases[0]?.id || "";
  const picker = bases.length === 0 ? null : (
    <select className={SELECT} value={current} onChange={(e) => setId(e.target.value)} aria-label="Brand">
      {bases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
  return { current, picker, scope: campaigns.filter((c) => c.rootId === current) };
}
const money = (v: number | null | undefined, currency?: string | null) => (v === null || v === undefined ? "n/a" : `${v.toFixed(2)}${currency ? ` ${currency}` : ""}`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Math.round(100 * v)} %`);

function CostsTab({ campaigns }: { campaigns: Campaign[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const { current, picker, scope } = useBrand(campaigns);
  const [campaignId, setCampaignId] = useState("");
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const target = campaignId && scope.some((c) => c.id === campaignId) ? campaignId : current;
  const load = useCallback(() => { if (target) rpc.call("results_costs", { campaignId: target, sinceDays: days }).then((r) => { setReport(r.report); setError(null); }, (e) => setError(String(e?.message ?? e))); }, [target, days, rpc]);
  useEffect(load, [load]);
  if (!picker) return <p className="text-sm text-muted-foreground">No brand yet.</p>;
  const c = report?.costs;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {picker}
        <select className={SELECT} value={target} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
          {scope.map((x) => <option key={x.id} value={x.id}>{x.kind === "always_on" ? `${x.name} (whole brand)` : x.name}</option>)}
        </select>
        <select className={SELECT} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {[7, 30, 90, 365].map((d) => <option key={d} value={d}>last {d} days</option>)}
        </select>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {c ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Costs: {money(c.total, c.currency)}{c.partial.length ? <span className="font-normal text-muted-foreground"> (not priced yet: {c.partial.join(", ")})</span> : null}</h3>
          <table className="text-sm">
            <tbody>
              {c.rows.map((r: any) => (
                <tr key={r.kind} className="border-b border-border"><td className="py-1 pr-4">{r.kind}</td><td className="py-1 pr-4 text-right tabular-nums">{money(r.money, c.currency)}</td><td className="py-1 text-xs text-muted-foreground">{r.detail}</td></tr>
              ))}
            </tbody>
          </table>
          {c.needs.map((n: string) => <p key={n} className="text-xs text-amber-600">Needs: {n}</p>)}
        </section>
      ) : null}
      {report?.formats?.length ? (
        <section className="flex flex-col gap-2">
          <div><h3 className="text-sm font-medium">Creatives by format (90 days at least)</h3><p className="text-xs text-muted-foreground">Everything generated in a format, rejected and failed included, over the assets that made it into an approved entry.</p></div>
          <table className="text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="pr-4">Format</th><th className="pr-4 text-right">Generated</th><th className="pr-4 text-right">Failed</th><th className="pr-4 text-right">Approved</th><th className="text-right">Per approved asset</th></tr></thead>
            <tbody>
              {report.formats.map((f: any) => (
                <tr key={f.format} className="border-b border-border"><td className="py-1 pr-4">{f.format}</td><td className="pr-4 text-right tabular-nums">{f.generations}</td><td className="pr-4 text-right tabular-nums">{f.failed}</td><td className="pr-4 text-right tabular-nums">{f.approvedAssets} ({pct(f.approvedShare)})</td><td className="text-right tabular-nums">{money(f.costPerApprovedAsset, c?.currency)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {report?.production ? (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="font-medium">Production (entries you review)</h3>
          <p>{report.production.decided} decided of {report.production.entries}: first-pass approval {pct(report.production.firstPassRate)}, send-backs per entry {report.production.sendBacksPerEntry?.toFixed(2) ?? "n/a"}, median {report.production.medianHoursToApproval?.toFixed(1) ?? "n/a"} h to approval.</p>
          <p className="text-xs text-muted-foreground">Send-back reasons: {Object.entries(report.production.reasons).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}</p>
        </section>
      ) : null}
      <AddCost campaignId={target} onAdded={load} />
    </div>
  );
}

/** A person states a cost the system cannot see: media spend, an incentive, a tool, sales cost (for CAC). */
function AddCost({ campaignId, onAdded }: { campaignId: string; onAdded: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [form, setForm] = useState({ kind: "media", amount: "", ref: "", note: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async () => {
    try {
      await rpc.call("cost_add", { campaignId, kind: form.kind as "media", amount: Number(form.amount), ref: form.ref, note: form.note || undefined });
      setForm({ ...form, amount: "", ref: "", note: "" }); setMsg("Recorded."); onAdded();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">State a cost</h3>
      <div className="flex flex-wrap gap-2">
        <select className={SELECT} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Kind">
          {["media", "incentive", "tool", "sales"].map((k) => <option key={k}>{k}</option>)}
        </select>
        <input className={SELECT} placeholder="Amount" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} aria-label="Amount" />
        <input className={SELECT} placeholder="Reference (invoice no.)" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} aria-label="Reference" />
        <input className={SELECT} placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} aria-label="Note" />
        <Button size="sm" disabled={!form.amount || !form.ref.trim()} onClick={submit}>Add</Button>
      </div>
      {msg ? <p className="text-xs text-muted-foreground">{msg}</p> : null}
    </section>
  );
}

const PROFILE_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "margin", label: "Contribution margin (0..1)", hint: "after cost of goods, shipping and fees" },
  { key: "orderValue", label: "Order or deal value", hint: "average order (e-commerce) or won deal (leads)" },
  { key: "leadToQualified", label: "Lead -> qualified (0..1)", hint: "leads only" },
  { key: "qualifiedToCustomer", label: "Qualified -> customer (0..1)", hint: "leads only" },
  { key: "hourlyRate", label: "Reviewer hourly rate", hint: "prices review minutes" },
  { key: "espPerThousand", label: "E-mail provider per 1,000 sent", hint: "" },
  { key: "llmMonthly", label: "LLM spend per month", hint: "spread over the agents' entries" },
  { key: "toolsMonthly", label: "Tools per month", hint: "period level only" },
];

function EconomicsTab({ campaigns }: { campaigns: Campaign[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const { current, picker } = useBrand(campaigns);
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!current) return;
    rpc.call("economics_get", { campaignId: current }).then((r) => {
      setData(r.economics);
      const p = r.economics.profile ?? { model: "ecommerce", currency: "EUR" };
      setForm(Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v !== "object").map(([k, v]) => [k, String(v)])));
    }, (e) => setMsg(String(e?.message ?? e)));
  }, [current, rpc]);
  useEffect(load, [load]);
  if (!picker) return <p className="text-sm text-muted-foreground">No brand yet.</p>;
  const save = async () => {
    try {
      const profile = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, k === "model" || k === "currency" ? v : Number(v)]));
      await rpc.call("economics_set", { campaignId: current, profile });
      setMsg("Saved as a new version: reports from now on use it."); load();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">{picker}<span className="text-xs text-muted-foreground">{data?.profile ? `Set by ${data.setBy} from ${data.validFrom?.slice(0, 10)}` : "No profile yet"}</span></div>
      <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">Business model
          <select className={SELECT} value={form.model ?? "ecommerce"} onChange={(e) => setForm({ ...form, model: e.target.value })}>
            {["ecommerce", "b2c_leads", "b2b_leads"].map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">Currency
          <input className={SELECT} value={form.currency ?? ""} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
        </label>
        {PROFILE_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs">{f.label}{f.hint ? <span className="text-muted-foreground">{f.hint}</span> : null}
            <input className={SELECT} inputMode="decimal" value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          </label>
        ))}
      </section>
      <div className="flex items-center gap-2"><Button size="sm" onClick={save}>Save profile</Button>{msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}</div>
      {data ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">What the profile says</h3>
          {data.derived.map((d: any) => (
            <p key={d.name} className="text-sm"><span className="font-mono text-xs">{d.name}</span>: {d.value === null ? <span className="text-amber-600">needs {d.needs.join(", ")}</span> : d.value.toFixed(2)} <span className="text-xs text-muted-foreground">({d.formula})</span></p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

const range = (r: { low: number; high: number } | undefined) => (!r ? "n/a" : r.low === r.high ? String(r.low) : `${r.low}..${r.high}`);
const perRange = (x: { best: number | null; worst: number | null } | undefined, cur?: string | null) => (!x || (x.best === null && x.worst === null) ? "n/a" : `${money(x.best, null)}..${money(x.worst, cur)}`);

/** Leads and orders: the funnel as attribution ranges with cost per result, and the brand's lead sources (a person adds and imports). */
function LeadsTab({ campaigns }: { campaigns: Campaign[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const { current, picker, scope } = useBrand(campaigns);
  const [campaignId, setCampaignId] = useState("");
  const [days, setDays] = useState(30);
  const [funnel, setFunnel] = useState<any>(null);
  const [sources, setSources] = useState<{ id: string; name: string; adapter: string; received: number }[]>([]);
  const [created, setCreated] = useState<{ id: string; secret: string | null; path: string } | null>(null);
  const [form, setForm] = useState({ name: "", adapter: "generic" as "generic" | "csv", promo: "", csv: "", sourceId: "", mapping: "id=id, status=status, occurredAt=occurredAt, email=email, utm_content=utm_content", kind: "lead" as "lead" | "order" });
  const [msg, setMsg] = useState<string | null>(null);
  const target = campaignId && scope.some((c) => c.id === campaignId) ? campaignId : current;
  const load = useCallback(() => {
    if (!target) return;
    rpc.call("results_funnel", { campaignId: target, sinceDays: days }).then((r) => setFunnel(r.funnel), (e) => setMsg(String(e?.message ?? e)));
    rpc.call("conversion_sources", { campaignId: target }).then((r) => setSources(r.sources), () => {});
  }, [target, days, rpc]);
  useEffect(load, [load]);
  if (!picker) return <p className="text-sm text-muted-foreground">No brand yet.</p>;
  const act = async (work: () => Promise<unknown>, done: string) => { try { await work(); setMsg(done); load(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } };
  const f = funnel;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {picker}
        <select className={SELECT} value={target} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
          {scope.map((x) => <option key={x.id} value={x.id}>{x.kind === "always_on" ? `${x.name} (whole brand)` : x.name}</option>)}
        </select>
        <select className={SELECT} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {[7, 30, 90, 365].map((d) => <option key={d} value={d}>last {d} days</option>)}
        </select>
      </div>
      {f && !f.measured ? <p className="text-sm text-amber-600">No lead source measures this brand yet: leads and CPL are unknown, not zero. Add one below.</p> : null}
      {f && f.measured ? (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="font-medium">Funnel (attribution range: last click .. with promo codes and self-reports)</h3>
          <p>Leads {range(f.leads)} · qualified {range(f.qualified)} · won {range(f.won)} · orders {range(f.orders)} · revenue {money(f.revenue?.low, null)}..{money(f.revenue?.high, f.currency)} · {f.unattributed} unattributed</p>
          <p>CPL {perRange(f.cpl, f.currency)} (max {money(f.cpl?.max, f.currency)}: {f.cpl?.verdict}) · CPQL {perRange(f.cpql, f.currency)} ({f.cpql?.verdict}) · CAC {perRange(f.cac, f.currency)}</p>
          <p>MER {f.mer?.low?.toFixed(2) ?? "n/a"}..{f.mer?.high?.toFixed(2) ?? "n/a"} (break-even ROAS {f.mer?.breakEven?.toFixed(2) ?? "n/a"}) · contribution {f.contribution ? `${money(f.contribution.low, null)}..${money(f.contribution.high, f.currency)}` : "n/a"}</p>
          <p className="text-xs text-muted-foreground">ROMI: {f.romi?.needs}</p>
          {f.needs?.map((n: string) => <p key={n} className="text-xs text-amber-600">Needs: {n}</p>)}
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Lead sources</h3>
        {sources.map((s) => <p key={s.id} className="text-sm">{s.name} <span className="text-xs text-muted-foreground">({s.adapter}, {s.received} received, id {s.id})</span></p>)}
        <div className="flex flex-wrap gap-2">
          <input className={SELECT} placeholder="Name (site form, CRM...)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Source name" />
          <select className={SELECT} value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value as "generic" })} aria-label="Adapter">
            <option value="generic">signed webhook</option><option value="csv">CSV import</option>
          </select>
          <Button size="sm" disabled={!form.name.trim()} onClick={() => act(async () => setCreated(await rpc.call("conversion_source_add", { campaignId: target, name: form.name, adapter: form.adapter })), "Source added.")}>Add source</Button>
        </div>
        {created ? (
          <p className="rounded-md border border-dashed border-border p-2 text-xs">
            POST to <span className="font-mono">{created.path}</span>{created.secret ? <> with the header <span className="font-mono">X-BrandWise-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256(secret, t + "." + body)&gt;</span>. Secret (shown once): <span className="font-mono">{created.secret}</span></> : " (CSV source: import below)"}
          </p>
        ) : null}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Import a CSV export</h3>
        <div className="flex flex-wrap gap-2">
          <select className={SELECT} value={form.sourceId} onChange={(e) => setForm({ ...form, sourceId: e.target.value })} aria-label="Source">
            <option value="">Source…</option>
            {sources.filter((s) => s.adapter !== "sim").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className={SELECT} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "lead" })} aria-label="Kind"><option>lead</option><option>order</option></select>
          <input className={cn(SELECT, "min-w-80 flex-1")} value={form.mapping} onChange={(e) => setForm({ ...form, mapping: e.target.value })} aria-label="Mapping: field=column, ..." />
        </div>
        <textarea className="min-h-24 rounded-md border border-input bg-transparent p-2 font-mono text-xs" placeholder="Paste the CSV (first row: headers)" value={form.csv} onChange={(e) => setForm({ ...form, csv: e.target.value })} />
        <div><Button size="sm" disabled={!form.sourceId || !form.csv.trim()} onClick={() => act(async () => {
          const mapping = Object.fromEntries(form.mapping.split(",").map((p) => p.split("=").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
          const r = await rpc.call("conversion_import", { sourceId: form.sourceId, csv: form.csv, mapping, kind: form.kind });
          setMsg(`Imported: ${JSON.stringify(r.result)}`);
        }, "Imported.")}>Import</Button></div>
      </section>
      <section className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Promo code of this campaign</h3>
        <input className={SELECT} placeholder="SPRING10" value={form.promo} onChange={(e) => setForm({ ...form, promo: e.target.value })} aria-label="Promo code" />
        <Button size="sm" disabled={form.promo.trim().length < 2} onClick={() => act(() => rpc.call("promo_set", { code: form.promo, campaignId: target }), "Promo code mapped.")}>Map</Button>
      </section>
      {msg ? <p className="text-xs text-muted-foreground">{msg}</p> : null}
    </div>
  );
}

/** Paid media per ad: what the platform reports next to our leads and orders (platform conversions are indicative). */
function PaidTab({ campaigns }: { campaigns: Campaign[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const { current, picker, scope } = useBrand(campaigns);
  const [campaignId, setCampaignId] = useState("");
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = campaignId && scope.some((c) => c.id === campaignId) ? campaignId : current;
  useEffect(() => { if (target) rpc.call("ads_results", { campaignId: target }).then((r) => { setRows(r.ads); setError(null); }, (e) => setError(String(e?.message ?? e))); }, [target, rpc]);
  if (!picker) return <p className="text-sm text-muted-foreground">No brand yet.</p>;
  const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "n/a" : v.toFixed(d));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {picker}
        <select className={SELECT} value={target} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
          {scope.map((x) => <option key={x.id} value={x.id}>{x.kind === "always_on" ? `${x.name} (whole brand)` : x.name}</option>)}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">Orders are tier-3 calendar entries you approve; the limits under Settings (Paid media) are checked when an order is made and again before payment. Unset limits buy nothing.</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {rows === null ? null : rows.length === 0 ? <p className="text-sm text-muted-foreground">No ads yet.</p> : (
        <table className="text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="pr-3">Ad</th><th className="pr-3">Status</th><th className="pr-3 text-right">Spend</th><th className="pr-3 text-right">CTR</th><th className="pr-3 text-right">CPC</th><th className="pr-3 text-right">Freq.</th><th className="pr-3 text-right">Leads</th><th className="pr-3 text-right">CPL</th><th className="text-right">ROAS</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.entryId} className="border-b border-border">
                <td className="py-1 pr-3">{a.name}{a.fatigue ? <span className="ml-1 text-xs text-amber-600">fatigue</span> : null}</td>
                <td className="pr-3 text-xs">{a.status}</td>
                <td className="pr-3 text-right tabular-nums">{n(a.spend)} {a.currency}</td>
                <td className="pr-3 text-right tabular-nums">{a.ctr === null ? "n/a" : `${(100 * a.ctr).toFixed(2)} %`}</td>
                <td className="pr-3 text-right tabular-nums">{n(a.cpc)}</td>
                <td className="pr-3 text-right tabular-nums">{n(a.frequency, 1)}</td>
                <td className="pr-3 text-right tabular-nums">{a.leads ?? "n/a"} <span className="text-xs text-muted-foreground">({a.platformConversions} platform)</span></td>
                <td className="pr-3 text-right tabular-nums">{n(a.cpl)}{a.fullyLoadedCpl !== null ? <span className="text-xs text-muted-foreground"> / {n(a.fullyLoadedCpl)} loaded</span> : null}</td>
                <td className="text-right tabular-nums">{n(a.roas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const TABS = [{ id: "learnings", title: "Learnings" }, { id: "costs", title: "Costs" }, { id: "leads", title: "Leads" }, { id: "paid", title: "Paid" }, { id: "economics", title: "Economics" }] as const;

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
        {tab === "costs" ? <CostsTab campaigns={campaigns} /> : null}
        {tab === "leads" ? <LeadsTab campaigns={campaigns} /> : null}
        {tab === "paid" ? <PaidTab campaigns={campaigns} /> : null}
        {tab === "economics" ? <EconomicsTab campaigns={campaigns} /> : null}
      </div>
    </div>
  );
}
