import { MockLedgerAdapter } from './mock.adapter';
import { ledgerTools } from '../../core/agent-tools/tools/ledger.tools';
import { validateStatement, describeValue, requireAmount, requireDate } from './validate';
import { addDecimal, subtractDecimal } from './decimal';

/**
 * The loop the feature is for: raise an invoice, watch what is owed, record a verified
 * payment, and stop chasing once the ledger says it is settled.
 *
 * Run against the in-memory ledger, which keeps real balances — raising an invoice
 * increases what the customer owes and a payment decreases it — so these assertions are
 * about behaviour rather than about which methods were called.
 */
describe('invoice → track → settle', () => {
  let ledger: MockLedgerAdapter;
  let tools: ReturnType<typeof ledgerTools>;
  const tool = (name: string) => tools.find(t => t.name === name)!;
  /**
   * Invokes a tool the way the runtime does.
   *
   * `AnyToolDescriptor` erases the per-tool input type so tools of different shapes can sit
   * in one list, so the cast happens here once rather than at every call site — exactly as
   * `invokeTool` does after validating against the schema.
   */
  const call = (name: string, input: unknown): Promise<unknown> => tool(name).handler(input as never, {} as never);

  beforeEach(() => {
    ledger = new MockLedgerAdapter();
    tools = ledgerTools({ ledger: () => ledger });
  });

  it('offers read tools and, because this ledger can write, the write tools too', () => {
    expect(tools.map(t => t.name)).toEqual(
      expect.arrayContaining(['LedgerListOverdue', 'LedgerGetCustomer', 'LedgerCreateInvoice', 'LedgerRecordPayment']),
    );
    // Writes must be `write` tier — that is what routes them through the approval gate and
    // keeps them out of the customer allowlist.
    expect(tool('LedgerCreateInvoice').tier).toBe('write');
    expect(tool('LedgerRecordPayment').tier).toBe('write');
    expect(tool('LedgerListOverdue').tier).toBe('read');
  });

  it('withholds the write tools when the ledger cannot write', () => {
    const readOnly = ledgerTools({
      // A read-only adapter: no createInvoice/recordPayment.
      ledger: () => ({ name: 'ro', health: () => Promise.resolve({ ok: true, detail: '' }) }) as never,
    });
    expect(readOnly.some(t => t.name === 'LedgerCreateInvoice')).toBe(false);
    expect(readOnly.some(t => t.tier === 'write')).toBe(false);
  });

  it('lists exactly the overdue customers — not the ones who are current or settled', async () => {
    const result = (await call('LedgerListOverdue', {})) as {
      count: number;
      rows: { name: string; outstanding: string; daysOverdue: number }[];
    };
    const names = result.rows.map(r => r.name);

    expect(names).toEqual(expect.arrayContaining(['Ali Textiles', 'Bilal Fabrics', 'Dawood Trading']));
    // Due in five days — chasing them would be wrong, and is the easiest mistake to make.
    expect(names).not.toContain('Chenab Mills');
    // Settled — a paid customer must never appear on a chase list.
    expect(names).not.toContain('Emaan Enterprises');
    expect(result.count).toBe(3);

    const ali = result.rows.find(r => r.name === 'Ali Textiles')!;
    expect(ali.outstanding).toBe('150000.00');
    expect(ali.daysOverdue).toBe(3);
  });

  it('includes a customer whose invoice is not yet due only in the upcoming bucket', async () => {
    const upcoming = (await call('LedgerListOverdue', { bucket: 'upcoming' })) as { rows: { name: string }[] };
    expect(upcoming.rows.map(r => r.name)).toEqual(['Chenab Mills']);
  });

  it('raises an invoice and the balance goes up by exactly its total', async () => {
    const before = (await ledger.getFacts('CUST-ALI')).balance;
    expect(before).toBe('150000.00');

    const created = (await call('LedgerCreateInvoice', {
      partyId: 'CUST-ALI',
      issueDate: '2026-09-01',
      dueDate: '2026-10-01',
      lines: [{ description: 'Cotton fabric', quantity: '100', unitPrice: '600' }],
      reference: 'PO-3001',
    })) as { externalId: string; number: string; deduplicated: boolean };

    expect(created.deduplicated).toBe(false);
    // 100 × 600 = 60,000 added to the 150,000 already outstanding.
    const after = (await ledger.getFacts('CUST-ALI')).balance;
    expect(after).toBe('210000.00');
    expect((await ledger.getFacts('CUST-ALI')).invoices.map(i => i.number)).toContain(created.number);
  });

  it('raising the same invoice twice does not create a second one', async () => {
    /*
     * The failure this prevents is a real debt the customer does not owe, and the ways it
     * happens are mundane: a retried request, a double-tapped approval, a redelivered
     * webhook. The key is derived from the arguments, so a repeat carries the same value.
     */
    const args = {
      partyId: 'CUST-ALI',
      issueDate: '2026-09-01',
      dueDate: '2026-10-01',
      lines: [{ description: 'Cotton fabric', quantity: '100', unitPrice: '600' }],
    };
    const first = (await call('LedgerCreateInvoice', args)) as {
      externalId: string;
      deduplicated: boolean;
    };
    const second = (await call('LedgerCreateInvoice', args)) as {
      externalId: string;
      deduplicated: boolean;
    };

    expect(second.deduplicated).toBe(true);
    expect(second.externalId).toBe(first.externalId);
    expect(ledger.snapshot().filter(i => i.number === first.externalId)).toHaveLength(1);
  });

  it('a verified payment settles the invoice and it leaves the overdue list', async () => {
    await call('LedgerRecordPayment', {
      partyId: 'CUST-ALI',
      invoiceId: 'INV-1001',
      amount: '150000.00',
      paidOn: '2026-09-04',
      method: 'bank_transfer',
      reference: 'TRX-88213',
    });

    const facts = await ledger.getFacts('CUST-ALI');
    expect(facts.balance).toBe('0.00');
    expect(facts.invoices).toHaveLength(0);

    // Ali drops off the chase list; the other two late customers are untouched.
    const overdue = (await call('LedgerListOverdue', {})) as { count: number; rows: { name: string }[] };
    expect(overdue.rows.map(r => r.name)).not.toContain('Ali Textiles');
    expect(overdue.count).toBe(2);
  });

  it('a partial payment reduces the balance without clearing it', async () => {
    await call('LedgerRecordPayment', {
      partyId: 'CUST-ALI',
      invoiceId: 'INV-1001',
      amount: '50000.00',
      paidOn: '2026-09-04',
      reference: 'TRX-1',
    });
    const facts = await ledger.getFacts('CUST-ALI');
    expect(facts.balance).toBe('100000.00');
    expect(facts.invoices).toHaveLength(1);
  });

  it('requires a payment reference, so a posting can always be checked', () => {
    const schema = tool('LedgerRecordPayment').inputSchema;
    const missing = schema.safeParse({
      partyId: 'CUST-ALI',
      invoiceId: 'INV-1001',
      amount: '100',
      paidOn: '2026-09-04',
    });
    expect(missing.success).toBe(false);
  });

  it('refuses an invoice for a customer the ledger does not have', async () => {
    await expect(
      call('LedgerCreateInvoice', {
        partyId: 'NOPE',
        issueDate: '2026-09-01',
        dueDate: '2026-10-01',
        lines: [{ description: 'x', quantity: '1', unitPrice: '1' }],
      }),
    ).rejects.toThrow(/No customer/);
  });
});

