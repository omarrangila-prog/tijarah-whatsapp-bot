/**
 * Contract enforcement on everything a host system returns.
 *
 * The port's TypeScript types describe what a host is supposed to send. They vanish at
 * runtime, and the data is arriving from someone else's ERP over HTTP — so this file is
 * where the contract is actually enforced.
 *
 * The governing decision: **coerce nothing that carries meaning.** It is tempting to read
 * `"1,50,000.00"` as 150000, or an empty due date as "today", or `null` outstanding as
 * zero. Every one of those guesses produces a confident, well-formatted payment demand
 * built on an assumption nobody made deliberately. A malformed field stops the customer's
 * reminder and names the field; it does not get a best-effort reading.
 *
 * The one thing that *is* normalised is presentation of a number that is unambiguously a
 * number: `150000`, `"150000"`, `"150000.00"` and `" 150000.0000 "` all mean the same
 * thing and differ only in how a host's JSON serialiser felt that day.
 */

import { BadGatewayException } from '@nestjs/common';
import type {
  DecimalString,
  IsoDate,
  LedgerBusiness,
  LedgerContact,
  LedgerEntry,
  LedgerFacts,
  LedgerInvoice,
  LedgerParty,
  LedgerStatement,
  ReceivablesRow,
} from './ledger.port';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Renders an unknown value for a human-facing message.
 *
 * `String({})` gives "[object Object]", which tells an operator nothing about which field
 * their host sent wrong — the whole point of these messages.
 */
export function describeValue(value: unknown, max = 200): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString().slice(0, max);
  }
  if (typeof value === 'symbol') return value.toString().slice(0, max);
  // Objects, arrays and functions: serialise rather than let String() emit "[object Object]",
  // which tells an operator nothing about which field their host sent wrong.
  try {
    return (JSON.stringify(value) ?? '[unserialisable]').slice(0, max);
  } catch {
    return '[unserialisable]';
  }
}

function fail(field: string, value: unknown, why: string): never {
  throw new BadGatewayException(`The connected system returned an unusable value for "${field}": ${why}.`);
}

/**
 * Compares two decimal strings exactly, without a decimal library.
 *
 * Scales both to the wider number of decimal places and compares as integers. Floats have
 * no place here: these are the figures a customer is asked to pay.
 */
export function amountsEqual(a: string, b: string): boolean {
  const parts = (v: string): [string, string] => {
    const [i, f = ''] = v.replace(/^\+/, '').split('.');
    return [i ?? '0', f];
  };
  const [ai, af] = parts(a);
  const [bi, bf] = parts(b);
  const width = Math.max(af.length, bf.length);
  return `${ai}.${af.padEnd(width, '0')}` === `${bi}.${bf.padEnd(width, '0')}`;
}

/** True when the decimal string is strictly negative. */
function isNegative(value: string): boolean {
  return value.trim().startsWith('-') && /[1-9]/.test(value);
}

/**
 * A decimal string, or a hard stop.
 *
 * Accepts a JS number reluctantly — hosts do send them — but only when it survives the
 * round trip through a string exactly. A float that has already lost precision by the time
 * it reaches here cannot be recovered, and pretending otherwise is how 150000.00000000003
 * ends up in a payment demand.
 */
export function requireAmount(value: unknown, field: string): DecimalString {
  if (value === null || value === undefined || value === '') fail(field, value, 'it is missing');

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(field, value, 'it is not a finite number');
    const asString = String(value);
    if (asString.includes('e') || asString.includes('E')) {
      fail(field, value, 'it is in exponent notation, which cannot be read as an exact amount');
    }
    if (!/^-?\d+(\.\d+)?$/.test(asString)) fail(field, value, 'it is not an exact decimal amount');
    return asString;
  }

  if (typeof value !== 'string') fail(field, value, 'it is not a number or a decimal string');

  const trimmed = value.trim();
  /*
   * Grouping separators are refused rather than stripped.
   *
   * "1,50,000" is 150,000 in the South Asian convention and 150 in the European one, where
   * the comma is a decimal point. There is no safe way to guess which a given ERP means,
   * and guessing wrong by a factor of a thousand in a demand for payment is not a rounding
   * error. The adapter's field mapping is where a host's format gets declared.
   */
  if (/[,\s]/.test(trimmed)) {
    fail(field, value, 'it contains grouping separators, which are ambiguous — send a plain decimal like "150000.00"');
  }
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) fail(field, value, 'it is not a plain decimal number');

  return trimmed;
}

/** An optional amount. Absent stays absent; present must be valid. */
export function optionalAmount(value: unknown, field: string): DecimalString | null {
  if (value === null || value === undefined || value === '') return null;
  return requireAmount(value, field);
}

