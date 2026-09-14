import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type {
  CreateInvoiceInput,
  LedgerBusiness,
  LedgerContact,
  LedgerFacts,
  LedgerHealth,
  LedgerInvoice,
  LedgerInvoiceLine,
  LedgerParty,
  LedgerPort,
  LedgerStatement,
  LedgerWritePort,
  ReceivablesQuery,
  ReceivablesRow,
  RecordPaymentInput,
  WriteResult,
} from './ledger.port';

interface MockInvoice extends LedgerInvoice {
  partyExternalId: string;
  paid: string;
  lines: LedgerInvoiceLine[];
}

/**
 * An in-memory accounting system.
 *
 * Not a stub: it keeps real invoices with real balances, raising an invoice increases what
 * the customer owes, recording a payment decreases it, and an invoice reaching zero leaves
 * the outstanding list — which is what makes "stop chasing once it is paid" demonstrable
 * without a client's system attached.
 *
 * It also honours idempotency keys, so the guard against raising an invoice twice can be
 * tested rather than assumed.
 */
@Injectable()
export class MockLedgerAdapter implements LedgerPort, LedgerWritePort {
  readonly name = 'mock';

  private readonly parties = new Map<string, LedgerParty>();
  private readonly invoices = new Map<string, MockInvoice>();
  private readonly idempotency = new Map<string, WriteResult>();
  private sequence = 1000;

  constructor() {
    this.seed();
  }

  /**
   * Demonstration data.
   *
   * Entirely fictional — invented names, invented balances, invented invoice numbers. It
   * exists so the workflow can be shown end to end before a client's real system is
   * connected, and it is labelled as a demo everywhere it surfaces so nothing here can be
   * mistaken for a real customer or a real debt.
   *
   * The spread is deliberate rather than decorative: it covers the four states a
   * collections process actually has to handle, so a demo shows judgement rather than one
   * happy path.
   *
   *   Ali Textiles     150,000  3 days overdue   — the routine chase
   *   Bilal Fabrics     85,000  21 days overdue  — old enough to need a firmer tone
   *   Dawood Trading    45,000  47 days overdue  — escalation territory
   *   Chenab Mills     240,000  due in 5 days    — NOT overdue, must not be chased
   *   Emaan Enterprises      0  settled          — must not appear at all
   *
   * Dates are relative to today, so the demo reads correctly whenever it is run rather than
   * drifting into "eight months overdue" a week later.
   */
  private seed(): void {
    const party = (id: string, name: string, phone: string, city: string, days = 30): LedgerParty => ({
      externalId: id,
      name,
      phone,
      city,
      creditDays: days,
      isActive: true,
    });

    for (const p of [
      party('CUST-ALI', 'Ali Textiles', '923214455667', 'Faisalabad'),
      party('CUST-BILAL', 'Bilal Fabrics', '923009988776', 'Karachi', 15),
      party('CUST-CHENAB', 'Chenab Mills', '923331122334', 'Lahore', 45),
      party('CUST-DAWOOD', 'Dawood Trading', '923455566778', 'Multan', 30),
      party('CUST-EMAAN', 'Emaan Enterprises', '923218899001', 'Sialkot'),
    ]) {
      this.parties.set(p.externalId, p);
    }

    const invoice = (
      number: string,
      partyId: string,
      total: string,
      dueInDays: number,
      description: string,
      quantity: string,
      unitPrice: string,
      paid = '0.00',
    ): void => {
      this.invoices.set(number, {
        externalId: number,
        number,
        issueDate: shiftDays(new Date(), dueInDays - 30),
        dueDate: shiftDays(new Date(), dueInDays),
        total,
        outstanding: (Number(total) - Number(paid)).toFixed(2),
        paid,
        currency: 'PKR',
        reference: null,
        partyExternalId: partyId,
        lines: [{ description, quantity, unitPrice, lineTotal: total }],
      });
    };

    invoice('INV-1001', 'CUST-ALI', '150000.00', -3, 'Cotton fabric — 60s combed, 250 m', '250', '600');
    invoice('INV-0994', 'CUST-BILAL', '85000.00', -21, 'Polyester lining — 500 m', '500', '170');
    invoice('INV-0961', 'CUST-DAWOOD', '45000.00', -47, 'Button assortment — 30 gross', '30', '1500');
    invoice('INV-1010', 'CUST-CHENAB', '240000.00', 5, 'Greige cloth — 400 m', '400', '600');
    // Settled: proves a paid customer is not chased, which is easy to get wrong.
    invoice('INV-0980', 'CUST-EMAAN', '62000.00', -12, 'Thread cones — 200', '200', '310', '62000.00');

    /*
     * Continue numbering above whatever was seeded.
     *
     * The counter started at a fixed 1000, so the first invoice raised came out as INV-1001
     * and silently overwrote the seeded one — the customer's balance went DOWN after
     * raising an invoice. Deriving it from what already exists makes a collision impossible
     * rather than unlikely.
     */
    for (const existing of this.invoices.keys()) {
      const numeric = Number(existing.replace(/\D/g, ''));
      if (Number.isFinite(numeric)) this.sequence = Math.max(this.sequence, numeric);
    }
  }

