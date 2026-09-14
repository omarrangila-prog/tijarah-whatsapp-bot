/**
 * Formatting helpers for the command center.
 *
 * Pure and dependency-free so they can be unit-tested directly and reused by any surface. Every one
 * of them distinguishes "no data" from "zero": a conversation that has never been answered shows a
 * dash, not "0m", because those mean opposite things to someone reading a dashboard.
 */

/** Short relative time for a conversation list: `now`, `4m`, `3h`, `2d`, then a date. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  // A clock skew between server and browser can put a fresh message a few seconds in the future;
  // showing "in 3 seconds" for a message that just arrived would be worse than showing "now".
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Absolute timestamp for detail panels and tooltips. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Date only, for a "member since" style field. */
export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A duration in minutes, rendered at the largest sensible unit.
 *
 * Returns null — not "0m" — when there is no measurement, so the caller can render a dash and say
 * why. Sub-minute durations round up to "1m" rather than down to "0m", which would read as instant.
 */
export function formatMinutes(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) {
    const whole = Math.floor(hours);
    const rest = Math.round(minutes - whole * 60);
    return rest ? `${whole}h ${rest}m` : `${whole}h`;
  }
  const days = hours / 24;
  const wholeDays = Math.floor(days);
  const restHours = Math.round(hours - wholeDays * 24);
  return restHours ? `${wholeDays}d ${restHours}h` : `${wholeDays}d`;
}

/** Thousands-separated integer. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString();
}

/**
 * A WhatsApp id rendered for a human: `+92 300 1234567` for a phone, the raw id otherwise.
 *
 * Grouping is deliberately loose — a strict per-country format would be wrong for most of the
 * world, and a wrongly-grouped number is harder to read than an evenly-grouped one.
 */
export function formatWaId(waId: string | null | undefined): string {
  if (!waId) return '';
  const at = waId.indexOf('@');
  const user = at === -1 ? waId : waId.slice(0, at);
  const domain = at === -1 ? '' : waId.slice(at + 1);
  if (domain === 'g.us') return 'Group chat';
  // A LID hides the phone number, so there is no number to show. Append the last four digits of the
  // identifier so several privacy contacts in one list are still tellable apart — without them the
  // inbox shows three identical rows and an operator cannot say which is which.
  if (domain === 'lid') return `Private identity · ${user.slice(-4)}`;
  if (!/^\d{6,15}$/.test(user)) return waId;
  const groups = user.length > 10 ? [user.slice(0, 2), user.slice(2, 5), user.slice(5)] : [user];
  return `+${groups.join(' ')}`;
}

/** Human label for a chat kind. */
export function chatKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'group':
      return 'Group';
    case 'channel':
      return 'Channel';
    case 'broadcast':
      return 'Broadcast list';
    case 'status':
      return 'Status';
    default:
      return 'Direct';
  }
}

/** `14:00` for an hour-of-day bucket. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * Shorten a bucket label for a chart axis: `2026-01-07` → `7 Jan`, `2026-01-07 14:00` → `14:00`.
 * Anything unrecognised is returned unchanged rather than mangled.
 */
export function formatBucketLabel(bucket: string): string {
  const hourly = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00$/.exec(bucket);
  if (hourly) return `${hourly[4]}:00`;
  const daily = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket);
  if (daily) {
    const date = new Date(Number(daily[1]), Number(daily[2]) - 1, Number(daily[3]));
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return bucket;
}

/**
 * The `/shortcut` prefix currently being typed at the caret, or null.
 *
 * Only fires when the slash starts a word (beginning of input or after whitespace), so a URL or a
 * date like `12/05` never opens the picker mid-typing.
 */
export function quickReplyQueryAt(text: string, caret: number): string | null {
  const upToCaret = text.slice(0, caret);
  const slash = upToCaret.lastIndexOf('/');
  if (slash === -1) return null;
  if (slash > 0 && !/\s/.test(upToCaret[slash - 1])) return null;
  const query = upToCaret.slice(slash + 1);
  // A space ends the shortcut: once the agent has typed past it they are writing a message.
  if (/\s/.test(query)) return null;
  return query;
}

/** Replace the `/shortcut` token at the caret with the resolved reply text. */
export function replaceQuickReplyToken(text: string, caret: number, replacement: string): { text: string; caret: number } {
  const upToCaret = text.slice(0, caret);
  const slash = upToCaret.lastIndexOf('/');
  if (slash === -1) return { text, caret };
  const next = text.slice(0, slash) + replacement + text.slice(caret);
  return { text: next, caret: slash + replacement.length };
}
