#!/usr/bin/env bash
#
# Boots Rangila — the real WhatsApp team inbox — on port 3000.
#
# Separate from scripts/agent-demo, which is a throwaway demonstration instance on 3111. This
# one uses the real database and reconnects the live WhatsApp number, so it is never tunnelled
# or shared: it holds real customer conversations.
#
#   ./start.sh     boot
#   ./start.sh --stop
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PORT_FROM_ENV="$(grep -E '^PORT=' "$HERE/boot.env" | cut -d= -f2)"
BASE="http://127.0.0.1:${PORT_FROM_ENV}"

# Only ever stops the process serving THIS port, so it cannot take down the demo instance
# sharing the same dist/main.js. `pkill -f dist/main.js` would kill both — and the wrapper
# shell running this script as well, since that pattern matches its own command line.
stop_server() {
  for pid in $(pgrep -x node 2>/dev/null || true); do
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'dist/main\.js' || continue
    [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$REPO" ] || continue
    grep -qz "PORT=${PORT_FROM_ENV}" "/proc/$pid/environ" 2>/dev/null || continue
    kill -9 "$pid" 2>/dev/null || true
  done
}

if [ "${1:-}" = "--stop" ]; then stop_server; echo "Rangila stopped"; exit 0; fi

[ -f "$REPO/dist/main.js" ] || { echo "build first: (cd $REPO && npx nest build)" >&2; exit 1; }
[ -f "$REPO/data/openwa.sqlite" ] || { echo "no real database at $REPO/data/openwa.sqlite" >&2; exit 1; }

stop_server
set -a
# shellcheck disable=SC1091
. "$HERE/boot.env"
set +a
# Every descriptor replaced, or piping this script's output hangs until the server stops.
( cd "$REPO" && setsid nohup node dist/main.js > "$HERE/server.log" 2>&1 < /dev/null & disown ) >/dev/null 2>&1

for _ in $(seq 1 90); do
  curl -sf -o /dev/null "$BASE/api/health" 2>/dev/null && break
  sleep 1
done
curl -sf -o /dev/null "$BASE/api/health" 2>/dev/null || { echo "did not come up — see $HERE/server.log" >&2; exit 1; }

echo
echo "Rangila is up at $BASE"
echo "  inbox:  $BASE"
echo "  log:    $HERE/server.log"
echo "  stop:   $HERE/start.sh --stop"
echo
echo "Real customer data. Do not tunnel this instance."
