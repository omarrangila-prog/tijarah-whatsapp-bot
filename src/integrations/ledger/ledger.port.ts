/**
 * The ledger port: the entire contract between this agent and the software it serves.
 *
 * Everything the agent knows about money it learns through this interface. There are eight
 * methods and **every one of them is a read**. There is no `markPaid`, no `postReceipt`,
 * no `applyCredit`, and none will be added — the agent's safety guarantee is not a policy
 * written in a document, it is the absence of a method.
 *
 * That matters because of what this agent does. It sends messages to a business's customers
 * demanding money, using figures it did not compute and wording it got from a language
 * model. Three rules follow, and the port is shaped to enforce them structurally rather
 * than by discipline:
 *
 *   1. **The host owns the truth.** A balance is whatever the host says it is, at the moment
 *      it is asked. The agent stores what it *quoted* in a given message, so a conversation
 *      months later can be reconstructed, but it never stores "the balance" and never
 *      derives one. If the host is unreachable, the agent sends nothing — it does not fall
 *      back to a cached figure, because a stale demand is worse than a late one.
 *
 *   2. **A conversation cannot change an accounting record.** A customer replying "I already
 *      paid" produces a notification for a human and nothing else. With no write method on
 *      this port, there is no code path from a WhatsApp message to an invoice, whatever a
 *      model concludes and whatever a future contributor intends.
 *
 *   3. **Reminders stop because the ledger says so.** "Cancel after payment" is implemented
 *      by re-asking the host before every send. The agent does not need to be told a
 *      payment happened; it needs only to notice the invoice is no longer outstanding.
 *
 * Implementing this port is the whole integration. `adapters/rest` implements it against
 * any JSON API through a field-mapping config; a host that would rather push than be polled
 * implements it against the agent's own mirror tables. Neither can do more than read.
 */

/** Amounts cross this boundary as decimal strings. Never as JavaScript numbers. */
export type DecimalString = string;

/** An ISO calendar date, `YYYY-MM-DD`. Never a timestamp, never a locale format. */
export type IsoDate = string;

export interface LedgerBusiness {
  name: string;
  legalName?: string | null;
  addressLines?: string[];
  city?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  currency: string;
  /** Printed on every document, so a customer knows how to actually pay. */
  paymentInstructions?: string | null;
}

export interface LedgerParty {
  /** The host's own identifier. Opaque to the agent, and the join key for everything. */
  externalId: string;
  name: string;
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  address?: string | null;
  taxId?: string | null;
  creditLimit?: DecimalString | null;
  creditDays?: number | null;
  /** Lets a business run a gentler ladder for old customers and a firmer one for new. */
  group?: string | null;
  isActive?: boolean;
}

export interface LedgerInvoice {
  externalId: string;
  /** The human reference the customer will recognise. Quoted verbatim in messages. */
  number: string;
  issueDate: IsoDate;
  dueDate: IsoDate;
  total: DecimalString;
  /** What is still owed, net of payments and credit notes. The figure that matters. */
  outstanding: DecimalString;
  currency?: string | null;
  reference?: string | null;
}

export interface LedgerContact {
  externalId?: string | null;
  name: string;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  isPrimary?: boolean;
}

/** One line of a customer's account history, for the statement document. */
export interface LedgerEntry {
  date: IsoDate;
  reference: string;
  description: string;
  debit: DecimalString;
  credit: DecimalString;
  /** The host's running balance, if it keeps one; otherwise the agent computes it. */
  balance?: DecimalString | null;
}

export interface LedgerStatement {
  openingBalance: DecimalString;
  entries: LedgerEntry[];
  closingBalance: DecimalString;
}

/**
 * A customer's receivable position.
 *
 * `balance` is authoritative and `invoices` is the explanation. They are allowed to
 * disagree: a customer who migrated from a paper ledger carries an opening balance with no
 * invoice behind it, and a reminder that lists 40,000 of invoices against a balance of
 * 150,000 looks like a mistake to the customer unless the difference is named. The agent
 * names it rather than hiding it.
 */
export interface LedgerFacts {
  party: LedgerParty;
  balance: DecimalString;
  currency: string;
  invoices: LedgerInvoice[];
  /** When the host computed this. Used to refuse a stale fact set rather than quote it. */
  asOf: string;
  lastPaymentDate?: IsoDate | null;
  lastPaymentAmount?: DecimalString | null;
}

export interface ReceivablesQuery {
  /** `overdue` means due date strictly before `asOf`. */
  bucket?: 'overdue' | 'due_today' | 'upcoming' | 'all';
  asOf?: IsoDate;
  limit?: number;
  search?: string | null;
}

export interface ReceivablesRow {
  party: LedgerParty;
  outstanding: DecimalString;
  oldestDueDate: IsoDate | null;
  daysOverdue: number;
  invoiceCount: number;
}

export interface LedgerHealth {
  ok: boolean;
  /** A sentence a person can act on, not a stack trace. */
  detail: string;
  latencyMs?: number;
}

/**
 * What a host system implements.
 *
 * Every method may throw `AppError('LEDGER_UNAVAILABLE')` when the host cannot be reached,
 * or `AppError('LEDGER_CONTRACT_VIOLATION')` when it answers with something unusable. Both
 * stop the agent; neither is papered over. An adapter that returns a zero balance because
 * the host was down would cause the agent to retire a real debt as paid.
 */
