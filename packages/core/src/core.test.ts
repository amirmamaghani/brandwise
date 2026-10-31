// Integration test against the local stack (pnpm infra:up). Skipped without DATABASE_URL.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cookieJarFor, createCore, configFromEnv, higgsfield, sessionFromCookieJar } from "./index.ts";
import { createSettings } from "./settings.ts";
import { migrate } from "./migrate.ts";
import { runDue } from "./publish.ts";
import { purge } from "./testing.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;

run("campaigns, calendar and assets round-trip", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}`; // unique: test files run in parallel and clean up by this prefix
  try {
    const base = await core.campaigns.add({ name: `${tag}-base`, kind: "always_on" });
    const campaign = await core.campaigns.add({ name: `${tag}-campaign`, kind: "campaign", parentId: base.id, startsAt: "2026-11-01", endsAt: "2026-11-30" });
    await assert.rejects(core.campaigns.add({ name: `${tag}-orphan`, kind: "campaign" }), /needs a parent/);
    assert.equal(base.rootId, base.id);
    assert.deepEqual([campaign.startsAt, campaign.endsAt], ["2026-11-01", "2026-11-30"], "dates must not shift by a day");
    assert.equal(campaign.rootId, base.id, "campaign inherits the root of its always-on base");

    const t1 = await core.calendar.add({ campaignId: campaign.id, title: "auto", channel: "email", scheduledAt: "2099-11-02T08:00", tier: 1 });
    const t2 = await core.calendar.add({ campaignId: campaign.id, title: "manual", channel: "instagram", scheduledAt: "2099-11-03T09:00", tier: 2 });
    assert.equal(t1.status, "approved");
    assert.equal(t2.status, "pending_approval");
    assert.equal((await core.calendar.decide(t2.id, "approve")).status, "approved");
    await assert.rejects(core.calendar.decide(t2.id, "approve"), /only pending_approval/);
    assert.equal((await core.calendar.decide(t1.id, "cancel")).status, "cancelled");

    // content edits of an approved tier-2 entry need a new approval, moving it in time does not
    const edited = await core.calendar.update(t2.id, { body: "Caption", link: "https://example.com/a" });
    assert.deepEqual([edited.status, edited.body, edited.link], ["pending_approval", "Caption", "https://example.com/a"]);
    await core.calendar.decide(t2.id, "approve");
    assert.equal((await core.calendar.update(t2.id, { scheduledAt: "2099-11-04T09:00" })).status, "approved");
    await assert.rejects(core.calendar.update(t2.id, { link: "javascript:alert(1)" }), /http\(s\)/);
    await assert.rejects(core.calendar.update(t1.id, { title: "late" }), /no actions allowed/, "cancelled entries are frozen");
    const auto = await core.calendar.add({ campaignId: campaign.id, title: "auto 2", channel: "email", scheduledAt: "2099-11-06T08:00", tier: 1 });
    assert.equal((await core.calendar.update(auto.id, { body: "changed" })).status, "approved", "tier 1 stays automatic");

    // an upcoming approved entry can go back to pending; approving it again is a manual step, even for tier 1
    const up = await core.calendar.add({ campaignId: campaign.id, title: "upcoming", channel: "web", scheduledAt: "2099-12-01T09:00", tier: 2 });
    await assert.rejects(core.calendar.unapprove(up.id), /only approved/, "pending cannot be withdrawn");
    await core.calendar.decide(up.id, "approve");
    assert.equal((await core.calendar.unapprove(up.id)).status, "pending_approval");
    assert.equal((await core.calendar.decide(up.id, "approve")).status, "approved");
    const auto1 = await core.calendar.add({ campaignId: campaign.id, title: "auto 3", channel: "email", scheduledAt: "2099-12-02T09:00", tier: 1 });
    assert.equal(auto1.status, "approved");
    assert.equal((await core.calendar.unapprove(auto1.id)).status, "pending_approval");
    assert.equal((await core.calendar.update(auto1.id, { body: "edited" })).status, "pending_approval", "tier 1 is not auto-approved again");

    // an entry whose time has come, or that is cancelled, accepts no action at all
    const gone = await core.calendar.add({ campaignId: campaign.id, title: "gone", channel: "web", scheduledAt: "2020-01-01T09:00", tier: 2 });
    const goneAuto = await core.calendar.add({ campaignId: campaign.id, title: "gone auto", channel: "web", scheduledAt: "2020-01-01T10:00", tier: 1 });
    for (const e of [gone, goneAuto]) {
      await assert.rejects(core.calendar.update(e.id, { title: "x" }), /already took place, no actions allowed/);
      await assert.rejects(core.calendar.requestChanges(e.id, "note"), /already took place/);
      await assert.rejects(core.calendar.decide(e.id, "approve"), /already took place/);
      await assert.rejects(core.calendar.decide(e.id, "cancel"), /already took place/);
      await assert.rejects(core.calendar.unapprove(e.id), /already took place/);
    }
    assert.equal((await core.calendar.get(gone.id))!.status, "pending_approval", "nothing changed");
    await assert.rejects(core.calendar.decide(t1.id, "cancel"), /cancelled, no actions allowed/);
    await assert.rejects(core.calendar.unapprove(t1.id), /cancelled/);

    // sent back with a note; any edit resubmits it and clears the note
    const draft = await core.calendar.add({ campaignId: campaign.id, title: "needs work", channel: "instagram", scheduledAt: "2099-11-07T09:00", tier: 2 });
    await assert.rejects(core.calendar.requestChanges(draft.id, "  "), /empty/);
    const sent = await core.calendar.requestChanges(draft.id, "Shorter caption");
    assert.deepEqual([sent.status, sent.reviewNote], ["changes_requested", "Shorter caption"]);
    await assert.rejects(core.calendar.decide(draft.id, "approve"), /only pending_approval/);
    const again = await core.calendar.update(draft.id, { body: "Short" });
    assert.deepEqual([again.status, again.reviewNote], ["pending_approval", null]);

    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from([0, 0, 4, 56, 0, 0, 5, 70]), Buffer.from(tag)]);
    const a = await core.assets.save({ campaignId: campaign.id, bytes: png, filename: "x.png", role: "creative", origin: "generated", aiGenerated: true, provenance: { model: "test" } });
    const b = await core.assets.save({ campaignId: campaign.id, bytes: png, filename: "x.png", role: "creative", origin: "generated" });
    assert.equal(a.id, b.id, "same content in same campaign is one asset");
    assert.deepEqual([a.width, a.height], [1080, 1350]);
    assert.ok(a.storageKey.startsWith(`c/${campaign.id}/`));
    assert.deepEqual(await core.assets.read(a.id), png);
    assert.equal((await fetch(await core.assets.url(a.id))).status, 200);
    const bucketUrl = (await core.assets.url(a.id)).split("?")[0];
    assert.equal((await fetch(bucketUrl)).status, 403, "bucket is private");

    assert.equal(a.name, "x.png");
    assert.equal((await core.assets.update(a.id, { name: "renamed.png", status: "approved" })).name, "renamed.png");
    await assert.rejects(core.assets.update(a.id, { name: "  " }), /empty/);
    const used = await core.calendar.add({ campaignId: campaign.id, title: "uses asset", channel: "web", scheduledAt: "2099-11-05T10:00", tier: 1, assetId: a.id });
    await assert.rejects(core.assets.delete(a.id), /used by 1 calendar entry/);
    await core.calendar.decide(used.id, "cancel");
    await core.pool.query("update content_calendar set asset_id = null where id = $1", [used.id]);
    const signed = await core.assets.url(a.id);
    assert.equal((await fetch(signed)).status, 200);
    await core.assets.delete(a.id);
    await assert.rejects(core.assets.get(a.id), /No asset/);
    assert.equal((await fetch(signed)).status, 404, "object is removed from S3");
  } finally {
    await core.pool.query("delete from content_calendar where campaign_id in (select id from campaign where name like $1)", [`${tag}%`]);
    await core.pool.query("delete from asset where campaign_id in (select id from campaign where name like $1)", [`${tag}%`]);
    await core.pool.query("delete from campaign where name like $1 and parent_id is not null", [`${tag}%`]);
    await core.pool.query("delete from campaign where name like $1", [`${tag}%`]);
    await core.close();
  }
});

run("run-due publishes approved due entries, retries failures and parks channels without a connector", async () => {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}`;
  try {
    const base = await core.campaigns.add({ name: `${tag}-pub`, kind: "always_on" });
    const add = (title: string, channel: string, tier: 1 | 2 = 1) => core.calendar.add({ campaignId: base.id, title, channel, scheduledAt: "2020-01-01T08:00", tier });
    const ok = await add("ok", "mock");
    const bad = await add("[fail] bad", "mock");
    const manual = await add("by hand", "linkedin");
    const unapproved = await add("not approved", "mock", 2);
    const outcomes = Object.fromEntries((await runDue(core, undefined, 50)).filter((o) => [ok.id, bad.id, manual.id, unapproved.id].includes(o.id)).map((o) => [o.id, o.result]));
    assert.deepEqual(outcomes, { [ok.id]: "published", [bad.id]: "retry", [manual.id]: "needs_manual" }, "pending_approval entries are never published");
    assert.equal((await core.calendar.get(ok.id))!.externalId, `mock-bw-${ok.id}`);
    assert.equal((await core.calendar.get(unapproved.id))!.status, "pending_approval");
    // a second run right away finds nothing: the failed entry waits for its retry time, published ones are done
    assert.equal((await runDue(core, undefined, 50)).filter((o) => o.id === bad.id).length, 0);
    // after the wait it is tried again, and fails for good on the third attempt
    for (const want of ["retry", "failed"]) {
      await core.pool.query("update content_calendar set next_attempt_at = now() - interval '1 second' where id = $1", [bad.id]);
      assert.equal((await runDue(core, undefined, 50)).find((o) => o.id === bad.id)?.result, want);
    }
    const failed = (await core.calendar.get(bad.id))!;
    assert.deepEqual([failed.status, failed.attempts], ["failed", 3]);

    // a connector that needs a per-campaign target parks entries until the campaign (or its parent) has one
    const fake = { id: "needs-target", channels: ["needs-target"], targetHint: "set it", publish: async ({ target }: { target: Record<string, string> | null }) => ({ externalId: target!.chatId }) };
    const targeted = await add("targeted", "needs-target");
    const parked = (await runDue(core, [fake as never], 50)).find((o) => o.id === targeted.id);
    assert.equal(parked?.result, "needs_manual");
    const child = await core.campaigns.add({ name: `${tag}-child`, kind: "campaign", parentId: base.id });
    assert.equal(await core.channels.get(child.id, "needs-target"), null);
    await core.channels.set(base.id, "needs-target", { chatId: "@base" });
    assert.deepEqual(await core.channels.get(child.id, "needs-target"), { chatId: "@base" }, "a campaign inherits its parent's target");
    await core.channels.set(child.id, "needs-target", { chatId: "@child" });
    assert.deepEqual(await core.channels.get(child.id, "needs-target"), { chatId: "@child" }, "its own target wins");
    await core.calendar.add({ campaignId: child.id, title: "on child", channel: "needs-target", scheduledAt: "2020-01-01T08:00", tier: 1 });
    const viaChild = (await runDue(core, [fake as never], 50)).find((o) => o.title === "on child");
    assert.deepEqual([viaChild?.result, viaChild?.detail], ["published", "needs-target: @child"]);
  } finally {
    await purge(core, tag);
    await core.close();
  }
});

