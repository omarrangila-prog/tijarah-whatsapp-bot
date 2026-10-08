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

import { parsePeriod } from './period-parse';

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

/**
 * A greeting or a bare "send", which opens the menu.
 *
 * Anchored at both ends, so only the word ON ITS OWN counts. With a trailing `\b` instead,
 * "Send me trail balance" began with "send" and was answered with the menu rather than the
 * report — the menu swallowing a real request, which is exactly what it must never do. A
 * short trailing politeness ("send please", "hello bhai") is still just a greeting.
 */
export const MENU_TRIGGER =
  /^\s*(send|bhejo?|menu|start|hi|hello|help|salam|assalam|aoa|option|options|list)[\s!.,]*(please|plz|bhai|yaar|ji)?[\s!.,]*$/i;

/** Marks a message as one of this menu's, so the next reply can be read in context. */
const TAGS: Record<string, string> = {
  root: '​​1',
  reports: '​​2',
  period: '​​3',
  dates: '​​4',
};

const ROOT_OPTIONS = [
  { label: 'Who owes me money', documentType: 'customer_ledger' },
  { label: 'Send me a report', documentType: null },
  { label: 'About an invoice', documentType: null },
] as const;

/**
 * The reports put at the top of the list, in this order.
 *
 * WhatsApp has no clickable buttons on a QR-paired number — they are Business-API only — so
 * the next best thing is a list short enough to take in at a glance. Fourteen alphabetical
 * entries made a person read to the bottom to find the trial balance; these are the ones the
 * live transcript shows clients actually asking for, so they come first and the rest follow.
 */
const COMMON_FIRST = [
  'trial_balance',
  'customer_ledger',
  'general_ledger',
  'balance_sheet',
  'income_statement',
  'stock_summary',
];

