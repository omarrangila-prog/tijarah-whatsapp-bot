# Tijarah Books WhatsApp bot — user guide

How to set the bot up, and how to use it every day. Written for the people who run it — the
office team and whoever looks after the server — not for developers. (Developers: start with
`HANDOFF.md`.)

**What the bot does**

1. **Sends documents.** When Tijarah Books queues an invoice or report for a customer, the bot
   delivers the PDF to their WhatsApp.
2. **Answers report requests.** A client messages _"trial balance for this year"_ and gets the
   PDF back in the same chat.
3. **Takes new documents for approval.** A client can compose a sale invoice in chat. It lands
   on Tijarah's **approval screen** as _pending_ — it is never entered until someone in Tijarah
   approves it.

It serves **registered clients only**. Anyone else who messages the number gets no reply from
the bot; their chat waits in the Inbox for your team.

---

## At a glance

| I want to…                                      | Go to                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Log in to the dashboard                         | your dashboard address → paste your API key                          |
| Connect or reconnect WhatsApp                   | **Document Delivery** → **Connect** → scan the QR                    |
| Make someone a client (so the bot answers them) | **Inbox** → open their chat → **Tijarah client** → **Add as client** |
| Stop the bot answering someone                  | **Inbox** → open their chat → **Tijarah client** → **Remove client** |
| Send an invoice or report to someone myself     | **Document Delivery** → **Send to WhatsApp**                         |
| See what was sent, and what failed              | **Document Delivery** → **Jobs** table                               |
| Resend something that failed                    | **Document Delivery** → the failed row → **Retry**                   |
| Approve a document a client composed            | the **approval screen in Tijarah Books** (not this dashboard)        |
| Give a colleague their own login                | **Settings** → **Administration** → **API keys**                     |
| Update the bot to the newest version            | [Part 3](#part-3--updating-the-bot)                                  |

---

## Part 1 — Setting it up (once)

### Step 1. Install it on the server

Whoever runs the server follows **`INSTALL.md`** (requirements, Docker route, what it touches).
In short, on a Linux server with Docker:

```bash
git clone https://github.com/omarrangila-prog/tijarah-whatsapp-bot.git /opt/tijarah-whatsapp-bot
cd /opt/tijarah-whatsapp-bot/deploy
sudo ./deploy.sh                 # first run creates .env and stops
sudo nano .env                   # fill it in — see Step 2
sudo ./deploy.sh --auto-update   # checks everything, builds, starts, keeps itself updated
```

`--auto-update` is what makes updates automatic: from then on the server checks GitHub every five
minutes and installs a new version by itself. Use it once; it stays on.

`deploy.sh` checks Tijarah's API before it starts and refuses to go live if something would fail
silently. If it stops with a message, the message says what to fix.

### Step 2. The settings that matter

All in `deploy/.env`. The file explains every line; these are the ones to get right before
clients use it.

| Setting                                 | Set it to                                      | Why                                                                                        |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `WHATSAPP_JOBS_MOCK`                    | `false` when ready                             | `true` = practice mode: documents are prepared but **not** sent                            |
| `AGENT_WHATSAPP_MOCK`                   | `false` when ready                             | `true` = the bot's chat replies are recorded but **not** sent                              |
| `TIJARAH_QUEUE_ENABLED`                 | `true`                                         | picks up documents Tijarah Books queues — whatever is queued **will** be delivered         |
| `APPROVAL_POLL_ENABLED`                 | `true`                                         | when a composed document is approved in Tijarah, sends the finished PDF back to the client |
| `BOT_REQUIRE_REGISTRATION`              | `true`                                         | only registered clients are served                                                         |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | your AI provider (e.g. Kimi, DeepSeek, OpenAI) | **required** for ordinary sentences — without it, fixed phrases only                       |
| `GEMINI_API_KEY`                        | optional backup AI key                         | used if the provider above is not set or fails                                             |
| `BOT_REGISTRATION_CONTACT`              | the person who adds new clients                | shown to clients when something needs a human                                              |

Without an AI key the bot still works, but only understands fixed phrases such as _"customer
ledger for C-1005"_. Every time you change `.env`, run `sudo ./deploy.sh` again.

### Step 3. Log in to the dashboard

The first login key is created on the server. From the `deploy` folder:

```bash
sudo docker compose exec openwa-api cat /app/data/.api-key
```

Open the dashboard in a browser, paste the key, and sign in. This is the **admin** key — keep it
private.

To give colleagues their own login: **Settings** → **Administration** → **API keys** → create a
key with the role **operator** (can work in the Inbox and send documents) or **viewer** (can only
look). Adding and removing clients needs an **admin** key.

### Step 4. Connect WhatsApp

1. In the dashboard open **Document Delivery**. The connection panel is on that page.
2. Press **Connect**. A QR code appears.
3. On the business phone: **WhatsApp → Linked devices → Link a device** (Linked devices is under
   Settings on iPhone, under the ⋮ menu on Android), and scan the code. The code changes every ~20 seconds — scan the one currently on screen.
4. When it says connected, press **Send test document**. It sends to the business phone itself,
   so no client receives it.

Keep the business phone charged and online. If WhatsApp is ever logged out from the phone, the
bot stops until you scan again.

### Step 5. Add your clients

The bot only answers numbers that are registered as clients, and each client is tied to **their
own company** in Tijarah — they can never see another company's books.

**Automatically:** if a client's WhatsApp number is the one saved on their Tijarah profile, the
bot finds them in Tijarah's client list the first time they message. Nothing to do.

**By hand, from the Inbox** (needs an admin key):

1. Open **Inbox** and click the client's chat.
2. In the right-hand panel, find **Tijarah client**. It says _"Not a client — the bot stays
   silent here"_.
3. Press **Add as client**. The bot looks the number up in Tijarah:
   - found → the company is filled in for you;
   - on several accounts → pick the right business;
   - not found → type the company yourself.
4. Check **Business name**, **Company (sid)**, **Group** and **Year**, then press **Save client**.

From then on the bot answers that number. **Remove client** in the same panel stops it; the
chat history stays.

> **Where do I find Company (sid) and Group?** They are the company number and branch code of the
> client's books in Tijarah Books — for example company `1006`, group `GR`. Ask Tijarah support if
> you are not sure; a wrong value would send a client the wrong company's reports.

### Step 6. Check it works

1. From a **client's** phone, send _"trial balance"_. Within a minute the PDF should arrive.
2. From a phone that is **not** a client, send anything. The bot should **not** reply; the chat
   appears in the Inbox for your team.
3. In **Document Delivery**, the trial balance shows as **SENT**.

If all three are true, it is set up.

---

## Part 2 — Using it every day

### A. Documents Tijarah Books sends (automatic)

When someone in Tijarah Books sends a document to WhatsApp, it appears in **Document Delivery →
Jobs** within seconds and is delivered on its own. You only need this screen to check on things.

| Status                            | Meaning                                                              | What to do                               |
| --------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| `PENDING`                         | waiting to be picked up                                              | nothing                                  |
| `CLAIMED` … `SENDING_TO_WHATSAPP` | fetching the PDF and sending it                                      | nothing                                  |
| `SENT`                            | delivered to WhatsApp                                                | nothing                                  |
| `RETRY_SCHEDULED`                 | a temporary problem (often WhatsApp disconnected); it will try again | reconnect WhatsApp if it is disconnected |
| `FAILED`                          | could not be sent — click the job to see why                         | fix the cause, then press **Retry**      |
| `CANCELLED`                       | someone cancelled it                                                 | nothing                                  |

Nothing is lost while WhatsApp is disconnected: jobs wait and go out once it reconnects.

Below the connection, a second line says whether the bot is **understanding ordinary sentences**:
which AI is answering, or — if it is not — the reason and what to fix. When it says _"No AI is set
up"_, clients only get the help list back, no matter what they type.

### B. Sending a document yourself

1. **Document Delivery** → **Send to WhatsApp**.
2. **Document type** — e.g. _Sale Invoice_ or _Customer Ledger_.
3. **Send to** — pick a registered client from the list (their company is filled in for you), or
   choose **Another number…** and type the WhatsApp number with country code, e.g. `92XXXXXXXXXX`.
4. For an invoice or voucher, enter the **Document number** exactly as Tijarah shows it — a plain
   number such as `179`, not `INV-179`.
5. For a report, the **From / To** dates are optional (blank = the full period). **Party code** is
   optional — fill it in for one customer's or vendor's ledger.
6. Name and caption are optional; leave them blank for the standard message.
7. Press **Send request**, and watch the job in the table.

A wrong document number or company ends as `FAILED` with _"Document API responded 400"_ —
Tijarah has no such document. Check the number in Tijarah and send again.

### C. What clients can ask for in chat

Clients just message the business number in ordinary words. Examples:

- _"Send me the trial balance"_
- _"Customer ledger for C-1005"_
- _"Sales book from 1 July to 30 September"_
- _"Stock summary for this year"_

The PDF comes back in the same chat. Reports available:

> Balance Sheet · Income Statement · Trial Balance · General Ledger · Customer Ledger ·
> Vendor Ledger · Expense Ledger · Item Ledger · Cash & Bank Book · Sales Book Report ·
> Purchase Book Report · Sale Return Report · Purchase Return Report · Stock Summary

Tell your clients:

- **For one customer's or vendor's ledger, give the account code** (e.g. `C-1005`), not the name.
  The bot cannot find a party by name yet, and will ask for the code.
- **No dates means the full period.** Say the dates for a shorter one.
- **They only ever get their own company's books,** and only to the number that asked.

### D. Clients creating documents for approval

A client can start a new document in chat, for example:

> _"Create a sale invoice for Ahmed Traders, 10 shirts at 1500"_

1. The bot asks for anything missing — date, items, quantities, prices — one question at a time.
2. When nothing is missing it says _"Ready"_. The client can reply **review** to read it all back
   with the total, **submit** to send it for approval, or **cancel** to drop it.
3. On **submit** it goes to the **approval screen in Tijarah Books** as **pending**. The client is
   told: _"It is waiting on the approval screen. No entry has been made."_
4. Someone in Tijarah **approves or rejects** it there.
5. Once an invoice is approved, the bot sends the finished invoice back to the client on WhatsApp.
   (A new account or item has no PDF, so nothing is sent for those.)

**Available today:** sale invoice, purchase invoice, new customer/vendor account, new item. Other
types (payments, receipts, returns, expenses) are ready on the bot's side and switch on once
Tijarah's approval screen accepts them — the bot tells the client politely if they ask for one
that is not ready.

**Nothing a client types on WhatsApp ever becomes an accounting entry by itself.** It always
waits for a person in Tijarah to approve it.

### E. Talking to people yourself

Every chat — clients and everyone else — is in the **Inbox**. Your team can read and reply there
as the business number. Chats from people who are not clients are left entirely to the team; the
bot does not answer them.

---

## Part 3 — Updating the bot

**If automatic updates are on** (installed with `./deploy.sh --auto-update`), there is nothing to
do. The server checks GitHub every five minutes and installs any new version by itself. WhatsApp
stays linked, and clients, settings and history are kept.

To check it is on, or to see the last few updates, on the server:

```bash
systemctl status tijarah-bot-update.timer
journalctl -u tijarah-bot-update -n 50
```

To turn automatic updates on later, or off:

```bash
cd /opt/tijarah-whatsapp-bot/deploy && sudo ./deploy.sh --auto-update      # on
cd /opt/tijarah-whatsapp-bot/deploy && sudo ./deploy.sh --no-auto-update   # off
```

**To update by hand** (automatic updates off, or you do not want to wait), run this **from your own
computer's terminal**, with your server's login in place of `USER@SERVER`:

```bash
ssh -t USER@SERVER 'cd /opt/tijarah-whatsapp-bot && sudo git -c safe.directory=/opt/tijarah-whatsapp-bot pull && cd deploy && sudo ./deploy.sh --no-check'
```

Already logged in to the server? Just run the part inside the quotes.

If it prints an error, copy the last 20 lines and send them to whoever maintains the bot. One error
is worth knowing by name: _"The server's copy has changes of its own"_ means somebody edited the
files on the server directly. Nothing is overwritten and nothing is deployed until that is sorted
out.

---

## Part 4 — When something goes wrong

| What you see                                                   | Likely cause                                        | Fix                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Nothing is delivered; clients get no replies                   | WhatsApp is disconnected                            | **Document Delivery** → **Connect** → scan the QR again                                |
| A number was stopped and came back on its own                  | normal — a linked number is restarted automatically | nothing; to stop it for good use **Log out**, not **Disconnect**                       |
| One client gets no reply                                       | their number is not registered                      | **Inbox** → their chat → **Tijarah client** → **Add as client**                        |
| A client gets _"The tool failed: Invalid API key"_             | the server is on an old version                     | update — [Part 3](#part-3--updating-the-bot)                                           |
| The bot only replies with its _"I can help with…"_ list        | no AI key, or it ran out of credit                  | the panel on **Document Delivery** names the cause; set the key in `.env` and redeploy |
| A job is `FAILED` — _Document API responded 400_               | wrong document number or company                    | check the number in Tijarah (e.g. `179`), send again                                   |
| A job is `FAILED` — _… is not on WhatsApp_                     | the number is wrong or has no WhatsApp              | check the number with the client, send again                                           |
| A job is `RETRY_SCHEDULED` — _WHATSAPP_DISCONNECTED_           | WhatsApp dropped                                    | reconnect; the job goes out by itself                                                  |
| A client asks for a ledger by name and the bot asks for a code | the bot can only find parties by account code       | give them the code, e.g. `C-1005`                                                      |
| The dashboard says the API key is invalid                      | wrong key, or the server's key was reset            | see _"If Invalid API key appears"_ in `INSTALL.md`                                     |
| Strangers get _"Your number is not registered"_                | an old version, or `BOT_REGISTRATION_REPLY=true`    | update — [Part 3](#part-3--updating-the-bot); leave `BOT_REGISTRATION_REPLY` blank     |

---

## Rules the bot always keeps

- **Clients only.** Unregistered numbers get no reply from the bot.
- **Own books only.** Each client sees only the company they are registered to.
- **To the asker only.** A report goes back to the number that asked for it — never anyone else.
- **Never an entry.** Anything composed on WhatsApp waits on Tijarah's approval screen as pending.

**What runs by itself:** documents Tijarah queues are delivered; a stopped number is started again;
a failed delivery is retried; an approved document goes back to the client; and the server installs
new versions. What still needs a person: scanning the QR if WhatsApp is logged out, adding a client
whose number is not on their Tijarah profile, and approving documents in Tijarah.

**Back up** the server's data regularly — it holds the WhatsApp link, your clients and the history
(command in `deploy/README.md` → _What survives a restart_). Never share the `.env` file or API
keys.
