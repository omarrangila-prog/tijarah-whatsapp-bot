import type { CreateJobPayload, DocumentTypeOption } from '../services/api';

/** The company whose books a document is read from. Blank parts fall back to the type's defaults. */
export interface Tenant {
  sid: string;
  grp: string;
  aYear: string;
}

export interface SendFormValues {
  type: Pick<DocumentTypeOption, 'documentType' | 'displayName' | 'requiredParameters' | 'optionalParameters'>;
  documentNumber: string;
  from: string;
  to: string;
  partyCode: string;
  tenant: Tenant;
  number: string;
  recipientName: string;
  messageText: string;
}

/** Whether the type names one document (an invoice, a voucher) rather than a report over a period. */
export function needsDocumentNumber(type: Pick<DocumentTypeOption, 'requiredParameters'> | undefined): boolean {
  return (type?.requiredParameters ?? []).length > 0;
}

/** Enough to submit: a plausible number, and the document number when the type needs one. */
export function canSend(values: Pick<SendFormValues, 'type' | 'documentNumber' | 'number'>): boolean {
  const digits = values.number.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15 && (!needsDocumentNumber(values.type) || values.documentNumber.trim() !== '');
}

/**
 * The job the Send to WhatsApp form creates.
 *
 * Only what the operator filled in is sent: a blank company, caption or name is left to the
 * server, which has the type's default company and writes the standard caption itself.
 */
export function buildSendJob(values: SendFormValues, now: Date = new Date()): CreateJobPayload {
  const { type, tenant } = values;
  const documentNumber = values.documentNumber.trim();
  const partyCode = values.partyCode.trim();
  const optional = type.optionalParameters ?? [];
  const byNumber = needsDocumentNumber(type);

  const parameters: Record<string, unknown> = {};
  for (const key of type.requiredParameters ?? []) parameters[key] = documentNumber;
  if (tenant.sid.trim()) parameters.companyId = tenant.sid.trim();
  if (tenant.grp.trim()) parameters.branch = tenant.grp.trim();
  if (tenant.aYear.trim()) parameters.year = tenant.aYear.trim();
  if (!byNumber) {
    if (optional.includes('from') && values.from) parameters.from = values.from;
    if (optional.includes('to') && values.to) parameters.to = values.to;
    if (optional.includes('partyCode') && partyCode) parameters.partyCode = partyCode;
  }

  /*
   * A document's key is what makes the delivery unique — this document of this company, to this
   * number — so a double-click cannot send a customer their invoice twice. A report changes as
   * the books do, so its key is the minute: asking for it again later is wanted, not a duplicate.
   */
  const subject = byNumber
    ? documentNumber
    : `${partyCode || 'all'}-${values.from || 'all'}-${values.to || 'all'}-${now.toISOString().slice(0, 16)}`;
  const digits = values.number.replace(/\D/g, '');

  return {
    source: 'ui',
    documentType: type.documentType,
    documentReference: byNumber ? documentNumber : type.displayName,
    clientId: tenant.sid.trim() || undefined,
    partyId: (!byNumber && partyCode) || undefined,
    recipientName: values.recipientName.trim() || undefined,
    recipientWhatsAppNumber: values.number.trim(),
    messageText: values.messageText.trim() || undefined,
    parameters,
    idempotencyKey: `ui-${tenant.sid.trim() || 'default'}-${type.documentType}-${subject}-${digits}`,
  };
}
