# WhatsApp document delivery — Phase 1

Command → job → worker → document API → document received → WhatsApp → status and KPI.

Nothing between those steps is skipped and nothing shortcuts them: the button, the agent and
the REST API all only ever write a row, and the worker is the single thing that talks to
WhatsApp. That is the design, not an implementation detail — it means there is exactly one
place in the system where a document can leave the building.

## Running it

```bash
npx nest build
./scripts/agent-demo/start.sh      # :3111, worker on, mock transport, demo document API
```

Then open **Document Delivery** in the dashboard, or drive it over the API:

```bash
curl -X POST http://127.0.0.1:3111/api/whatsapp-document-jobs \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{
    "source": "software",
    "requestedByUserId": "USER-001",
    "documentType": "invoice",
    "documentName": "INV-1001.pdf",
    "documentReference": "INV-1001",
    "clientId": "CLIENT-001",
    "partyId": "PARTY-ALI",
    "recipientName": "Ali Accounts",
    "recipientWhatsAppNumber": "+923001234567",
    "messageText": "Please find your requested invoice attached.",
    "parameters": { "invoiceId": "INV-1001", "companyId": "COMPANY-001" },
    "idempotencyKey": "invoice-INV-1001-923001234567"
  }'
```

```json
{
  "success": true,
  "jobId": "JOB-1001",
  "status": "PENDING",
  "message": "WhatsApp document-delivery job created successfully."
}
```

| Route                                                 | Role     | Purpose                                    |
| ----------------------------------------------------- | -------- | ------------------------------------------ |
| `POST /api/whatsapp-document-jobs`                    | OPERATOR | create a job                               |
| `GET /api/whatsapp-document-jobs`                     | VIEWER   | list, newest first                         |
| `GET /api/whatsapp-document-jobs/:id`                 | VIEWER   | one job with its full timeline             |
| `POST /api/whatsapp-document-jobs/:id/retry`          | OPERATOR | return a failed job to the queue           |
| `POST /api/whatsapp-document-jobs/:id/cancel`         | OPERATOR | cancel one not yet sent                    |
| `GET /api/whatsapp-document-jobs/document-types`      | VIEWER   | the registry, for the send form            |
| `GET /api/whatsapp-document-jobs/kpis`                | VIEWER   | per-type KPIs and SLA compliance           |
| `GET /api/whatsapp-document-jobs/connection`          | VIEWER   | WhatsApp state, queue depth, last delivery |
| `GET /api/whatsapp-document-jobs/connection/qr`       | ADMIN    | pairing QR, when one is being shown        |
| `POST /api/whatsapp-document-jobs/connection/:action` | ADMIN    | `connect` \| `reconnect` \| `logout`       |
| `POST /api/whatsapp-document-jobs/worker/tick`        | ADMIN    | run one worker pass now                    |

## Environment

