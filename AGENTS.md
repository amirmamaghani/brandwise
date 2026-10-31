# brandwise

**Language rule:** everything you write into this repository is in English: Markdown files (docs, skills, README), code comments, strings and prompts, commit messages, issue and PR text. Answer the user in the language they write in, but never commit non-English text. `tools/check-english.sh` enforces it for Markdown.

Turborepo monorepo (pnpm). CLI scripts and tools for marketing.

## Tools (`tools/`)

Standalone scripts, not workspace packages. Run `tools/bootstrap.sh` once (installs yt-dlp + ffmpeg via Homebrew; the scripts also call it automatically).

- `tools/video-dl.sh <url>...` – download YouTube / Instagram / TikTok video. Prints file paths on stdout. See `.claude/skills/download-video/SKILL.md` for flags and failure handling. Downloads land in `downloads/` (gitignored).
- `tools/creative-preview.sh <image>...` – builds `preview.html` next to the images (all in one folder) and prints an `::inline-vis{file="..."}` line, see "Showing creatives in chat". Images are embedded as data URIs (relative `src` and plain path links break in the chat viewer).

## Local infrastructure

`pnpm infra:up` / `pnpm infra:down` run Postgres (:5436) and a local S3 emulator (:9010) from `infra/docker-compose.yml`. Config is in `.env.example` (production storage = the same `S3_*` variables). Read `.claude/skills/infra/SKILL.md` before any docker command; campaigns, assets and storage keys are in `docs/assets.md`.

## BrandWise BB instance

A dedicated bb instance (port 38896) runs the BrandWise; its plugin is `apps/bb-plugin-brandwise` (a thin shell over `packages/core`: campaigns, calendar and assets on Postgres + S3), provisioning is `infra/bb-instance/provision.sh`. Before starting, stopping or changing either, read `.claude/skills/bb-instance/SKILL.md` (env vars to target the right instance, sandbox caveats, plugin rules).

Video: `packages/video-remotion` is an optional engine (Remotion projects per campaign, Studio on 127.0.0.1, own licence, see its README); the plugin's Video page and `bb brandwise video ...` use it. Each BrandWise page has a "Start agent" action in its side panel (`apps/bb-plugin-brandwise/agents.ts`).

## Showing creatives in chat

Every creative you produce (image or video poster) must be shown inline in the chat, not only named by path:

1. Register it: `bb brandwise assets add <file> ...` prints the asset id.
2. Put `::creative{ids="<id>[,<id>...]"}` in your reply as its own line, outside any code fence. The BrandWise plugin renders it with the Creatives page's tile and opens the same preview dialog on click.
3. Only for files that are not registered yet (drafts, reference frames): run `tools/creative-preview.sh <image1> [<image2> ...]` (images in one folder) and paste the printed `::inline-vis{file="..."}` line instead.
4. Say only what the image does not show (prompt, model, cost, caveats). For small HTML pages without files use a fenced `inline-vis` block instead.
