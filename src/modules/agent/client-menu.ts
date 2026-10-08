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
import { wallClock } from '../../common/utils/wall-clock';

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
  /^\s*(?:(?:bhai|yaar|ji|sir|ok|acha|achha)[\s!.,]+)?(send|bhejo?|menu|start|hi+|hey+|hy|hello|helo|hlo|help|salam|slam|assalam\w*|asalam\w*|aoa|option|options|list)[\s!.,]*(please|plz|bhai|yaar|ji)?[\s!.,]*$/i;

/**
 * Marks a message as one of this menu's, so the next reply can be read in context.
 *
 * Every character here must be INVISIBLE. The first version ended each tag in a real digit
 * (zero-width space, zero-width space, "1"), so every menu a client received closed with a
 * stray number — "like trial balance.1", "Send 0 to go back.2" — on every single menu. The
 * tags are read back from the bot's own stored reply, never from WhatsApp, so they only have
 * to survive our database, which they do.
 */
const TAGS: Record<string, string> = {
  root: '\u2060\u200b\u200b',
  reports: '\u2060\u200b\u200c',
  period: '\u2060\u200c\u200b',
  dates: '\u2060\u200c\u200c',
};

/**
 * The tags the first version sent, still recognised for one reason: a person who was half-way
 * through a menu when the update landed answers a message that carries the old tag, and
 * without this their "2" would fall through to "I did not understand".
 */
const LEGACY_TAGS: Record<string, string> = {
  root: '\u200b\u200b1',
  reports: '\u200b\u200b2',
  period: '\u200b\u200b3',
  dates: '\u200b\u200b4',
};

/** Whether a message carries this step's tag, current or legacy. */
const tagged = (message: string, step: string): boolean =>
  message.includes(TAGS[step]) || message.includes(LEGACY_TAGS[step]);

/*
 * Option 1 is the customer ledger, and like every ledger it asks WHICH customer after the
 * dates — "send *all* for every customer" is offered in that question. The client asked for the
 * bot to ask who before sending, not to decide on their behalf that it meant everyone.
 */
const ROOT_OPTIONS = [
  { label: 'Who owes me money', documentType: 'customer_ledger' },
  { label: 'Send me a report', documentType: null },
  { label: 'Get an invoice or voucher', documentType: null },
] as const;

/**
 * The root options as lines, for any message that offers "send 1, 2 or 3".
 *
 * Shared, because the "did not understand" reply printed its own list, whose option 3 said
 * "Make a new invoice or voucher" while sending 3 actually asked for an invoice NUMBER — the
 * same digit promising one thing and doing another.
 */
export function rootOptionLines(): string[] {
  return ROOT_OPTIONS.map((o, i) => `${i + 1}.  ${o.label}`);
}

/**
 * The voucher picked in answer to "Which voucher? 1. Payment 2. Receive", or null.
 *
 * Without this the "1" carried no menu tag and was read as option 1 of the MAIN menu, so
 * choosing "Payment voucher" opened the Customer Ledger.
 */
export function voucherPick(lastBotMessage: string | null, reply: string): string | null {
  if (!lastBotMessage || !/^Which voucher\?/.test(lastBotMessage)) return null;
  const choice = readChoice(reply);
  if (choice === 1 || /^\s*payment\s*$/i.test(reply)) return 'Payment Voucher';
  if (choice === 2 || /^\s*(receive|receipt)\s*$/i.test(reply)) return 'Receive Voucher';
  return null;
}

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
  const lines = rootOptionLines();
  return (
    `Hello! This is *${businessName}*.\n\nWhat do you need?\n\n${lines.join('\n')}\n\n` +
    `Just send 1, 2 or 3.\nOr type what you want, like _trial balance_.${TAGS.root}`
  );
}

/**
 * The report list: a number per report, and the name itself also works.
 *
 * Not capped. A cap of 20 silently dropped the Vendor Ledger the day invoices and vouchers
 * were (wrongly) added to this list — the 21st entry simply vanished, with nothing to say so.
 * The caller passes reports only; documents are fetched by number and have their own option.
 */