  getBusiness(): Promise<LedgerBusiness> {
    return Promise.resolve({
      name: 'Rangila Trading Co. (DEMO LEDGER — not a real business)',
      city: 'Karachi',
      currency: 'PKR',
      paymentInstructions: 'Bank transfer to Meezan Bank. Please quote the invoice number.',
    });
  }

  listReceivables(query: ReceivablesQuery = {}): Promise<ReceivablesRow[]> {
    const asOf = query.asOf ?? today();
    const byParty = new Map<string, MockInvoice[]>();
    for (const invoice of this.invoices.values()) {
      if (Number(invoice.outstanding) <= 0) continue;
      byParty.set(invoice.partyExternalId, [...(byParty.get(invoice.partyExternalId) ?? []), invoice]);
    }

    const rows: ReceivablesRow[] = [];
    for (const [partyId, list] of byParty) {
      const party = this.parties.get(partyId);
      if (!party) continue;
      const oldest = list.map(i => i.dueDate).sort()[0];
      rows.push({
        party,
        outstanding: list.reduce((sum, i) => (Number(sum) + Number(i.outstanding)).toFixed(2), '0.00'),
        oldestDueDate: oldest,
        daysOverdue: Math.max(0, daysBetween(oldest, asOf)),
        invoiceCount: list.length,
      });
    }

    const bucket = query.bucket ?? 'all';
    return Promise.resolve(
      rows.filter(r => {
        if (bucket === 'all' || !r.oldestDueDate) return true;
        if (bucket === 'overdue') return r.oldestDueDate < asOf;
        if (bucket === 'due_today') return r.oldestDueDate === asOf;
        return r.oldestDueDate > asOf;
      }),
    );
  }

  getParty(externalId: string): Promise<LedgerParty> {
    const party = this.parties.get(externalId);
    if (!party) throw new NotFoundException(`No customer ${externalId}`);
    return Promise.resolve(party);
  }

  async getFacts(externalId: string): Promise<LedgerFacts> {
    const party = await this.getParty(externalId);
    const open = [...this.invoices.values()].filter(i => i.partyExternalId === externalId && Number(i.outstanding) > 0);
    return {
      party,
      balance: open.reduce((sum, i) => (Number(sum) + Number(i.outstanding)).toFixed(2), '0.00'),
      currency: 'PKR',
      invoices: open.map(stripInternal).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      asOf: new Date().toISOString(),
    };
  }

  getContacts(externalId: string): Promise<LedgerContact[]> {
    const party = this.parties.get(externalId);
    return Promise.resolve(
      party ? [{ name: 'Ali Accounts', role: 'Accounts Officer', phone: party.phone, isPrimary: true }] : [],
    );
  }

  async getStatement(externalId: string): Promise<LedgerStatement> {
    const list = [...this.invoices.values()].filter(i => i.partyExternalId === externalId);
    const entries = list.flatMap(i => [
      {
        date: i.issueDate,
        reference: i.number,
        description: `Invoice ${i.number}`,
        debit: i.total,
        credit: '0.00',
        balance: null,
      },
      ...(Number(i.paid) > 0
        ? [
            {
              date: today(),
              reference: `RCPT-${i.number}`,
              description: 'Payment received',
              debit: '0.00',
              credit: i.paid,
              balance: null,
            },
          ]
        : []),
    ]);
    const closing = (await this.getFacts(externalId)).balance;
    return { openingBalance: '0.00', entries, closingBalance: closing };
  }

