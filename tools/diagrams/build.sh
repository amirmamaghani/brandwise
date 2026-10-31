#!/usr/bin/env bash
# Regenerates docs/images/*.svg. Edit the diagram scripts in this folder, then run it. Needs only python3.
set -euo pipefail
cd "$(dirname "$0")"
for f in flow architecture email regulator logo; do python3 "$f.py"; done
# PNG avatars for X, GitHub and others (needs rsvg-convert; skipped without it)
if command -v rsvg-convert >/dev/null; then
  for n in avatar avatar-dark; do rsvg-convert -w 1024 ../../docs/images/$n.svg -o ../../docs/images/$n.png; done
fi
echo "wrote docs/images/{flow,architecture,email,regulator,logo,avatar}*"
