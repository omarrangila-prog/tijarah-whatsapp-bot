import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRightLeft,
  Brain,
  Power,
  Calendar,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Star,
  User,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { sessionApi, asMessageType, type Chat, type ChatKind } from '../services/api';
import {
  aiApi,
  workspaceApi,
  type AiAnalysis,
  type Conversation,
  type ConversationFilters,
  type HandoffBrief,
  type ConversationPriority,
  type ConversationStatus,
} from '../services/commandCenter';
import {
  ccKeys,
  mergeConversation,
  patchConversationInLists,
  useAgentsQuery,
  useAssignmentHistoryQuery,
  useConversationMutations,
  useConversationsQuery,
  useCurrentActorQuery,
  useCustomerMutations,
  useCustomerQuery,
  useFollowUpMutations,
  useNoteMutations,
  useNotesQuery,
  useQuickRepliesQuery,
  useTagsQuery,
  useTeamsQuery,
} from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useChatMessages, useChatMessagesActions } from '../hooks/useChatMessages';
import { useChatScrollPosition } from '../hooks/useChatScrollPosition';
import { useProfilePicture } from '../hooks/useProfilePicture';
import { useWebSocket } from '../hooks/useWebSocket';
import { usePresence } from '../hooks/usePresence';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import {
  applyMessageEdit,
  getMediaSrc,
  mergeDeliveryStatus,
  mergeReactionSnapshot,
  type ChatMessageView,
} from '../utils/chatMessages';
import { messageApi } from '../services/api';
import ChatThread from '../components/chats/ChatThread';
import ChatComposer, { type StagedAttachment } from '../components/chats/ChatComposer';
import MediaLightbox, { type LightboxItem } from '../components/chats/MediaLightbox';
import { Avatar, EmptyState, ErrorState, HealthDot, Skeleton } from '../components/cc/Primitives';
import InboxRail from '../components/inbox/InboxRail';
import { filtersForView, type InboxView } from '../utils/inboxFilters';
import ConversationList from '../components/inbox/ConversationList';
import CustomerPanel from '../components/inbox/CustomerPanel';
import AiPanel from '../components/inbox/AiPanel';
import QuickReplyPicker from '../components/inbox/QuickReplyPicker';
import TransferDialog from '../components/inbox/TransferDialog';
import HandoffBanner from '../components/inbox/HandoffBanner';
import { absoluteTime, formatWaId, quickReplyQueryAt, relativeTime, replaceQuickReplyToken } from '../utils/ccFormat';
// The reused thread and composer render with the existing chat styles.
import './Chats.css';
import './Inbox.css';

/** Page size for the conversation list. Enough to fill a tall screen without over-fetching. */
const PAGE_SIZE = 25;

type PanelTab = 'details' | 'ai' | 'activity';

/** The `Chat` shape the reused thread/composer components expect, built from a conversation. */
function toChat(conversation: Conversation): Chat {
  return {
    id: conversation.chatId,
    name: conversation.chatName || formatWaId(conversation.chatId),
    isGroup: conversation.kind === 'group',
    kind: (conversation.kind as ChatKind) || 'individual',
    unreadCount: conversation.unreadCount,
    timestamp: conversation.lastMessageAt ? Math.floor(new Date(conversation.lastMessageAt).getTime() / 1000) : 0,
    lastMessage: conversation.lastMessagePreview ?? undefined,
  };
}

