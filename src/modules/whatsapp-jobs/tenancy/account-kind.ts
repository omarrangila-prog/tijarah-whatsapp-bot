/**
 * What an account code says about the kind of account it is.
 *
 * Tijarah's chart encodes the type in the first four digits — `0107…` is a customer, `0105…`
 * a vendor — and that is the only reliable signal available, because `GetBotCustomers`
 * filters on `ActHead=RECEIVABLE` and `BANK`/`CASH` and ignores every other value, returning
 * the whole chart. Measured against the live chart for company 1006 on 7 October 2026:
 * RECEIVABLE returns exactly the `0104`/`0107` codes, BANK and CASH exactly the `0101` ones,
 * and PAYABLE/EXPENSE return all 225 unfiltered.
 *
 * This matters because a name has to reach the RIGHT ledger: asking for a vendor by name and
 * being handed the customer ledger is the same class of mistake as being handed the whole
 * book. Where the prefix is not known, the kind is `unknown` and the caller asks rather than
 * assuming.
 */

export type AccountKind = 'customer' | 'vendor' | 'bank' | 'expense' | 'unknown';

/**
 * Prefix → kind, from the live chart.
 *
 * `0104` appears under RECEIVABLE *and* in the wider chart, so it is left as a customer: it
 * is what the host itself returns when asked for receivables.
 */
const PREFIXES: Readonly<Record<string, AccountKind>> = {
  '0101': 'bank',
  '0104': 'customer',
  '0105': 'vendor',
  '0107': 'customer',
};

/** The kind of account a code belongs to, or `unknown` when its prefix is not mapped. */
export function accountKind(lcode: string | null | undefined): AccountKind {
  if (!lcode) return 'unknown';
  const digits = lcode.replace(/\D/g, '');
  if (digits.length < 4) return 'unknown';
  return PREFIXES[digits.slice(0, 4)] ?? 'unknown';
}

/**
 * The ledger that answers "send me X's ledger" for an account of this kind.
 *
 * A customer's statement is the customer ledger, a vendor's the vendor ledger. Anything else
 * falls to the general ledger, which is the one report that can show any account — the
 * honest answer for a bank or an expense head, rather than forcing it into a ledger built
 * for trading parties.
 */
export function ledgerForKind(kind: AccountKind): string {
  switch (kind) {
    case 'customer':
      return 'customer_ledger';
    case 'vendor':
      return 'vendor_ledger';
    case 'expense':
      return 'expense_ledger';
    default:
      return 'general_ledger';
  }
}

/**
 * The `ActHead` to ask the host for when looking a name up for a given ledger.
 *
 * Only RECEIVABLE and BANK/CASH actually narrow anything; everything else is the full chart,
 * which is why the prefix above does the real work. Asking with the right head still helps:
 * it is a smaller list to match a name against, and fewer rows is fewer ways to be ambiguous.
 */
export function actHeadForLedger(documentType: string): string {
  if (documentType === 'customer_ledger') return 'RECEIVABLE';
  if (documentType === 'cash_bank_book') return 'BANK';
  return 'ALL';
}
