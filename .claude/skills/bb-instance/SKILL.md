---
name: bb-instance
description: Operate and develop the dedicated BB instance that runs the BrandWise (second BB on port 38896) and its plugin `apps/bb-plugin-brandwise`. Use when asked to start, stop, provision or check that instance, change or debug the plugin, or run `bb` commands against it.
---

# BrandWise BB instance

A second bb server runs the BrandWise, separate from the personal bb (port 38886). The plugin `brandwise` lives in `apps/bb-plugin-brandwise`; provisioning lives in `infra/bb-instance/`.

| What | Where |
|---|---|
| Web UI | `http://127.0.0.1:38896` |
| Server / host daemon ports | 38896 / 38897 (personal bb: 38886 / 38887) |
| Data dir (threads, secrets, plugin data; never commit) | `~/.bb-brandwise` |
| Declarative profile | `infra/bb-instance/profile.env` |
| Instructions the instance's agents get | `infra/bb-instance/AGENTS.md` (copied to the data dir) |
| Plugin skill for campaigns, calendar, assets | `apps/bb-plugin-brandwise/skills/brandwise/SKILL.md` |
| Shared logic (Postgres + S3) | `packages/core` (migrations in `packages/core/migrations`) |
| Connection settings | repo `.env` (copy `.env.example`), applied to the plugin by `apply` |

## Operate

```bash
infra/bb-instance/provision.sh status   # instance + plugin state
infra/bb-instance/provision.sh up       # start if needed, then apply
infra/bb-instance/provision.sh apply    # build, install/reload the plugin, apply profile.env
infra/bb-instance/provision.sh down     # stop
```

- The script is idempotent and non-interactive. Change settings in `profile.env`, not by hand.
- `apply` also runs the core migrations and sets the plugin's Postgres/S3 settings from `.env`; the local stack must be up first (`pnpm infra:up`, see the `infra` skill).
- `up` and `apply` write to `~/.bb-brandwise`, which the sandbox blocks: run them unsandboxed.
- The instance does not start at boot (no launchd yet).

## Reaching the instance from other devices (tailnet)

bb only binds `127.0.0.1` or `0.0.0.0` (`--server-bind-host`; anything else, e.g. a Tailscale IP, makes the server refuse to start). Do not use `0.0.0.0`: the server runs agents with a shell and would be open to the whole LAN. The supported way is Tailscale Serve in front of the loopback listener:

- Put `BW_TAILNET_HTTP_PORT=38896` in `infra/bb-instance/profile.local.env` (gitignored, machine-specific). `apply` then runs `tailscale serve --bg --http=<port> http://127.0.0.1:38896`; `down` removes it. Plain HTTP is fine inside the tailnet (WireGuard encrypts it); HTTPS needs the tailnet's HTTPS certificates switched on in the Tailscale admin console.
- bb answers `403 forbidden_host` to any hostname other than localhost, an IP, or the one in `BB_APP_URL`, so `up` exports `BB_APP_URL=http://<this Mac's MagicDNS name>:<port>`. Use that full name in the browser: `http://<machine>.<tailnet>.ts.net:38896`. The tailnet IP gets a 404 from Serve (it routes by hostname) and the machine's short name gets the 403.
- The personal bb (port 38886) is bound to all interfaces; leave it unless asked.

## Threads by campaign

bb's thread list cannot be extended (its Organize menu is a fixed list owned by the bundled thread-list plugin; the only hook replaces the whole list), so "by campaign" is built from plugin slots:

- A thread is linked to a campaign through this plugin's metadata namespace on the thread (`campaignId`). Write it with the thread menu action **Campaign** or `bb brandwise campaign assign|unassign <thread-id> [<campaign>]`.
- The **Campaigns** page has a sidebar that replaces the thread list while it is open and shows threads grouped by campaign; the page itself lists campaigns with thread, calendar and creative counts and creates new ones.
- The campaign chip under a thread title is a row-metadata item: provisioning turns on the `threadRowMetadata` experiment, and each user turns on Organize > Rows > Metadata.

## Display modes (Full / Minimal)

The plugin setting `mode` (`full` | `minimal`) decides how much of bb's own UI the instance shows. Minimal = marketing only: it switches off bb-account, connect, git, GitHub PR status, the code editor, annotations and the Codex/Pi/ACP providers, hides the Report-a-bug and Mobile footer items and the Plugins and Skills destinations. `profile.env` sets the default (`BW_MODE`), `apply` passes it on, and the plugin applies it itself on load through the SDK (`bb.sdk.plugins.enable|disable`, `bb.sdk.system.uiPreferences`). It records what it changed and the previous values, so switching back undoes exactly that.

