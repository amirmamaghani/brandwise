# Plan: what is left to do

Status as of 2026-10-30. Decision: **everything runs on bb**, with no Vercel AI SDK and no DBOS. Agent = bb thread (Claude Code), tools = `bb brandwise` (CLI and MCP), scheduling = bb automations, approvals and notifications = the Calendar page and bb push notifications, credentials = bb `secrets`. State that must survive (calendar, limits, metrics) lives in Postgres.

## Order

1. Scheduler (`calendar run-due` from a bb automation)
2. Connectors (publishing)
3. Limits and usage
4. Product: wizard and MD bundle
5. Claims lint
6. Metrics and feedback
7. Comment moderation
8. Research tools
9. Roles (personas) and notifications

Items 1 to 3 are required for anything to get out the door. The rest can be done in the order that brings the first client the most value.

## 1. Scheduler: a bb automation calls our command

**Decision:** a one-minute *script automation* runs `bb brandwise calendar run-due`. No custom daemon, no DBOS.

Why this is the cleanest fit with bb:
- automations are part of bb (cron, run history, output, pause, retries visible in the UI), so we add no new infrastructure,
- a script that prints nothing is recorded as a silent tick (no noise),
- the logic stays in our plugin (one command), the automation is just an alarm clock. It can be swapped for another alarm clock without changing the logic,
- `provision.sh apply` creates it declaratively (`bb automation create --cron "* * * * *"`), like the other instance settings.

How `run-due` works:
1. In one transaction it selects entries that are `approved` with `scheduled_at <= now()` using `... FOR UPDATE SKIP LOCKED` and sets them to `publishing` (the next tick will not pick them up again).
2. For each one it calls the connector (item 2) with an `idempotency_key`. Success: `published`, `external_id`. Failure: `attempts + 1`, `next_attempt_at` with exponential backoff. After the 3rd attempt: `failed` and a notification (item 7).
3. Before firing it re-checks the approval, limits (item 2) and claims (item 4). Any change since approval = back to `pending_approval`.
4. Entries that stayed in `publishing` longer than the timeout (the process crashed) go back to `approved`; the idempotency key protects against double sending.

Risks to verify in the first test: the automation script receives `BB_SERVER_URL` but not `BB_HOST_DAEMON_PORT`; we need to verify that `bb brandwise ...` inside it hits the right instance. The shortest cycle is 1 minute (enough for social networks). A disabled Automations plugin (e.g. in some mode) = nothing gets published, so provisioning checks that it is running.

**Status: done (2026-10-30).** `calendar run-due` in `packages/core/src/publish.ts`, states `publishing` and `needs_manual`, connector `mock`, test in `core.test.ts`, the automation is created by `provision.sh apply`. Verified live: an entry scheduled one minute ahead published itself, an entry with `[fail]` in its title keeps retrying.

Pitfalls we hit (also recorded in the provisioning script):
- bb passes `BB_SERVER_URL` pointing at the default server (personal bb, 38886) into automation scripts; the script sets it from `BB_SERVER_PORT`.
- bb passes `BB_CLI` pointing at a launcher in `<data dir>/bin/bb`, which re-execs itself endlessly (hundreds of processes per second). The script must set `BB_CLI="$BB_CLI_DIR/bb"` and call it directly.
- A script that ends on a timeout shows no output: debug by writing to a file.

## 2. Connectors (publishing, metrics, later comments)

**One contract for all networks and sources.** A connector is a folder `packages/connectors/<name>/` with a manifest and three optional capabilities:

```ts
type Connector = {
  id: string;                         // "meta-instagram", "linkedin", "email-resend", "web-cms"
  channels: string[];                 // which calendar `channel` values it serves
  auth: { kind: "oauth" | "apikey"; secrets: string[] };   // names in bb secrets
  publish?(entry: PublishInput): Promise<{ externalId: string; url?: string }>;
  metrics?(range: { since: string; until: string }): AsyncIterable<MetricPoint>;   // item 5
  limits?: { postsPerDay?: number; maxTextLength?: number; mediaKinds?: string[] };
};
```

- `PublishInput` is neutral (text, assets with signed URLs, time, market). Adapting to the network (length, format, hashtags) is done by the connector, not the agent.
- Registration: one list in `packages/connectors/index.ts`. New network = new folder + one line in the list. Nothing in the calendar, plugin or UI changes.
- Credentials: bb plugin **secrets** (the agent never sees the values). Only names in code.
- A channel without a connector can be scheduled but is not published automatically: the entry ends in state `needs_manual` with the text and assets in the inbox (Calendar). This is also how Postiz or manual upload works at the start.
- **Done: `telegram`** (channel `telegram`: text, image or video; a single `TELEGRAM_BOT_TOKEN` in `.env`, and **the campaign decides where**: `bb brandwise campaign channel set telegram chatId=@channel` for a channel, group or user; the campaign inherits the target from its parent, its own overrides it; without a target the entry waits as "Publish by hand" with instructions) and `mock`. Telegram has no idempotency key, so a crash between sending and writing the record can duplicate a post (note in the code). More channels depending on the research result and the client.
- **Done (without a live test): `email` via Resend**, see `email.md`: connector, adapter, webhook, statistics (`email stats`), provider swap.
- Original idea for the first connector: **Postiz** (its API; AGPL, so only via the API, not a fork) or e-mail directly. The decision depends on the client's first channel.
- The test connector `mock` (writes to the log) is part of item 1.

