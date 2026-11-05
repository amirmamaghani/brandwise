#!/usr/bin/env bash
# A public test address for this Mac through a Cloudflare quick tunnel (no Cloudflare account): a test page and the short-link
# redirect of the BrandWise instance, nothing else of bb (its UI and API stay on loopback; the front in tools/public-test/server.mjs
# forwards only `/l`). Test only: the address changes at every start, and links break while the Mac sleeps (docs/analytics.md, step 3).
#   tools/public-test.sh up [--links]   start the front and the tunnel, print the address; --links also points the plugin's short links at it
#   tools/public-test.sh status | url | down
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$root/infra/bb-instance/profile.env"; [ -f "$root/infra/bb-instance/profile.local.env" ] && . "$root/infra/bb-instance/profile.local.env"; set +a
state="${BW_PUBLIC_TEST_DIR:-/tmp/bw-public-test}"; mkdir -p "$state"
port="${BW_PUBLIC_TEST_PORT:-38909}"   # 38899 is taken by bb's own proxy

# the same bb resolution as infra/bb-instance/provision.sh: the BrandWise instance, and the desktop app's copy when no `bb` is on PATH
unset BB_THREAD_ID BB_PROJECT_ID BB_ENVIRONMENT_ID BB_THREAD_STORAGE
export BB_SERVER_URL="http://127.0.0.1:$BW_SERVER_PORT" BB_HOST_DAEMON_PORT="$BW_DAEMON_PORT"
bb_app_dist="/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist"
if ! command -v bb >/dev/null 2>&1 && [ -f "$bb_app_dist/bb.js" ]; then
  bb() { BB_DATA_DIR="$BW_DATA_DIR" ELECTRON_RUN_AS_NODE=1 /Applications/bb.app/Contents/MacOS/bb "$bb_app_dist/bb.js" "$@"; }
fi

alive() { [ -f "$state/$1.pid" ] && kill -0 "$(cat "$state/$1.pid")" 2>/dev/null; }
url() { [ -s "$state/url" ] && cat "$state/url"; }

up() {
  if ! command -v cloudflared >/dev/null; then
    command -v brew >/dev/null || { echo "Install cloudflared first (brew install cloudflared)" >&2; exit 1; }
    brew install cloudflared
  fi
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$BB_SERVER_URL/")" = 000 ]; then
    echo "note: no BrandWise instance on $BB_SERVER_URL; the page works, short links answer 502 until it is up" >&2
  fi
  if ! alive front; then
    PORT="$port" BW_SERVER_URL="$BB_SERVER_URL" nohup node "$root/tools/public-test/server.mjs" >"$state/front.log" 2>&1 &
    echo $! >"$state/front.pid"
  fi
  if ! alive tunnel; then
    rm -f "$state/url"
    nohup cloudflared tunnel --url "http://127.0.0.1:$port" --no-autoupdate >"$state/tunnel.log" 2>&1 &
    echo $! >"$state/tunnel.pid"
  fi
  for _ in $(seq 1 40); do
    u="$(grep -o -E 'https://[a-z0-9-]+\.trycloudflare\.com' "$state/tunnel.log" | head -1 || true)"
    [ -n "$u" ] && { echo "$u" >"$state/url"; break; }
    sleep 1
  done
  [ -s "$state/url" ] || { echo "the tunnel gave no address in 40 s, see $state/tunnel.log" >&2; exit 1; }
  u="$(url)"
  if [ "${1:-}" = "--links" ]; then
    bb plugin config brandwise set linksBaseUrl "$u/l" >/dev/null
    echo "linksBaseUrl = $u/l (posts published from now on carry short links through this address)"
  fi
  echo "$u"
}

status() {
  for p in front tunnel; do if alive "$p"; then echo "$p: running (pid $(cat "$state/$p.pid"))"; else echo "$p: stopped"; fi; done
  echo "address: $(url || echo none)"
}

down() {
  u="$(url || true)"
  # clear the plugin's short-link address only when it is ours
  if [ -n "$u" ] && bb plugin config brandwise 2>/dev/null | grep -q -F "linksBaseUrl = \"$u/l\""; then
    bb plugin config brandwise unset linksBaseUrl >/dev/null && echo "linksBaseUrl cleared"
  fi
  for p in tunnel front; do
    if alive "$p"; then kill "$(cat "$state/$p.pid")"; fi
    rm -f "$state/$p.pid"
  done
  rm -f "$state/url"
  echo "down"
}

case "${1:-}" in
  up) up "${2:-}" ;;
  status) status ;;
  url) url || { echo "not up" >&2; exit 1; } ;;
  down) down ;;
  *) sed -n '2,7p' "$0" >&2; exit 1 ;;
esac
