import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { DocumentDraft } from './document-draft.entity';
import { CREATABLE_TYPES, findCreatableType, type DraftFieldSpec, type DraftLineItem } from './draft-schema';
import { APPROVAL_SUBMISSION_PORT, type ApprovalSubmissionPort } from './approval-submission.port';
import { normalizeWhatsAppNumber } from '../providers/whatsapp-delivery.provider';

export interface DraftOutcome {
  ok: boolean;
  draft?: DocumentDraft;
  message: string;
  /** The next thing the person needs to supply, when the draft is still incomplete. */
  nextField?: DraftFieldSpec | null;
}

/**
 * Composing a document in conversation, and submitting it for approval.
 *
 * The service owns three rules, and each of them exists because the alternative goes wrong
 * quietly rather than loudly:
 *
 *  1. **One open draft per number.** Two half-built invoices in one conversation means an
 *     answer landing on the wrong one, and nobody noticing until an approval screen shows a
 *     quantity against the wrong customer.
 *  2. **Only the composer may touch it.** A draft is addressed by the number that started it,
 *     never by a reference someone else can quote.
 *  3. **Submission is one-way and once.** A submitted draft is closed; re-submitting would put
 *     the same document on the approval screen twice, and the second one gets approved by
 *     somebody who assumes it is a different order.
 */
@Injectable()
export class DraftService {
  private readonly logger = createLogger('DraftService');

  constructor(
    @InjectRepository(DocumentDraft, 'data') private readonly drafts: Repository<DocumentDraft>,
    @Inject(APPROVAL_SUBMISSION_PORT) private readonly submission: ApprovalSubmissionPort,
  ) {}

  listCreatableTypes(): Array<{ documentType: string; displayName: string; hasLineItems: boolean }> {
    return CREATABLE_TYPES.map(t => ({
      documentType: t.documentType,
      displayName: t.displayName,
      hasLineItems: t.hasLineItems,
    }));
  }

  private async nextReference(): Promise<string> {
    return `DRAFT-${1001 + (await this.drafts.count())}`;
  }

  /** The draft this number is currently composing, if any. */
  async openDraftFor(phone: string): Promise<DocumentDraft | null> {
    const owner = normalizeWhatsAppNumber(phone);
    if (!owner) return null;
    return this.drafts.findOne({
      where: [
        { createdByPhone: owner, status: 'COLLECTING' },
        { createdByPhone: owner, status: 'READY' },
      ],
      order: { createdAt: 'DESC' },
    });
  }

  async start(phone: string, documentType: string, conversationId?: string | null): Promise<DraftOutcome> {
    const owner = normalizeWhatsAppNumber(phone);
    if (!owner) return { ok: false, message: 'That number cannot start a document.' };

    const spec = findCreatableType(documentType);
    if (!spec) {
      return {
        ok: false,
        message: `"${documentType}" is not something that can be created here.`,
      };
    }
    /*
     * Refused here rather than on submission.
     *
     * The host accepts four request types today; the other eight answer with a validation
     * error. Discovering that after somebody has typed a date, a party and three line items
     * wastes their time and reads like a fault — so the type that cannot land is declined at
     * the moment it is asked for, and the ones that can are named.
     */
    if (!spec.submittable) {
      const available = CREATABLE_TYPES.filter(t => t.submittable)
        .map(t => t.displayName)
        .join(', ');
      return {
        ok: false,
        message: `${spec.displayName} cannot be created over WhatsApp yet — Tijarah Books has not enabled it. You can create: ${available}.`,
      };
    }

    const existing = await this.openDraftFor(owner);
    if (existing) {
      /*
       * A stranded draft is cleared rather than allowed to block.
       *
       * A draft started before the host's supported types were known can never be submitted,
       * so refusing every new document until the person "finishes or cancels" it traps them
       * with no way forward that they were ever told about.
       */
      if (!findCreatableType(existing.documentType)?.submittable) {
        await this.cancel(owner);
      } else {
        return {
          ok: false,
          draft: existing,
          message: `You already have ${existing.displayName} ${existing.reference} in progress. Finish or cancel it first.`,
        };
      }
    }

    const now = new Date();
    const draft = await this.drafts.save(
      this.drafts.create({
        reference: await this.nextReference(),
        documentType: spec.documentType,
        displayName: spec.displayName,
        createdByPhone: owner,
        conversationId: conversationId ?? null,
        status: 'COLLECTING',
        fields: {},
        lineItems: [],
        createdAt: now,
        updatedAt: now,
      }),
    );

    this.logger.log(`${draft.reference}: ${spec.displayName} started by ${owner}`);
    return {
      ok: true,
      draft,
      message: `Started ${spec.displayName} ${draft.reference}.`,
      nextField: this.missingField(draft),
    };
  }

