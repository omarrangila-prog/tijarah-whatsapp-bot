#!/usr/bin/env bash
#
# Checks a deployment before it can do damage.
#
# Every test here corresponds to a mistake that actually happened while this was being built:
# the wrong Tijarah host (serves HTML, never PDFs), a document type left on a placeholder
# endpoint, a Gemini key with no credit, the transport left live while pointed at test data.
# None of them announce themselves — they surface later as a customer receiving something
# wrong, or nothing at all.
#
#   ./preflight.sh            check the .env beside it
#   ./preflight.sh /path/.env
set -uo pipefail

ENV_FILE="${1:-$(cd "$(dirname "$0")" && pwd)/.env}"
PASS=0
WARN=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

[ -f "$ENV_FILE" ] || { echo "No env file at $ENV_FILE"; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

echo
echo "Preflight — $ENV_FILE"
echo

echo "Configuration"
[ -n "${AGENT_API_KEY:-}" ] && ok "AGENT_API_KEY is set" || bad "AGENT_API_KEY is empty — the agent cannot invoke any tool"
[ "${ENGINE_TYPE:-}" = "baileys" ] && ok "engine is baileys (no Chromium needed)" \
  || warn "engine is '${ENGINE_TYPE:-unset}' — whatsapp-web.js needs a working Chromium in the container"
[ -n "${WHATSAPP_DEFAULT_COUNTRY_CODE:-}" ] && ok "country code ${WHATSAPP_DEFAULT_COUNTRY_CODE} for local numbers" \
  || warn "WHATSAPP_DEFAULT_COUNTRY_CODE unset — '03001234567' will default to 92"
[ -n "${WHATSAPP_BUSINESS_NAME:-}" ] && ok "messages signed '${WHATSAPP_BUSINESS_NAME}'" \
  || warn "WHATSAPP_BUSINESS_NAME unset — documents go out unsigned"

echo
echo "Reach"
BASE="${DOCUMENT_API_BASE_URL:-https://api.tijarabooks.com}"
case "$BASE" in
  *my.tijarahbooks.com*)
    bad "DOCUMENT_API_BASE_URL points at the dashboard host — it answers every document path with HTML, never a PDF" ;;
  *) ok "document API host is $BASE" ;;
esac

# A real fetch, because "the host resolves" is not the same as "it returns a PDF".
PROBE=$(curl -s -m 30 -o /tmp/preflight.pdf -w '%{http_code}' \
  "$BASE/internal/pdf/SL/1006/GR/2026/1?scode=0102003" 2>/dev/null || echo 000)
if [ "$PROBE" = "200" ] && head -c 5 /tmp/preflight.pdf 2>/dev/null | grep -q '%PDF-'; then
  ok "document API returns a real PDF ($(stat -c%s /tmp/preflight.pdf 2>/dev/null) bytes)"
else
  bad "document API did not return a PDF (HTTP $PROBE) — nothing will deliver"
fi
rm -f /tmp/preflight.pdf

if [ "${TIJARAH_QUEUE_ENABLED:-false}" = "true" ]; then
  Q=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "${TIJARAH_QUEUE_BASE_URL}/GetPendingBotInvoices" 2>/dev/null || echo 000)
  [ "$Q" = "200" ] && ok "host job queue reachable" || bad "host job queue returned HTTP $Q"

  # The client directory: how a number that is not in bot_users gets its company. Without it
  # every new client is "not registered" and has to be added by hand.
  C=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "${TIJARAH_QUEUE_BASE_URL}/GetBotTijarahClient?cont=0&email=0&bname=0" 2>/dev/null || echo 000)
  [ "$C" = "200" ] && ok "host client directory reachable" \
    || warn "GetBotTijarahClient returned HTTP $C — new numbers must be registered by hand until it is up"
fi

# A pepper that the app generates for itself is one a later deploy can regenerate — and then
# every existing API key returns "Invalid API key" while still looking right in data/.api-key.
# Caught here because the symptom points at the key, not at the pepper.
if [ -z "${API_KEY_PEPPER:-}" ]; then
  warn "API_KEY_PEPPER is unset — set it (openssl rand -hex 32) before first boot, or a future deploy can invalidate every API key"
else
  ok "API_KEY_PEPPER is pinned"
fi

