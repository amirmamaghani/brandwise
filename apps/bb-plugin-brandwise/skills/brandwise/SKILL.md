---
name: brandwise
description: Manage BrandWise campaigns, the content calendar and assets with the `bb brandwise` CLI. Use when the user asks to schedule, approve, cancel or review posts, emails or pages, to register or look up creatives and images, or to create campaigns.
---

# BrandWise

Data lives in Postgres (campaigns, calendar, asset records) and S3 (the files). The Calendar and Creatives pages in the BB sidebar and `bb brandwise` read and write the same data.

The calendar is the only way anything leaves the system: never publish directly, add an entry.

## Campaigns

A campaign is the unit that content belongs to. An **always-on** campaign is the evergreen base of a brand or a product (no end date): it holds the logo, brand rules and permanent assets. A **campaign** is a time-bound run under it (dates) and inherits the base's look; its creatives and calendar entries belong to it alone.

| Command | Effect |
| --- | --- |
| `bb brandwise campaign list` | Campaigns with ids. |
| `bb brandwise campaign add "<name>" --kind <always_on\|campaign> [--parent <campaign>] [--from <date> --to <date>]` | Create one. Time-bound campaigns take a parent. |

| `bb brandwise campaign assign <thread-id> <campaign>` | Link a bb thread to a campaign (the sidebar of the Campaigns page groups threads by it). Use your own thread id when you start work on a campaign. |
| `bb brandwise campaign unassign <thread-id>` | Remove the link. |

Wherever `--campaign <c>` is accepted, `<c>` is an id or a name. It may be left out only when exactly one campaign exists.

## Calendar

| Command | Effect |
| --- | --- |
| `bb brandwise calendar list [--campaign <c>]` | Entries: id, time (UTC), channel, tier, status, campaign. |
| `bb brandwise calendar add "<title>" --channel <c> --at <ISO date> --tier <1\|2\|3> [--campaign <c>] [--asset <asset-id>] [--body "<text>"] [--link <url>] [--brief-id <id> --applies <ids> --tests <id> --tag <key=value,...>]` | Add an entry. `--body` is the text exactly as it will be published (caption, e-mail text), `--link` an http(s) URL. A reviewer approves what they can read, so always fill the body. Tier 1 is approved automatically, tiers 2 and 3 wait for a human. Cite the brief you wrote from and the learnings you apply (see "Before you write content"). |
| `bb brandwise calendar edit <id> [--title <t>] [--body "<text>"] [--link <url>] [--channel <c>] [--at <ISO date>] [--asset <asset-id>]` | Change an entry. Changing title, text, link, channel or creative of an approved tier 2 or 3 entry sends it back for approval; moving the time does not. Published and cancelled entries cannot be edited. |
| `bb brandwise calendar request-changes <id> "<note>" [--reason claims\|facts\|tone\|brand\|visual\|legal\|typo\|offer\|other]` | Send a pending entry back to its author with a note (what a human uses when they do not approve as is). |
| `bb brandwise calendar history <id>` | Every action on the entry: who did what and when, every send-back note. |
| `bb brandwise calendar unapprove <id>` | Take an upcoming approved entry back to `pending_approval`. Approving it again is a manual step for a human, also for tier 1. |
| `bb brandwise calendar approve <id>` | Approve a pending entry. Do this only when the user says so. |
| `bb brandwise calendar cancel <id>` | Cancel an entry. |

An entry whose publish time has come (now counts) accepts no action at all: not edit, request-changes, approve, unapprove or cancel; the command fails with "already took place, no actions allowed". Cancelled and published entries accept none either. Check the time before you act.

An entry with status `changes_requested` was sent back by a human: `calendar list` prints their note under it. Revise it with `calendar edit` (any edit resubmits it for approval) and do not argue with the note; if it cannot be done as asked, say why in your reply to the user.

Times without an offset are read in the server's local time and shown in UTC.

## Before you write content

Run `bb brandwise brief --campaign <c> --channel <ch> [--at <ISO date of the entry>]` first. It prints, from code:

