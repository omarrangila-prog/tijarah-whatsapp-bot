# Deploying the Tijarah WhatsApp bot

A Linux server with Docker and the compose plugin. Nothing else — the database is a file, the
WhatsApp engine is pure Node, and the only outbound dependencies are Tijarah's API and Gemini.

```bash
git clone <this repo> && cd wa-command-center/deploy
./deploy.sh                      # writes .env from the template, then stops
$EDITOR .env                     # fill it in
./deploy.sh                      # preflight, build, start
```

`deploy.sh --logs` follows the log, `--stop` brings it down. Re-running it upgrades in place.

## Getting it onto the server

The repository is `github.com/omarrangila-prog/tijarah-whatsapp-bot` (private). On the server:

```bash
git clone https://github.com/omarrangila-prog/tijarah-whatsapp-bot.git
cd tijarah-whatsapp-bot/deploy
./deploy.sh          # creates .env from the template and stops — fill it in
./deploy.sh          # preflight, build, start
```

To hand the client a copy without git, `git archive` from the repository root produces a
clean tarball with nothing ignored in it — no keys, no databases, no logs:

```bash
git archive --format=zip --prefix=tijarah-whatsapp-bot/ -o tijarah-whatsapp-bot.zip main
```

## Before you go live

`preflight.sh` runs automatically and refuses a deployment that would fail silently. Every
check in it corresponds to something that actually went wrong while this was built:

| It checks                                  | Because                                                                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the document host returns a real PDF       | `my.tijarahbooks.com` answers every document path with HTML and a 406 — it looks configured and delivers nothing                                                                        |
| the host job queue answers                 | a queue that 404s means jobs never arrive and nobody notices                                                                                                                            |
| the approval endpoint reaches its database | it returned _"Invalid object name 'WhatsAppBotRequest'"_ — up, but with no table behind it. The table now exists; the check stays, because a restored or rebuilt host can lose it again |
| the Gemini key has credit                  | an exhausted key means free-form sentences stop being understood                                                                                                                        |
| the transport and worker states            | so nobody discovers the bot is live by watching a customer receive something                                                                                                            |

It sends one clearly-labelled `PREFLIGHT CHECK` request to the approval endpoint. That is an
approval request, not an entry — reject it on the approval screen.

## The four settings that decide blast radius

|                         |                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_JOBS_MOCK`    | `false` transmits real messages to real numbers. Leave `true` until a test number is paired and you have watched one delivery.                       |
| `WHATSAPP_JOBS_WORKER`  | `true` starts claiming and sending.                                                                                                                  |
| `TIJARAH_QUEUE_ENABLED` | `true` polls Tijarah's queue — whatever is in it **will** be delivered.                                                                              |
| `DRAFT_SUBMIT_ENDPOINT` | must be the endpoint that creates a record on the **approval screen**. Unset, drafts are recorded locally and nothing leaves.                        |
| `AGENT_WHATSAPP_MOCK`   | `false` makes the bot **answer people who message it**. Separate from document delivery: with it `true`, replies are recorded and never transmitted. |

`requestStatus: "PENDING"` is hard-coded, not configurable. It is the single field that keeps a
WhatsApp message from becoming an accounting entry, and it is not going in an env var.

## The Phase 3 round trip

```
person composes in chat  →  UpsertRequest        →  PENDING on the approval screen
                                                       ↓  a person there accepts it
document arrives on their WhatsApp  ←  /internal/pdf/…  ←  GetActiveRequest
```

`APPROVAL_POLL_ENABLED=true` runs the right-hand half. Every draft still waiting is checked
against `GetActiveRequest` for the composer's own number and company; an accepted one has its
finished document fetched and sent back to whoever composed it, a rejected one is recorded.

Three things it will not do:

- **Act on a row that is not the one it asked about.** `whatsAppNo=0` came back holding a
  different number's request, so the answer is checked against the number and company that were
  asked for. An unverified row would send one person the document another person composed.
- **Guess a document number.** Approved with no number in the answer is logged in full and
  nothing is sent — fetching `…/{year}/undefined` returns _something_, and it would go out as
  somebody's invoice.
- **Approve anything.** The decision is a human's, inside Tijarah Books.

An approved customer, vendor, expense, chart or item account has no PDF to send, so it is
recorded and the person is not sent a file.

## Who the bot will serve

With `BOT_REQUIRE_REGISTRATION=true`, the bot answers only numbers listed in `bot_users` —
each mapped to the company (`sid`/`grp`) whose books that person may see. Anyone else is told
how to get registered and nothing more. Register a number:

```
curl -X PUT https://your-host/api/bot-users \
  -H "X-API-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"whatsAppNo":"03009988776","sid":1006,"grp":"GR","aYear":"2026","displayName":"Bilal Fabrics"}'
```

`GET /api/bot-users` lists them; `DELETE /api/bot-users/<number>` stops serving one. Removal
deactivates rather than deletes, because "why did this person receive that ledger" has to stay
answerable after the mapping is gone.

The `sid`/`grp` pair is the fence between one client's books and another's. There is no default
company anywhere in the code: an unregistered number is refused rather than served from a
fallback, which is the only way a wrong mapping fails loudly instead of quietly.

## Pairing WhatsApp

1. Start with `WHATSAPP_JOBS_MOCK=true` and confirm documents are being fetched and recorded.
2. Open the dashboard → **Document Delivery**, press **Connect**, scan with a **separate test
   number** — not the main business line.
3. Press **Send test document**. It addresses the connected number itself, so nothing reaches
   a customer.
4. Only then set `WHATSAPP_JOBS_MOCK=false` and redeploy.

The QR refreshes itself on that screen; WhatsApp rotates codes every ~20 seconds and a stale
one fails silently when scanned.

## What survives a restart

Everything under `data/` in the container, mounted as a volume: the SQLite database, the
bootstrap API key, and the Baileys session credentials. **Back that directory up** — losing it
means re-scanning the QR and losing the job history.

```bash
docker compose exec openwa-api tar czf - /app/data > backup-$(date +%F).tgz
```

## Monitoring

Set `METRICS_TOKEN` and scrape `GET /api/metrics` with it as a bearer token:

```
openwa_document_jobs_sent_total
openwa_document_jobs_failed_total{code="DOCUMENT_API_TIMEOUT"}
openwa_document_jobs_retried_total
openwa_document_api_duration_ms
```

Retried is separate from failed on purpose: one means the system is coping, the other means it
gave up. Queue depth is deliberately not a metric — it is a `SELECT`, answered by
`GET /api/whatsapp-document-jobs/connection`.

## If something is wrong

| Symptom                                                 | Look at                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| jobs stay PENDING                                       | `WHATSAPP_JOBS_WORKER` is false, or the worker cannot reach WhatsApp                                                           |
| jobs go to RETRY_SCHEDULED with `WHATSAPP_DISCONNECTED` | the session dropped; reconnect on the Document Delivery screen. Attempts are **not** consumed while parked, so nothing is lost |
| `INVALID_DOCUMENT_RESPONSE: returned an HTML page`      | the document host is wrong — check `DOCUMENT_API_BASE_URL`                                                                     |
| free-form sentences misunderstood                       | no Gemini credit; the rule-based reasoner handles fixed phrasings only                                                         |
| a document type will not send                           | its endpoint may still be the `TODO://` sentinel — the service refuses those even when enabled                                 |

## Not automated

Building the image on this machine was not possible (no Docker in the development sandbox), so
the first `./deploy.sh` on your server is the first time the image is built. If it fails, the
Dockerfile is unchanged from the upstream project and the error will be from the base image or
the network rather than from anything in this work.