run("settings inherit campaign > base > global, validate, encrypt secrets and drive providers", async () => {
  await migrate(process.env.DATABASE_URL!);
  const secretKey = randomBytes(32).toString("base64");
  const core = createCore({ ...configFromEnv(), secretKey });
  const S = core.settings;
  const tag = `test-${Date.now()}-${randomBytes(3).toString("hex")}`; // unique: test files run in parallel and clean up by this prefix
  const key = "higgsfield.workspaceId";
  const prior = await S.own(null, key); // the real global value, restored at the end
  try {
    const base = await core.campaigns.add({ name: `${tag}-base`, kind: "always_on" });
    const camp = await core.campaigns.add({ name: `${tag}-c`, kind: "campaign", parentId: base.id });
    assert.deepEqual(await S.chain(camp.id), [camp.id, base.id, null]);
    await assert.rejects(S.chain("00000000-0000-0000-0000-000000000000"), /No campaign/);

    // nearest scope wins; removing an override inherits again
    await S.set(null, key, "global-ws");
    assert.deepEqual(await S.resolve(camp.id, key), { value: "global-ws", scope: null });
    await S.set(base.id, key, "base-ws");
    assert.deepEqual(await S.resolve(camp.id, key), { value: "base-ws", scope: base.id });
    await S.set(camp.id, key, "camp-ws");
    assert.deepEqual(await S.resolve(camp.id, key), { value: "camp-ws", scope: camp.id });
    await S.set(camp.id, key, "camp-ws-2"); // upsert
    assert.equal((await S.resolve(camp.id, key))!.value, "camp-ws-2");
    await S.unset(camp.id, key);
    assert.deepEqual(await S.resolve(camp.id, key), { value: "base-ws", scope: base.id });
    // a key nothing sets in the scope chain falls back to the global value if there is one (the real limits may be changed), else the default
    const limitKey = "higgsfield.maxPerGeneration";
    assert.equal((await S.resolve(base.id, limitKey))!.scope, (await S.own(null, limitKey)) === undefined ? "default" : null);
    const seen = (await S.view(camp.id)).find((v) => v.field.key === key)!;
    assert.deepEqual([seen.value, seen.source], ["base-ws", base.id]);

    // only declared keys with the right type are accepted
    await assert.rejects(S.set(base.id, "nope.key", 1), /Unknown setting/);
    await assert.rejects(S.set(base.id, "higgsfield.dailyBudget", "x" as never), /Invalid value/);
    await assert.rejects(S.set(base.id, "higgsfield.dailyBudget", Number.NaN), /Invalid value/);
    await assert.rejects(S.set(base.id, "generation.provider", "other"), /Invalid value/);
    await assert.rejects(S.set(base.id, "download.cookiesBrowser", "opera"), /Invalid value/, "only known browsers can be a download session");
    assert.equal((await S.resolve(camp.id, "download.cookiesBrowser"))!.value, (await S.own(null, "download.cookiesBrowser")) ?? "none");

    // daily budgets nest: every scope of the chain that sets one applies, the global one falls back to the default
    await S.set(base.id, "higgsfield.dailyBudget", 10);
    const budgets = await core.generation.budgets(camp.id, "higgsfield");
    assert.deepEqual(budgets[0], { scope: base.id, limit: 10 });
    assert.equal(budgets.at(-1)!.scope, null);

    // a provider with the settings of the scope it is asked for
    const host = { profilesDir: mkdtempSync(join(tmpdir(), "bw-profiles-")) };
    const { provider, config } = await core.generation.providerFor(camp.id, host);
    assert.equal(provider.id, "higgsfield");
    assert.equal(config.values.workspaceId, "base-ws");
    await assert.rejects(core.generation.providerFor(camp.id, host, "nope"), /Unknown provider/);

    // a profile gives the scope its own account folder; names cannot escape the profiles folder
    const hint = higgsfield.loginHint({ ...config, values: { profile: "acme" } });
    assert.match(hint, /HOME=".*higgsfield\/acme" higgsfield auth login/);
    assert.equal(higgsfield.loginHint({ ...config, values: {} }), "higgsfield auth login");
    assert.throws(() => higgsfield.loginHint({ ...config, values: { profile: "../x" } }), /Invalid profile name/);

    // secrets: encrypted at rest, never returned by view, unreadable with another key, refused without a key
    const fields = [...S.fields, { key: "x.token", label: "Token", group: "X", type: "string" as const, secret: true }];
    const q = async (text: string, params?: unknown[]) => (await core.pool.query(text, params)).rows;
    const sec = createSettings({ q, chain: S.chain, fields, secretKey });
    await sec.set(base.id, "x.token", "s3cret-value");
    const stored = JSON.stringify((await q("select value from setting where campaign_id = $1 and key = 'x.token'", [base.id]))[0].value);
    assert.ok(!stored.includes("s3cret-value"), "plaintext must not be stored");
    assert.deepEqual((await sec.resolve(camp.id, "x.token"))!, { value: "s3cret-value", scope: base.id });
    const hidden = (await sec.view(camp.id)).find((v) => v.field.key === "x.token")!;
    assert.deepEqual([hidden.value, hidden.isSet], [null, true]);
    const other = createSettings({ q, chain: S.chain, fields, secretKey: randomBytes(32).toString("base64") });
    await assert.rejects(other.resolve(base.id, "x.token"), /Cannot decrypt/);
    await assert.rejects(createSettings({ q, chain: S.chain, fields }).set(base.id, "x.token", "v"), /No encryption key/);
  } finally {
    if (prior === undefined) await S.unset(null, key);
    else await S.set(null, key, prior);
    await core.pool.query("delete from campaign where name like $1 and parent_id is not null", [`${tag}%`]);
    await core.pool.query("delete from campaign where name like $1", [`${tag}%`]);
    await core.close();
  }
});