- **Learnings in force** (E1 = an experiment verdict, E2 = a pattern over many entries), strongest first: apply them.
- **Do not test again**: levers where no difference was found at this audience size.
- **Candidates** (E3): ideas to try only in an explore slot or as an experiment, never as fact.
- **Style rules** from the reviewer (confirmed by a person) and the latest send-back notes: keep them.
- Whether this is an **exploit** slot (apply what is known) or an **explore** slot (try one untested idea).

When you add the entry, pass `--brief-id <id> --applies <learning ids>` and, in an explore slot, `--tests <id>`; tag what you chose with `--tag hook=question,offer=free_trial` (keys: hook, angle, offer, visual_style, cta, subject_style, tone, template). The reviewer sees what you declared. Subject features, format, length and send time are tagged by code.

| Command | Effect |
| --- | --- |
| `bb brandwise learnings list [--campaign <c>] [--status active\|needs_retest\|proposed] [--evidence E1\|E2\|E3]` | What the brand has learned, with evidence and status. |
| `bb brandwise learnings add "<observation>" [--lever "attribute: from -> to"] [--campaign <c>]` | Note an observation as E3 (a candidate to test). E1 and E2 are written by code only. |
| `bb brandwise learnings propose-preference "<rule>" --from-entries <ids>` | Propose a rule drawn from a person's send-backs of those entries; it is in force once the person confirms it. |

## Paid media

Buying ads, boosting a published post and changing a running budget are calendar entries on channel `ads`, always tier 3: a person approves every one, and the money moves only when its time comes.

| Command | Effect |
| --- | --- |
| `bb brandwise ads order --name "<ad>" --budget <n> --days <n> --at <ISO> [--body "<ad text>"] [--link <url>] [--asset <id>] [--boost <published entry>] [--order <live order> (budget change)] [--campaign <c>]` | Draft an order. Refused at once when it breaks the brand's ads limits (per order, per day, per month); unset limits buy nothing. The limits are checked again right before payment. |
| `bb brandwise ads list [--campaign <c>]` | Per ad: spend, CTR, CPC, frequency, fatigue, our leads, CPL (fully loaded when production is over 10 % of the spend), ROAS. Platform conversions are the platform's own count: indicative. |
| `bb brandwise ads pause <entry>` | Stop a live ad (allowed to agents: it only stops spending). |

You never see a payment method, a card or a token, and you never set the limits. Prefer big creative differences over variations, and judge an ad by our leads and their quality, not by its clicks.

## Results and costs (read-only)

| Command | Effect |
| --- | --- |
| `bb brandwise results costs [--campaign <c>] [--since 30d]` | What a campaign cost, by kind (generation, media, review minutes, e-mail sends, LLM share, incentives, tools), at the brand's prices; what cannot be priced yet says what it needs. |
| `bb brandwise results formats [--campaign <c>]` | Creative economics per format: everything generated (rejected and failed included) over the assets that made it into an approved entry. |
| `bb brandwise results production [--campaign <c>]` | First-pass approval, send-backs per entry, time to approval, send-back reasons. |
| `bb brandwise results economics [--campaign <c>]` | The economics profile and its ceilings (break-even ROAS, value per lead, CPL max), with what is missing. |
| `bb brandwise results funnel [--campaign <c>] [--since 30d]` | Leads, qualified, won, orders and revenue as ranges (last click .. with promo codes and self-reports), CPL, CPQL, CAC and MER next to the ceilings. Decide on the range, never on one end of it. Without a lead source leads are unknown, not zero. |
| `bb brandwise results sources [--campaign <c>]` | The brand's lead sources and how many leads each received. |

A fully loaded cost per lead of a single organic creative is not a metric (too few leads per creative); compare formats and attributes over many entries. Setting the economics profile and stating costs (media spend, invoices) is a person's, on the Results page; generation spend is recorded by the system.

A single send is not evidence: never cite the result of one entry as a reason. Confirming or retiring a learning (Results page only), goals, budgets and approvals are the user's.

## Assets

