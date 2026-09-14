/**
 * The message a customer reads above their document.
 *
 * This is the business speaking to a customer about their own money, so it is written as a
 * short note rather than a system notification: who it is for, what is attached, its
 * reference, and a courteous close. No mention of a bot, a delivery system or anything else
 * internal — see customer-caption.spec.ts, which enforces that.
 *
 * WhatsApp renders `*bold*` and `_italic_` and nothing else, so the shape has to come from
 * line breaks and restraint. A financial document dressed up with decoration reads as less
 * trustworthy, not more.
 */

export interface CaptionFacts {
  displayName: string;
  documentNumber?: string | null;
  reference?: string | null;
  recipientName?: string | null;
  from?: string | null;
  to?: string | null;
  businessName?: string | null;
}

/** The company the document comes from. Configuration — never invented. */
export function businessName(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.WHATSAPP_BUSINESS_NAME?.trim();
  return name || null;
}

/**
 * `{placeholder}` substitution where a missing value removes its whole line.
 *
 * The alternative — leaving an empty string behind — produces "Dear ," and "Reference: " for
 * a contact with no name on file, which looks careless in exactly the message that most needs
 * not to. A line whose placeholders all resolve to nothing is dropped entirely.
 */
export function renderTemplate(template: string, facts: Record<string, string | null | undefined>): string {
  const lines = template.split('\n').map(line => {
    const placeholders = [...line.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    if (placeholders.length && placeholders.every(key => !facts[key]?.trim())) return null;
    return line.replace(/\{(\w+)\}/g, (_whole, key: string) => facts[key]?.trim() ?? '');
  });

  return (
    lines
      .filter((line): line is string => line !== null)
      .join('\n')
      // Collapse the gaps a dropped line leaves, so the note never has a hole in the middle.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 1024)
  );
}

/**
 * A reference a customer can read, from one shaped like an API path.
 *
 * The host identifies a document as `SL/1006/GR/2026/103` — a code, a company, a branch, a
 * year and a number. Printed verbatim in a WhatsApp message it reads as an internal URL, and
 * it tells the recipient about the shape of the supplier's systems rather than about their
 * invoice. `SL-103` says the same thing to the only person who matters.
 *
 * Anything carrying a scheme is dropped entirely: a link has no business in a caption.
 */
export function customerReference(reference?: string | null): string | null {
  const raw = reference?.trim();
  if (!raw) return null;
  if (/^[a-z]+:\/\//i.test(raw) || raw.includes('://')) return null;

  const segments = raw.split('/').filter(Boolean);
  if (segments.length < 2) return raw;
  // The document's own code and number; the company, branch and year are ours, not theirs.
  return `${segments[0]}-${segments[segments.length - 1]}`;
}

/** A period as a person writes it: "1 Jan 2026 to 31 Dec 2026". */
export function formatPeriod(from?: string | null, to?: string | null): string | null {
  const pretty = (value?: string | null): string | null => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const start = pretty(from);
  const end = pretty(to);
  if (start && end) return `${start} to ${end}`;
  return start ?? end ?? null;
}

/**
 * Defaults per document type.
 *
 * A sale invoice goes to a customer and thanks them; a purchase invoice goes to a supplier and
 * does not. A receipt confirms money arrived, which is the one line its reader wants. Getting
 * this wrong is not a formatting mistake — thanking a supplier for their business on a debit
 * note reads as a company that does not know who it is writing to.
 */
export const DEFAULT_CAPTIONS: Readonly<Record<string, string>> = {
  sale_invoice:
    '*{displayName} {documentNumber}*\n\n{greeting}\nYour invoice is attached.\n\n_Ref: {reference}_\n\nThank you for your business.\n{businessName}',
  digital_invoice:
    '*{displayName} {documentNumber}*\n\n{greeting}\nYour invoice is attached.\n\n_Ref: {reference}_\n\nThank you for your business.\n{businessName}',
  purchase_invoice:
    '*{displayName} {documentNumber}*\n\n{greeting}\nThe purchase invoice is attached for your records.\n\n_Ref: {reference}_\n\n{businessName}',
  sale_return:
    '*{displayName} {documentNumber}*\n\n{greeting}\nThe return note is attached for your records.\n\n_Ref: {reference}_\n\n{businessName}',
  purchase_return:
    '*{displayName} {documentNumber}*\n\n{greeting}\nThe return note is attached for your records.\n\n_Ref: {reference}_\n\n{businessName}',
  payment_voucher:
    '*{displayName} {documentNumber}*\n\n{greeting}\nThe payment voucher is attached for your records.\n\n_Ref: {reference}_\n\n{businessName}',
  receive_voucher:
    '*Receipt {documentNumber}*\n\n{greeting}\nThank you — your payment has been received. The receipt is attached.\n\n_Ref: {reference}_\n\n{businessName}',
  general_ledger:
    '*{displayName}*\n\n{greeting}\nYour account statement is attached.\n\n_Period: {period}_\n\n{businessName}',
  customer_ledger:
    '*{displayName}*\n\n{greeting}\nYour account statement is attached.\n\n_Period: {period}_\n\n{businessName}',
  vendor_ledger:
    '*{displayName}*\n\n{greeting}\nThe account statement is attached.\n\n_Period: {period}_\n\n{businessName}',
  expense_ledger:
    '*{displayName}*\n\n{greeting}\nThe expense statement is attached.\n\n_Period: {period}_\n\n{businessName}',

  /*
   * Phase Two reports. These go to the colleague who asked for them rather than to a customer,
   * so they are brief and factual rather than courteous. Without an entry here a report fell
   * through to the generic wording and arrived saying only "The document is attached", which
   * is true and useless.
   */
  trial_balance: '*{displayName}*\n\nTrial balance attached.\n\n_Period: {period}_\n\n{businessName}',
  item_ledger: '*{displayName}*\n\nItem ledger attached.\n\n_Period: {period}_\n\n{businessName}',
  stock_summary: '*{displayName}*\n\nStock summary attached.\n\n_Period: {period}_\n\n{businessName}',
  income_statement: '*{displayName}*\n\nIncome statement attached.\n\n_Period: {period}_\n\n{businessName}',
  balance_sheet: '*{displayName}*\n\nBalance sheet attached.\n\n_As at: {period}_\n\n{businessName}',
  cash_bank_book: '*{displayName}*\n\nCash and bank book attached.\n\n_Period: {period}_\n\n{businessName}',
  sales_book_report: '*{displayName}*\n\nSales book attached.\n\n_Period: {period}_\n\n{businessName}',
  sale_return_report: '*{displayName}*\n\nSale returns attached.\n\n_Period: {period}_\n\n{businessName}',
  purchase_book_report: '*{displayName}*\n\nPurchase book attached.\n\n_Period: {period}_\n\n{businessName}',
  purchase_return_report: '*{displayName}*\n\nPurchase returns attached.\n\n_Period: {period}_\n\n{businessName}',
};

/** The wording used when a type has no template of its own. */
export const FALLBACK_CAPTION =
  '*{displayName} {documentNumber}*\n\n{greeting}\nThe document is attached.\n\n_Ref: {reference}_\n\n{businessName}';

export function buildCaption(documentType: string, facts: CaptionFacts, template?: string | null): string {
  const chosen = template?.trim() || DEFAULT_CAPTIONS[documentType] || FALLBACK_CAPTION;
  const name = facts.recipientName?.trim();
  return renderTemplate(chosen, {
    displayName: facts.displayName,
    documentNumber: facts.documentNumber ?? null,
    reference: customerReference(facts.reference),
    recipientName: name ?? null,
    // "Dear ABC," when the contact has a name, and no greeting line at all when it does not —
    // a bare "Dear," is worse than opening with the sentence.
    greeting: name ? `Dear ${name},` : null,
    period: formatPeriod(facts.from, facts.to),
    businessName: facts.businessName ?? businessName(),
  });
}
