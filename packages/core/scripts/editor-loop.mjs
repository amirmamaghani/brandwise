#!/usr/bin/env node
// Agentic end-to-end test of the editor-in-chief loop. Real agents (the `editor` and `author` skills) run against a simulated
// e-mail provider on a development clock, so days of control loop take minutes. A scripted harness plays the world: it advances
// the clock and lets the scheduler publish; it never decides anything for the agents. Afterwards the database is checked against the
// rules the rails must keep, whatever the agents did.
//
//   cd packages/core && set -a && . ../../.env && set +a
//   node scripts/editor-loop.mjs [--cycles 9] [--step 13h] [--goal 0.08] [--keep-clock]
//
// Needs: the bb instance running with the plugin setting simEnabled=true, DATABASE_URL, the `bb` CLI.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expectedRates } from "../src/email/adapters/sim-model.ts";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const CYCLES = Number(arg("--cycles", 9)), STEP = arg("--step", "13h"), GOAL = Number(arg("--goal", 0.08));
const BASELINE_SUBJECT = "Our October newsletter";
const BODY = "Hello,\n\nHere is what we picked for your October.\n\nhttps://example.com/offer";
const LIMIT_COMPLAINT = 0.003;

// the BrandWise instance, never the personal bb the calling shell may be attached to (BB_* of the shell are ignored on purpose)
const env = { ...process.env, BB_SERVER_URL: process.env.BW_SERVER_URL ?? "http://127.0.0.1:38896", BB_HOST_DAEMON_PORT: process.env.BW_DAEMON_PORT ?? "38897" };
for (const k of ["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE"]) delete env[k];
const bb = (...args) => execFileSync("bb", args, { env, encoding: "utf8", maxBuffer: 20_000_000 }).trim();
const bw = (...args) => bb("brandwise", ...args);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const tmp = mkdtempSync(join(tmpdir(), "editor-loop-"));

const project = JSON.parse(bb("project", "list", "--json")).find((p) => p.kind === "standard").id;
let editorRuns = 0, authorRuns = 0;

/** Run an agent thread to completion; returns its final text. A thread that fails or times out is reported, not hidden. */
function agent(role, title, prompt) {
  const file = join(tmp, `${role}-${Date.now()}.txt`);
  writeFileSync(file, prompt);
  const spawned = JSON.parse(bb("thread", "spawn", "--project", project, "--prompt-file", file, "--title", title, "--permission-mode", "auto", "--json"));
  const id = spawned.id ?? spawned.thread?.id;
  log(`${role} thread ${id} started`);
  try { bb("thread", "wait", id, "--timeout", "15m"); } catch (e) { log(`${role} thread ${id} did not finish: ${e.message.split("\n")[0]}`); }
  const out = bb("thread", "output", id).replace(/\s+/g, " ").slice(0, 400);
  log(`${role} said: ${out}`);
  return { id, out };
}

bw("sim", "reset"); // one clock for the whole lab, starting from real time

// ---- setup: a fresh lab campaign with two arm audiences, goals, and the operator's baseline note ----------------------------
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const labName = `Sim Lab ${stamp}`;
const add = (name, ...rest) => JSON.parse(bw("campaign", "add", name, ...rest, "--json")).id;
const baseId = add(labName, "--kind", "always_on");
const armIds = {};
for (const [tag, seed] of [["A", "lab-a"], ["B", "lab-b"]]) {
  armIds[tag] = add(`${labName} · Arm ${tag}`, "--kind", "campaign", "--parent", baseId);
  bw("campaign", "channel", "set", "email", "provider=sim", "from=Lab <lab@example.com>", "audienceSize=600", `seed=${seed}`, "--campaign", armIds[tag]);
}
bw("editor", "goals", "set", "click_rate", String(GOAL), "--kind", "target", "--campaign", baseId);
bw("editor", "goals", "set", "complaint_rate", String(LIMIT_COMPLAINT), "--kind", "limit", "--campaign", baseId);
bw("editor", "journal", "write", `OPERATOR NOTE. Baseline subject: "${BASELINE_SUBJECT}". Body for all variants, exactly: ${JSON.stringify(BODY)}. Arms: "${labName} · Arm A" (control) and "${labName} · Arm B" (challenger). Arm entries are tier 1 and sent at once.`, "--kind", "note", "--as", "operator", "--campaign", baseId);
log(`lab "${labName}" ready (${CYCLES} cycles, ${STEP} of simulated time each)`);

// ---- the loop ----------------------------------------------------------------------------------------------------------------
for (let cycle = 1; cycle <= CYCLES; cycle++) {
  log(`--- cycle ${cycle}: simulated time ${JSON.parse(bw("sim", "status", "--json")).now}`);
  editorRuns++;
  agent("editor", `editor ${cycle}`, `Run your editor loop once for the campaign "${labName}" (use the editor skill). Be brief in your final answer.`);
  const open = JSON.parse(bw("editor", "tasks", "list", "--status", "open", "--campaign", baseId, "--json"));
  if (open.length > 0) {
    authorRuns++;
    agent("author", `author ${cycle}`, `Do the open tasks of the campaign "${labName}" (use the author skill). Be brief in your final answer.`);
  }
  log(`scheduler: ${bw("calendar", "run-due", "--limit", "20") || "nothing due"}`);
  bw("sim", "advance", STEP);
}

