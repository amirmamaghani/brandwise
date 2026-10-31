// The library against the local stack (database, S3): brand kits and components inherited down the campaign tree, immutable versions,
// bindings of entries to snapshots, the link from a send to its snapshot, and the public image bucket. Skipped without DATABASE_URL.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createCore, configFromEnv } from "../../index.ts";
import { migrate } from "../../migrate.ts";
import { runDue } from "../../publish.ts";
import { purge } from "../../testing.ts";
import { memoryProvider } from "../adapters/memory.ts";
import { createEmail, recipientHasher } from "../index.ts";
import { assetHost } from "./adapters/asset-host.ts";
import { createTemplates } from "./index.ts";
import { createLibrary } from "./library.ts";
import { SEED_MJML, SEED_SAMPLE } from "./seed.ts";

const run = process.env.DATABASE_URL && process.env.S3_BUCKET ? test : test.skip;
const passThrough = {
  compile: async (mjml: string) => ({
    html: mjml.replace(/<mj-button[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/mj-button>/g, '<a href="$1">$2</a>').replace(/<\/?mj-[^>]*>/g, ""),
    errors: [],
  }),
};

async function setup(prefix: string) {
  await migrate(process.env.DATABASE_URL!);
  const core = createCore(configFromEnv());
  const recipient = recipientHasher("lib");
  const mem = memoryProvider({ recipient, idPrefix: `${prefix}-m`, recipients: ["a@example.com", "b@example.com"] });
  const email = createEmail({ pool: core.pool, salt: "lib", extraProviders: [mem] });
  const root = mkdtempSync(join(tmpdir(), "bw-lib-"));
  const assets = assetHost({ read: async () => null });
  const dialectOf = (id: string) => (id === "memory" ? mem.dialect! : null);
  let library: ReturnType<typeof createLibrary>;
  const templates = createTemplates({ root: () => root, renderer: () => passThrough, preview: () => { throw new Error("no preview here"); }, assets, dialectOf, resolve: (c) => library.resolve(c) });
  library = createLibrary({ pool: core.pool, core, templates, renderer: () => passThrough, assets, dialectOf });
  const base = await core.campaigns.add({ name: `${prefix}-base`, kind: "always_on" });
  const child = await core.campaigns.add({ name: `${prefix}-child`, kind: "campaign", parentId: base.id });
  return { core, email, mem, templates, library, base, child, root, cleanup: async () => { await purge(core, prefix); await core.close(); } };
}

run("brand kits and components are inherited down the campaign tree, the template's own values win", async () => {
  const { library, templates, base, child, root, cleanup } = await setup(`test-${Date.now()}-brand`);
  try {
    assert.deepEqual(await library.brand.resolve(base.id), { brand: {}, hasKit: false });
    await library.brand.set(base.id, { name: "Client", colors: { primary: "#111111", text: "#222222", background: "#f3f4f6" }, footer: { company: "Client Ltd", address: "Road 1, Town" } });
    await library.brand.set(child.id, { colors: { primary: "#0b57d0" } });
    const resolved = (await library.brand.resolve(child.id)).brand;
    assert.deepEqual([resolved.name, resolved.colors?.primary, resolved.colors?.text, resolved.footer?.address], ["Client", "#0b57d0", "#222222", "Road 1, Town"], "child overrides one key, inherits the rest");
    assert.equal((await library.brand.own(base.id))!.version, 1);
    await library.brand.set(base.id, { ...(await library.brand.own(base.id))!.brand, name: "Client 2" });
    assert.equal((await library.brand.own(base.id))!.version, 2, "every change is a new version of the kit");

    // a template seeded for a client with a kit starts without brand values of its own and renders with the kit
    await templates.seed(child.id, "kit");
    assert.deepEqual(JSON.parse(readFileSync(join(root, child.id, "kit", "brand.json"), "utf8")), {});
    const r = await templates.render(child.id, "kit");
    assert.ok(r.html.includes("Client 2") && r.html.includes("Road 1, Town"), "brand name and footer come from the kit");
    writeFileSync(join(root, child.id, "kit", "brand.json"), JSON.stringify({ name: "Own name" }));
    assert.ok((await templates.render(child.id, "kit")).html.includes("Own name"), "the template's own value wins");

    // components are partials, a child's version replaces the parent's
    await library.components.set(base.id, "shout", "<mj-text>BASE {{headline}}</mj-text>");
    await assert.rejects(library.components.set(base.id, "Bad Name", "x"), /component name/);
    writeFileSync(join(root, child.id, "kit", "template.mjml"), SEED_MJML.replace("{{headline}}</mj-text>", "{{headline}}</mj-text>{{> shout}}"));
    assert.ok((await templates.render(child.id, "kit")).html.includes("BASE Three ideas"));
    await library.components.set(child.id, "shout", "<mj-text>CHILD {{headline}}</mj-text>");
    const overridden = (await templates.render(child.id, "kit")).html;
    assert.ok(overridden.includes("CHILD Three ideas") && !overridden.includes("BASE Three"));
    assert.equal(await library.components.remove(child.id, "shout"), true);
  } finally { await cleanup(); }
});

run("published versions are immutable; entries bind to them, with a snapshot of exactly what was rendered", async () => {
  const { core, library, templates, base, child, root, cleanup } = await setup(`test-${Date.now()}-ver`);
  try {
    await library.brand.set(base.id, { name: "Client", colors: { primary: "#0b57d0", text: "#1f2937", background: "#f3f4f6" }, footer: { company: "Client Ltd", address: "Road 1, Town" } });
    await core.channels.set(base.id, "email", { provider: "memory", from: "Client <news@example.com>" });
    await templates.seed(base.id, "news");

    // a template that fails lint cannot be published
    const mjmlPath = join(root, base.id, "news", "template.mjml");
    writeFileSync(mjmlPath, SEED_MJML.replace("[[unsubscribe_url]]", "#"));
    await assert.rejects(library.versions.publish(base.id, "news", "t"), /Not published[\s\S]*unsubscribe/);
    writeFileSync(mjmlPath, SEED_MJML);

    const v1 = await library.versions.publish(base.id, "news", "t", "first");
    assert.deepEqual([v1.created, v1.version.version, v1.version.note], [true, 1, "first"]);
    assert.equal((await library.versions.publish(base.id, "news", "t")).created, false, "the same content is not a new version");
    writeFileSync(mjmlPath, SEED_MJML.replace('font-size="28px"', 'font-size="30px"'));
    const v2 = await library.versions.publish(base.id, "news", "t");
    assert.deepEqual([v2.created, v2.version.version], [true, 2]);
    assert.ok((await library.versions.find(child.id, "news", 1))!.files.mjml.includes("<mjml"), "found from a child campaign (inherited)");
    assert.equal((await library.versions.find(child.id, "news"))!.version, 2, "latest by default");
    assert.ok(!(await library.versions.find(base.id, "news", 1))!.files.mjml.includes('font-size="30px"') && (await library.versions.find(base.id, "news", 2))!.files.mjml.includes('font-size="30px"'), "version 1 never changes");
    assert.equal((await library.versions.list(base.id, "news")).length, 2);

    // create an entry from the template: tier 2 waits for approval, the body is the rendered HTML in the provider's dialect
    const content = { ...SEED_SAMPLE };
    const made = await library.entries.create({ campaignId: child.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), tier: 2, templateId: "news", version: 1, content, createdBy: "t" });
    assert.deepEqual([made.entry.status, made.entry.title, made.version.version], ["pending_approval", SEED_SAMPLE.subject, 1]);
    assert.ok(made.entry.body.includes("{{unsubscribe}}") && made.entry.body.includes("Hello {{first_name|there}},"), "rendered for the memory provider's dialect");
    assert.equal((await library.entries.get(made.entry.id))!.render.hash, made.render.hash);
    await core.calendar.decide(made.entry.id, "approve");

    // changing the content makes a new snapshot and sends the entry back for approval; the old snapshot stays as it was
    const changed = await library.entries.bind({ entryId: made.entry.id, templateId: "news", version: 2, content: { ...content, headline: "A different headline" } });
    assert.equal(changed.changed, true);
    assert.notEqual(changed.render.id, made.render.id);
    assert.equal((await core.calendar.get(made.entry.id))!.status, "pending_approval", "a content change needs a new approval");
    assert.ok((await library.snapshots.get(made.render.id))!.html.includes("Three ideas for your October"), "the first snapshot is untouched");
    assert.equal((await library.entries.bind({ entryId: made.entry.id, templateId: "news", version: 2, content: { ...content, headline: "A different headline" } })).changed, false, "the same input binds to the same snapshot");

    // refused: content that breaks the schema, a locale the template does not have, a template that is not published
    await assert.rejects(library.entries.bind({ entryId: made.entry.id, templateId: "news", content: { ...content, subject: "" } }), /Not bound[\s\S]*subject/);
    await assert.rejects(library.entries.bind({ entryId: made.entry.id, templateId: "nope", content }), /not published/);
    writeFileSync(join(root, base.id, "news", "template.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(root, base.id, "news", "template.json"), "utf8")), locales: ["en", "cs"] }));
    await library.versions.publish(base.id, "news", "t");
    await assert.rejects(library.entries.bind({ entryId: made.entry.id, templateId: "news", locale: "de", content }), /Locale "de"/);
    const cs = await library.entries.bind({ entryId: made.entry.id, templateId: "news", locale: "cs", content });
    assert.equal(cs.render.locale, "cs");
  } finally { await cleanup(); }
});

run("a send records the snapshot it sent", async () => {
  const { core, email, library, templates, base, child, cleanup } = await setup(`test-${Date.now()}-send`);
  try {
    await library.brand.set(base.id, { name: "Client", colors: { primary: "#0b57d0", text: "#1f2937", background: "#f3f4f6" }, footer: { company: "Client Ltd", address: "Road 1, Town" } });
    await core.channels.set(base.id, "email", { provider: "memory", from: "Client <news@example.com>" });
    await templates.seed(base.id, "news");
    await library.versions.publish(base.id, "news", "t");
    const made = await library.entries.create({ campaignId: child.id, scheduledAt: new Date(Date.now() - 60_000).toISOString(), tier: 1, templateId: "news", content: SEED_SAMPLE, createdBy: "t" });
    const out = (await runDue(core, [email.connector(library.entries.renderIdFor)], 5, [child.id])).find((o) => o.id === made.entry.id);
    assert.equal(out?.result, "published", out?.detail);
    const row = (await core.pool.query("select render_id from email_send where entry_id = $1", [made.entry.id])).rows[0];
    assert.equal(row.render_id, made.render.id, "the send points at the exact snapshot that was approved");
  } finally { await cleanup(); }
});

run("images go to the public bucket once, under a permanent content-addressed address", async () => {
  const prefix = `test-${Date.now()}-pub`;
  await migrate(process.env.DATABASE_URL!);
  const cfg = configFromEnv();
  const core = createCore(cfg);
  const s3 = new S3Client({ region: cfg.s3.region, endpoint: cfg.s3.endpoint, forcePathStyle: cfg.s3.forcePathStyle, credentials: { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey } });
  const bucket = `bw-public-test-${Date.now()}`;
  let key = "";
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const campaign = await core.campaigns.add({ name: `${prefix}-c`, kind: "always_on" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const asset = await core.assets.save({ campaignId: campaign.id, bytes: png, filename: "pixel.png", role: "brand", origin: "uploaded" });
    const url = await core.assets.publishPublic(asset.id, { bucket, baseUrl: "https://cdn.example.com/" });
    assert.match(url, new RegExp(`^https://cdn\\.example\\.com/e/${asset.sha256}\\.png$`));
    key = url.replace("https://cdn.example.com/", "");
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.equal(await core.assets.publishPublic(asset.id, { bucket, baseUrl: "https://cdn.example.com" }), url, "publishing again is a no-op with the same address");
    const doc = await core.assets.save({ campaignId: campaign.id, bytes: Buffer.from("%PDF-1.4"), filename: "private.pdf", role: "source", origin: "uploaded" });
    await assert.rejects(core.assets.publishPublic(doc.id, { bucket, baseUrl: "https://cdn.example.com" }), /Only images/);

    // an e-mail for a real provider takes the public address of a stored image instead of failing
    const host = assetHost({ read: async () => null, publish: (id) => core.assets.publishPublic(id, { bucket, baseUrl: "https://cdn.example.com" }) });
    assert.equal((await host.resolve(asset.id, false)).src, url);
  } finally {
    if (key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
    await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
    await purge(core, prefix);
    await core.close();
  }
});
