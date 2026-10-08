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

/**
 * Phase Two: asking for an accounting report in a WhatsApp conversation.
 *
 * The whole of the difference from Phase One is who chooses the recipient. A queued invoice
 * names its customer; a chat request names nobody, so the report goes to **the number that
 * asked for it** and nowhere else. That is why the tool is `senderScoped`: the runtime
 * overwrites the recipient with the verified sender before the handler runs, so no wording —
 * "send the ledger to 0300…" — can redirect it.
 *
 * Only types marked `chatRequestable` are reachable, which is reports and not invoices. An
 * invoice belongs to a named customer and needs a document number; "send me invoice 104" from
 * anyone on the allowlist is how one customer's invoice reaches another.
 */

export interface ReportRequestToolDeps {
  jobs: () => WhatsAppJobsService;
  users: () => BotUserService;
  parties: () => KnownPartyService;
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
              `No customer called "${input.name}" has been seen in your books yet. ` +
              'A customer appears here once a document has been sent to them.',
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
        'Queue an accounting report to be sent back to the person asking, as a PDF. Dates are ' +
        'optional — omitting them returns the full period. The report always goes to the ' +
        'requesting number, never to anyone else. Requires OPERATOR.',
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
            reason: 'This number is not registered to a company, so there is nothing it can be shown.',
          };
        }

        const parameters: Record<string, unknown> = { ...deps.users().toDocumentParameters(tenant) };
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
        if (!parameters.partyCode && input.partyName?.trim()) {
          const match = await deps.parties().find(tenant, input.partyName, input.documentType);
          if (match.kind === 'one' && match.party.lcode) {
            parameters.partyCode = match.party.lcode;
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
              reason: `More than one customer matches "${input.partyName}".`,
              customers: match.parties.map(p => ({ name: p.name, partyCode: p.lcode })),
            };
          } else {
            return {
              queued: false,
              reason:
                match.kind === 'one'
                  ? `"${match.party.name}" is known, but their account code could not be confirmed. Please give the code.`
                  : `No customer called "${input.partyName}" has been seen in your books. Please give the account code.`,
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
        if (resolvedType.documentType === 'item_ledger' && input.itemName?.trim()) {
          const item = await deps.parties().findItem(tenant, input.itemName);
          if (item.kind === 'one' && item.party.lcode) {
            parameters.itemCode = item.party.lcode;
          } else if (item.kind === 'several') {
            return {
              queued: false,
              reason: `More than one item matches "${input.itemName}".`,
              items: item.parties.map(p => ({ name: p.name, itemCode: p.lcode })),
            };
          } else {
            return {
              queued: false,
              reason: `No item called "${input.itemName}" is in your stock list. Please check the name.`,
            };
          }
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
          `${keyPart(parameters.partyCode)}-${keyPart(parameters.itemCode)}-` +
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
          if (detail?.jobId) return { queued: false, alreadyQueued: detail.jobId, reason: detail.message };
          throw error;
        }
      },
    }),
  ];
}
