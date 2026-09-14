import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { defineTool } from '../tool-descriptor';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { WhatsAppJobsService } from '../../../modules/whatsapp-jobs/whatsapp-jobs.service';
import type { ContactMapper } from '../../../integrations/whatsapp/contact-mapper';
import { normalizeWhatsAppNumber } from '../../../modules/whatsapp-jobs/providers/whatsapp-delivery.provider';

/**
 * The agent's one door into document delivery.
 *
 * §6 is precise about the division of labour, and it is the right one: the agent decides
 * *what* to send and *to whom*, and then writes a row. It never fetches the document and
 * never talks to WhatsApp — the worker does both. So a model that has been talked into
 * something can, at worst, create a job that a human can see, cancel and audit.
 *
 * Being on the write tier puts it behind the approval gate for WhatsApp-originated requests,
 * and it is absent from the customer allowlist, so no customer message can reach it however
 * it is phrased.
 */

export interface WhatsAppJobToolDeps {
  jobs: () => WhatsAppJobsService;
  contacts: () => ContactMapper;
}

export function whatsappJobTools(deps: WhatsAppJobToolDeps): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'create_whatsapp_document_job',
      description:
        'Queue a document to be sent to a WhatsApp recipient. Use only after the exact document, ' +
        'the exact party and the exact recipient number are all known. If more than one contact ' +
        'matches the name, ask the user which one — never choose. This creates a job; a background ' +
        'worker fetches the document and sends it. Requires OPERATOR.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        document_type: z.string().min(1).max(64).describe('e.g. "invoice" — must exist in the document type registry'),
        document_reference: z.string().min(1).max(120).describe('e.g. "INV-1001"'),
        client_id: z.string().max(64).optional(),
        party_id: z.string().max(64).optional(),
        recipient_name: z.string().max(190).optional(),
        recipient_whatsapp_number: z.string().min(8).max(24).describe('Country code required'),
        message_text: z.string().max(1024).optional(),
        parameters: z.record(z.string(), z.unknown()).optional().describe('Passed to the document API'),
      }),
      handler: async input => {
        const recipient = normalizeWhatsAppNumber(input.recipient_whatsapp_number);
        if (!recipient) {
          return {
            created: false,
            reason: 'That is not a usable WhatsApp number. It needs a country code and 8–15 digits.',
          };
        }

        /*
         * An ambiguous name is a question, not a ranking problem.
         *
         * §6 forbids guessing, and the reason is concrete: three customers called Ali means
         * sending one customer another customer's invoice, which is a data breach that looks
         * like a helpful assistant. The agent is handed the candidates and must ask.
         */
        if (input.recipient_name) {
          const matches = await deps.contacts().searchContacts(input.recipient_name, 5);
          const distinct = matches.filter(m => m.phoneE164);
          const namedIsAmongThem = distinct.some(m => normalizeWhatsAppNumber(m.phoneE164) === recipient);
          if (distinct.length > 1 && !namedIsAmongThem) {
            return {
              created: false,
              reason: 'More than one contact matches that name and the number given is not one of them. Ask which.',
              candidates: distinct.map(m => ({ name: m.displayName, company: m.company, phone: m.phoneE164 })),
            };
          }
        }

        const idempotencyKey = `${input.document_type}-${input.document_reference}-${recipient}`;
        try {
          const job = await deps.jobs().create({
            source: 'agent',
            documentType: input.document_type,
            documentReference: input.document_reference,
            documentName: `${input.document_reference}.pdf`,
            clientId: input.client_id,
            partyId: input.party_id,
            recipientName: input.recipient_name,
            recipientWhatsAppNumber: recipient,
            messageText: input.message_text,
            parameters: input.parameters ?? {},
            idempotencyKey,
          });
          return {
            created: true,
            jobId: job.reference,
            status: job.status,
            note: 'Queued. A background worker will fetch the document and send it.',
          };
        } catch (error) {
          // A duplicate is the guard working, so it is reported as an outcome rather than an
          // error the model should try to route around.
          const detail = (error as { response?: { message?: string; jobId?: string } }).response;
          if (detail?.jobId) {
            return { created: false, duplicateOf: detail.jobId, reason: detail.message ?? 'Already queued.' };
          }
          throw error;
        }
      },
    }),
  ];
}