| Variable                         | Default                                     | What it does                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_JOBS_WORKER`           | `false`                                     | Runs the background worker. Off by default: a worker that started itself on every install would begin sending from whatever half-configured environment it found.                                                    |
| `WHATSAPP_JOBS_MOCK`             | `true`                                      | Records instead of transmitting, with a `mock.` message id. **Set to `false` only with a test number attached.** Defaulting the other way would let a fresh install message a customer before anyone chose a number. |
| `WHATSAPP_JOBS_SESSION_ID`       | `default`                                   | Which WhatsApp session the worker sends through.                                                                                                                                                                     |
| `JOB_POLL_INTERVAL_SECONDS`      | `5`                                         | How often the worker looks for work.                                                                                                                                                                                 |
| `JOB_BATCH_SIZE`                 | `10`                                        | Jobs claimed per pass.                                                                                                                                                                                               |
| `JOB_MAX_ATTEMPTS`               | `3`                                         | Fallback attempt cap; the registry row wins where it sets one.                                                                                                                                                       |
| `JOB_PROCESSING_LEASE_SECONDS`   | `120`                                       | How long a claim is honoured before another worker may take the job back.                                                                                                                                            |
| `JOB_CONCURRENCY`                | `3`                                         | Jobs in flight at once within a batch. Sequential lets one slow document API hold up everything behind it; unbounded is a memory spike and a thundering herd at whoever's API it is.                                 |
| `WHATSAPP_JOBS_RETAIN_DOCUMENTS` | `false`                                     | Keep a copy of each delivered document. Off by default — these are customers' financial documents and the pipeline does not need them once the send succeeds.                                                        |
| `DOCUMENT_API_TIMEOUT_SECONDS`   | `30`                                        | Fallback timeout; the registry row wins.                                                                                                                                                                             |
| `DOCUMENT_API_BASE_URL`          | `http://127.0.0.1:$PORT`                    | Prefix for registry endpoints that are paths rather than absolute URLs. The seeded endpoint already carries `/api`, so this is the host root.                                                                        |
| `MOCK_DOCUMENT_API`              | `false`                                     | Mounts the demo document API. Every route 404s unless this is `true`.                                                                                                                                                |
| `TIJARAH_QUEUE_ENABLED`          | `false`                                     | Poll the host's own job queue. Opt-in: a deployment not pointed at a host queue must not start polling one.                                                                                                          |
| `TIJARAH_QUEUE_BASE_URL`         | `https://api.tijarabooks.com/BotConnectApi` | Where the two queue endpoints live.                                                                                                                                                                                  |
| `TIJARAH_QUEUE_POLL_SECONDS`     | `15`                                        | How often to look for new rows and acknowledge delivered ones.                                                                                                                                                       |
| `WHATSAPP_DEFAULT_COUNTRY_CODE`  | `92`                                        | Applied to a number written with a national trunk zero.                                                                                                                                                              |
| `MOCK_DOCUMENT_API_BASE`         | `http://127.0.0.1:$PORT`                    | What the `url` demo route points back at.                                                                                                                                                                            |
| `DOCAPI_<PROFILE>_TOKEN`         | —                                           | Bearer token for the auth profile named `<PROFILE>` on a registry row.                                                                                                                                               |
| `DOCAPI_<PROFILE>_APIKEY`        | —                                           | API key for that profile, sent as `x-api-key` unless overridden.                                                                                                                                                     |
| `DOCAPI_<PROFILE>_HEADER`        | `x-api-key`                                 | Header name for the key above.                                                                                                                                                                                       |

**No credential is ever written to a job row, a registry row or a log line.** The registry
stores only the _name_ of an auth profile; the secret is resolved from the environment at call
time, and `redactHeaders()` replaces its value anywhere headers are logged.

## Document type registry

A document type is a row, so adding one is an operations task rather than a deployment. The
importable template is [`document-types.import.csv`](./document-types.import.csv) — the columns
map one-for-one onto the `document_type_registry` table, ready for the Google Sheet.

Four response shapes are supported, because document APIs differ in how they hand back a file
and in nothing else:

| `response_format` | The API answers with                                       |
| ----------------- | ---------------------------------------------------------- |
| `binary`          | the PDF bytes                                              |
| `base64`          | a base64 body                                              |
| `url`             | a URL to download (http/https only, no redirects followed) |
| `json`            | JSON carrying either, located by `response_document_path`  |

## Tijarah Books

Eleven document types, all live against `https://api.tijarabooks.com`:

| Type               | Code     | Needs                        |
| ------------------ | -------- | ---------------------------- |
| `digital_invoice`  | DINV     | `documentNumber`             |
| `sale_invoice`     | SL       | `documentNumber`             |
| `purchase_invoice` | PR       | `documentNumber`             |
| `sale_return`      | SR       | `documentNumber`             |
| `purchase_return`  | RP       | `documentNumber`             |
| `payment_voucher`  | CV       | `documentNumber`             |
| `receive_voucher`  | DV       | `documentNumber`             |
| `general_ledger`   | GL       | `from` / `to`, both optional |
| `customer_ledger`  | CUSTOMER | `from` / `to`, both optional |
| `vendor_ledger`    | VENDOR   | `from` / `to`, both optional |
| `expense_ledger`   | EXPENSE  | `from` / `to`, both optional |

`sid`, `grp` and `ayear` are per-type defaults (`1006` / `GR` / `2026`), so a caller supplies
only what varies. A job may override any of them, which is how a second company or a prior
year works without a second registry row.

**The host matters more than the path.** The original specification gave
`https://my.tijarahbooks.com`, which is the dashboard: the same paths there are routes in a
single-page app, every one returns the same HTML shell, and a request asking for
`application/pdf` is answered 406. `api.tijarabooks.com` serves the real documents. If a type
ever starts returning HTML, check the host before anything else.

**The ledger variants replace `GL`, they do not follow `L`.** `/internal/pdf/GL/…/L/CUSTOMER`
404s; `/internal/pdf/CUSTOMER/…/L` returns a PDF titled "CUSTOMER LEDGER". They are three
separate reports, which is why they are three document types.

### The host's own queue

Tijarah Books queues work itself, and two endpoints close the loop:

