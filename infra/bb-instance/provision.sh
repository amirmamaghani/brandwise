#!/usr/bin/env bash
# Provision and run the dedicated BB instance of the BrandWise. Idempotent, non-interactive.
# Usage: infra/bb-instance/provision.sh up|apply|status|down
#   up      start the instance if needed, then apply
#   apply   (re)install the plugin and apply settings from profile.env to a running instance
#   status  show instance and plugin state
#   down    stop the instance
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
set -a; . "$here/profile.env"; [ -f "$here/profile.local.env" ] && . "$here/profile.local.env"; set +a  # profile.local.env: machine-specific, gitignored

abs() { case "$1" in /*) echo "$1" ;; *) echo "$root/$1" ;; esac; }
data_dir="$BW_DATA_DIR"
plugin_dir="$(abs "$BW_PLUGIN_DIR")"

# Point every bb command at THIS instance, never at the personal one the script may run inside of.
unset BB_THREAD_ID BB_PROJECT_ID BB_ENVIRONMENT_ID BB_THREAD_STORAGE
export BB_SERVER_URL="http://127.0.0.1:$BW_SERVER_PORT" BB_HOST_DAEMON_PORT="$BW_DAEMON_PORT"

# `bb status` exits 0 even when nothing listens, so ask the port itself (000 = no answer)
running() { [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$BB_SERVER_URL/")" != 000 ]; }

start() {
  if running; then echo "instance already running on $BB_SERVER_URL"; return; fi
  mkdir -p "$data_dir/logs"
  cp "$here/AGENTS.md" "$data_dir/AGENTS.md"
  # bb refuses Host headers other than localhost/IPs and the hostname in BB_APP_URL (forbidden_host)
  if [ -n "${BW_TAILNET_HTTP_PORT:-}" ]; then export BB_APP_URL="http://$(tailnet_host):$BW_TAILNET_HTTP_PORT"; fi
  echo "starting bb-app (data dir $data_dir)"
  nohup bb-app --data-dir "$data_dir" --server-port "$BW_SERVER_PORT" \
    --host-daemon-port "$BW_DAEMON_PORT" --no-in-app-updates \
    >"$data_dir/logs/bb-app.out" 2>&1 &
  for _ in $(seq 1 60); do running && return; sleep 1; done
  echo "instance did not come up in 60 s, see $data_dir/logs/bb-app.out" >&2; exit 1
}

apply() {
  running || { echo "no instance on $BB_SERVER_URL, run: $0 up" >&2; exit 1; }
  [ -f "$root/.env" ] || { echo "missing $root/.env, run: cp .env.example .env (and pnpm infra:up)" >&2; exit 1; }
  # DATABASE_URL and S3_* come from .env, so the same file drives local and production
  (set -a; . "$root/.env"; set +a; cd "$root/packages/core" && node src/migrate.ts)
  cp "$here/AGENTS.md" "$data_dir/AGENTS.md"
  # downloads (yt-dlp, gallery-dl) and thumbnails (ffmpeg) run on this host, so provisioning installs them; no-op when present
  "$root/tools/bootstrap.sh"
  # bb refuses server imports outside the plugin folder, so the plugin builds against a generated copy of the core
  mkdir -p "$plugin_dir/core"
  rsync -a --delete --exclude='*.test.ts' --exclude='migrate.ts' --exclude='contract.ts' --exclude='testing.ts' "$root/packages/core/src/" "$plugin_dir/core/"
  (cd "$plugin_dir" && bb plugin build >/dev/null)
  first_install=0
  if bb plugin list | grep -q '^bb-plugin-brandwise@\|^brandwise@'; then
    bb plugin reload brandwise >/dev/null
  else
    first_install=1
    # --yes: plugins are full-trust code; this is our own plugin from this repo, installed from a local path
    bb plugin install "$plugin_dir" --yes
  fi
  (set -a; . "$root/.env"; set +a
   cfg() { bb plugin config brandwise set "$1" "$2" >/dev/null; }
   cfg databaseUrl "$DATABASE_URL"
   cfg s3Endpoint "${S3_ENDPOINT:-}"
   cfg s3Region "${S3_REGION:-us-east-1}"
   cfg s3Bucket "$S3_BUCKET"
   cfg s3AccessKeyId "$S3_ACCESS_KEY_ID"
   cfg s3SecretAccessKey "$S3_SECRET_ACCESS_KEY"
   cfg s3ForcePathStyle "${S3_FORCE_PATH_STYLE:-true}"
   # optional channels: a connector is on once its credentials are set
   if [ -n "${RESEND_API_KEY:-}" ]; then cfg resendApiKey "$RESEND_API_KEY"; fi
   if [ -n "${RESEND_WEBHOOK_SECRET:-}" ]; then cfg resendWebhookSecret "$RESEND_WEBHOOK_SECRET"; fi
   if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then cfg telegramBotToken "$TELEGRAM_BOT_TOKEN"; fi
   # optional video engine (agent-written Remotion templates); empty until its npm deps are installed
   if [ -f "$root/packages/video-remotion/node_modules/.package-lock.json" ]; then cfg videoEnginePath "$root/packages/video-remotion"; fi
   if [ -d "$root/packages/email-engine/node_modules/mjml" ]; then cfg emailEnginePath "$root/packages/email-engine"; fi
   # the mode is a user choice in Settings: profile.env only seeds it, unless BW_MODE_ENFORCE=1
   if [ "$first_install" = 1 ] || [ "${BW_MODE_ENFORCE:-0}" = 1 ]; then cfg mode "${BW_MODE:-full}"; fi)
  bb plugin reload brandwise >/dev/null
  # the campaign badge under thread titles is a row-metadata item; bb draws it only with this experiment on (and Organize > Rows > Metadata)
  bb settings experiment threadRowMetadata true >/dev/null
  if [ "$(bb brandwise campaign list --json | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" = 0 ]; then
    bb brandwise campaign add "$BW_DEFAULT_CAMPAIGN" --kind always_on
  fi
  ensure_scheduler
  tailnet_publish
  echo "applied"; status
}

# BrandWise runs on bb automations (scripts) that call one `bb brandwise` command each and print nothing when there is nothing to do,
# which bb records as a skipped tick. Idempotent: created once, the script is refreshed on every apply.
# bb injects two wrong values into automation scripts, so each script fixes them: BB_SERVER_URL is the default server (the personal bb
# on 38886), and BB_CLI is the launcher in <data dir>/bin, which re-execs BB_CLI forever (a fork storm). BB_CLI_DIR holds the real bb.
automation_script() {
  printf '%s\n%s' 'export BB_SERVER_URL="http://127.0.0.1:${BB_SERVER_PORT}" BB_CLI="${BB_CLI_DIR}/bb"' "\"\$BB_CLI\" brandwise $1"
}
ensure_automation() { # <name> <cron> <brandwise command> <timeout>
  local name="$1" cron="$2" script project id
  script=$(automation_script "$3")
  project=$(bb project list --json | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')
  id=$(bb automation list --project "$project" --json | python3 -c 'import json,sys;print(next((a["id"] for a in json.load(sys.stdin) if a["name"]=="'"$name"'"),""))')
  if [ -z "$id" ]; then
    bb automation create --project "$project" --name "$name" --cron "$cron" --timezone UTC \
      --script "$script" --interpreter bash --timeout "$4" >/dev/null
  else
    bb automation update "$id" --project "$project" --script "$script" --interpreter bash --timeout "$4" >/dev/null
    bb automation resume "$id" --project "$project" >/dev/null 2>&1 || true
  fi
}
# The scheduler publishes approved entries whose time has come (every minute).
# The editor's alarm clock starts the editor or the author only on campaigns with editor.autoRun, and only when code finds work.
# The miner looks for E2 patterns over matured entries once a week (docs/analytics.md).
ensure_scheduler() {
  ensure_automation "BrandWise scheduler" "* * * * *" "calendar run-due" 90s
  ensure_automation "BrandWise editor" "0 */6 * * *" "editor autorun" 120s
  ensure_automation "BrandWise learnings" "30 3 * * 1" "learnings mine" 300s
}

