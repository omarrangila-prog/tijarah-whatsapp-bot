import { canSeeConversation, conversationRecipientKeyIds, needsVisibilityFence } from './visibility';
import type { ConversationActor } from './visibility';

const hassan: ConversationActor = { agentId: 'agent-hassan', role: 'operator' };
const ayesha: ConversationActor = { agentId: 'agent-ayesha', role: 'operator' };
const admin: ConversationActor = { agentId: 'agent-admin', role: 'admin' };
const viewer: ConversationActor = { agentId: 'agent-viewer', role: 'viewer' };
const unlinked: ConversationActor = { agentId: null, role: 'operator' };

describe('canSeeConversation', () => {
  describe('with the fence off', () => {
    it('shows every conversation to everyone, which is the previous behaviour', () => {
      expect(canSeeConversation('agent-ayesha', hassan, false)).toBe(true);
      expect(canSeeConversation(null, unlinked, false)).toBe(true);
      expect(canSeeConversation('agent-hassan', viewer, false)).toBe(true);
    });
  });

  describe('with the fence on', () => {
    it("hides a colleague's conversation", () => {
      expect(canSeeConversation('agent-ayesha', hassan, true)).toBe(false);
      expect(canSeeConversation('agent-hassan', ayesha, true)).toBe(false);
    });

    it('shows an agent their own conversation', () => {
      expect(canSeeConversation('agent-hassan', hassan, true)).toBe(true);
    });

    it('keeps the unassigned queue visible to everyone so new work can be claimed', () => {
      expect(canSeeConversation(null, hassan, true)).toBe(true);
      expect(canSeeConversation(undefined, ayesha, true)).toBe(true);
      expect(canSeeConversation(null, unlinked, true)).toBe(true);
    });

    it('lets an admin see everything, because supervision cannot work behind the fence', () => {
      expect(canSeeConversation('agent-ayesha', admin, true)).toBe(true);
      expect(canSeeConversation('agent-hassan', admin, true)).toBe(true);
      expect(canSeeConversation(null, admin, true)).toBe(true);
    });

    it('grants a key with no linked agent nothing but the queue', () => {
      // An unlinked key owns no conversations, so "assigned to me" can never match. The danger
      // would be a null agentId accidentally matching a null assigneeId and exposing everything.
      expect(canSeeConversation('agent-ayesha', unlinked, true)).toBe(false);
      expect(canSeeConversation(null, unlinked, true)).toBe(true);
    });

    it('does not exempt viewers, who are read-only rather than privileged', () => {
      expect(canSeeConversation('agent-hassan', viewer, true)).toBe(false);
    });
  });
});

describe('needsVisibilityFence', () => {
  it('is false when the fence is off, so the query is left untouched', () => {
    expect(needsVisibilityFence(hassan, false)).toBe(false);
    expect(needsVisibilityFence(admin, false)).toBe(false);
  });

  it('is false for an admin, who would match every row anyway', () => {
    expect(needsVisibilityFence(admin, true)).toBe(false);
  });

  it('is true for an operator under the fence', () => {
    expect(needsVisibilityFence(hassan, true)).toBe(true);
    expect(needsVisibilityFence(unlinked, true)).toBe(true);
  });
});

describe('conversationRecipientKeyIds', () => {
  it('returns null (broadcast as usual) when the fence is off', () => {
    expect(conversationRecipientKeyIds('key-ayesha', ['key-admin'], false, true)).toBeNull();
  });

  it('returns null for an unassigned conversation, which is shared queue activity', () => {
    expect(conversationRecipientKeyIds(null, ['key-admin'], true, false)).toBeNull();
  });

  it('restricts an assigned conversation to its owner plus the admins', () => {
    const recipients = conversationRecipientKeyIds('key-ayesha', ['key-admin'], true, true);
    expect(recipients).toEqual(expect.arrayContaining(['key-ayesha', 'key-admin']));
    expect(recipients).toHaveLength(2);
  });

  it('does not include an unrelated agent', () => {
    expect(conversationRecipientKeyIds('key-ayesha', [], true, true)).toEqual(['key-ayesha']);
  });

  it('still reaches the admins when the assignee holds no API key', () => {
    // A conversation can be assigned to a teammate who was never issued a key; the update must
    // still reach supervisors rather than being dropped entirely.
    expect(conversationRecipientKeyIds(null, ['key-admin'], true, true)).toEqual(['key-admin']);
  });

  it('de-duplicates when the assignee is themselves an admin', () => {
    expect(conversationRecipientKeyIds('key-admin', ['key-admin'], true, true)).toEqual(['key-admin']);
  });
});
