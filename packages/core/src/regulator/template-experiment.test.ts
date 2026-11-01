// An experiment that varies a slot of a published template (not only the subject): the editor's task carries the template and the base
// content, the author changes one slot, the system builds both arms from the same version. Needs the local stack, skipped without.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCore, configFromEnv } from "../index.ts";
import { migrate } from "../migrate.ts";
import { runDue } from "../publish.ts";
import { purge } from "../testing.ts";
import { assetHost } from "../email/templates/adapters/asset-host.ts";
import { createEmail } from "../email/index.ts";
import { createTemplates } from "../email/templates/index.ts";
import { createLibrary, type Library } from "../email/templates/library.ts";
import { SEED_SAMPLE } from "../email/templates/seed.ts";
import { createRegulator } from "./index.ts";
import { regulatorStore } from "./store.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const passThrough = { compile: async (mjml: string) => ({ html: mjml.replace(/<mj-button[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/mj-button>/g, '<a href="$1">$2</a>').replace(/<\/?mj-[^>]*>/g, ""), errors: [] }) };
const HOUR = 3_600_000;

run("an experiment can vary a slot of a published template", async () => {
  const prefix = `test-${Date.now()}-tplexp`;
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const rstore = regulatorStore(core.pool);
  const before = await rstore.clockOffset();
  await rstore.setClockOffset(0);
  try {
    const email = createEmail({ pool: core.pool, salt: "tplexp", sim: { now: async () => new Date(Date.now() + (await rstore.clockOffset()) * 1000) } });
    const dialectOf = (id: string) => email.providers.find((p) => p.id === id)?.dialect ?? null;
    let library: Library;
    const assets = assetHost({ read: async () => null });
    const root = mkdtempSync(join(tmpdir(), "bw-exp-"));
    const templates = createTemplates({ root: () => root, renderer: () => passThrough, preview: () => { throw new Error("none"); }, assets, dialectOf, resolve: (c) => library.resolve(c) });
    library = createLibrary({ pool: core.pool, core, templates, renderer: () => passThrough, assets, dialectOf });
    const reg = createRegulator({ core, email, library: () => library });

    const base = await core.campaigns.add({ name: `${prefix}-base`, kind: "always_on" });
    await library.brand.set(base.id, { name: "Client", colors: { primary: "#0b57d0", text: "#1f2937", background: "#f3f4f6" }, footer: { company: "Client Ltd", address: "Road 1, Town" } });
    const arms: Record<string, string> = {};
    for (const [tag, seed] of [["A", "ta"], ["B", "tb"]] as const) {
      const c = await core.campaigns.add({ name: `${prefix}-arm-${tag}`, kind: "campaign", parentId: base.id });
      await core.channels.set(c.id, "email", { provider: "sim", from: "Lab <lab@example.com>", audienceSize: "300", seed });
      arms[tag] = c.name;
    }
    await templates.seed(base.id, "news");
    await library.versions.publish(base.id, "news", "t");

    const params = (role: string) => ({ arm: arms[role === "control" ? "A" : "B"], role, tier: 1, template: { id: "news" }, content: SEED_SAMPLE });
    const control = await reg.tasks.create(base.id, "editor", { kind: "write_variant", brief: "control", params: params("control") });
    const challenger = await reg.tasks.create(base.id, "editor", { kind: "write_variant", brief: "challenger", params: params("challenger") });
    await reg.tasks.claim(control.id, "author"); await reg.tasks.claim(challenger.id, "author");

    // the challenger must really differ, by a slot or by the subject
    await assert.rejects(reg.tasks.submitVariant(challenger.id, {}, "author"), /must differ/);
    await assert.rejects(reg.tasks.submitVariant(challenger.id, { content: { cta_url: "http://insecure.example" } }, "author"), /Not created[\s\S]*cta_url/);
    const a = await reg.tasks.submitVariant(control.id, { subject: "ignored for the control" }, "author");
    const b = await reg.tasks.submitVariant(challenger.id, { content: { cta_label: "Start now" } }, "author");
    const entryA = (a.result as { entry: string }).entry, entryB = (b.result as { entry: string }).entry;
    const [ea, eb] = [await core.calendar.get(entryA), await core.calendar.get(entryB)];
    assert.equal(ea!.title, eb!.title, "same subject: only the button label differs");
    assert.ok(ea!.body.includes("See the ideas") && eb!.body.includes("Start now") && !eb!.body.includes("See the ideas"));
    assert.deepEqual([ea!.campaignId === eb!.campaignId, (await library.entries.get(entryA))!.version.version], [false, 1]);

    // both arms go out through the e-mail connector with their snapshots, then the rails judge the experiment as for any other
    const sent = await runDue(core, [email.connector(library.entries.renderIdFor)], 10, [ea!.campaignId, eb!.campaignId]);
    assert.deepEqual(sent.map((o) => o.result).sort(), ["published", "published"]);
    const renders = (await core.pool.query("select render_id from email_send where entry_id = any($1)", [[entryA, entryB]])).rows.map((r) => r.render_id);
    assert.equal(new Set(renders).size, 2, "each send points at its own snapshot");
    const exp = await reg.experiments.propose({ campaignId: base.id, hypothesis: "A clearer button label raises the click rate", lever: "cta_label: see the picks -> start now", armA: entryA, armB: entryB, createdBy: "editor" });
    assert.equal((await reg.experiments.evaluate(exp.id)).verdict, "wait");
    await reg.clock.advance(25 * HOUR);
    const done = await reg.experiments.evaluate(exp.id);
    assert.ok(done.final && ["A", "B", "inconclusive"].includes(done.verdict), done.verdict);
  } finally {
    await rstore.setClockOffset(before);
    await purge(core, prefix);
    await core.close();
  }
});
