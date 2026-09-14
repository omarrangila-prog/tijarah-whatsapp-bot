import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { mergeConversation } from '../utils/conversationMerge';
import {
  analyticsApi,
  automationApi,
  broadcastApi,
  conversationApi,
  customerApi,
  workspaceApi,
  type AnalyticsRange,
  type AutomationFlow,
  type Broadcast,
  type BroadcastAudience,
  type ConsentStatus,
  type Conversation,
  type ConversationFilters,
  type ConversationPage,
  type ConversationPriority,
  type ConversationStatus,
  type Customer,
} from '../services/commandCenter';

export { mergeConversation };

// ── Query keys ────────────────────────────────────────────────────────
//
// Namespaced under 'cc' so a logout's cache clear and any invalidation sweep can address the whole
// command-center surface without touching the gateway queries in hooks/queries.ts.

export const ccKeys = {
  all: ['cc'] as const,
  conversations: (filters: ConversationFilters) => ['cc', 'conversations', filters] as const,
  conversationList: ['cc', 'conversations'] as const,
  conversation: (id: string) => ['cc', 'conversation', id] as const,
  notes: (id: string) => ['cc', 'conversation', id, 'notes'] as const,
  assignmentHistory: (id: string) => ['cc', 'conversation', id, 'assignment-history'] as const,
  me: ['cc', 'me'] as const,
  agents: ['cc', 'agents'] as const,
  teams: ['cc', 'teams'] as const,
  tags: ['cc', 'tags'] as const,
  quickReplies: ['cc', 'quick-replies'] as const,
  followUps: (filters: Record<string, unknown>) => ['cc', 'follow-ups', filters] as const,
  scheduledMessages: (filters: Record<string, unknown>) => ['cc', 'scheduled-messages', filters] as const,
  customers: (filters: Record<string, unknown>) => ['cc', 'customers', filters] as const,
  customer: (waId: string) => ['cc', 'customer', waId] as const,
  flows: (sessionId?: string) => ['cc', 'flows', sessionId ?? 'all'] as const,
  flowExecutions: (flowId?: string) => ['cc', 'flow-executions', flowId ?? 'all'] as const,
  broadcasts: ['cc', 'broadcasts'] as const,
  broadcast: (id: string) => ['cc', 'broadcast', id] as const,
  broadcastRecipients: (id: string, status?: string) => ['cc', 'broadcast', id, 'recipients', status ?? 'all'] as const,
  analytics: (params: Record<string, unknown>) => ['cc', 'analytics', params] as const,
};

// ── Conversations ─────────────────────────────────────────────────────

/**
 * The inbox list.
 *
 * `staleTime` is generous and there is no refetch interval: live changes arrive over the existing
 * `/events` socket and are written straight into this cache by the inbox's realtime handler, so
 * polling would be pure duplicate traffic.
 */
export function useConversationsQuery(filters: ConversationFilters): UseQueryResult<ConversationPage, Error> {
  return useQuery({
    queryKey: ccKeys.conversations(filters),
    queryFn: () => conversationApi.list(filters),
    staleTime: 60_000,
    // Keeps the previous page on screen while a filter change loads, so the list does not blink
    // through an empty state on every keystroke of the search box.
    placeholderData: previous => previous,
  });
}

