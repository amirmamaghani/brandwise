---
name: download-video
description: Download a video or audio track from a YouTube, Instagram (reels/posts) or TikTok URL to a local file. Use whenever the user gives such a link and wants it downloaded, saved, analysed, transcribed or reused.
---

# Download video

Run from the repo root:

```bash
tools/video-dl.sh <url>...            # video -> mp4
tools/video-dl.sh --audio <url>       # audio only -> mp3
tools/video-dl.sh --cookies chrome <url>   # use logged-in browser session
tools/video-dl.sh --out <dir> <url>   # custom output dir
```

- **stdout** = absolute path of each downloaded file (use it directly in the next step). Everything else goes to stderr.
- Files go to `downloads/<site>/<id>.mp4`. Next to each is `<id>.info.json` with caption, uploader, title, duration, view/like counts – read it when the task needs metadata.
- Dependencies (yt-dlp, ffmpeg) are installed automatically via `tools/bootstrap.sh`.
- Single video only (`--no-playlist`); for a channel/playlist call the script per URL or use `yt-dlp` directly.

## Live streams

A live stream (`is_live` true, e.g. YouTube `/watch` of an ongoing broadcast) can't be downloaded whole – never run `tools/video-dl.sh` on it. When only the look is needed (graphic style, banner reference), grab a few frames of the live edge instead:

```bash
yt-dlp -F --no-playlist "<url>"                  # live formats are video-only m3u8; pick an id (e.g. 270 = 1080p)
url=$(yt-dlp -g -f <id> --no-playlist "<url>" | head -1)   # direct stream URL
mkdir -p downloads/live && ffmpeg -y -i "$url" -vf fps=1/5 -frames:v 4 downloads/live/frame-%02d.jpg
```

Then read the frames (Read tool) and show them with `tools/creative-preview.sh` (paste the printed `::inline-vis{...}` line). Never reference them only by relative path in chat: the sidebar link resolves against the wrong root and shows "File not found". Check first with `yt-dlp --print is_live "<url>"` if unsure. Needs network, so run unsandboxed only if the sandbox blocks it.

## When it fails

| Symptom | Fix |
|---|---|
| Instagram "login required" / "rate-limit" / empty media; YouTube "Sign in to confirm you're not a bot" | Retry with `--cookies chrome` (the user must be logged in there; macOS may prompt for Keychain access – tell the user). Only do this after the plain attempt failed. |
| `Unable to extract` / HTTP 4xx on a URL that works in browser | yt-dlp is outdated: `brew upgrade yt-dlp`, retry once. |
| Private account / deleted post | Cannot be fixed; report to the user. |

Only download content the user has the right to use. Do not bypass paywalls or private accounts.
