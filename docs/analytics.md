# Analytics: learnings, experiments, economics, paid media

Status 2026-11-01: phase 1 is built (code in `packages/core/src/learnings/`, tests in `learnings.test.ts`, `learnings.db.test.ts` and `regulator/loop.test.ts`); phases 2 to 5 are planned. For e-mail and paid media this replaces the sketch in `roadmap.md` §6.

Principles stay: nothing leaves without the calendar and approval; code judges, agents read aggregates; agents get tools, never credentials; providers are adapters with contract tests; Postgres is the source of truth.

## Defects to fix first

| # | Defect | Where |
|---|---|---|
| D1 | Unsubscribe guard is blind on Resend (unsubscribes are contact events, count stays 0) | `regulator/rails.ts:45`, `email/adapters/resend.ts:4` |
| D2 | `minDetectableLift` is optimistic: +72 % instead of about +85 % at 2 % and 1,500 per arm | `regulator/stats.ts:23` |
| D3 | Learnings are free text in the journal, read by the editor only | `regulator/index.ts:104` |
| D4 | No review history: a send-back overwrites `review_note`, approval stores no who or when | `packages/core/src/index.ts:150`, `:171` |
| D5 | The editor loop never runs on its own | `infra/bb-instance/provision.sh:87` |
| D6 | UTM only on `entry.link` of plain-text e-mails, entry id in `utm_campaign`; HTML, templates and Telegram untagged | `email/domain/render.ts:7`, `connector-telegram.ts:31` |

## Phase 1. Learnings: what agents remember (M)

- **`learning`**: statement, lever (`attribute: from -> to`), context, metric, effect, CI, N, MDE, method, biases, experiment, scope, status, `review_at`, `superseded_by`.
- **Evidence levels**: E1 = experiment verdict, E2 = pattern over many entries (miner over attribute tags), both written by code only; E3 = agent observation, a test candidate only.
- **Kinds**: `performance`, `null_result` (no difference above MDE at N), `reviewer_preference` (proposed by an agent from send-backs, confirmed by a person; a style rule, not evidence).
- **Weight** = evidence (E1 1.0, E2 0.6, E3 0.2) × 0.5^(age / half-life) × status. Half-life by lever category: trends 60 d, offer 135 d, timing 180 d, style 365 d. Below 0.25: `needs_retest`.
- **Scope**: campaign → brand. Code promotes when confirmed in 2 campaigns or tested on the always-on base. Specific beats general; on contradiction the fresher, stronger one wins and the other is `superseded`. Nothing is deleted.
- **Applications**: `learning_application(learning, entry, exploit|explore|test, outcome)`. When the entry matures its outcome is recorded; 5 contrary outcomes send the learning to `needs_retest`.
- **`brief --campaign <c> --channel <ch>`**: learnings in force with weights, null results (do not re-test), E3 candidates, style rules, a diversity hint, and whether this slot is exploit or explore (explore share 20–50 %, decided by code).
- **Gates**: no re-test of a lever with an active null result at the same or lower power.
- **Review history** (D4): `entry_event` for every calendar action (who, when, note, reason, review seconds); feeds preferences and production metrics.
- **Agents**: editor, author, `brandwise` skill and `agents.ts` run `brief` before writing and pass `--brief/--applies/--tests` with the entry; the approval card shows what was applied.
- **Automations**: editor every 6 h (opt-in per campaign, D5), `learnings maintain` daily, `learnings mine` weekly.

Done when: `editor-loop.mjs` passes with a structured learning for every conclusion; the next brief shows it with a weight; a re-test of a null-result lever is refused; every author entry carries a brief id.

As built:
- `needs_retest` is computed when learnings are read (age, contrary applications), and promotion happens when a learning is written, so there is no daily `learnings maintain`.
- Tags live with the learnings: `entry_attribute`, with the derived subject features (number, personal, question, caps), format, length, daypart and weekday; the miner (`learnings mine`) runs over them.
- An application's outcome is the entry's click rate 24 h after sending against the brand's pooled rate of its last five other sends; "clearly contrary" means the Wilson interval lies entirely on the other side.
- A null result blocks a re-test unless the expected sample per arm is more than 1.2 times the one it was found at.
- The flag that links an entry to its brief is `--brief-id` (`--brief` is the task text of `editor tasks create`).
- Not verified here: `editor autorun` and the automations need a bb instance, and `editor-loop.mjs` needs real agents.

## Phase 2. Experiments that can conclude (S–M)

- Fix D2 (unequal variances); test vectors from the specification.
- **Registration before launch**: hypothesis, lever, primary metric, guardrails, expected lift, planned rounds, decision rule; shown on the approval card; `experiment_id/variant` on calendar entries.
- **Power gate**: refused when the expected lift is below the MDE; the answer says how many rounds would do.
- **Series**: one hypothesis pooled over several sends (Cochran–Mantel–Haenszel), fixed horizon, no verdict before the planned rounds.
- **Guardrails**: B rejected when significantly worse, or complaints ≥ 0.1 % with at least 2 events; freeze at 0.3 %. A guard the provider cannot measure is `unavailable`, never 0 (D1).

Done when: a 4-round series of 600 per arm reaches a pooled verdict where every round alone is inconclusive; an untestable registration is refused with the rounds needed; a variant with 0.15 % complaints is rejected although it wins on clicks.

## Phase 3. Costs and creative economics (M–L)

