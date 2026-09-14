import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { defineTool } from '../tool-descriptor';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { LedgerPort, LedgerWritePort } from '../../../integrations/ledger/ledger.port';
import { supportsWrites } from '../../../integrations/ledger/ledger.port';

/**
 * The accounting surface: read the client's ledger, raise invoices, record payments.
 *
 * Every write here is `tier: 'write'`, which is not decoration — it is what routes the call
 * through the approval gate and keeps it out of the customer tool allowlist. The practical
 * consequence is the property that matters most in this whole feature: **a customer's
 * message cannot reach any of these**, however it is phrased, because the customer fence is
 * an allowlist and none of these names are on it.
 *
 * The write tools are only registered when the configured adapter actually supports writing.
 * A read-only integration therefore offers no invoice-raising tool at all, rather than one
 * that fails at approval time after an administrator has already said yes.
 */

export interface LedgerToolDeps {
  ledger: () => LedgerPort;
}

/**
 * Idempotency for a write.
 *
 * Derived from the arguments, so a retry of the same instruction carries the same key and a
 * host that honours it returns the original record. Deliberately NOT random: a fresh uuid
 * per attempt would make every retry a new invoice, which is the exact failure the key
 * exists to prevent.
 */
function idempotencyKey(kind: string, payload: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
}

export function ledgerTools(deps: LedgerToolDeps): AnyToolDescriptor[] {
  const read: AnyToolDescriptor[] = [
    defineTool({
      name: 'LedgerListOverdue',
      description:
        'List customers with money outstanding, oldest first. Use this for "who owes us?", ' +
        '"show overdue parties", or before preparing reminders.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        bucket: z.enum(['overdue', 'due_today', 'upcoming', 'all']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      handler: async input => {
        const rows = await deps.ledger().listReceivables({
          bucket: input.bucket ?? 'overdue',
          limit: input.limit ?? 20,
        });
        return {
          count: rows.length,
          summary:
            rows.length === 0
              ? 'Nobody is overdue.'
              : rows
                  .map(
                    r =>
                      `${r.party.name}: ${r.outstanding} outstanding, ${r.daysOverdue} days overdue (${r.invoiceCount} invoice(s))`,
                  )
                  .join('\n'),
          rows: rows.map(r => ({
            partyId: r.party.externalId,
            name: r.party.name,
            outstanding: r.outstanding,
            oldestDueDate: r.oldestDueDate,
            daysOverdue: r.daysOverdue,
          })),
        };
      },
    }),

    defineTool({
      name: 'LedgerGetCustomer',
      description: "A customer's verified balance and open invoices, straight from the accounting system.",
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({ partyId: z.string().min(1).describe('The accounting system customer id') }),
      handler: async input => {
        const facts = await deps.ledger().getFacts(input.partyId);
        return {
          name: facts.party.name,
          balance: facts.balance,
          currency: facts.currency,
          summary: `${facts.party.name} owes ${facts.currency} ${facts.balance} across ${facts.invoices.length} invoice(s).`,
          invoices: facts.invoices.map(i => ({
            invoiceId: i.externalId,
            number: i.number,
            dueDate: i.dueDate,
            total: i.total,
            outstanding: i.outstanding,
          })),
        };
      },
    }),

    defineTool({
      name: 'LedgerGetInvoice',
      description: 'One invoice in full, including its lines. Use before sending or discussing it.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({ invoiceId: z.string().min(1) }),
      handler: async input => (await deps.ledger().getInvoice(input.invoiceId)) ?? { found: false },
    }),

    defineTool({
      name: 'LedgerHealth',
      description: 'Whether the accounting system is reachable right now.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      inputSchema: z.object({}),
      handler: async () => deps.ledger().health(),
    }),
  ];

  const port = safePort(deps);
  if (!port || !supportsWrites(port)) return read;

  const write: AnyToolDescriptor[] = [
    defineTool({
      name: 'LedgerCreateInvoice',
      description:
        'Raise a new invoice in the accounting system. Requires approval: an administrator sees ' +
        'the customer, the lines and the total before it is created.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        partyId: z.string().min(1).describe('The accounting system customer id'),
        issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        lines: z
          .array(
            z.object({
              description: z.string().min(1).max(300),
              quantity: z.string().regex(/^\d+(\.\d+)?$/),
              unitPrice: z.string().regex(/^\d+(\.\d+)?$/),
            }),
          )
          .min(1)
          .max(50),
        reference: z.string().max(120).optional(),
        notes: z.string().max(500).optional(),
      }),
      handler: async input => {
        const writable = deps.ledger() as LedgerPort & LedgerWritePort;
        return writable.createInvoice({
          partyExternalId: input.partyId,
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          lines: input.lines,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          idempotencyKey: idempotencyKey('invoice', input),
        });
      },
    }),

    defineTool({
      name: 'LedgerRecordPayment',
      description:
        'Record a payment that has been VERIFIED against the bank and mark the invoice settled. ' +
        'Requires approval. Never use this because a customer said they paid — a message is not a ' +
        'receipt; route that to a person instead.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        partyId: z.string().min(1),
        invoiceId: z.string().min(1).nullable().optional().describe('Null for an on-account payment'),
        amount: z.string().regex(/^\d+(\.\d+)?$/),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        method: z.string().max(40).optional(),
        /*
         * A reference is required, not optional.
         *
         * It is the only thing that ties a posted receipt back to something a human can
         * check against a bank statement. A payment recorded with no reference is a ledger
         * entry nobody can verify afterwards, which is how a mistaken posting becomes
         * permanent.
         */
        reference: z.string().min(2).max(120).describe('Bank/cheque/transfer reference — required'),
      }),
      handler: async input => {
        const writable = deps.ledger() as LedgerPort & LedgerWritePort;
        return writable.recordPayment({
          partyExternalId: input.partyId,
          invoiceExternalId: input.invoiceId ?? null,
          amount: input.amount,
          paidOn: input.paidOn,
          method: input.method ?? null,
          reference: input.reference,
          idempotencyKey: idempotencyKey('payment', input),
        });
      },
    }),
  ];

  return [...read, ...write];
}

/**
 * Resolves the adapter at registration time only to ask whether it can write.
 *
 * Wrapped because the registry is built during bootstrap, when the adapter may not be
 * constructed yet. An unavailable adapter means the read tools are registered and the write
 * tools are not — which is the safe direction to fail in.
 */
function safePort(deps: LedgerToolDeps): LedgerPort | null {
  try {
    return deps.ledger();
  } catch {
    return null;
  }
}
