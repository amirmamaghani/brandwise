# E-mail templates and campaign production: system design

Status: **phase 1 is built** (section 12); the rest is design. It extends the e-mail module (`docs/email.md`: providers, events, metrics) and the regulator (`docs/editor.md`) with the production side: how an e-mail is designed, written, checked, approved and archived. Facts about third-party tools (MJML, react.email, provider merge-tag syntax) must be verified when the matching part is built.

## 1. Goals and non-goals

Goals
- An agent or a person changes the look of an e-mail and sees the result at once (live preview in the app), like the Video page does for Remotion.
- Many clients and brands, one system: an agency can run campaigns for several clients with their own brand kits, audiences and approvals.
- Every e-mail that leaves can be reproduced exactly: which template version, which content, which brand, which locale, which provider dialect.
- Quality and compliance checks are code, not prompts, and they gate approval.
- Providers stay swappable. The output is plain HTML plus a small dialect for merge tags and the unsubscribe link.

Non-goals
- A drag-and-drop WYSIWYG builder. Templates are source files edited by agents and people.
- Being an ESP. Lists, consent, unsubscribe handling, bounces and deliverability stay with the provider.
- Pixel-exact rendering in every mail client. We approximate and lint; real client previews are an optional adapter later.

## 2. What agencies need, and what it means for the design

| Agency need | Design consequence |
|---|---|
| Several clients, strict separation | everything hangs on the campaign tree (client = always-on root); brand kits, templates and content inherit down the tree and are never shared sideways |
| Brand consistency | **brand kit** (design tokens: colours, fonts, spacing, logo, legal footer, social links) is separate from layout and from content |
| Reuse across campaigns | **component library** (header, hero, product grid, button, footer) and **templates** composed from it |
| Designers and copywriters work apart | template **slots** with types and limits; some regions locked, some editable; content validated against the slot schema |
| Several languages and markets (DE, CS, SK, EN) | content is **per locale** with a fallback; the layout is shared |
| Personalisation with safe fallbacks | neutral merge tags in templates, translated per provider by an adapter; every tag has a fallback |
| Approval by the client, audit | templates are **versioned and immutable once published**; every send stores the exact rendered HTML (snapshot); preview link for the client |
| QA before sending | **lint rules** (compliance, size, links, accessibility, spam), test sends, rendering previews |
| Regulated claims (finance, health) | the claims check from the roadmap runs as a lint rule on content |
| Learn what works across campaigns | metrics carry the template version, content variant, locale and link id, so reports compare versions and blocks |
| No lock-in | MJML source in, standard HTML out; export or upload to a provider-hosted template is an adapter, not the core |

## 3. Layers and the dependency rule

```
UI and agent surface (E-mail page, side-panel agent, CLI, MCP)      thin: parse, call, print
            |
Workflow      calendar entry -> approval -> scheduler -> connector       exists
            |
Production    templates, content, render, lint, snapshots               NEW (this document)
            |
Ports         TemplateStore, Renderer, LintRule, AssetHost,
              PreviewService, MergeTagDialect                            interfaces only
            |
Adapters      MJML renderer, headless-Chrome preview, S3/CDN host,
              provider dialects (Resend, sim, ...)                       replaceable
```

Rules, enforced by a test like the one for the e-mail domain:
1. **Domain (production core) is pure TypeScript**: no database, no provider, no file system, no network. It defines types, ports and pure functions.
2. **Adapters import only the domain.** They never know the calendar, the plugin or each other.
3. **Rendering is a pure function:** `render(templateVersion, content, brandKit, locale, target) -> { html, text, preheader, warnings }`. Same input, same output, cached by a content hash.
4. **Storage and I/O sit behind ports**, so the same core serves the plugin, tests and a future service.
5. **The delivery side knows nothing about templates.** Connectors receive a rendered snapshot, exactly as they receive text today.

## 4. Core concepts and data

| Concept | What it is | Mutable? |
|---|---|---|
| **Brand kit** | design tokens and fixed brand content of a client (root campaign); versioned | new version per change |
| **Component** | an MJML fragment with a props schema (button, hero, footer...) | versioned with the library |
| **Template** | MJML layout that uses components, tokens and **slots**, plus `template.json` (slot schema, locales, required checks) | draft in a working folder; **published versions are immutable** |
| **Content** | slot values for one e-mail and locale (headline, body, image, link, list items), as structured data, **not HTML** | per entry, editable until approval |
| **Render snapshot** | the final HTML and text for a template version, content, brand version, locale and target dialect, with its lint report; stored once, content-addressed | immutable |
| **Send** | existing `email_send`, now pointing at one snapshot | immutable |