export function requireDate(value: unknown, field: string): IsoDate {
  if (value === null || value === undefined || value === '') fail(field, value, 'it is missing');
  const text = describeValue(value).trim();

  // A full timestamp is fine — take the date part. Hosts routinely send one.
  const candidate = text.length > 10 && /^\d{4}-\d{2}-\d{2}[T ]/.test(text) ? text.slice(0, 10) : text;
  if (!ISO_DATE.test(candidate)) {
    fail(
      field,
      value,
      'it is not an ISO date (YYYY-MM-DD) — other formats are ambiguous between day-first and month-first',
    );
  }
  // Rejects 2026-02-31, which matches the pattern and is not a day.
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    fail(field, value, 'it is not a real calendar date');
  }
  return candidate;
}

export function optionalDate(value: unknown, field: string): IsoDate | null {
  if (value === null || value === undefined || value === '') return null;
  return requireDate(value, field);
}

export function requireString(value: unknown, field: string, max = 500): string {
  if (value === null || value === undefined) fail(field, value, 'it is missing');
  const text = describeValue(value).trim();
  if (text.length === 0) fail(field, value, 'it is empty');
  return text.slice(0, max);
}

export function optionalString(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const text = describeValue(value).trim();
  return text.length === 0 ? null : text.slice(0, max);
}

/* ------------------------------------------------------------------ shapes */

export function validateParty(raw: unknown, context = 'party'): LedgerParty {
  if (!raw || typeof raw !== 'object') fail(context, raw, 'it is not an object');
  const row = raw as Record<string, unknown>;
  return {
    externalId: requireString(row.externalId, `${context}.externalId`, 128),
    name: requireString(row.name, `${context}.name`, 200),
    displayName: optionalString(row.displayName, 200),
    phone: optionalString(row.phone, 40),
    email: optionalString(row.email, 200),
    city: optionalString(row.city, 120),
    address: optionalString(row.address, 500),
    taxId: optionalString(row.taxId, 60),
    creditLimit: optionalAmount(row.creditLimit, `${context}.creditLimit`),
    creditDays: row.creditDays === null || row.creditDays === undefined ? null : Number(row.creditDays) || 0,
    group: optionalString(row.group, 60),
    isActive: row.isActive === undefined ? true : Boolean(row.isActive),
  };
}

export function validateInvoice(raw: unknown, context = 'invoice'): LedgerInvoice {
  if (!raw || typeof raw !== 'object') fail(context, raw, 'it is not an object');
  const row = raw as Record<string, unknown>;

  const outstanding = requireAmount(row.outstanding, `${context}.outstanding`);
  if (isNegative(outstanding)) {
    // A negative outstanding is a credit, not a debt. Chasing it would demand money from a
    // customer who is owed money.
    fail(`${context}.outstanding`, outstanding, 'it is negative, so this is a credit rather than a debt');
  }

  return {
    externalId: requireString(row.externalId, `${context}.externalId`, 128),
    number: requireString(row.number, `${context}.number`, 80),
    issueDate: requireDate(row.issueDate, `${context}.issueDate`),
    /*
     * A due date is required and never defaulted.
     *
     * Every reminder is built around "this was due on X, which is N days ago". With no due
     * date there is no overdue, no ladder position and nothing truthful to say — and
     * substituting the issue date would silently make every invoice in a host that leaves
     * due dates blank instantly overdue by its payment terms.
     */
    dueDate: requireDate(row.dueDate, `${context}.dueDate`),
    total: requireAmount(row.total, `${context}.total`),
    outstanding,
    currency: optionalString(row.currency, 3),
    reference: optionalString(row.reference, 120),
  };
}

export function validateFacts(raw: unknown): LedgerFacts {
  if (!raw || typeof raw !== 'object') fail('facts', raw, 'it is not an object');
  const row = raw as Record<string, unknown>;

  const invoices = Array.isArray(row.invoices)
    ? row.invoices.map((invoice, index) => validateInvoice(invoice, `invoices[${index}]`))
    : [];

  return {
    party: validateParty(row.party),
    balance: requireAmount(row.balance, 'balance'),
    currency: requireString(row.currency ?? 'PKR', 'currency', 3).toUpperCase(),
    invoices,
    asOf: typeof row.asOf === 'string' && row.asOf.length > 0 ? row.asOf : new Date().toISOString(),
    lastPaymentDate: optionalDate(row.lastPaymentDate, 'lastPaymentDate'),
    lastPaymentAmount: optionalAmount(row.lastPaymentAmount, 'lastPaymentAmount'),
  };
}

export function validateContact(raw: unknown, context = 'contact'): LedgerContact {
  if (!raw || typeof raw !== 'object') fail(context, raw, 'it is not an object');
  const row = raw as Record<string, unknown>;
  return {
    externalId: optionalString(row.externalId, 128),
    name: requireString(row.name, `${context}.name`, 200),
    role: optionalString(row.role, 80),
    phone: optionalString(row.phone, 40),
    email: optionalString(row.email, 200),
    isPrimary: Boolean(row.isPrimary),
  };
}

