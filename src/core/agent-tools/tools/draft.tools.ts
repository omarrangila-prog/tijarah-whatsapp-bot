import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { defineTool } from '../tool-descriptor';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { DraftService } from '../../../modules/whatsapp-jobs/drafts/draft.service';

/**
 * Phase Three: creating a document from a WhatsApp conversation.
 *
 * Every tool here is `senderScoped`, so a draft belongs to the number composing it and cannot
 * be addressed, edited or submitted by anyone else quoting its reference. That is the whole
 * of the ownership model, and it holds without a permission check of its own because the
 * runtime pins the number before the handler runs.
 *
 * None of these writes to the accounting system. The most any of them does is put a document
 * on Tijarah Books' approval screen, where a person accepts or rejects it — the specification
 * says "do not make final entry" for all twelve types, and `ApprovalSubmissionPort` is shaped
 * so there is no other option available to call.
 */

export interface DraftToolDeps {
  drafts: () => DraftService;
}

/**
 * The line a person reads back after each step.
 *
 * The generic tool summariser reduces an object to its most identifying field, which for a
 * draft is the reference — so every step in the conversation answered "DRAFT-1001" and told
 * nobody what to do next. A `summary` is what the summariser prefers, so each tool writes the
 * sentence it wants said.
 */
function nextPrompt(next: { label: string; hint?: string } | null | undefined): string {
  if (!next) return '';
  return `\nNext: *${next.label}*${next.hint ? ` — ${next.hint}` : ''}`;
}