export interface LedgerPort {
  /** Stable identifier for logs and the admin screen: `rest`, `mirror`, `karobaros`. */
  readonly name: string;

  /** Letterhead and payment instructions for generated documents. */
  getBusiness(): Promise<LedgerBusiness>;

  /** The collections worklist. */
  listReceivables(query: ReceivablesQuery): Promise<ReceivablesRow[]>;

  getParty(externalId: string): Promise<LedgerParty>;

  /**
   * The authoritative position for one customer.
   *
   * Called again immediately before every send, however recently it was called. That
   * re-check is what makes "stop chasing someone who has paid" work without the agent ever
   * being told a payment happened.
   */
  getFacts(externalId: string, asOf?: IsoDate): Promise<LedgerFacts>;

  /** People at the customer the host knows about. May be empty; the agent keeps its own. */
  getContacts(externalId: string): Promise<LedgerContact[]>;

  /** Account history for the statement PDF. */
  getStatement(externalId: string, from?: IsoDate | null, to?: IsoDate | null): Promise<LedgerStatement>;

  /** One invoice in full, for the invoice PDF. Null when the host cannot supply lines. */
  getInvoice(
    externalId: string,
  ): Promise<(LedgerInvoice & { lines?: LedgerInvoiceLine[]; party?: LedgerParty }) | null>;

  /** Answered without side effects, for the settings screen and the pre-flight check. */
  health(): Promise<LedgerHealth>;
}

export interface LedgerInvoiceLine {
  description: string;
  quantity?: DecimalString | null;
  unitPrice?: DecimalString | null;
  taxAmount?: DecimalString | null;
  lineTotal: DecimalString;
}

/* ============================== WRITES ============================== */

/**
 * The write half of the port.
 *
 * Added deliberately and against the original design, which was read-only. That decision
 * is reversed here because the agent is being asked to raise invoices and record payments
 * in a client's accounting system — so the honest thing is to make those operations
 * first-class, auditable and idempotent, rather than to leave someone to bolt them on
 * later without these guarantees.
 *
 * What has NOT changed is who may trigger them. Every method below is reachable only from
 * a tool marked `tier: 'write'`, which means:
 *
 *   * it is absent from the customer tool allowlist, so a customer's message can never
 *     reach it however the message is phrased;
 *   * it defaults to REQUIRE_APPROVAL, so an administrator sees the exact figures and
 *     replies APPROVE before anything is written;
 *   * the approval stores the resolved arguments, so what was approved is what runs.
 *
 * The distinction that matters most: `recordPayment` posts money a HUMAN has confirmed
 * arrived. It is not, and must never become, the handler for a customer saying they paid.
 */

export interface CreateInvoiceLine {
  description: string;
  quantity: DecimalString;
  unitPrice: DecimalString;
  /** Host-side tax code, when the host uses one. */
  taxCode?: string | null;
}

export interface CreateInvoiceInput {
  partyExternalId: string;
  issueDate: IsoDate;
  dueDate: IsoDate;
  lines: CreateInvoiceLine[];
  reference?: string | null;
  notes?: string | null;
  currency?: string | null;
  /**
   * Required, and passed to the host.
   *
   * An invoice raised twice is a real debt the customer does not owe, and the ways it
   * happens are mundane: a retried request, a double-tapped approval, a webhook redelivery.
   * The key is derived from the approval that authorised it, so a repeat carries the same
   * value and a host that honours it returns the original invoice instead of a second one.
   */
  idempotencyKey: string;
}

export interface RecordPaymentInput {
  partyExternalId: string;
  /** The invoice being settled. Null means an on-account payment. */
  invoiceExternalId: string | null;
  amount: DecimalString;
  paidOn: IsoDate;
  method?: string | null;
  /** The bank/cheque/transfer reference a human verified. */
  reference?: string | null;
  notes?: string | null;
  idempotencyKey: string;
}

export interface WriteResult {
  /** The host's id for what was created. */
  externalId: string;
  /** The human reference, when the host mints one (`INV-1042`). */
  number?: string | null;
  /** True when the host recognised the idempotency key and returned an existing record. */
  deduplicated: boolean;
  /** Whatever else the host returned, for the audit trail. */
  raw?: Record<string, unknown>;
}

/**
 * Implemented by an adapter whose host supports writing.
 *
 * Separate from `LedgerPort` on purpose: a read-only integration is a legitimate and safer
 * configuration, and `supportsWrites()` lets the agent offer the write tools only where
 * they will actually work rather than failing at approval time.
 */
export interface LedgerWritePort {
  createInvoice(input: CreateInvoiceInput): Promise<WriteResult>;
  recordPayment(input: RecordPaymentInput): Promise<WriteResult>;
}

export function supportsWrites(port: unknown): port is LedgerPort & LedgerWritePort {
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof (port as LedgerWritePort).createInvoice === 'function' &&
    typeof (port as LedgerWritePort).recordPayment === 'function'
  );
}

/** DI token for the configured ledger adapter. */
export const LEDGER_PORT = Symbol('LEDGER_PORT');
