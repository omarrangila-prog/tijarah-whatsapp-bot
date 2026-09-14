import type { ConversationFilters } from '../services/commandCenter';

/** The saved views down the inbox's left rail. */
export type InboxView = 'all' | 'mine' | 'unassigned' | 'unread' | 'waiting' | 'resolved' | 'starred';

/**
 * Translate a saved view into the filter arguments the API expects.
 *
 * Pure and stated once, so the rail's labels and the query they produce cannot drift apart —
 * "Waiting" is the WAITING status and nothing else, and that claim is testable here rather than
 * buried in a component.
 */
export function filtersForView(view: InboxView): Partial<ConversationFilters> {
  switch (view) {
    case 'mine':
      // Resolved server-side against the calling API key's linked agent.
      return { assigneeId: 'me' };
    case 'unassigned':
      return { assigneeId: 'unassigned' };
    case 'unread':
      return { unreadOnly: true };
    case 'waiting':
      return { status: 'waiting' };
    case 'resolved':
      return { status: 'resolved' };
    case 'starred':
      return { starredOnly: true };
    case 'all':
    default:
      return {};
  }
}
