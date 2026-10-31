#!/usr/bin/env bash
# Regenerates docs/images/*.svg. Edit the diagram scripts in this folder, then run it. Needs only python3.
set -euo pipefail
cd "$(dirname "$0")"
for f in flow architecture email; do python3 "$f.py"; done
echo "wrote docs/images/{flow,architecture,email}.svg"
