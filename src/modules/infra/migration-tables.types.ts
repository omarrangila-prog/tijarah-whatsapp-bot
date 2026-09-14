// Database migration types for export/import
export interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  config: string | Record<string, unknown>;
  proxyUrl: string | null;
  proxyType: string | null;
  connectedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookRow {
  id: string;
  sessionId: string;
  url: string;
  events: string | string[];
  // Credentials. export-data omits both (see exportData), so an exported row may not carry them;
  // the importer restores them as null/{} in that case.
  secret?: string | null;
  headers?: string | Record<string, string>;
  filters: string | Record<string, unknown> | null;
  active: boolean | number;
  retryCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shapes mirror the REAL table columns as returned by `SELECT *` (export-data), not the
// camelCase TypeORM entity properties. `messages` columns are the property names; `message_batches`
// columns are snake_case (the entity maps them via `name:`). Keeping these accurate is what keeps
// the import column lists below from drifting back into "no such column" failures.
export interface MessageRow {
  id: string;
  sessionId: string;
  waMessageId: string | null;
  chatId: string;
  chatName: string | null;
  /** Group participant JID (nullable; added to messages after chatName — keep the import list in sync). */
  author: string | null;
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  timestamp: number | string | null;
  metadata: string | Record<string, unknown> | null;
  status: string;
  createdAt: string;
  /**
   * Chat-media archive pointers (nullable; added after author — keep the import list in sync).
   * Dropping these on import would leave the archived FILES restored but unreferenced, and the
   * orphan sweep would then delete them after its grace window.
   */
  mediaPath: string | null;
  mediaMimetype: string | null;
  /**
   * Postgres-only STORED generated tsvector (FTS). Present in `SELECT *` rows read from a Postgres
   * source (and in backups made before it was stripped) but never a real payload column: export drops
   * it, and the import's explicit column list ignores it. Declared so both directions type-check.
   */
  body_ts?: unknown;
}

export interface MessageBatchRow {
  id: string;
  batch_id: string;
  session_id: string;
  status: string;
  messages: string | unknown[];
  options: string | Record<string, unknown> | null;
  progress: string | Record<string, unknown> | null;
  results: string | unknown[] | null;
  current_index: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// templates + baileys_stored_messages both FK sessions ON DELETE CASCADE, so import's
// `DELETE FROM sessions` wipes them; they must be exported and re-inserted or the documented
// backup flow loses them permanently.
export interface TemplateRow {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BaileysStoredMessageRow {
  id: string;
  sessionId: string;
  waMessageId: string;
  serializedMessage: string;
  createdAt: string;
}

// The persisted lid->phone resolution cache. Not a FK to sessions (provenance only), so the import's
// `DELETE FROM sessions` never clears it — it must be exported + re-inserted explicitly or a
// backup→restore into a fresh DB loses the whole cache (it self-heals via re-lookup, but lossily).
export interface LidMappingRow {
  lid: string;
  phone: string | null;
  sessionId: string | null;
  updatedAt: string;
}

export interface PluginInstanceRow {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string;
  verifyToken: string | null;
  config: string | Record<string, unknown> | null;
  enabled: boolean | number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMappingRow {
  id: string;
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
  providerConversationId: string;
  handoverState: string;
  metadata: string | Record<string, unknown> | null;
  updatedAt: string;
}

export interface IngressEventRow {
  id: string;
  instanceId: string;
  pluginId: string;
  providerDeliveryId: string;
  route: string;
  // Retired to NULL once the dispatch outcome is recorded; only 'pending' rows still carry one.
  payload: string | Record<string, unknown> | null;
  payloadHash?: string | null;
  // Dispatch lifecycle (the AddIngressEventDispatchState migration). A restored 'pending' row must
  // keep these or the reconciler never replays it while the dedup row still blocks the provider's
  // retry. Optional because backups exported before the columns existed don't carry them.
  dispatchState?: 'pending' | 'dispatched' | 'failed' | null;
  dispatchAttempts?: number;
  lastDispatchAt?: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface WebhookDeliveryFailureRow {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  url: string;
  idempotencyKey: string | null;
  deliveryId: string | null;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string;
  createdAt: string;
}

export interface WebhookOutboxEventRow {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  idempotencyKey: string;
  deliveryId: string;
  payload: string | null;
  state: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  createdAt: string;
}

export interface IntegrationDeliveryFailureRow {
  id: string;
  direction: string;
  pluginId: string;
  instanceId: string;
  sessionId: string | null;
  deliveryId: string | null;
  attempts: number;
  lastError: string;
  payload: string | Record<string, unknown> | null;
  redriven: boolean | number;
  createdAt: string;
}

// status_updates has no FK to sessions (plain columns), so the import's `DELETE FROM sessions` never
// clears it — it must be exported + re-inserted explicitly like lid_mappings. postedAt/expiresAt are
// bigint epoch-ms: raw queries bypass the entity transformer, so Postgres returns them as strings.
export interface StatusUpdateRow {
  id: string;
  sessionId: string;
  contactJid: string;
  contactName: string | null;
  contactPushName: string | null;
  waStatusId: string;
  type: string;
  caption: string | null;
  mediaPath: string | null;
  mediaMimetype: string | null;
  mediaOmitted: boolean | number;
  omitReason: string | null;
  backgroundColor: string | null;
  font: number | null;
  postedAt: number | string;
  expiresAt: number | string;
}

/**
 * automation_rules has an ON DELETE CASCADE FK to sessions, so the import's `DELETE FROM sessions`
 * takes every rule with it — on SQLite too, where better-sqlite3 enforces foreign keys. Exporting
 * and re-inserting it is therefore not optional: without it a backup/restore silently destroys
 * every autoreply rule. `conditions` is stored as text (the webhook-filter JSON), `enabled` reads
 * back as a boolean on Postgres and 0/1 on SQLite.
 */
export interface AutomationRuleRow {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean | number;
  conditions: string | null;
  replyText: string;
  cooldownSeconds: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

// ---------- WA Command Center ----------
//
// The business layer over the WhatsApp data. Every one of these tables must survive a database
// migration: `cc_conversations` could in principle be rebuilt from `messages`, but notes, customer
// profiles, consent records, tags, agents, teams, automation flows and campaigns cannot be derived
// from anything — excluding them from a backup would destroy them silently on a DB switch.
//
// The shapes mirror the entities; boolean columns are typed `boolean | number` because SQLite reads
// them back as 0/1 while Postgres returns real booleans, and a backup round-trips whichever it got.

export interface CcAgentRow {
  id: string;
  name: string;
  email: string | null;
  apiKeyId: string | null;
  role: string;
  color: string;
  active: boolean | number;
  lastSeenAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcTeamRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcTeamMemberRow {
  id: string;
  teamId: string;
  agentId: string;
  teamRole: string;
  createdAt: string | Date;
}

export interface CcConversationRow {
  id: string;
  sessionId: string;
  chatId: string;
  chatName: string | null;
  kind: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  teamId: string | null;
  starred: boolean | number;
  muted: boolean | number;
  lastMessageAt: string | Date | null;
  lastMessagePreview: string | null;
  lastMessageType: string | null;
  lastMessageDirection: string | null;
  unreadCount: number;
  manualUnread: boolean | number;
  firstInboundAt: string | Date | null;
  firstResponseAt: string | Date | null;
  pendingSince: string | Date | null;
  resolvedAt: string | Date | null;
  lastReadAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcConversationNoteRow {
  id: string;
  conversationId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcAssignmentHistoryRow {
  id: string;
  conversationId: string;
  action: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  teamId: string | null;
  actor: string | null;
  reason: string | null;
  createdAt: string | Date;
}

export interface CcTagRow {
  id: string;
  name: string;
  color: string;
  createdAt: string | Date;
}

export interface CcConversationTagRow {
  id: string;
  conversationId: string;
  tagId: string;
  createdAt: string | Date;
}

export interface CcCustomerProfileRow {
  id: string;
  waId: string;
  phone: string | null;
  displayName: string | null;
  company: string | null;
  email: string | null;
  source: string | null;
  customerType: string | null;
  city: string | null;
  customFields: string | null;
  firstInteractionAt: string | Date | null;
  lastInteractionAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcContactConsentRow {
  id: string;
  waId: string;
  status: string;
  source: string | null;
  optedInAt: string | Date | null;
  optedOutAt: string | Date | null;
  recordedBy: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcQuickReplyRow {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  folder: string;
  useCount: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcWorkspaceSettingsRow {
  id: string;
  routingStrategy: string;
  routingTeamId: string | null;
  routeToOnlineOnly: boolean | number;
  maxOpenPerAgent: number;
  presenceTimeoutMinutes: number;
  privateAssignedChats: boolean | number;
  updatedAt: string | Date;
}

export interface CcFollowUpRow {
  id: string;
  conversationId: string | null;
  assigneeId: string | null;
  title: string;
  notes: string | null;
  dueAt: string | Date;
  status: string;
  createdVia: string;
  completedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcAiInsightRow {
  id: string;
  conversationId: string;
  summary: string | null;
  intent: string | null;
  sentiment: string | null;
  language: string | null;
  keyPoints: string | null;
  extracted: string | null;
  suggestedReply: string | null;
  nextBestAction: string | null;
  provider: string;
  model: string | null;
  messageCountAtAnalysis: number;
  createdAt: string | Date;
}

export interface CcAutomationFlowRow {
  id: string;
  name: string;
  description: string | null;
  sessionId: string | null;
  trigger: string;
  triggerAfterMinutes: number | null;
  conditions: string | null;
  actions: string;
  enabled: boolean | number;
  cooldownSeconds: number;
  executionCount: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcAutomationExecutionRow {
  id: string;
  flowId: string;
  flowName: string | null;
  conversationId: string | null;
  sessionId: string | null;
  chatId: string | null;
  outcome: string;
  reason: string | null;
  actionResults: string | null;
  createdAt: string | Date;
}

export interface CcScheduledMessageRow {
  id: string;
  sessionId: string;
  chatId: string;
  body: string;
  runAt: string | Date;
  status: string;
  error: string | null;
  createdBy: string | null;
  sentAt: string | Date | null;
  createdAt: string | Date;
}

export interface CcBroadcastRow {
  id: string;
  name: string;
  sessionId: string;
  body: string;
  audience: string | null;
  status: string;
  throttleMs: number;
  scheduledAt: string | Date | null;
  approvedBy: string | null;
  approvedAt: string | Date | null;
  startedAt: string | Date | null;
  completedAt: string | Date | null;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CcBroadcastRecipientRow {
  id: string;
  broadcastId: string;
  waId: string;
  name: string | null;
  status: string;
  waMessageId: string | null;
  error: string | null;
  sentAt: string | Date | null;
  createdAt: string | Date;
}

export interface MigrationTables {
  sessions: SessionRow[];
  webhooks: WebhookRow[];
  messages: MessageRow[];
  messageBatches: MessageBatchRow[];
  templates: TemplateRow[];
  baileysStoredMessages: BaileysStoredMessageRow[];
  lidMappings: LidMappingRow[];
  pluginInstances: PluginInstanceRow[];
  conversationMappings: ConversationMappingRow[];
  ingressEvents: IngressEventRow[];
  webhookDeliveryFailures: WebhookDeliveryFailureRow[];
  webhookOutboxEvents: WebhookOutboxEventRow[];
  integrationDeliveryFailures: IntegrationDeliveryFailureRow[];
  statusUpdates: StatusUpdateRow[];
  automationRules: AutomationRuleRow[];
  ccAgents: CcAgentRow[];
  ccTeams: CcTeamRow[];
  ccTeamMembers: CcTeamMemberRow[];
  ccConversations: CcConversationRow[];
  ccConversationNotes: CcConversationNoteRow[];
  ccAssignmentHistory: CcAssignmentHistoryRow[];
  ccTags: CcTagRow[];
  ccConversationTags: CcConversationTagRow[];
  ccCustomerProfiles: CcCustomerProfileRow[];
  ccContactConsent: CcContactConsentRow[];
  ccQuickReplies: CcQuickReplyRow[];
  ccFollowUps: CcFollowUpRow[];
  ccAiInsights: CcAiInsightRow[];
  ccAutomationFlows: CcAutomationFlowRow[];
  ccAutomationExecutions: CcAutomationExecutionRow[];
  ccScheduledMessages: CcScheduledMessageRow[];
  ccBroadcasts: CcBroadcastRow[];
  ccBroadcastRecipients: CcBroadcastRecipientRow[];
  ccWorkspaceSettings: CcWorkspaceSettingsRow[];
}

export type TableCounts = { [K in keyof MigrationTables]: number };
