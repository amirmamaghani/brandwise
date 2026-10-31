#!/usr/bin/env bash
# Fails when a tracked Markdown file contains letters specific to Slovak or Czech. Everything in this repository (docs, skills,
# README, issue and PR text) is written in English; replies to users may follow their language, committed text may not.
set -euo pipefail
cd "$(dirname "$0")/.."
hits=$(git ls-files -z '*.md' | xargs -0 grep -n -P '[ľščťžýôäňĺŕďĽŠČŤŽÝÔÄŇĹŔĎ]' 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "Markdown files must be in English. Non-English text found:" >&2
  echo "$hits" | cut -c1-160 | head -40 >&2
  exit 1
fi
echo "ok: all tracked Markdown files are English"
