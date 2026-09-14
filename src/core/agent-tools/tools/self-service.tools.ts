import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { defineTool } from '../tool-descriptor';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { LedgerPort } from '../../../integrations/ledger/ledger.port';
import type { ContactMapper } from '../../../integrations/whatsapp/contact-mapper';
import type { AgentEventService } from '../../../modules/agent/agent-event.service';

/**
 * What a customer may do for themselves over WhatsApp.
 *
 * These are the only tools on the customer allowlist, and until now they were names in that
 * allowlist with nothing behind them — which meant a customer could never be helped, only
 * deflected. They exist so the restricted experience is genuinely useful: a customer can
 * ask what they owe, see their own invoices, hand over a payment reference, promise a date,
 * dispute a charge, ask for a person, or ask to be left alone.
 *
 * Three properties hold for every tool here, and they are the reason this file is separate
 * from the operator tools rather than being a role check inside them:
 *
 *  1. **The account comes from the channel, not the conversation.** Every tool is
 *     `senderScoped`, so the runtime overwrites `senderPhone` with the number the message
 *     actually arrived from. No wording can change whose account is read.
 *  2. **An unlinked number is refused, never guessed.** The phone must be explicitly linked
 *     to a ledger id; matching on a name would let "I'm from Bilal Fabrics" read Bilal's
 *     account.
 *  3. **Nothing here writes to the ledger.** A customer saying they paid produces a note for
 *     the accounts team, never a payment. The balance changes when a person confirms it
 *     against the bank, which is the whole point of step 7 of the demonstration.
 */

export interface SelfServiceToolDeps {
  ledger: () => LedgerPort;
  contacts: () => ContactMapper;
  events: () => AgentEventService;
}

/** The refusal a number that is not linked to an account receives. Deliberately uninformative. */
const UNLINKED =
  'I could not match this number to an account, so I have passed your message to our team ' +
  'and someone will follow up.';

