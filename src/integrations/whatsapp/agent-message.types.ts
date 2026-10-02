/**
 * The normalized shape a channel hands to the agent, and the shape it hands back.
 *
 * This file is the entire contract between "a message arrived somewhere" and "the agent
 * reasoned about it". WhatsApp is the first channel to speak it; the dashboard, a webhook
 * or an email adapter can speak the same thing without the runtime learning a second
 * vocabulary.
 *
 * Two properties are load-bearing:
 *
 *   * **`senderRole` is resolved before the agent sees the message, never by the agent.**
 *     A model asked to work out whether the person messaging it is an admin will, sooner or
 *     later, be talked into deciding they are — that is what prompt injection is. The role
 *     is decided by `ContactMapper` from the allowlist and the contact tables, arrives on
 *     the envelope, and everything downstream treats it as settled fact.
 *
 *   * **`text` is untrusted, always.** It is a customer's words, and it may contain
 *     instructions aimed at the model. Nothing in this envelope may be interpolated into a
 *     system prompt, and the runtime marks it as data when it builds the turn.
 */

/** Where a message came from. Only `whatsapp` exists today; the field prevents a rewrite later. */
export type AgentChannel = 'whatsapp';

/**
 * Who is talking.
 *
 * `admin` and `staff` map onto the existing `ApiKeyRole` hierarchy; `customer` and `unknown`
 * have no key at all and are the reason the customer-facing tool set exists separately.
 */
/**
 * `client` is a Tijarah Books user: a number mapped to a company in `bot_users` or resolved
 * from the host's client directory. Not staff — they may not reach the business's other
 * customers — and not a receivables customer either: their books are their own company's.
 */
export type SenderRole = 'admin' | 'staff' | 'client' | 'customer' | 'unknown';

export type AgentMessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'other';

export interface AgentAttachment {
  type: AgentMessageType;
  /** The engine's media id or a resolved URL. Never a filesystem path — see MediaHandler. */
  reference: string;
  mimeType: string | null;
  fileName: string | null;
  byteSize: number | null;
  /** Text the sender typed alongside the file. Untrusted, like `text`. */
  caption: string | null;
}

/**
 * One inbound turn, normalized.
 *
 * Mirrors the shape in the brief exactly, with the additions the runtime cannot work
 * without: the session the message arrived on (this deployment is multi-session), the
 * resolved conversation row, and whether the sender is known to the CRM.
 */
export interface NormalizedAgentMessage {
  channel: AgentChannel;
  messageId: string;
  senderPhone: string;
  senderRole: SenderRole;
  /** Stable per counterparty, so the agent's memory and the inbox agree on "the thread". */
  conversationId: string;
  messageType: AgentMessageType;
  /** Untrusted user input. Never interpolated into a system prompt. */
  text: string;
  attachments: AgentAttachment[];
  timestamp: string;

  /* ---- context the runtime needs, resolved before the agent runs ---- */

  /** Which WhatsApp session received it. Every tool call is scoped to this. */
  sessionId: string;
  /** The WhatsApp JID, needed to reply. */
  chatId: string;
  /** The command-center conversation row, when one exists. */
  internalConversationId: string | null;
  /** The CRM contact this number resolves to, when it resolves to exactly one. */
  contactId: string | null;
  senderName: string | null;
  /** True when the message is a group message — the agent declines those by default. */
  isGroup: boolean;
}

/**
 * What the agent produces.
 *
 * `text` is what the sender receives. `actions` records what the turn actually did, so the
 * audit trail and the UI can show tool calls and approval decisions without re-deriving
 * them from logs.
 */
export interface AgentReply {
  text: string;
  /** Documents the turn decided to send, already permission-checked. */
  attachments: OutboundAttachment[];
  actions: AgentActionRecord[];
  /** Set when the turn produced something waiting on a human. */
  pendingApprovalId: string | null;
  /** False when the runtime decided the correct response was silence. */
  shouldReply: boolean;
}

export interface OutboundAttachment {
  kind: 'document' | 'image';
  /** A URL or base64 payload the engine can send. Never an internal path. */
  data: string;
  fileName: string;
  mimeType: string;
}

export interface AgentActionRecord {
  tool: string;
  /** What the permission layer decided, and why. */
  decision: 'allowed' | 'requires_approval' | 'denied';
  reason: string | null;
  /** Present when the call actually ran. */
  ok?: boolean;
  errorMessage?: string | null;
  approvalId?: string | null;
  durationMs?: number;
}

/**
 * A scheduled or system-originated turn.
 *
 * Cron does not send messages (brief §11). It raises one of these, the agent reasons about
 * it, and anything outbound goes through the same permission layer as a human's request.
 * Modelling it as an agent input rather than a send path is what keeps one set of rules.
 */
export interface AgentSystemEvent {
  channel: AgentChannel;
  eventType:
    | 'payment_due'
    | 'invoice_overdue'
    | 'promise_date_passed'
    | 'payment_received'
    | 'daily_summary'
    | 'message_retry'
    | 'escalation';
  /** Idempotency: the same event raised twice must produce one turn. */
  eventKey: string;
  /** Who the event concerns, when it concerns someone. */
  subjectPhone: string | null;
  subjectContactId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}
