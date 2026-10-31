#!/usr/bin/env bash
# Build an HTML preview of finished creatives (PNG/JPG/WEBP/GIF in ONE folder) so they render inline in the bb chat.
# Usage: tools/creative-preview.sh <image>...
# stdout: the `::inline-vis{...}` directive line. Paste it into the reply on its own line, OUTSIDE any code fence.
set -euo pipefail
[ $# -gt 0 ] || { sed -n '2,4p' "$0" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 -I - "$root" "$@" <<'PY'
import base64, html, mimetypes, os, sys
root, files = sys.argv[1], [os.path.abspath(f) for f in sys.argv[2:]]
for f in files:
    if not os.path.isfile(f): sys.exit(f"not a file: {f}")
folders = {os.path.dirname(f) for f in files}
if len(folders) != 1: sys.exit("all images must be in the same folder")
folder = folders.pop()
def uri(f):  # inline the bytes: relative src does not resolve inside the chat viewer
    return f"data:{mimetypes.guess_type(f)[0] or 'image/png'};base64," + base64.b64encode(open(f, 'rb').read()).decode()
figs = "\n".join(
    f'  <figure style="margin:0;flex:1;min-width:0"><img src="{uri(f)}" '
    f'alt="{html.escape(os.path.basename(f))}" style="width:100%;height:auto;display:block;'
    f'border-radius:var(--radius);border:1px solid var(--border)"><figcaption style="margin-top:6px;'
    f'color:var(--muted-foreground);font-size:12px">{html.escape(os.path.splitext(os.path.basename(f))[0])}</figcaption></figure>'
    for f in files)
out = os.path.join(folder, "preview.html")
page = f'<div style="display:flex;gap:12px;align-items:flex-start">\n{figs}\n</div>\n'
assert page.count('src="data:') == len(files), "every <img> must be a data URI"  # guards the broken-image regression
open(out, "w").write(page)
print(f'::inline-vis{{file="{os.path.relpath(out, root)}"}}')
PY