export function selfServiceTools(deps: SelfServiceToolDeps): AnyToolDescriptor[] {
  /*
   * `senderPhone` is in the schema because the tool needs it, not because a caller supplies
   * it: the runtime overwrites it from the verified message before the tool ever runs. It is
   * described as verified so that nothing reading the schema mistakes it for an argument the
   * model gets to choose.
   */
  const senderPhone = z.string().min(1).describe('Verified sender number. Pinned by the runtime; not caller-supplied.');

  /** Resolves the caller to a ledger account, or explains why not. */
  const account = async (phone: string): Promise<{ ok: true; id: string } | { ok: false; reply: string }> => {
    const id = await deps.contacts().resolveLedgerId(phone);
    return id ? { ok: true, id } : { ok: false, reply: UNLINKED };
  };

  /** Records something a customer told us, for a person to action. Never changes a balance. */
  const note = async (
    kind: string,
    phone: string,
    payload: Record<string, unknown>,
    reply: string,
  ): Promise<{ recorded: boolean; reply: string; note: string }> => {
    /*
     * The key is derived from the content, so sending the same thing twice converges on one
     * row rather than filling the accounts team's queue with duplicates of an anxious
     * customer's third message.
     */
    const digest = createHash('sha256').update(JSON.stringify({ kind, phone, payload })).digest('hex').slice(0, 24);
    await deps.events().raise({
      eventType: kind,
      eventKey: `${kind}:${phone}:${digest}`,
      subjectPhone: phone,
      payload,
    });
    return { recorded: true, reply, note: 'Passed to the accounts team. No balance has been changed.' };
  };

  return [
    defineTool({
      name: 'AgentSelfBalance',
      description:
        "What the sender's own account owes, read live from the accounting system. " +
        'Use when a customer asks what they owe, their balance, or how much is outstanding.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({ senderPhone }),
      handler: async input => {
        const found = await account(input.senderPhone);
        if (!found.ok) return { linked: false, reply: found.reply };
        const facts = await deps.ledger().getFacts(found.id);
        const count = facts.invoices.length;
        return {
          linked: true,
          customer: facts.party.name,
          balance: facts.balance,
          currency: facts.currency,
          openInvoices: count,
          asOf: facts.asOf,
          reply:
            count === 0
              ? `Your account is clear — there is nothing outstanding. Thank you.`
              : `Your account shows ${facts.currency} ${facts.balance} outstanding across ${count} invoice${count === 1 ? '' : 's'}.`,
        };
      },
    }),

    defineTool({
      name: 'AgentSelfStatement',
      description:
        "The sender's own open invoices with due dates and amounts. Use when a customer asks " +
        'for their statement, their invoices, or a breakdown of what they owe.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({ senderPhone }),
      handler: async input => {
        const found = await account(input.senderPhone);
        if (!found.ok) return { linked: false, reply: found.reply };
        const facts = await deps.ledger().getFacts(found.id);
        const lines = facts.invoices.map(i => `${i.number} — ${facts.currency} ${i.outstanding}, due ${i.dueDate}`);
        return {
          linked: true,
          customer: facts.party.name,
          currency: facts.currency,
          closingBalance: facts.balance,
          invoices: facts.invoices.map(i => ({
            number: i.number,
            issued: i.issueDate,
            due: i.dueDate,
            total: i.total,
            outstanding: i.outstanding,
          })),
          reply: lines.length
            ? `Here is your account:\n${lines.join('\n')}\nTotal outstanding: ${facts.currency} ${facts.balance}.`
            : 'Your account is clear — there is nothing outstanding. Thank you.',
        };
      },
    }),

    defineTool({
      name: 'AgentSelfInvoice',
      description:
        'One invoice belonging to the sender, by its number. Use when a customer asks about a ' +
        'specific invoice reference.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        number: z.string().min(1).max(60).describe('Invoice number, e.g. INV-1001'),
      }),
      handler: async input => {
        const found = await account(input.senderPhone);
        if (!found.ok) return { linked: false, reply: found.reply };
        const facts = await deps.ledger().getFacts(found.id);
        const wanted = input.number.trim().toUpperCase();
        const mine = facts.invoices.find(i => i.number.toUpperCase() === wanted);
        /*
         * Not found and not yours are the same answer on purpose.
         *
         * Distinguishing them would turn this tool into an oracle for whether an invoice
         * number exists on someone else's account, which is worth more to someone probing
         * than the invoice itself.
         */
        if (!mine) return { found: false, reply: `I could not find invoice ${input.number} on your account.` };
        const currency = mine.currency ?? facts.currency;
        return {
          found: true,
          number: mine.number,
          issued: mine.issueDate,
          due: mine.dueDate,
          total: mine.total,
          outstanding: mine.outstanding,
          currency,
          reply: `${mine.number}: ${currency} ${mine.outstanding} outstanding of ${currency} ${mine.total}, due ${mine.dueDate}.`,
        };
      },
    }),

    defineTool({
      name: 'AgentSubmitPaymentReference',
      description:
        'Record a payment reference a customer has given, for the accounts team to check against ' +
        'the bank. Does NOT record a payment or change any balance.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        reference: z.string().min(1).max(80).describe('The transaction reference the customer quoted'),
        amount: z.string().max(40).optional(),
        invoiceNumber: z.string().max(60).optional(),
      }),
      handler: async input =>
        note(
          'customer.payment_reference',
          input.senderPhone,
          { reference: input.reference, amount: input.amount ?? null, invoiceNumber: input.invoiceNumber ?? null },
          `Thank you — I have passed reference ${input.reference} to our accounts team to check against our bank records. ` +
            'Your balance will update once they confirm it.',
        ),
    }),

    defineTool({
      name: 'AgentRecordPromiseToPay',
      description: 'Record a date a customer has said they will pay by, so the team can follow up after it.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        promisedDate: z.string().min(1).max(40).describe('What the customer said, e.g. "Friday" or "2026-09-12"'),
        note: z.string().max(400).optional(),
      }),
      handler: async input =>
        note(
          'customer.promise_to_pay',
          input.senderPhone,
          { promisedDate: input.promisedDate, note: input.note ?? null },
          `Thank you for letting us know — I have recorded that you expect to pay by ${input.promisedDate} and passed it to the team.`,
        ),
    }),

    defineTool({
      name: 'AgentRaiseDispute',
      description: 'Record that a customer disputes a charge or an invoice, for a person to review.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        reason: z.string().min(1).max(600),
        invoiceNumber: z.string().max(60).optional(),
      }),
      handler: async input =>
        note(
          'customer.dispute',
          input.senderPhone,
          { reason: input.reason, invoiceNumber: input.invoiceNumber ?? null },
          'Thank you for raising that — I have recorded the dispute for our accounts team to review.',
        ),
    }),

    defineTool({
      name: 'AgentRequestHuman',
      description: 'Record that a customer has asked to speak to a person.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({ senderPhone, reason: z.string().max(400).optional() }),
      handler: async input =>
        note(
          'customer.request_human',
          input.senderPhone,
          { reason: input.reason ?? null },
          'Of course — I have asked a colleague to get in touch with you directly.',
        ),
    }),

    defineTool({
      name: 'AgentOptOut',
      description:
        'Record that a customer does not want to be contacted on this number, and stop sending to it. ' +
        'Set optedOut false to resume when a customer asks to be contacted again.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      senderScoped: true,
      inputSchema: z.object({ senderPhone, optedOut: z.boolean().default(true) }),
      handler: async input => {
        /*
         * This is enforced, not just filed.
         *
         * The permission layer refuses sends to an opted-out number, so the request takes
         * effect on the next reminder rather than sitting in a queue. An opt-out that is
         * only recorded is worse than none: it puts on the record that they asked, and then
         * messages them anyway.
         */
        const known = await deps.contacts().setOptOut(input.senderPhone, input.optedOut);
        if (!known) return { applied: false, reply: UNLINKED };
        const confirmation = input.optedOut
          ? 'Understood — we will not send you further reminders on this number.'
          : 'Noted — we will contact you on this number again.';
        await note(
          input.optedOut ? 'customer.opt_out' : 'customer.opt_in',
          input.senderPhone,
          { optedOut: input.optedOut },
          confirmation,
        );
        return {
          applied: true,
          optedOut: input.optedOut,
          reply: confirmation,
        };
      },
    }),
  ];
}
