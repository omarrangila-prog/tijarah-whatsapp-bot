import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConversation } from './conversationMerge.ts';
import type { Conversation, Tag } from '../services/commandCenter.ts';

const tag = (id: string, name: string): Tag => ({ id, name, color: '#6366f1', createdAt: '2026-01-01T00:00:00Z' });

const conversation = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1',
    sessionId: 's1',
    chatId: '923001234567@c.us',
    chatName: 'Bilal',
    kind: 'individual',
    status: 'open',
    priority: 'normal',
    assigneeId: null,
    teamId: null,
    starred: false,
    muted: false,
    lastMessageAt: '2026-01-01T10:00:00Z',
    lastMessagePreview: 'hello',
    lastMessageType: 'text',
    lastMessageDirection: 'incoming',
    unreadCount: 0,
    manualUnread: false,
    firstInboundAt: null,
    firstResponseAt: null,
    pendingSince: null,
    resolvedAt: null,
    lastReadAt: null,
    createdAt: '2026-01-01T09:00:00Z',
    updatedAt: '2026-01-01T10:00:00Z',
    tags: [],
    ...over,
  }) as Conversation;

describe('mergeConversation', () => {
  test('keeps the cached tags when the update does not carry any', () => {
    // The regression this pins: the websocket sends the raw conversation ROW, so a status change
    // overwrote a cached view and deleted its `tags`. The next render then crashed on
    // `conversation.tags.length` and blanked the entire dashboard.
    const cached = conversation({ tags: [tag('t1', 'Sales')] });
    const incoming = { ...conversation({ status: 'waiting' }), tags: undefined } as unknown as Conversation;

    const merged = mergeConversation(cached, incoming);

    assert.equal(merged.status, 'waiting');
    assert.deepEqual(merged.tags, [tag('t1', 'Sales')]);
  });

  test('takes the incoming tags when the update does carry them', () => {
    const cached = conversation({ tags: [tag('t1', 'Sales')] });
    assert.deepEqual(mergeConversation(cached, conversation({ tags: [tag('t2', 'VIP')] })).tags, [tag('t2', 'VIP')]);
  });

  test('an incoming empty list is a real value, not a missing one', () => {
    // Removing the last tag must actually clear it: [] means "none left", undefined means "this
    // update says nothing about tags".
    const cached = conversation({ tags: [tag('t1', 'Sales')] });
    assert.deepEqual(mergeConversation(cached, conversation({ tags: [] })).tags, []);
  });

  test('never yields an undefined tags field, even with nothing cached', () => {
    const incoming = { ...conversation(), tags: undefined } as unknown as Conversation;
    assert.deepEqual(mergeConversation(undefined, incoming).tags, []);
  });

  test('incoming fields win over the cached copy', () => {
    const merged = mergeConversation(
      conversation({ unreadCount: 0, priority: 'normal' }),
      conversation({ unreadCount: 3, priority: 'urgent' }),
    );
    assert.equal(merged.unreadCount, 3);
    assert.equal(merged.priority, 'urgent');
  });
});
