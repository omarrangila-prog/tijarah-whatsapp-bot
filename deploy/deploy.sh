#!/usr/bin/env bash
#
# Deploys the Tijarah WhatsApp bot on a Linux server, and upgrades it in place.
#
#   ./deploy.sh                    build, preflight, start
#   ./deploy.sh --no-check         skip preflight (not advised)
#   ./deploy.sh --auto-update      also install a timer that deploys every new version on its own
#   ./deploy.sh --no-auto-update   remove that timer (and deploy as usual)
#   ./deploy.sh --logs             follow the log
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

CHECK=1
AUTO_UPDATE=""
for arg in "$@"; do
  case "$arg" in
    --no-check) CHECK=0 ;;
    --auto-update) AUTO_UPDATE=install ;;
    --no-auto-update) AUTO_UPDATE=remove ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

UNIT=tijarah-bot-update

# A systemd timer that runs auto-update.sh every five minutes. It touches nothing else on the
# host: two unit files under /etc/systemd/system, removed again by --no-auto-update.
install_auto_update() {
  if [ "$(id -u)" != "0" ]; then
    echo "  updates   : NOT automatic — run with sudo to install the update timer"
    return
  fi
  if ! command -v systemctl >/dev/null; then
    echo "  updates   : no systemd here. For automatic updates, add to root's crontab:"
    echo "              */5 * * * * $HERE/auto-update.sh >> /var/log/$UNIT.log 2>&1"
    return
  fi
  cat > "/etc/systemd/system/$UNIT.service" <<UNIT_EOF
[Unit]
Description=Deploy the newest Tijarah WhatsApp bot from GitHub, when there is one
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$HERE/auto-update.sh
TimeoutStartSec=30min
UNIT_EOF
  cat > "/etc/systemd/system/$UNIT.timer" <<UNIT_EOF
[Unit]
Description=Check for a newer Tijarah WhatsApp bot every five minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT_EOF
  systemctl daemon-reload
  systemctl enable --now "$UNIT.timer" >/dev/null
  echo "  updates   : automatic — checked every 5 minutes (journalctl -u $UNIT shows each one)"
}

remove_auto_update() {
  if command -v systemctl >/dev/null && [ -f "/etc/systemd/system/$UNIT.timer" ]; then
    systemctl disable --now "$UNIT.timer" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$UNIT.timer" "/etc/systemd/system/$UNIT.service"
    systemctl daemon-reload
  fi
  echo "  updates   : manual (the update timer is removed)"
}

# Called once the bot answers its health check: records what is running, so auto-update.sh can
# tell a new version from the one already deployed.
finish() {
  git -C "$REPO" -c "safe.directory=$REPO" rev-parse HEAD > "$HERE/.deployed" 2>/dev/null || rm -f "$HERE/.deployed"
  case "$AUTO_UPDATE" in
    install) install_auto_update ;;
    remove) remove_auto_update ;;
  esac
}

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

if [ "$CHECK" = "1" ]; then
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
    finish
    exit 0
  fi
  printf '.'
  sleep 2
done

echo
echo "It did not become healthy. Recent log:"
"${COMPOSE[@]}" logs --tail 40 openwa-api
exit 1