export function reportMenu(reports: MenuReport[]): string {
  const lines = orderReports(reports).map((r, i) => `${i + 1}.  ${r.displayName}`);
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
 *
 * Each line carries the account's code in brackets, and the CODE is what a pick resolves to.
 * Resolving by name looped forever on a real client: three accounts all called exactly
 * "USMAN", so picking "1" searched for "USMAN" again, found the same three, and asked again.
 * A line with no code (an older message, or a name learned without one) keeps the name.
 */
export interface ShortlistOption {
  name: string;
  code: string | null;
  /** A product rather than an account, so the pick goes to the item ledger. */
  item: boolean;
}

export function awaitedChoice(
  lastBotMessage: string | null,
): { ledger: string; names: string[]; options: ShortlistOption[] } | null {
  if (!lastBotMessage) return null;
  // "people" is the older wording, still read so a reply to one sent before the update works.
  const isParty = /^I found a few (?:people|accounts) called|^I could not find "[^"]*"\. Did you mean/.test(
    lastBotMessage,
  );
  const isItem = /^I found a few items like/.test(lastBotMessage);
  if (!isParty && !isItem) return null;
  const options = [...lastBotMessage.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => {
    const line = m[1].trim();
    const item = isItem || / — item\b/.test(line);
    const coded = /^(.*?)\s*\(([0-9][0-9A-Za-z-]*)\)\s*$/.exec(line);
    if (!coded) return { name: line, code: null, item };
    // "USMAN — 0321 1111111 (0107031)": the name is what comes before the dash.
    return { name: coded[1].split(' — ')[0].trim(), code: coded[2], item };
  });
  if (options.length === 0) return null;
  return { ledger: isItem ? 'item_ledger' : 'party', names: options.map(o => o.name), options };
}

/**
 * One line of a "which one?" shortlist: the name, a phone where there is one, and the code.
 *
 * The phone is what a business owner actually recognises a customer by; the code is what the
 * pick resolves to. Without either, three accounts called "USMAN" were three identical lines.
 */
export function shortlistLine(index: number, name: string, code: string | null, phone?: string | null): string {
  const tel = phone && /\d{7,}/.test(phone.replace(/\D/g, '')) ? ` — ${phone}` : '';
  return `${index}.  ${name}${tel}${code ? ` (${code})` : ''}`;
}

/**
 * Asks for the number of a document named without one: "Sale invoice dede".
 *
 * Built here, next to the reader below, so the question and the code that reads its answer
 * cannot drift apart: a bare "179" in reply is then the number, not a stray digit.
 */
export function documentNumberPrompt(displayName: string): string {
  return `Which *${displayName}*?\n\nSend me its number — for example *179*.`;
}

/**
 * The document a "Which Sale Invoice? Send me its number" question was about, or null.
 *
 * Without this, answering the bot's own question with "179" reached the help list: the number
 * alone names no document, and the person had to start again with "sale invoice 179".
 */
export function awaitedDocument(lastBotMessage: string | null): string | null {
  if (!lastBotMessage) return null;
  const match = /^Which \*([^*]+)\*\?\n\nSend me its number/.exec(lastBotMessage);
  return match ? match[1] : null;
}

