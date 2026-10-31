# Scoped settings and providers

Everything that differs per campaign (which provider generates creatives, with which account, and the limits) is a **scoped setting**. One mechanism, one table, no per-feature special cases.

## Scopes and inheritance

A value is set at a scope: **global**, or one **campaign**. A campaign sees its own value, else its parent's (the always-on base), else the global one, else the field's default. `bb brandwise config list [--campaign <c>]` shows what a scope sees and where each value comes from; the Settings page (global) and the Campaigns page (one campaign) show the same with a badge per field and a button to fall back to the inherited value.

| | |
| --- | --- |
| Table | `setting (campaign_id null = global, key, value jsonb, secret)` (migration 009) |
| Code | `packages/core/src/settings.ts` (generic), `packages/core/src/providers/` (what can be set) |
| What can be set | declared in code (`SettingField`); unknown keys and wrong types are refused |
| Secrets | encrypted at rest (AES-256-GCM). The key is the plugin setting Security > Encryption key (generated on first start, `BW_SECRET_KEY` for scripts). Secrets are never sent to the UI or printed; the CLI refuses to take them on the command line |

Not scoped: infrastructure the operator owns (database, S3, the path of a provider's CLI). Those stay plugin settings, because a campaign (or an agent working on one) must not be able to change what runs outside the sandbox.

## Providers

A provider is one file implementing `Provider` (`packages/core/src/providers/index.ts`) and listed in `PROVIDERS`:

- `fields`: its own settings (short keys, stored as `<id>.<key>`). Every provider also gets `maxPerGeneration` and `dailyBudget`, counted in its `unit`.
- `status`, `loginHint`: is the account of a scope signed in, and the command to sign in.
- `estimate`, `start`, `get`: cost check, start (this spends), poll.

To add one (fal, Runware, Google, ...): write the file, add it to `PROVIDERS`. The setting `generation.provider` offers it, the Settings and campaign pages render its fields (a field with `secret: true` becomes a write-only password field), `creative cost|generate|collect` use it. Nothing else changes.

### Higgsfield

The CLI keeps its OAuth login in `$HOME/.config/higgsfield`. Two settings give a scope its own account:

- **Account profile** (`higgsfield.profile`): a name; the CLI then runs with its own `HOME` (`~/.bb-brandwise/providers/higgsfield/<name>`), so it has its own login. Sign in once in a terminal with the command that `bb brandwise providers status --campaign <c>` (or "Check accounts") prints. Empty = the account signed in on the host.
- **Workspace id** (`higgsfield.workspaceId`): the billing workspace of the account (`HIGGSFIELD_WORKSPACE_ID`).

## Limits

`<provider>.maxPerGeneration` is resolved like any setting (the nearest scope wins). `<provider>.dailyBudget` nests: every scope of the chain that sets one applies, and spend is counted at every scope of the chain, so a budget on an always-on base covers all its campaigns and the global one covers everything (it defaults to 40 credits). A generation is refused, before anything is spent, if it breaks any of them.

## Downloads

Videos (yt-dlp) and photos (gallery-dl) from Instagram, TikTok and YouTube are downloaded by the plugin on the host (`bb brandwise assets download|download-photos`), because the agents' sandbox has no network. They need `yt-dlp`, `gallery-dl` and `ffmpeg` on the host: `infra/bb-instance/provision.sh apply` installs them (`tools/bootstrap.sh`) and `bb brandwise doctor` shows what is there.

Instagram shows photos to signed-in sessions only, so a download needs one, and it is the user's decision: no command takes a session as an argument and agents cannot import or pass one. The user connects Instagram under Settings > Providers > Downloads (globally, or for one campaign that uses another account):

- **Import from browser**: sign in to Instagram in Chrome (or Safari, Firefox, Brave, Edge) and click it. The plugin reads the `sessionid` cookie once (macOS may ask for Keychain access), saves it encrypted (`download.instagramSession`, a secret scoped setting) and tests it. Downloads then use it without any browser; for a call the plugin writes it to a private cookie file and deletes it afterwards.
- **Paste session id**: the manual fallback (browser dev tools > Application > Cookies > instagram.com > sessionid).
- **Test**: asks Instagram whether it accepts the session (lists one post, downloads nothing). **Disconnect** removes the saved session of that scope.
- `download.cookiesBrowser`: an alternative that takes the session from a browser at every download; used only when no session is saved.

It is a login, so use a dedicated account; Instagram signs sessions out from time to time, then Test says so and Import again. `bb brandwise instagram test [--campaign <c>]` is the same check for agents and `bb brandwise doctor [--campaign <c>]` shows which session a scope downloads with.
