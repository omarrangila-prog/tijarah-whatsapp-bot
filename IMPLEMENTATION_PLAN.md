# IMPLEMENTATION_PLAN.md — WA Command Center

Derived from `ARCHITECTURE_FOUND.md`. Every item extends the existing OpenWA architecture;
nothing in the engine, session-lifecycle, auth, webhook or media layers is rewritten.

Priority key — **P0** = hackathon-critical (must work end to end), **P1** = complete the product
story, **P2** = polish / breadth.

---

## P0 — Foundation + Unified Inbox

### P0.1 Data model (one migration, `data` connection)

| Table                                       | Purpose                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `cc_agents`                                 | A human operator. Optional link to an `api_keys.id` so the caller resolves to "me". |
| `cc_teams`                                  | Named team (Sales, Support…) with a colour.                                         |
| `cc_team_members`                           | agent ↔ team, with a role in the team.                                              |
| `cc_conversations`                          | **(sessionId, chatId)** business state + denormalized inbox index.                  |
| `cc_conversation_notes`                     | Internal notes. Never sent to WhatsApp.                                             |
| `cc_assignment_history`                     | Every assign/unassign/claim with actor + reason.                                    |
| `cc_tags`                                   | Org-level tag vocabulary (name, colour).                                            |
| `cc_conversation_tags`                      | conversation ↔ tag.                                                                 |
| `cc_customer_profiles`                      | CRM record keyed by normalized WhatsApp id.                                         |
| `cc_contact_consent`                        | Opt-in state, source, timestamps — the broadcast gate.                              |
| `cc_quick_replies`                          | Shortcut (`/price`), folder, body with `{{variables}}`.                             |
| `cc_follow_ups`                             | Task with due date, linked to conversation + agent.                                 |
| `cc_ai_summaries`                           | Cached AI analysis per conversation, with provider + model recorded.                |
| `cc_automation_flows`                       | WHEN → IF → THEN rules (JSON trigger/conditions/actions).                           |
| `cc_automation_executions`                  | Execution log: flow, conversation, matched, actions, error.                         |
| `cc_scheduled_messages`                     | Send-later queue.                                                                   |
| `cc_broadcasts` / `cc_broadcast_recipients` | Campaign + per-recipient state.                                                     |

Indexes: `(sessionId, chatId)` unique on conversations, plus
`(sessionId, lastMessageAt)`, `(status)`, `(assigneeId)`, `(priority)`,
`(conversationId)` on children, `(waId)` unique on profiles/consent,
`(shortcut)` on quick replies, `(dueAt, status)` on follow-ups,
`(runAt, status)` on scheduled messages.

### P0.2 Services

- `ConversationService` — list (filters + search + pagination), get, ensure, record inbound/outbound,
  markRead/unread, status transitions, priority, assign/claim/unassign, star, mute, resolve/reopen.
- `ConversationRecorder` — the projector-facing, fire-and-forget recording surface.
- `NoteService`, `TagService`, `TeamService`, `AgentService`, `CustomerProfileService`.

### P0.3 API routes

Session-dimensioned where the resource is: `sessions/:sessionId/conversations/...`.
Cross-session inbox and org-level resources get `@RequireUnscopedKey()` **or** explicit
key-scope filtering with an allowlist entry + reason (matching `session.controller.ts :: findAll`).

### P0.4 Realtime

Add `conversation.updated` and `conversation.note` to `SUBSCRIBABLE_EVENTS` with matching
`emitConversationUpdated` / `emitConversationNote` producers on `EventsGateway`
(the drift guard requires the pair).

### P0.5 Frontend foundation

- `services/api.ts` — new `conversationApi, teamApi, agentApi, quickReplyApi, profileApi,
aiApi, analyticsApi, automationApi, broadcastApi, followUpApi` namespaces.
- `hooks/queries.ts` — query keys + hooks in the existing TanStack style.
- New sidebar (`Layout.tsx`) with the 11 primary + 4 admin sections.
- Design layer: extend `App.css` tokens with a command-center surface/elevation scale.

### P0.6 Unified Inbox (the centrepiece)

Four columns: filter rail → conversation list → chat → customer panel.
Realtime through the existing `/events` socket, multi-session subscribe (`*` or per-session
fallback when the key is scoped). Composer with attachments, reply-to, `/` quick-reply picker,
emoji, schedule, and an AI panel. Notes tab that cannot send to WhatsApp.

---

## P1 — Business features + AI + Automation + Analytics

- **P1.1 Team inbox** — assignment UI, claim, reassign, team routing, assignment history timeline.
- **P1.2 Contacts / Customer 360** — searchable list, detail page, custom fields, consent toggle,
  conversation history, notes.
- **P1.3 Quick replies** — CRUD + folders + variable interpolation (`{{name}}`, `{{phone}}`,
  `{{agent_name}}`), `/` picker in the composer.
- **P1.4 AI Copilot** — `AiProviderRegistry` with `anthropic`, `openai-compatible`, and a
  deterministic offline `heuristic` provider. Endpoints: analyze, suggest-reply, rewrite,
  shorten, translate, extract. **Never auto-sends**; output lands in the composer for approval.
- **P1.5 Automation builder** — flows with triggers/conditions/actions, cooldown + loop guards,
  execution log, and a visual WHEN/IF/THEN editor.
- **P1.6 Overview + Analytics** — KPIs, charts (recharts, already a dependency), agent workload,
  peak hours, first-response/resolution times computed from the timestamps P0 persists.
- **P1.7 WhatsApp Numbers** — session cards with health, uptime, messages today, QR modal,
  connect/disconnect/restart/logout (reusing existing session endpoints).

---

## P2 — Breadth

- **P2.1 Broadcasts** — draft → audience → message → preview → rate/schedule → approval → send →
  analytics. Consent-gated (opted-in only), conservative pacing, pause/cancel, failed recipients.
- **P2.2 Scheduled messages** — queue + worker tick + cancel.
- **P2.3 Follow-ups** — create from conversation/AI, due list, complete.
- **P2.4 Activity** — audit stream view over the existing `/audit` API.
- **P2.5 Settings / Webhooks / API Keys / Infrastructure / Integrations** — rehomed under the new
  navigation, existing pages preserved.

---

## Sequencing

1. Migration + entities + module skeleton (P0.1)
2. Services + controllers + realtime producers (P0.2–P0.4)
3. Projector recording hook + backfill (P0.2)
4. API client + hooks + shell/navigation (P0.5)
5. Inbox (P0.6)
6. Customer panel, notes, assignment, quick replies (P1.1–P1.3)
7. AI copilot (P1.4)
8. Automation builder (P1.5)
9. Overview + Analytics (P1.6), Numbers (P1.7)
10. Broadcasts, scheduling, follow-ups, activity (P2)
11. QA: lint, jest, tsc, dashboard build, OpenAPI re-export

## Definition of done

- `npm run build:all` succeeds; `npx tsc --noEmit` clean on both sides.
- `npm test` green (new unit tests for the new pure logic).
- No dead controls: every button in the new UI calls a real endpoint.
- Loading / empty / error states on every new surface.
- Existing pages and endpoints still work.
