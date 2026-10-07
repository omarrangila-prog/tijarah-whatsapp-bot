/**
 * A numbered menu for clients, so nothing depends on guessing what a person meant.
 *
 * The live log is the argument for it: "trial balance send" delivered a PDF, "Send me trail
 * balance" — one letter different — got the help list, and "send me list of receivables" got
 * nothing at all. Free text only works when a language model is answering, and when the key
 * is missing or its credit runs out the bot silently degrades to fixed phrasings. A menu is
 * the one route that works identically either way, and it is faster for a regular user:
 * "2" beats typing a report name.
 *
 * Deliberately a pure state machine over the text of the conversation. It holds no session:
 * each step re-reads the menu it just sent, so a restart mid-menu cannot strand anyone, and
 * every branch is directly testable.
 */

/** A report a client can ask for, as the registry describes it. */
export interface MenuReport {
  documentType: string;
  displayName: string;
  /** Whether this report accepts a from/to period. */
  datedByDefault: boolean;
}

/** What the caller should do once a reply has been read. */
export type MenuAction =
  | { kind: 'show'; text: string }
  | { kind: 'report'; documentType: string; from: string | null; to: string | null }
  | { kind: 'document'; prompt: string }
  | { kind: 'none' };

/** The step a conversation is on, worked out from the last menu the bot sent. */
export type MenuStep =
  | { kind: 'root' }
  | { kind: 'reports' }
  | { kind: 'period'; documentType: string }
  | { kind: 'dates'; documentType: string };

export const MENU_TRIGGER = /^\s*(menu|start|hi|hello|help|salam|assalam|aoa|option|options|list)\b/i;

/** Marks a message as one of this menu's, so the next reply can be read in context. */
const TAGS: Record<string, string> = {
  root: '​​1',
  reports: '​​2',
  period: '​​3',
  dates: '​​4',
};

const ROOT_OPTIONS = [
  { label: 'Receivables — who owes me', documentType: 'customer_ledger' },
  { label: 'A report (trial balance, balance sheet…)', documentType: null },
  { label: 'An invoice or voucher by number', documentType: null },
] as const;

/**
 * The root menu, sent when a client says hello or anything unrecognised.
 *
 * Numbered rather than keyword-driven because a reply of "2" cannot be misspelled, and
 * because it tells a new client what the bot can do without them having to know first.
 */
export function rootMenu(businessName = 'Tijarah Books'): string {
  const lines = ROOT_OPTIONS.map((o, i) => `${i + 1}. ${o.label}`);
  return (
    `What would you like from ${businessName}?\n\n${lines.join('\n')}\n\n` +
    `Reply with a number. You can also just ask, e.g. "trial balance for July to September".${TAGS.root}`
  );
}

/** The report list, numbered. Capped so one WhatsApp message stays readable. */
export function reportMenu(reports: MenuReport[]): string {
  const lines = reports.slice(0, 20).map((r, i) => `${i + 1}. ${r.displayName}`);
  return `Which report?\n\n${lines.join('\n')}\n\nReply with a number, or 0 to go back.${TAGS.reports}`;
}

/** Asked after a dated report is chosen, so a period is never silently "everything". */
export function periodMenu(displayName: string): string {
  return (
    `${displayName} — for which period?\n\n` +
    `1. This month\n2. Last month\n3. This year\n4. Everything\n5. Specific dates\n\n` +
    `Reply with a number.${TAGS.period}`
  );
}

export function datesPrompt(displayName: string): string {
  return `${displayName} — send the dates as:\n\n*2026-07-01 to 2026-09-30*${TAGS.dates}`;
}

/** Which step a conversation is on, from the last thing the bot said. */
export function stepFor(lastBotMessage: string | null): MenuStep | null {
  if (!lastBotMessage) return null;
  if (lastBotMessage.includes(TAGS.dates)) return { kind: 'dates', documentType: documentTypeIn(lastBotMessage) };
  if (lastBotMessage.includes(TAGS.period)) return { kind: 'period', documentType: documentTypeIn(lastBotMessage) };
  if (lastBotMessage.includes(TAGS.reports)) return { kind: 'reports' };
  if (lastBotMessage.includes(TAGS.root)) return { kind: 'root' };
  return null;
}

