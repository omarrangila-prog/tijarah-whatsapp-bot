import { matchParty, normaliseName, scoreName, type PartyCandidate } from './party-match';

const party = (name: string, phone: string, lcode: string | null = null): PartyCandidate => ({ name, phone, lcode });

// The real spellings from the host's queue, which is what these rules have to cope with.
const DANYAL = party('DANYAL BHAI - (KAUSAR INNOVATIONS)', '03313687287', '0107015');
const CASH = party('CASH CUSTOMER', '03302417530', '0107077');
const ABC = party('ABC', '03000000000', null);

describe('normaliseName', () => {
  it('ignores case, punctuation and extra spacing', () => {
    expect(normaliseName('DANYAL BHAI - (KAUSAR INNOVATIONS)')).toBe('danyal bhai kausar innovations');
    expect(normaliseName('  M/S   A.N.S  ENTERPRISES ')).toBe('m s a n s enterprises');
  });

  it('keeps non-Latin letters, so an Urdu name is not emptied', () => {
    expect(normaliseName('دانیال')).toBe('دانیال');
  });
});

describe('scoreName', () => {
  it('ranks exact above whole-word above word-start', () => {
    expect(scoreName('cash customer', 'CASH CUSTOMER')).toBe(3);
    expect(scoreName('danyal', 'DANYAL BHAI - (KAUSAR INNOVATIONS)')).toBe(2);
    expect(scoreName('dany', 'DANYAL BHAI - (KAUSAR INNOVATIONS)')).toBe(1);
  });

  it('requires every word the person typed, so an unrelated extra word fails the match', () => {
    expect(scoreName('danyal kausar', 'DANYAL BHAI - (KAUSAR INNOVATIONS)')).toBeGreaterThan(0);
    expect(scoreName('danyal lahore', 'DANYAL BHAI - (KAUSAR INNOVATIONS)')).toBe(0);
  });

  it('does not match mid-word, which is what made short queries dangerous', () => {
    // "ali" inside "Pakistani" must not make this customer a candidate.
    expect(scoreName('ali', 'PAKISTANI FORMICA LIMITED')).toBe(0);
    expect(scoreName('ali', 'ALI TRADERS')).toBe(2);
  });

  it('is empty-safe', () => {
    expect(scoreName('', 'ALI TRADERS')).toBe(0);
    expect(scoreName('ali', '')).toBe(0);
    expect(scoreName('   ', 'ALI TRADERS')).toBe(0);
  });
});

describe('matchParty', () => {
  it('finds the one customer a first name refers to', () => {
    const result = matchParty('danyal', [DANYAL, CASH, ABC]);
    expect(result).toEqual({ kind: 'one', party: DANYAL });
  });

  it('says nothing was found rather than offering the nearest thing', () => {
    expect(matchParty('zubair', [DANYAL, CASH])).toEqual({ kind: 'none' });
  });

  it('asks when two different customers share the typed name', () => {
    const other = party('DANYAL TRADERS', '03001112222', '0107099');
    const result = matchParty('danyal', [DANYAL, other]);
    expect(result.kind).toBe('several');
    expect(result.kind === 'several' && result.parties).toHaveLength(2);
  });

  it('prefers an exact match over customers that merely contain the word', () => {
    const longer = party('CASH CUSTOMER WALK IN', '03009998888', '0107100');
    expect(matchParty('cash customer', [CASH, longer])).toEqual({ kind: 'one', party: CASH });
  });

  it('treats two spellings of one account as one customer, not an ambiguity', () => {
    const alt = party('DANYAL BHAI', '03313687287', '0107015');
    expect(matchParty('danyal', [DANYAL, alt])).toEqual({ kind: 'one', party: DANYAL });
  });

  it('treats one phone with two spellings as one customer', () => {
    const alt = party('DANYAL BHAI KAUSAR', '03313687287', null);
    const result = matchParty('danyal', [DANYAL, alt]);
    // The row carrying the account code is the useful one — a ledger is fetched by code.
    expect(result).toEqual({ kind: 'one', party: DANYAL });
  });

  it('asks when the only matches have no account code and different phones', () => {
    const a = party('ABC TRADING', '03001112222', null);
    const b = party('ABC ENTERPRISES', '03003334444', null);
    expect(matchParty('abc', [a, b]).kind).toBe('several');
  });

  it('is empty-safe', () => {
    expect(matchParty('danyal', [])).toEqual({ kind: 'none' });
    expect(matchParty('', [DANYAL])).toEqual({ kind: 'none' });
  });
});
