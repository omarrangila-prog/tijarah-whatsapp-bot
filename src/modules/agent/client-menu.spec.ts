import {
  advance,
  datesPrompt,
  periodFor,
  periodMenu,
  readChoice,
  readDates,
  reportMenu,
  rootMenu,
  stepFor,
  type MenuReport,
} from './client-menu';

const REPORTS: MenuReport[] = [
  { documentType: 'balance_sheet', displayName: 'Balance Sheet', datedByDefault: true },
  { documentType: 'customer_ledger', displayName: 'Customer Ledger', datedByDefault: true },
  { documentType: 'trial_balance', displayName: 'Trial Balance', datedByDefault: true },
  { documentType: 'stock_summary', displayName: 'Stock Summary', datedByDefault: false },
];

// A Wednesday in October, so "last month" crosses a month boundary with 30/31 days either side.
const NOW = new Date('2026-10-07T11:15:00Z');

describe('readChoice', () => {
  it('reads a number however a person types it', () => {
    expect(readChoice('2')).toBe(2);
    expect(readChoice(' 2. ')).toBe(2);
    expect(readChoice('option 2')).toBe(2);
    expect(readChoice('2)')).toBe(2);
  });

  it('is not fooled by a number inside a sentence', () => {
    // "invoice 179" must reach the ordinary reasoning, not be read as menu option 179.
    expect(readChoice('invoice 179')).toBeNull();
    expect(readChoice('send me 2 copies')).toBeNull();
    expect(readChoice('')).toBeNull();
  });
});