describe('what the connected system is allowed to send back', () => {
  it('refuses an ambiguous grouped amount rather than guessing', () => {
    // "1,50,000" is 150,000 in the South Asian convention and 150 in the European one.
    // Guessing wrong by a factor of a thousand in a demand for payment is not a rounding error.
    expect(() => requireAmount('1,50,000.00', 'invoice.outstanding')).toThrow(/grouping separators/);
    expect(() => requireAmount('', 'invoice.outstanding')).toThrow(/missing/);
    expect(requireAmount('150000.00', 'x')).toBe('150000.00');
    expect(requireAmount(150000, 'x')).toBe('150000');
  });

  it('refuses a date that is not ISO, and one that is not a real day', () => {
    expect(() => requireDate('04/09/2026', 'invoice.dueDate')).toThrow(/ISO date/);
    expect(() => requireDate('2026-02-31', 'invoice.dueDate')).toThrow(/real calendar date/);
    expect(requireDate('2026-09-04T10:00:00Z', 'x')).toBe('2026-09-04');
  });

  it('refuses a statement whose entries do not add up to its closing balance', () => {
    // Far more likely a debit column mapped to credit than a bug in the host's accounting —
    // and the customer is the one who would notice.
    expect(() =>
      validateStatement({
        openingBalance: '0.00',
        entries: [{ date: '2026-08-01', reference: 'INV-1', description: 'x', debit: '100.00', credit: '0.00' }],
        closingBalance: '250.00',
      }),
    ).toThrow(/do not add up/);
  });

  it('accepts a statement that balances', () => {
    const statement = validateStatement({
      openingBalance: '0.00',
      entries: [
        { date: '2026-08-01', reference: 'INV-1', description: 'Goods', debit: '150000.00', credit: '0.00' },
        { date: '2026-09-04', reference: 'RCPT-1', description: 'Payment', debit: '0.00', credit: '50000.00' },
      ],
      closingBalance: '100000.00',
    });
    expect(statement.entries).toHaveLength(2);
  });

  it('describes a bad value usefully instead of "[object Object]"', () => {
    expect(describeValue({ a: 1 })).toBe('{"a":1}');
    expect(describeValue(null)).toBe('null');
    expect(describeValue('x')).toBe('x');
  });
});

describe('decimal arithmetic', () => {
  it('is exact where floats are not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float. Not in an invoice.
    expect(addDecimal('0.1', '0.2')).toBe('0.3000');
    expect(addDecimal('150000.00', '60000.00')).toBe('210000.0000');
    expect(subtractDecimal('150000.00', '50000.00')).toBe('100000.0000');
  });

  it('never reports a negative outstanding', () => {
    // An overpayment is not a debt owed backwards.
    expect(subtractDecimal('100.00', '150.00')).toBe('0.0000');
  });
});
