import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resendProvider } from "../adapters/resend.ts";
import { memoryProvider } from "../adapters/memory.ts";
import { recipientHasher } from "../index.ts";
import { applyDialect, previewDialect, tokensIn } from "./domain/dialect.ts";
import { lint } from "./domain/lint.ts";
import { hasErrors, renderTemplate } from "./domain/render.ts";
import { validateContent } from "./domain/slots.ts";
import { htmlToText, sanitizeRichText } from "./domain/text.ts";
import { PREVIEW, type TemplateSource } from "./domain/types.ts";
import { assetHost } from "./adapters/asset-host.ts";
import { chromePreview } from "./adapters/chrome-preview.ts";
import { mjmlProcess } from "./adapters/mjml-process.ts";
import { createTemplates } from "./index.ts";
import { SEED_BRAND, SEED_CONFIG, SEED_MJML, SEED_SAMPLE } from "./seed.ts";

const recipient = recipientHasher("t");
const resend = resendProvider({ apiKey: "k", recipient });
const noImages = assetHost({ read: async () => null });
// the pipeline does not care how MJML is compiled: tests that are about the pipeline use a renderer that passes the source through
const passThrough = {
  compile: async (mjml: string) => ({
    html: mjml
      .replace(/<mj-button[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/mj-button>/g, '<a href="$1">$2</a>')
      .replace(/<mj-image[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/>/g, '<img src="$1" alt="$2" width="600">')
      .replace(/<\/?mj-[^>]*>/g, ""),
    errors: [],
  }),
};
const seed: TemplateSource = { mjml: SEED_MJML, config: SEED_CONFIG, brand: SEED_BRAND, sample: SEED_SAMPLE };

test("slots: the schema is the contract; rich text and links are made safe", () => {
  const ok = validateContent(SEED_CONFIG, SEED_SAMPLE);
  assert.deepEqual(ok.findings, []);
  const bad = validateContent(SEED_CONFIG, { subject: "x".repeat(80), headline: "", body: "<script>alert(1)</script><p onclick=\"x()\">hi</p><a href=\"javascript:alert(1)\">a</a><a href=\"https://ok.example/p?a=1&b=2\">b</a>", cta_label: "Go", cta_url: "http://insecure.example", extra: "?" });
  const rules = bad.findings.map((f) => f.message);
  assert.ok(rules.some((m) => m.startsWith("subject: is 80 characters")));
  assert.ok(rules.some((m) => m.startsWith("headline: required")) && rules.some((m) => m.startsWith("preheader: required")));
  assert.ok(rules.some((m) => m.startsWith("cta_url: must be an https")));
  assert.ok(rules.some((m) => m.startsWith("extra: not a slot")));
  const body = String(bad.value.body);
  assert.ok(!/script|onclick|javascript:/i.test(body), body);
  assert.match(body, /<a href="https:\/\/ok\.example\/p\?a=1&amp;b=2">b<\/a>/);
  assert.deepEqual(validateContent({ name: "x", slots: { hero: { type: "image" } } }, { hero: { asset: "a1", alt: "" } }).findings.map((f) => f.message), ["hero: image needs alt text"]);
  assert.equal(sanitizeRichText("1 < 2 and <b>bold</b>"), "1 &lt; 2 and <b>bold</b>");
});

test("dialect: neutral tokens become the provider's, or sample data in a preview", () => {
  const src = "Hi [[first_name|there]] / [[first_name]] / [[unsubscribe_url]]";
  assert.equal(applyDialect(src, resend.dialect!), "Hi {{{contact.first_name|there}}} / {{{contact.first_name}}} / {{{RESEND_UNSUBSCRIBE_URL}}}");
  assert.equal(applyDialect(src, previewDialect()), "Hi Alex / Alex / #unsubscribe");
  assert.equal(applyDialect("[[last_name|friend]]", previewDialect({})), "friend");
  assert.deepEqual(tokensIn(src), [{ field: "first_name", fallback: true }, { field: "first_name", fallback: false }, { field: "unsubscribe_url", fallback: false }]);
  assert.ok(memoryProvider({ recipient }).dialect!.hostedImagesRequired === false && resend.dialect!.hostedImagesRequired === true);
});

test("text: plain text keeps links and breaks lines", () => {
  assert.equal(htmlToText("<style>x{}</style><p>Hello &amp; welcome</p><p>See <a href=\"https://e.example/x\">the page</a></p><br>end"), "Hello & welcome\nSee the page (https://e.example/x)\n\nend".replace("\n\nend", "\n\nend"));
});

test("render: the seed renders for a preview and for a provider, deterministically", async () => {
  const deps = { renderer: passThrough, assets: noImages };
  const a = await renderTemplate(seed, SEED_SAMPLE, deps, { id: PREVIEW, dialect: null });
  assert.ok(a.html.includes("Hello Alex,") && a.html.includes("Three ideas for your October") && a.html.includes("#unsubscribe"));
  assert.ok(!a.html.includes("[[") && !a.html.includes("{{"));
  assert.equal(a.subject, "Three ideas for your October");
  assert.ok(!hasErrors(a), JSON.stringify(a.findings.filter((f) => f.severity === "error")));
  const again = await renderTemplate(seed, SEED_SAMPLE, deps, { id: PREVIEW, dialect: null });
  assert.equal(a.hash, again.hash, "same input, same hash");
  const r = await renderTemplate(seed, SEED_SAMPLE, deps, { id: "resend", dialect: resend.dialect! });
  assert.ok(r.html.includes("{{{contact.first_name|there}}}") && r.html.includes("{{{RESEND_UNSUBSCRIBE_URL}}}"));
  assert.notEqual(a.hash, r.hash);
  assert.ok(a.html.includes("https://example.com/ideas"), "urls are not mangled by escaping");
  assert.ok(!a.html.includes("<img"), "an optional section (the hero) is left out when its slot is empty");
});

test("lint: each rule catches what it is for", async () => {
  const deps = { renderer: passThrough, assets: noImages };
  const run = async (mjml: string, content = SEED_SAMPLE, brand = SEED_BRAND, target = PREVIEW) =>
    (await renderTemplate({ ...seed, mjml, brand }, content, deps, { id: target, dialect: target === PREVIEW ? null : resend.dialect! })).findings;
  const rules = (f: { rule: string; severity: string }[], severity = "error") => f.filter((x) => x.severity === severity).map((x) => x.rule);

  const base = await run(SEED_MJML);
  assert.deepEqual(rules(base), [], JSON.stringify(base.filter((x) => x.severity === "error")));
  assert.ok(rules(await run(SEED_MJML.replace("[[unsubscribe_url]]", "#"))).includes("unsubscribe"));
  assert.ok(rules(await run(SEED_MJML, SEED_SAMPLE, { ...SEED_BRAND, footer: { company: "X" } })).includes("footer-address"));
  assert.ok(rules(await run(SEED_MJML.replace("{{brand.footer.address}}", ""))).includes("footer-address"));
  assert.ok(rules(await run(SEED_MJML + "<script>1</script>")).includes("forbidden-tags"));
  assert.ok(rules(await run(SEED_MJML + "<img src=\"https://cdn.example/a.png\">")).includes("image-alt"));
  assert.ok(rules(await run(SEED_MJML + "<img src=\"data:image/png;base64,AAAA\" alt=\"a\" width=\"100\">"), "info").includes("image-hosted"), "inlined image is a hint in a preview");
  assert.ok(rules(await run(SEED_MJML + "<img src=\"data:image/png;base64,AAAA\" alt=\"a\" width=\"100\">", SEED_SAMPLE, SEED_BRAND, "resend")).includes("image-hosted"), "and an error for a send");
  assert.ok(rules(await run(SEED_MJML + "<a href=\"http://evil.example\">x</a>"), "warn").includes("links"));
  assert.ok(rules(await run(SEED_MJML + "<a href=\"https://evil.example\">x</a>", SEED_SAMPLE, { ...SEED_BRAND, allowedLinkDomains: ["brand.example"] })).includes("links"));
  assert.deepEqual(rules(await run(SEED_MJML + "<a href=\"https://shop.brand.example/p\">x</a>", { ...SEED_SAMPLE, cta_url: "https://brand.example/ideas" }, { ...SEED_BRAND, allowedLinkDomains: ["brand.example"] })), [], "subdomains of an allowed domain are fine");
  assert.ok(rules(await run(SEED_MJML.replace("{{{body}}}", "{{{headline}}}"))).includes("raw-slot"));
  assert.ok(rules(await run(SEED_MJML.replace("[[unsubscribe_url]]", "[[unsubscribe_url]] [[first_name]]")), "warn").includes("merge-fallback"));
  assert.ok(rules(await run(SEED_MJML, { ...SEED_SAMPLE, subject: "Act now: WINNER" }), "warn").includes("spam-words"));
  assert.ok(rules(await run(SEED_MJML, { ...SEED_SAMPLE, headline: "" })).includes("slot"));
  assert.ok(rules(await run(SEED_MJML + "x".repeat(110_000))).includes("size"));
  assert.ok(lint.length >= 1);
});

// ---- real MJML and Chrome, when installed --------------------------------------------------------------------------------------

const engine = join(import.meta.dirname, "..", "..", "..", "..", "email-engine");
const haveMjml = existsSync(join(engine, "node_modules", "mjml"));
const videoEngine = join(import.meta.dirname, "..", "..", "..", "..", "video-remotion");

test("mjml engine: the seed compiles to responsive HTML and passes lint for a preview", { skip: !haveMjml }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bw-tpl-"));
  const templates = createTemplates({ root: () => root, renderer: () => mjmlProcess(engine), preview: () => chromePreview({ enginePath: engine, videoEnginePath: videoEngine }), assets: noImages, dialectOf: (p) => (p === "resend" ? resend.dialect! : null) });
  const campaign = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(templates.list(), []);
  const d = await templates.seed(campaign, "launch");
  assert.ok(existsSync(join(d, "template.mjml")));
  await assert.rejects(templates.seed(campaign, "launch"), /already exists/);
  await assert.rejects(templates.seed("../x", "launch"), /invalid/);
  assert.deepEqual(templates.list(), [{ campaignId: campaign, id: "launch" }]);
  const before = templates.state(campaign, "launch").hash;
  const r = await templates.render(campaign, "launch");
  assert.ok(r.html.startsWith("<!doctype html>") && r.html.includes("Three ideas for your October") && r.html.includes("max-width"), r.html.slice(0, 200));
  assert.ok(!hasErrors(r), JSON.stringify(r.findings));
  assert.ok(r.size < 60_000);
  const send = await templates.render(campaign, "launch", { target: "resend" });
  assert.ok(send.html.includes("{{{RESEND_UNSUBSCRIBE_URL}}}"));
  await assert.rejects(templates.render(campaign, "launch", { target: "nope" }), /Unknown or unconfigured/);
  templates.saveFile(campaign, "launch", "sample.json", JSON.stringify({ ...SEED_SAMPLE, headline: "Changed headline" }));
  assert.notEqual(templates.state(campaign, "launch").hash, before, "an edit changes the state hash the page polls");
  assert.ok((await templates.render(campaign, "launch")).html.includes("Changed headline"));
  assert.throws(() => templates.saveFile(campaign, "launch", "sample.json", "{ not json"), /JSON/);
  assert.throws(() => templates.saveFile(campaign, "launch", "../../etc/passwd", "x"), /Not a template file/);
  writeFileSync(join(d, "template.mjml"), "<mjml><mj-body><mj-section><mj-column><mj-text>{{headline}}</mj-text></mj-column></mj-section></mj-body></mjml>");
  const stripped = await templates.render(campaign, "launch");
  assert.ok(stripped.findings.some((f) => f.rule === "unsubscribe" && f.severity === "error"), "a template without the unsubscribe link is refused by lint");
});

test("chrome preview: a picture of the e-mail", { skip: !haveMjml || !existsSync(videoEngine) }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bw-tpl-"));
  const templates = createTemplates({ root: () => root, renderer: () => mjmlProcess(engine), preview: () => chromePreview({ enginePath: engine, videoEnginePath: videoEngine }), assets: noImages, dialectOf: () => null });
  const campaign = "22222222-2222-4222-8222-222222222222";
  await templates.seed(campaign, "pic");
  const { png } = await templates.picture(campaign, "pic", { width: 640 });
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a PNG");
  assert.ok(png.length > 8_000);
});

