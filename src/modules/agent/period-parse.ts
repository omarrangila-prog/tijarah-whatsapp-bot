/**
 * The periods people actually type, turned into the dates a report is fetched with.
 *
 * Every shape here is one a real client sent on 7 October and did not get: "January ledger de",
 * "send me ledger from 1 july to 1 oct", "2026 ledger", "30 days ledger". The parser accepted
 * only `2026-07-01`, so each of those silently became the whole book — the person asked for a
 * month and received everything, with nothing in the reply to say the period was dropped.
 *
 * Pure, and injected with `now`, so "this month" is testable and does not drift with the clock.
 */

export interface Period {
  from: string;
  to: string;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const day = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m, d));
/** Day 0 of the next month is the last day of this one, so month length is never hardcoded. */
const endOfMonth = (y: number, m: number): Date => day(y, m + 1, 0);

const MONTH_WORDS = Object.keys(MONTHS).join('|');

/**
 * The period a message asks for, or null when it names none.
 *
 * Null means "no period", which the caller must treat as the host's own default — never as a
 * reason to invent one. The order below is most specific first: an explicit range beats a
 * single month, which beats a relative phrase, so "1 July to 30 September" is not read as
 * "July".
 */
export function parsePeriod(text: string, now: Date = new Date()): Period | null {
  const lower = text.toLowerCase();
  const year = now.getUTCFullYear();

  // 1. Two ISO dates: "2026-07-01 to 2026-09-30".
  const isoDates = lower.match(/\d{4}-\d{2}-\d{2}/g);
  if (isoDates && isoDates.length >= 2) return { from: isoDates[0], to: isoDates[1] };

  /*
   * 1b. Day-first dates: "01-01-2026 to 31-03-2026", also written with / or .
   *
   * Day-first because that is how Pakistan writes a date; 01-03-2026 is 1 March, never
   * 3 January. Guessing the other way would quietly return the wrong quarter.
   */
  const dmy = [...lower.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g)];
  if (dmy.length >= 2) {
    const at = (m: RegExpMatchArray): string => iso(day(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return { from: at(dmy[0]), to: at(dmy[1]) };
  }

  /*
   * 1c. "up to date" / "aaj tak" — the year so far — and "today" on its own.
   *
   * Up-to-date is tested FIRST because "aaj tak" contains "aaj": matching "today" first turned
   * a request for the year so far into a single day's ledger.
   */
  if (/\b(up\s*to\s*date|till\s*date|to\s*date|aaj\s*tak|ab\s*tak)\b/i.test(lower)) {
    return { from: iso(day(year, 0, 1)), to: iso(now) };
  }
  if (/\b(today|aaj)\b/i.test(lower)) return { from: iso(now), to: iso(now) };

  // 2. "from 1 july to 1 oct", "1 jan - 31 mar 2026" — day and month either side.
  const dayMonth = new RegExp(
    `(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+(${MONTH_WORDS})\\b[^0-9]{0,14}?(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+(${MONTH_WORDS})\\b\\s*(\\d{4})?`,
    'i',
  ).exec(lower);
  if (dayMonth) {
    const y = dayMonth[5] ? Number(dayMonth[5]) : year;
    const fromMonth = MONTHS[dayMonth[2]];
    const toMonth = MONTHS[dayMonth[4]];
    return {
      from: iso(day(y, fromMonth, Number(dayMonth[1]))),
      // A range that runs backwards crosses a year end: "1 Nov to 31 Jan" ends the next year.
      to: iso(day(toMonth < fromMonth ? y + 1 : y, toMonth, Number(dayMonth[3]))),
    };
  }

  // 3. "july to september", "jan-mar 2026" — months with no days.
  const monthRange = new RegExp(
    `\\b(${MONTH_WORDS})\\b[\\s-]{0,3}(?:to|till|until|se|tak|-|–)?[\\s-]{0,3}\\b(${MONTH_WORDS})\\b\\s*(\\d{4})?`,
    'i',
  ).exec(lower);
  if (monthRange && monthRange[1] !== monthRange[2]) {
    const y = monthRange[3] ? Number(monthRange[3]) : year;
    const fromMonth = MONTHS[monthRange[1]];
    const toMonth = MONTHS[monthRange[2]];
    const endYear = toMonth < fromMonth ? y + 1 : y;
    return { from: iso(day(y, fromMonth, 1)), to: iso(endOfMonth(endYear, toMonth)) };
  }

  // 4. "last N days" / "30 days".
  const days = /\b(?:last\s+)?(\d{1,3})\s*days?\b/i.exec(lower);
  if (days) {
    const n = Number(days[1]);
    if (n >= 1 && n <= 366) {
      return { from: iso(new Date(now.getTime() - n * 86_400_000)), to: iso(now) };
    }
  }

  // 5. Relative phrases, English and the Roman Urdu these clients write.
  if (/\b(this|current)\s+month\b|\bis\s+month\b|\bmahine\b/i.test(lower)) {
    return { from: iso(day(year, now.getUTCMonth(), 1)), to: iso(now) };
  }
  if (/\b(last|previous|pichle)\s+month\b/i.test(lower)) {
    const m = now.getUTCMonth() - 1;
    const y = m < 0 ? year - 1 : year;
    const month = (m + 12) % 12;
    return { from: iso(day(y, month, 1)), to: iso(endOfMonth(y, month)) };
  }
  if (/\b(this|current)\s+year\b|\bis\s+saal\b|\bsaal\s+ka\b/i.test(lower)) {
    return { from: iso(day(year, 0, 1)), to: iso(now) };
  }
  if (/\b(last|previous|pichle)\s+year\b/i.test(lower)) {
    return { from: iso(day(year - 1, 0, 1)), to: iso(day(year - 1, 11, 31)) };
  }

  // 6. A single month: "January ledger", "ledger for march".
  const single = new RegExp(`\\b(${MONTH_WORDS})\\b\\s*(\\d{4})?`, 'i').exec(lower);
  if (single) {
    const m = MONTHS[single[1]];
    const y = single[2] ? Number(single[2]) : year;
    return { from: iso(day(y, m, 1)), to: iso(endOfMonth(y, m)) };
  }

  // 7. A bare year: "2026 ledger".
  const bareYear = /\b(20\d{2})\b/.exec(lower);
  if (bareYear) {
    const y = Number(bareYear[1]);
    return { from: iso(day(y, 0, 1)), to: y === year ? iso(now) : iso(day(y, 11, 31)) };
  }

  return null;
}

/**
 * A party's account code, as Tijarah actually writes them.
 *
 * The host's codes are bare digits — `0107170`, `0104014` — not the `C-1005` shape the
 * examples used. A client sent "send me 30 days customer ledger for this 0107170" and the
 * code was dropped, so they received every account instead of the one they named.
 *
 * A bare number is only read as a code when the message points at it ("for this 0107170"),
 * because a loose digit rule would read the 179 in "invoice 179" as an account.
 */
export function parsePartyCode(text: string): string | null {
  const prefixed =
    /\b(?:for|of|party|code|account|lcode)\s+(?:this\s+)?([A-Z]{1,4}-\d{2,})\b/i.exec(text) ??
    /\b([A-Z]{1,4}-\d{3,})\b/i.exec(text);
  if (prefixed) return prefixed[1].toUpperCase();

  const bare = /\b(?:for|of|party|code|account|lcode)\s*=?\s*(?:this\s+)?(\d{6,10})\b/i.exec(text);
  return bare ? bare[1] : null;
}