if [ -n "${DRAFT_SUBMIT_ENDPOINT:-}" ]; then
  # A structurally VALID request, because an invalid one is rejected by validation before it
  # ever reaches the database — and "does the database table exist" is the thing worth
  # knowing. Labelled so whoever sees it on the approval screen knows to reject it, and it is
  # an approval request rather than an entry, so rejecting it is the whole cost.
  PROBE_SID="${TIJARAH_SID:-1006}"
  PROBE_GRP="${TIJARAH_GRP:-GR}"
  PROBE_YEAR="${TIJARAH_AYEAR:-$(date +%Y)}"
  D=$(curl -s -m 30 -o /tmp/preflight.json -w '%{http_code}' -H 'Content-Type: application/json' -X POST \
    -d "{\"whatsAppNo\":\"0\",\"sid\":${PROBE_SID},\"grp\":\"${PROBE_GRP}\",\"aYear\":\"${PROBE_YEAR}\",\"requestType\":\"ITEM\",\"currentStep\":\"ITEM_DETAILS\",\"requestStatus\":\"PENDING\",\"requestData\":{\"type\":\"ITEM\",\"name\":\"PREFLIGHT CHECK - please reject\",\"code\":\"NEW\",\"uom\":\"PCS\",\"rate\":0}}" \
    "$DRAFT_SUBMIT_ENDPOINT" 2>/dev/null || echo 000)
  # The host's own message, rather than a guess from the status code: a 400 here has meant
  # both "your payload is wrong" and "our database table does not exist", and those go to
  # different people.
  DETAIL=$(sed -e 's/.*"error" *: *"\([^"]*\)".*/\1/' -e 's/.*"message" *: *"\([^"]*\)".*/\1/' \
    /tmp/preflight.json 2>/dev/null | head -c 160)
  if grep -qi "Invalid object name" /tmp/preflight.json 2>/dev/null; then
    bad "approval endpoint is up but its database table is missing — ask Tijarah to create it"
  elif [ "$D" = "200" ] || [ "$D" = "201" ]; then
    ok "approval endpoint accepted a request — reject the 'PREFLIGHT CHECK' row it created"
  else
    warn "approval endpoint returned HTTP $D${DETAIL:+ — $DETAIL}"
  fi
  rm -f /tmp/preflight.json

  # The other half of the loop. A submit endpoint that works while this one 404s means
  # documents get approved and nobody is ever sent them — silent, and only noticed by the
  # person still waiting for their invoice.
  if [ "${APPROVAL_POLL_ENABLED:-false}" = "true" ]; then
    BASE="${DRAFT_SUBMIT_ENDPOINT%/UpsertRequest}"
    A=$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
      "${BASE}/GetActiveRequest?sid=${PROBE_SID}&grp=${PROBE_GRP}&aYear=${PROBE_YEAR}" 2>/dev/null || echo 000)
    [ "$A" = "200" ] && ok "approval follow-up endpoint reachable" \
      || bad "GetActiveRequest returned HTTP $A — approved documents would never be delivered"
  fi
else
  warn "DRAFT_SUBMIT_ENDPOINT unset — documents composed in chat are recorded locally, not submitted"
fi

# The OpenAI-compatible reasoner, which answers ahead of Gemini when configured.
#
# Checked for all three settings together, because the provider stays silently dormant unless
# every one is set: a deployment with only AI_API_KEY filled in looked configured, answered
# every client from the rule-based fallback, and the only tell was that a typo stopped working.
if [ -n "${AI_BASE_URL:-}${AI_API_KEY:-}${AI_MODEL:-}" ]; then
  if [ -z "${AI_BASE_URL:-}" ] || [ -z "${AI_API_KEY:-}" ] || [ -z "${AI_MODEL:-}" ]; then
    bad "AI_BASE_URL, AI_API_KEY and AI_MODEL must ALL be set — with any missing, the bot silently uses fixed phrasings only"
  else
    AIC=$(curl -s -m 45 -o /tmp/preflight.ai -w '%{http_code}' -X POST \
      -H "Authorization: Bearer ${AI_API_KEY}" -H 'Content-Type: application/json' \
      -d "{\"model\":\"${AI_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":8}" \
      "${AI_BASE_URL%/}/chat/completions" 2>/dev/null || echo 000)
    case "$AIC" in
      200) ok "reasoning host answers on model '${AI_MODEL}'" ;;
      401|403) bad "the reasoning host rejected AI_API_KEY (HTTP $AIC)" ;;
      404) bad "model '${AI_MODEL}' is not served by ${AI_BASE_URL} — GET ${AI_BASE_URL%/}/models lists what is" ;;
      429) bad "the reasoning host has no credit left — replies would fall back to fixed phrasings" ;;
      *)   warn "reasoning host returned HTTP $AIC" ;;
    esac
    rm -f /tmp/preflight.ai
  fi
elif [ -z "${GEMINI_API_KEY:-}" ]; then
  warn "no reasoner configured — clients get the numbered menu and fixed phrasings only"
fi

if [ -n "${GEMINI_API_KEY:-}" ]; then
  G=$(curl -s -m 30 -o /tmp/preflight.g -w '%{http_code}' -X POST \
    -H "x-goog-api-key: ${GEMINI_API_KEY}" -H 'Content-Type: application/json' \
    -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}' \
    "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL:-gemini-3.6-flash}:generateContent" 2>/dev/null || echo 000)
  case "$G" in
    200) ok "Gemini key works on ${GEMINI_MODEL:-gemini-3.6-flash}" ;;
    429) bad "Gemini key has no credit left — free-form sentences will fall back to fixed phrasings" ;;
    404) bad "model '${GEMINI_MODEL:-gemini-3.6-flash}' is retired — Google's response names the replacement" ;;
    *)   warn "Gemini returned HTTP $G" ;;
  esac
  rm -f /tmp/preflight.g
else
  warn "GEMINI_API_KEY unset — only fixed phrasings will be understood"
fi

echo
echo "Blast radius"
if [ "${WHATSAPP_JOBS_MOCK:-true}" = "false" ]; then
  warn "TRANSPORT IS LIVE — every job sends a real WhatsApp message"
  [ "${TIJARAH_QUEUE_ENABLED:-false}" = "true" ] &&
    warn "  …and the host queue is being polled: whatever is queued there WILL be delivered"
else
  ok "transport is mock — messages are recorded, nothing is transmitted"
fi
[ "${MOCK_DOCUMENT_API:-false}" = "true" ] && bad "MOCK_DOCUMENT_API is on in production" || ok "demo document API is off"
[ "${WHATSAPP_JOBS_WORKER:-false}" = "true" ] && ok "worker is on" || warn "worker is off — jobs will queue and never send"

echo
printf '  %s passed, %s warnings, %s failures\n\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "  Fix the failures before going live."; exit 1; }
