/**
 * The calendar as the business reads it, not as the server's clock does.
 *
 * The server runs in UTC and every client is in Pakistan, five hours ahead. Reading the date
 * with UTC getters made "today" the PREVIOUS day from midnight to 5 a.m. Karachi time — a
 * draft dated yesterday, "this month" on the 1st meaning last month — and clients do write at
 * that hour. A Date whose UTC fields hold the Karachi wall-clock time lets every existing
 * UTC-getter calculation stay exactly as it is.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Karachi';

export function wallClock(at: Date = new Date(), timeZone: string = BUSINESS_TIME_ZONE): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map(part => [part.type, part.value]),
  );
  return new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ),
  );
}

/** Today's date in the business's own calendar, as YYYY-MM-DD. */
export function businessToday(at: Date = new Date()): string {
  return wallClock(at).toISOString().slice(0, 10);
}
