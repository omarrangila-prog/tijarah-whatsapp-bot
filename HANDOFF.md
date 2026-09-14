# Tijarah Books WhatsApp bot — handoff

A WhatsApp bot for **Tijarah Books** (accounting software). It delivers documents the
software queues, answers report requests in chat, and lets a client compose a document in
chat that lands on Tijarah's **approval screen** — never as an accounting entry.

Built on the existing NestJS + React project in this repository. Everything Tijarah-specific
is additive: no existing route changed behaviour.

---

## 1. What works today

| Phase                      | What it does                                                                  | State                                                                |
| -------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **1 — Send to WhatsApp**   | Tijarah queues a job → bot fetches the PDF → delivers it → marks it processed | **Working against the live API.** 34 documents delivered in testing. |
| **2 — Chat with bot**      | Client asks in their own WhatsApp for a ledger or report → receives the PDF   | **Working.** 14 report types, party-filtered.                        |
| **3 — Create on WhatsApp** | Client composes a document in chat → PENDING row on Tijarah's approval screen | **Working for 4 of 12 types** — see §5.                              |

The three phases share one WhatsApp connection, one permission layer and one audit trail.

---

## 2. Run it

### Locally (no Docker)

```bash
npm ci
./scripts/agent-demo/start.sh      # builds, migrates, seeds, serves on :3112
```

Settings live in `scripts/agent-demo/boot.env`. The dashboard is at
`http://127.0.0.1:3112`, and the API key is written to
`scripts/agent-demo/data/.api-key`.

Drive a conversation without touching WhatsApp:

```bash
curl -X POST http://127.0.0.1:3112/api/agent/simulate \
  -H "X-API-Key: $(cat scripts/agent-demo/data/.api-key)" -H 'Content-Type: application/json' \
  -d '{"from":"+923347037531","text":"send me the customer ledger for C-1005"}'
```

`simulate` runs the real runtime — the same permission layer, the same tools. Only the
arrival is simulated. Add `"type":"ptt"` or `"image"` to rehearse a voice note or a photo.

### On the server (Docker)

```bash
cd deploy
./deploy.sh          # first run copies .env.production.example → .env and stops
# fill in .env, then:
./deploy.sh          # preflight, build, start, wait for health
./deploy.sh --logs
```

`deploy.sh` runs `preflight.sh` first and refuses a deployment that would fail silently.
Every check in it corresponds to something that actually went wrong during the build.

> **The image has never been built.** The development machine has no Docker daemon access
> (`permission denied on /var/run/docker.sock`, and `sudo` needs a password). `Dockerfile`
> and `docker-compose.yml` are the project's own, unmodified except for the added
> environment forwards, so a failure will come from the base image or the network rather
> than from this work — but the first `./deploy.sh` is genuinely the first build.
> Only the `openwa-api` service is needed; postgres/redis/minio sit behind compose
> profiles and `depends_on … required: false`, so they do not start.

---

## 3. The settings that decide blast radius

In `deploy/.env.production.example`, marked with ⚠.

| Setting                    | Effect                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| `WHATSAPP_JOBS_MOCK`       | `false` transmits real documents to real numbers                             |
| `WHATSAPP_JOBS_WORKER`     | `true` starts claiming and sending                                           |
| `TIJARAH_QUEUE_ENABLED`    | `true` polls Tijarah's queue — whatever is in it **will** be delivered       |
| `AGENT_WHATSAPP_MOCK`      | `false` makes the bot **answer people who message it**, as the paired number |
| `DRAFT_SUBMIT_ENDPOINT`    | must be the **approval screen** endpoint; unset, drafts are recorded locally |
| `APPROVAL_POLL_ENABLED`    | `true` follows an approval back and delivers the finished document           |
| `BOT_REQUIRE_REGISTRATION` | `true` serves only numbers in `bot_users`                                    |

`requestStatus: "PENDING"` is hard-coded in `buildEnvelope()`, not configurable. It is the
single field that keeps a WhatsApp message from becoming an accounting entry, and it is
deliberately not one environment variable away from being switched off.

---

## 4. How it is wired

```
Tijarah queue ──► TijarahQueueService ──► whatsapp_document_jobs ──► JobWorkerService ──► WhatsApp
                                                                          │
person's message ──► WhatsAppGateway ──► AgentRuntime ──► ToolRegistry ────┘
                                              │
                                              ├─ report tools  ──► /report/pdf/…  (Phase 2)
                                              └─ draft tools   ──► UpsertRequest  (Phase 3)
                                                                       │
                                          GetActiveRequest ◄───────────┘  approval, read back
```

### Files worth reading first