describe('readDates', () => {
  it('reads a typed period', () => {
    expect(readDates('2026-07-01 to 2026-09-30')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(readDates('from 2026-01-01 - 2026-01-31 please')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('returns nothing for something that is not a period', () => {
    expect(readDates('july to september')).toBeNull();
    expect(readDates('3')).toBeNull();
  });
});

describe('periodFor', () => {
  it('resolves the named periods against the clock', () => {
    expect(periodFor(1, NOW)).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(periodFor(2, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(periodFor(3, NOW)).toEqual({ from: '2026-01-01', to: '2026-10-07' });
    expect(periodFor(4, NOW)).toEqual({ from: null, to: null });
  });

  it('rolls back across a year end', () => {
    expect(periodFor(2, new Date('2026-01-15T00:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('has no option beyond the four named ones', () => {
    expect(periodFor(5, NOW)).toBeNull();
    expect(periodFor(0, NOW)).toBeNull();
  });
});

describe('stepFor', () => {
  it('recognises each menu from the message that was sent', () => {
    expect(stepFor(rootMenu())).toEqual({ kind: 'root' });
    expect(stepFor(reportMenu(REPORTS))).toEqual({ kind: 'reports' });
    expect(stepFor(periodMenu('Customer Ledger'))).toEqual({ kind: 'period', documentType: 'Customer Ledger' });
    expect(stepFor(datesPrompt('Customer Ledger'))).toEqual({ kind: 'dates', documentType: 'Customer Ledger' });
  });

  it('treats an ordinary reply as no menu at all', () => {
    expect(stepFor('Trial Balance is on its way — it will arrive here shortly.')).toBeNull();
    expect(stepFor(null)).toBeNull();
  });
});

describe('advance', () => {
  const root = stepFor(rootMenu());
  const reports = stepFor(reportMenu(REPORTS));

  it('turns "1" at the root into the receivables period question', () => {
    const action = advance(root, '1', REPORTS, NOW);
    expect(action.kind).toBe('show');
    expect(action.kind === 'show' && action.text).toContain('*Customer Ledger* — for which period?');
  });

  it('turns "2" at the root into the report list', () => {
    const action = advance(root, '2', REPORTS, NOW);
    expect(action.kind === 'show' && action.text).toContain('Balance Sheet');
  });

  it('sends an undated report straight away, with no period question', () => {
    // Stock Summary is option 4 in the list above.
    expect(advance(reports, '4', REPORTS, NOW)).toEqual({
      kind: 'report',
      documentType: 'stock_summary',
      from: null,
      to: null,
    });
  });

  it('asks the period for a dated report, then sends it with the dates resolved', () => {
    const asked = advance(reports, '2', REPORTS, NOW);
    expect(asked.kind === 'show' && asked.text).toContain('Customer Ledger');

    const period = stepFor(asked.kind === 'show' ? asked.text : '');
    expect(advance(period, '2', REPORTS, NOW)).toEqual({
      kind: 'report',
      documentType: 'customer_ledger',
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('takes specific dates, asked for and then given', () => {
    const period = stepFor(periodMenu('Trial Balance'));
    const asked = advance(period, '5', REPORTS, NOW);
    expect(asked.kind === 'show' && asked.text).toContain('2026-07-01 to 2026-09-30');

    const dates = stepFor(asked.kind === 'show' ? asked.text : '');
    expect(advance(dates, '2026-07-01 to 2026-09-30', REPORTS, NOW)).toEqual({
      kind: 'report',
      documentType: 'trial_balance',
      from: '2026-07-01',
      to: '2026-09-30',
    });
  });

  it('accepts a typed period where it asked for a number, rather than correcting the person', () => {
    const period = stepFor(periodMenu('Trial Balance'));
    expect(advance(period, '2026-01-01 to 2026-01-31', REPORTS, NOW)).toEqual({
      kind: 'report',
      documentType: 'trial_balance',
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('re-sends the menu for a number that is not on it', () => {
    expect(advance(reports, '99', REPORTS, NOW).kind).toBe('show');
    expect(advance(root, '9', REPORTS, NOW).kind).toBe('show');
  });

  it('goes back from the report list with 0', () => {
    const action = advance(reports, '0', REPORTS, NOW);
    expect(action.kind === 'show' && action.text).toContain('What would you like');
  });

  it('never swallows a real request just because a menu is open', () => {
    // This is the rule that keeps the menu additive: free text still reaches the reasoning.
    expect(advance(root, 'send me invoice 179', REPORTS, NOW)).toEqual({ kind: 'none' });
    // A whole sentence is a request, not a selection, even while the report list is open.
    expect(advance(reports, 'send me the trial balance for July', REPORTS, NOW)).toEqual({ kind: 'none' });
  });

  it('takes the report name typed instead of its number', () => {
    // Answering "trial balance" to "Which report?" is as clear as answering "1".
    const action = advance(reports, 'trial balance', REPORTS, NOW);
    expect(action.kind === 'show' && action.text).toContain('*Trial Balance* — for which period?');
  });

  it('does not guess between reports that share a word', () => {
    // "ledger" is in Customer Ledger, Vendor Ledger, Item Ledger and General Ledger; choosing
    // one would send somebody the wrong book, so it falls through instead.
    const many: MenuReport[] = [
      ...REPORTS,
      { documentType: 'vendor_ledger', displayName: 'Vendor Ledger', datedByDefault: true },
      { documentType: 'item_ledger', displayName: 'Item Ledger', datedByDefault: true },
    ];
    expect(advance(stepFor(reportMenu(many)), 'ledger', many, NOW)).toEqual({ kind: 'none' });
  });

  it('goes back to the start from anywhere', () => {
    for (const word of ['back', 'menu', 'cancel']) {
      const action = advance(stepFor(periodMenu('Trial Balance')), word, REPORTS, NOW);
      expect(action.kind === 'show' && action.text).toContain('What would you like');
    }
  });

  it('asks which document when the person chooses an invoice by number', () => {
    const action = advance(root, '3', REPORTS, NOW);
    expect(action.kind).toBe('document');
    expect(action.kind === 'document' && action.prompt).toContain('sale invoice 179');
  });

  it('with no menu open, a bare number is not treated as a choice out of nowhere', () => {
    // There is no menu to answer, so this falls through rather than inventing a selection.
    expect(advance(null, 'hello', REPORTS, NOW)).toEqual({ kind: 'none' });
  });
});
