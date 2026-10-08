import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { defineTool } from '../tool-descriptor';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { WhatsAppJobsService } from '../../../modules/whatsapp-jobs/whatsapp-jobs.service';
import { normalizeWhatsAppNumber } from '../../../modules/whatsapp-jobs/providers/whatsapp-delivery.provider';
import { buildCaption } from '../../../modules/whatsapp-jobs/caption';
import { accountKind, ledgerForKind } from '../../../modules/whatsapp-jobs/tenancy/account-kind';
import type { BotUserService } from '../../../modules/whatsapp-jobs/tenancy/bot-user.service';
import type { KnownPartyService } from '../../../modules/whatsapp-jobs/tenancy/known-party.service';
import { documentNumberPrompt, periodMenu, shortlistLine, type Subject } from '../../../modules/agent/client-menu';

/**
 * Phase Two: asking for an accounting report in a WhatsApp conversation.
 *
 * The whole of the difference from Phase One is who chooses the recipient. A queued invoice
 * names its customer; a chat request names nobody, so the report goes to **the number that
 * asked for it** and nowhere else. That is why the tool is `senderScoped`: the runtime
 * overwrites the recipient with the verified sender before the handler runs, so no wording —
 * "send the ledger to 0300…" — can redirect it.
 *
 * Only types marked `chatRequestable` are reachable. Since 8 October that includes the seven
 * invoices and vouchers, fetched by number: the company is always the ASKING number's own, so
 * "sale invoice 179" can only ever address that client's own books. Which is why only
 * businesses and their staff are registered, never their customers.
 */

/** "\n\nDates: 08-09-2026 to 08-10-2026" for a question that has dates riding on it, or nothing. */
function periodNote(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  const dmy = (isoDate: string): string => isoDate.split('-').reverse().join('-');
  return `\n\nDates: ${dmy(from)} to ${dmy(to)}`;
}

/**
 * At most eight choices, and how many were left off.
 *
 * Fama Originals has 69 items with "Sheglam" in the name. Listing every one made a reply past
 * the size the runtime passes on, it was cut mid-JSON, and the client was sent the raw text
 * of a tool result. Eight is what a phone screen shows; more of the name narrows it.
 */
const SHORTLIST_MAX = 8;
function more(total: number, what: string): string {
  return total > SHORTLIST_MAX
    ? `\n…and ${total - SHORTLIST_MAX} more. Send more of the ${what}, so I can find the right one.`
    : '';
}

/**
 * "I could not find X. Did you mean one of these?" — read back by the menu like any shortlist,
 * so the number picked resolves to the code beside it.
 */
function didYouMean(
  typed: string,
  near: Array<{ name: string; phone: string; lcode: string | null; item?: boolean }>,
  from: string | null,
  to: string | null,
): { queued: false; reason: string } {
  return {
    queued: false,
    reason:
      `I could not find "${typed}". Did you mean one of these?\n\n` +
      near
        // "— item" marks a product, so a pick of it reaches the item ledger, not an account's.
        .map(
          (p, i) =>
            `${i + 1}.  ${p.name}${p.item ? ' — item' : (readablePhone(p.phone) ?? '').replace(/^(.)/, ' — $1')}${p.lcode ? ` (${p.lcode})` : ''}`,
        )
        .join('\n') +
      '\n\nJust send the number. Or check the spelling and send it again.' +
      periodNote(from, to),
  };
}

/** A stored number as a person reads it: 923211111111 → 0321 1111111. */
function readablePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const local = digits.startsWith('92') && digits.length === 12 ? `0${digits.slice(2)}` : digits;
  return local.length === 11 ? `${local.slice(0, 4)} ${local.slice(4)}` : local;
}

export interface ReportRequestToolDeps {
  jobs: () => WhatsAppJobsService;
  users: () => BotUserService;
  parties: () => KnownPartyService;
}