| File                                                           | Why                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/modules/agent/agent-runtime.service.ts`                   | One turn, start to finish. The numbered steps are the whole policy.   |
| `src/integrations/whatsapp/permission-guard.ts`                | Six layers, in order. The customer fence is an allowlist on purpose.  |
| `src/modules/whatsapp-jobs/tenancy/bot-user.service.ts`        | Which company a phone number may see. There is no default.            |
| `src/modules/whatsapp-jobs/drafts/tijarah-request.ts`          | The 12 request types and the envelope. `requestStatus` is fixed here. |
| `src/modules/whatsapp-jobs/drafts/approval-outcome.service.ts` | Reads a decision back and delivers the document.                      |
| `src/modules/whatsapp-jobs/caption.ts`                         | What a customer actually reads above the PDF.                         |

### Tenancy — read this before changing anything

Every report and every draft is scoped to a `sid`/`grp` pair resolved from the sender's
phone number. **There is no fallback company anywhere in the code.** An unregistered number
is refused rather than served from a default — an earlier version had a default and two
clients both received company 1006's books.

Resolution order (`BotUserService.lookup`):

1. `bot_users` — an administrator's explicit mapping, and the cache of every directory answer
2. `GetBotTijarahClient?cont=<phone>` — Tijarah's client directory, asked in the local form
   (`03001234567`) then the international form. One row → remembered and served. Several →
   the person is asked _which business_ and answers by name or position (two turns, no stored
   state; the list is fetched again on the reply). None → refused.

The directory carries no accounting year, so `aYear` defaults to the current calendar year.
A cached row is not re-checked; `DELETE /api/bot-users/<number>` forces a fresh lookup.

Register a number (ADMIN key):

```bash
curl -X PUT http://host/api/bot-users -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"whatsAppNo":"03009988776","sid":1006,"grp":"GR","aYear":"2026","displayName":"Bilal Fabrics"}'
```

`GET /api/bot-users` lists, `DELETE /api/bot-users/<number>` deactivates (the row is kept —
"why did this person receive that ledger" has to stay answerable).

---

## 5. Open items — blocked on Tijarah

### 5.1 Only 4 of 12 creatable types are accepted

`UpsertRequest` answers anything else with:

> `RequestType must be 'SALE', 'PURCHASE', 'PARTY', or 'ITEM'.`

Live: **SALE, PURCHASE, PARTY, ITEM.** Not yet built on the host: DIGITAL, SALE RETURN,
PURCHASE RETURN, PAYMENT, RECEIVE, VENDOR, EXPENSE, ACCOUNT NAME.

The collection side for all twelve is finished. `HOST_REQUEST_TYPES` in
`tijarah-request.ts` is the single place to widen once the host accepts more — everything
else derives from it, including the refusal a person sees when they ask for one that is not
ready. **Do not hand-edit `pending` flags; they are computed.**

### 5.2 `GetActiveRequest` returns one row today; a list is coming

It reports only the most recent active request per company. Four requests were submitted in
testing (#2 SALE, #3 PARTY, #4 ITEM, #5 PURCHASE) and only #5 is visible, so the poller
cannot yet notice an approval for anything but the latest.

Tijarah is changing it to return **every request — approved, pending, failed — as a list.**
`ApprovalOutcomeService.readRequests()` already reads both shapes and finds the draft's own
row by the host's `id`, never by position, so the change needs no redeploy on this side.
`FAILED` is treated as a refusal.

### 5.3 `whatsAppNo` is not filtered

`GetActiveRequest?…&whatsAppNo=0` returned a request belonging to `923347037531`. Any
consumer polling with a number that has no active request may receive **someone else's**
request data.

`ApprovalOutcomeService.match()` checks the returned `whatsAppNo`, `sid` and `grp` against
what was asked for and ignores a mismatch, so this bot cannot act on it — but the endpoint
should be fixed at source.

### 5.4 `GetBotCustomers` has no name field

The payload carries `lcode`, `telNo`, `email` and no name, so "send me Ahmed's ledger"
cannot be resolved — a person must give an account code. `findByPhone` exists because the
phone number is the only identifier a human recognises in that payload. `findByName` does
not exist, deliberately.

### 5.5 The PDF endpoints have no authentication

`api.tijarabooks.com/internal/pdf/…` serves any company's documents to anyone who guesses
the path. This bot is not the exposure and cannot fix it. Tijarah should know.

### 5.6 `GetBotTijarahClient` is not deployed yet

Every path form returns 404 while `GetBotCustomers` on the same host answers 200. The lookup
is built against the shape Tijarah documented and tested over a real socket against a
stand-in; until the endpoint is live, a number not in `bot_users` is refused and preflight
warns. Nothing else changes when it goes live.

### 5.7 Gemini free-tier quota

The key runs out after a few dozen turns (`429 … exceeded your current quota`). The runtime
falls through to a rule-based provider and keeps working — the bot degrades from natural
language to step-by-step prompts rather than breaking. A paid key removes the ceiling.

---

## 6. Conventions to keep

- **Every guard is a test.** 6,384 passing. `npx jest` before anything.
- **Parity specs exist so lists cannot go stale**: `tijarah-spec.parity` (migrations by
  glob), `compose-parity` + `env-precedence` (every env key in compose has a
  `BLANK_SHADOWED_ENV_KEYS` entry), `export-tables.parity` (every new table has a backup
  decision), `migration-ordering` (no two migrations share a timestamp), `swagger.config`,
  `docs-readme-mcp`. Adding a table, an env var or a migration and skipping its spec will
  fail CI, which is the point.
- **CI gates on `npm run lint` and `npm run format:check`.** Both are clean.
- **Comments say why, not what.** Several in this work record a specific failure — the
  day-first date parser, the `NEW` placeholder, the `whatsAppNo=0` check. Those are the
  comments most worth keeping.
- **Nothing reaches a customer without passing the permission layer.** If you add a path
  that sends, route it through `AgentRuntime`, not around it.

---

## 7. Before the client uses it

- [ ] Pair a **separate test number**, not the business line, and watch one delivery
- [ ] Register the client's numbers in `bot_users` with their real `sid`/`grp`
- [ ] Set `BOT_REGISTRATION_CONTACT` to whoever adds new numbers
- [ ] Put a paid Gemini key in `GEMINI_API_KEY`
- [ ] Approve or reject the test rows on the approval screen (#1 `PREFLIGHT CHECK`, #2–#5)
- [ ] Set `AGENT_WHATSAPP_MOCK=false` only once the number is right