test("the Instagram session id is found in a cookie jar, HttpOnly prefix and look-alikes included", () => {
  const jar = [
    "# Netscape HTTP Cookie File",
    ".example.com\tTRUE\t/\tTRUE\t0\tsessionid\tnot-instagram",
    ".instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tabc",
    "#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\t123%3Aabc%3A1\r",
  ].join("\n");
  assert.equal(sessionFromCookieJar(jar), "123%3Aabc%3A1");
  assert.equal(sessionFromCookieJar(".instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tplain"), "plain");
  assert.equal(sessionFromCookieJar("# Netscape\n.instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tabc"), null);
  assert.equal(sessionFromCookieJar(".notinstagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tx"), null, "only instagram.com and its subdomains");
  assert.equal(sessionFromCookieJar(""), null);
});

test("saved Instagram cookies become a cookie jar from a header, a cookies.txt or a bare session id", () => {
  const now = 1_800_000_000_000;
  const exp = String(1_800_000_000 + 30 * 86400);
  // the whole cookie: header, as copied from the browser's network tab
  const fromHeader = cookieJarFor("cookie: mid=AAA; ig_did=B-B; sessionid=123%3Aabc%3A1; csrftoken=zzz", now);
  assert.equal(sessionFromCookieJar(fromHeader), "123%3Aabc%3A1");
  assert.ok(fromHeader.includes(`.instagram.com\tTRUE\t/\tTRUE\t${exp}\tmid\tAAA`) && fromHeader.includes("\tig_did\tB-B"), "device cookies are kept");
  // a cookies.txt: only instagram lines, expiry rewritten (0 would mean already expired), HttpOnly prefix understood
  const txt = ["# Netscape HTTP Cookie File", ".google.com\tTRUE\t/\tTRUE\t0\tSID\tnope", "#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\t9%3Aq%3A2"].join("\n");
  const fromTxt = cookieJarFor(txt, now);
  assert.equal(sessionFromCookieJar(fromTxt), "9%3Aq%3A2");
  assert.ok(!fromTxt.includes("google") && fromTxt.includes(`\t${exp}\tsessionid`));
  // a bare session id
  assert.equal(sessionFromCookieJar(cookieJarFor("123%3Aabcdefgh%3A1%3Asig", now)), "123%3Aabcdefgh%3A1%3Asig");
  // things that are not it
  assert.throws(() => cookieJarFor("mid=AAA; csrftoken=zzz"), /no sessionid/);
  assert.throws(() => cookieJarFor("sessionid=a b"), /name=value/);
  assert.throws(() => cookieJarFor("short"), /looks wrong/);
  assert.throws(() => cookieJarFor("   "), /No Instagram cookies/);
  assert.throws(() => cookieJarFor("x".repeat(21_000)), /too long/);
});

