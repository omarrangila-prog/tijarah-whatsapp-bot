import { pickLeastBusy } from './routing.service';
import type { Agent } from './entities/agent.entity';

const agent = (id: string): Agent => ({ id, name: id, color: '#000' }) as Agent;

describe('pickLeastBusy', () => {
  it('picks the agent holding the fewest open conversations', () => {
    const candidates = [agent('a'), agent('b'), agent('c')];
    const load = new Map([
      ['a', 7],
      ['b', 2],
      ['c', 5],
    ]);
    expect(pickLeastBusy(candidates, load).id).toBe('b');
  });

  it('treats an agent absent from the load map as idle', () => {
    // A brand-new agent has no rows in the group-by, so their absence must read as zero rather than
    // as unknown — otherwise the person with capacity is the one who never gets work.
    const candidates = [agent('busy'), agent('fresh')];
    expect(pickLeastBusy(candidates, new Map([['busy', 3]])).id).toBe('fresh');
  });

  it('breaks ties deterministically so an unfair split is reproducible', () => {
    const candidates = [agent('zoe'), agent('adam'), agent('mia')];
    const load = new Map([
      ['zoe', 4],
      ['adam', 4],
      ['mia', 4],
    ]);
    expect(pickLeastBusy(candidates, load).id).toBe('adam');
    // Stable across calls — an unstable tiebreak makes a bad distribution impossible to diagnose.
    expect(pickLeastBusy(candidates, load).id).toBe('adam');
  });

  it('does not mutate the caller’s candidate list', () => {
    const candidates = [agent('c'), agent('a'), agent('b')];
    const before = candidates.map(a => a.id);
    pickLeastBusy(candidates, new Map());
    expect(candidates.map(a => a.id)).toEqual(before);
  });
});
