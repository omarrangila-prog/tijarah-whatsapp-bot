import type { Conversation } from '../services/commandCenter';

/**
 * Merge an updated conversation over the cached copy, keeping fields the update does not carry.
 *
 * The websocket payload is the raw conversation ROW. Only the tag mutations broadcast a view with
 * `tags` attached — every status, priority and assignment change, and every incoming message, sends
 * the row alone. Assigning it wholesale therefore deleted `tags` from a cached view, and the next
 * render crashed on `conversation.tags.length`, blanking the whole dashboard.
 *
 * Merging is also the correct semantics, not merely a crash guard: those events genuinely do not
 * change the tags, so the ones already known are still true. An incoming EMPTY array is respected
 * as a real value — that is what "the last tag was removed" looks like — while an absent field
 * means "this update has nothing to say about tags".
 *
 * Pure and dependency-free so it can be unit-tested without a query client.
 */
export function mergeConversation(previous: Conversation | undefined, incoming: Conversation): Conversation {
  if (!previous) return { ...incoming, tags: incoming.tags ?? [] };
  return { ...previous, ...incoming, tags: incoming.tags ?? previous.tags ?? [] };
}