- **`cost_entry` ledger**, idempotent by `(source, source_ref)`:
  - `gen`: every generation, rejected and failed included; moves from bb KV to Postgres, daily budgets read the ledger, credits become money via `<provider>.unitPrice`;
  - `llm`: bb thread usage if bb exposes it, otherwise a monthly amount allocated over the campaign's threads;
  - `human`: review timer in the approval dialog (defaults for CLI) × hourly rate;
  - `distribution` (ESP fees), `incentive` (discounts, gifts), `tool` (subscriptions, period level), `media` (phase 5 or manual).
- **Three levels**: entry, campaign, period.
- **`economics_profile`** (versioned, set by a person): business model, contribution margin, order or deal value, lead → qualified → customer rates, hourly rate, targets.
- **Attribute tags** `entry_attribute`: format, hook, angle, offer, style, CTA, subject style, send time; derived where possible, otherwise from agent or person.
- **Creative economics**:
  - cost per approved asset per format;
  - first-pass approval rate, iterations, time to approval, send-back reasons;
  - response per exposure for each creative.
  - Fully loaded CPL for a single organic creative is not a metric: too few leads, and in e-mail and Telegram a creative is not an independent unit. Per ad in paid media it is (phase 5).

Done when: a rejected and a failed video generation both count in cost per approved video; budgets behave as before but read the ledger; `results economics` says "needs: margin" until the profile is set.

## Phase 4. Leads and CPL (L)

- Fix D6: `utm_content=<entry id>` on every link (HTML, templates, Telegram). Move the hash salt from bb KV to Postgres.
- **`conversion`** with status history (lead → qualified → SQL → won), idempotent by `(source, external_id)`. Port `ConversionSource`: signed `generic-webhook`, `csv`, then the first real source. E-mail and phone are hashed at ingest and never stored. Optional site snippet keeps first/last UTM for forms.
- **Attribution**: UTM last non-direct click, promo codes, "how did you hear about us"; windows from the profile; shown as a range, never one number.
- **Economics**: CPL, CPQL, CPA/CAC (blended), value per lead and CPL max, break-even ROAS = 1 / margin, ROMI on incremental gross profit only, MER, contribution per campaign, format payback.
- **Loop**: `lead_rate` as a guardrail on every e-mail test, primary when power allows. The simulator `sim-shop` sets the proxy trap: urgency raises clicks and lowers leads.

Done when: a signed lead with `utm_content` is attributed to its entry once, even if sent twice; a later qualification updates CPQL; a clickbait subject that wins on clicks is rejected on leads.

## Phase 5. Paid media: ad buys and boosts (L)

- **A purchase is a calendar entry** (`media_buy`, `boost`, `budget_change`) at tier 3. Spend limits are checked on insert and again right before firing (`limit`/`usage`, `roadmap.md` §3).
- **Port `MediaBuyer`**: create or boost, pause, report (spend, impressions, clicks, conversions). Reports go to `metric_point` and spend to `cost_entry(media)`. Adapters: ad platform APIs (Meta, Google, Telegram Ads, to be checked one by one), AdCP sales agents where a seller offers them.
- **Port `Payment`**: only for sellers that take agent payments, through ACP. The plugin issues a token scoped to the seller and amount after approval; the agent never sees a card or a balance. Platforms with prepaid balances or invoices get no payment step, spend is only recorded.
- **Metrics**: CPL, CPQL and ROAS per ad on media spend; production cost added when it is above about 10 % of media; frequency and creative fatigue; platform conversions are indicative and reconciled with leads from phase 4.
- **Tests**: platform split tests; geo and time holdouts later.

Done when (mock buyer): a boost over the limit is refused before payment; an approved boost spends once on retry; its spend is in the ledger and CPL shows per ad; no command prints the payment token.

## Results page and digest

A **Results** page in the plugin grows with the phases:
- Health and Experiments (phase 2);
- Learnings (phase 1);
- Costs and Production (phase 3);
- Economics and Funnel (phase 4);
- Paid (phase 5).

An `analyst` skill writes a weekly digest from `results digest`.

## Before the first live send

- A public entry for webhook paths only (a tunnel with an allowlist); the instance listens on loopback.
- Resend contact events for unsubscribes, attributed to the last send.
- Link-scanner filtering: clicks seconds after delivery or on every link at once are machine clicks. `email_event.at` is stored, but `CountableEvent` drops it.
- Complaint alerts at 0.1 % and 0.3 %.

## Later and never

- **Later**:
  - holdout and incrementality (needs tens of thousands of recipients);
  - splits made by the system through the provider's contacts API;
  - own redirect service, Telegram views and forwards (not in the Bot API), tests over many posts;
  - organic social metrics, Search Console, AI visibility;
  - LTV and payback;
  - Bayesian and sequential rules, Thompson sampling;
  - cross-client priors;
  - Google Postmaster Tools, MTProto;
  - verified caller identity.
- **Never**: media mix modelling, multi-touch attribution, predictive LTV.

## Open questions

1. Tunnel and hosting for webhooks.
2. May the system read Resend contacts and create segments?
3. First lead source.
4. Does bb expose token usage per thread?
5. Review-minute defaults per tier and format.
6. Heuristic thresholds: hard bounce 2/5 %, delivery 97/90 %, unsubscribes 0.5/1 %.
7. Do both experiment arms need a person's approval in production?
8. Frequentist or Bayesian by default?
9. Does promoting a learning to brand level need a person?
10. Currency and VAT.
11. Retention of conversion data and customer hashes.
12. Our own site snippet?
13. Which ad platforms first?
14. Which sellers take ACP, and which payment method backs it?