|                                            |                                      |
| ------------------------------------------ | ------------------------------------ |
| `GET /BotConnectApi/GetPendingBotInvoices` | what is waiting                      |
| `POST /BotConnectApi/MarkInvoiceProcessed` | `{"ID": n}` — stop offering this row |

Each pending row becomes a job; the worker then owns it. Four rules govern the loop, and each
exists because breaking it loses or duplicates a customer's document:

1. **Acknowledge after delivery, never on pickup.** Marking a row when it is picked up means a
   send that then fails is lost — the host stops offering it and nobody received anything.
2. **A recorded send is not a delivery.** In demonstration mode the transport stamps every id
   `mock.` and transmits nothing. Those are never acknowledged, whatever the job's status says.
3. **Idempotency is keyed on the queue id, not the invoice.** The host legitimately queues the
   same invoice twice — two rows for `SL/1006/GR/2026/103` were waiting the first time this
   ran — and each is a separate request to send it.
4. **A failed acknowledgement is retried as an acknowledgement.** Delivering and acknowledging
   are two systems and either can fail alone; the retry must never become a second send.

An unrecognised document code or an undialable contact number is skipped and logged, never
guessed at: sending a customer the wrong document is worse than sending nothing and saying why.

### Contact numbers

The queue stores numbers as people write them locally — `03000000000`. A leading trunk zero is
replaced with `WHATSAPP_DEFAULT_COUNTRY_CODE` (default `92`), giving `923000000000`. Stripping
the zero alone produced a number with no country code, which WhatsApp would have delivered to
whoever it resolved to. `00`-prefixed and already-international numbers pass through untouched.

Getting the country code wrong sends a customer's invoice to a stranger abroad, so it is
configuration rather than a constant in code.

## What a document must survive before it is sent

A response is not a document. Every fetch is checked for a successful status, a non-empty
body, the size limit, and the file signature for the expected MIME type — and, for PDFs,
explicitly for being an HTML page.

That last one is the point of the exercise: an API having a bad day answers `200 OK` with
`content-type: application/pdf` and an error page in the body. Without the signature check
that page goes to a customer as `INV-1001.pdf` — a file that will not open, sent from your
company, about their money.

Filenames are reduced to a leaf name with separators stripped, so a document called
`../../etc/passwd` stays a filename.

## Crash safety

A claim is a conditional `UPDATE ... WHERE status = 'PENDING'`, so two workers racing produce
one winner and one no-op. No Redis and no distributed lock: the database's own row locking is
the mutual exclusion, which matters here because `QUEUE_ENABLED` is off by default.

Each claim carries a lease, extended at every stage. A worker that dies leaves the job in
flight with an expiry, and the sweeper returns it once that passes. A worker that comes back
from the dead cannot finish a job someone else took over, because every write is guarded by
`claimedBy`.

**`SENT` is terminal and is excluded from every recovery path.** Lease recovery skips it,
retry refuses it, cancel refuses it. The document reached a customer's phone and cannot be
unsent, so the only safe thing to do with that row is leave it alone.

Retries use exponential backoff (30s, 2m, 8m, 32m, capped at an hour). These are never
retried, because they will not succeed on the tenth attempt either: an invalid recipient
number, a missing document, an unauthorised client, an unsupported document type, invalid
parameters, a permanently rejected request, an oversized document, a disabled type.

## Idempotency

`idempotencyKey` has a unique index. The service looks the key up first so a caller retrying a
timed-out request gets the original job back with a clear message — but the index is what makes
it correct when two identical requests arrive in the same instant and both pass the lookup.

The send form derives the key from what makes a delivery unique — this document, to this
number — so a double-click collides by design.

## The agent

`create_whatsapp_document_job` is registered on the write tier and is absent from the customer
allowlist, so no customer message reaches it however it is phrased. The agent resolves the
document, the party and the recipient, then writes a row; it never fetches the document and
never talks to WhatsApp. If more than one contact matches the name and the number given is not
one of them, the tool returns the candidates and refuses — picking one would send a customer
somebody else's invoice.

## Connecting a real number

The `OpenWAProvider` interface (§10) is implemented by `EngineDeliveryProvider`, backed by this
project's Baileys / whatsapp-web.js engines rather than `@open-wa/wa-automate` — which is not a
dependency here and requires a real Chrome. The interface is unchanged, so a wa-automate
adapter is a drop-in.

To send for real:

1. Attach a **separate test number** — never the primary business number.
2. Set `ENGINE_TYPE=baileys` unless you have a working Chromium (see below).
3. Create a session, then set `WHATSAPP_JOBS_MOCK=false` and `WHATSAPP_JOBS_SESSION_ID` to
   that session's **name or id** — either is accepted.
