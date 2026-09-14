#!/usr/bin/env bash
#
# Boots the WhatsApp receivables agent for a demonstration.
#
# Everything runs against a throwaway database in this directory. No WhatsApp session is
# started, so there is no QR code and no connection to any account, and the agent's transport
# is the in-memory mock — a "sent" message is recorded with a `mock.` id and goes nowhere.
#
#   ./start.sh          boot (first run also seeds the demo people)
#   ./start.sh --reset  throw the database away and start from nothing
#
# Then: ./demo.sh
set -euo pipefail

DEMO_HOME="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DEMO_HOME/../.." && pwd)"
export DEMO_HOME
PORT_FROM_ENV="$(grep -E '^PORT=' "$DEMO_HOME/boot.env" | cut -d= -f2)"
BASE="http://127.0.0.1:${PORT_FROM_ENV}"

if [ "${1:-}" = "--reset" ]; then
  rm -rf "$DEMO_HOME/data"
  echo "demo database removed"
fi
mkdir -p "$DEMO_HOME/data"

stop_server() {
  # `pgrep -x node` matches only processes named exactly "node", so this can never match the
  # shell running this script. `pkill -f dist/main.js` can, and does: that pattern matches the
  # wrapper shell's own command line, which then kills itself half way through the restart.
  #
  # The cwd check keeps it to this checkout, so running the demo does not stop a copy of the
  # server someone else on the machine is running from another directory.
  for pid in $(pgrep -x node 2>/dev/null || true); do
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'dist/main\.js' || continue
    [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$REPO" ] || continue
    kill -9 "$pid" 2>/dev/null || true
  done
  # Give the port back before the next bind, or the second boot dies with EADDRINUSE.
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null "$BASE/api/health" 2>/dev/null || return 0
    sleep 0.5
  done
}

wait_for_health() {
  for _ in $(seq 1 90); do
    curl -sf -o /dev/null "$BASE/api/health" 2>/dev/null && return 0
    sleep 1
  done
  echo "server did not come up — see $DEMO_HOME/server.log" >&2
  return 1
}

boot() {
  set -a
  # shellcheck disable=SC1091
  . "$DEMO_HOME/boot.env"
  # Local overrides, if present. Credentials live here rather than in boot.env, because
  # boot.env is committed and data/ is not — an API key in a tracked file is one `git push`
  # from being public.
  if [ -f "$DEMO_HOME/data/.env.local" ]; then
    # shellcheck disable=SC1091
    . "$DEMO_HOME/data/.env.local"
  fi
  set +a
  # The key the agent acts as when it invokes a tool. Read from the bootstrap file the server
  # writes on first boot rather than committed here, so this directory holds no credential.
  if [ -f "$DEMO_HOME/data/.api-key" ]; then
    AGENT_API_KEY="$(tr -d '\n' < "$DEMO_HOME/data/.api-key")"
    export AGENT_API_KEY
  fi
  # Every descriptor is replaced before the server starts, stdout included.
  #
  # Inheriting this script's stdout keeps it open for as long as the server runs, so
  # `./start.sh | tee log` — or any pipe at all — hangs forever waiting for an EOF that only
  # arrives when the server stops. `disown` and the /dev/null stderr keep job control quiet
  # too: without them the shell prints "Killed  setsid nohup node dist/main.js" when the
  # first-boot process is stopped, which reads like a crash mid-start.
  ( cd "$REPO" && setsid nohup node dist/main.js > "$DEMO_HOME/server.log" 2>&1 < /dev/null & disown ) >/dev/null 2>&1
  wait_for_health
}

[ -f "$REPO/dist/main.js" ] || { echo "build first: (cd $REPO && npx nest build)" >&2; exit 1; }

# Publish the console into the dashboard's asset directory.
#
# `/assets/` is the one prefix the SPA document handler in configure-app.ts does not
# intercept, so a real file there is served as itself rather than as the dashboard's
# index.html. It is copied on every boot because dashboard/dist is a build output and a
# dashboard rebuild wipes it; the source of truth is this directory.
#
# The script lives in its own file rather than inline because the CSP is
# `scriptSrc: ['self', nonce]` — an inline <script> in a static page has no nonce and is blocked.
ASSETS="$REPO/dashboard/dist/assets"
if [ -d "$ASSETS" ]; then
  cp "$DEMO_HOME/console.html" "$ASSETS/agent-demo.html"
  cp "$DEMO_HOME/console.js" "$ASSETS/agent-demo.js"
  CONSOLE_URL="$BASE/assets/agent-demo.html"
else
  CONSOLE_URL=""
  echo "note: no dashboard build at $ASSETS — console not published (API still works)" >&2
fi

stop_server

FIRST_RUN=0
[ -f "$DEMO_HOME/data/agent.sqlite" ] || FIRST_RUN=1

# First boot creates the schema and writes the bootstrap API key; the agent needs that key in
# its environment, so a fresh install boots twice. Subsequent runs boot once.
boot
if [ "$FIRST_RUN" = "1" ]; then
  echo "first run: creating schema and seeding"
  python3 "$DEMO_HOME/seed.py"
  stop_server
  boot
fi

echo
echo "Agent is up at $BASE"
if [ -n "$CONSOLE_URL" ]; then
  echo "  console:   $CONSOLE_URL"
  echo "  api key:   $(tr -d '\n' < "$DEMO_HOME/data/.api-key")"
  echo "             (the console asks for this once and keeps it in the browser)"
fi
echo "  demo.sh:   $DEMO_HOME/demo.sh"
echo "  approvals: $BASE/api/agent/approvals"
echo "  status:    $BASE/api/agent/status"
echo "  log:       $DEMO_HOME/server.log"
