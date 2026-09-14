# WhatsApp receivables agent — demonstration

Walks a client through the whole flow: the agent reads a real accounting system, drafts a
reminder, waits for a human, sends it, answers the customer, records what the customer says
without believing it, and stops chasing once a person confirms the payment.

```bash
(cd ../.. && npx nest build)   # once, if dist/ is stale
./start.sh                     # boots on :3111 (first run seeds the demo people)
./demo.sh                      # walk through it with pauses
./demo.sh --fast               # no pauses
./start.sh --reset             # throw the database away and start over
```

## What is real and what is not

Everything runs through the real runtime, the real permission layer, the real tool registry
and the real approval gate. Two things are simulated, and only two:

|                                       |                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **The arrival of a WhatsApp message** | `POST /api/agent/simulate` injects it, instead of an engine delivering it.                                          |
| **The WhatsApp transport**            | `AGENT_WHATSAPP_MOCK=true` swaps the three send tools for stand-ins that record. Every result carries a `mock.` id. |

No WhatsApp session is started, so there is no QR code and no connection to any account.
Nothing can be transmitted to anyone. The database is a throwaway in `data/`, never the
production one.

The accounting system is `MockLedgerAdapter` — an in-memory ledger with real balances and
honoured idempotency. Point `LEDGER_*` at a client's REST API and the same demo runs against
their books.

**All the data is fictional.** Ali Textiles, Bilal Fabrics, Dawood Trading, the invoice
numbers and the payment reference are invented for the demonstration.

## The people

| Number       | Who          | Role                                         |
| ------------ | ------------ | -------------------------------------------- |
| 923001111111 | Ahmed        | administrator — can instruct the agent       |
| 923002222222 | Manager      | administrator — approves what Ahmed asks for |
| 923214455667 | Ali Textiles | customer — restricted to his own account     |

An administrator is an entry in `agent_admin_numbers`. A customer is a CRM profile whose
`ledgerId` custom field links the number to an account in the accounting system. A number
that is neither is ignored.

## The points worth pausing on

- **Step 4** — the person who asked cannot approve their own request.
- **Step 7** — Ali asks about `INV-0994`, which is real but belongs to Bilal. He is told
  exactly what he would be told about an invoice that does not exist.
- **Step 8** — a message is not a receipt. Nothing is marked paid because a customer said so.
- **Step 13** — Ali drops off the chase list without anyone telling the agent he paid. It
  asked the ledger again.
- **Step 14** — an opt-out is enforced, not filed: the next send is refused even for an admin.
- **Step 16** — every turn above, with the permission decision that produced it.

## Files

|            |                                                                  |
| ---------- | ---------------------------------------------------------------- |
| `start.sh` | boots the server against the throwaway database                  |
| `demo.sh`  | the 16 steps                                                     |
| `seed.py`  | the two administrators and three customers                       |
| `boot.env` | the isolated configuration (no credentials)                      |
| `data/`    | database, bootstrap API key, media — git-ignored, safe to delete |
