# Email: metrics and providers

**Status: steps 1 to 3 are built** (domain, store, `email stats`, webhook, Resend adapter and the `memory` test provider), the code is in `packages/core/src/email/`. Verified by tests (17 pass, including an integration test with the database). **There has been no live run through Resend yet**; the key, domain, segment and public webhook address are missing. There is no second provider yet. Claims about the capabilities of specific providers are verified when writing that provider's adapter, not here.

## 1. Metrics catalog

Basic rule: **every metric has one definition in code** (numerator, denominator, window). "Open rate" is not a provider number but our function over events, so it can be compared across providers.

**Sending and delivery**
- sent, delivered, deliverability = delivered / sent
- bounce: hard (permanent), soft (temporary), with a subtype (mailbox full, does not exist, blocked content, reputation); bounce rate = bounce / sent
- deferred (delayed), dropped (rejected, blocked), suppressed (before sending), failed
- inbox placement and spam share (from seed tests), spam trap hits

**Engagement**
- opens: total, unique; open rate = unique opens / delivered
- **machine opens** (Apple Mail Privacy Protection, image-loading proxies) separate from human ones, if the provider distinguishes them
- clicks: total, unique; CTR = unique clicks / delivered; **CTOR** = unique clicks / unique opens; clicks by link and position (heatmap)
- replies (reply rate), forwards, prints, reading time (skim, read), time to open and to click
- dimensions: device, email client, OS, country and city, language, hour and day of week

**List health**
- unsubscribes (unsubscribe rate), spam complaints (complaint rate, mailbox feedback loops), added to suppressions
- new subscribers, net growth, churn, re-subscribes, double opt-in confirmation rate, growth by source
- share of active subscribers (opened or clicked in 90 days), inactive ones and cleanup candidates

**Conversions and revenue**
- conversions and conversion rate, goals (demo booking, signup, purchase), landing page conversion
- revenue, revenue per email and per recipient, average order value, ROI, cost per acquisition, LTV from email
- attribution: window (e.g. 1, 7, 30 days), last click or multi-touch

**Reputation and technical**
- SPF, DKIM, DMARC and alignment pass rate, DMARC reports, BIMI, blacklists
- domain and IP reputation, complaint share (limits of the big mailbox providers: under 0.1% target, 0.3% ceiling), sender score

**Experiments and automations**
- A/B: difference (lift), statistical significance, winning variant; holdout (incremental effect versus unsent); improvement from send-time optimization
- flows: entries and exits, step completion, drop-off between steps, time in flow, time from trigger to conversion
- frequency and fatigue (emails per person and period, drop in engagement)

For decisions: **clicks, conversions and unsubscribes are reliable, opens are not** (pixel, machine opens, email clients block it). The catalog therefore marks each metric as `reliable` or `indicative`, so the agent does not mix them up.

## 2. Layers and dependency direction

```
Calendar ──► Connector "email" ──► Email domain ◄── Adapters (Resend, Brevo, memory, ...)
 (publish)    (thin, picks the        (types, ports,       (translate the provider API
              provider by the          metrics, ingest)     into our types; nothing else)
              campaign target)                ▲
                                              │
                                    Event store (Postgres)
```

Rules (enforced by a test that walks the imports):
1. **Domain** (`email/domain/`): types, ports, metrics catalog, formulas. Nothing depends on a provider, the database or S3. It is pure TypeScript.
2. **Adapters** (`email/adapters/<id>.ts`) import only the domain. They know nothing about the database, the calendar or the plugin. They are pure functions: provider input into our types, and our types into a provider call.
3. **Store** (`email/store.ts`) implements the `EventStore` port on top of Postgres. The domain knows it only as an interface.
4. **Connector `email`** is a thin layer between the calendar and the domain. It picks the provider from the campaign target (`provider=resend`), so **swapping the provider is a change of one setting**, not of code.
5. **Composition** (the only place that knows everything): in the plugin, adapters are built from the settings and registered. Credentials are passed through constructors, never globally.

## 3. Ports (interfaces by responsibility)

The original single large `EmailAdapter` was too broad: it mixed sending, event intake and setup. A provider may know only part of it (e.g. plain SMTP has no events, a provider with only totals has no webhooks). So there are three small ports, which an adapter implements as needed:

