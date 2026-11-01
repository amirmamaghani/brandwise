# The editor-in-chief: a feedback regulator for e-mail

People set the goals. An **editor agent** watches the results and steers the campaign: it proposes A/B experiments, hands the writing to **author agents**, and keeps a journal. **Code decides** whether an experiment may start and who won (the rails). Everything the agents produce still goes through the calendar and its approval.

## The control loop

| Control theory | In BrandWise |
|---|---|
| Setpoint | goals per campaign: `click_rate` target, `complaint_rate` / `unsubscribe_rate` / `bounce_rate` limits. Set by a person. |
| Sensor | e-mail events turned into counts and signals (`bb brandwise editor signals`) |
| Controller | the editor agent (skill `editor`), one run per invocation, memory in the journal |
| Actuator | tasks for author agents, then calendar entries, then the scheduler and the provider |
| Plant | the audience and the mailbox providers |
| Delay | results keep arriving for about a day after sending |
| Noise | small samples, privacy proxies that fake opens |
| Constraints | limits (complaints, unsubscribes) and the rails below |

## The rails (`packages/core/src/regulator/rails.ts`)

Code, not prompt: an agent can ask, it cannot overrule. Each rule answers a known way a loop goes wrong.

| Rule | Why |
|---|---|
| **Maturity**: an arm is judged 24 h after sending, never earlier | reacting to data that is still arriving makes the loop oscillate |
| **Minimum sample**: 200 delivered per arm | do not decide on noise |
| **Significance and minimum lift (hysteresis)**: p < 0.05 and at least 10 % relative difference | the incumbent changes only for a clear, sizeable win |
| **Cooldown**: 24 h after an adoption | let a change settle, one change at a time |
| **One running experiment** per campaign | one variable at a time, so a result has one cause |
| **Guards**: complaint rate 0.3 %, unsubscribe rate 1 % | limits, not goals (Goodhart): a clickbait winner is rejected; two unsafe arms **freeze** the campaign until a person clears it |
| **Separate audiences**: the arms are entries in two different child campaigns | otherwise the same people get both variants |
| **Final verdicts**: a concluded experiment cannot be re-judged | the agent cannot shop for a better answer |

The statistics (`stats.ts`) are two-sided two-proportion z-test and Wilson intervals. Guards use the point estimate on purpose: a false alarm costs less than a breach.

## Roles and commands

- **Editor** (`skills/editor`): reads `editor signals` and the journal, evaluates or proposes one experiment per run, creates `write_variant` tasks, writes the journal. Cannot approve, publish, change goals or clear a freeze.
- **Author** (`skills/author`): claims tasks, writes the entries into the arm campaigns exactly as asked, completes the task.
- **Person**: sets goals (`editor goals set <metric> <value> --kind target|limit`), clears a freeze (`editor unfreeze`), approves what needs approval.

```
bb brandwise editor signals [--campaign <c>] [--as-of <ISO>]
bb brandwise editor experiments list | propose --a <entry> --b <entry> --hypothesis "..." --lever "attribute: from -> to" | evaluate <id> | backfill
bb brandwise editor journal read [--limit n] [--kind learning] | write "<text>"
bb brandwise editor tasks list | create --kind <k> --brief "..." [--params '<json>'] | claim <id> | complete <id> [--result '<json>']
bb brandwise editor goals [set ...] | unfreeze
bb brandwise sim status | advance <90m|24h|2d> | reset
bb brandwise brief --campaign <c> --channel email          (what is known, what not to re-test, the reviewer's rules)
bb brandwise editor autorun                                (the automation: starts the editor or author only when code finds work)
```

Every verdict becomes a structured **learning** (E1) keyed on the experiment's lever; an inconclusive one becomes a null result that blocks a re-test of the same lever at the same audience size until it ages out. Authors and page agents read the same learnings through `brief`. Details: [`analytics.md`](analytics.md), phase 1.

The commands take the always-on base campaign (a child resolves to its base). The identity given with `--as` is a label for the journal, **not** an authorisation: whether a caller is really the editor is not enforced yet, only the skills say who may do what.

## Testing without waiting: the simulated provider

`simEnabled` (plugin setting, section Development) adds the provider **`sim`**. It sends nothing; it answers a send with the events a real provider would produce for a synthetic audience (opens within hours, clicks minutes later, complaints, unsubscribes, privacy-proxy opens), following a hidden model (`email/adapters/sim-model.ts`) in which, for example, a personal, concrete subject line does well and urgency or ALL CAPS raises opens but also complaints (a deliberate trap). It runs on a **development clock**: `sim advance 24h` moves time, so a day of delay costs one command. The same events are counted, judged and reported as real ones.

Target of a simulated arm campaign: `campaign channel set email provider=sim from="Lab <lab@example.com>" audienceSize=600 seed=<any text>`.

### Three layers of tests

1. **Rails and statistics** (`regulator.test.ts`, pure, milliseconds): wait before maturity, hysteresis, guards, freeze, cooldown.
2. **The closed loop with a scripted controller** (`loop.test.ts`, database, seconds): the simulated world, the clock and the rails together. Asserts that the loop converges on a better variant, refuses to decide on immature data, keeps the incumbent against a near-identical variant, rejects the clickbait variant because of the complaint guard, and freezes when both arms are unsafe.
3. **The agentic test** (`packages/core/scripts/editor-loop.mjs`): real editor and author agents against the simulated world.

```bash
cd packages/core && set -a && . ../../.env && set +a
node scripts/editor-loop.mjs --cycles 9 --step 13h
```

One recorded 18-cycle run (7 experiments, 6 concluded): the agents took the click rate from a 3.5 % baseline to 8.5 % (true value in the simulated world) with two adoptions, the other four conclusions were inconclusive and left the incumbent alone (hysteresis), nothing unsafe was adopted, and every hard check passed. The agents never tried a clickbait subject on their own, so the guard path is covered by the scripted test, not by this run. Authors hand in only a subject line (`editor tasks submit`); the system builds the entry, because an author that was asked to schedule it picked a wrong date.

A cycle is: an editor run, an author run if there are open tasks, one scheduler pass, then the clock moves on. The harness decides nothing for the agents. Afterwards it checks the database against the rules that must hold whatever the agents did (no verdict on immature data, separate arm audiences, no unsafe winner, goals untouched, a journal entry per run, a learning per conclusion, tasks claimed by an author) and reports soft results (at most one statistically false adoption, the final incumbent at least as good as the baseline). It exits non-zero when a hard rule fails.

## Going from the lab to real e-mail

- The loop already judges real events the same way; the difference is the provider. With Resend, an experiment needs two audiences: one segment and one child campaign per arm (`campaign channel set email provider=resend segmentId=...`).
- Maturity is counted from the send's `sent` event. Events must reach the system (webhook), otherwise there is nothing to regulate on.
- Open and click tracking must be on for the sending domain; click rate needs it.
- Opens are skewed by privacy proxies, which is why the loop is built on clicks.

## Not built yet

- Verified caller identity (editor, author, person), and an approver agent with a policy and a veto window.
- Other channels, budgets for paid promotion. (Other levers than the subject exist for e-mail: an experiment can vary one slot of a published template, see `docs/email-templates.md`.)
- Per-campaign rails (they are defaults in code), and a UI page for goals, experiments and the journal (learnings have one: Results > Learnings).
- Multi-armed experiments (only A/B), and sequential testing.