  getInvoice(
    externalId: string,
  ): Promise<(LedgerInvoice & { lines?: LedgerInvoiceLine[]; party?: LedgerParty }) | null> {
    const invoice = this.invoices.get(externalId);
    if (!invoice) return Promise.resolve(null);
    return Promise.resolve({
      ...stripInternal(invoice),
      lines: invoice.lines,
      party: this.parties.get(invoice.partyExternalId),
    });
  }

  health(): Promise<LedgerHealth> {
    return Promise.resolve({ ok: true, detail: 'In-memory demo ledger.', latencyMs: 0 });
  }

  /* ---------------------------------------------------------------- writes */

  createInvoice(input: CreateInvoiceInput): Promise<WriteResult> {
    // Idempotency honoured, so raising the same invoice twice returns the first one.
    const seen = this.idempotency.get(input.idempotencyKey);
    if (seen) return Promise.resolve({ ...seen, deduplicated: true });

    if (!this.parties.has(input.partyExternalId)) {
      throw new NotFoundException(`No customer ${input.partyExternalId}`);
    }

    const total = input.lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unitPrice), 0).toFixed(2);
    this.sequence += 1;
    let number = `INV-${this.sequence}`;
    // Belt and braces: never hand back a number that is already in use.
    while (this.invoices.has(number)) {
      this.sequence += 1;
      number = `INV-${this.sequence}`;
    }

    this.invoices.set(number, {
      externalId: number,
      number,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      total,
      outstanding: total,
      paid: '0.00',
      currency: input.currency ?? 'PKR',
      reference: input.reference ?? null,
      partyExternalId: input.partyExternalId,
      lines: input.lines.map(l => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: (Number(l.quantity) * Number(l.unitPrice)).toFixed(2),
      })),
    });

    const result: WriteResult = { externalId: number, number, deduplicated: false, raw: { total } };
    this.idempotency.set(input.idempotencyKey, result);
    return Promise.resolve(result);
  }

  recordPayment(input: RecordPaymentInput): Promise<WriteResult> {
    const seen = this.idempotency.get(input.idempotencyKey);
    if (seen) return Promise.resolve({ ...seen, deduplicated: true });

    const invoice = input.invoiceExternalId ? this.invoices.get(input.invoiceExternalId) : null;
    if (input.invoiceExternalId && !invoice) {
      throw new NotFoundException(`No invoice ${input.invoiceExternalId}`);
    }
    if (invoice) {
      const paid = (Number(invoice.paid) + Number(input.amount)).toFixed(2);
      const outstanding = Math.max(0, Number(invoice.total) - Number(paid)).toFixed(2);
      this.invoices.set(invoice.externalId, { ...invoice, paid, outstanding });
    }

    const reference = `RCPT-${Date.now().toString().slice(-6)}`;
    const result: WriteResult = {
      externalId: reference,
      number: reference,
      deduplicated: false,
      raw: { appliedTo: input.invoiceExternalId, amount: input.amount },
    };
    this.idempotency.set(input.idempotencyKey, result);
    return Promise.resolve(result);
  }

  /** Test helper: what the ledger currently believes. */
  snapshot(): { number: string; total: string; outstanding: string; paid: string }[] {
    return [...this.invoices.values()].map(i => ({
      number: i.number,
      total: i.total,
      outstanding: i.outstanding,
      paid: i.paid,
    }));
  }
}

function stripInternal(invoice: MockInvoice): LedgerInvoice {
  // Only the port's own fields cross the boundary; the mock's bookkeeping stays inside.
  return {
    externalId: invoice.externalId,
    number: invoice.number,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    total: invoice.total,
    outstanding: invoice.outstanding,
    currency: invoice.currency,
    reference: invoice.reference,
  };
}

const today = (): string => new Date().toISOString().slice(0, 10);

function shiftDays(from: Date, days: number): string {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
