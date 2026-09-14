// WA Command Center API client.
//
// Kept beside services/api.ts rather than inside it: the OpenWA gateway surface and the
// command-center business surface are different products with different vocabularies, and one
// 2000-line module would obscure both. Auth, base URL and error mapping are NOT duplicated — the
// `request` helper is imported from api.ts, so a 401 behaves identically wherever it comes from.

import { request } from './api';

// =============================================================================
// Types
// =============================================================================

export type ConversationStatus = 'open' | 'waiting' | 'resolved';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  sessionId: string;
  chatId: string;
  chatName: string | null;
  kind: string;
  status: ConversationStatus;
  priority: ConversationPriority;
  assigneeId: string | null;
  teamId: string | null;
  starred: boolean;
  muted: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageType: string | null;
  lastMessageDirection: 'incoming' | 'outgoing' | null;
  unreadCount: number;
  manualUnread: boolean;
  firstInboundAt: string | null;
  firstResponseAt: string | null;
  pendingSince: string | null;
  resolvedAt: string | null;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
}

export interface ConversationPage {
  conversations: Conversation[];
  total: number;
}

export interface ConversationFilters {
  sessionIds?: string[];
  status?: ConversationStatus;
  priority?: ConversationPriority;
  /** An agent id, `unassigned`, or `me` — the server resolves `me` against the calling key. */
  assigneeId?: string;
  teamId?: string;
  tagIds?: string[];
  unreadOnly?: boolean;
  starredOnly?: boolean;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ConversationNote {
  id: string;
  conversationId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentHistoryEntry {
  id: string;
  conversationId: string;
  action: 'assigned' | 'reassigned' | 'unassigned' | 'claimed' | 'team_assigned';
  fromAgentId: string | null;
  toAgentId: string | null;
  teamId: string | null;
  actor: string | null;
  reason: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  email: string | null;
  apiKeyId: string | null;
  role: 'admin' | 'operator' | 'viewer';
  color: string;
  active: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemberView {
  agentId: string;
  name: string;
  color: string;
  teamRole: string;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  color: string;
  members: TeamMemberView[];
  createdAt: string;
  updatedAt: string;
}

export interface CurrentActor {
  agent: Agent | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  role: 'admin' | 'operator' | 'viewer' | null;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  folder: string;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RenderedQuickReply {
  reply: QuickReply;
  text: string;
  /** Placeholders the conversation could not fill — shown so the agent edits before sending. */
  unresolved: string[];
}

export type ConsentStatus = 'unknown' | 'opted_in' | 'opted_out';

export interface ContactConsent {
  id: string;
  waId: string;
  status: ConsentStatus;
  source: string | null;
  optedInAt: string | null;
  optedOutAt: string | null;
  recordedBy: string | null;
}

export interface Customer {
  id: string;
  waId: string;
  phone: string | null;
  displayName: string | null;
  company: string | null;
  email: string | null;
  source: string | null;
  customerType: string | null;
  city: string | null;
  customFields: Record<string, string> | null;
  firstInteractionAt: string | null;
  lastInteractionAt: string | null;
  consent: ContactConsent | null;
  sessionIds: string[];
  conversationIds: string[];
  messageCount: number;
}

export interface AiAnalysis {
  summary: string;
  intent: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  language: string;
  keyPoints: string[];
  extracted: Record<string, string>;
  suggestedReply: string;
  nextBestAction: string;
  provider: string;
  model: string | null;
  cached: boolean;
  generatedAt: string;
}

/** What an agent taking a conversation over is told before they type. */
export interface HandoffBrief {
  situation: string;
  /** Commitments our side already made. Never invented — empty when nothing was promised. */
  promised: string[];
  tone: string;
  openQuestions: string[];
  watchOut: string;
  nextMessage: string;
  provider: string;
  model: string | null;
}

export interface AiStatus {
  provider: string;
  model: string | null;
  /** True when only the offline provider is available — the UI must say so, not imply a model. */
  degraded: boolean;
}

export type FlowTrigger = 'message_received' | 'conversation_created' | 'label_added' | 'conversation_unresolved';

export interface FlowCondition {
  field:
    | 'body'
    | 'sessionId'
    | 'chatKind'
    | 'contactTag'
    | 'businessHours'
    | 'conversationStatus'
    | 'conversationPriority';
  operator: 'contains' | 'equals' | 'startsWith' | 'notContains' | 'is' | 'isNot';
  value: string;
  caseSensitive?: boolean;
}

export interface FlowAction {
  type:
    | 'send_reply'
    | 'add_tag'
    | 'remove_tag'
    | 'assign_agent'
    | 'assign_team'
    | 'set_priority'
    | 'set_status'
    | 'create_follow_up'
    | 'webhook';
  value?: string;
  quickReplyId?: string;
  dueInMinutes?: number;
  url?: string;
}

export interface AutomationFlow {
  id: string;
  name: string;
  description: string | null;
  sessionId: string | null;
  trigger: FlowTrigger;
  triggerAfterMinutes: number | null;
  conditions: FlowCondition[] | null;
  actions: FlowAction[];
  enabled: boolean;
  cooldownSeconds: number;
  executionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationExecution {
  id: string;
  flowId: string;
  flowName: string | null;
  conversationId: string | null;
  sessionId: string | null;
  chatId: string | null;
  outcome: 'matched' | 'skipped' | 'failed';
  reason: string | null;
  actionResults: Array<{ type: string; ok: boolean; detail?: string }> | null;
  createdAt: string;
}

export type BroadcastStatus =
  | 'draft'
  | 'pending_approval'
  | 'scheduled'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'cancelled';

export interface BroadcastAudience {
  tagIds?: string[];
  customerType?: string | null;
  city?: string | null;
  sessionIds?: string[];
}

export interface Broadcast {
  id: string;
  name: string;
  sessionId: string;
  body: string;
  audience: BroadcastAudience | null;
  status: BroadcastStatus;
  throttleMs: number;
  scheduledAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastRecipient {
  id: string;
  broadcastId: string;
  waId: string;
  name: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
  waMessageId: string | null;
  error: string | null;
  sentAt: string | null;
}

export interface AudiencePreview {
  matched: number;
  optedIn: number;
  excludedNoConsent: number;
  sample: Array<{ waId: string; name: string | null }>;
}

export interface FollowUp {
  id: string;
  conversationId: string | null;
  assigneeId: string | null;
  title: string;
  notes: string | null;
  dueAt: string;
  status: 'pending' | 'done' | 'cancelled';
  createdVia: string;
  completedAt: string | null;
  createdAt: string;
}

export interface ScheduledMessage {
  id: string;
  sessionId: string;
  chatId: string;
  body: string;
  runAt: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  error: string | null;
  createdBy: string | null;
  sentAt: string | null;
  createdAt: string;
}

// ── Live presence & work routing ─────────────────────────────────────

export interface AgentPresence {
  agentId: string;
  name: string;
  color: string;
  /** Epoch ms of the agent's last heartbeat. */
  lastSeen: number;
  /** The conversation they currently have open, when they have one. */
  viewingConversationId: string | null;
  typing: boolean;
}

/** Another agent looking at the same conversation as you. */
export interface ConversationViewer {
  agentId: string;
  name: string;
  color: string;
  typing: boolean;
}

export interface HeartbeatResult {
  agent: Agent | null;
  online: AgentPresence[];
  /** Everyone ELSE viewing the conversation you reported having open. */
  viewers: ConversationViewer[];
}

export type RoutingStrategy = 'manual' | 'round_robin' | 'least_busy';

export interface RoutingSettings {
  id: string;
  routingStrategy: RoutingStrategy;
  routingTeamId: string | null;
  routeToOnlineOnly: boolean;
  /** 0 = no ceiling. */
  maxOpenPerAgent: number;
  /** When on, agents see only their own conversations plus the unassigned queue. Admins see all. */
  privateAssignedChats: boolean;
  presenceTimeoutMinutes: number;
  updatedAt: string;
}

export type AnalyticsRange = 'today' | '7d' | '30d' | 'custom';

export interface Analytics {
  window: { from: string; to: string; granularity: 'hour' | 'day' };
  kpis: {
    connectedNumbers: number;
    totalNumbers: number;
    messages: number;
    inbound: number;
    outbound: number;
    failed: number;
    newConversations: number;
    unread: number;
    open: number;
    waiting: number;
    resolved: number;
    newContacts: number;
    avgFirstResponseMinutes: number | null;
    avgResolutionMinutes: number | null;
    /** How many conversations each average is drawn from — an average of 2 is not a trend. */
    firstResponseSample: number;
    resolutionSample: number;
  };
  timeSeries: Array<{ bucket: string; inbound: number; outbound: number }>;
  byStatus: Array<{ status: string; count: number }>;
  busiestHours: Array<{ hour: number; count: number }>;
  topSessions: Array<{ sessionId: string; name: string | null; inbound: number; outbound: number }>;
  agentWorkload: Array<{ agentId: string | null; name: string; open: number; resolved: number; color: string }>;
  peakHour: number | null;
}

// =============================================================================
// Helpers
// =============================================================================

/** Build a query string, dropping empties and joining arrays the way the DTOs expect. */
function toQuery(params: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      query.set(key, value.join(','));
    } else {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

// =============================================================================
// Conversations
// =============================================================================

export const conversationApi = {
  list: (filters: ConversationFilters = {}) => request<ConversationPage>(`/conversations${toQuery(filters)}`),
  get: (id: string) => request<Conversation>(`/conversations/${id}`),
  markRead: (id: string) => request<Conversation>(`/conversations/${id}/read`, { method: 'POST' }),
  markUnread: (id: string) => request<Conversation>(`/conversations/${id}/unread`, { method: 'POST' }),
  setStatus: (id: string, status: ConversationStatus) =>
    request<Conversation>(`/conversations/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  setPriority: (id: string, priority: ConversationPriority) =>
    request<Conversation>(`/conversations/${id}/priority`, { method: 'PATCH', body: JSON.stringify({ priority }) }),
  setFlags: (id: string, flags: { starred?: boolean; muted?: boolean }) =>
    request<Conversation>(`/conversations/${id}/flags`, { method: 'PATCH', body: JSON.stringify(flags) }),
  assign: (id: string, body: { agentId?: string | null; teamId?: string | null; reason?: string }) =>
    request<Conversation>(`/conversations/${id}/assign`, { method: 'POST', body: JSON.stringify(body) }),
  claim: (id: string) => request<Conversation>(`/conversations/${id}/claim`, { method: 'POST' }),
  /** Hand the conversation to another agent, carrying a note across with it. */
  transfer: (id: string, body: { toAgentId: string; toTeamId?: string | null; note?: string }) =>
    request<Conversation>(`/conversations/${id}/transfer`, { method: 'POST', body: JSON.stringify(body) }),
  assignmentHistory: (id: string) => request<AssignmentHistoryEntry[]>(`/conversations/${id}/assignment-history`),
  listNotes: (id: string) => request<ConversationNote[]>(`/conversations/${id}/notes`),
  addNote: (id: string, body: string) =>
    request<ConversationNote>(`/conversations/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  updateNote: (id: string, noteId: string, body: string) =>
    request<ConversationNote>(`/conversations/${id}/notes/${noteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    }),
  deleteNote: (id: string, noteId: string) =>
    request<{ success: boolean }>(`/conversations/${id}/notes/${noteId}`, { method: 'DELETE' }),
  addTag: (id: string, tagId: string) =>
    request<Conversation>(`/conversations/${id}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) }),
  removeTag: (id: string, tagId: string) =>
    request<Conversation>(`/conversations/${id}/tags/${tagId}`, { method: 'DELETE' }),
};

// =============================================================================
// Workspace: agents, teams, tags, quick replies, follow-ups, scheduled messages
// =============================================================================

export const workspaceApi = {
  me: () => request<CurrentActor>('/workspace/me'),

  listAgents: () => request<Agent[]>('/workspace/agents'),
  createAgent: (body: Partial<Agent>) =>
    request<Agent>('/workspace/agents', { method: 'POST', body: JSON.stringify(body) }),
  updateAgent: (id: string, body: Partial<Agent>) =>
    request<Agent>(`/workspace/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAgent: (id: string) => request<{ success: boolean }>(`/workspace/agents/${id}`, { method: 'DELETE' }),

  listTeams: () => request<Team[]>('/workspace/teams'),
  createTeam: (body: { name: string; description?: string; color?: string }) =>
    request<Team>('/workspace/teams', { method: 'POST', body: JSON.stringify(body) }),
  updateTeam: (id: string, body: { name?: string; description?: string; color?: string }) =>
    request<Team>(`/workspace/teams/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTeam: (id: string) => request<{ success: boolean }>(`/workspace/teams/${id}`, { method: 'DELETE' }),
  addTeamMember: (teamId: string, agentId: string, teamRole: 'lead' | 'member' = 'member') =>
    request<unknown>(`/workspace/teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify({ agentId, teamRole }),
    }),
  removeTeamMember: (teamId: string, agentId: string) =>
    request<{ success: boolean }>(`/workspace/teams/${teamId}/members/${agentId}`, { method: 'DELETE' }),

  listTags: () => request<Tag[]>('/workspace/tags'),
  createTag: (body: { name: string; color?: string }) =>
    request<Tag>('/workspace/tags', { method: 'POST', body: JSON.stringify(body) }),
  updateTag: (id: string, body: { name?: string; color?: string }) =>
    request<Tag>(`/workspace/tags/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTag: (id: string) => request<{ success: boolean }>(`/workspace/tags/${id}`, { method: 'DELETE' }),

  listQuickReplies: (folder?: string) => request<QuickReply[]>(`/workspace/quick-replies${toQuery({ folder })}`),
  quickReplyFolders: () => request<string[]>('/workspace/quick-replies/folders'),
  createQuickReply: (body: { shortcut: string; title: string; body: string; folder?: string }) =>
    request<QuickReply>('/workspace/quick-replies', { method: 'POST', body: JSON.stringify(body) }),
  updateQuickReply: (id: string, body: Partial<{ shortcut: string; title: string; body: string; folder: string }>) =>
    request<QuickReply>(`/workspace/quick-replies/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteQuickReply: (id: string) =>
    request<{ success: boolean }>(`/workspace/quick-replies/${id}`, { method: 'DELETE' }),
  seedQuickReplies: () => request<{ created: number }>('/workspace/quick-replies/seed-defaults', { method: 'POST' }),
  renderQuickReply: (id: string, conversationId?: string) =>
    request<RenderedQuickReply>(`/workspace/quick-replies/${id}/render`, {
      method: 'POST',
      body: JSON.stringify({ conversationId }),
    }),

  listFollowUps: (filters: { status?: string; assigneeId?: string; conversationId?: string } = {}) =>
    request<FollowUp[]>(`/workspace/follow-ups${toQuery(filters)}`),
  createFollowUp: (body: {
    conversationId?: string;
    assigneeId?: string;
    title: string;
    notes?: string;
    dueAt: string;
  }) => request<FollowUp>('/workspace/follow-ups', { method: 'POST', body: JSON.stringify(body) }),
  updateFollowUp: (id: string, status: 'pending' | 'done' | 'cancelled') =>
    request<FollowUp>(`/workspace/follow-ups/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  deleteFollowUp: (id: string) => request<{ success: boolean }>(`/workspace/follow-ups/${id}`, { method: 'DELETE' }),

  /**
   * One call carries both "I am here" and "this is what I have open", because the two always change
   * together — and it answers with the roster plus the other viewers of that conversation, so a
   * single round trip keeps both the presence strip and the collision warning current.
   */
  heartbeat: (body: { viewingConversationId?: string | null; typing?: boolean }) =>
    request<HeartbeatResult>('/workspace/presence/heartbeat', { method: 'POST', body: JSON.stringify(body) }),
  leavePresence: () => request<{ success: boolean }>('/workspace/presence/leave', { method: 'POST' }),
  presenceRoster: () => request<{ online: AgentPresence[] }>('/workspace/presence'),

  getRouting: () => request<RoutingSettings>('/workspace/routing'),
  /** Share the conversations already waiting out across agents, using the current strategy. */
  distributeQueue: (limit?: number) =>
    request<{ assigned: number; skipped: number; reason: string | null }>('/workspace/routing/distribute', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  updateRouting: (body: Partial<RoutingSettings>) =>
    request<RoutingSettings>('/workspace/routing', { method: 'PATCH', body: JSON.stringify(body) }),

  listScheduledMessages: (filters: { sessionId?: string; status?: string } = {}) =>
    request<ScheduledMessage[]>(`/workspace/scheduled-messages${toQuery(filters)}`),
  scheduleMessage: (body: { sessionId: string; chatId: string; body: string; runAt: string }) =>
    request<ScheduledMessage>('/workspace/scheduled-messages', { method: 'POST', body: JSON.stringify(body) }),
  cancelScheduledMessage: (id: string) =>
    request<ScheduledMessage>(`/workspace/scheduled-messages/${id}`, { method: 'DELETE' }),
};

// =============================================================================
// Customers
// =============================================================================

export const customerApi = {
  list: (filters: { search?: string; customerType?: string; consent?: ConsentStatus; limit?: number; offset?: number } = {}) =>
    request<{ customers: Customer[]; total: number }>(`/customers${toQuery(filters)}`),
  get: (waId: string) => request<Customer>(`/customers/${encodeURIComponent(waId)}`),
  update: (waId: string, body: Partial<Customer>) =>
    request<Customer>(`/customers/${encodeURIComponent(waId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setConsent: (waId: string, status: ConsentStatus, source?: string) =>
    request<ContactConsent>(`/customers/${encodeURIComponent(waId)}/consent`, {
      method: 'POST',
      body: JSON.stringify({ status, source }),
    }),
};

// =============================================================================
// AI copilot — every call returns text for a human to approve; none of them send
// =============================================================================

export const aiApi = {
  status: () => request<AiStatus>('/ai/status'),
  analyze: (conversationId: string, force = false) =>
    request<AiAnalysis>(`/ai/conversations/${conversationId}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  suggestReply: (conversationId: string, instruction?: string) =>
    request<{ text: string; provider: string }>(`/ai/conversations/${conversationId}/suggest-reply`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    }),
  /** Brief the incoming agent on a conversation being handed to them. Never cached. */
  handoffBrief: (conversationId: string) =>
    request<HandoffBrief>(`/ai/conversations/${conversationId}/handoff-brief`, { method: 'POST' }),
  rewrite: (text: string) =>
    request<{ text: string; provider: string }>('/ai/rewrite', { method: 'POST', body: JSON.stringify({ text }) }),
  shorten: (text: string) =>
    request<{ text: string; provider: string }>('/ai/shorten', { method: 'POST', body: JSON.stringify({ text }) }),
  translate: (text: string, targetLanguage: string) =>
    request<{ text: string; provider: string }>('/ai/translate', {
      method: 'POST',
      body: JSON.stringify({ text, targetLanguage }),
    }),
};

// =============================================================================
// Automation flows
// =============================================================================

export const automationApi = {
  list: (sessionId?: string) => request<AutomationFlow[]>(`/automation-flows${toQuery({ sessionId })}`),
  get: (id: string) => request<AutomationFlow>(`/automation-flows/${id}`),
  create: (body: Partial<AutomationFlow>) =>
    request<AutomationFlow>('/automation-flows', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<AutomationFlow>) =>
    request<AutomationFlow>(`/automation-flows/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => request<{ success: boolean }>(`/automation-flows/${id}`, { method: 'DELETE' }),
  executions: (filters: { flowId?: string; limit?: number } = {}) =>
    request<AutomationExecution[]>(`/automation-flows/executions${toQuery(filters)}`),
};

// =============================================================================
// Broadcasts
// =============================================================================

export const broadcastApi = {
  list: () => request<Broadcast[]>('/broadcasts'),
  get: (id: string) => request<Broadcast>(`/broadcasts/${id}`),
  create: (body: Partial<Broadcast>) =>
    request<Broadcast>('/broadcasts', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Broadcast>) =>
    request<Broadcast>(`/broadcasts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => request<{ success: boolean }>(`/broadcasts/${id}`, { method: 'DELETE' }),
  previewAudience: (audience: BroadcastAudience) =>
    request<AudiencePreview>('/broadcasts/audience-preview', {
      method: 'POST',
      body: JSON.stringify({ audience }),
    }),
  submit: (id: string) => request<Broadcast>(`/broadcasts/${id}/submit`, { method: 'POST' }),
  approve: (id: string) => request<Broadcast>(`/broadcasts/${id}/approve`, { method: 'POST' }),
  pause: (id: string) => request<Broadcast>(`/broadcasts/${id}/pause`, { method: 'POST' }),
  resume: (id: string) => request<Broadcast>(`/broadcasts/${id}/resume`, { method: 'POST' }),
  cancel: (id: string) => request<Broadcast>(`/broadcasts/${id}/cancel`, { method: 'POST' }),
  recipients: (id: string, status?: string) =>
    request<BroadcastRecipient[]>(`/broadcasts/${id}/recipients${toQuery({ status })}`),
};

// =============================================================================
// Analytics
// =============================================================================

export const analyticsApi = {
  get: (params: { range?: AnalyticsRange; from?: string; to?: string; sessionIds?: string[] } = {}) =>
    request<Analytics>(`/command-center/analytics${toQuery(params)}`),
  backfill: (sessionIds?: string[]) =>
    request<{ created: number; updated: number; contacts: number }>('/command-center/backfill', {
      method: 'POST',
      body: JSON.stringify({ sessionIds }),
    }),
};