tailnet_host() { tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'; }

# Optional: publish the loopback listener to the tailnet (bb only binds 127.0.0.1 or 0.0.0.0; serve keeps it off the LAN).
tailnet_publish() {
  [ -n "${BW_TAILNET_HTTP_PORT:-}" ] || return 0
  command -v tailscale >/dev/null || { echo "tailnet: BW_TAILNET_HTTP_PORT is set but tailscale is not installed" >&2; return 1; }
  tailscale serve --bg --http="$BW_TAILNET_HTTP_PORT" "http://127.0.0.1:$BW_SERVER_PORT" >/dev/null
  echo "tailnet: http://$(tailnet_host):$BW_TAILNET_HTTP_PORT"
}
tailnet_unpublish() {
  [ -n "${BW_TAILNET_HTTP_PORT:-}" ] && command -v tailscale >/dev/null && tailscale serve --http="$BW_TAILNET_HTTP_PORT" off >/dev/null 2>&1 || true
}

status() {
  running && echo "instance: up ($BB_SERVER_URL, data dir $data_dir)" || { echo "instance: down"; return 0; }
  bb plugin list | grep -E '^(brandwise|bb-plugin-brandwise|bb-account)@' -A1 || true
}

case "${1:-}" in
  up) start; apply ;;
  apply) apply ;;
  status) status ;;
  down) tailnet_unpublish; bb-app stop --data-dir "$data_dir" ;;
  *) sed -n '2,7p' "$0" >&2; exit 2 ;;
esac