Working copy: a folder per template, like the video projects (`<data dir>/email/<campaign>/<template>/`: `template.mjml`, `template.json`, `sample.json`, `assets/`). Agents and people edit files; the preview follows the folder. **Publish** snapshots the folder into the database (files, schema, hash). Entries and sends only ever reference published versions, so history is never rewritten by an edit.

Tables (names indicative): `email_brand_kit`, `email_template`, `email_template_version(template_id, version, source jsonb or object key, schema jsonb, hash)`, `email_content(entry_id, locale, slots jsonb, template_version_id)`, `email_render(id, hash, template_version_id, brand_version, locale, target, html_key, text, size, lint jsonb)`. `email_send` gets `render_id`. All tables carry the root campaign id for isolation (row level security later).

Slot types: `text` (length limits), `richtext-lite` (a few inline tags), `image` (hosted asset id, required alt), `link` (checked against the client's allowed domains), `list`, `enum`. Locked regions are simply not slots. Content that does not fit the schema cannot be saved; that is the contract between designer and copywriter, and between an editor agent and an author agent.

## 5. The render pipeline

```
content (slots) --validate against schema--> bound data
template version + components + brand tokens + bound data
        --> template engine (logic-less, escaped by default)   ---> MJML
        --> MJML compiler (adapter)                            ---> HTML (inlined, responsive)
        --> post-process: dialect (merge tags, unsubscribe), UTM + link ids, preheader, plain text
        --> snapshot (hash) --> lint --> report
```

- **Logic-less templating** (variables, conditionals, loops, no code, no helpers from agents). Agent-written templates never execute code. Output is escaped by default.
- **Targets**: `preview` (images from the local host, tags filled with sample data), `provider:<id>` (the provider's merge tags and unsubscribe tag), `text`.
- **Link ids**: every link gets a stable id (`block` and position), carried as a UTM parameter, so statistics can say which block earned the click.
- **Compiler is an adapter** (MJML first). The port allows another source format later without touching content, lint or delivery.

## 6. Quality gates (lint) and approval

Lint rules are small deterministic plugins `(snapshot, context) -> findings` with a severity (`error`, `warn`, `info`). A snapshot with an `error` cannot be approved.

Starting set: unsubscribe link present, sender identity and postal address in the footer (from the brand kit), size under about 100 KB (Gmail clips larger HTML), plain-text part present, every image has alt text and width, links valid and on the client's allowed domains, no scripts, forms or iframes, preheader present, contrast of text on background, spam-prone wording, merge tags have fallbacks, locale complete (no missing slot). Later: link status check (HTTP), claims check against the client's claims for regulated clients, accessibility depth.

Rendering previews for human and agent: a screenshot service port (`PreviewService`). The first adapter uses headless Chrome (the Remotion engine already installs one; it stays optional), later an external rendering-test service can be a second adapter. **Previews approximate; they are not a guarantee for Outlook, Gmail or Apple Mail.** The approval card shows the rendered preview and the lint report, not source code.

Test sends and seed lists are a delivery feature through the existing connector with a `test` target, so they reuse the provider's sending path.

## 7. Assets

E-mail images need **permanent public URLs**. Our S3 links are signed and expire, which would break images in e-mails already delivered.
- **`AssetHost` port:** `publish(assetId) -> { url, width, height }`. First adapter: a public bucket or CDN path with content-addressed, immutable keys (`/e/<sha256>.<ext>`), generated sizes for retina, dimensions stored.
- A snapshot references only hosted URLs. Unpublished assets fail lint.
- Brand logos are published once per brand kit version.

## 8. Providers and merge tags

Providers differ in personalisation syntax and the unsubscribe tag (`{{{RESEND_UNSUBSCRIBE_URL}}}` for Resend, another for the simulator). Templates use **neutral tokens** (`{{contact.first_name | there}}`, `{{unsubscribe_url}}`). A `MergeTagDialect` adapter per provider translates them in the post-process step and declares what the provider supports (fallback syntax, conditionals). A feature the provider lacks makes the lint report a warning for that target, never a silent break. This sits beside the e-mail adapters and reuses their capability model.

## 9. Measurement and experiments

- Events already map to a send; a send now maps to a snapshot, so every report can group by **template version, content variant, locale, link id**.
- The regulator's experiment gets a second lever: besides the subject, a **slot or a template version** (A and B differ in exactly one slot or one version). The rails stay as they are.
- Cross-campaign comparison for an agency (which hero style works for which client) reads the same tables; nothing client-specific leaves the client's root.

## 10. Security

- Slot content and agent-written templates are untrusted: logic-less engine, escaping, sanitised rich text, no scripts or forms, link allowlist, hosted images only.
- The preview is rendered in a sandboxed frame without scripts, with remote content limited to hosted assets.
- Inbound text (replies, comments) is data for agents, never instructions.
- Secrets (provider keys) never reach templates, content or agents.
- Approval is about the snapshot: editing content or the template version after approval invalidates it.

## 11. Surfaces

- **E-mail page** in the app: template picker, live preview (desktop, mobile, light and dark), lint report, version list, publish button; the **side-panel agent** that knows the open template (the same mechanism as the Video page: add `email` to the screens, context `<campaign>/<template>`).
- **CLI and MCP** (agents and people): `email template seed|list|render|lint|preview|publish|send-test`, `email content get|set`, plus the existing `email stats`.
- **Approval card** shows the snapshot preview and lint, in the Calendar page.
- A **client approval link** (signed, read-only preview with approve or comment) is a later addition on the same snapshot.

## 12. Phases

**Built so far (phase 1):** the pure core (`packages/core/src/email/templates/domain`: slots, rich-text sanitising, logic-less templating with Mustache, merge-tag dialects, lint rules, the render pipeline), the adapters (MJML and puppeteer in `packages/email-engine` as child processes, an asset host that inlines images for previews, headless Chrome from the video engine or the machine), providers expose their dialect and `sendTest`, the E-mail page (live preview that follows the folder, desktop and mobile width, findings, a plain file editor, test send), the side-panel agent for the template, and the CLI `email template ...`. **Built since (phases 2 and 3, partly 4):** brand kits and components per client, inherited down the campaign tree (`email_brand_kit`, `email_component`, Mustache partials); immutable published versions with the resolved brand and components (`email_template_version`, publish refuses while the sample has lint errors); content per entry and locale bound to a version, with content-addressed render snapshots (`email_entry`, `email_render`, `library.ts`); the approval card shows the snapshot and its lint report; a send records the snapshot (`email_send.render_id`); a public image bucket adapter (`assets.publishPublic`, content-addressed keys, images only, plugged in through the `AssetHost` port, off until the settings name a bucket); a link checker that refuses private addresses; a contrast rule; template and slot experiments through the regulator (a challenger changes one slot of the same published version).

**Still open:** the client approval link (a signed read-only preview with approve and comment), dark-mode and per-mail-client previews (an external rendering adapter), per-block statistics from link ids, export to provider-hosted templates, automation flows, per-client permissions and row level security, template sharing between clients, and the public bucket itself (infrastructure).


1. **Slice, no data model change:** MJML adapter, working folder per template, E-mail page with preview and the side-panel agent, a first set of lint rules, PNG preview for the agent, test send. Entries keep their current body.
2. **Contract:** brand kit, slot schema, content validation, immutable template versions, render snapshots, provider dialects, entries and sends referencing snapshots, hosted images, preview and lint on the approval card.
3. **Agency features:** component library and inheritance across clients, locales, link ids and per-block statistics, link checks, accessibility lint, client approval link.
4. **Optimisation:** template and slot experiments through the regulator, automation flows, export to provider-hosted templates.
5. **Scale:** external rendering-test adapter, per-client permissions and row level security, template sharing between clients.

## 13. Decisions and open points

- **Renderer:** MJML (source in, HTML out, widest client compatibility) versus a React-based one. MJML first because the port keeps the choice open; verify licence and maintenance when building.
- **Where files live:** working folders on the host (like video), published versions in Postgres and object storage. Revisit if several machines need the same working copy.
- **Image hosting:** public bucket or CDN with immutable keys is required before the first real send with images. Needs an infrastructure decision (domain, cache).
- **Preview engine:** headless Chrome from the optional video engine or its own small dependency.
- **Locales:** one snapshot per locale; fallback rules per client.
- **Per-client rails:** the regulator's rails are global defaults today; agencies will need them per client.