Done when: two different connectors (mock + one real) publish from the same calendar without changing `run-due`.

## 3. Limits and usage (replaces the "policy gate")

Agreed: a separate "policy engine" is not needed. Split:

| What | Where | Note |
|---|---|---|
| Limits per day, channel, credits, budget, quiet hours | **`limit` table + `usage` records** | same principle as today's limits for Higgsfield (limit per call and per day) |
| Approval tier 1 to 3 | calendar (already there) | |
| Claim checking | claims lint (item 4) | it is a content check, not a usage check |

- `limit(scope, key, period, max)`: e.g. `("channel","instagram","day",2)`, `("credits","higgsfield","day",40)`, `("quiet_hours","SK","", "22:00-07:00")`.
- `usage(scope, key, amount, at, entry_id?)`: written on every fire and generation. A single function `canSpend(scope, key, amount)` reads it; `run-due` calls it before publishing.
- Limit settings are in the plugin's Settings page and in `profile.env` (as now). Exceeding a limit = the entry is moved to the next window or goes to the inbox, it is never dropped.

Done when: the 3rd post of a day on a channel with a limit of 2 moves to the next day and Calendar shows why.

## 4. Product: wizard and MD bundle

Agreed on the wizard via bb (a question-asking tool), then a regular thread.

1. The **bundle** is a folder `~/.bb-brandwise/product/<always-on base campaign id>/` with `product.md`, `audience.md`, `claims.md`, `constraints.md`, `voice.md` and a `derived/` subfolder (positioning, keywords, messages). Read and write via `bb brandwise product get|set <file>`. No new storage.
2. The **wizard** is the skill `product-onboarding`: the thread asks questions with a question tool (one topic per screen: what we sell, to whom, how we differ, what we can and cannot claim, tone, markets and languages, forbidden topics), and after the answers writes the files via `product set`.
3. Then **compilation**: another thread (role "strategist", item 7) reads the bundle and produces `derived/`. A human approves.
4. The Campaigns page gets a "Start wizard" button (opens a thread with the skill) and a list of the bundle's files with in-text editing.
5. Read tools: `product get` (the whole bundle or one file), `claims get` (structured: claim, source, validity, market).

`claims.md` has a fixed structure (field `claim`, `source`, `valid_until`, `markets`) so that it can be used in item 5. The exact format will be decided with the first client.

Done when: a new client goes through the wizard in 15 minutes and the agent writes a draft post from the bundle alone.

## 5. Claims lint

A deterministic check (no LLM) of the entry's text against `claims.md`: numbers, prices, guarantees, subsidies, superlatives. The result is `green | list`, shown on the approval card; mandatory for tier 3. `run-due` runs it again right before firing. It starts once the first client's `claims.md` exists (backlog).

## 6. Metrics and feedback (flexible for all networks and sources)

For e-mail and paid media this item is planned in [`analytics.md`](analytics.md) (learnings, experiments, costs, leads and CPL, ad buys); the sketch below stays for the other channels.

Goal: add a new network or data source without changing the schema.

- **One narrow table** `metric_point(source, entity, metric, value, at, dims jsonb)`:
  - `source` = connector id (`meta-instagram`, `ga4`, `shop`, `crm`),
  - `entity` = what it relates to (`calendar:<id>`, `campaign:<id>`, `ad:<id>`, `page:<url>`),
  - `metric` from a **fixed vocabulary** (`impressions`, `reach`, `clicks`, `likes`, `comments`, `shares`, `saves`, `video_views`, `watch_time`, `followers`, `spend`, `conversions`, `revenue`, `orders`),
  - `dims` for dimensions (market, creative, experiment variant) that do not fit the vocabulary.
- **Collection:** every connector with a `metrics()` capability has one bb automation script (daily, plus after publishing at 1 h, 24 h and 7 d via `run-due`, which creates check entries on `published`). The script calls `bb brandwise metrics pull <connector>`; repeating it is safe (key `source+entity+metric+at`).
- **Raw events from the web, CRM and shop:** a receiver via the plugin's HTTP route with a signature and writing to `metric_point` or to `event` (another narrow table); same vocabulary.
- **Reading by the agent:** only deterministic aggregations, never raw rows: `metrics summary --campaign <c> --since 7d --by channel|entry|variant`, `metrics compare <a> <b>`. The agent gets numbers and signals ("post X had 3x the median"), not tables.
- **Experiments:** `experiment(id, hypothesis, variants, holdout_pct, metric)` and columns in the calendar (`experiment_id`, `variant`, `holdout`). Evaluation is a deterministic function over `metric_point`; conclusions are written as findings (`learning`) that the agent reads via `get_learnings`.

