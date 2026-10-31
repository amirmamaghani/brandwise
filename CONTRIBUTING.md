# Contributing to BrandWise

Thanks for helping. This is a young project: small, focused pull requests get reviewed fastest.

## Before you start

- **Open an issue first** for anything bigger than a bug fix or a small improvement, so we agree on the approach before you write code.
- Read the design rules below. A change that breaks one of them will not be merged, however useful.

## Design rules

1. **The calendar is the only way out.** Nothing is published except through a calendar entry that a human approved and the scheduler fired. Agents never approve.
2. **Agents never see credentials.** Keys live in plugin settings; commands that agents run must not print them.
3. **Modules depend inward.** `packages/core` does not import the plugin or bb. In `packages/core/src/email`, the domain imports no provider, database or plugin code, and adapters import only the domain (a test enforces this).
4. **Providers are interchangeable.** Statistics are computed from our own records and the provider-neutral event type. Do not leak provider ids or provider-specific fields into the domain.
5. **Personal data stays out of what we store.** Recipient addresses and IPs are hashed or dropped before an event is saved.
6. **Humans decide the audience.** An agent must not be able to choose who receives a message.

## Development setup

Requirements: Node 24, Docker, [bb](https://getbb.app) 0.48+, `rsync`.

```bash
cp .env.example .env
npm run infra:up
cd packages/core && npm install && npm test     # integration tests need the stack above and skip without it
cd ../../apps/bb-plugin-brandwise && npm install && npx tsc --noEmit
```

`infra/bb-instance/provision.sh apply` builds the plugin against a generated copy of `packages/core` and reloads it in a running instance. Read `.claude/skills/bb-instance/SKILL.md` first: it lists pitfalls (wrong environment variables inside bb automations, sandbox limits, and others).

## Pull requests

- Branch from `main`; one topic per pull request.
- Add or update tests. New connectors and e-mail providers must pass the shared contract tests (`packages/core/src/email/contract.ts` for e-mail).
- Tests that touch the database clean up after themselves (use `purge` from `src/testing.ts`) and use unique names, because test files run in parallel.
- Run `npx tsc --noEmit` in the plugin and `npm test` in `packages/core` before you push; CI runs both.
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`), in English. Pull request descriptions are in English too.
- Never commit secrets, `.env` files, customer data or generated creatives. Do not commit real brand assets of a client.
- **Everything committed is in English**: Markdown files (docs, skills, README), commit messages, issues and pull requests, and the prompts and strings in code. `npm run check:english` (also run by CI) fails when a Markdown file contains Slovak or Czech letters. Agents answer users in the user's language, but what they write into the repository is English.

## Reviews

A maintainer reviews every pull request. Expect questions about the design rules above. We squash-merge, so your branch history does not matter.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