export function useConversationQuery(id: string | null) {
  return useQuery({
    queryKey: ccKeys.conversation(id ?? ''),
    queryFn: () => conversationApi.get(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useNotesQuery(conversationId: string | null) {
  return useQuery({
    queryKey: ccKeys.notes(conversationId ?? ''),
    queryFn: () => conversationApi.listNotes(conversationId!),
    enabled: Boolean(conversationId),
    staleTime: 30_000,
  });
}

export function useAssignmentHistoryQuery(conversationId: string | null, enabled = true) {
  return useQuery({
    queryKey: ccKeys.assignmentHistory(conversationId ?? ''),
    queryFn: () => conversationApi.assignmentHistory(conversationId!),
    enabled: Boolean(conversationId) && enabled,
    staleTime: 60_000,
  });
}

/**
 * Every conversation mutation, sharing one cache-update rule.
 *
 * Each mutation returns the updated conversation, so the row is written straight into both the
 * detail cache and every cached list page. That keeps the sidebar and the header in step without a
 * refetch — which matters because the list is filtered, and a refetch would reorder it under the
 * user's cursor mid-action.
 */
export function useConversationMutations() {
  const qc = useQueryClient();

  const applyConversation = (conversation: Conversation) => {
    qc.setQueryData<Conversation>(ccKeys.conversation(conversation.id), previous =>
      mergeConversation(previous, conversation),
    );
    patchConversationInLists(qc, conversation);
  };

  return {
    markRead: useMutation({ mutationFn: conversationApi.markRead, onSuccess: applyConversation }),
    markUnread: useMutation({ mutationFn: conversationApi.markUnread, onSuccess: applyConversation }),
    setStatus: useMutation({
      mutationFn: ({ id, status }: { id: string; status: ConversationStatus }) =>
        conversationApi.setStatus(id, status),
      onSuccess: applyConversation,
    }),
    setPriority: useMutation({
      mutationFn: ({ id, priority }: { id: string; priority: ConversationPriority }) =>
        conversationApi.setPriority(id, priority),
      onSuccess: applyConversation,
    }),
    setFlags: useMutation({
      mutationFn: ({ id, ...flags }: { id: string; starred?: boolean; muted?: boolean }) =>
        conversationApi.setFlags(id, flags),
      onSuccess: applyConversation,
    }),
    assign: useMutation({
      mutationFn: ({ id, ...body }: { id: string; agentId?: string | null; teamId?: string | null; reason?: string }) =>
        conversationApi.assign(id, body),
      onSuccess: conversation => {
        applyConversation(conversation);
        void qc.invalidateQueries({ queryKey: ccKeys.assignmentHistory(conversation.id) });
      },
    }),
    transfer: useMutation({
      mutationFn: ({ id, ...body }: { id: string; toAgentId: string; toTeamId?: string | null; note?: string }) =>
        conversationApi.transfer(id, body),
      onSuccess: conversation => {
        applyConversation(conversation);
        void qc.invalidateQueries({ queryKey: ccKeys.assignmentHistory(conversation.id) });
        void qc.invalidateQueries({ queryKey: ccKeys.notes(conversation.id) });
      },
    }),
    claim: useMutation({
      mutationFn: conversationApi.claim,
      onSuccess: conversation => {
        applyConversation(conversation);
        void qc.invalidateQueries({ queryKey: ccKeys.assignmentHistory(conversation.id) });
      },
    }),
    addTag: useMutation({
      mutationFn: ({ id, tagId }: { id: string; tagId: string }) => conversationApi.addTag(id, tagId),
      onSuccess: applyConversation,
    }),
    removeTag: useMutation({
      mutationFn: ({ id, tagId }: { id: string; tagId: string }) => conversationApi.removeTag(id, tagId),
      onSuccess: applyConversation,
    }),
  };
}

export function useNoteMutations(conversationId: string | null) {
  const qc = useQueryClient();
  const invalidate = () => {
    if (conversationId) void qc.invalidateQueries({ queryKey: ccKeys.notes(conversationId) });
  };
  return {
    add: useMutation({
      mutationFn: (body: string) => conversationApi.addNote(conversationId!, body),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ noteId, body }: { noteId: string; body: string }) =>
        conversationApi.updateNote(conversationId!, noteId, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (noteId: string) => conversationApi.deleteNote(conversationId!, noteId),
      onSuccess: invalidate,
    }),
  };
}

// ── Workspace ─────────────────────────────────────────────────────────

export function useCurrentActorQuery() {
  return useQuery({ queryKey: ccKeys.me, queryFn: workspaceApi.me, staleTime: 5 * 60_000 });
}

export function useRoutingQuery() {
  return useQuery({ queryKey: ['cc', 'routing'], queryFn: workspaceApi.getRouting, staleTime: 60_000 });
}

export function usePresenceRosterQuery() {
  return useQuery({
    queryKey: ['cc', 'presence'],
    queryFn: workspaceApi.presenceRoster,
    // Short, because this IS the live view. The inbox gets presence over the socket; this poll
    // serves pages that only need an occasional read.
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export function useRoutingMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['cc', 'routing'] });
    void qc.invalidateQueries({ queryKey: ccKeys.conversationList });
  };
  return {
    update: useMutation({ mutationFn: workspaceApi.updateRouting, onSuccess: invalidate }),
    distribute: useMutation({
      mutationFn: (limit?: number) => workspaceApi.distributeQueue(limit),
      onSuccess: invalidate,
    }),
  };
}

export function useAgentsQuery() {
  return useQuery({ queryKey: ccKeys.agents, queryFn: workspaceApi.listAgents, staleTime: 5 * 60_000 });
}

export function useTeamsQuery() {
  return useQuery({ queryKey: ccKeys.teams, queryFn: workspaceApi.listTeams, staleTime: 5 * 60_000 });
}

export function useTagsQuery() {
  return useQuery({ queryKey: ccKeys.tags, queryFn: workspaceApi.listTags, staleTime: 5 * 60_000 });
}

export function useQuickRepliesQuery() {
  return useQuery({ queryKey: ccKeys.quickReplies, queryFn: () => workspaceApi.listQuickReplies(), staleTime: 60_000 });
}

export function useFollowUpsQuery(filters: { status?: string; assigneeId?: string; conversationId?: string } = {}) {
  return useQuery({
    queryKey: ccKeys.followUps(filters),
    queryFn: () => workspaceApi.listFollowUps(filters),
    staleTime: 60_000,
  });
}

export function useScheduledMessagesQuery(filters: { sessionId?: string; status?: string } = {}) {
  return useQuery({
    queryKey: ccKeys.scheduledMessages(filters),
    queryFn: () => workspaceApi.listScheduledMessages(filters),
    staleTime: 30_000,
  });
}

export function useAgentMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ccKeys.agents });
    void qc.invalidateQueries({ queryKey: ccKeys.teams });
    void qc.invalidateQueries({ queryKey: ccKeys.me });
  };
  return {
    create: useMutation({ mutationFn: workspaceApi.createAgent, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => workspaceApi.updateAgent(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: workspaceApi.deleteAgent, onSuccess: invalidate }),
  };
}

