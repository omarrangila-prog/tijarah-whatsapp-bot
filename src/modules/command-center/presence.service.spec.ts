import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  let presence: PresenceService;

  beforeEach(() => {
    presence = new PresenceService();
  });

  afterEach(() => {
    presence.onModuleDestroy();
  });

  const beat = (agentId: string, over: Partial<Parameters<PresenceService['heartbeat']>[0]> = {}) =>
    presence.heartbeat({ agentId, name: agentId, color: '#000', ...over });

  it('reports an agent online once they have beaten', () => {
    expect(presence.isOnline('a')).toBe(false);
    beat('a');
    expect(presence.isOnline('a')).toBe(true);
  });

  it('drops an agent immediately on release, so sign-out stops routing work to them', () => {
    beat('a');
    presence.release('a');
    expect(presence.isOnline('a')).toBe(false);
  });

  it('lists who else is viewing a conversation, excluding the asker', () => {
    // Including the caller would make every conversation look contended by its own reader.
    beat('a', { viewingConversationId: 'c1' });
    beat('b', { viewingConversationId: 'c1' });
    beat('c', { viewingConversationId: 'c2' });

    const forA = presence.viewersOf('c1', 'a');
    expect(forA.map(v => v.agentId)).toEqual(['b']);
    expect(
      presence
        .viewersOf('c1')
        .map(v => v.agentId)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('moves an agent between conversations rather than accumulating them', () => {
    beat('a', { viewingConversationId: 'c1' });
    beat('a', { viewingConversationId: 'c2' });
    expect(presence.viewersOf('c1')).toEqual([]);
    expect(presence.viewersOf('c2').map(v => v.agentId)).toEqual(['a']);
  });

  it('carries a very recent typing flag through one beat that omits it', () => {
    // Typing must not flicker off between keystrokes while the agent is still in the same thread.
    beat('a', { viewingConversationId: 'c1', typing: true });
    beat('a', { viewingConversationId: 'c1' });
    expect(presence.viewersOf('c1')[0].typing).toBe(true);
  });

  it('does not carry typing across a change of conversation', () => {
    beat('a', { viewingConversationId: 'c1', typing: true });
    beat('a', { viewingConversationId: 'c2' });
    expect(presence.viewersOf('c2')[0].typing).toBe(false);
  });

  it('counts viewers per conversation for the operations view', () => {
    beat('a', { viewingConversationId: 'c1' });
    beat('b', { viewingConversationId: 'c1' });
    beat('c', { viewingConversationId: 'c2' });
    beat('d', {});

    const counts = presence.viewerCounts();
    expect(counts.get('c1')).toBe(2);
    expect(counts.get('c2')).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('orders the roster by name, so it does not reshuffle on every heartbeat', () => {
    // Every agent re-beats every 20 seconds. A recency sort would reorder the presence strip
    // continuously, which at a hundred agents makes it unreadable and moves the person you are
    // reaching for out from under the cursor.
    presence.heartbeat({ agentId: '3', name: 'Zara', color: '#000' });
    presence.heartbeat({ agentId: '1', name: 'Ayesha', color: '#000' });
    presence.heartbeat({ agentId: '2', name: 'Hamza', color: '#000' });

    expect(presence.online().map(p => p.name)).toEqual(['Ayesha', 'Hamza', 'Zara']);

    // Re-beating the first-listed agent must not move them.
    presence.heartbeat({ agentId: '1', name: 'Ayesha', color: '#000' });
    expect(presence.online().map(p => p.name)).toEqual(['Ayesha', 'Hamza', 'Zara']);
  });
});
