# Analytics: measuring the whole campaign

Status 2026-11-04. Learnings and experiments already exist and work; what they lack is data. Today only e-mail reports numbers, so
everything the system learns comes from e-mail. The work below gives every channel a source of numbers, then lets tests and learnings
use any of them. It replaces the earlier `feat/analytics` branch, which built depth on e-mail only.

Scope: Western platforms only for now.

## Stack

Each step is one small pull request on top of the previous one.

| # | Branch | What it adds |
|---|---|---|
| 1 | `stack/analytics-1-base` | Fixes the system needs whatever the source: power estimates (D2), review history (D4), UTM on every link (D6). |
| 2 | `stack/analytics-2-metrics` | One port `MetricsSource` writing `metric_point` per calendar entry (`roadmap.md` §6). E-mail becomes one adapter; learnings and experiments read from it instead of `email_event`. |
| 3 | `stack/analytics-3-links` | Own short links with a redirect: clicks per entry in any channel, with nothing to set up on the client's side. |
| 4 | `stack/analytics-4-site` | GA4: visits and key events by `utm_content`, so leads arrive from the analytics the client already has, without webhooks or CSV. |
| 5 | `stack/analytics-5-ads-meta` | Ad platform reports, read only: spend, impressions, clicks, conversions per ad. |
| 6 | `stack/analytics-6-social-<platform>` | Organic post metrics. |
| 7 | `stack/analytics-7-ads-buy`, `-acp` | Buying through the calendar and a person's approval, paid through a real ACP adapter. |

Not planned: LLM or token cost accounting (subscriptions make it meaningless).

## Defects fixed in step 1

| # | Defect | Fix |
|---|---|---|
| D2 | `minDetectableLift` gave both arms the control's variance and promised too much: +72 % instead of +85 % at a 2 % rate and 1,500 per arm. | `requiredPerArm` gives each arm its own variance; `minDetectableLift` solves it for the lift (`regulator/stats.ts`). |
| D4 | A send-back overwrote `review_note`; an approval stored neither who nor when. | `entry_event`: one row per action (created, edited, approved, changes_requested, unapproved, cancelled, published, failed, needs_manual) with actor, statuses, note, reason and data. `content_calendar.approved_at/approved_by`. `bb brandwise calendar history <id>`. |
| D6 | UTM only on `entry.link` of plain-text e-mails, with the entry id in `utm_campaign`; HTML, templates and Telegram untagged. | Every http(s) link in e-mail (text, HTML, templates) and Telegram posts gets `utm_source`, `utm_medium`, `utm_campaign=<campaign slug>` and `utm_content=<entry id>`; parameters already on a link are kept; merge tags, `mailto:` and the unsubscribe link are left alone. |

## Step 2: one metrics layer

- `packages/core/src/metrics`: the vocabulary (sends, exposures, clicks, complaints, unsubscribes, bounces, reactions, comments, shares, saves, video_views, leads, orders, revenue, spend; all counts, rates are computed) and the port `MetricsSource`. A source names the channels it measures and the metrics it can report. A metric no source reports is missing, never 0.
- Two kinds of source. **Live** sources keep their own event history and answer for any moment (`at`): e-mail. **Pull** sources only know current totals (`pull`): each pull stores a snapshot of the running totals in `entry_metric`, so history builds up and every read can be "as of" a moment. A repeated pull at the same moment stores nothing; a source cannot write numbers for entries outside its channels.
- One number per metric per entry: the first source that reports it wins, sources are never added up. An entry's start is what the source says, or its publish time from the review history (step 1) when the source cannot tell.
- The regulator reads only from here. An experiment may run on any channel where a source measures exposures and clicks, with both arms on the same channel; the rails are unchanged (`docs/editor.md`).
- E-mail is the first source (`email/metrics-source.ts`). A number its providers cannot emit is missing: Resend reports unsubscribes as contact events, so the unsubscribe guard no longer reads a fake 0 there (D1).
- CLI: `bb brandwise metrics sources | entry <id> | campaign [--campaign <c>] [--as-of <ISO>]`, `metrics pull [--source <id>] [--days 30]`. No pull source exists yet; the automation that pulls comes with the first one (step 3).
- Not changed: `write_variant` tasks still create e-mail entries; arms on other channels are proposed with entries made by hand or by an author.

## Step 3: own short links

