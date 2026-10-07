#!/usr/bin/env bash
#
# Keeps the bot on the newest version: if the branch on GitHub has moved past what is deployed,
# pull it and redeploy. Installed as a systemd timer by `deploy.sh --auto-update`, which runs
# this every five minutes; safe to run by hand.
#
# Compared against deploy/.deployed — the commit the last HEALTHY deploy ran — rather than the
# checkout, so a deploy that failed is tried again on the next run instead of being skipped
# because the files were already pulled.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BRANCH="${AUTO_UPDATE_BRANCH:-main}"
GIT=(git -C "$REPO" -c "safe.directory=$REPO")

"${GIT[@]}" fetch --quiet origin "$BRANCH"
REMOTE="$("${GIT[@]}" rev-parse "origin/$BRANCH")"
DEPLOYED="$(cat "$HERE/.deployed" 2>/dev/null || true)"

if [ "$REMOTE" = "$DEPLOYED" ]; then
  exit 0
fi

echo "Updating ${DEPLOYED:0:7} → ${REMOTE:0:7}"
# Fast-forward only: a copy someone edited by hand on the server is reported, never overwritten.
"${GIT[@]}" merge --ff-only --quiet "origin/$BRANCH" || {
  echo "The server's copy has changes of its own, so it cannot fast-forward. Nothing was deployed."
  exit 1
}

# No preflight: each run files a PREFLIGHT CHECK request on Tijarah's approval screen, and an
# update every few minutes would fill it. The first install runs it.
exec "$HERE/deploy.sh" --no-check