  /** The first required field with no value yet, or null when the header is complete. */
  missingField(draft: DocumentDraft): DraftFieldSpec | null {
    const spec = findCreatableType(draft.documentType);
    if (!spec) return null;
    const values = draft.fields ?? {};
    /*
     * Asked in conversational order, which is not the form's order.
     *
     * The form lists Date first because that is how the client laid it out. Asked aloud, "who
     * is it for?" before "what date?" is how anyone actually raises an invoice, and a bot that
     * opens with the date reads as a form talking. The template keeps its order; this only
     * changes what is asked first.
     */
    const FIRST: ReadonlyArray<string> = ['partyName', 'fromName', 'name'];
    const ordered = [...spec.fields].sort((a, b) => {
      const ai = FIRST.indexOf(a.name);
      const bi = FIRST.indexOf(b.name);
      return (ai === -1 ? FIRST.length : ai) - (bi === -1 ? FIRST.length : bi);
    });
    return ordered.find(f => f.required && !values[f.name]?.trim()) ?? null;
  }

  async setField(phone: string, name: string, value: string): Promise<DraftOutcome> {
    const draft = await this.requireOpenDraft(phone);
    if ('message' in draft && !('id' in draft)) return draft;
    const open = draft as DocumentDraft;

    const spec = findCreatableType(open.documentType);
    const field = spec?.fields.find(f => f.name === name);
    if (!field) {
      return { ok: false, draft: open, message: `${open.displayName} has no field called "${name}".` };
    }

    const cleaned = this.coerce(field, value);
    if (cleaned === null) {
      return {
        ok: false,
        draft: open,
        message: `"${value}" is not a valid ${field.label.toLowerCase()}.`,
        nextField: field,
      };
    }

    open.fields = { ...(open.fields ?? {}), [field.name]: cleaned };
    open.updatedAt = new Date();
    open.status = this.isComplete(open) ? 'READY' : 'COLLECTING';
    await this.drafts.save(open);

    return { ok: true, draft: open, message: `${field.label}: ${cleaned}`, nextField: this.missingField(open) };
  }

  /**
   * Applies a value to whichever field the person was last asked for.
   *
   * The conversational primitive: someone answers the question in front of them rather than
   * naming a field. Refuses when nothing is pending, so a stray message during the line-item
   * stage does not overwrite the customer's name.
   */
  async answerPrompt(phone: string, value: string): Promise<DraftOutcome> {
    const draft = await this.requireOpenDraft(phone);
    if ('message' in draft && !('id' in draft)) return draft;
    const open = draft as DocumentDraft;

    const pending = this.missingField(open);
    if (!pending) {
      const spec = findCreatableType(open.documentType);
      return {
        ok: false,
        draft: open,
        message: spec?.hasLineItems
          ? 'Nothing is waiting on an answer. Add a line like "250 cotton fabric at 600", or say submit.'
          : 'Nothing is waiting on an answer. Say review, or submit.',
      };
    }
    return this.setField(phone, pending.name, value);
  }

  async addLineItem(phone: string, item: DraftLineItem): Promise<DraftOutcome> {
    const draft = await this.requireOpenDraft(phone);
    if ('message' in draft && !('id' in draft)) return draft;
    const open = draft as DocumentDraft;

    const spec = findCreatableType(open.documentType);
    if (!spec?.hasLineItems) {
      return { ok: false, draft: open, message: `${open.displayName} does not take line items.` };
    }
    if (!item.description?.trim()) {
      return { ok: false, draft: open, message: 'A line needs a description.' };
    }

    const line: DraftLineItem = {
      description: item.description.trim().slice(0, 200),
      quantity: this.numeric(item.quantity) ?? '1',
      rate: this.numeric(item.rate) ?? '0',
    };
    open.lineItems = [...(open.lineItems ?? []), line];
    open.updatedAt = new Date();
    open.status = this.isComplete(open) ? 'READY' : 'COLLECTING';
    await this.drafts.save(open);

    return {
      ok: true,
      draft: open,
      message: `Added: ${line.description} — ${line.quantity} × ${line.rate}`,
      nextField: this.missingField(open),
    };
  }

  /**
   * Everything required is present.
   *
   * A document with line items needs at least one: an invoice with a customer, a date and
   * nothing on it is not a document anyone can approve.
   */
  isComplete(draft: DocumentDraft): boolean {
    const spec = findCreatableType(draft.documentType);
    if (!spec) return false;
    if (this.missingField(draft)) return false;
    if (spec.hasLineItems && !(draft.lineItems ?? []).length) return false;
    return true;
  }