- On publishing, the Telegram connector replaces every link of the post (already tagged with UTM) with our short link `<public address>?c=<id>.<signature>`. The redirect route `/api/v1/plugins/brandwise/http/l` sends the visitor on with a 302 and records the request. More channels join as their connectors take the shortener (`SHORTENED_CHANNELS` in `publish.ts`).
- The route has no bb login, because a link is public by nature. A code carries an HMAC signature, so only links we issued resolve; anything else is a 404. The target is always a URL stored when publishing, so it is not an open redirect.
- A click stores no address and no browser string, only salted hashes, so unique clicks can be counted. Link previews, crawlers, scripts and HEAD requests are recorded as bots and never counted. Telegram fetches every link of a post for its preview.
- Click integrity: the client address is the right-most `X-Forwarded-For` entry, the one our proxy appends; whatever the client wrote before it is ignored, so the proxy in front of the instance must append that header. One address adds at most 3 unique visitors to an entry, so rotating the browser string cannot inflate a test.
- `links` is a live metrics source: unique human visitors over all short links of an entry, as of any moment. An entry with links and no click has 0; one without short links is unknown.
- E-mail keeps its links: the provider counts its clicks, and redirects through an unknown domain hurt delivery.
- Needed before it works: a public address that reaches the route (a tunnel or proxy), set as Settings > Short links (`LINKS_BASE_URL` for provisioning). Without it, links are tagged but not shortened. Replacing the plugin's encryption key breaks issued links.
- CLI: `bb brandwise metrics links <entry>` lists each link with clicks, unique visitors and bot requests.
- Telegram still reports no views through the Bot API, so a Telegram post has clicks but no exposures, and an A/B test there cannot conclude yet. That needs an exposure source (step 6).

## Step 4: the client's site (GA4)

- `site/ga4.ts` is a pull source for every channel (`*`). It reads Google Analytics 4 through the Data API (`runReport`, read-only scope) by `sessionManualAdContent`, which is the `utm_content` every link carries since step 1. Per entry it reports `visits` (sessions), `leads` (key events), `orders` (purchases) and `revenue`.
- Leads come from the analytics the client already runs: no webhook, no CSV, no form changes. Setup is two steps.
  - Once per installation: a Google service account with the Analytics Data API enabled. Its JSON key goes into Settings > Web analytics.
  - Once per brand: the client adds the service account's e-mail to their GA4 property as a Viewer, and a person names the property on the brand's base campaign: `bb brandwise campaign channel set site propertyId=<id> [leadEvents=generate_lead,sign_up]`. Without `leadEvents`, every key event counts as a lead.
- Child campaigns inherit the property. Entries of brands without one are not measured: their site numbers are unknown, not 0.
- An entry of a measured property that GA4 has no row for had no visit yet, so it gets 0. GA4 processes data with a delay of hours, so recent numbers grow after the fact; each pull stores a new snapshot.
- The hourly automation "BrandWise metrics" (`provision.sh apply`) runs `metrics pull`. `metrics campaign` ends with the campaign's funnel: exposures, clicks, visits, leads, orders and revenue, each over the entries that report it.
- Leads are not yet a metric the rails decide on: experiments still judge click rate. Leads per entry are small numbers, so a lead test needs the exact test for rare events and enough of them. That comes later.

## Step 5: ad reports (Meta), read only

- An ad is a calendar entry on channel `meta_ads`, approved like any other entry. With no connector that buys (that is step 7), the scheduler parks it as "publish by hand" when its time comes. A person then launches the ad in Ads Manager with the link from `bb brandwise calendar tagged-link <id>` (`utm_medium=paid`, `utm_source=meta`, `utm_content=<entry id>`), and marks the entry published with the ad's id: `bb brandwise calendar published <id> --external <ad id>`, or "Mark published" in the entry's dialog.
- `calendar published` works for every channel without a connector, for example a post made in an app. It is the one action allowed on an entry whose time has passed, and only while it waits as `needs_manual`.
- `ads/meta.ts` is a pull source for `meta_ads`. It makes one Graph API read per 50 ads (`?ids=...&fields=insights.date_preset(maximum){...}`) and reports lifetime `exposures` (impressions), `reach`, `clicks` (link clicks) and `spend` (in the ad account's currency).
  - An ad without delivery has 0; an id Meta did not answer for is unknown.
  - The token travels in a header and needs only `ads_read`. Nothing here can spend money or change an ad.
- Ads have exposures and clicks, so the rails can judge an A/B test between two ads: both on `meta_ads`, in two child campaigns. Site visits and leads of an ad come from GA4 by the same `utm_content`. Meta's own conversion counts are not used.
- Settings > Ads: Meta access token (a system-user token with `ads_read`) and the Graph API version (default `v23.0`, which Meta retires after about two years).
- `metrics campaign`'s funnel adds reach and spend.

Notes on step 1:
- The actor is a label, not a verified identity: `ui` is a person on a page, `cli` or `cli:<label>` the command line (`--as <label>`), `auto` the tier-1 approval, `scheduler` publishing. The CLI refuses `--as ui`, `auto`, `scheduler` and `unknown`.
- Send-back reasons are a closed list: claims, facts, tone, brand, visual, legal, typo, offer, other. The approval dialog offers them; the CLI takes `--reason`.
- `utm_campaign` changed from the entry id to the campaign's slug. Reports that grouped by `utm_campaign` to find an entry must use `utm_content`.