export function draftTools(deps: DraftToolDeps): AnyToolDescriptor[] {
  const senderPhone = z.string().min(1).describe('Verified sender. Pinned by the runtime; not caller-supplied.');

  /*
   * A model extracts "5 Product A at 1200" as the numbers 5 and 1200, not the strings. The
   * host wants text, and rejecting a number here surfaced to the person as "bad request" —
   * the tool refusing the very input it had asked for.
   */
  const text = z.union([z.string(), z.number()]).transform(v => String(v));
  const optionalText = text.optional();

  return [
    defineTool({
      name: 'ListCreatableDocuments',
      description: 'The documents and accounts that can be created from a conversation.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({}),
      handler: () => {
        const documents = deps.drafts().listCreatableTypes();
        return Promise.resolve({
          documents,
          summary: `I can create:\n${documents.map(d => `• ${d.displayName}`).join('\n')}`,
        });
      },
    }),

    defineTool({
      name: 'StartDocumentDraft',
      description:
        'Begin creating a document or account. Returns the first thing needed. One draft at a ' +
        'time per person. Nothing is entered into the accounting system.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        documentType: z.string().min(1).max(64).describe('e.g. create_sale_invoice, create_customer_account'),
      }),
      handler: async input => {
        const result = await deps.drafts().start(input.senderPhone, input.documentType);
        const next = result.nextField
          ? { name: result.nextField.name, label: result.nextField.label, hint: result.nextField.hint }
          : null;
        return {
          started: result.ok,
          reference: result.draft?.reference ?? null,
          nextField: next,
          summary: result.ok ? `${result.message}${nextPrompt(next)}` : result.message,
        };
      },
    }),

    defineTool({
      name: 'SetDraftField',
      description: 'Supply one value on the document being composed, e.g. the customer or the date.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        field: z.string().min(1).max(64),
        value: z.string().min(1).max(300),
      }),
      handler: async input => {
        const result = await deps.drafts().setField(input.senderPhone, input.field, input.value);
        const next = result.nextField
          ? { name: result.nextField.name, label: result.nextField.label, hint: result.nextField.hint }
          : null;
        const ready = result.draft ? deps.drafts().isComplete(result.draft) : false;
        return {
          accepted: result.ok,
          nextField: next,
          readyToSubmit: ready,
          summary:
            `${result.message}${nextPrompt(next)}` +
            (ready ? '\n\nReady. Say *review* to check it, or *submit* to send it for approval.' : ''),
        };
      },
    }),

    defineTool({
      name: 'AnswerDraftPrompt',
      description:
        'Apply a value to whichever field the person was last asked for. Use when they answer ' +
        'the question rather than naming a field.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({ senderPhone, value: z.string().min(1).max(300) }),
      handler: async input => {
        const result = await deps.drafts().answerPrompt(input.senderPhone, input.value);
        const next = result.nextField
          ? { name: result.nextField.name, label: result.nextField.label, hint: result.nextField.hint }
          : null;
        const ready = result.draft ? deps.drafts().isComplete(result.draft) : false;
        const spec = result.draft ? deps.drafts().review(result.draft) : null;
        return {
          accepted: result.ok,
          nextField: next,
          readyToSubmit: ready,
          summary:
            `${result.message}${nextPrompt(next)}` +
            (!next && !ready && spec
              ? '\n\nNow add the lines, like "250 cotton fabric at 600".'
              : ready
                ? '\n\nReady. Say *review* to check it, or *submit* to send it for approval.'
                : ''),
        };
      },
    }),

    defineTool({
      name: 'AddDraftLineItem',
      description: 'Add one line to the invoice being composed: what it is, how many, and the rate.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        description: z.string().min(1).max(200),
        quantity: z.string().max(20).optional(),
        rate: z.string().max(20).optional(),
      }),
      handler: async input => {
        const result = await deps.drafts().addLineItem(input.senderPhone, {
          description: input.description,
          quantity: input.quantity ?? '1',
          rate: input.rate ?? '0',
        });
        const ready = result.draft ? deps.drafts().isComplete(result.draft) : false;
        const review = result.draft ? deps.drafts().review(result.draft) : null;
        return {
          added: result.ok,
          readyToSubmit: ready,
          summary:
            `${result.message}` +
            (review ? `\nRunning total: ${String(review.total)}` : '') +
            (ready ? '\n\nAdd another line, or say *submit* to send it for approval.' : ''),
        };
      },
    }),

    defineTool({
      name: 'ComposeDocument',
      description:
        'Create a document or account in ONE step from everything the person said: the type, the ' +
        'party, the date, any line items. Use this when the message already contains the details — ' +
        'do not ask for fields that are not listed here. Only these fields exist: for invoices and ' +
        'returns: partyName, partyCode, date, referenceNo, discount, and items (name, code, qty, rate, ' +
        'uom); for payment/receive vouchers: fromName, fromCode, toName, toCode, amount, date, ' +
        'referenceNo, remarks; for accounts: name, code, phone, address; for items: name, code, uom, ' +
        'rate. Codes default to NEW. Returns the draft for review; it is NOT submitted until ' +
        'SubmitDraftForApproval is called. Nothing is entered into the accounting system.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({
        senderPhone,
        documentType: z.string().min(1).max(64).describe('e.g. create_sale_invoice, create_payment_voucher'),
        /*
         * Every field named explicitly rather than as a free-form record.
         *
         * A record with no declared properties cannot be expressed to Gemini, so the schema
         * translation had turned it into a string — and the model then sent a JSON string
         * where the tool wanted an object. Naming each field also tells the model what exists,
         * which is what stopped it inventing a "due date".
         */
        fields: z
          .object({
            date: optionalText.describe('YYYY-MM-DD or "today"'),
            referenceNo: optionalText,
            partyName: optionalText.describe('Customer or supplier, for invoices and returns'),
            partyCode: optionalText,
            discount: optionalText,
            fromName: optionalText.describe('Vouchers: who the money came from'),
            fromCode: optionalText,
            toName: optionalText.describe('Vouchers: where it went, e.g. a bank or cash account'),
            toCode: optionalText,
            amount: optionalText,
            remarks: optionalText,
            name: optionalText.describe('Accounts and items'),
            code: optionalText,
            phone: optionalText,
            address: optionalText,
            uom: optionalText,
            rate: optionalText,
          })
          .optional(),
        items: z
          .array(
            z.object({
              name: text,
              code: optionalText,
              qty: optionalText,
              rate: optionalText,
              uom: optionalText,
            }),
          )
          .optional()
          .describe('Line items, for invoices and returns only'),
      }),
      handler: async input => {
        const drafts = deps.drafts();
        /*
         * A previous unfinished draft is replaced, not stacked.
         *
         * A person who says "create a sale invoice…" twice means the second one; keeping the
         * first would put every subsequent answer on the wrong document. Cancelling is the
         * only honest reading, and nothing has left the building so nothing is lost.
         */
        const existing = await drafts.openDraftFor(input.senderPhone);
        if (existing) await drafts.cancel(input.senderPhone);

        const started = await drafts.start(input.senderPhone, input.documentType);
        if (!started.ok) return { composed: false, message: started.message };

        const rejected: string[] = [];
        for (const [name, value] of Object.entries(input.fields ?? {})) {
          if (!value?.trim()) continue;
          const set = await drafts.setField(input.senderPhone, name, value);
          if (!set.ok) rejected.push(`${name}: ${set.message}`);
        }
        for (const item of input.items ?? []) {
          const added = await drafts.addLineItem(input.senderPhone, {
            description: item.name,
            quantity: item.qty ?? '1',
            rate: item.rate ?? '0',
          });
          if (!added.ok) rejected.push(`item ${item.name}: ${added.message}`);
        }

        const draft = await drafts.openDraftFor(input.senderPhone);
        if (!draft) return { composed: false, message: 'The draft could not be read back.' };
        const review = drafts.review(draft);
        return {
          composed: true,
          reference: draft.reference,
          ...review,
          rejected: rejected.length ? rejected : undefined,
          next: review.readyToSubmit
            ? 'Read it back to the person and ask them to confirm; then call SubmitDraftForApproval.'
            : `Ask the person for: ${String(review.missing)}.`,
        };
      },
    }),

    defineTool({
      name: 'ReviewDraft',
      description: 'Read back everything collected so far, with the total and anything still missing.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({ senderPhone }),
      handler: async input => {
        const draft = await deps.drafts().openDraftFor(input.senderPhone);
        if (!draft) return { found: false, summary: 'There is no document in progress.' };

        const review = deps.drafts().review(draft);
        const details = (review.details as Array<{ label: string; value: string }>).map(d => `${d.label}: ${d.value}`);
        const lines = (
          review.lineItems as Array<{ description: string; quantity: string; rate: string; amount: string }>
        ).map(l => `• ${l.description} — ${l.quantity} × ${l.rate} = ${l.amount}`);
        return {
          found: true,
          ...review,
          summary: [
            `*${String(review.document)} ${String(review.reference)}*`,
            ...details,
            ...(lines.length ? ['', ...lines, `*Total: ${String(review.total)}*`] : []),
            '',
            review.readyToSubmit
              ? 'Ready. Say *submit* to send it for approval.'
              : `Still needed: ${String(review.missing)}`,
          ].join('\n'),
        };
      },
    }),

    defineTool({
      name: 'SubmitDraftForApproval',
      description:
        'Send the completed document to the approval screen in the accounting system. It is NOT ' +
        'entered — a person approves or rejects it there. Review before calling this.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({ senderPhone }),
      handler: async input => {
        const result = await deps.drafts().submit(input.senderPhone);
        return {
          submitted: result.ok,
          reference: result.draft?.reference ?? null,
          approvalRef: result.draft?.submittedRef ?? null,
          // Said in the reply as well as the description: nothing here posts an entry.
          summary: result.ok
            ? `*${result.draft?.displayName ?? 'Document'} ${result.draft?.reference ?? ''}* submitted.\n\n${result.message}\n\n_It is waiting on the approval screen. No entry has been made._`
            : result.message,
        };
      },
    }),

    defineTool({
      name: 'CancelDraft',
      description: 'Abandon the document being composed.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      senderScoped: true,
      inputSchema: z.object({ senderPhone }),
      handler: async input => {
        const result = await deps.drafts().cancel(input.senderPhone);
        return { cancelled: result.ok, summary: result.message };
      },
    }),
  ];
}