```ts
// sending (called by the connector from the calendar)
interface EmailSender {
  readonly id: string;
  createCampaign(draft: CampaignDraft): Promise<{ externalId: string }>;   // always a draft
  schedule(externalId: string, at: Date): Promise<void>;
  sendTest?(externalId: string, to: string[]): Promise<void>;
  cancel?(externalId: string): Promise<void>;
}

// event intake (called by the webhook route or the polling scheduler)
interface EmailEventSource {
  readonly id: string;
  parseWebhook?(req: { headers: Headers; body: string }): EmailEvent[];    // verifies the signature, writes nothing
  pull?(since: Date): AsyncIterable<EmailEvent>;                           // if the provider has no webhooks
  pullTotals?(send: SendRef): Promise<Counts>;                             // if it gives only totals
}

// tracking state (optional; "is open and click tracking enabled?")
interface TrackingCheck { status(): Promise<TrackingStatus>; }

type EmailProvider = { id: string; capabilities: Capabilities; sender?: EmailSender; events?: EmailEventSource; tracking?: TrackingCheck };
```

An adapter never writes to the database: it returns events and **intake** stores them (one `ingest(events)` function in the domain, used by both the webhook and polling). Dedup, storage and recalculation are in one place.

## 4. Capabilities determine metric availability (nothing is written by hand per provider)

```ts
type Capabilities = {
  emits: ReadonlySet<EventType>;       // which events the provider can send: sent, delivered, opened, clicked, bounced, ...
  details: ReadonlySet<DetailKey>;     // which details: link, bounceClass, bounceReason, machine, device, country, ...
  features: ReadonlySet<Feature>;      // drafts, scheduling, sendTest, segments, abTest, subAccounts, ...
};
```

Every metric in the catalog declares what it needs: `requires: { events: ["delivered","clicked"], details: [] }`. Availability is derived: a metric is available if `requires ⊆ capabilities` of the provider that sent the campaign. A new provider capability = one field in its declaration and the metrics unlock themselves. A metric the provider cannot supply shows as "unavailable" (never as 0).

## 5. Normalized event and our identifiers

```ts
type EmailEvent = {
  provider: string;
  providerEventId: string;            // dedup together with `provider`: webhooks arrive "at least once"
  type: EventType;                    // sent | delivered | deferred | bounced | dropped | suppressed | failed | opened | clicked | unsubscribed | complained | replied
  at: string;                         // UTC
  sendId: string;                     // OUR send identifier (not the provider's), see below
  recipient: { hash: string; domain: string };
  detail: { bounceClass?; bounceReason?; link?; linkPosition?; machine?: boolean | null; device?; client?; country? };
  raw: unknown;                       // the whole original payload, lossless
  schemaVersion: 1;
};
```

**Why swapping the provider does not break the statistics:** everything is tied to **our** `send`, not to provider identifiers.
- On send, a record `email_send(id, entry_id, provider, external_id, capabilities_snapshot, created_at)` is created. The provider receives our `send_id` as a tag or metadata (each adapter translates this in its own way: tag, custom header, utm; a contract test verifies that it comes back in the event).
- Events carry `sendId`. Metrics are computed by `entry_id` or campaign through `email_send`, **never by provider**.
- Changing the provider mid-year: old sends stay with Resend and its events, new ones go through the new one. The campaign or period overview sums them, because both are in the same shape.

## 6. Metrics: one input shape, three sources

Formulas are pure functions over **`Counts`**, not over events or over the provider:

```ts
type Counts = { sent; delivered; bounced: { hard; soft }; opened: { total; unique; humanUnique? }; clicked: { total; unique; perLink? }; unsubscribed; complained; ... };
```

- **From events** (main source): `eventsToCounts(events)`. Uniqueness is computed by **us** (recipient + `sendId`), not by the provider's flag, so it is the same everywhere.
- **From provider totals** (only if the provider has no events): `pullTotals` returns `Counts` directly. Metrics that depend on details (per link, machine opens) are then marked unavailable.
- **Recalculation** of `Counts` into metrics (`open_rate`, `ctr`, `ctor`, `bounce_rate`, ...) is the only place with formulas and denominators, shared by all providers.
- The catalog marks metrics as `reliable` or `indicative` (opens are indicative). Machine opens are subtracted if the provider distinguishes them (`machine` is not `null`), otherwise the metric is `indicative`.