Done when: after publishing a test post, its numbers appear in `metrics summary` after an hour and Calendar shows the performance next to the entry.

## 7. Comment moderation (reading via automation)

Decided: comments are **read periodically** by a bb automation, not via webhook. A webhook (Meta has one, TikTok, LinkedIn and YouTube probably do not for organic comments) can be added later as a ping to the same command; it requires a separate public receiver, because we must not expose the bb instance publicly.

- The connector gets a capability `comments?(since)` and actions `hide`, `delete`, `reply`.
- Table `comment(source, external_id, entry_id, author, text, at, status)`, the key `source+external_id` makes collection repeatable. States: `new`, `ok`, `hidden`, `needs_review`, `replied`.
- An automation script calls `bb brandwise comments pull <connector>` every few minutes; with no new comments it prints nothing (silent tick), otherwise it starts the moderation agent (persona).
- A deterministic prefilter (blocked words, links, repetition) handles clear spam without an LLM, the agent judges only the unclear cases.
- Tiers: hiding clear spam = 1 (automatic, logged, reversible); deleting, blocking and replying = 2 and go through the calendar. The agent never sends a reply itself.
- Push on `needs_review` and on bulk hiding.
- Before building, check the API options for TikTok and LinkedIn in the official documentation.

Done when: a test comment shows up within 5 minutes and spam is hidden without intervention.

## 8. Research tools (SEO, GEO, ads)

Same pattern as connectors: the **provider** is a small adapter, the tool is a command.

- Commands: `research keywords <query>`, `research serp <query>`, `research gsc --site <s> --since 28d`, `research ads <brand>` (Meta Ad Library), `research geo <query>` (citations in AI answers), `media transcribe <file>` (Whisper).
- A provider (DataForSEO, Google Search Console, Meta) = `packages/research/<name>.ts` with one function; the list is in `index.ts`. Credentials in bb secrets.
- **Cache and cost:** table `research_cache(provider, key, payload, fetched_at, cost)` with validity per tool (SERP 24 h, keywords 30 d). Every paid call goes through `usage` (item 3), so the limits apply.
- The output is always bounded (top N, summary), not a raw export.

Done when: `research keywords` returns a result, the second identical call is served from the cache and the cost is visible in `usage`.

## 9. Roles and notifications

**Roles = personas** (a system prompt + a list of commands they may use): `researcher`, `writer`, `seo`, `ads`, `analyst`, `critic`, `strategist`. Each is a file `roles/<name>.md` in the plugin. It runs as a thread with that prompt (from "Start agent", from another thread or from an automation). Agreed that this is enough.

An honest limitation: a persona **does not enforce** a ban on tools, it is only an instruction. The real protections stay in code: the agent cannot approve (only a human can), nothing goes out outside the calendar, limits and the claims lint run in `run-due`. A role therefore simplifies work, not security.

**Notifications (what I called inbox and digest):** the owner must not have to watch the app. In bb this means:
- **Inbox = the Calendar page** (already exists): entries awaiting approval, failed publications, `needs_manual`.
- **Check via a bb automation** (not a push from the plugin): a small script automation every few minutes runs `bb brandwise inbox` (entries awaiting approval, `failed`, `needs_manual`). If nothing is new, it prints nothing (silent tick). If there is, it sends a notification via bb push notifications (mobile and desktop). The "already notified" state is kept by the command in Postgres so it does not repeat. The plugin thus does not have to send anything on a state change, and everything is visible in the automation's run history.
- **Weekly digest:** one bb automation on Monday morning (agent mode) that produces a thread "Week: what happened, what is waiting, what we learned" and sends a push with a link. No WhatsApp or e-mail at the start; they can be added as another connector.

## What we dropped from the original design

- **Vercel AI SDK, DBOS, Inngest, A2A:** gone. The agent is a bb thread, durability is state in Postgres plus bb automations.
- **Tables `tool` and `tool_call`:** gone. Every tool call is already in the bb thread's log, a second record would be a duplicate. What remains is only the link from a calendar entry to the thread that created it (`thread_id`, `rationale`) and the `usage` table (item 3), which we need for limits.
- **`propose_tool` and approval of new tools:** a new tool is a change in the plugin's code via a regular PR.
- **A separate policy engine:** replaced by limits, the claims lint and the approval tier.
- **Tool selection test (50 tasks):** stays as an optional quality check after item 8, not as a requirement.