/**
 * The report a period question was about.
 *
 * Carried in the message's own text rather than in stored state: the question names the
 * report to the person reading it, so re-reading it is both the simplest way to remember and
 * the one that cannot disagree with what they saw.
 */
function documentTypeIn(message: string): string {
  const match = /^([A-Za-z &'’-]+?)\s+—/.exec(message.trim());
  return match ? match[1].trim() : '';
}

/** A whole number a person typed, or null. Tolerates "2." and "option 2". */
export function readChoice(text: string): number | null {
  const match = /^\s*(?:option\s*)?(\d{1,2})\s*[.)]?\s*$/i.exec(text);
  if (!match) return null;
  return Number(match[1]);
}

/** A period a person typed as "2026-07-01 to 2026-09-30". */
export function readDates(text: string): { from: string; to: string } | null {
  const match = /(\d{4}-\d{2}-\d{2})\s*(?:to|-|until|till|–)\s*(\d{4}-\d{2}-\d{2})/i.exec(text);
  if (!match) return null;
  return { from: match[1], to: match[2] };
}

/** The named periods behind options 1–4, resolved against a clock that can be injected. */
export function periodFor(choice: number, now: Date): { from: string | null; to: string | null } | null {
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  switch (choice) {
    case 1:
      return { from: iso(new Date(Date.UTC(year, month, 1))), to: iso(now) };
    case 2:
      return {
        from: iso(new Date(Date.UTC(year, month - 1, 1))),
        // Day 0 of this month is the last day of the previous one.
        to: iso(new Date(Date.UTC(year, month, 0))),
      };
    case 3:
      return { from: iso(new Date(Date.UTC(year, 0, 1))), to: iso(now) };
    case 4:
      return { from: null, to: null };
    default:
      return null;
  }
}

/**
 * Read a client's reply in the context of the menu they are answering.
 *
 * Returns what to do, never a side effect. A reply that is not a number at the root is
 * `none`, which is the caller's signal to fall through to the ordinary reasoning — the menu
 * must never swallow "send me invoice 179" just because a menu happens to be open.
 */
export function advance(
  step: MenuStep | null,
  reply: string,
  reports: MenuReport[],
  now: Date = new Date(),
): MenuAction {
  const choice = readChoice(reply);

  if (!step || step.kind === 'root') {
    if (choice === null) return { kind: 'none' };
    const option = ROOT_OPTIONS[choice - 1];
    if (!option) return { kind: 'show', text: rootMenu() };
    if (option.documentType) {
      const report = reports.find(r => r.documentType === option.documentType);
      return report
        ? { kind: 'show', text: periodMenu(report.displayName) }
        : { kind: 'show', text: reportMenu(reports) };
    }
    if (choice === 2) return { kind: 'show', text: reportMenu(reports) };
    return {
      kind: 'document',
      prompt: 'Which document? Send its type and number, e.g. *sale invoice 179*.',
    };
  }

  if (step.kind === 'reports') {
    if (choice === 0) return { kind: 'show', text: rootMenu() };
    if (choice === null) return { kind: 'none' };
    const report = reports[choice - 1];
    if (!report) return { kind: 'show', text: reportMenu(reports) };
    return report.datedByDefault
      ? { kind: 'show', text: periodMenu(report.displayName) }
      : { kind: 'report', documentType: report.documentType, from: null, to: null };
  }

  if (step.kind === 'period') {
    const report = reports.find(r => r.displayName === step.documentType);
    if (!report) return { kind: 'show', text: reportMenu(reports) };
    if (choice === 5) return { kind: 'show', text: datesPrompt(report.displayName) };
    const period = choice === null ? null : periodFor(choice, now);
    if (!period) {
      // A date range typed instead of choosing is an answer, not a mistake.
      const typed = readDates(reply);
      if (typed) return { kind: 'report', documentType: report.documentType, ...typed };
      return { kind: 'show', text: periodMenu(report.displayName) };
    }
    return { kind: 'report', documentType: report.documentType, from: period.from, to: period.to };
  }

  // step.kind === 'dates'
  const report = reports.find(r => r.displayName === step.documentType);
  if (!report) return { kind: 'show', text: reportMenu(reports) };
  const typed = readDates(reply);
  if (!typed) return { kind: 'show', text: datesPrompt(report.displayName) };
  return { kind: 'report', documentType: report.documentType, ...typed };
}
