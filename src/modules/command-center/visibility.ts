/**
 * Who may see which conversation in a shared inbox.
 *
 * Kept as pure functions with no database or Nest dependency so the rule can be unit-tested
 * exhaustively and — more importantly — so the SAME rule backs every enforcement point. The list
 * query, the single-conversation read, and the realtime fan-out each fence differently (SQL,
 * exception, recipient set), and a privacy rule re-expressed three times is a privacy rule with
 * three chances to disagree with itself.
 */

/** The identity behind a request: the agent an API key resolves to, and that key's role. */
export interface ConversationActor {
  /** Null when the calling key is not linked to any agent — it then owns nothing. */
  agentId: string | null;
  role: 'admin' | 'operator' | 'viewer';
}

/**
 * Whether `actor` may see a conversation currently assigned to `assigneeId`.
 *
 * The unassigned case is deliberately visible to everyone: unassigned conversations are the shared
 * queue, and an agent who cannot see the queue cannot pick work up.
 */
export function canSeeConversation(
  assigneeId: string | null | undefined,
  actor: ConversationActor,
  privateAssignedChats: boolean,
): boolean {
  if (!privateAssignedChats) return true;
  // Supervision is the one job that cannot be done from behind the fence.
  if (actor.role === 'admin') return true;
  // The shared queue stays shared.
  if (assigneeId == null) return true;
  return actor.agentId != null && assigneeId === actor.agentId;
}

/**
 * Whether the actor needs any visibility predicate at all.
 *
 * Lets callers skip building a WHERE clause (and the parameter binding that goes with it) in the
 * common cases: privacy off, or an admin who would match every row anyway.
 */
export function needsVisibilityFence(actor: ConversationActor, privateAssignedChats: boolean): boolean {
  return privateAssignedChats && actor.role !== 'admin';
}

/**
 * The set of API keys that should receive a realtime update about a conversation.
 *
 * Returns `null` to mean "no restriction — broadcast as usual", which keeps the unrestricted path
 * free of any per-recipient work. Otherwise returns the key ids allowed to know: the assignee's own
 * key plus every admin key, since admins see everything.
 *
 * Key ids rather than agent ids because the socket registry is keyed by API key — that is the only
 * identity a connected socket actually carries.
 */
export function conversationRecipientKeyIds(
  assigneeKeyId: string | null | undefined,
  adminKeyIds: readonly string[],
  privateAssignedChats: boolean,
  assigned: boolean,
): string[] | null {
  if (!privateAssignedChats) return null;
  // An unassigned conversation is queue activity everyone is entitled to see.
  if (!assigned) return null;
  const recipients = new Set<string>(adminKeyIds);
  if (assigneeKeyId) recipients.add(assigneeKeyId);
  return [...recipients];
}
