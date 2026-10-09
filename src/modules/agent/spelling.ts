/**
 * The misspellings and Roman Urdu shorthands clients actually send, put right before the
 * rule-based reader looks for a document or a report.
 *
 * Without a language model the reader matches words, and one wrong letter cost the answer:
 * "legder bhejo", "sale invoce 179", "recivable list", "payment vochar 12" all got the help list,
 * and "purchse invoice 122" was read as SALE invoice 122 because the misspelled word was simply
 * not seen. This puts the accounting words back the way the reader knows them.
 *
 * Only accounting words are touched. A typed word is corrected when it is one or two letters
 * from exactly one of them (one for short words, two for long ones, a swapped pair counting as
 * one); a person's or a product's name is left as typed, because it is rarely that close to
 * "ledger" or "invoice" — and when it is, nothing is sent on it anyway: every ledger still asks
 * whose, and every name still has to match the chart.
 */

/** The words the reader recognises. Corrections only ever land on one of these. */
const ACCOUNTING_WORDS = [
  'ledger',
  'ledgers',
  'balance',
  'trial',
  'sheet',
  'statement',
  'statements',
  'summary',
  'stock',
  'invoice',
  'invoices',
  'purchase',
  'purchases',
  'receivable',
  'receivables',
  'payable',
  'payables',
  'voucher',
  'vouchers',
  'receive',
  'received',
  'payment',
  'payments',
  'expense',
  'expenses',
  'customer',
  'customers',
  'supplier',
  'suppliers',
  'vendor',
  'vendors',
  'report',
  'reports',
  'profit',
  'income',
  'return',
  'returns',
  'digital',
  'account',
  'accounts',
  'general',
  'quantity',
];
const KNOWN = new Set([...ACCOUNTING_WORDS, 'sale', 'sales', 'book', 'cash', 'bank', 'item', 'items', 'loss']);

/** Whole phrases people use for a report, in their words → the report's own name. */
const PHRASES: Array<[RegExp, string]> = [
  [/\btb\b/g, 'trial balance'],
  [/\bbok\b/g, 'book'],
  // A receipt voucher is Tijarah's receive voucher.
  [/\b(?:reciept|receipt|reciet|recipt|receving|receiving)\s+vouchers?\b/g, 'receive voucher'],
  [/\bp\s*n\s*l\b|\bpnl\b/g, 'profit and loss'],
  [/\bprofit\s*(?:and|&|n)?\s*los\b/g, 'profit and loss'],
  [/\b(?:nafa|nafaa|munafa)\s*(?:o|aur|and|&)?\s*(?:nuqsan|nuksan|nuqsaan|nuksaan)\b/g, 'profit and loss'],
  [/\b(?:kharcha|kharchay|kharche|kharchey|akhrajat|ikhrajat)\b/g, 'expense'],
  [/\b(?:vochar|vocher|vouchar|vouchr|vochr|wochar)\b/g, 'voucher'],
  // "bank book" is the cash & bank book — unless it already says "cash bank book".
  [/(?<!\bcash\s*(?:&|and)?\s*)\bbank\s*book\b/g, 'cash book'],
];

/** Words that make "sale" mean the sales BOOK for a period rather than one invoice. */
const PERIOD_HINT =
  /\b(?:aaj|aj|today|kal|yesterday|is\s+mahin[ae]|iss\s+mahin[ae]|this\s+month|last\s+month|pichl[ae]\s+mahin[ae]|week|hafte|hafta|month|mahina|mahine|year|saal|days|din)\b/;

export function correctSpelling(text: string): string {
  /*
   * Only the request is corrected, never a message. "send Ali: your statement is attached" is an
   * instruction followed by words for a customer, and those words go out exactly as written.
   */
  const raw = String(text ?? '');
  const colon = raw.indexOf(':');
  if (colon >= 0) return correctRequest(raw.slice(0, colon)) + raw.slice(colon);
  return correctRequest(raw);
}

function correctRequest(text: string): string {
  let out = text;

  // Single words first, so the phrase rules below see "profit", "voucher" and the like.
  out = out.replace(/[A-Za-z]{4,}/g, word => {
    const fixed = closestAccountingWord(word.toLowerCase());
    return fixed ?? word;
  });
  let lower = out.toLowerCase();

  for (const [pattern, replacement] of PHRASES) {
    if (pattern.test(lower)) {
      out = lower.replace(pattern, replacement);
      lower = out;
    }
    pattern.lastIndex = 0;
  }

  // "Payables" and "statement" are named ledgers, in the words the reader already knows.
  if (/\bpayables?\b/.test(lower) && !/\b(?:invoice|voucher|ledger)\b/.test(lower)) {
    out = lower.replace(/\bpayables?(?:\s+(?:report|list))?\b/, 'vendor ledger');
    lower = out;
  }
  if (/\bexpenses?\b/.test(lower) && !/\b(?:ledger|voucher|invoice)\b/.test(lower)) {
    out = lower.replace(/\bexpenses?(?:\s+(?:report|list|details?))?\b/, 'expense ledger');
    lower = out;
  }
  if (/\bstatements?\b/.test(lower) && !/\bincome\s+statement/.test(lower)) {
    out = lower.replace(/\b(?:customer\s+|account\s+)?statements?(?:\s+of\s+account)?\b/, 'customer ledger');
    lower = out;
  }

  // "aaj ki sale", "is mahine ki sale": a period's sales, which is the sales book. A number means
  // an invoice instead ("sale 179"), and an explicit document word is left to the reader.
  if (PERIOD_HINT.test(lower) && !/\d{2,}/.test(lower) && !/\b(?:invoice|return|book|report|ledger)\b/.test(lower)) {
    if (/\bsales?\b/.test(lower)) out = lower.replace(/\bsales?\b/, 'sales book');
    else if (/\bpurchases?\b/.test(lower)) out = lower.replace(/\bpurchases?\b/, 'purchase book');
  }
  return out;
}

/** The accounting word a typed word was meant to be, or null when it is not near exactly one. */
function closestAccountingWord(word: string): string | null {
  if (KNOWN.has(word)) return null;
  const allowed = word.length >= 7 ? 2 : 1;
  let best: string | null = null;
  let bestDistance = Infinity;
  let tied = false;
  for (const candidate of ACCOUNTING_WORDS) {
    // Same first letter: misspellings keep it, and requiring it keeps names from being "corrected".
    if (candidate[0] !== word[0]) continue;
    // A four-letter word may only grow into a five-letter one sharing its first two letters ("stok").
    if (word.length === 4 && (candidate.length !== 5 || candidate.slice(0, 2) !== word.slice(0, 2))) continue;
    const distance = damerauLevenshtein(word, candidate, allowed);
    if (distance > allowed) continue;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && best && stem(best) !== stem(candidate)) {
      tied = true;
    } else if (
      distance === bestDistance &&
      best &&
      Math.abs(candidate.length - word.length) < Math.abs(best.length - word.length)
    ) {
      best = candidate;
    }
  }
  return best && !tied ? best : null;
}

function stem(word: string): string {
  return word.replace(/s$/, '');
}

/** Edit distance where swapping two neighbouring letters ("legder") costs one, not two. */
export function damerauLevenshtein(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    let rowBest = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
      rowBest = Math.min(rowBest, d[i][j]);
    }
    if (rowBest > limit) return limit + 1;
  }
  return d[rows - 1][cols - 1];
}