| Command | Effect |
| --- | --- |
| `bb brandwise assets add <file> [--campaign <c>] [--role creative\|source\|brand\|reference] [--origin generated\|uploaded\|imported] [--ai] [--provenance '<json>']` | Upload a file to S3 (key by content hash) and record it. The same content in the same campaign is one asset. |
| `bb brandwise assets download <url> [--campaign <c>]` | Download a video from Instagram, TikTok or YouTube (https links only). Runs on the host outside the agent's sandbox, registers it as a `reference` asset with caption, author and source in the provenance, and prints the local path. Third-party content: reference only, never republish. |
| `bb brandwise assets download-photos <instagram profile or post url> [--campaign <c>] [--limit 12]` | Download photos (not videos; for a reel use `assets download`) of an Instagram profile or post with gallery-dl, at most 40, registered as `reference` assets; prints the local paths. Instagram shows photos to signed-in sessions only: without a session it answers "user could not be found". The session is the user's Instagram connection under Settings > Providers > Downloads, for a campaign or globally (one click: Import from browser; stored encrypted; Test shows whether it works). When a download fails like that, tell the user to connect Instagram; never import, pass or choose a session yourself (`--cookies` is refused). `bb brandwise instagram test [--campaign <c>]` checks the connection without downloading anything. Photos of a real person are reference only: they do not allow generating that person's likeness without their written consent. |
| `bb brandwise doctor` | Are the host tools there (yt-dlp, gallery-dl, ffmpeg, higgsfield) and is the database configured; prints the install command for what is missing. |
| `bb brandwise assets list [--campaign <c>]` | Assets with ids. |
| `bb brandwise assets url <asset-id> [--seconds 300]` | Short-lived signed link. The bucket itself is private. |

Approved entries are published automatically when their time comes (a bb automation runs `calendar run-due` every minute). Channels with a connector are `telegram` (text, image or video) and `mock` (tests). Where a campaign publishes is its channel target: `bb brandwise campaign channel set telegram chatId=@channel [--campaign <c>]` (also `list`, `unset`); a campaign without one uses its parent's, and an entry whose campaign has none waits as "Publish by hand" with that command as the hint. The bot token is one global setting, you never see it; any other channel ends as "Publish by hand" in the calendar. A failed publish is retried twice, then shown as Failed with the reason.

## E-mail campaigns

Channel `email`. The entry's **title is the subject**, **body is the e-mail** (plain text becomes paragraphs; start it with `<` to write HTML; an unsubscribe link is always added), **link** and every link in the body get UTM parameters (`utm_content` is the entry id, so a lead from the e-mail is traced to it; Telegram posts too). When the entry is approved and its time comes it is created as a campaign at the provider and sent to the campaign's audience: nobody can send without approval, and you never choose the audience. The audience and sender are the campaign's email target, set by a human (`bb brandwise campaign channel set email provider=resend segmentId=<id> from="Name <news@domain>"`); without it the entry waits as "Publish by hand". Claims in finance e-mail (returns, "risk-free", leverage) must be checked by the client: write nothing that is not in the client's claims, and use tier 3 for such e-mail.

Results: `bb brandwise email stats <entry-id>` (or `--campaign <c>`): delivered, bounces, complaints, opens, clicks, click rate. What the results taught is in `bb brandwise brief`, not in single sends. Same numbers whichever provider sent it; a metric the provider cannot report shows "n/a", never 0. Opens are indicative only (privacy proxies inflate them): judge by clicks.

Always pass `--ai` for AI-generated images or video, and put model, prompt, job id and cost into `--provenance`. After creating a creative, show it in chat with `::creative{ids="<asset-id>[,<asset-id>...]"}` on its own line (outside any code fence): it renders the Creatives tile and opens the same preview dialog.

Add `--json` when the output drives code.

## Generating creatives (providers)

Generate directly, never by starting a thread, and never by running a provider's own CLI (it needs the network and the account of the campaign, which only the plugin has). Credits are spent, so every call checks the price first. Which provider generates (Higgsfield today), with which account and workspace, and the limits come from the settings of the campaign: its own, else its always-on base's, else global (`bb brandwise config list --campaign <c>` shows them and where each comes from; `bb brandwise providers status --campaign <c>` says whether its account is signed in). Pass `--campaign` to `creative cost` too, otherwise the global settings are used.