export function validateEntry(raw: unknown, context = 'entry'): LedgerEntry {
  if (!raw || typeof raw !== 'object') fail(context, raw, 'it is not an object');
  const row = raw as Record<string, unknown>;
  return {
    date: requireDate(row.date, `${context}.date`),
    reference: optionalString(row.reference, 80) ?? '',
    description: optionalString(row.description, 300) ?? '',
    debit: optionalAmount(row.debit, `${context}.debit`) ?? '0',
    credit: optionalAmount(row.credit, `${context}.credit`) ?? '0',
    balance: optionalAmount(row.balance, `${context}.balance`),
  };
}

/**
 * A statement, with its running balance checked rather than trusted.
 *
 * Opening plus every debit minus every credit must equal closing. A host whose statement
 * does not add up has sent something the agent must not put in front of a customer under
 * its own letterhead — and a mismatch here is far more likely to be a mapping error (a
 * debit column mapped to credit) than a bug in the host's accounting.
 */
export function validateStatement(raw: unknown): LedgerStatement {
  if (!raw || typeof raw !== 'object') fail('statement', raw, 'it is not an object');
  const row = raw as Record<string, unknown>;

  const opening = requireAmount(row.openingBalance ?? '0', 'statement.openingBalance');
  const closing = requireAmount(row.closingBalance ?? '0', 'statement.closingBalance');
  const entries = Array.isArray(row.entries)
    ? row.entries.map((entry, index) => validateEntry(entry, `statement.entries[${index}]`))
    : [];

  /*
   * Summed as scaled integers, never as floats.
   *
   * These are the figures a customer is asked to pay. `0.1 + 0.2` producing
   * 150000.00000000003 in a statement is not a rounding curiosity, it is a wrong document
   * under the business's letterhead.
   */
  const SCALE = 4;
  let running = toScaled(opening, SCALE);
  for (const entry of entries) {
    running += toScaled(entry.debit, SCALE) - toScaled(entry.credit, SCALE);
  }

  // Compared at 2dp, which is what the document shows; a host carrying more precision
  // internally is not a mapping error.
  const round2 = (v: bigint): bigint => {
    const factor = 10n ** BigInt(SCALE - 2);
    const negative = v < 0n;
    const abs = negative ? -v : v;
    const rounded = (abs + factor / 2n) / factor;
    return negative ? -rounded : rounded;
  };

  if (round2(running) !== round2(toScaled(closing, SCALE))) {
    fail(
      'statement.closingBalance',
      closing,
      `the entries do not add up to it (opening ${opening} plus the movements gives ${fromScaled(running, SCALE)}) — check the debit and credit field mapping`,
    );
  }

  return { openingBalance: opening, entries, closingBalance: closing };
}

/** Decimal string to a scaled bigint. Rejects anything that is not a plain decimal. */
function toScaled(value: string, scale: number): bigint {
  const negative = value.trim().startsWith('-');
  const [whole = '0', fraction = ''] = value.trim().replace(/^[+-]/, '').split('.');
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  const magnitude = BigInt(`${whole || '0'}${padded}`);
  return negative ? -magnitude : magnitude;
}

function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function validateBusiness(raw: unknown): LedgerBusiness {
  if (!raw || typeof raw !== 'object') fail('business', raw, 'it is not an object');
  const row = raw as Record<string, unknown>;
  return {
    name: requireString(row.name, 'business.name', 200),
    legalName: optionalString(row.legalName, 200),
    addressLines: Array.isArray(row.addressLines)
      ? row.addressLines
          .map(line => String(line))
          .filter(Boolean)
          .slice(0, 4)
      : optionalString(row.address, 500)
        ? [optionalString(row.address, 500)!]
        : [],
    city: optionalString(row.city, 120),
    country: optionalString(row.country, 60),
    phone: optionalString(row.phone, 40),
    email: optionalString(row.email, 200),
    taxId: optionalString(row.taxId, 60),
    currency: (optionalString(row.currency, 3) ?? 'PKR').toUpperCase(),
    paymentInstructions: optionalString(row.paymentInstructions, 1000),
  };
}

export function validateReceivablesRow(raw: unknown, index: number): ReceivablesRow {
  if (!raw || typeof raw !== 'object') fail(`receivables[${index}]`, raw, 'it is not an object');
  const row = raw as Record<string, unknown>;
  const oldestDueDate = optionalDate(row.oldestDueDate, `receivables[${index}].oldestDueDate`);
  return {
    party: validateParty(row.party, `receivables[${index}].party`),
    outstanding: requireAmount(row.outstanding, `receivables[${index}].outstanding`),
    oldestDueDate,
    daysOverdue: Math.max(0, Number(row.daysOverdue ?? 0) || 0),
    invoiceCount: Math.max(0, Number(row.invoiceCount ?? 0) || 0),
  };
}