export function useTeamMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ccKeys.teams });
  return {
    create: useMutation({ mutationFn: workspaceApi.createTeam, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string; color?: string }) =>
        workspaceApi.updateTeam(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: workspaceApi.deleteTeam, onSuccess: invalidate }),
    addMember: useMutation({
      mutationFn: ({ teamId, agentId, teamRole }: { teamId: string; agentId: string; teamRole?: 'lead' | 'member' }) =>
        workspaceApi.addTeamMember(teamId, agentId, teamRole),
      onSuccess: invalidate,
    }),
    removeMember: useMutation({
      mutationFn: ({ teamId, agentId }: { teamId: string; agentId: string }) =>
        workspaceApi.removeTeamMember(teamId, agentId),
      onSuccess: invalidate,
    }),
  };
}

export function useTagMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ccKeys.tags });
    // A renamed or deleted tag is embedded in every cached conversation row.
    void qc.invalidateQueries({ queryKey: ccKeys.conversationList });
  };
  return {
    create: useMutation({ mutationFn: workspaceApi.createTag, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string; name?: string; color?: string }) =>
        workspaceApi.updateTag(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: workspaceApi.deleteTag, onSuccess: invalidate }),
  };
}

export function useQuickReplyMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ccKeys.quickReplies });
  return {
    create: useMutation({ mutationFn: workspaceApi.createQuickReply, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string } & Record<string, string>) =>
        workspaceApi.updateQuickReply(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: workspaceApi.deleteQuickReply, onSuccess: invalidate }),
    seed: useMutation({ mutationFn: workspaceApi.seedQuickReplies, onSuccess: invalidate }),
  };
}

export function useFollowUpMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['cc', 'follow-ups'] });
  return {
    create: useMutation({ mutationFn: workspaceApi.createFollowUp, onSuccess: invalidate }),
    setStatus: useMutation({
      mutationFn: ({ id, status }: { id: string; status: 'pending' | 'done' | 'cancelled' }) =>
        workspaceApi.updateFollowUp(id, status),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: workspaceApi.deleteFollowUp, onSuccess: invalidate }),
  };
}

export function useScheduledMessageMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['cc', 'scheduled-messages'] });
  return {
    create: useMutation({ mutationFn: workspaceApi.scheduleMessage, onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: workspaceApi.cancelScheduledMessage, onSuccess: invalidate }),
  };
}

// ── Customers ─────────────────────────────────────────────────────────

export function useCustomersQuery(filters: {
  search?: string;
  customerType?: string;
  consent?: ConsentStatus;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ccKeys.customers(filters),
    queryFn: () => customerApi.list(filters),
    staleTime: 60_000,
    placeholderData: previous => previous,
  });
}

export function useCustomerQuery(waId: string | null) {
  return useQuery({
    queryKey: ccKeys.customer(waId ?? ''),
    queryFn: () => customerApi.get(waId!),
    enabled: Boolean(waId),
    staleTime: 60_000,
  });
}