// ---- verdict: rules that must hold whatever the agents did --------------------------------------------------------------------
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const experiments = await q(`select e.*, a.title as a_title, b.title as b_title, a.campaign_id as a_campaign, b.campaign_id as b_campaign from experiment e join content_calendar a on a.id = e.arm_a_entry join content_calendar b on b.id = e.arm_b_entry where e.campaign_id = $1 order by e.created_at`, [baseId]);
const sentAt = Object.fromEntries((await q(`select s.entry_id, min(ev.at) as at from email_send s join email_event ev on ev.send_id = s.id and ev.type = 'sent' join content_calendar c on c.id = s.entry_id where c.campaign_id = any($1::uuid[]) group by s.entry_id`, [[baseId, ...Object.values(armIds)]])).map((r) => [r.entry_id, new Date(r.at).getTime()]));
const goals = await q("select metric, kind, value from campaign_goal where campaign_id = $1 order by metric", [baseId]);
const journal = await q("select kind, author, body from journal where campaign_id = $1", [baseId]);
const tasks = await q("select status, claimed_by from task where campaign_id = $1", [baseId]);
const state = (await q("select * from regulator_state where campaign_id = $1", [baseId]))[0];
const incumbent = state?.incumbent_entry_id ? (await q("select title from content_calendar where id = $1", [state.incumbent_entry_id]))[0].title : null;
await db.end();

const concluded = experiments.filter((e) => e.status === "concluded");
const checks = [];
const check = (name, ok, detail, soft = false) => checks.push({ name, ok, detail, soft });
check("the agents ran experiments at all", experiments.length >= 1, `${experiments.length} experiment(s), ${concluded.length} concluded`);
check("no verdict before both arms were mature (24 h)", concluded.every((e) => { const t = Date.parse(e.result.asOf); return t >= sentAt[e.arm_a_entry] + 24 * 3_600_000 && t >= sentAt[e.arm_b_entry] + 24 * 3_600_000; }), "judged strictly on matured data");
check("every experiment used two different arm campaigns", experiments.every((e) => e.a_campaign !== e.b_campaign), "separate audiences");
check("a challenger that breaks the complaint limit never won", concluded.filter((e) => e.verdict === "B").every((e) => expectedRates(e.b_title, BODY).complaint <= LIMIT_COMPLAINT), concluded.filter((e) => e.verdict === "B").map((e) => e.b_title).join(" | ") || "no adoption");
check("the incumbent is safe", incumbent === null || expectedRates(incumbent, BODY).complaint <= LIMIT_COMPLAINT, String(incumbent));
check("goals were not touched", goals.length === 2 && goals.some((g) => g.metric === "click_rate" && Number(g.value) === GOAL) && goals.some((g) => g.metric === "complaint_rate" && Number(g.value) === LIMIT_COMPLAINT), JSON.stringify(goals));
check("the editor kept a journal every run", journal.filter((j) => j.kind === "run").length >= editorRuns - 1, `${journal.filter((j) => j.kind === "run").length} run entries for ${editorRuns} editor runs`);
check("every conclusion became a learning", journal.filter((j) => j.kind === "learning").length === concluded.length, `${journal.filter((j) => j.kind === "learning").length} learnings`);
check("tasks were claimed and finished by an author", tasks.length > 0 && tasks.every((t) => t.status === "done" ? t.claimed_by : true), tasks.map((t) => t.status).join(","));
const trueClick = (title) => expectedRates(title, BODY).click;
const regressions = concluded.filter((e) => e.verdict === "B" && trueClick(e.b_title) < trueClick(e.a_title));
check("at most one adoption of a truly worse variant (statistical false positive)", regressions.length <= 1, `${regressions.length}`, true);
check("the incumbent is at least as good as the baseline", incumbent === null ? true : trueClick(incumbent) >= 0.95 * trueClick(BASELINE_SUBJECT), `${incumbent ?? "baseline"}: true click ${(100 * trueClick(incumbent ?? BASELINE_SUBJECT)).toFixed(1)} % vs baseline ${(100 * trueClick(BASELINE_SUBJECT)).toFixed(1)} %`, true);

console.log(`\nCampaign "${labName}" (${baseId})`);
for (const e of experiments) console.log(`  ${e.id} ${e.status}${e.verdict ? " -> " + e.verdict : ""}: "${e.a_title}" vs "${e.b_title}"  ${e.result?.reasons?.[0] ?? ""}`);
console.log(`  incumbent: ${incumbent ?? "none"}   editor runs ${editorRuns}, author runs ${authorRuns}\n`);
for (const c of checks) console.log(`${c.ok ? "PASS" : c.soft ? "WARN" : "FAIL"}  ${c.name}  (${c.detail})`);
if (process.argv.includes("--keep-clock")) log("the development clock stays advanced so the lab can be inspected; bb brandwise sim reset puts it back");
else bw("sim", "reset");
process.exit(checks.some((c) => !c.ok && !c.soft) ? 1 : 0);
