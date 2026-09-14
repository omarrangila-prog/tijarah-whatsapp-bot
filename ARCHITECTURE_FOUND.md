# ARCHITECTURE_FOUND.md — WA Command Center

Audit of the existing **OpenWA** repository (`openwa` v0.23.3, fork of `rmyndharis/OpenWA`)
performed before any code was written. Everything below was read from source, not assumed.

---

## 1. Root architecture

Single npm workspace, two build targets in one repo:

| Path                                           | What it is                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/`                                         | NestJS 11 backend (TypeScript, TypeORM, Socket.IO, Swagger)                            |
| `dashboard/`                                   | React 19 + Vite 8 SPA (TanStack Query v5, react-router 7, i18next, recharts, lucide)   |
| `sdk/`                                         | Generated client SDKs (TS/Python/PHP) with drift-check scripts                         |
| `docs/`                                        | 31 numbered design documents                                                           |
| `test/`                                        | Jest e2e suites (`test/jest-e2e.json`)                                                 |
| `charts/`, `Dockerfile`, `docker-compose*.yml` | Helm chart + container/deploy config                                                   |
| `openapi.json`                                 | Committed OpenAPI snapshot, verified against a fresh export by `npm run openapi:check` |

Key scripts: `npm run dev` (concurrently API + Vite), `npm run build:all`,
`npm test` (jest), `npm run lint`, `dashboard: npm run build / test / typecheck`.

In production the Nest process **serves the built dashboard itself** (`ServeStaticModule` in
`app.module.ts`, `DASHBOARD_DIST = dashboard/dist`) — one port, `/api/*` and `/socket.io/*` excluded
from the SPA fallback. `main.ts` owns the HTML responses so it can inject a per-response CSP nonce.

### Two TypeORM connections (important)

- **`main`** — _always_ `better-sqlite3` (hardcoded). Owns `api_keys` + `audit_logs`.
  Migrations: `src/database/migrations-main/`.
- **`data`** — pluggable `sqlite | postgres`. Owns sessions, messages, webhooks, templates,
  integration, status-store, automation. Migrations: `src/database/migrations/` (32 files).
  Postgres boot migrations run under a cross-replica advisory lock (`pg-boot-migrations.ts`).

`src/common/utils/column-types.ts` gives `jsonColumnType()` (always `simple-json`) and
`dateColumnType()` (`timestamp` on PG, `text` + `DateTransformer` on SQLite). **Data-connection
entities only** — main-connection entities must hardcode their types.

---

## 2. NestJS modules present

`session, message, webhook, template, auth, audit, events, contact, group, profile, call, label,
channel, stats, metrics, status, status-store, media, chat-media, automation, takeover, catalog,
plugins, integration, search, health, settings, infra, docker, queue (opt-in), mcp (opt-in)`
plus core `hooks`, `plugins`, `agent-tools`.

Conditional modules are mounted by env flag (`QUEUE_ENABLED`, `MCP_ENABLED`, `SEARCH_ENABLED`).

---

## 3. WhatsApp engines — DO NOT TOUCH

`src/engine/` holds an engine abstraction (`IWhatsAppEngine`) with two adapters:
**whatsapp-web.js** and **Baileys**, plus `identity/` (LID ↔ phone mapping store), an engine
registry with liveness checks, and a large parity/inventory test suite
(`engine-parity.spec.ts`, `engine-inventory-parity.spec.ts`, `docs-29-counts.spec.ts`).

Session lifecycle is split across `session-engine-lifecycle.service.ts`,
`session-engine-event-wiring.ts`, `session-ownership.service.ts` (node lease + claim),
`session-liveness-watchdog`, `reconnect-policy`, `takeover`. This is subtle, well-tested,
multi-node-aware code. **Nothing here will be rewritten.**

---

## 4. Message persistence

`messages` table (`src/modules/message/entities/message.entity.ts`):

`id, sessionId, waMessageId, chatId, chatName, author, from, to, body, type, direction
(incoming|outgoing), timestamp (bigint→number transformer), metadata (simple-json),
mediaPath, mediaMimetype, status (pending|sent|delivered|read|failed), createdAt`

Indexes: `(sessionId, createdAt)`, `(chatId)`, **unique `(sessionId, waMessageId)`**,
`status`, partial `mediaPath`, `createdAt`. There is also an FTS table
(`AddMessagesFts` migration) used by the global search module.

`MessageProjector` (`src/modules/session/message-projector.service.ts`, 627 LOC) is the single
inbound/outbound projection point:

- `dispatchInboundMessage()` — fires `message:persisted` hook → chat-media archive →
  `webhookService.dispatch('message.received')` → `automationRules.evaluateInbound()` →
  `eventsGateway.emitMessage()`.
  The **unique `(sessionId, waMessageId)` insert is the at-most-once oracle** — engine re-fires
  are deduped here.
- `handleOwnSendEcho()` — the single chokepoint for **all** outgoing messages (REST _and_
  phone-composed); `MessageSendService` deliberately does **not** dispatch `message.sent`.
- `handleMessageAck()`, revoke/edit/reaction mutation projectors.

This is exactly where new business-metadata recording must attach — as a fire-and-forget optional
dependency, mirroring how `AutomationRulesService` is already wired in.

---

## 5. REST API surface (reusable as-is)

Controller prefixes found:

```
sessions | sessions/:sessionId/{messages,contacts,groups,labels,templates,webhooks,
                                channels,status,profile,calls,media,automation-rules}
auth | auth/api-keys | audit | stats | search | webhooks | plugins | integration/* | infra |
health | metrics | settings | ingress
```

Highlights that must be **reused, not reimplemented**:

- `GET /sessions/:id/chats` — engine chat list (id, name, isGroup, kind, unreadCount, timestamp, lastMessage)
- `GET /sessions/:id/messages?chatId=&limit=` — persisted history (inline-media budget applied)
- `GET /sessions/:id/messages/:chatId/history` — live engine history backfill
- `GET /sessions/:id/messages/:chatId/:messageId/media` — on-demand media blob
- 20+ send endpoints: text, image, video, audio, document, sticker, location, contact, poll,
  reply, forward, react, edit, delete, pin, star, vote-poll, **send-bulk (async batch + cancel)**
- Chat ops: mark read/unread, archive, mute, pin, delete, typing, presence subscribe/update
- Contacts: list, check number, profile picture (single + **batched**), resolve phone, block/unblock
- Labels: list, chat labels, add/remove label on chat (engine-backed, WhatsApp Business labels)
- Sessions lifecycle: create/start/stop/logout/force-kill/QR/pairing-code/config/stats
- Stats: `/stats/overview`, `/stats/messages?period=`, `/stats/sessions/:id`
- Search: `/search` (FTS across messages, key-scoped)

---

## 6. Realtime architecture

`EventsGateway` — Socket.IO namespace **`/events`**, room model `session:<id>:<event>`,
optional Redis adapter for multi-node. API key sent via `auth.apiKey` (never in the query string).

Guards in place: per-key token-bucket frame limiter, per-IP handshake sliding window,
max sockets per key, live socket eviction when a key is revoked, and
`isSessionSubscriptionAllowed()` which forbids a session-scoped key from subscribing to `*`.

`SUBSCRIBABLE_EVENTS` (drift-guarded — every entry must have a matching `emit*` producer):

```
message.received, message.sent, message.ack, message.revoked, message.reaction, message.edited,
session.status, session.qr, session.authenticated, session.disconnected, session.restriction,
group.join, group.leave, group.update, group.join_request,
call.received, call.accepted, call.rejected, call.missed,
status.received, presence.update
```

Client side: `dashboard/src/hooks/useWebSocket.ts` already decodes the envelope
(`{type:'event', payload:{event, sessionId, data}}`) and fans out to typed callbacks, with
reconnect/`connectionFailed` handling. **No polling is used for live messages today.**

---

## 7. Authentication & authorization

API-key based. `ApiKey` entity: `name, keyHash, keyPrefix, role, allowedIps, allowedSessions,
isActive, expiresAt, lastUsedAt, usageCount`. Roles: **`admin` > `operator` > `viewer`**.

`ApiKeyGuard` enforces role (`@RequireRole`), IP allowlist, and session scoping. Session scoping
resolves from `:sessionId` (or `:id` on a `@SessionScoped()` controller).
`@RequireUnscopedKey()` fences routes with no session dimension;
`src/modules/auth/global-route-fence-coverage.spec.ts` is a **structural guard** that fails the
build if a new global route is added without a fence or an allowlist entry with a reason.

Frontend stores the key in `sessionStorage` (`openwa_api_key`), re-validates on mount via
`POST /auth/validate`, and gates admin routes in `App.tsx` + `Layout.tsx`.

---

## 8. Webhooks, labels, automation (existing)

- **Webhooks**: per-session, event list, **filter DSL** (`WebhookFilters` = conditions with
  `is/isNot/contains/equals`), outbox + reconciler + delivery-failure tracking, **HMAC signing**.
  `filter-evaluator.ts` is reusable and LID-aware.
- **Labels**: engine-backed WhatsApp Business labels — real API, not local storage.
- **Automation**: `automation_rules` table — _single-message autoreply only_
  (`conditions` reuses the webhook filter JSON verbatim, `replyText`, `cooldownSeconds`,
  per-session cap, freshness gate at 300 s, per-(rule,chat) cooldown map, loop bounding).
  `evaluateInbound()` is called fire-and-forget from the projector.

---

## 9. Dashboard (existing)

Pages: `Dashboard, Sessions, Chats, Webhooks, Templates, ApiKeys, Logs, MessageTester,
Infrastructure, Plugins, Login`. All lazy-loaded with retry (`lazyWithRetry`).

`src/services/api.ts` (1355 LOC) — typed client, `X-API-Key` header, 401 → auto-logout,
errors carry `status` + machine `code`. Namespaced: `sessionApi, messageApi, webhookApi,
templateApi, contactApi, apiKeyApi, auditApi, searchApi, healthApi, infraApi, pluginsApi,
pluginInstancesApi, statsApi`.

`src/components/chats/` — `ChatSidebar, ChatThread, ChatComposer, MessageBody, MediaLightbox,
ChatAvatar, KindIcon, StatusMedia, StatusComposeModal`. `Chats.tsx` (1066 LOC) already handles
WS message append, ack merge, reaction snapshots, edits, revokes, scroll restore, mark-read
coalescing, profile-picture batching, LID→phone resolution.

Design tokens live in `App.css` (`--primary #25d366`, slate scale, `--radius 10px`, shadow scale)
with a `[data-theme='dark']` block and documented WCAG-AA contrast twins
(`--primary-text`, `--error-text`, …). i18n covers 13 locales with a parity check script.

Pure logic is already extracted into `src/utils/*` with `node --test` unit tests
(chatList, chatMessages, chatFilters, composerSend, scrollDecision, sessionActions, …).

---

## 10. Structural guards that constrain new code

These are real tests that will fail the build — they shape how features must be added:

1. `global-route-fence-coverage.spec.ts` — global routes need `@RequireUnscopedKey`/`@Public`/session param.
2. `audit-coverage.spec.ts` — every `AuditAction` enum member must be emitted or registered as intentionally unemitted.
3. `events.gateway.spec.ts` — every `SUBSCRIBABLE_EVENTS` entry needs an `emit*` producer.
4. `openapi-contract.spec.ts` + `npm run openapi:check` — committed `openapi.json` must match a fresh export.
5. `migration-drift.spec.ts` — migrations must cover entity schema.
6. Per-module **jest coverage thresholds** in `package.json`.

---

## 11. What must NOT be rewritten

- The engine layer and both adapters, session lifecycle/ownership/takeover, reconnect policy.
- Message persistence + the projector's at-most-once oracle.
- Webhook delivery/outbox/HMAC, filter evaluator.
- Auth guard, role model, session scoping, WS rate limiting and eviction.
- Media handling, inline-media budgets, chat-media archive.
- Search/FTS, plugin system, integration fabric, MCP, infra/Docker control.

---

## 12. Gaps — what WA Command Center must add

| Need                                                                 | Status today                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Conversation as a business object (status, priority, assignee, team) | **absent**                                                       |
| Internal notes (never sent to WhatsApp)                              | **absent**                                                       |
| Assignment + assignment history                                      | **absent**                                                       |
| CRM contact profile, custom fields, consent                          | **absent** (engine contacts only)                                |
| Quick replies with variables + `/` picker                            | partial — `templates` exist, but no shortcut/folder/variables    |
| Visual WHEN→IF→THEN automation + execution logs                      | partial — autoreply rules only, no logs                          |
| AI copilot (summary/intent/sentiment/suggested reply)                | **absent**                                                       |
| Broadcasts with consent, approval, pacing, analytics                 | partial — `send-bulk` batch exists, no audience/consent/approval |
| Scheduled messages                                                   | **absent**                                                       |
| First-response / resolution-time metrics                             | **absent** (no persistence to compute them)                      |
| Unified multi-number inbox                                           | **absent** — `Chats.tsx` is single-session at a time             |
| Follow-ups                                                           | **absent**                                                       |

---

## 13. Proposed changes (summary)

- **New backend module `src/modules/command-center/`** holding conversations, notes, tags, teams,
  agents, customer profiles, quick replies, follow-ups, broadcasts, AI, analytics — mounted in
  `app.module.ts` alongside the existing modules, on the **`data`** connection.
- **One new migration** creating 15 tables with proper indexes (SQLite + Postgres branches,
  following `AddAutomationRules1785900000000` verbatim in style).
- **`ConversationMetadata` is a derived index + workflow state**, not a duplicate store: it carries
  business fields (status/priority/assignee) _and_ denormalized `lastMessageAt/preview/unread`
  so the inbox is one indexed query and first-response/resolution times become computable.
  Message bodies, media and delivery state stay in `messages`, which remains the source of truth.
- **Recording hooks** attach to `MessageProjector` as an `@Optional()` dependency, exactly like
  `AutomationRulesService` — fire-and-forget, never able to break the receive path.
- **Realtime** extends the existing `/events` gateway with `conversation.updated` +
  `conversation.note` producers registered in `SUBSCRIBABLE_EVENTS`.
- **Frontend** keeps Vite/React/TanStack Query/`useWebSocket`, adds an `Inbox` page plus the new
  sidebar sections, and reuses `services/api.ts` conventions for every new call.
- Existing pages stay reachable; nothing is deleted.

## 14. Major risks

1. **Route-fence guard** — new global controllers must carry `@RequireUnscopedKey()` or be
   session-dimensioned, or CI fails. Mitigation: conversations are addressed under
   `sessions/:sessionId/...` where possible; genuinely global surfaces (teams, quick replies)
   get the fence decorator.
2. **OpenAPI snapshot drift** — adding routes invalidates `openapi.json`. Mitigation: regenerate
   with `npm run openapi:export`.
3. **Coverage thresholds** — a new module with no tests drags the global threshold down.
   Mitigation: unit tests for the new pure logic (state machine, variable interpolation,
   automation evaluation, consent gate, analytics bucketing).
4. **Dual-dialect SQL** — every new migration needs a Postgres _and_ a SQLite branch.
5. **Module cycles** — `command-center` needs `MessageService` for sending; resolve the
   `PLUGIN_MESSAGE_PORT` token lazily via `ModuleRef` (the established pattern) rather than
   importing `MessageModule`.
6. **AI provider coupling** — must stay behind an interface with a working offline fallback so a
   missing API key never breaks the inbox.
