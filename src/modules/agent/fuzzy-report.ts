/**
 * Matching a report name that was typed slightly wrong.
 *
 * "Send me trail balance" was sent by two different clients on the first day and answered
 * with the help list both times, because the keyword table requires "trial" exactly. A person
 * who misspells a word still said clearly what they wanted, and answering a near-miss with a
 * menu reads as the bot not listening.
 *
 * Only near-misses are corrected, and only when a single report is close: the cost of a wrong
 * guess here is a real PDF of the wrong report, which is worse than asking.
 */

/** Keyboard-distance-free edit distance, capped: beyond `max` the exact value does not matter. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    // Every path through this row is already too long; nothing below can come back under the cap.
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/** How much slack a word of this length gets: one typo in a short word, two in a long one. */
function tolerance(word: string): number {
  if (word.length <= 4) return 0;
  return word.length <= 7 ? 1 : 2;
}

/**
 * Whether two words differ only by one adjacent swap: "trail" for "trial".
 *
 * Transposition is the typo people actually make, and plain edit distance scores it 2 — over
 * the tolerance a five-letter word gets, which is why "Send me trail balance" went
 * unanswered twice on the first live day. Checked separately so the tolerance for genuinely
 * different words can stay tight.
 */
function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff.push(i);
    if (diff.length > 2) return false;
  }
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

/**
 * The report a misspelling meant, or null.
 *
 * Each report is described by the words that identify it — "trial balance" by both words —
 * and a message matches when every one of those words appears, exactly or within tolerance.
 * Two reports matching is null rather than a choice.
 */
export function fuzzyReport(text: string, reports: ReadonlyArray<readonly [string, readonly string[]]>): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;

  const hits = reports.filter(([, needed]) =>
    needed.every(need =>
      words.some(
        word =>
          word === need || isTransposition(word, need) || editDistance(word, need, tolerance(need)) <= tolerance(need),
      ),
    ),
  );
  return hits.length === 1 ? hits[0][0] : null;
}

/**
 * The identifying words of each report, longest-named first.
 *
 * A report is listed by the words a person would type, not its display name: nobody writes
 * "Cash & Bank Book", they write "cash book". Specific ledgers come before the general one
 * for the same reason the exact table does — "customer ledger" must not become the general
 * ledger because both contain "ledger".
 */
export const REPORT_WORD_SETS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['customer_ledger', ['customer', 'ledger']],
  ['vendor_ledger', ['vendor', 'ledger']],
  ['expense_ledger', ['expense', 'ledger']],
  ['item_ledger', ['item', 'ledger']],
  ['general_ledger', ['general', 'ledger']],
  ['trial_balance', ['trial', 'balance']],
  ['balance_sheet', ['balance', 'sheet']],
  ['income_statement', ['income', 'statement']],
  ['stock_summary', ['stock']],
  ['cash_bank_book', ['cash', 'book']],
  ['sales_book_report', ['sales', 'book']],
  ['purchase_book_report', ['purchase', 'book']],
  // The returns need "report": "sale return 3" is return document 3, and the exact table
  // above routes it by number. Matching on "sale return" alone sent somebody the period
  // summary when they had named a specific document.
  ['sale_return_report', ['sale', 'return', 'report']],
  ['purchase_return_report', ['purchase', 'return', 'report']],
];
