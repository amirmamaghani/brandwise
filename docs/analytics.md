# Analytics: learnings, experiments, economics, paid media

Status 2026-11-01: phases 1 to 5 are built (code in `packages/core/src/learnings/`, `regulator/`, `economics/`, `conversions/` and `media/`, each with pure and database tests). Real ad platforms and ACP payments are the adapters still to write; the mock platform and payment come with the simulated provider. For e-mail and paid media this replaces the sketch in `roadmap.md` §6.

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

As built:
- Registration lives on `propose` (`--expected-lift`, `--rounds`; the CLI requires the lift), with the per-arm size, the MDE, the guards and the decision rule stored on the experiment; arm entries carry `experiment_id` and `variant`, and the approval card shows the registration.
- Rounds are added with `editor experiments add-round`, to the same two arm campaigns, after the previous round was sent. The judge says `next_round` until the planned rounds are mature; `editor autorun` then starts the editor to write the next pair.
- The guard rule was changed after simulation: "0.1 % with two events", looked at after every round, rejected about a quarter of good challengers in 4-round series. Complaints are now unsafe at the 0.3 % ceiling (two events) or when the lower end of their 95 % interval is above 0.1 %; "significantly worse than the control" uses p < 0.01 and three events. Both arms unsafe freezes the campaign; an unsafe control gives way to a safe challenger.
- Pooling counts every round as new people although the arms are fixed audiences; per-round re-randomization needs the provider's contacts API (later).

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