4. Open **Document Delivery** and press **Connect**; scan the QR with that phone.
5. The screen shows `CONNECTED` only when the engine itself says so — never inferred.

### Browser-rendered hosts

Some accounting systems build their PDFs in the browser and serve no document endpoint at all.
For those, a type is marked `providerKind: 'browser'` and `BrowserDocumentProvider` signs a
real Chrome in, opens the route, waits for the page to render, and prints it.

Tijarah Books turned out not to need this — `api.tijarabooks.com` serves PDFs directly — but
the provider is kept and tested for hosts that do. It waits for real content before printing:
"network idle" only means the requests stopped, and printing a client-rendered page too early
produces a blank but perfectly valid PDF, which every downstream check would pass.

```
docker compose --profile documents up -d
DOCUMENT_BROWSER_WS_ENDPOINT=ws://openwa-chrome:3000
DOCAPI_<PROFILE>_USERNAME / _PASSWORD / _SIGNED_IN_SELECTOR
```

### Which engine

`whatsapp-web.js` (the default) drives a real Chromium, so it needs a container with Chrome
installed (`docker compose --profile full up`), not a serverless function: the browser session
is long-lived and stateful. On a host where Chromium cannot start, a session on it sits in
`initializing` forever and every send fails.

**Baileys is pure Node and pairs by QR just the same.** It has no browser, so it is the engine
to use anywhere Chrome is awkward — including this development sandbox, where snap Chromium
cannot build its mount namespace at all.

### Verified, and not

The pipeline is proven end to end against the real engine transport: the document is fetched
and validated, the send is attempted, and — with the number not yet scanned — the worker
correctly refuses with `WHATSAPP_DISCONNECTED: WhatsApp session is QR_REQUIRED` and schedules
a retry, having sent nothing.

The physical QR scan and the resulting delivery to a handset are the one step that cannot be
verified without a phone in the room.

## Monitoring

With `METRICS_TOKEN` set, `GET /api/metrics` carries the delivery series alongside the
gateway's own (bearer-authenticated, not the API key):

```
openwa_document_jobs_claimed_total
openwa_document_jobs_sent_total
openwa_document_jobs_retried_total
openwa_document_jobs_failed_total{code="DOCUMENT_API_TIMEOUT"}
openwa_document_jobs_duplicates_prevented_total
openwa_document_api_duration_ms
openwa_document_send_duration_ms
```

They appear only once the worker has claimed something, matching the pacing series: a family
that shows up at its first occurrence is easier to alert on than one pinned at zero on every
deployment that does not use the feature.

Failures are labelled by cause, because the alert worth having is not "some jobs failed" but
"jobs are failing for a reason nobody is watching". `..._retried_total` is separate from
`..._failed_total` — one means the system is coping, the other means it gave up.

The current queue depth is deliberately not a metric. It is a database question, answered by
`GET /api/whatsapp-document-jobs/connection`; holding it in Prometheus as well would be a
second source of truth for something one `SELECT` already knows.

## Which prefix a report lives behind

Verified against the live host on 7 October 2026, by fetching every code both ways and
checking for a real PDF. It is **not one prefix for everything** — a specification review
asked for `/internal` to be replaced by `/report` throughout, which would have broken all
four ledgers:

| Behind `/internal/pdf/`                                             | Behind `/report/pdf/`                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GL`, `CUSTOMER`, `VENDOR`, `EXPENSE` (the ledgers, path ends `/L`) | `TB/Y`, `IL/0`, `SS/Y`, `IS/0`, `BS/0`, `CB/0`, `SP/SL`, `SP/SR`, `SP/PR`, `SP/RP` |

The other prefix 404s in both directions, so a mistake here is loud rather than silent.

## The host honours `from` and `to`

Also verified by reading the period printed inside the returned PDF, rather than by trusting
the parameters were accepted:

| Asked for                       | The PDF says                       |
| ------------------------------- | ---------------------------------- |
| `from=2026-01-01&to=2026-03-31` | Period: 01-Jan-2026 to 31-Mar-2026 |
| `from=2026-07-01&to=2026-07-15` | Period: 01-Jul-2026 to 15-Jul-2026 |
| neither                         | Period: the last 7 days            |

So a ledger that comes back with the wrong period is this side dropping the dates, not the
host ignoring them. `parsePeriod` in `src/modules/agent/period-parse.ts` is where a phrase
becomes those two parameters, and every form it accepts has a test naming the message a real
client sent.
