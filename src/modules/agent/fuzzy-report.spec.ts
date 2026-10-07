import { editDistance, fuzzyReport, REPORT_WORD_SETS } from './fuzzy-report';

/**
 * Misspelled report names, which clients sent on the first live day and were answered with a
 * menu. A near-miss is corrected; an ambiguous one is not, because the cost of guessing here
 * is a real PDF of the wrong report.
 */
describe('fuzzyReport', () => {
  const f = (text: string) => fuzzyReport(text, REPORT_WORD_SETS);

  it('corrects the typos real clients sent', () => {
    expect(f('send me trail balance')).toBe('trial_balance');
    expect(f('balnce sheet')).toBe('balance_sheet');
    expect(f('stok summary')).toBe('stock_summary');
    expect(f('incom statment')).toBe('income_statement');
    expect(f('custmer ledger')).toBe('customer_ledger');
  });

  it('keeps a specific ledger specific, rather than falling back to the general one', () => {
    // The bug this prevents: "custmer ledger" returning every account's ledger.
    expect(f('vendr ledger')).toBe('vendor_ledger');
    expect(f('item ledgr')).toBe('item_ledger');
    expect(f('expnse ledger')).toBe('expense_ledger');
  });

  it('reads a correct spelling unchanged', () => {
    expect(f('trial balance')).toBe('trial_balance');
    expect(f('customer ledger')).toBe('customer_ledger');
  });

  it('refuses to choose when the words fit more than one report', () => {
    // "ledger" alone is four reports; a guess sends somebody the wrong book.
    expect(f('ledger')).toBeNull();
    expect(f('report')).toBeNull();
  });

  it('does not match something that is not a report at all', () => {
    expect(f('easy paisa')).toBeNull();
    expect(f('jazzcash')).toBeNull();
    expect(f('hello bhai')).toBeNull();
  });

  it('treats an adjacent swap as a near miss however short the word', () => {
    // "trail" for "trial" is edit distance 2, which a five-letter word would not otherwise get.
    expect(editDistance('trail', 'trial')).toBe(2);
    expect(f('trail balance')).toBe('trial_balance');
  });

  it('stops short of correcting a genuinely different word', () => {
    // "sales" must not become "cash", however the distances fall.
    expect(f('cash book')).toBe('cash_bank_book');
    expect(f('sales book')).toBe('sales_book_report');
  });
});