- Users switch in Settings > "BrandWise display mode". The switch offers only the modes in `BW_MODES` (comma list in `profile.env`, read when the bb server starts, so change it and run `down` + `up`); one entry locks the mode. A caller can override per run: `BW_MODES=minimal infra/bb-instance/provision.sh up`.
- Modes are data in `apps/bb-plugin-brandwise/modes.ts` (`MODES`): `disablePlugins`, `uiPreferences`, `css`. A new mode or a new hidden item is one entry, no engine change; editing an entry re-applies it on the next plugin load (the engine stores a hash of the definition). Never list `brandwise` in `disablePlugins`.
- Switch from the shell: `bb brandwise mode set full|minimal`. Show state: `bb brandwise mode`; re-apply (e.g. after a bb update re-enabled something): `bb brandwise mode apply`. Full sets `sidebar.visiblePluginPanels` to null (all destinations) because bb keeps a stale allow-list there.
- Hide a bb footer item: add its key to `sidebar.hiddenFooterItems` (built-ins are `builtin:report-bug`, `builtin:mobile`; hidden items move into the More menu). Valid preference keys: `bb settings ui list`.
- Host UI with no setting or plugin behind it (e.g. links inside Settings) can only be hidden with `css` in the mode, which an app overlay injects. Selectors there must be checked in the real UI first.
- A plugin the user switched off by hand is not touched when leaving a mode (the engine only re-enables what it disabled).

## Talk to the instance, not to the personal bb

Every `bb` command needs these, otherwise it hits the personal bb and its thread:

```bash
unset BB_THREAD_ID BB_PROJECT_ID BB_ENVIRONMENT_ID BB_THREAD_STORAGE
export BB_SERVER_URL=http://127.0.0.1:38896 BB_HOST_DAEMON_PORT=38897
```

- `bb status` exits 0 even when no server listens. To test if the instance is up use
  `curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:38896/` (000 = down).
- Never install or disable plugins without this env set.

## Develop the plugin

1. Edit `server.ts` (RPC, CLI, settings) or `app.tsx` (UI slots) in `apps/bb-plugin-brandwise`.
2. Shared logic goes to `packages/core/src/index.ts`. bb refuses server imports outside the plugin folder, so `apply` copies it to `apps/bb-plugin-brandwise/core/` (generated, gitignored). Run `infra/bb-instance/provision.sh apply`; do not run a bare `bb plugin build` after changing the core, the copy would be stale.
3. Test the core with `cd packages/core && set -a && . ../../.env && set +a && npm test` (integration test against the local stack), and the plugin through `bb brandwise campaign|calendar|assets ...`.
4. A plugin that fails to load shows `error (...)` in `bb plugin list`; read the reason, fix, rebuild, reload.

Rules learned the hard way:
- CLI command names in `bb.cli.register({ commands })` must match `[a-z0-9-]+` (no spaces); parse sub-actions in `run(argv)`.
- `bb plugin install <path>` asks for confirmation (plugins are full-trust code); the script passes `--yes` for our own local plugin only.
- `npm install` in the sandbox needs `--cache "$TMPDIR/npm-cache"` and an allowed `registry.npmjs.org`. `pnpm install` fails in the sandbox (store lock): use npm in `packages/core` and in the plugin.
- Settings are data: `SECTIONS` in `server.ts` (one `section(id, title, description, fields)` per section). bb renders the descriptors as one flat form with no section API (the label prefix is the heading there); the plugin's Settings page (`settings.tsx`) renders the same sections with a navigation, reading and writing through `settings_get` / `settings_set`, and secrets are never sent to the page. To add a setting put it in a section; to add a section add a `section(...)`. Rich sections (not plain fields) are registered with `addSettingsSection` in `app.tsx`; the same id replaces the server's fields. Keys stay flat (`bb plugin config`, `profile.env` and `provision.sh` use them). Settings that a campaign can override (provider, account, limits) are not here: they are scoped settings in Postgres, declared by the providers in `packages/core/src/providers` (`docs/settings.md`). Any change applies at once: limits and paths are read per call, a new database or S3 setting rebuilds the core.
- UI slots are mostly `experimental_`; pin the bb version. Whether a slot renders cannot be checked from the terminal, ask the user to look.

## Architecture rules the plugin must keep

- The calendar is the only way anything leaves the system: agents create entries, they never publish.
- Tier 1 auto, tier 2 one click, tier 3 manual; unsure means the higher tier. Agents never approve unless the user says so.
- Campaigns, calendar and asset records are in Postgres, files in S3 (`docs/assets.md`). Current shortcuts: no RLS, no CLI for `asset_link`.
- Approved entries are fired by a bb automation, "BrandWise scheduler" (every minute, runs `bb brandwise calendar run-due`), created by `provision.sh apply`. Two more automations come with it: "BrandWise editor" (every 6 h, `editor autorun`: starts the editor or the author only on campaigns with the setting `editor.autoRun` and only when code finds work) "BrandWise learnings" (Mondays, `learnings mine`: E2 patterns) and "BrandWise ads" (hourly, `ads pull`: platform reports and media spend); see `docs/analytics.md`. Publishing goes through connectors (`packages/core/src/publish.ts`, `CONNECTORS`); a channel without one ends as `needs_manual`. Check it with `bb automation runs <id> --project <project id>`. Roadmap: `docs/roadmap.md`.
- Scripts of bb automations get a wrong `BB_SERVER_URL` (default server) and a `BB_CLI` that points to the launcher in `<data dir>/bin/bb`, which re-execs itself without end (a fork storm of hundreds of processes per second). Any automation script that calls `bb` must set `BB_SERVER_URL=http://127.0.0.1:$BB_SERVER_PORT` and `BB_CLI=$BB_CLI_DIR/bb` first (see `automation_script` in provision.sh). Never export `BB_CLI` as the launcher in your own tests.