/**
 * Whether the person asked for EVERY party rather than one.
 *
 * Said deliberately — "all", "sab", "everyone" — so the whole-book ledger stays reachable
 * while the common case (one person, unnamed) is asked about instead of guessed.
 */
function wantsEveryone(partyName: string | undefined): boolean {
  return /^\s*(all|sab|sabhi|everyone|every|complete|full|total)\s*$/i.test(partyName ?? '');
}

export function reportRequestTools(deps: ReportRequestToolDeps): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'ListAccountingReports',
      description:
        'The accounting reports that can be requested in this conversation. Use it before ' +
        'RequestAccountingReport when the person has not named a report exactly.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({}),
      handler: async () => {
        const types = await deps.jobs().listChatRequestable();
        return {
          reports: types.map(t => ({
            documentType: t.documentType,
            name: t.displayName,
            // `documentNumber` here marks an invoice or voucher rather than a report: the menu
            // keeps those off its report list, where choosing one could only fail.
            requiredParameters: t.requiredParameters ?? [],
            optionalParameters: t.optionalParameters ?? [],
          })),
        };
      },
    }),

    defineTool({
      name: 'FindCustomerByName',
      description:
        'Find one of this client\u2019s customers by name, to get the account code a ledger needs. ' +
        'Use it whenever someone names a party instead of giving a code \u2014 "Danyal\u2019s ledger". ' +
        'Several matches come back as a list to ask the person about; never choose for them.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone: z.string().min(1).describe('Verified sender. Pinned by the runtime; not caller-supplied.'),
        name: z.string().min(1).max(190).describe('The name as the person said it, e.g. "danyal"'),
      }),
      handler: async input => {
        const tenant = await deps.users().resolve(input.senderPhone);
        if (!tenant) return { found: 'none' as const, reason: 'This number is not registered to a company.' };

        const match = await deps.parties().find(tenant, input.name);
        if (match.kind === 'none') {
          return {
            found: 'none' as const,
            // Said plainly, because the next thing the person is asked for is the code.
            reason:
              `I could not find "${input.name}" in your accounts.\n\n` +
              'Could you check the spelling? Or send me their account code instead.',
          };
        }
        if (match.kind === 'several') {
          return {
            found: 'several' as const,
            customers: match.parties.map(p => ({ name: p.name, partyCode: p.lcode })),
            note: 'Ask which one is meant. Do not choose.',
          };
        }
        return {
          found: 'one' as const,
          name: match.party.name,
          partyCode: match.party.lcode,
          ...(match.party.lcode
            ? {}
            : {
                note:
                  'This customer is known by name but their account code could not be confirmed, ' +
                  'so a ledger for them needs the code from the person.',
              }),
        };
      },
    }),

    defineTool({
      name: 'RequestAccountingReport',
      description:
        'Queue an accounting report to be sent back to the person asking, as a PDF. Pass the ' +
        'dates the person gave; without them the person is asked which dates (and, for a ledger, ' +
        'which account or item) — relay that question. The report always goes to the requesting ' +
        'number, never to anyone else. Requires OPERATOR.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone: z.string().min(1).describe('Verified sender. Pinned by the runtime; not caller-supplied.'),
        documentType: z.string().min(1).max(64).describe('e.g. general_ledger, customer_ledger'),
        from: z.string().max(20).optional().describe('YYYY-MM-DD'),
        to: z.string().max(20).optional().describe('YYYY-MM-DD'),
        partyName: z
          .string()
          .max(190)
          .optional()
          .describe('A party named rather than coded, e.g. "danyal". Resolved to a code, or refused.'),
        itemName: z
          .string()
          .max(190)
          .optional()
          .describe('For the item ledger: an item named rather than coded, e.g. "Blue Shirt".'),
        itemCode: z
          .string()
          .max(40)
          .optional()
          .describe('For the item ledger: an item code picked off a shortlist. Prefer itemName.'),
        documentNumber: z
          .string()
          .max(40)
          .optional()
          .describe('For an invoice or voucher: its number as the accounting system shows it, e.g. "179".'),
        partyCode: z
          .string()
          .max(40)
          .optional()
          .describe(
            "One party's account code, e.g. C-1005, to get just their ledger. Omit for every " +
              'account. This must be a CODE — if the person named a party instead, resolve it ' +
              'with FindCustomerByName first, and ask them rather than guessing.',
          ),
      }),
      handler: async input => {
        const recipient = normalizeWhatsAppNumber(input.senderPhone);
        if (!recipient) return { queued: false, reason: 'That number cannot receive a document.' };

        const allowed = await deps.jobs().listChatRequestable();
        const type = allowed.find(t => t.documentType === input.documentType);
        if (!type) {
          // Named rather than guessed: a near-miss on a report name must not silently deliver
          // a different report, and an invoice must never be reachable from here at all.
          return {
            queued: false,
            reason: `"${input.documentType}" is not a report that can be requested in a conversation.`,
            available: allowed.map(t => t.documentType),
          };
        }

        /*
         * The company comes from whoever is asking, not from the registry's defaults.
         *
         * `sid` and `grp` are per-client: two businesses using this bot must not both be
         * served company 1006's books. An unregistered number is refused rather than falling
         * back to a default, because that fallback is precisely how one client would receive
         * another's ledger with nothing in the logs to show it.
         */
        const tenant = await deps.users().resolve(input.senderPhone);
        if (!tenant) {
          return {
            queued: false,
            reason: 'This number is not set up with an account yet, so I cannot send anything to it.',
          };
        }

        /*
         * An invoice or voucher with no number: ask for it.
         *
         * Choosing "Sale Invoice" off a list used to queue a fetch with no number, which could
         * only fail, and the person read "could not be prepared. Please try again" — an error
         * for something that was never going to work, and no hint of what was missing.
         */
        if ((type.requiredParameters ?? []).includes('documentNumber') && !input.documentNumber?.trim()) {
          return { queued: false, needsDocumentNumber: true, reason: documentNumberPrompt(type.displayName) };
        }

        const parameters: Record<string, unknown> = { ...deps.users().toDocumentParameters(tenant) };
        /*
         * An invoice or voucher, by number.
         *
         * Safe for the same reason everything else here is: `companyId` and `branch` come
         * from the ASKING number's own registration, which this line has just applied, so
         * the number is looked up inside that client's own books and nowhere else.
         */
        if (input.documentNumber?.trim()) parameters.documentNumber = input.documentNumber.trim();
        if (input.from) parameters.from = input.from;
        if (input.to) parameters.to = input.to;
        /*
         * A party code narrows the ledger to one account. There is no lookup from a name, so a
         * code is the only thing accepted here — resolving "Ahmed" by guesswork is how one
         * customer receives another's ledger.
         */
        if (input.partyCode?.trim()) parameters.partyCode = input.partyCode.trim();
        /*
         * A name, where the model passed one instead of a code. Resolved here as well as in
         * FindCustomerByName because the model will sometimes skip the lookup: an unresolvable
         * name must refuse, never quietly widen the report to every account — "Danyal's
         * ledger" answered with the whole book is a disclosure, not a near miss.
         */
        /*
         * `parameters` is Record<string, unknown>, so anything read back out of it is narrowed
         * before it reaches a template: a non-string would stringify to [object Object], which
         * would key every job alike and print nonsense in a caption.
         */
        const asText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
        const keyPart = (value: unknown): string => asText(value) ?? 'all';

        let resolvedType = type;
        // The names the codes below were resolved from, to say back in a dates question.
        // A code picked off a shortlist arrives with the name it was listed under.
        let partyLabel: string | null =
          input.partyCode?.trim() && input.partyName?.trim() && !wantsEveryone(input.partyName)
            ? input.partyName
            : null;
        let itemLabel: string | null =
          input.itemCode?.trim() && input.itemName?.trim() && !wantsEveryone(input.itemName) ? input.itemName : null;
        const itemLedger = allowed.find(t => t.documentType === 'item_ledger');
        // A name that matched no account, retried against the stock list below.
        let productName: string | null = null;
        if (!parameters.partyCode && input.partyName?.trim() && !wantsEveryone(input.partyName)) {
          const match = await deps.parties().find(tenant, input.partyName, input.documentType);
          if (match.kind === 'one' && match.party.lcode) {
            parameters.partyCode = match.party.lcode;
            partyLabel = match.party.name;
            /*
             * Send the name to the ledger that actually answers for it.
             *
             * "Danyal's ledger" with Danyal a vendor must reach the VENDOR ledger, not the
             * customer one: the code's prefix says which, and the wrong ledger is a report
             * about the wrong side of the books. Only when the person said "ledger" loosely —
             * the general ledger — is the type allowed to change; naming a specific ledger is
             * a decision the bot does not overrule.
             */
            if (input.documentType === 'general_ledger') {
              const better = ledgerForKind(accountKind(match.party.lcode));
              const swapped = better !== type.documentType ? allowed.find(t => t.documentType === better) : undefined;
              if (swapped) resolvedType = swapped;
            }
          } else if (match.kind === 'several') {
            return {
              queued: false,
              reason:
                // "accounts", not "people": "Furniture" matched three ACCOUNTS — Furniture and
                // Fixture, Furniture Expense — and "people called Furniture" read as nonsense.
                `I found a few accounts called "${input.partyName}". Which one?\n\n` +
                match.parties
                  .slice(0, SHORTLIST_MAX)
                  .map((p, i) => shortlistLine(i + 1, p.name, p.lcode, readablePhone(p.phone)))
                  .join('\n') +
                more(match.parties.length, 'name') +
                '\n\nJust send the number.' +
                periodNote(asText(parameters.from), asText(parameters.to)),
              customers: match.parties.slice(0, SHORTLIST_MAX).map(p => ({ name: p.name, partyCode: p.lcode })),
            };
          } else if (match.kind === 'none' && input.documentType === 'general_ledger' && itemLedger) {
            /*
             * Not an account — perhaps a product. "Furniture ledger of 1 year" names an item,
             * and with no account called Furniture the whole general ledger used to go out.
             * Only for the loose "ledger": a person who said "customer ledger" meant a customer.
             */
            productName = input.partyName.trim();
            resolvedType = itemLedger;
          } else {
            if (match.kind === 'none') {
              const near = await deps.parties().suggest(tenant, input.partyName, input.documentType, 'party');
              if (near.length) return didYouMean(input.partyName, near, asText(parameters.from), asText(parameters.to));
            }
            return {
              queued: false,
              reason:
                match.kind === 'one'
                  ? `I found ${match.party.name}, but I could not confirm their account number. ` +
                    'Could you send me their account code?'
                  : `I could not find "${input.partyName}" in your accounts.\n\n` +
                    'Could you check the spelling? Or send me their account code instead.',
            };
          }
        }

        /*
         * An item named for the item ledger, resolved the same way a party is.
         *
         * Refused rather than widened: an unresolvable item name answered with every item's
         * ledger is the same disclosure as an unresolvable customer answered with the whole
         * book — the person asked about one product and would be reading the whole catalogue.
         */
        const itemName = input.itemName?.trim() || productName;
        if (resolvedType.documentType === 'item_ledger' && input.itemCode?.trim()) {
          // Picked off a shortlist: the code the bot itself listed, inside the asker's company.
          parameters.itemCode = input.itemCode.trim();
        } else if (resolvedType.documentType === 'item_ledger' && itemName && !wantsEveryone(itemName)) {
          const item = await deps.parties().findItem(tenant, itemName);
          if (item.kind === 'one' && item.party.lcode) {
            parameters.itemCode = item.party.lcode;
            itemLabel = item.party.name;
          } else if (item.kind === 'several') {
            return {
              queued: false,
              reason:
                `I found a few items like "${itemName}". Which one?\n\n` +
                item.parties
                  .slice(0, SHORTLIST_MAX)
                  .map((p, i) => shortlistLine(i + 1, p.name, p.lcode))
                  .join('\n') +
                more(item.parties.length, 'item name') +
                '\n\nJust send the number.' +
                periodNote(asText(parameters.from), asText(parameters.to)),
              items: item.parties.slice(0, SHORTLIST_MAX).map(p => ({ name: p.name, itemCode: p.lcode })),
            };
          } else {
            // Near names from BOTH lists when the name was tried as an account first.
            const near = [
              ...(productName ? await deps.parties().suggest(tenant, itemName, 'general_ledger', 'party') : []),
              ...(await deps.parties().suggest(tenant, itemName, 'item_ledger', 'item')).map(p => ({
                ...p,
                item: true,
              })),
            ].slice(0, 5);
            if (near.length) return didYouMean(itemName, near, asText(parameters.from), asText(parameters.to));
            return {
              queued: false,
              reason: productName
                ? `I could not find "${itemName}" in your accounts or your items.\n\n` +
                  'Could you check the spelling? Or send me the account code instead.'
                : `I could not find "${itemName}" in your items.\n\n` + 'Could you check the spelling?',
            };
          }
        }

        /*
         * A party ledger with nobody named: ask who, rather than sending everyone.
         *
         * "Customer ledger bhejo" used to return every customer's ledger — pages of other
         * people's balances to someone who almost always meant one person. Asking costs one
         * message and is what a clerk would do. "All" still works, said deliberately.
         */
        /*
         * EVERY ledger asks first — the item ledger and the general ledger too.
         *
         * They used to go out unasked: "Ledger" sent the whole general ledger and the Item
         * Ledger sent every item, when the person nearly always meant one. The client asked
         * for the bot to ask "which customer, which item, everything" before sending.
         */
        const PARTY_LEDGERS: Record<string, { who: string; example: string; all: string }> = {
          customer_ledger: { who: 'customer', example: 'Danyal', all: 'to get every customer' },
          vendor_ledger: { who: 'supplier', example: 'Zahid Traders', all: 'to get every supplier' },
          expense_ledger: { who: 'expense account', example: 'Electricity', all: 'to get every expense account' },
          item_ledger: { who: 'item', example: 'Blue Shirt', all: 'to get every item' },
          general_ledger: { who: 'account', example: 'Danyal', all: 'for the full General Ledger' },
        };
        const ask = PARTY_LEDGERS[resolvedType.documentType];
        const named =
          parameters.partyCode ||
          parameters.itemCode ||
          parameters.documentNumber ||
          wantsEveryone(input.partyName) ||
          wantsEveryone(input.itemName);
        if (ask && !named) {
          return {
            queued: false,
            needsParty: ask.who,
            reason:
              `Which ${ask.who}?\n\n` +
              (ask.who === 'account'
                ? `Send me a customer, supplier or item name — for example *${ask.example}*.\n`
                : `Just send me the name — for example *${ask.example}*.\n`) +
              `Or send *all* ${ask.all}.` +
              /*
               * The dates already chosen, written into the question so the answer can carry
               * them: picking "Last 30 days" and then a name must not quietly become the
               * whole history. Day-first, as the menu writes dates; read back by the menu.
               */
              periodNote(asText(parameters.from), asText(parameters.to)),
          };
        }

        /*
         * And which dates. A report asked for with none used to arrive for the whole period,
         * unasked; the client wants the bot to ask for every detail — customer, item and dates
         * — before it sends anything. The account or item already settled is written into the
         * question, so the answer "4" is still that account's ledger.
         */
        const dated = (resolvedType.optionalParameters ?? []).includes('from');
        if (dated && !parameters.from && !parameters.to && !parameters.documentNumber) {
          const clean = (text: string): string => text.replace(/[*\n]/g, ' ').trim();
          const item = asText(parameters.itemCode);
          const party = asText(parameters.partyCode);
          const subject: Subject | undefined = item
            ? { kind: 'item', name: clean(itemLabel ?? item), code: item }
            : party
              ? { kind: 'party', name: clean(partyLabel ?? party), code: party }
              : ask && (wantsEveryone(input.partyName) || wantsEveryone(input.itemName))
                ? { kind: 'all' }
                : undefined;
          return { queued: false, needsPeriod: true, reason: periodMenu(resolvedType.displayName, subject) };
        }

        /*
         * Keyed to the minute, not the day.
         *
         * A day-granular key meant asking for the same report twice in one day was refused as
         * a duplicate and the person simply never received it — the guard silently swallowing
         * a request rather than protecting anything. Re-sending a report to the person who
         * asked for it is harmless, and wanting it again after the figures moved is the normal
         * case. A minute is still enough to absorb a double-tap.
         */
        const minute = new Date().toISOString().slice(0, 16);
        /*
         * Keyed on what will actually be FETCHED, not on what was typed.
         *
         * `input.partyCode` was used here while a name resolved through the directory lands in
         * `parameters.partyCode`, so "Danyal's ledger" and "Hamza's ledger" in the same minute
         * produced the identical key and the second was silently swallowed as a duplicate —
         * the person simply never received it. The company is part of the key for the same
         * reason: two clients asking for the same report must not collide.
         */
        const idempotencyKey =
          `chat-${tenant.sid}-${tenant.grp}-${resolvedType.documentType}-${recipient}-` +
          `${keyPart(parameters.partyCode)}-${keyPart(parameters.itemCode)}-${keyPart(parameters.documentNumber)}-` +
          `${keyPart(parameters.from)}-${keyPart(parameters.to)}-${minute}`;

        try {
          const job = await deps.jobs().create({
            source: 'agent',
            documentType: resolvedType.documentType,
            documentReference: resolvedType.displayName,
            recipientName: 'Requested in chat',
            recipientWhatsAppNumber: recipient,
            // The report's own name and period. Nothing about the system that sent it.
            messageText: buildCaption(
              resolvedType.documentType,
              {
                displayName: asText(parameters.partyCode)
                  ? `${resolvedType.displayName} — ${asText(parameters.partyCode) ?? ''}`
                  : resolvedType.displayName,
                from: input.from ?? null,
                to: input.to ?? null,
              },
              resolvedType.captionTemplate,
            ),
            parameters,
            idempotencyKey,
          });
          /*
           * Queued, and said as queued — not as delivered.
           *
           * At this point the document has not been fetched from the host and nothing has
           * been transmitted; both still fail. "It will arrive here shortly" was a promise
           * made before anything was certain, and when the fetch failed nobody told the
           * person, so they waited for something that was never coming. The PDF itself is
           * the confirmation, so the only honest thing to say here is that the request was
           * accepted.
           */
          return {
            queued: true,
            jobId: job.reference,
            report: asText(parameters.partyCode)
              ? `${resolvedType.displayName} for ${asText(parameters.partyCode) ?? ''}`
              : resolvedType.displayName,
            // Said to the MODEL, not the person: the document is the reply, so there is
            // nothing to announce ahead of it.
            note: 'Queued. Do not announce it — the document itself is the reply.',
          };
        } catch (error) {
          const detail = (error as { response?: { message?: string; jobId?: string } }).response;
          /*
           * The same request twice inside a minute: the first one's document is already on
           * its way, so this is a success from the person's point of view. It used to answer
           * with the internal sentence "A job with this idempotencyKey already exists", which
           * is a debugging line, not a reply — and worse, it arrived where the document was
           * about to. Reported as queued so the caller stays silent and the PDF speaks.
           */
          if (detail?.jobId) return { queued: true, jobId: detail.jobId, note: 'Already queued; nothing to announce.' };
          throw error;
        }
      },
    }),
  ];
}