As built:
- The ledger keeps units (credits, money) and prices them when a report is made: credits by the setting `<provider>.unitPrice`, review minutes and e-mail sends by the profile valid then. Review minutes and sends are read from `entry_event` and `email_event`, so nothing is allocated by a job and there is no `costs allocate`.
- Generations are recorded when they start (estimated units) and get their status and asset when collected; a failed job is marked failed. The bb KV counter of earlier versions is still read for the day it was written.
- The review timer is the time the approval dialog was open, capped at 30 minutes; approvals without it (CLI, the sidebar's quick approve) take the tier's default (0, 3 and 10 minutes, or the profile's).
- LLM spend is the profile's monthly amount spread over the brand's campaigns by the entries written outside the UI; bb does not expose token usage to the plugin as far as the code shows.
- Setting the profile and stating costs (media, incentive, tool, sales) are a person's actions on the Results page only; `bb brandwise results ...` is read-only.
- Not built yet: response per exposure per single creative (only e-mail is measured, and e-mail entries rarely carry a creative); it comes with the channel metrics of phase 5.

## Phase 4. Leads and CPL (L)

- Fix D6: `utm_content=<entry id>` on every link (HTML, templates, Telegram). Move the hash salt from bb KV to Postgres.
- **`conversion`** with status history (lead → qualified → SQL → won), idempotent by `(source, external_id)`. Port `ConversionSource`: signed `generic-webhook`, `csv`, then the first real source. E-mail and phone are hashed at ingest and never stored. Optional site snippet keeps first/last UTM for forms.
- **Attribution**: UTM last non-direct click, promo codes, "how did you hear about us"; windows from the profile; shown as a range, never one number.
- **Economics**: CPL, CPQL, CPA/CAC (blended), value per lead and CPL max, break-even ROAS = 1 / margin, ROMI on incremental gross profit only, MER, contribution per campaign, format payback.
- **Loop**: `lead_rate` as a guardrail on every e-mail test, primary when power allows. The simulator `sim-shop` sets the proxy trap: urgency raises clicks and lowers leads.

Done when: a signed lead with `utm_content` is attributed to its entry once, even if sent twice; a later qualification updates CPQL; a clickbait subject that wins on clicks is rejected on leads.

As built:
- A source is added by a person (Results > Leads): a signed webhook (`POST /api/v1/plugins/brandwise/http/webhooks/conversions?source=<id>`, header `X-BrandWise-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`, five minutes of tolerance; the secret is shown once and stored sealed with the plugin's key) or a CSV import with a column mapping. Body: `{ "kind": "lead" | "order", "id", "status", "occurredAt", "email" | "phone", "value", "currency", "utm": { "utm_content": ... }, "bw", "promo", "selfReport" }`, or an array of them.
- The recipient-hash salt moved to Postgres (`installation`); an install keeps its earlier KV salt. A customer's e-mail gets the same salted hash as the e-mail recipient, phones a salted hash of their digits; `raw` drops every field that looks personal.
- `tools/bw-snippet.js` keeps the first and last touch of a visitor and fills hidden form fields (`bw`, `bw_utm_last`, `bw_utm_first`); optional.
- The lead rules in the rails, when a source measures the brand: arms are judged 72 h after sending; a challenger with significantly fewer leads (exact conditional binomial, p < 0.05, at least 3 control leads) is unsafe; a click win whose leads are 10 % or more lower is not adopted even before that is significant (the safe default keeps the control). A lead experiment (`--metric lead_rate`) decides on leads with the exact test for one round and Cochran-Mantel-Haenszel for a series, and is refused while no lead rate is measured (only sends at least 72 h old count). In simulation, a "free gift" subject with +129 % clicks and 12 leads against 18 was kept out, and learned as a finding about leads.
- Promo codes are unique per brand (`promo_code (root_id, code)`), mapped by a person, and a source resolves only codes of its own brand.
- Funnel numbers are ranges (last click .. promo codes and self-reports); ROMI is not computed: on attributed revenue it would count sales that happen anyway, and incremental profit needs a holdout (later).
- The simulated shop turns simulated clicks into leads with a hidden model in which bait brings clicks and few leads.

## Phase 5. Paid media: ad buys and boosts (L)

- **A purchase is a calendar entry** (`media_buy`, `boost`, `budget_change`) at tier 3. Spend limits are checked on insert and again right before firing (`limit`/`usage`, `roadmap.md` §3).
- **Port `MediaBuyer`**: create or boost, pause, report (spend, impressions, clicks, conversions). Reports go to `metric_point` and spend to `cost_entry(media)`. Adapters: ad platform APIs (Meta, Google, Telegram Ads, to be checked one by one), AdCP sales agents where a seller offers them.
- **Port `Payment`**: only for sellers that take agent payments, through ACP. The plugin issues a token scoped to the seller and amount after approval; the agent never sees a card or a balance. Platforms with prepaid balances or invoices get no payment step, spend is only recorded.
- **Metrics**: CPL, CPQL and ROAS per ad on media spend; production cost added when it is above about 10 % of media; frequency and creative fatigue; platform conversions are indicative and reconciled with leads from phase 4.
- **Tests**: platform split tests; geo and time holdouts later.

Done when (mock buyer): a boost over the limit is refused before payment; an approved boost spends once on retry; its spend is in the ledger and CPL shows per ad; no command prints the payment token.

As built:
- `bb brandwise ads order` drafts a `media_buy`, `boost` (of a published post) or `budget_change` (of a live order) as a tier-3 entry on channel `ads` with a `media_order`; the core refuses any other tier for that channel and moving entries to or from it. Limits are scoped settings (`ads.maxPerOrder`, `ads.dailyLimit`, `ads.monthlyLimit`, in the profile's currency) that only a person changes, on the Settings page (the CLI refuses `userOnly` settings, as it does `editor.autoRun`); they fail closed: unset limits or an unset brand currency buy nothing. They are checked when the order is made and again in the connector, before the payment step. The month counts every order scheduled in it whatever became of it (paused, ended: the larger of its budget and its spend), and a pending budget change counts its increase.
- Where a campaign buys and how it pays (its `ads` channel target: platform, payment method or a prepaid account) is set by a person on Results > Paid; `campaign channel set|unset ads` is refused in the CLI. An order copies platform and payment when it is made, the approval card shows them, and the connector buys with the copy, so a later change of the target does not change an approved order.
- An `ads` entry is approved only by a person in the UI (`calendar approve` from the CLI is refused), and the connector buys only when the entry's `approved_by` is `ui`; a boosted post or a changed order must belong to the same brand, checked again in the connector.
- The connector authorizes a payment only for platforms that need one (`requiresPayment`, unless the target says `prepaid=true`), per idempotency key, and keeps only the authorization's reference; the token is handed to the platform and dropped. The ad's link gets `utm_medium=paid` and `utm_content=<entry id>`, so our leads are traced to it.
- `ads pull` (hourly automation) stores the platform's daily numbers in `metric_point` and the spend in the cost ledger, both idempotent per day; a finished order ends. Per ad (`ads list`, Results > Paid): spend, CTR, CPC, CPM, frequency, fatigue (CTR of the last three days under 70 % of the first three), our leads, CPL, CPQL, ROAS on our orders, and the fully loaded CPL when the format's cost per approved asset is over 10 % of the spend.
- Not built: real platform adapters (Meta Marketing API, Google Ads, Telegram Ads, AdCP sales agents) and a real ACP payment adapter; split tests on the platforms. The ports (`MediaBuyer`, `PaymentProvider`) and the mock pair define what they implement.

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
