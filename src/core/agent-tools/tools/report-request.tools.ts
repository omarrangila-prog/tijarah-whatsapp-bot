import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { defineTool } from '../tool-descriptor';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { WhatsAppJobsService } from '../../../modules/whatsapp-jobs/whatsapp-jobs.service';
import { normalizeWhatsAppNumber } from '../../../modules/whatsapp-jobs/providers/whatsapp-delivery.provider';
import { buildCaption } from '../../../modules/whatsapp-jobs/caption';
import type { BotUserService } from '../../../modules/whatsapp-jobs/tenancy/bot-user.service';

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
        partyCode: z
          .string()
          .max(40)
          .optional()
          .describe(
            "One party's account code, e.g. C-1005, to get just their ledger. Omit for every " +
              'account. This must be a CODE — if the person named a party without one, ask them ' +
              'for the code rather than guessing.',
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
         * Keyed to the minute, not the day.
         *
         * A day-granular key meant asking for the same report twice in one day was refused as
         * a duplicate and the person simply never received it — the guard silently swallowing
         * a request rather than protecting anything. Re-sending a report to the person who
         * asked for it is harmless, and wanting it again after the figures moved is the normal
         * case. A minute is still enough to absorb a double-tap.
         */
        const minute = new Date().toISOString().slice(0, 16);
        // The company is part of the key: without it two clients asking for the same report in
        // the same minute would collide and the second would be refused as a duplicate.
        const idempotencyKey =
          `chat-${tenant.sid}-${tenant.grp}-${input.documentType}-${recipient}-` +
          `${input.partyCode ?? 'all'}-${input.from ?? 'all'}-${input.to ?? 'all'}-${minute}`;

        try {
          const job = await deps.jobs().create({
            source: 'agent',
            documentType: type.documentType,
            documentReference: type.displayName,
            recipientName: 'Requested in chat',
            recipientWhatsAppNumber: recipient,
            // The report's own name and period. Nothing about the system that sent it.
            messageText: buildCaption(
              type.documentType,
              {
                displayName: input.partyCode ? `${type.displayName} — ${input.partyCode}` : type.displayName,
                from: input.from ?? null,
                to: input.to ?? null,
              },
              type.captionTemplate,
            ),
            parameters,
            idempotencyKey,
          });
          return {
            queued: true,
            jobId: job.reference,
            report: input.partyCode ? `${type.displayName} for ${input.partyCode}` : type.displayName,
            note: 'It will arrive here shortly.',
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