test("dependency rule: the template domain is pure, adapters import only the domain", () => {
  const dirOf = join(import.meta.dirname);
  const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  for (const f of readdirSync(join(dirOf, "domain"))) {
    for (const i of imports(join(dirOf, "domain", f))) {
      const ok = i.startsWith("./") || i === "../../domain/types.ts" || i === "mustache" || i === "node:crypto";
      assert.ok(ok, `templates/domain/${f} imports ${i}: the domain may use only itself, the e-mail types, mustache and node:crypto`);
    }
  }
  for (const f of readdirSync(join(dirOf, "adapters"))) {
    for (const i of imports(join(dirOf, "adapters", f))) assert.ok(i.startsWith("../domain/") || i.startsWith("node:"), `templates/adapters/${f} imports ${i}`);
  }
});

test("every provider with templates has a dialect of the same shape", () => {
  for (const p of [resend, memoryProvider({ recipient })]) {
    const d = p.dialect!;
    assert.ok(d.unsubscribe.length > 3, p.id);
    assert.ok(d.token("first_name", "there").includes("first_name"), p.id);
    assert.ok(d.token("first_name").includes("first_name") && !d.token("first_name").includes("|"), `${p.id}: no fallback, no separator`);
  }
});

test("contrast: WCAG ratios and the lint rule that uses them", async () => {
  const { contrast } = await import("./domain/color.ts");
  assert.ok(Math.abs(contrast("#000000", "#ffffff")! - 21) < 0.01);
  assert.equal(contrast("#fff", "#ffffff"), 1);
  assert.equal(contrast("red", "#ffffff"), null, "only hex colours are judged");
  const deps = { renderer: passThrough, assets: noImages };
  const orange = await renderTemplate({ ...seed, brand: { ...SEED_BRAND, colors: { ...SEED_BRAND.colors, primary: "#e8590c" } } }, SEED_SAMPLE, deps, { id: PREVIEW, dialect: null });
  assert.ok(orange.findings.some((f) => f.rule === "contrast" && f.message.includes("white button text")), "a light orange button with white text is flagged");
  assert.ok(!(await renderTemplate(seed, SEED_SAMPLE, deps, { id: PREVIEW, dialect: null })).findings.some((f) => f.rule === "contrast"));
});