The agent reads only results: `email stats <entry | campaign | period>`.

## 7. Webhooks and intake

- One plugin route `/webhooks/email/<provider>`. It looks up the adapter in the registry and calls `events.parseWebhook`. Bad signature → 401 with no write. Duplicate → 200 (already stored). Unknown provider event → only `raw` is stored with type `unknown`, nothing crashes.
- Credentials and signing keys are in the plugin settings and go to the adapter as constructor parameters.
- Polling (`pull`) is a scheduled bb automation, just like the scheduler, and calls the same `ingest` function.

## 8. File layout

```
packages/core/src/email/
  domain/        types.ts  ports.ts  capabilities.ts  metrics.ts  counts.ts  ingest.ts   (pure domain, no pg or S3)
  adapters/      memory.ts (test provider, produces events)  resend.ts  index.ts (list)
  store.ts       EventStore on Postgres (email_send, email_event)
  connector.ts   Connector "email" for calendar publish (picks the provider from the campaign target)
  email.arch.test.ts   enforces the dependency rules (domain imports nothing; adapter only domain)
```

Build note: provisioning currently copies `packages/core/src/*.ts` with a flat copy (bb rejects imports outside the plugin folder). Subfolders must be copied recursively, which is a small change to `provision.sh`.

## 9. How to add a provider

1. `adapters/<id>.ts`: a function `<id>Provider(config): EmailProvider` with declared capabilities and the ports the provider supports. Nothing else changes.
2. Add it to `adapters/index.ts`.
3. **Contract tests** (one suite for all adapters, also run over `memory`): recorded payloads → expected `EmailEvent`; `sendId` comes back in the event; a bad signature is rejected; a draft is never sent without `schedule`; capabilities match what the adapter actually emits.
4. The "what each provider can do" table is generated from the declared capabilities.
5. Campaign target: `bb brandwise campaign channel set email provider=<id> list=<...> from=<...>`.

## 10. Build order

1. Domain (types, ports, `Counts`, metrics catalog, `ingest`) and the `memory` provider with contract tests and the dependency test. No Resend, no network.
2. `store.ts` (migration `email_send`, `email_event`), `email stats`, webhook route.
3. Resend adapter (sender, event source, tracking check) and contract tests on its fixtures.
4. **Second provider** (Brevo or MailerLite) as a test of the abstraction: if it requires a domain change, the abstraction was wrong and gets fixed here, not worked around.
5. Conversions (`bw_eid`, UTM, events from the web) and A/B tests.

## 11. What to know before building

- The exact capabilities of Resend (event fields on open, email list, Broadcast API fields) and prices are verified at the adapter.
- Legal: we store the recipient hash (with the installation salt) and the domain, not addresses. Lists, consent and suppression stay with the provider.
- The dependency test must be written as part of step 1, otherwise the rules get broken over time.

## 12. What changed during the build compared to the design above

- **The event carries `ref`, not `sendId`:** `{ sendId?, externalId? }`. Resend does not support tags on campaigns (Broadcasts), so the event is matched to our send via `broadcast_id` (`email_send.external_id`). An event that arrives before we know the send is stored and attached at `recordSend`.
- **`send(externalId, { at? })` instead of `schedule`:** the scheduler triggers the entry only at its time, so it sends immediately. `sendTest` and `TrackingCheck` were not built (Resend has no verified endpoint for domain tracking status).
- **One send per entry** (`email_send.entry_id` is unique): a retry after a failure uses the same draft and first asks the provider whether it has already gone out (`status`), so a second campaign or second send is never created.
- **Privacy:** `raw` contains no addresses or IPs (the adapter replaces them before storing). The recipient is a salted hash and the domain; the salt is a plugin secret.
- **Webhook** is a plugin HTTP route without bb login (`auth: "none"`, which bb allows only for signed webhooks); without a valid signature nothing is stored.
- **Email body:** the entry `title` is the subject, `body` is text (or HTML if it starts with `<`), `link` gets UTM tags. An unsubscribe link is always added if the body does not have one.
- **Not addressed:** unsubscribes (Resend reports them as contact events, not email events, so `unsubscribe_rate` is "unavailable" for Resend), segmentation, A/B, conversions (`bw_eid`), claim checks before approval.
