import { accountKind, actHeadForLedger, ledgerForKind } from './account-kind';

/**
 * The prefixes are measured, not assumed: the live chart for company 1006 returns exactly the
 * 0104/0107 codes for RECEIVABLE and the 0101 codes for BANK and CASH.
 */
describe('accountKind', () => {
  it('reads the kind out of the code prefix', () => {
    expect(accountKind('0107015')).toBe('customer');
    expect(accountKind('0104014')).toBe('customer');
    expect(accountKind('0105001')).toBe('vendor');
    expect(accountKind('0101001')).toBe('bank');
  });

  it('says unknown rather than guessing an unmapped prefix', () => {
    // 0102/0103/0106/0108 exist in the chart but their meaning has not been confirmed, and a
    // wrong guess sends somebody the wrong ledger.
    expect(accountKind('0102001')).toBe('unknown');
    expect(accountKind('0108001')).toBe('unknown');
  });

  it('is safe on anything that is not a code', () => {
    expect(accountKind(null)).toBe('unknown');
    expect(accountKind('')).toBe('unknown');
    expect(accountKind('C-1005')).toBe('unknown');
    expect(accountKind('12')).toBe('unknown');
  });
});

describe('ledgerForKind', () => {
  it('sends each kind to the ledger that answers for it', () => {
    expect(ledgerForKind('customer')).toBe('customer_ledger');
    expect(ledgerForKind('vendor')).toBe('vendor_ledger');
    expect(ledgerForKind('expense')).toBe('expense_ledger');
  });

  it('falls back to the general ledger, which can show any account', () => {
    expect(ledgerForKind('bank')).toBe('general_ledger');
    expect(ledgerForKind('unknown')).toBe('general_ledger');
  });
});

describe('actHeadForLedger', () => {
  it('asks the host for the narrowest list it actually filters', () => {
    expect(actHeadForLedger('customer_ledger')).toBe('RECEIVABLE');
    expect(actHeadForLedger('cash_bank_book')).toBe('BANK');
    // Everything else returns the whole chart whatever is asked, so ALL is honest.
    expect(actHeadForLedger('vendor_ledger')).toBe('ALL');
    expect(actHeadForLedger('general_ledger')).toBe('ALL');
  });
});
