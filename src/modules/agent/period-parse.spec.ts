import { parsePartyCode, parsePeriod } from './period-parse';

/**
 * The periods and account codes real clients typed on 7 October, every one of which was
 * dropped — the person asked for a month or one account and silently received the whole book.
 */
const NOW = new Date('2026-10-07T12:30:00Z');

describe('parsePeriod', () => {
  const p = (text: string) => parsePeriod(text, NOW);

  it('reads the messages that were silently ignored in production', () => {
    expect(p('January ledger de')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(p('send me ledger from 1 july to 1 oct')).toEqual({ from: '2026-07-01', to: '2026-10-01' });
    expect(p('send me 30 days ledger')).toEqual({ from: '2026-09-07', to: '2026-10-07' });
    expect(p('2026 ledger')).toEqual({ from: '2026-01-01', to: '2026-10-07' });
    expect(p('January 2026 ledger only')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    // "to till date" means up to today, not the end of January.
    expect(p('Need ledger from January to till date')).toEqual({ from: '2026-01-01', to: '2026-10-07' });
  });

  it('prefers an explicit range over anything less specific', () => {
    expect(p('ledger 2026-07-01 to 2026-09-30')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    // "1 July to 30 September" must not be read as just "July".
    expect(p('sales book 1 july to 30 september')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
  });

  it('reads a month range with no days, to the end of the closing month', () => {
    expect(p('july to september')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(p('jan-mar 2025')).toEqual({ from: '2025-01-01', to: '2025-03-31' });
  });

  it('rolls a backwards range into the next year', () => {
    expect(p('1 nov to 31 jan')).toEqual({ from: '2026-11-01', to: '2027-01-31' });
  });

  it('reads the relative phrases, in English and Roman Urdu', () => {
    expect(p('this month ka ledger')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(p('last month ledger')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(p('is saal ka ledger')).toEqual({ from: '2026-01-01', to: '2026-10-07' });
    expect(p('last year ledger')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('crosses a year end for last month in January', () => {
    expect(parsePeriod('last month ledger', new Date('2026-01-15T00:00:00Z'))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('gets February right in a leap year rather than assuming 30 days', () => {
    expect(parsePeriod('february ledger', new Date('2024-06-01T00:00:00Z'))).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
  });

  it('returns nothing when no period was named, so the host default stands', () => {
    expect(p('send me the ledger')).toBeNull();
    expect(p('trial balance')).toBeNull();
    expect(p('my ledger')).toBeNull();
  });

  it('does not read an invoice number as a year or a day count', () => {
    expect(p('sale invoice 179')).toBeNull();
    expect(p('invoice 1990')).toBeNull();
  });
});

describe("the date phrases in Tijarah's specification", () => {
  const p = (text: string) => parsePeriod(text, NOW);

  it('reads the day-counts they listed', () => {
    expect(p('Mujhe last 10 days ka ledger do')).toEqual({ from: '2026-09-27', to: '2026-10-07' });
    expect(p('Mujhe last 15 days ka ledger do')).toEqual({ from: '2026-09-22', to: '2026-10-07' });
    expect(p('Mujhe last 30 days ka ledger do')).toEqual({ from: '2026-09-07', to: '2026-10-07' });
  });

  it('reads day-first dates, which is how Pakistan writes them', () => {
    // 01-03-2026 is 1 March, never 3 January — the other reading returns the wrong quarter.
    expect(p('01-01-2026 to 31-03-2026')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(p('ledger 1/7/2026 to 30/9/2026')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
  });

  it('reads the Roman Urdu range', () => {
    expect(p('1 Jan se 31 March tak')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(p('Mujhe 1 January se 31 March tak ka ledger do')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('reads today and up-to-date', () => {
    expect(p('Mujhe aaj tak ka ledger do')).toEqual({ from: '2026-01-01', to: '2026-10-07' });
    expect(p('up to date ledger')).toEqual({ from: '2026-01-01', to: '2026-10-07' });
    expect(p('today ka ledger')).toEqual({ from: '2026-10-07', to: '2026-10-07' });
  });

  it('leaves a plain request to the host default of 7 days', () => {
    // Their rule: only when the person gives no range at all.
    expect(p('Mujhe ledger do')).toBeNull();
  });
});

describe('parsePartyCode', () => {
  it("reads the host's own bare numeric codes, which were being dropped", () => {
    expect(parsePartyCode('send me 30 days customer ledger for this 0107170')).toBe('0107170');
    expect(parsePartyCode('send me general ledger for this code 0101001')).toBe('0101001');
    expect(parsePartyCode('sent me ledger for this lcode=0101001')).toBe('0101001');
  });

  it('still reads the prefixed form', () => {
    expect(parsePartyCode('customer ledger for C-1005')).toBe('C-1005');
    expect(parsePartyCode('ledger C-1005')).toBe('C-1005');
  });

  it('never reads a document number as an account code', () => {
    // The whole reason a bare number needs a pointing word in front of it.
    expect(parsePartyCode('sale invoice 179')).toBeNull();
    expect(parsePartyCode('send me 30 days ledger')).toBeNull();
    expect(parsePartyCode('trial balance')).toBeNull();
  });
});

describe('"kal" in a request for figures', () => {
  it('is yesterday', () => {
    expect(parsePeriod('kal ki sale', NOW)).toEqual({ from: '2026-10-06', to: '2026-10-06' });
    expect(parsePeriod('yesterday sales book', NOW)).toEqual({ from: '2026-10-06', to: '2026-10-06' });
  });
});