| Command | Effect |
| --- | --- |
| `bb brandwise creative models [--video\|--image] [--campaign <c>]` | The models the provider offers. |
| `bb brandwise creative model <model-id> [--campaign <c>]` | The parameters of one model and which media it takes. Read this before using a model you have not used. |
| `bb brandwise creative cost --prompt "<text>" [--campaign <c>] [--model ..] [same flags as generate]` | Estimate in the provider's unit (credits); spends nothing. Shows the per-generation limit and every daily budget that applies. |
| `bb brandwise creative generate --prompt "<text>" --campaign <c> [--model ..] [--aspect ..] [--resolution ..] [--ref <image>]... [--start-image <image>] [--end-image <image>] [--video-ref <file>]... [--audio-ref <file>]... [--duration <n>] [--param name=value]... [--name <n>] [--role creative\|source] [--max-credits N] [--wait-seconds 18]` | Checks cost and limits, starts the job, waits up to `--wait-seconds`, and registers the result as an AI-flagged asset (model, prompt, job id, cost in provenance). |
| `bb brandwise creative collect <job-id> [--wait-seconds 18]` | Finish a job that was still running; safe to repeat (same asset). |

### Which media a model takes

The model decides, not the command: a flag the model does not have fails with "Model does not accept --image-references" before anything is spent. Look it up with `creative model <id>`; the common cases (Higgsfield, Oct 2026):

| Model | Media | Parameters |
| --- | --- | --- |
| Image models (`nano_banana_pro`, ...) | `--ref` reference images (up to 14), e.g. a character sheet | `--aspect` (4:5, 9:16, ...), `--resolution` 1k, 2k or 4k |
| Veo 3.1 (`veo3_1`), Kling 3.0 (`kling3_0`) | **No `--ref`.** The first frame is `--start-image` (Kling also `--end-image`) | `--aspect` 9:16 or 16:9 (Veo has no 1:1), `--duration` (Veo 4, 6 or 8; Kling a number, default 5), Kling `--param sound=on\|off`, `--param mode=std\|pro\|4k`, Veo `--param quality=basic\|high\|ultra` |
| Seedance 2.0 (`seedance_2_0`) | `--ref` (up to 9 images counting the frames), `--start-image`, `--end-image`, `--video-ref` (up to 3), `--audio-ref` (up to 3) | `--duration`, `--resolution`, `--param generate_audio=true\|false`, `--param mode=std\|fast` |
| Genjutsu (`hf_mult_motion_control`) | `--ref` at least one image (who), `--video-ref` exactly one clip (the motion): puts that person into the clip | `--resolution` 480p, 720p or 1080p |

- Instagram reels and stories are `--aspect 9:16`. Speech in a Veo or Kling clip goes into the prompt in quotes, with the language named ("says in Russian: \"...\"").
- Seen prices: an image about 2 credits, Kling 5 s 10, Veo 8 s 32, Genjutsu 480p about 3 per second. Always `creative cost` with the same flags first; the price depends on duration, mode and resolution.
- Media arguments are files (images, video, audio; for example a thread attachment path) or ids of files already uploaded to the provider. Anything else is refused.

### Keeping one character consistent across clips

1. Make a still of the character in the scene with an image model and the character sheet as `--ref` (cheap). Register it, show it with `::creative{...}` and let the user approve the look.
2. Animate the approved still: `--start-image <still>` on Veo or Kling. A video model never sees the character sheet, only the first frame, so the still has to carry the look (face, hair, clothes).
3. Several clips of the same scene: reuse the same still, scene description and wording, change only what happens.
4. To put a real person from photos into an existing clip, use Genjutsu instead.

### Waiting, limits, mistakes

