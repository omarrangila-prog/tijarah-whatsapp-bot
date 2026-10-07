import { detectIntent } from './mock-reasoning.provider';

/**
 * A party named in a ledger request must never widen to the whole book.
 *
 * Every message here is one a real client actually sent on 7 Oct 2026. "Anas boltan ka ledger
 * bhejo" was answered with the entire General Ledger — a real PDF, silently the wrong one —
 * because the bare `ledger` rule matched and the name was dropped. That is a disclosure, not a
 * near miss, which is why these are regression tests rather than feature tests.
 */
describe('a named party in a ledger request', () => {
  const report = (text: string) => {
    const intent = detectIntent(text);
    if (intent.kind !== 'report') throw new Error(`expected a report intent, got ${intent.kind}`);
    return intent;
  };

  it('reads the name out of Roman Urdu word order', () => {
    // The exact message that sent somebody the whole general ledger.
    const intent = report('Anas boltan ka ledger bhejo');
    expect(intent.partyName).toBe('Anas boltan');
    expect(intent.partyCode).toBeNull();
  });

  it('reads the name out of English word order', () => {
    expect(report('send me the ledger of Danyal Bhai').partyName).toBe('Danyal Bhai');
    expect(report('ledger for Ahmed Traders').partyName).toBe('Ahmed Traders');
  });

  it('still prefers an explicit account code over a name', () => {
    const intent = report('customer ledger for C-1005');
    expect(intent.partyCode).toBe('C-1005');
    expect(intent.partyName).toBeNull();
  });

  it('does not invent a party when none was named', () => {
    // These must stay whole-book requests: the person asked for the whole book.
    expect(report('send me the general ledger').partyName).toBeNull();
    expect(report('ledger bhejo').partyName).toBeNull();
    expect(report('Trial balance so').partyName).toBeNull();
  });

  it('does not read request words as a customer name', () => {
    const intent = report('mujhe ledger chahiye');
    expect(intent.partyName).toBeNull();
  });

  it('keeps the dates alongside the name', () => {
    const intent = report('Danyal ka ledger 2026-07-01 to 2026-09-30');
    expect(intent.partyName).toBe('Danyal');
    expect(intent.from).toBe('2026-07-01');
    expect(intent.to).toBe('2026-09-30');
  });
});
