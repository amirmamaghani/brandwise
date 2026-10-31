# Agent tools

The agent chooses from tools, but whether anything happens is decided by code and a human (see `architecture.md`). The tools are `bb brandwise` commands (CLI and MCP of the bb instance). Decided (2026-10-30): the agent is a bb thread, no Vercel AI SDK or DBOS (see `roadmap.md`). The `tool` and `tool_call` tables below are cancelled: tool calls are in the thread log.

## Rules

1. **Small packs by role.** Each role sees 15–25 tools. More worsens selection and raises the context cost.
2. **Intent-level tools**, typed inputs and outputs, bounded output (no raw tables).
3. **Three kinds:**
   - `read` – no side effects,
   - `draft` – writes only to internal tables (drafts), nothing goes out,
   - `write` – creates or changes a calendar entry. Nothing calls the platform directly, the only way out is through the scheduler.
4. **Gates are in code.** Each tool is wrapped by our policy function, which before execution checks role, kind, risk, limits and budget. On denial, the denial wins.
5. **The agent gets only our tools.** No shell and no file access in production.
6. **The agent only proposes new tools** (`propose_tool`): status `proposed` → sandbox → human approval (tier 3) → `approved`. Unapproved code never runs.
7. **Per-run limits:** maximum number of steps, tokens and calls per tool. Every call is recorded in `tool_call`.

## Schema

```sql
create table tool (
  name            text primary key,              -- e.g. search_keywords
  version         int  not null default 1,
  roles           text[] not null,               -- which roles see it
  kind            text not null check (kind in ('read','draft','write')),
  risk_tier       int  not null check (risk_tier between 1 and 3),
  idempotent      boolean not null,
  cost_cents_est  numeric,                       -- estimate per call
  max_calls_per_run int,
  input_schema    jsonb not null,
  output_schema   jsonb not null,
  impl            text not null,                 -- adapter id, e.g. tools/video-dl.sh
  status          text not null default 'draft'
                  check (status in ('draft','proposed','approved','disabled')),
  proposed_by     text,
  approved_by     text,
  approved_at     timestamptz
);

create table tool_call (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,                     -- RLS by campaign root (campaign.root_id)
  run_id      uuid not null,
  tool        text not null references tool(name),
  version     int  not null,
  input_hash  text not null,
  output_ref  text,                              -- reference to the stored output
  status      text not null check (status in ('ok','denied','error')),
  denied_by   text,                              -- rule that denied it
  cost_cents  numeric,
  started_at  timestamptz not null default now()
);
```

## First role: content and research (SEO, GEO, organic posts)

Status: **exists** = done in the repo, **plan** = needs to be built, **external** = requires an account or approval.

| # | Tool | Kind | Risk | What it does | Status |
|---|---|---|---|---|---|
| 1 | `get_product_context` | read | 1 | derived/ (positioning, messaging) for the business | plan |
| 2 | `get_claims` | read | 1 | structured claims from `claims.md` | plan |
| 3 | `get_brand_voice` | read | 1 | tone rules and examples | plan |
| 4 | `search_keywords` | read | 1 | keywords and volume (DataForSEO) | external |
| 5 | `get_serp_snapshot` | read | 1 | top results for a query | external |
| 6 | `get_search_console_report` | read | 1 | impressions, clicks, positions | external |
| 7 | `get_competitor_ads` | read | 1 | competitor ads (Meta Ad Library) | external |
| 8 | `download_video` | read | 1 | downloads a video, returns the path and metadata | **exists** (`tools/video-dl.sh`) |
| 9 | `transcribe_media` | read | 1 | audio transcription (Whisper) | plan |
| 10 | `get_geo_citations` | read | 1 | citations in AI answers | external |
| 11 | `get_social_metrics` | read | 1 | performance of published posts | plan |
| 12 | `get_calendar` | read | 1 | future and past calendar entries | plan |
| 13 | `get_learnings` | read | 1 | library of learnings and experiments | plan |
| 14 | `lint_claims` | read | 1 | deterministic check of text against `claims.md` | plan |
| 15 | `draft_post` | draft | 1 | saves a post draft, runs lint right away | plan |
| 16 | `draft_page` | draft | 1 | page from a template and a data row (pSEO) | plan |
| 17 | `generate_media` | draft | 2 over budget | image or video (Higgsfield), costs credits | **exists** as `bb brandwise creative cost\|generate\|collect` (per-call and daily limit) |
| 18 | `log_hypothesis` | write | 1 | writes a hypothesis to `experiments` | plan |
| 19 | `schedule_item` | write | 1–3 by type | creates a calendar entry | plan |
| 20 | `reschedule_item` | write | 1–2 | changes the time or cancels an entry | plan |
| 21 | `propose_tool` | write | 3 | proposes a new tool (status `proposed` only) | plan |
| 22 | `get_asset` | read | 1 | asset metadata and a short-lived signed link (see `assets.md`) | plan |
| 23 | `save_asset` | draft | 1 | saves a file to storage by hash and writes an `asset` record | plan |

`schedule_item`: a draft without publishing is tier 1, publishing to an account is tier 2, claims about price, warranty or subsidies and a new channel are tier 3.

## How we verify tool selection

- 50 fixed tasks with an expected tool (for example "write a post about …" → `get_product_context`, `get_claims`, `draft_post`, `lint_claims`).
- We track whether the agent chose the right tool, whether it violated its role and how many calls it used.
- Only once this passes do we add another role (ads, lifecycle, reception).

## Open

- Exact structure of `claims.md` (fields, example), see `roadmap.md` item 4.