/** A document number answering that question: "179", "no 179", "#179". */
export function readDocumentNumber(text: string): string | null {
  const match = /^\s*(?:no\.?|number|#)?\s*(\d{1,10})\s*[.)]?\s*$/i.exec(text);
  return match ? match[1] : null;
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
  if (/^Which item\?/.test(lastBotMessage)) return 'item_ledger';
  if (/^Which account\?/.test(lastBotMessage)) return 'general_ledger';
  return null;
}

/**
 * The dates a "Which customer?" question — or a "which one?" shortlist — was asked with, so the
 * answer keeps them. "Furniture ledger of 1 year", answered with a pick from the list, used to
 * arrive as the whole history.
 */
export function awaitedPartyPeriod(lastBotMessage: string | null): { from: string; to: string } | null {
  if (!lastBotMessage || !(awaitedParty(lastBotMessage) || awaitedChoice(lastBotMessage))) return null;
  const match = /\nDates: (\d{2})-(\d{2})-(\d{4}) to (\d{2})-(\d{2})-(\d{4})\s*$/.exec(lastBotMessage);
  if (!match) return null;
  return { from: `${match[3]}-${match[2]}-${match[1]}`, to: `${match[6]}-${match[5]}-${match[4]}` };
}

/**
 * A reply that is only conversation — "haan bhai", "ok", "why", "Arey bhai" — and so is not
 * the NAME the bot just asked for. Read as one, "haan bhai" became a customer search and
 * "Arey bhai" became the customer on an invoice.
 */
const CHAT_WORDS =
  /^(ok|okay|k|kk|haan|han|ha|haa|ji|jee|g|yes|yeah|no|nahi|nai|nhi|thanks|thank|you|thx|shukriya|acha|achha|accha|theek|thik|hai|he|hmm+|why|what|kya|kia|kyun|kyu|how|kaise|bhai|yaar|yar|arey|are|arre|sir|done|sure|right|hello|hi|hey|salam|please|plz|wait|ruko|chalo|chal|chalna|pagal|bas|nothing|kuch)$/i;

export function isChitChat(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.length > 0 && words.every(word => CHAT_WORDS.test(word));
}

/** Which step a conversation is on, from the last thing the bot said. */
export function stepFor(lastBotMessage: string | null): MenuStep | null {
  if (!lastBotMessage) return null;
  if (tagged(lastBotMessage, 'dates')) return { kind: 'dates', documentType: documentTypeIn(lastBotMessage) };
  if (tagged(lastBotMessage, 'period')) return { kind: 'period', documentType: documentTypeIn(lastBotMessage) };
  if (tagged(lastBotMessage, 'reports')) return { kind: 'reports' };
  if (tagged(lastBotMessage, 'root')) return { kind: 'root' };
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
  now: Date = wallClock(),
): MenuAction {
  const choice = readChoice(reply);

  // "back" or "menu" anywhere returns to the start, so nobody is ever stuck part-way through
  // a question they did not mean to open.
  /*
   * Only while a menu is open. With none, "cancel" belongs to whatever IS open — the bot's own
   * draft messages say "say *cancel* to drop it", and this line answered that with the menu
   * while the invoice stayed open.
   */
  if (step && /^\s*(back|menu|start|cancel|wapas)\s*$/i.test(reply)) return { kind: 'show', text: rootMenu() };

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
      const typed = onlyAPeriod(reply) ? (readDates(reply) ?? parsePeriod(reply, now)) : null;
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
  /*
   * The prompt shows the dates day-first — "01-07-2026 to 30-09-2026" — because that is how
   * Pakistan writes them. Only the ISO form used to be read here, so a person who copied the
   * example exactly was shown the same prompt again, forever.
   */
  const typed = readDates(reply) ?? parsePeriod(reply, now);
  if (!typed) return { kind: 'show', text: datesPrompt(report.displayName) };
  return { kind: 'report', documentType: report.documentType, from: typed.from, to: typed.to };
}

/**
 * Whether a reply is nothing BUT a period: "last 20 days", "1 Jan se 31 March tak".
 *
 * "Furniture ledger of 1 year", typed at the Item Ledger's date question, contains a period
 * too — and taking only that part sent the ledger of every item, dropping the one product the
 * person named. A reply with anything else in it is a new request and goes to the reasoning,
 * which reads all of it.
 */
const PERIOD_WORDS = new RegExp(
  '^(' +
    [
      'last',
      'past',
      'previous',
      'pichle',
      'pichhle',
      'this',
      'current',
      'is',
      'us',
      'from',
      'to',
      'till',
      'until',
      'upto',
      'up',
      'se',
      'tak',
      'and',
      'the',
      'of',
      'for',
      'ka',
      'ki',
      'ke',
      'only',
      'sirf',
      'please',
      'plz',
      'ji',
      'bhai',
      'aaj',
      'ab',
      'today',
      'date',
      'days?',
      'din',
      'weeks?',
      'hafte',
      'hafta',
      'months?',
      'mahine',
      'mahina',
      'years?',
      'saal',
      'one',
      'two',
      'three',
      'six',
      'twelve',
      'ek',
      'do',
      'teen',
      'chaar',
      'char',
      'paanch',
      'panch',
      'chhe',
      'st',
      'nd',
      'rd',
      'th',
      'jan(uary)?',
      'feb(ruary)?',
      'mar(ch)?',
      'apr(il)?',
      'may',
      'june?',
      'july?',
      'aug(ust)?',
      'sep(t|tember)?',
      'oct(ober)?',
      'nov(ember)?',
      'dec(ember)?',
    ].join('|') +
    ')$',
  'i',
);

export function onlyAPeriod(reply: string): boolean {
  const words = reply.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.every(word => PERIOD_WORDS.test(word));
}