export function Inbox() {
  useDocumentTitle('Inbox');
  const queryClient = useQueryClient();
  const { error: showError, success: showSuccess } = useToast();
  const { canWrite } = useRole();

  // ── Filter state ────────────────────────────────────────────────────
  const [view, setView] = useState<InboxView>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [status, setStatus] = useState<ConversationStatus | ''>('');
  const [priority, setPriority] = useState<ConversationPriority | ''>('');
  const [assignee, setAssignee] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Debounced so typing in the search box does not fire a query per keystroke — the search arm hits
  // the message table, which is the expensive one.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  // A new search or filter must start from the first page again.
  useEffect(() => setLimit(PAGE_SIZE), [debouncedSearch, view, status, priority, assignee, sessionIds, tagIds]);

  const filters = useMemo<ConversationFilters>(
    () => ({
      ...filtersForView(view),
      ...(sessionIds.length ? { sessionIds } : {}),
      ...(tagIds.length ? { tagIds } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(assignee ? { assigneeId: assignee } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      limit,
    }),
    [view, sessionIds, tagIds, status, priority, assignee, debouncedSearch, limit],
  );

  // ── Data ────────────────────────────────────────────────────────────
  const sessionsQuery = useSessionsQuery();
  const conversationsQuery = useConversationsQuery(filters);
  const agentsQuery = useAgentsQuery();
  const teamsQuery = useTeamsQuery();
  const tagsQuery = useTagsQuery();
  const quickRepliesQuery = useQuickRepliesQuery();
  const actorQuery = useCurrentActorQuery();
  const aiStatusQuery = useQuery({ queryKey: ['cc', 'ai', 'status'], queryFn: aiApi.status, staleTime: 5 * 60_000 });

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const conversations = useMemo(() => conversationsQuery.data?.conversations ?? [], [conversationsQuery.data]);
  const agentsById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const sessionsById = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);

  // ── Selection ───────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('details');
  // Mobile shows one column at a time; this drives which.
  const [mobilePane, setMobilePane] = useState<'list' | 'chat'>('list');

  const selected = useMemo(
    () => conversations.find(conversation => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );
  // The selected conversation may fall out of the filtered page (a resolve while "Open" is
  // selected). Keeping the last known row means the chat pane does not blank out underneath the
  // action the user just took.
  const [detached, setDetached] = useState<Conversation | null>(null);
  useEffect(() => {
    if (selected) setDetached(selected);
  }, [selected]);
  const active = selected ?? (detached?.id === selectedId ? detached : null);

  // Live presence for the shared inbox: who else is online, and who else has THIS conversation open.
  const { online, viewers, noteTyping } = usePresence(selectedId, true);

  const mutations = useConversationMutations();
  const noteMutations = useNoteMutations(selectedId);
  const customerMutations = useCustomerMutations();
  const followUpMutations = useFollowUpMutations();

  const notesQuery = useNotesQuery(selectedId);
  const historyQuery = useAssignmentHistoryQuery(selectedId, panelTab === 'activity');
  const waId = active ? active.chatId.replace('@s.whatsapp.net', '@c.us') : null;
  const customerQuery = useCustomerQuery(active && active.kind === 'individual' ? waId : null);

  // ── Messages (reuses the existing chat data path) ────────────────────
  const messagesQuery = useChatMessages(active?.sessionId ?? '', active?.chatId ?? null);
  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);
  const { appendMessage, updateMessage } = useChatMessagesActions();
  const { containerRef: messagesContainerRef, onMessageAppended, onMediaLoad } = useChatScrollPosition(
    active?.chatId ?? null,
    messages.length > 0,
  );
  // The hook returns a query result; the panel and header want just the URL (null while loading).
  const profilePictureQuery = useProfilePicture(active?.sessionId, active?.chatId);
  const profilePicture = profilePictureQuery.data ?? null;

  // Composer state lives here so a draft survives switching panels (but not conversations).
  const [messageInput, setMessageInput] = useState('');
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  // Handoff briefing: shown once, for a conversation that has just been handed to this agent.
  const [brief, setBrief] = useState<HandoffBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<unknown>(null);
  const [briefFrom, setBriefFrom] = useState<string | null>(null);
  // Conversations whose briefing this agent has already seen or dismissed, so it does not reappear
  // every time they switch back to the thread.
  const briefedRef = useRef<Set<string>>(new Set());

  const loadBrief = useCallback(async (conversationId: string, fromName: string | null) => {
    setBriefFrom(fromName);
    setBriefLoading(true);
    setBriefError(null);
    try {
      setBrief(await aiApi.handoffBrief(conversationId));
    } catch (error) {
      setBriefError(error);
    } finally {
      setBriefLoading(false);
    }
  }, []);

  /** Bring a stopped number back online from the conversation the operator is already looking at. */
  const reconnectSession = useCallback(
    async (sessionId: string) => {
      setReconnecting(true);
      try {
        await sessionApi.start(sessionId);
        showSuccess('Connecting…', 'The number will come online in a few seconds.');
        await sessionsQuery.refetch();
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Could not connect that number');
      } finally {
        setReconnecting(false);
      }
    },
    [sessionsQuery, showError, showSuccess],
  );

  // Announce typing from the draft. The hook only records a timestamp, so this is free per keystroke
  // and the flag decays on its own if the tab closes mid-compose.
  useEffect(() => {
    if (messageInput) noteTyping();
  }, [messageInput, noteTyping]);

  useEffect(() => {
    setMessageInput('');
    setAttachment(null);
    setPreviewUrl(null);
    setReplyingTo(null);
    setLightboxIndex(null);
    setScheduleOpen(false);
  }, [selectedId]);

  // ── AI ──────────────────────────────────────────────────────────────
  /**
   * Offer a briefing when a conversation has just been handed to this agent.
   *
   * Keyed on the assignment trail rather than on the assignee alone: a conversation that has always
   * been mine is not a handover, and briefing me on my own work would train me to dismiss the
   * banner without reading it — which is exactly when it would matter.
   */
  const historyForBrief = useAssignmentHistoryQuery(selectedId, Boolean(selectedId));
  useEffect(() => {
    const me = actorQuery.data?.agent?.id;
    if (!selectedId || !me || !active || active.assigneeId !== me) return;
    if (briefedRef.current.has(selectedId)) return;

    const latest = historyForBrief.data?.[0];
    const handedToMe = latest?.toAgentId === me && latest.fromAgentId !== null && latest.fromAgentId !== me;
    if (!handedToMe) return;

    briefedRef.current.add(selectedId);
    const from = latest.fromAgentId ? (agentsById.get(latest.fromAgentId)?.name ?? null) : null;
    void loadBrief(selectedId, from);
  }, [selectedId, active, actorQuery.data, historyForBrief.data, agentsById, loadBrief]);

  const [analysis, setAnalysis] = useState<AiAnalysis | undefined>();
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<unknown>(null);
  const [suggesting, setSuggesting] = useState(false);

  // A new conversation must not show the previous one's analysis even for a frame.
  useEffect(() => {
    setAnalysis(undefined);
    setAiError(null);
    setBrief(null);
    setBriefError(null);
    setTransferOpen(false);
  }, [selectedId]);

  const runAnalysis = useCallback(
    async (force: boolean) => {
      if (!selectedId) return;
      setAiLoading(true);
      setAiError(null);
      try {
        setAnalysis(await aiApi.analyze(selectedId, force));
      } catch (error) {
        setAiError(error);
      } finally {
        setAiLoading(false);
      }
    },
    [selectedId],
  );

  const redraftReply = useCallback(async () => {
    if (!selectedId) return;
    setSuggesting(true);
    try {
      const result = await aiApi.suggestReply(selectedId);
      setAnalysis(current => (current ? { ...current, suggestedReply: result.text } : current));
    } catch (error) {
      showError(error instanceof Error ? error.message : 'The AI assistant could not draft a reply');
    } finally {
      setSuggesting(false);
    }
  }, [selectedId, showError]);

  // ── Quick replies in the composer ───────────────────────────────────
  const composerRef = useRef<HTMLDivElement>(null);
  const [quickReplyQuery, setQuickReplyQuery] = useState<string | null>(null);

  // Watch the draft for a `/shortcut` token. Reading the caret from the live textarea keeps this
  // correct when the agent types a slash in the middle of an existing draft.
  useEffect(() => {
    const textarea = composerRef.current?.querySelector('textarea');
    const caret = textarea?.selectionStart ?? messageInput.length;
    setQuickReplyQuery(quickReplyQueryAt(messageInput, caret));
  }, [messageInput]);

  const insertQuickReply = useCallback(
    async (replyId: string) => {
      const textarea = composerRef.current?.querySelector('textarea');
      const caret = textarea?.selectionStart ?? messageInput.length;
      try {
        const rendered = await workspaceApi.renderQuickReply(replyId, selectedId ?? undefined);
        const next = replaceQuickReplyToken(messageInput, caret, rendered.text);
        setMessageInput(next.text);
        setQuickReplyQuery(null);
        if (rendered.unresolved.length) {
          showError(`Fill in before sending: ${rendered.unresolved.map(name => `{{${name}}}`).join(', ')}`);
        }
        // Restore focus and put the caret after the inserted text.
        window.setTimeout(() => {
          const area = composerRef.current?.querySelector('textarea');
          area?.focus();
          area?.setSelectionRange(next.caret, next.caret);
        }, 0);
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Could not insert that quick reply');
      }
    },
    [messageInput, selectedId, showError],
  );

  // ── Realtime ────────────────────────────────────────────────────────
  const subscribedRef = useRef(false);
  // The realtime callbacks are memoised and would otherwise close over a stale chat id; the ref
  // gives them the current one. Written in an effect, never during render — React may render
  // without committing, and a ref updated in that discarded pass would point at a chat the user
  // never opened.
  const activeChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeChatIdRef.current = active?.chatId ?? null;
  }, [active?.chatId]);

  const handleIncoming = useCallback(
    (sessionId: string, raw: Record<string, unknown>) => {
      const chatId = typeof raw.chatId === 'string' ? raw.chatId : '';
      if (!chatId) return;
      const fromMe = raw.fromMe === true;
      // Only append into a thread that is already cached — appendMessage is a no-op otherwise, which
      // is what stops a phantom one-message slice from replacing real history when the chat opens.
      const message: ChatMessageView = {
        id: String(raw.id ?? ''),
        waMessageId: String(raw.id ?? ''),
        chatId,
        from: String(raw.from ?? ''),
        to: String(raw.to ?? ''),
        body: String(raw.body ?? ''),
        type: asMessageType(typeof raw.type === 'string' ? raw.type : undefined),
        direction: fromMe ? 'outgoing' : 'incoming',
        status: fromMe ? 'sent' : 'delivered',
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Math.floor(Date.now() / 1000),
        createdAt: new Date().toISOString(),
        chatName: typeof raw.chatName === 'string' ? raw.chatName : undefined,
        author: typeof raw.author === 'string' ? raw.author : undefined,
        metadata: {
          ...(raw.media ? { media: raw.media as ChatMessageView['metadata'] extends undefined ? never : NonNullable<ChatMessageView['metadata']>['media'] } : {}),
          ...(raw.quotedMessage ? { quotedMessage: raw.quotedMessage as { id: string; body: string } } : {}),
        },
      };
      appendMessage(sessionId, chatId, message);
      if (chatId === activeChatIdRef.current) onMessageAppended(fromMe ? 'outgoing' : 'incoming');
    },
    [appendMessage, onMessageAppended],
  );

  const { isConnected, connectionFailed, reconnect, subscribe } = useWebSocket({
    onMessage: event => handleIncoming(event.sessionId, event.message),
    onMessageAck: event => {
      const chatId = activeChatIdRef.current;
      if (!chatId) return;
      // Delivery ticks merge forward-only, so a late `sent` never downgrades a `read`.
      updateMessage(event.sessionId, chatId, event.messageId, {
        status: mergeDeliveryStatus('sent', event.status),
      });
    },
    onMessageReaction: event => {
      // `reactions` is the post-apply snapshot and may be absent, which means "unknown" rather than
      // "none left" — mergeReactionSnapshot keeps the existing map in that case.
      updateMessage(event.sessionId, event.chatId, event.messageId, {
        metadata: { reactions: mergeReactionSnapshot(undefined, event.reactions) },
      });
    },
    onMessageEdited: event => {
      queryClient.setQueryData<ChatMessageView[]>(['messages', event.sessionId, event.chatId], old =>
        old ? applyMessageEdit(old, { messageId: event.messageId, body: event.body }) : old,
      );
    },
    onConversationUpdated: event => {
      const conversation = event.conversation as unknown as Conversation;
      if (!conversation?.id) return;
      // MERGED, not assigned: this payload is the raw row and carries no `tags`, so overwriting the
      // cached view with it dropped them and the next render crashed. The list is server-sorted and
      // filtered, so a row that newly matches the current filter arrives on the next fetch rather
      // than being guessed into position.
      patchConversationInLists(queryClient, conversation);
      queryClient.setQueryData<Conversation>(ccKeys.conversation(conversation.id), previous =>
        mergeConversation(previous, conversation),
      );
      setDetached(current => (current?.id === conversation.id ? mergeConversation(current, conversation) : current));
    },
    onConversationNote: event => {
      void queryClient.invalidateQueries({ queryKey: ccKeys.notes(event.conversationId) });
    },
  });

  // Subscribe once connected. `*` covers every number in one subscription; a session-scoped key is
  // refused the wildcard by the gateway, so fall back to per-session rooms for exactly the sessions
  // this key can see.
  useEffect(() => {
    if (!isConnected) {
      subscribedRef.current = false;
      return;
    }
    if (subscribedRef.current) return;
    subscribedRef.current = true;
    const events = [
      'message.received',
      'message.sent',
      'message.ack',
      'message.reaction',
      'message.edited',
      'message.revoked',
      'conversation.updated',
      'conversation.note',
    ];
    subscribe('*', events);
    for (const session of sessions) subscribe(session.id, events);
  }, [isConnected, sessions, subscribe]);

  // Conversations arriving over the socket change ordering and unread counts; a periodic
  // reconciliation catches rows that newly match the filter. Long interval on purpose — this is a
  // safety net behind the socket, not the primary update path.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ccKeys.conversationList });
    }, 120_000);
    return () => window.clearInterval(timer);
  }, [queryClient]);

  // ── Actions ─────────────────────────────────────────────────────────
  const openConversation = useCallback(
    (conversation: Conversation) => {
      setSelectedId(conversation.id);
      setMobilePane('chat');
      if (conversation.unreadCount > 0 || conversation.manualUnread) {
        mutations.markRead.mutate(conversation.id);
        // Also clear the badge on WhatsApp itself, mirroring what the Chats page does.
        void sessionApi.markChatRead(conversation.sessionId, conversation.chatId).catch(() => undefined);
      }
    },
    [mutations.markRead],
  );

  /**
   * Open the newest conversation automatically on a wide screen, so the inbox lands on something to
   * read instead of two empty panels.
   *
   * Deliberately does NOT mark it read: nobody has looked at it yet, and silently clearing an
   * unread badge the operator never saw destroys the signal they came here for. Only an explicit
   * click does that. Skipped on mobile, where the list IS the screen and auto-opening would hide it.
   */
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current || selectedId) return;
    if (conversations.length === 0) return;
    if (window.innerWidth < 780) return;
    autoSelectedRef.current = true;
    setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  const handleReact = useCallback(
    async (message: ChatMessageView, emoji: string) => {
      if (!active) return;
      try {
        await messageApi.react(active.sessionId, {
          chatId: active.chatId,
          messageId: message.waMessageId || message.id,
          emoji,
        });
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Could not send that reaction');
      }
    },
    [active, showError],
  );

  const handleDelete = useCallback(
    async (message: ChatMessageView) => {
      if (!active) return;
      try {
        await messageApi.delete(active.sessionId, {
          chatId: active.chatId,
          messageId: message.waMessageId || message.id,
          forEveryone: true,
        });
        updateMessage(active.sessionId, active.chatId, message.id, { type: 'revoked', body: '' });
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Could not delete that message');
      }
    },
    [active, showError, updateMessage],
  );

  const scheduleMessage = useCallback(async () => {
    if (!active || !messageInput.trim() || !scheduleAt) return;
    setScheduling(true);
    try {
      await workspaceApi.scheduleMessage({
        sessionId: active.sessionId,
        chatId: active.chatId,
        body: messageInput.trim(),
        runAt: new Date(scheduleAt).toISOString(),
      });
      showSuccess(`Message scheduled for ${absoluteTime(new Date(scheduleAt).toISOString())}`);
      setMessageInput('');
      setScheduleOpen(false);
      setScheduleAt('');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Could not schedule that message');
    } finally {
      setScheduling(false);
    }
  }, [active, messageInput, scheduleAt, showError, showSuccess]);

  const transformDraft = useCallback(
    async (kind: 'rewrite' | 'shorten') => {
      if (!messageInput.trim()) return;
      try {
        const result = kind === 'rewrite' ? await aiApi.rewrite(messageInput) : await aiApi.shorten(messageInput);
        setMessageInput(result.text);
      } catch (error) {
        showError(error instanceof Error ? error.message : 'The AI assistant is unavailable');
      }
    },
    [messageInput, showError],
  );

  const imageMedia = useMemo<LightboxItem[]>(
    () =>
      messages
        .filter(message => message.type === 'image' && Boolean(getMediaSrc(message.metadata?.media)))
        .map(message => ({
          id: message.id,
          url: getMediaSrc(message.metadata?.media),
          alt: message.body || message.metadata?.media?.filename || '',
          senderName: undefined,
          timestamp: absoluteTime(message.createdAt),
        })),
    [messages],
  );

  const activeChat = active ? toChat(active) : null;
  const activeSession = active ? sessionsById.get(active.sessionId) : undefined;
  const total = conversationsQuery.data?.total ?? 0;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className={`inbox inbox-pane-${mobilePane}`}>
      <InboxRail
        view={view}
        onViewChange={setView}
        sessions={sessions}
        selectedSessionIds={sessionIds}
        onToggleSession={id =>
          setSessionIds(current => (current.includes(id) ? current.filter(x => x !== id) : [...current, id]))
        }
        tags={tagsQuery.data ?? []}
        selectedTagIds={tagIds}
        onToggleTag={id => setTagIds(current => (current.includes(id) ? current.filter(x => x !== id) : [...current, id]))}
      />

      <div className="inbox-centre">
        {/* Who is on shift, and what they are on. The strip sits above the list rather than in a
            separate page because a shared inbox is worked from here — a supervisor should not have
            to leave the queue to see the queue's owners. */}
        {online.length > 0 && (
          <div className="inbox-team">
            <span className="inbox-team-label">On shift</span>
            {online.slice(0, 8).map(person => {
              const busy = Boolean(person.viewingConversationId);
              return (
                <span
                  key={person.agentId}
                  className={`inbox-team-chip ${busy ? 'is-busy' : ''}`}
                  title={
                    busy
                      ? `${person.name} — in a conversation${person.typing ? ', typing' : ''}`
                      : `${person.name} — available`
                  }
                >
                  <span className="inbox-team-avatar" style={{ background: person.color }}>
                    {person.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="cc-truncate">{person.name}</span>
                  {person.typing && <span className="inbox-team-typing" aria-label="typing" />}
                </span>
              );
            })}
            {online.length > 8 && <span className="inbox-team-more cc-num">+{online.length - 8}</span>}
          </div>
        )}

      <ConversationList
        conversations={conversations}
        total={total}
        loading={conversationsQuery.isLoading}
        fetching={conversationsQuery.isFetching}
        error={conversationsQuery.error}
        onRetry={() => void conversationsQuery.refetch()}
        selectedId={selectedId}
        onSelect={openConversation}
        search={search}
        onSearchChange={setSearch}
        agentsById={agentsById}
        sessionsById={sessionsById}
        status={status}
        onStatusChange={setStatus}
        priority={priority}
        onPriorityChange={setPriority}
        assignee={assignee}
        onAssigneeChange={setAssignee}
        agents={agents}
        onLoadMore={() => setLimit(current => Math.min(current + PAGE_SIZE, 100))}
        canLoadMore={conversations.length < total && limit < 100}
      />
      </div>

      {/* `chats-page` is load-bearing, not decorative: every rule in Chats.css is scoped under that
          class (enforced by styles.scope.test.ts), so the reused ChatThread and ChatComposer render
          completely unstyled without it — no bubbles, no alignment, and the per-message hover
          actions permanently expanded. Its own padding is neutralised in Inbox.css. */}
      <main className="inbox-chat chats-page">
        {!active || !activeChat ? (
          <div className="inbox-chat-empty">
            <EmptyState
              icon={<MessageSquare size={22} />}
              title="Select a conversation"
              description="Pick a conversation from the list to read the thread, see the customer, and reply. Everything updates live as messages arrive."
            />
          </div>
        ) : (
          <>
            <header className="inbox-chat-head">
              <button
                type="button"
                className="inbox-back cc-btn cc-btn-ghost cc-btn-icon"
                onClick={() => setMobilePane('list')}
                aria-label="Back to conversations"
              >
                <ArrowLeft size={17} />
              </button>

              <Avatar name={active.chatName} seed={active.chatId} src={profilePicture} />

              <div className="inbox-chat-identity">
                <div className="inbox-chat-name cc-truncate">{active.chatName || formatWaId(active.chatId)}</div>
                <div className="inbox-chat-sub cc-truncate">
                  {activeSession && (
                    <>
                      <HealthDot status={activeSession.status} />
                      <span>{activeSession.name}</span>
                      <span className="inbox-sep">·</span>
                    </>
                  )}
                  <span>{formatWaId(active.chatId)}</span>
                  {active.lastMessageAt && (
                    <>
                      <span className="inbox-sep">·</span>
                      <span>active {relativeTime(active.lastMessageAt)}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="inbox-chat-actions">
                <select
                  className="cc-mini-select"
                  value={active.status}
                  onChange={event =>
                    mutations.setStatus.mutate({ id: active.id, status: event.target.value as ConversationStatus })
                  }
                  disabled={!canWrite}
                  aria-label="Conversation status"
                >
                  <option value="open">Open</option>
                  <option value="waiting">Waiting</option>
                  <option value="resolved">Resolved</option>
                </select>

                <select
                  className="cc-mini-select"
                  value={active.priority}
                  onChange={event =>
                    mutations.setPriority.mutate({
                      id: active.id,
                      priority: event.target.value as ConversationPriority,
                    })
                  }
                  disabled={!canWrite}
                  aria-label="Priority"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>

                <select
                  className="cc-mini-select"
                  value={active.assigneeId ?? ''}
                  onChange={event =>
                    mutations.assign.mutate({ id: active.id, agentId: event.target.value || null })
                  }
                  disabled={!canWrite}
                  aria-label="Assignee"
                >
                  <option value="">Unassigned</option>
                  {agents.map(agent => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="cc-btn cc-btn-sm"
                  onClick={() => setTransferOpen(true)}
                  disabled={!canWrite || agents.length === 0}
                  title={
                    agents.length === 0
                      ? 'Add teammates on the Team page to hand conversations over'
                      : 'Hand this conversation to a colleague'
                  }
                >
                  <ArrowRightLeft size={12} /> Hand over
                </button>

                {actorQuery.data?.agent && active.assigneeId !== actorQuery.data.agent.id && (
                  <button
                    type="button"
                    className="cc-btn cc-btn-sm"
                    onClick={() => mutations.claim.mutate(active.id)}
                    disabled={!canWrite || mutations.claim.isPending}
                    title="Assign this conversation to yourself"
                  >
                    <User size={12} /> Claim
                  </button>
                )}

                <button
                  type="button"
                  className={`cc-btn cc-btn-icon cc-btn-ghost ${active.starred ? 'is-starred' : ''}`}
                  onClick={() => mutations.setFlags.mutate({ id: active.id, starred: !active.starred })}
                  disabled={!canWrite}
                  aria-label={active.starred ? 'Unstar conversation' : 'Star conversation'}
                >
                  <Star size={15} fill={active.starred ? 'currentColor' : 'none'} />
                </button>

                <button
                  type="button"
                  className="cc-btn cc-btn-icon cc-btn-ghost"
                  onClick={() => mutations.markUnread.mutate(active.id)}
                  disabled={!canWrite}
                  aria-label="Mark as unread"
                  title="Mark as unread"
                >
                  <RotateCcw size={15} />
                </button>

                {active.status !== 'resolved' ? (
                  <button
                    type="button"
                    className="cc-btn cc-btn-sm"
                    onClick={() => mutations.setStatus.mutate({ id: active.id, status: 'resolved' })}
                    disabled={!canWrite}
                  >
                    <CheckCircle2 size={13} /> Resolve
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cc-btn cc-btn-sm"
                    onClick={() => mutations.setStatus.mutate({ id: active.id, status: 'open' })}
                    disabled={!canWrite}
                  >
                    Reopen
                  </button>
                )}
              </div>
            </header>

            {!isConnected && (
              <div className="inbox-connection">
                {connectionFailed ? <WifiOff size={13} /> : <Loader2 size={13} className="cc-spin" />}
                <span>
                  {connectionFailed
                    ? 'Live updates disconnected — new messages will not appear until you reconnect.'
                    : 'Connecting to live updates…'}
                </span>
                {connectionFailed && (
                  <button type="button" className="cc-btn cc-btn-sm" onClick={reconnect}>
                    Reconnect
                  </button>
                )}
              </div>
            )}

            {(brief || briefLoading || briefError) && (
              <HandoffBanner
                brief={brief}
                loading={briefLoading}
                error={briefError}
                fromAgentName={briefFrom}
                onUseMessage={text => {
                  setMessageInput(text);
                  setBrief(null);
                }}
                onDismiss={() => {
                  setBrief(null);
                  setBriefError(null);
                }}
                onRetry={() => selectedId && void loadBrief(selectedId, briefFrom)}
              />
            )}

            <ChatThread
              sessionId={active.sessionId}
              activeChat={activeChat}
              messages={messages}
              loadingMessages={messagesQuery.isLoading}
              messagesError={Boolean(messagesQuery.error)}
              messagesContainerRef={messagesContainerRef}
              onMediaLoad={onMediaLoad}
              onOpenImage={messageId => {
                const index = imageMedia.findIndex(item => item.id === messageId);
                if (index >= 0) setLightboxIndex(index);
              }}
              onReply={setReplyingTo}
              onReact={handleReact}
              onDelete={handleDelete}
            />

            {/* Somebody else has this conversation open. Shown right above the composer, where a
                second agent is about to start writing the same reply — a warning further up the
                page is one they would have already scrolled past. */}
            {viewers.length > 0 && (
              <div className={`inbox-viewers ${viewers.some(v => v.typing) ? 'is-typing' : ''}`}>
                <span className="inbox-viewers-avatars">
                  {viewers.slice(0, 3).map(viewer => (
                    <span
                      key={viewer.agentId}
                      className="inbox-viewer-dot"
                      style={{ background: viewer.color }}
                      title={viewer.name}
                    >
                      {viewer.name.slice(0, 1).toUpperCase()}
                    </span>
                  ))}
                </span>
                <span>
                  {viewers.some(v => v.typing)
                    ? `${viewers.filter(v => v.typing).map(v => v.name).join(', ')} is typing…`
                    : `${viewers.map(v => v.name).join(', ')} ${viewers.length === 1 ? 'has' : 'have'} this open`}
                </span>
              </div>
            )}

            {activeSession && activeSession.status !== 'ready' ? (
              // A stopped number cannot send. Previously the composer accepted the message and the
              // send failed after the fact, which read as the product being broken rather than the
              // number being offline — so say so up front, and offer the one action that fixes it.
              <div className="inbox-offline">
                <WifiOff size={16} />
                <div className="inbox-offline-text">
                  <strong>{activeSession.name} is not connected</strong>
                  <span>
                    Messages cannot be sent until this number is back online. Its history stays
                    readable here.
                  </span>
                </div>
                <button
                  type="button"
                  className="cc-btn cc-btn-primary cc-btn-sm"
                  disabled={!canWrite || reconnecting}
                  onClick={() => void reconnectSession(activeSession.id)}
                >
                  {reconnecting ? <Loader2 size={13} className="cc-spin" /> : <Power size={13} />} Connect
                </button>
                <Link to="/numbers" className="cc-btn cc-btn-sm">
                  Manage numbers
                </Link>
              </div>
            ) : (
            <div className="inbox-composer" ref={composerRef}>
              <div className="inbox-composer-tools">
                <button
                  type="button"
                  className="cc-btn cc-btn-ghost cc-btn-sm"
                  onClick={() => setMessageInput(current => (current.endsWith('/') ? current : `${current}${current && !current.endsWith(' ') ? ' ' : ''}/`))}
                  title="Insert a quick reply"
                >
                  <Zap size={13} /> Quick reply
                </button>
                <button
                  type="button"
                  className="cc-btn cc-btn-ghost cc-btn-sm"
                  onClick={() => void transformDraft('rewrite')}
                  disabled={!messageInput.trim()}
                  title="Rewrite the draft more professionally"
                >
                  <Sparkles size={13} /> Rewrite
                </button>
                <button
                  type="button"
                  className="cc-btn cc-btn-ghost cc-btn-sm"
                  onClick={() => void transformDraft('shorten')}
                  disabled={!messageInput.trim()}
                  title="Shorten the draft"
                >
                  Shorten
                </button>
                <button
                  type="button"
                  className="cc-btn cc-btn-ghost cc-btn-sm"
                  onClick={() => {
                    setPanelTab('ai');
                    if (!analysis) void runAnalysis(false);
                  }}
                  title="Open the AI copilot"
                >
                  <Brain size={13} /> AI copilot
                </button>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="cc-btn cc-btn-ghost cc-btn-sm"
                  onClick={() => setScheduleOpen(open => !open)}
                  disabled={!messageInput.trim()}
                  title="Send this message later"
                >
                  <Calendar size={13} /> Schedule
                </button>
              </div>

              {scheduleOpen && (
                <div className="inbox-schedule">
                  <Clock size={13} />
                  <input
                    className="cc-input"
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={event => setScheduleAt(event.target.value)}
                    aria-label="Send at"
                  />
                  <button
                    type="button"
                    className="cc-btn cc-btn-primary cc-btn-sm"
                    onClick={() => void scheduleMessage()}
                    disabled={!scheduleAt || scheduling}
                  >
                    {scheduling ? <Loader2 size={12} className="cc-spin" /> : null} Schedule
                  </button>
                  <button type="button" className="cc-btn cc-btn-sm" onClick={() => setScheduleOpen(false)}>
                    Cancel
                  </button>
                </div>
              )}

              {quickReplyQuery !== null && (
                <QuickReplyPicker
                  replies={quickRepliesQuery.data ?? []}
                  query={quickReplyQuery}
                  loading={quickRepliesQuery.isLoading}
                  onPick={reply => void insertQuickReply(reply.id)}
                  onClose={() => setQuickReplyQuery(null)}
                />
              )}

              <ChatComposer
                selectedSessionId={active.sessionId}
                activeChat={activeChat}
                replyingTo={replyingTo}
                setReplyingTo={setReplyingTo}
                onMessageAppended={onMessageAppended}
                // The composer promotes the chat in its own list; this inbox is server-ordered and
                // is patched by the conversation.updated event instead, so the setter is a no-op.
                setChats={() => undefined}
                messageInput={messageInput}
                setMessageInput={setMessageInput}
                attachment={attachment}
                setAttachment={setAttachment}
                previewUrl={previewUrl}
                setPreviewUrl={setPreviewUrl}
              />
            </div>
            )}
          </>
        )}
      </main>

      <aside className="inbox-panel" aria-label="Customer details">
        {!active ? (
          <div className="inbox-panel-empty">
            <span className="inbox-panel-empty-icon">
              <User size={20} />
            </span>
            <p>Customer details, AI insights and activity appear here once you open a conversation.</p>
          </div>
        ) : (
          <>
            <div className="inbox-panel-tabs" role="tablist">
              {(
                [
                  ['details', 'Details', User],
                  ['ai', 'AI', Sparkles],
                  ['activity', 'Activity', History],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={panelTab === id}
                  className={`inbox-panel-tab ${panelTab === id ? 'is-active' : ''}`}
                  onClick={() => {
                    setPanelTab(id);
                    if (id === 'ai' && !analysis && !aiLoading) void runAnalysis(false);
                  }}
                >
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>

            <div className="inbox-panel-body">
              {panelTab === 'details' && (
                <CustomerPanel
                  conversation={active}
                  customer={customerQuery.data}
                  customerLoading={customerQuery.isLoading}
                  customerError={customerQuery.error}
                  session={activeSession}
                  agents={agents}
                  teams={teamsQuery.data ?? []}
                  tags={tagsQuery.data ?? []}
                  notes={notesQuery.data ?? []}
                  notesLoading={notesQuery.isLoading}
                  profilePictureUrl={profilePicture}
                  savingProfile={customerMutations.update.isPending}
                  onSaveProfile={patch => {
                    if (!waId) return;
                    customerMutations.update.mutate({ waId, ...patch });
                  }}
                  onSetConsent={(status, source) => {
                    if (!waId) return;
                    customerMutations.setConsent.mutate(
                      { waId, status, source },
                      {
                        onError: error =>
                          showError(error instanceof Error ? error.message : 'Could not record consent'),
                      },
                    );
                  }}
                  onAddTag={tagId => mutations.addTag.mutate({ id: active.id, tagId })}
                  onRemoveTag={tagId => mutations.removeTag.mutate({ id: active.id, tagId })}
                  onAddNote={body => noteMutations.add.mutate(body)}
                  onDeleteNote={noteId => noteMutations.remove.mutate(noteId)}
                  addingNote={noteMutations.add.isPending}
                  onCreateFollowUp={(title, dueAt) =>
                    followUpMutations.create.mutate(
                      { conversationId: active.id, assigneeId: active.assigneeId ?? undefined, title, dueAt },
                      { onSuccess: () => showSuccess('Follow-up created') },
                    )
                  }
                />
              )}

              {panelTab === 'ai' && (
                <AiPanel
                  analysis={analysis}
                  status={aiStatusQuery.data}
                  loading={aiLoading}
                  error={aiError}
                  onAnalyze={force => void runAnalysis(force)}
                  onUseReply={text => {
                    setMessageInput(text);
                    setPanelTab('details');
                  }}
                  onSuggestReply={() => void redraftReply()}
                  suggesting={suggesting}
                  onSaveDetail={(key, value) => {
                    if (!waId) return;
                    customerMutations.update.mutate({
                      waId,
                      customFields: { ...(customerQuery.data?.customFields ?? {}), [key]: value },
                    });
                    showSuccess(`Saved ${key} to the customer profile`);
                  }}
                />
              )}

              {panelTab === 'activity' && (
                <div className="inbox-activity">
                  <p className="cc-label">Assignment history</p>
                  {historyQuery.isLoading ? (
                    <Skeleton height={64} />
                  ) : historyQuery.error ? (
                    <ErrorState error={historyQuery.error} onRetry={() => void historyQuery.refetch()} />
                  ) : (historyQuery.data ?? []).length === 0 ? (
                    <p className="cc-muted" style={{ fontSize: '0.8125rem' }}>
                      No assignment changes yet.
                    </p>
                  ) : (
                    <ol className="inbox-timeline">
                      {(historyQuery.data ?? []).map(entry => (
                        <li key={entry.id}>
                          <span className="inbox-timeline-dot" />
                          <div>
                            <strong>{entry.action.replace(/_/g, ' ')}</strong>
                            {entry.toAgentId && agentsById.get(entry.toAgentId) && (
                              <> to {agentsById.get(entry.toAgentId)!.name}</>
                            )}
                            {entry.reason && <div className="inbox-timeline-reason">{entry.reason}</div>}
                            <time dateTime={entry.createdAt}>{absoluteTime(entry.createdAt)}</time>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}

                  <p className="cc-label" style={{ marginTop: '1.25rem' }}>
                    Conversation timing
                  </p>
                  <dl className="inbox-cust-facts">
                    <div>
                      <dt>First message</dt>
                      <dd>{absoluteTime(active.firstInboundAt)}</dd>
                    </div>
                    <div>
                      <dt>First reply</dt>
                      <dd>{active.firstResponseAt ? absoluteTime(active.firstResponseAt) : 'Not answered yet'}</dd>
                    </div>
                    <div>
                      <dt>Resolved</dt>
                      <dd>{active.resolvedAt ? absoluteTime(active.resolvedAt) : '—'}</dd>
                    </div>
                    <div>
                      <dt>Last read</dt>
                      <dd>{absoluteTime(active.lastReadAt)}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      {transferOpen && active && (
        <TransferDialog
          conversation={active}
          agents={agents}
          teams={teamsQuery.data ?? []}
          online={online}
          currentAgentId={actorQuery.data?.agent?.id ?? null}
          transferring={mutations.transfer.isPending}
          onClose={() => setTransferOpen(false)}
          onTransfer={input =>
            mutations.transfer.mutate(
              { id: active.id, ...input },
              {
                onSuccess: conversation => {
                  const name = agents.find(a => a.id === input.toAgentId)?.name ?? 'your colleague';
                  showSuccess(`Handed to ${name}`, 'They get a briefing on what has been said and promised.');
                  setTransferOpen(false);
                  // The conversation is no longer mine; a briefing for it would be for them, not me.
                  briefedRef.current.add(conversation.id);
                },
                onError: error =>
                  showError(error instanceof Error ? error.message : 'Could not hand the conversation over'),
              },
            )
          }
        />
      )}

      <MediaLightbox
        items={imageMedia}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
      />

      {/* Connection pill, always visible so an operator never wonders whether the inbox is live. */}
      <div className={`inbox-live ${isConnected ? 'is-live' : ''}`} title={isConnected ? 'Live' : 'Offline'}>
        {isConnected ? <Wifi size={11} /> : <WifiOff size={11} />}
        <span>{isConnected ? 'Live' : 'Offline'}</span>
      </div>
    </div>
  );
}

export default Inbox;