- A video takes minutes. `--wait-seconds` is capped at 20 (over MCP `run` a snippet is stopped after 25 s), so a video almost always returns `pending`: call `creative collect <job-id>` again, as often as needed. Never run `generate` again for the same clip, that spends again.
- Refused before any spend: price over the per-generation limit (`<provider>.maxPerGeneration`; `--max-credits` can only lower it) or over any daily budget of the campaign's chain (`<provider>.dailyBudget`: the campaign's, its base's and the global one each count the spend under them). Say what blocks it and let the user decide.
- Limits, accounts and the provider are the operator's settings: `config set` and `config unset` are for the user, never change them yourself to get a job through.
- If a job ends as failed, credits may still have been used; report it, do not retry blindly.
- A temporary error from Higgsfield (HTTP 502, 503 or 504, "upstream connect error", "connection termination") is on their side. The plugin repeats reads (cost, status, polling) by itself, and before it starts a job again it checks Higgsfield's job list, so it never starts the same generation twice. What the error text says is final: "nothing was started or spent" means you may run the same command again after a few minutes (once, not in a loop); "it is not known whether this started a job" means do not retry, tell the user to check the Higgsfield job list.
- The returned asset id can go into `calendar add --asset <id>`; show the result in chat as described in AGENTS.md.
- Generated people are AI content: the asset is flagged `--ai` automatically, and the post must say so. Do not have an AI character speak as a real, named person unless that person has agreed in writing.

## Display mode

| Command | Effect |
| --- | --- |
| `bb brandwise mode` | Show the current mode (`full` or `minimal`) and what it changed. |
| `bb brandwise mode apply` | Re-apply it (idempotent). |
| `bb brandwise mode set <name>` | Switch mode, only to one the operator allows (`BW_MODES`). |

Users switch it in Settings > BrandWise display mode. Do not switch it unless the user asks; Minimal hides Plugins, Skills, git and the code editor.

## Tiers

1. Reports, drafts, rotation inside the budget cap: automatic.
2. Publishing content, budget change inside the cap, reply to a customer: one click.
3. New market or channel, claims about price, warranty or subsidies, budget above the cap: manual.

If unsure, use the higher tier.

## Rules

- Run `calendar list` or `campaign list` before changing anything; use the printed ids, never guess.
- Never approve an entry yourself unless the user explicitly asks.
- If a command says "Not configured", the instance needs `infra/bb-instance/provision.sh apply`.

## Video (full Remotion projects)

A video project is a normal Remotion project, one folder per project: `~/.bb-brandwise/video/<campaign id>/<project id>/`. You write it; the user can open the same folder in Remotion Studio on the **Video** page (or `video studio`). Needs the optional `@brandwise/video-remotion` package (setting `videoEnginePath`).

1. `bb brandwise video seed --template <id> --campaign <c>` copies a working example (`index.ts`, `src/Root.tsx`, `src/PostReel.tsx`, `public/`). Use `--dir <empty dir>` for a folder anywhere else.
2. Edit it like any Remotion project: several `<Composition>`s in `src/Root.tsx`, any components, `public/` for images/audio/video loaded with `staticFile()`. Every `@remotion/*` package installed in the engine is available (`remotion`, `@remotion/transitions`, `shapes`, `noise`, `motion-blur`, `layout-utils`, `paths`, `media-utils`, `captions`, `google-fonts`). Do not add dependencies; ask the user. Give every composition `defaultProps` with a default for every prop: renders reject unknown props and wrong types.
3. `video compositions --template <id> --campaign <c>` lists ids, sizes, durations and defaultProps; it also shows whether the project builds.
4. `video preview --template <id> --campaign <c> [--composition <id>] [--props '<json>'] [--frame N]` renders one frame to a PNG creative. The command prints `file <path>`: open that PNG (Read it) and look at it before you report anything as done. Check for clipped or overflowing text, empty scenes and wrong colours. Frame 0 is often blank because things animate in, so pass `--frame` in the middle of each scene.
5. `video render ... [--name <n>]` renders an MP4 creative. If it prints "Still rendering", run `video collect <job-id>`. Max 2 renders at once, 4096 px per side and 3840x2160 pixels at most, 60 fps, 120 s.
6. A prop `<name>Asset: "<asset id>"` is replaced by `<name>Url` (signed URL) in the component; the output is marked AI-generated if any input asset is.
7. Show the result with `::creative{ids="<id>"}`. Flags apply to `--dir <folder>` as well as `--template`.