  /** What has been collected, as a person would read it back. */
  review(draft: DocumentDraft): Record<string, unknown> {
    const spec = findCreatableType(draft.documentType);
    const values = draft.fields ?? {};
    const lines = draft.lineItems ?? [];
    const total = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.rate), 0);

    return {
      reference: draft.reference,
      document: draft.displayName,
      status: draft.status,
      details: (spec?.fields ?? []).filter(f => values[f.name]).map(f => ({ label: f.label, value: values[f.name] })),
      lineItems: lines.map(l => ({ ...l, amount: (Number(l.quantity) * Number(l.rate)).toFixed(2) })),
      total: spec?.hasLineItems ? total.toFixed(2) : (values.amount ?? null),
      missing:
        this.missingField(draft)?.label ?? (spec?.hasLineItems && !lines.length ? 'At least one line item' : null),
      readyToSubmit: this.isComplete(draft),
    };
  }

  /**
   * Sends the draft to the approval screen.
   *
   * Refuses an incomplete draft, refuses one already submitted, and marks the row SUBMITTED
   * only after the host confirms. A failure leaves it READY so it can be tried again — the
   * document has not reached anyone, so retrying costs nothing.
   */
  async submit(phone: string): Promise<DraftOutcome> {
    const draft = await this.requireOpenDraft(phone);
    if ('message' in draft && !('id' in draft)) return draft;
    const open = draft as DocumentDraft;

    if (!findCreatableType(open.documentType)?.submittable) {
      // A draft from before the host's answer was known. Saying so beats a bare HTTP 400.
      const available = CREATABLE_TYPES.filter(t => t.submittable)
        .map(t => t.displayName)
        .join(', ');
      return {
        ok: false,
        draft: open,
        message: `${open.displayName} cannot be submitted — Tijarah Books has not enabled it yet. You can create: ${available}.`,
      };
    }

    if (!this.isComplete(open)) {
      const review = this.review(open);
      return {
        ok: false,
        draft: open,
        message: `Not ready yet — ${String(review.missing)} is still needed.`,
        nextField: this.missingField(open),
      };
    }

    const result = await this.submission.submitForApproval(open);
    open.updatedAt = new Date();

    if (!result.ok) {
      // Left READY on purpose: nothing reached the approval screen, so this can be retried.
      open.errorMessage = result.message.slice(0, 480);
      await this.drafts.save(open);
      return { ok: false, draft: open, message: result.message };
    }

    open.status = 'SUBMITTED';
    open.submittedRef = result.approvalRef;
    open.submittedAt = new Date();
    open.errorMessage = null;
    await this.drafts.save(open);

    this.logger.log(`${open.reference} submitted for approval${result.approvalRef ? ` as ${result.approvalRef}` : ''}`);
    return { ok: true, draft: open, message: result.message };
  }

  async cancel(phone: string): Promise<DraftOutcome> {
    const draft = await this.requireOpenDraft(phone);
    if ('message' in draft && !('id' in draft)) return draft;
    const open = draft as DocumentDraft;

    open.status = 'CANCELLED';
    open.updatedAt = new Date();
    await this.drafts.save(open);
    return { ok: true, draft: open, message: `${open.displayName} ${open.reference} cancelled.` };
  }

  async list(limit = 25): Promise<DocumentDraft[]> {
    return this.drafts.find({
      where: { status: Not('CANCELLED') },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  private async requireOpenDraft(phone: string): Promise<DocumentDraft | DraftOutcome> {
    const open = await this.openDraftFor(phone);
    if (!open) {
      return { ok: false, message: 'There is no document in progress. Start one first.' };
    }
    return open;
  }

  /** Validates and normalises a value for its field kind, or null when it is not usable. */
  private coerce(field: DraftFieldSpec, raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;

    switch (field.kind) {
      case 'money':
      case 'number':
        return this.numeric(value);
      case 'date':
        return coerceDate(value);
      case 'phone':
        return normalizeWhatsAppNumber(value);
      /*
       * There is no choice field in the host's contract — a payment mode is expressed as the
       * `to` account, not an enum. The kind is kept in the type because a future field may
       * need it, and falling through to text is the honest behaviour meanwhile.
       */
      case 'choice':
        return value.slice(0, 300);
      default:
        return value.slice(0, 300);
    }
  }

  /** Digits with an optional decimal, commas stripped. Rejects anything else. */
  private numeric(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').replace(/[,\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
    return value;
  }
}

/**
 * A date as a person types it in a message.
 *
 * Three things it handles that `new Date()` alone does not:
 *
 *  - A restated label. Someone answering "Date?" writes "date is today", and a model relaying
 *    that answer passes the whole phrase through. Rejecting it teaches nobody anything.
 *  - "today" / "aaj", the two words actually used here.
 *  - **Day-first slash and dash forms.** `new Date('12/09/2026')` is 9 December by American
 *    convention; in Pakistan that is written for 12 September. Getting this wrong misdates an
 *    invoice by months and nothing downstream would question it, so these forms are parsed
 *    day-first explicitly rather than handed to the engine's default.
 */
export function coerceDate(raw: string): string | null {
  // "Date is 12/09/2026", "date: today", "dated 2026-09-12" — the label, restated.
  const value = String(raw ?? '')
    .trim()
    .replace(/^(?:the\s+)?(?:date|dated|on)\b\s*(?:is|was|=|:)?\s*/i, '')
    .trim();
  if (!value) return null;

  if (/^(today|aaj|aj)$/i.test(value)) return new Date().toISOString().slice(0, 10);
  if (/^(yesterday|kal)$/i.test(value)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  const dayFirst = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(value);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    // Rejects 31/02: the engine would roll it into March rather than say no.
    const parsed = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}
