# BrandWise instance

This bb instance runs BrandWise: campaigns, a content calendar and creatives for the brands you manage. The repo is `brandwise`.

- Data is organised in campaigns (an always-on base per brand or product, and time-bound campaigns under it). The content calendar is the only way anything
  leaves the system. Use `bb brandwise calendar ...`, never publish directly. Register every creative with
  `bb brandwise assets add` (add `--ai` and `--provenance` for generated ones). Tier 1 is automatic, tier 2 one click, tier 3 manual; if unsure use the higher tier.
- Never approve an entry yourself unless the user says so.
- Give every calendar entry its real text (`--body`) and link: a human approves what they can read. Entries with status `changes_requested` come back with a note in `calendar list`; fix them with `calendar edit`, which resubmits them.
- Claims about price, warranty or subsidies need tier 3 and must exist in the client's `claims.md`.
- Show every creative in chat by its asset id: after `assets add`, put `::creative{ids="<id>[,<id>...]"}` on its own line
  (outside any code fence). It renders the same tile and preview as the Creatives page. `tools/creative-preview.sh` is only for
  files that are not registered yet.
- Videos from Instagram, TikTok or YouTube (samples, references): `bb brandwise assets download <url> --campaign <c>`; photos of an Instagram profile or post: `bb brandwise assets download-photos <url> --campaign <c>`. Both run on the host outside your sandbox and register the files as reference assets (they print the local paths; analyse videos with ffmpeg). Instagram shows photos to signed-in sessions only: if an attempt fails with "user could not be found" or a login error, tell the user to connect Instagram under Settings > Providers > Downloads (one click: Import from browser); `bb brandwise instagram test --campaign <c>` shows whether it works. You never choose, import or pass a session yourself. Do not try browsers or yt-dlp yourself, never republish downloaded media, and a real person's photos are reference only: generating that person's likeness needs their written consent. `bb brandwise doctor` shows whether the host tools are installed.
- Generating creatives: always through `bb brandwise creative cost|generate|collect --campaign <c>`, never by running a provider's CLI yourself (it runs outside your sandbox through the plugin, with the account and limits of the campaign). Check the cost first and generate only if it is small or the user agreed. Which media a model takes differs (video models take a start image, not references): read the `brandwise` skill section "Which media a model takes" and `bb brandwise creative model <id>` before using one. Never change settings (`config set|unset`) or accounts to get a job through; tell the user what blocks it.