test("higgsfield: temporary errors are repeated, and a job that may have started is never started twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-fake-hf-"));
  const state = join(dir, "state.json");
  // a fake CLI: `create` fails with the gateway error the first `failCreates` times (and records the job when `createdDespiteError`),
  // `cost` fails once, `list` shows the jobs, and can be made to fail too
  const bin = join(dir, "higgsfield");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
const [cmd, sub] = process.argv.slice(2);
const gateway = () => { console.error("Error: Higgsfield API error (HTTP 503). upstream connect error or disconnect/reset before headers. reset reason: connection termination"); process.exit(3); };
if (sub === "cost") { if (st.costFails-- > 0) { save(); gateway(); } console.log("32 credits"); }
else if (sub === "create") {
  st.creates++;
  const prompt = process.argv[process.argv.indexOf("--prompt") + 1];
  if (st.failCreates-- > 0) { if (st.createdDespiteError) st.jobs.push({ id: "job-" + st.creates, job_type: process.argv[4], created_at: new Date().toISOString(), status: "queued", params: { prompt } }); save(); gateway(); }
  st.jobs.push({ id: "job-" + st.creates, job_type: process.argv[4], created_at: new Date().toISOString(), status: "queued", params: { prompt } }); save();
  console.log(JSON.stringify([{ id: "job-" + st.creates, status: "queued" }]));
}
else if (sub === "list") { if (st.listFails) gateway(); console.log(JSON.stringify(st.jobs)); }
`);
  chmodSync(bin, 0o755);
  const setState = (o: object) => writeFileSync(state, JSON.stringify({ costFails: 0, failCreates: 0, createdDespiteError: false, listFails: false, creates: 0, jobs: [], ...o }));
  const cfg = { bin, profilesDir: dir, values: {}, retryDelayMs: 5 };
  const spec = { model: "veo3_1", prompt: "a woman says hello" };
  const creates = () => JSON.parse(readFileSync(state, "utf8")).creates;

  setState({ costFails: 2 }); // reads are repeated
  assert.equal(await higgsfield.estimate(cfg, spec), 32);
  setState({ costFails: 5 });
  await assert.rejects(higgsfield.estimate(cfg, spec), /503/, "gives up after a few tries");

  setState({ failCreates: 1 }); // the first request never created a job: it is started again, once
  assert.equal((await higgsfield.start(cfg, spec)).id, "job-2");
  assert.equal(creates(), 2);

  setState({ failCreates: 1, createdDespiteError: true }); // the request went through although the answer did not: no second job
  assert.equal((await higgsfield.start(cfg, spec)).id, "job-1");
  assert.equal(creates(), 1, "nothing was started twice");

  setState({ failCreates: 9 }); // keeps failing and no job exists: says nothing was spent
  await assert.rejects(higgsfield.start(cfg, spec), /nothing was started or spent/);
  assert.equal(creates(), 3);

  setState({ failCreates: 1, listFails: true }); // cannot tell whether a job exists: refuses to guess
  await assert.rejects(higgsfield.start(cfg, spec), /not known whether this started a job/);
  assert.equal(creates(), 1, "no blind retry when the job list cannot be read");

  setState({}); // a real error is not retried
  const bad = { ...cfg, bin: join(dir, "missing") };
  await assert.rejects(higgsfield.start(bad, spec), /cannot run/);
});
