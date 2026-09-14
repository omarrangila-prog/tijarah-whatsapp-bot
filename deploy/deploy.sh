#!/usr/bin/env bash
#
# Deploys the Tijarah WhatsApp bot on a Linux server, and upgrades it in place.
#
#   ./deploy.sh              build, preflight, start
#   ./deploy.sh --no-check   skip preflight (not advised)
#   ./deploy.sh --logs       follow the log
#   ./deploy.sh --stop
#
# Assumes Docker and the compose plugin. Run it from the repository root's deploy/ directory.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENV_FILE="$HERE/.env"
COMPOSE=(docker compose --project-directory "$REPO" --env-file "$ENV_FILE")

case "${1:-}" in
  --logs) exec "${COMPOSE[@]}" logs -f openwa-api ;;
  --stop) exec "${COMPOSE[@]}" down ;;
esac

command -v docker >/dev/null || { echo "Docker is not installed."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "The docker compose plugin is missing."; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
  cp "$HERE/.env.production.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE from the template. Fill it in, then run this again."
  echo "The four settings marked with a warning decide whether real documents reach real people."
  exit 1
fi
# The file holds an API key and possibly a Gemini key; it should never be world-readable.
chmod 600 "$ENV_FILE"

if [ "${1:-}" != "--no-check" ]; then
  echo "Preflight…"
  "$HERE/preflight.sh" "$ENV_FILE" || {
    echo
    echo "Preflight failed. Fix the failures, or re-run with --no-check if you understand why."
    exit 1
  }
fi

echo "Building…"
"${COMPOSE[@]}" build openwa-api

echo "Starting…"
"${COMPOSE[@]}" up -d openwa-api

# The health endpoint is the only honest signal that it came up: the container can be running
# while the app is still failing its migrations.
PORT_VALUE="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
BASE="http://127.0.0.1:${PORT_VALUE:-2785}"
printf 'Waiting for health'
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE/api/health" 2>/dev/null; then
    echo " — up."
    echo
    echo "  dashboard : $BASE"
    echo "  api key   : docker compose exec openwa-api cat /app/data/.api-key"
    echo "  logs      : $HERE/deploy.sh --logs"
    exit 0
  fi
  printf '.'
  sleep 2
done

echo
echo "It did not become healthy. Recent log:"
"${COMPOSE[@]}" logs --tail 40 openwa-api
exit 1