test("link check: extracts clickable links, reports dead ones, never calls private addresses", async () => {
  const { extractLinks, checkLinks } = await import("./domain/links.ts");
  const { fetchLinkChecker, isPrivateAddress } = await import("./adapters/fetch-link-checker.ts");
  const html = '<a href="https://a.example/x?p=1&amp;q=2">a</a><a href="https://a.example/x?p=1&amp;q=2">dup</a><a href="mailto:x@y.z">m</a><a href="#top">t</a><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">u</a><a href="https://b.example/gone">b</a>';
  assert.deepEqual(extractLinks(html), ["https://a.example/x?p=1&q=2", "https://b.example/gone"]);
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.20.0.1", "169.254.169.254", "::1", "fd12::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1"]) assert.ok(!isPrivateAddress(ip), ip);
  const called: string[] = [];
  const checker = fetchLinkChecker({
    lookup: async (host) => [{ address: host === "internal.example" ? "10.0.0.5" : "93.184.216.34" }],
    fetchImpl: (async (url: string, init: { method: string }) => {
      called.push(`${init.method} ${url}`);
      if (url.includes("gone")) return new Response("", { status: 404 });
      if (init.method === "HEAD") return new Response("", { status: 405 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const found = await checkLinks(html, checker);
  assert.deepEqual(found.map((x) => [x.severity, x.message.includes("404")]), [["error", true]], "the dead link is an error, the live one (HEAD refused, GET fine) is fine");
  assert.ok(called.includes("GET https://a.example/x?p=1&q=2"));
  assert.match((await checker.check("https://internal.example/x")).error!, /private/);
  assert.match((await checker.check("http://a.example/")).error!, /not https/);
  assert.ok(!called.some((c) => c.includes("internal.example")), "a private address is never called");
});