## E-mail templates

A template is a folder per campaign (`<data dir>/email-templates/<campaign id>/<template id>/`), the same folder the E-mail page shows live. Four files:
- `template.mjml`: the layout in [MJML](https://mjml.io). Slots are written `{{slot}}` (escaped); `{{{slot}}}` only for `richtext-lite` slots. Brand values are `{{brand.colors.primary}}`, `{{brand.footer.address}}`...
- `template.json`: the slot schema (`text`, `richtext-lite`, `image`, `link`, `list`, `enum`; `required`, `max`). Content that does not fit it is refused: that is the contract between whoever designs and whoever writes.
- `brand.json`: colours, fonts, name, footer (company and postal address), `allowedLinkDomains`.
- `sample.json`: example content for the preview.

Merge tags are neutral and translated for each provider: `[[first_name|there]]` (always give a fallback) and `[[unsubscribe_url]]`. Never write a provider's own syntax.

| Command | What it does |
|---|---|
| `bb brandwise email template seed <id> --campaign <c>` | New folder from the starter template |
| `bb brandwise email template list` | Templates and their folders |
| `bb brandwise email template lint <id> --campaign <c> [--target resend]` | Checks (exit 1 on an error): unsubscribe link, postal address, size (Gmail clips about 102 KB), alt text, links, images on https, no scripts, merge-tag fallbacks, spam words |
| `bb brandwise email template render <id> --campaign <c> [--target resend] [--raw]` | Subject, size and findings; `--raw` prints the HTML |
| `bb brandwise email template preview <id> --campaign <c> [--width 375]` | Writes a full-page PNG and prints its path: **open it and look** before you say you are done |
| `bb brandwise email template send-test <id> --to <address> --campaign <c>` | One test e-mail through the campaign's provider (the sender is the `from=` of its e-mail target) |

Rules: keep the unsubscribe link and the postal address in the footer (lint refuses an e-mail without them); images need a public https address (stored assets are only inlined in previews until a public bucket exists); no scripts, forms or iframes; do not change `template.json` slots without updating `sample.json`. The client's **brand kit** and **components** are shared by all its templates and inherited by child campaigns: `bb brandwise email brand [set --brand '<json>'|--file f] --campaign <c>` (colours, fonts, name, footer company and postal address, `allowedLinkDomains`; a template's own `brand.json` overrides it, and a template seeded for a client with a kit starts with an empty `brand.json`), `bb brandwise email component [set <name> --file <full path of an .mjml file> | --mjml '<inline mjml>' | remove <name>] --campaign <c>` (an MJML fragment, used in templates as `{{> name}}`; files are given by their full path).

**Publish, then use.** `bb brandwise email template publish <id> --campaign <c> [--note "..."]` freezes the folder as the next version (refused while the sample has lint errors, the same content twice is not a new version); `email template versions <id>` lists them; `email template links <id>` checks that every link answers (https only, never private addresses). Entries use a published version: `bb brandwise email entry create --template <id> --at <ISO> --tier <1|2|3> --content '<json of the slots>' [--version n] [--locale cs] --campaign <c>` makes a calendar entry whose title is the subject and whose body is the e-mail rendered for the campaign's provider, `email entry bind <entry-id> --template <id> --content '<json>'` changes the content of an existing one (an approved tier 2 or 3 entry goes back for approval), `email entry show <entry-id>`. The content is checked against the slot schema, lint errors refuse it, and every render is stored as a snapshot: the approval card shows that snapshot and the send records it. Locales: the template may list `locales` in `template.json`; one entry is one language, so write one entry per language and audience. Stored images get a public address once the public image bucket is set; until then use https:// addresses.

The older way still works: a template becomes an e-mail when an entry carries its rendered HTML as the body (`--body "$(bb brandwise email template render <id> --campaign <c> --target <provider> --raw)"`), and that entry still needs its approval like any other.