/** The reports in the order they are offered: the common ones first, then the rest. */
export function orderReports(reports: MenuReport[]): MenuReport[] {
  const rank = (r: MenuReport): number => {
    const i = COMMON_FIRST.indexOf(r.documentType);
    return i === -1 ? COMMON_FIRST.length : i;
  };
  return [...reports].sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

/**
 * The root menu, sent when a client says hello or anything unrecognised.
 *
 * Numbered rather than keyword-driven because a reply of "2" cannot be misspelled, and
 * because it tells a new client what the bot can do without them having to know first.
 */
export function rootMenu(businessName = 'Tijarah Books'): string {
  const lines = ROOT_OPTIONS.map((o, i) => `${i + 1}.  ${o.label}`);
  return (
    `Hello! This is *${businessName}*.\n\nWhat do you need?\n\n${lines.join('\n')}\n\n` +
    `Just send 1, 2 or 3.\nOr type what you want, like _trial balance_.${TAGS.root}`
  );
}

/** The report list: a number per report, and the name itself also works. */
export function reportMenu(reports: MenuReport[]): string {
  const lines = orderReports(reports)
    .slice(0, 20)
    .map((r, i) => `${i + 1}.  ${r.displayName}`);
  return (
    `Which report do you need?\n\n${lines.join('\n')}\n\n` +
    `Send the number, or the name.\nSend 0 to go back.${TAGS.reports}`
  );
}

/** Asked after a dated report is chosen, so a period is never silently "everything". */
/**
 * The durations the specification asks for, in its order.
 *
 * Seven named spans and a custom range. Option 1 is the host's own default, so choosing it
 * and saying nothing give the same report — which is what makes "just send it" safe.
 */
export const PERIOD_OPTIONS = [
  'Last 7 days',
  'Last 10 days',
  'Last 15 days',
  'Last 30 days',
  'This month',
  'This year',
  'Up to today',
  'Custom dates',
] as const;

export function periodMenu(displayName: string): string {
  const lines = PERIOD_OPTIONS.map((label, i) => `${i + 1}.  ${label}`);
  return (
    `*${displayName}* — for which dates?\n\n${lines.join('\n')}\n\n` +
    `Send the number.\nOr type the dates, like _July to September_.\nSend 0 to go back.${TAGS.period}`
  );
}

export function datesPrompt(displayName: string): string {
  // The "name — ..." shape is load-bearing: stepFor reads the report back out of this text.
  return `${displayName} — which dates?\n\nSend them like this:\n\n` + `*01-07-2026 to 30-09-2026*${TAGS.dates}`;
}

/**
 * The shortlist a "I found a few people called X" question offered, or null.
 *
 * When two accounts match a name the bot lists them and asks for a number. That number is
 * not a menu choice and not a report, so without reading the list back out of the question
 * the person's answer goes nowhere — the same dead end a bare name hit.
 */
export function awaitedChoice(lastBotMessage: string | null): { ledger: string; names: string[] } | null {
  if (!lastBotMessage) return null;
  const isParty = /^I found a few people called/.test(lastBotMessage);
  const isItem = /^I found a few items like/.test(lastBotMessage);
  if (!isParty && !isItem) return null;
  const names = [...lastBotMessage.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim());
  if (names.length === 0) return null;
  return { ledger: isItem ? 'item_ledger' : 'party', names };
}

/**
 * The ledger a "Which customer?" question was about, or null.
 *
 * RequestAccountingReport asks this when a party ledger names nobody. The answer is a bare
 * name, which matches no menu step and no keyword, so without reading the question back the
 * person is answered with "I did not understand that" and cannot get out of the loop.
 */
export function awaitedParty(lastBotMessage: string | null): string | null {
  if (!lastBotMessage) return null;
  if (/^Which customer\?/.test(lastBotMessage)) return 'customer_ledger';
  if (/^Which supplier\?/.test(lastBotMessage)) return 'vendor_ledger';
  if (/^Which expense account\?/.test(lastBotMessage)) return 'expense_ledger';
  return null;
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
  // The name is wrapped in WhatsApp's *bold* markers, which are part of the message a person
  // reads and so part of what has to be parsed back out.
  const match = /^\*?([A-Za-z &'’-]+?)\*?\s+—/.exec(message.trim());
  return match ? match[1].trim() : '';
}

/**
 * A report chosen by typing its name while the list is open.
 *
 * Exact first, then a unique partial, so "trial" finds the Trial Balance but "ledger" — which
 * four reports share — matches nothing and the list is simply shown again. Guessing between
 * ledgers is how somebody receives the wrong book.
 */
function byName(reply: string, reports: MenuReport[]): MenuReport | undefined {
  const typed = reply.trim().toLowerCase();
  if (typed.length < 3) return undefined;
  // A sentence is a request, not a selection: "send me the trial balance for July" carries a
  // period and belongs to the reasoning, which can act on all of it. Only a bare name is a
  // choice, so the cutoff is length rather than content.
  if (typed.split(/\s+/).length > 3) return undefined;
  const exact = reports.find(r => r.displayName.toLowerCase() === typed);
  if (exact) return exact;
  const partial = reports.filter(r => r.displayName.toLowerCase().includes(typed));
  return partial.length === 1 ? partial[0] : undefined;
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
  const back = (days: number): string => iso(new Date(now.getTime() - days * 86_400_000));
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  switch (choice) {
    case 1:
      // The host's own default. Named anyway, so choosing it is a decision rather than a guess.
      return { from: back(7), to: iso(now) };
    case 2:
      return { from: back(10), to: iso(now) };
    case 3:
      return { from: back(15), to: iso(now) };
    case 4:
      return { from: back(30), to: iso(now) };
    case 5:
      return { from: iso(new Date(Date.UTC(year, month, 1))), to: iso(now) };
    case 6:
      return { from: iso(new Date(Date.UTC(year, 0, 1))), to: iso(now) };
    case 7:
      return { from: iso(new Date(Date.UTC(year, 0, 1))), to: iso(now) };
    default:
      // 8 is the custom range, which is a prompt rather than a period.
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

  // "back" or "menu" anywhere returns to the start, so nobody is ever stuck part-way through
  // a question they did not mean to open.
  if (/^\s*(back|menu|start|cancel|wapas)\s*$/i.test(reply)) return { kind: 'show', text: rootMenu() };

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
    const ordered = orderReports(reports);
    // The name typed instead of its number: "trial balance" while the list is open is the
    // same choice as "1", and correcting someone who answered clearly is pure friction.
    const report = choice === null ? byName(reply, ordered) : ordered[choice - 1];
    if (!report) return choice === null ? { kind: 'none' } : { kind: 'show', text: reportMenu(reports) };
    return report.datedByDefault
      ? { kind: 'show', text: periodMenu(report.displayName) }
      : { kind: 'report', documentType: report.documentType, from: null, to: null };
  }

  if (step.kind === 'period') {
    const report = reports.find(r => r.displayName === step.documentType);
    if (!report) return { kind: 'show', text: reportMenu(reports) };
    if (choice === 0) return { kind: 'show', text: reportMenu(reports) };
    // 8 is the custom range in PERIOD_OPTIONS: a prompt for two dates, not a period itself.
    if (choice === PERIOD_OPTIONS.length) return { kind: 'show', text: datesPrompt(report.displayName) };
    const period = choice === null ? null : periodFor(choice, now);
    if (!period) {
      /*
       * A period typed instead of chosen is an answer, not a mistake — and it is read with the
       * same parser the free-text path uses, so "last 20 days" and "1 Jan se 31 March tak"
       * work here too rather than only the two forms this menu happens to print.
       */
      const typed = readDates(reply) ?? parsePeriod(reply, now);
      if (typed) return { kind: 'report', documentType: report.documentType, from: typed.from, to: typed.to };
      /*
       * Anything else is a NEW request, not a bad answer.
       *
       * Re-showing the question for every unrecognised reply trapped people: having opened
       * the Trial Balance date menu, "customer ledger bhejo" and even a customer's name were
       * answered with the same dates question again, forever. A person who has moved on has
       * moved on, so this falls through to the reasoning — and a stray "x" lands on the
       * ordinary "I did not understand" reply, which is the honest one.
       */
      return { kind: 'none' };
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