export function useCustomerMutations() {
  const qc = useQueryClient();
  const applyCustomer = (customer: Customer) => {
    qc.setQueryData(ccKeys.customer(customer.waId), customer);
    void qc.invalidateQueries({ queryKey: ['cc', 'customers'] });
  };
  return {
    update: useMutation({
      mutationFn: ({ waId, ...body }: { waId: string } & Partial<Customer>) => customerApi.update(waId, body),
      onSuccess: applyCustomer,
    }),
    setConsent: useMutation({
      mutationFn: ({ waId, status, source }: { waId: string; status: ConsentStatus; source?: string }) =>
        customerApi.setConsent(waId, status, source),
      onSuccess: (_consent, variables) => {
        void qc.invalidateQueries({ queryKey: ccKeys.customer(variables.waId) });
        void qc.invalidateQueries({ queryKey: ['cc', 'customers'] });
      },
    }),
  };
}

// ── Automation ────────────────────────────────────────────────────────

export function useFlowsQuery(sessionId?: string) {
  return useQuery({ queryKey: ccKeys.flows(sessionId), queryFn: () => automationApi.list(sessionId), staleTime: 60_000 });
}

export function useFlowExecutionsQuery(flowId?: string) {
  return useQuery({
    queryKey: ccKeys.flowExecutions(flowId),
    queryFn: () => automationApi.executions({ flowId, limit: 200 }),
    staleTime: 30_000,
  });
}

export function useFlowMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['cc', 'flows'] });
  return {
    create: useMutation({ mutationFn: automationApi.create, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string } & Partial<AutomationFlow>) => automationApi.update(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: automationApi.remove, onSuccess: invalidate }),
  };
}

// ── Broadcasts ────────────────────────────────────────────────────────

export function useBroadcastsQuery() {
  return useQuery({ queryKey: ccKeys.broadcasts, queryFn: broadcastApi.list, staleTime: 15_000 });
}

export function useBroadcastRecipientsQuery(id: string | null, status?: string) {
  return useQuery({
    queryKey: ccKeys.broadcastRecipients(id ?? '', status),
    queryFn: () => broadcastApi.recipients(id!, status),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useBroadcastMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ccKeys.broadcasts });
    void qc.invalidateQueries({ queryKey: ['cc', 'broadcast'] });
  };
  return {
    create: useMutation({ mutationFn: broadcastApi.create, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string } & Partial<Broadcast>) => broadcastApi.update(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: broadcastApi.remove, onSuccess: invalidate }),
    submit: useMutation({ mutationFn: broadcastApi.submit, onSuccess: invalidate }),
    approve: useMutation({ mutationFn: broadcastApi.approve, onSuccess: invalidate }),
    pause: useMutation({ mutationFn: broadcastApi.pause, onSuccess: invalidate }),
    resume: useMutation({ mutationFn: broadcastApi.resume, onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: broadcastApi.cancel, onSuccess: invalidate }),
    previewAudience: useMutation({ mutationFn: (audience: BroadcastAudience) => broadcastApi.previewAudience(audience) }),
  };
}

// ── Analytics ─────────────────────────────────────────────────────────

export function useAnalyticsQuery(params: { range?: AnalyticsRange; from?: string; to?: string; sessionIds?: string[] }) {
  return useQuery({
    queryKey: ccKeys.analytics(params),
    queryFn: () => analyticsApi.get(params),
    staleTime: 60_000,
    placeholderData: previous => previous,
  });
}

export function useBackfillMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionIds?: string[]) => analyticsApi.backfill(sessionIds),
    onSuccess: () => {
      // Backfill can create hundreds of rows across every surface — a broad sweep is correct here.
      void qc.invalidateQueries({ queryKey: ccKeys.all });
    },
  });
}

// ── Shared cache helpers ──────────────────────────────────────────────

type QueryClientLike = ReturnType<typeof useQueryClient>;

/**
 * Write an updated conversation into every cached list page that already holds it.
 *
 * Deliberately does NOT insert a conversation into a page it is missing from: the list is filtered
 * and sorted server-side, and guessing where a row belongs under an arbitrary filter would put it
 * in the wrong place. A conversation that newly matches a filter arrives on the next fetch.
 */
export function patchConversationInLists(qc: QueryClientLike, conversation: Conversation): void {
  qc.setQueriesData<ConversationPage>({ queryKey: ccKeys.conversationList }, page => {
    if (!page) return page;
    const index = page.conversations.findIndex(row => row.id === conversation.id);
    if (index === -1) return page;
    const conversations = [...page.conversations];
    conversations[index] = mergeConversation(conversations[index], conversation);
    return { ...page, conversations };
  });
}
