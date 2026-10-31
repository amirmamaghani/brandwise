#!/usr/bin/env bash
# Download video (or audio) from YouTube, Instagram, TikTok and anything else yt-dlp supports.
# Usage: tools/video-dl.sh [--audio] [--cookies <browser>] [--out <dir>] <url>...
# stdout: one absolute file path per downloaded file. Logs/errors: stderr. A <id>.info.json
# (caption, uploader, stats) is saved next to each file. Default output: <repo>/downloads/<site>/<id>.<ext>
set -euo pipefail
# agent and service shells often lack Homebrew in PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/tools/bootstrap.sh" >&2

out="$root/downloads"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --audio) args+=(-x --audio-format mp3) ;;
    --cookies) args+=(--cookies-from-browser "${2:?--cookies needs a browser name, e.g. chrome}"); shift ;;
    --out) out="${2:?--out needs a directory}"; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
[ $# -gt 0 ] || { sed -n '2,4p' "$0" >&2; exit 2; }

# h264/m4a preferred so files play in QuickTime and upload to social platforms as-is
exec yt-dlp --no-playlist --quiet --write-info-json --restrict-filenames \
  -S "vcodec:h264,res,acodec:m4a" --merge-output-format mp4 \
  -o "$out/%(extractor)s/%(id)s.%(ext)s" --print after_move:filepath \
  ${args[@]+"${args[@]}"} "$@"
