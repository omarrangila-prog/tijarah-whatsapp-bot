# 21 — WhatsApp Agent Channel

Lets an authorised WhatsApp number instruct the agent in natural language, and gives
customers a restricted, own-account-only version of the same thing.

```
WhatsApp message
      ↓
MessageProjector  (existing inbound path)
      ↓  AGENT_CHANNEL_PORT — optional, fail-open
WhatsAppGateway   resolve sender → normalize → hand over
      ↓
AgentRuntime      reason → propose tool calls
      ↓
PermissionGuard   ALLOW_AUTOMATICALLY / REQUIRE_APPROVAL / DENY
      ↓
invokeTool        the registry's own auth: role, session scope, input schema
      ↓
reply on the session the message arrived on
```

## What it reuses, and what is new

Nearly all of it already existed. The channel adds the loop that connects the pieces.

| Concern                                                  | Where it lives                                                                  | New?             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------- |
| WhatsApp transport                                       | `EngineRegistry` (Baileys / whatsapp-web.js), reached via `PLUGIN_MESSAGE_PORT` | no               |
| Tool registry                                            | `core/agent-tools` — 57 tools, role-gated, session-scoped                       | 6 tools added    |
| Tool execution + auth                                    | `invokeTool` → `AuthService`                                                    | no               |
| Model                                                    | `AnthropicAiProvider` (the copilot's)                                           | `reason()` added |
| Conversations / memory                                   | `cc_conversations`, `messages`                                                  | no               |
| Background jobs                                          | BullMQ + `ScheduledMessageService`                                              | no               |
| Reasoning loop                                           | `AgentRuntime`                                                                  | **yes**          |
| Permission tiers, approvals, admin allowlist, turn audit | `modules/agent`                                                                 | **yes**          |

There is **no second WhatsApp engine**. `OpenWaProvider` is a bridge, not an engine.

## Setup

### 1. Create the agent's API key

Dashboard → Settings → API keys. Give it the **lowest** role the agent should ever have.

```bash
AGENT_API_KEY=<the key>
```

A sender's own role is applied on top of this key, so a turn's effective rights are the
_intersection_ of the two — never the union. An `operator` key means no WhatsApp sender can
reach an admin-only tool, whatever their own role.

With no key the channel still records turns and replies, but runs no tools.

### 2. Connect WhatsApp

Nothing new here — the agent uses the sessions this gateway already manages.

1. Dashboard → Sessions → **New session**.
2. Scan the QR shown on the session card (`QR_REQUIRED`).
3. Wait for `CONNECTED`.

The agent maps the session lifecycle onto the six states in the brief:

| Session status                                | Agent state    |
| --------------------------------------------- | -------------- |
| `ready`                                       | `CONNECTED`    |
| `qr_ready`                                    | `QR_REQUIRED`  |
| `created` / `initializing` / `authenticating` | `CONNECTING`   |
| `disconnected`                                | `RECONNECTING` |
| `failed` / `action_required`                  | `ERROR`        |

> Use a **separate number** for the agent. Do not point it at the company's primary
> business line while you are still deciding what it may do.

### 3. Authorise administrator numbers

The allowlist is a table, not an env var — so a grant can be audited, and it records who
made it. Numbers are stored as digits with the country code and no punctuation
(`923001234567`, never `+92 300 1234567`).

```sql
INSERT INTO agent_admin_numbers ("id", "phoneE164", "label", "role", "isActive", "addedBy")
VALUES (lower(hex(randomblob(16))), '923001234567', 'Ahmed (owner)', 'admin', 1, 'setup');
```

- `admin` — may instruct the agent **and** approve prepared actions.
- `staff` — may instruct and prepare; their requests always need an admin to approve.

A number that is not on this list is a **customer** if the CRM knows it, and **unknown**
otherwise. Neither can reach an admin tool, whatever their message says.

### 4. Choose a mode

```sql
UPDATE agent_settings SET mode = 'assisted' WHERE id = 'default';
```

| Mode                 | Behaviour                                                                    |
| -------------------- | ---------------------------------------------------------------------------- |
| `manual` _(default)_ | The agent prepares and explains. Every outbound action needs approval.       |
| `assisted`           | The agent drafts, picks the contact and recommends a time. A human approves. |
| `automatic`          | Only tools with an explicit `ALLOW_AUTOMATICALLY` policy may run unattended. |

The mode is a **ceiling**. A per-tool policy may be stricter than it, never bolder.

### 5. Per-tool permission (optional)

```sql
INSERT INTO agent_tool_policies ("id", "toolName", "senderRole", "level", "allowedRecipients", "note")
VALUES (lower(hex(randomblob(16))), 'MessageSendText', 'admin', 'ALLOW_AUTOMATICALLY',
        '923214455667', 'Statement reminders to Ali Traders only.');
```

Anything without a row defaults to `REQUIRE_APPROVAL` for writes and
`ALLOW_AUTOMATICALLY` for reads. The default is decided in code, not by the absence of a
row — a missing policy must never mean "allowed".

## Approving over WhatsApp

```
Agent → admin:
  Action: MessageSendText
  Requested by: +923001111111
  Recipient: 923214455667@c.us
  Message: Dear Ali, a gentle reminder about invoice INV-1001…

  APR-1001 · expires in 60 minutes
  Reply APPROVE APR-1001 / EDIT APR-1001 <new text> / CANCEL APR-1001
```

Before anything executes:

- the approver must be on the allowlist with role `admin`;
- it **cannot be the number that requested it** — self-approval would make the gate
  decorative;
- the approval must still be `pending` and unexpired;
- the claim is a conditional `UPDATE … WHERE state = 'pending'` with a unique idempotency
  key, so two `APPROVE` replies racing produce one message, not two;
- the **emergency stop outranks approval** — a halted agent refuses `APPROVE` while still
  allowing `CANCEL` and `EDIT`.

`EDIT` replaces the wording and leaves the action pending. It does not approve as a side
effect, so nobody sends a message by correcting a typo in it.

## Emergency stop

```sql
UPDATE agent_settings
   SET "automationHalted" = 1, "haltedReason" = 'incident 42', "haltedAt" = datetime('now')
 WHERE id = 'default';
```

Checked at the top of every turn. While set, the agent still receives, records and answers,
but performs no outbound action and will not execute a prepared one.

## Safety model

The architecture, not the prompt, is what holds:

- **The model cannot reach an engine.** It returns tool _requests_; the backend decides.
- **The sender's role is resolved before the model runs**, from the allowlist. A message
  claiming to be from the owner is a customer message that says so.
- **Tools are filtered by role before being offered**, so a tool a sender may not use is
  invisible rather than merely refused.
- **Customers are fenced to their own account** by an allowlist of tools, and any tool aimed
  at a number other than their own is denied.
- **Some tools are off over WhatsApp entirely** at every role — session deletion, contact
  blocking, webhook and automation-rule changes. Those are dashboard work.
- **Injection screening demotes rather than blocks**: a flagged turn still gets answered,
  with write tools withheld. A false positive costs an action, not a reply.
- **Untrusted text is fenced** with a per-turn random marker, and the marker is stripped
  from the content so a message cannot close the fence early.
- Group messages are never answered.
- Redelivered messages are processed exactly once (unique index on the inbound message id).

## Scheduled events

A cron job's entire job is to insert a row:

```ts
await agentEvents.raise({
  eventType: 'invoice_overdue',
  eventKey: `overdue:INV-1001:${today}`, // unique — dedupe lives in the database
  subjectPhone: '923214455667',
});
```

It does not send, decide, or talk to WhatsApp. The agent picks the event up, reasons about
it, and anything outbound goes through the same permission layer as a human's request —
because a scheduler with its own send path would be a second route to a customer that
bypasses every control here.

## Backups

All six `agent_*` tables are **excluded** from the export, each with a reason in
`EXPORT_TABLE_EXCLUSIONS`. Two are transient queues whose rows are meaningless after a
restore; four are per-deployment security configuration, and restoring an allowlist would
silently grant admin rights in the destination.

## Running without credentials

```bash
AGENT_WHATSAPP_MOCK=true    # in-memory transport; `mock.` message ids, nothing transmitted
AGENT_REASONING_MOCK=true   # deterministic rule-based reasoner instead of the model
```

Both are real implementations rather than stubs: the mock transport records sends, fails
when "disconnected", and can be driven through every connection state; the mock reasoner
genuinely picks tools and summarises their results. Neither can be mistaken for the real
thing — mock sends carry a `mock.` id and the provider id is recorded on every turn.
