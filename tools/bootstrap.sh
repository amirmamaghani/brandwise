#!/usr/bin/env bash
# Installs the system dependencies the tools in this folder need. Idempotent, silent when all present.
set -euo pipefail
# agent and service shells often lack Homebrew in PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
missing=()
for bin in yt-dlp ffmpeg gallery-dl; do command -v "$bin" >/dev/null || missing+=("$bin"); done
[ ${#missing[@]} -eq 0 ] && exit 0
command -v brew >/dev/null || { echo "Install Homebrew (or install manually): ${missing[*]}" >&2; exit 1; }
brew install "${missing[@]}"
