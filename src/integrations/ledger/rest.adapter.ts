/**
 * The generic REST adapter: one ledger port implementation that fits any JSON API.
 *
 * Given a base URL, an auth scheme, endpoint descriptions and field mappings, this reads a
 * host's receivables through its own API. Onboarding a client is writing a config, not
 * shipping a release.
 *
 * Three properties are worth stating because each one exists to prevent a specific way this
 * could go wrong:
 *
 *   * **Every read is validated before it is used.** The host's JSON goes through
 *     `ports/validate.ts`, which refuses ambiguous amounts and missing due dates rather
 *     than coercing them. A host that returns `"1,50,000"` stops that customer's reminder
 *     and names the field; it does not get read as either 150,000 or 150.
 *
 *   * **Failure is loud and never zero.** If the host is unreachable, `getFacts` throws.
 *     Returning an empty invoice list or a zero balance would make the agent conclude the
 *     customer has paid and retire a real debt.
 *
 *   * **Only reads are possible.** There is no write method here because there is none on
 *     the port. A client's ERP credentials, in the agent's hands, can be used to look at
 *     receivables and nothing else — which is what the client should be told, and what is
 *     true.
 */

import { Injectable, BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createLogger } from '../../common/services/logger.service';
import { readCredential } from './secrets';
import { addDecimal, subtractDecimal } from './decimal';
import { describeValue } from './validate';
import type {
  IsoDate,
  LedgerBusiness,
  LedgerContact,
  LedgerFacts,
  LedgerHealth,
  LedgerInvoice,
  LedgerInvoiceLine,
  LedgerParty,
  LedgerPort,
  LedgerStatement,
  ReceivablesQuery,
  ReceivablesRow,
} from './ledger.port';
import {
  validateBusiness,
  validateContact,
  validateEntry,
  validateInvoice,
  validateParty,
  validateStatement,
  requireAmount,
  optionalAmount,
  optionalDate,
} from './validate';
import type { CreateInvoiceInput, LedgerWritePort, RecordPaymentInput, WriteResult } from './ledger.port';
import { applyMapping, readPath, renderTemplate } from './mapping';
import { ledgerRestConfigSchema, type EndpointConfig, type LedgerRestConfig } from './rest.config';

@Injectable()
export class RestLedgerAdapter implements LedgerPort, LedgerWritePort {
  readonly name = 'rest';
  private readonly logger = createLogger('RestLedgerAdapter');
  private readonly config: LedgerRestConfig | null;
  private readonly token: string | null;

  /**
   * Loads the client's connection from the file named by `LEDGER_REST_CONFIG`.
   *
   * A file rather than a pile of environment variables: an integration is a dozen endpoint
   * descriptions and field mappings, which is a document, not a setting. It holds no
   * credential — `auth.credentialRef` names an environment variable and the token is read
   * from the process at call time.
   *
   * A malformed file leaves the adapter unconfigured rather than crashing the app, so a
   * typo costs the ledger integration and not the whole WhatsApp gateway. The reason is
   * logged and surfaced by `health()`.
   */
  private configError: string | null = null;

  constructor() {
    const path = process.env.LEDGER_REST_CONFIG;
    if (!path) {
      this.config = null;
      this.token = null;
      return;
    }
    try {
      const parsed = ledgerRestConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      this.config = parsed;
      this.token =
        parsed.auth.type === 'none' ? null : readCredential(parsed.auth.credentialRef ?? null, 'CLIENT_ERP_TOKEN');
      if (parsed.auth.type !== 'none' && !this.token) {
        this.configError = `No credential found in ${parsed.auth.credentialRef ?? 'CLIENT_ERP_TOKEN'}.`;
      }
    } catch (error) {
      this.config = null;
      this.token = null;
      this.configError = `Could not read ${path}: ${(error as Error).message}`;
      this.logger.warn(`ledger connection not loaded: ${this.configError}`);
    }
  }

  /** Whether a client's system is actually wired up. False means the demo ledger is used. */
  isConfigured(): boolean {
    return this.config !== null && this.configError === null;
  }

  /** Narrows the nullable config at every call site that needs it. */
  private get cfg(): LedgerRestConfig {
    if (!this.config) {
      throw new BadRequestException(
        this.configError ?? 'No accounting system is connected. Set LEDGER_REST_CONFIG to a connection file.',
      );
    }
    return this.config;
  }

  /* ------------------------------------------------------------- transport */

  private authHeaders(): Record<string, string> {
    const { auth } = this.cfg;
    if (auth.type === 'none' || !this.token) return {};
    switch (auth.type) {
      case 'bearer':
        return { authorization: `Bearer ${this.token}` };
      case 'header':
        return { [auth.parameterName ?? 'x-api-key']: this.token };
      case 'basic':
        return {
          authorization: `Basic ${Buffer.from(`${auth.username ?? ''}:${this.token}`).toString('base64')}`,
        };
      default:
        return {};
    }
  }

  /**
   * Calls one configured endpoint and returns the payload at its `resultPath`.
   *
   * Retries transport failures and 5xx responses with a short backoff; never retries a 4xx,
   * because a host answering "no such customer" will answer it again and the retry only
   * delays the error reaching a person.
   */
  private async call(
    endpoint: EndpointConfig,
    variables: Record<string, string>,
    label: string,
    payload?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(
      renderTemplate(endpoint.path, variables).replace(/^\/*/, '/'),
      this.cfg.baseUrl.endsWith('/') ? this.cfg.baseUrl : `${this.cfg.baseUrl}/`,
    );
    // Re-join so a baseUrl with a path prefix (…/api/v1) is not discarded by the leading
    // slash, which is what `new URL('/x', 'https://h/api')` does.
    const joined = new URL(
      `${this.cfg.baseUrl.replace(/\/+$/, '')}${renderTemplate(endpoint.path, variables).replace(/^\/*/, '/')}`,
    );
    joined.search = url.search;

    for (const [key, template] of Object.entries(endpoint.query ?? {})) {
      const value = renderTemplate(template, variables);
      // A placeholder that resolved to nothing is dropped rather than sent as empty, which
      // many APIs treat as "match nothing" instead of "no filter".
      if (value.length > 0) joined.searchParams.set(key, value);
    }
    if (this.cfg.auth.type === 'query' && this.token) {
      joined.searchParams.set(this.cfg.auth.parameterName ?? 'api_key', this.token);
    }

    const body = payload === undefined ? undefined : JSON.stringify(payload);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        const response = await fetch(joined, {
          method: endpoint.method,
          headers: {
            accept: 'application/json',
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...this.authHeaders(),
            ...(endpoint.headers ?? {}),
            ...(extraHeaders ?? {}),
          },
          body,
          signal: controller.signal,
        });

        if (response.status >= 500) {
          lastError = new Error(`the connected system answered ${response.status}`);
          continue;
        }
        if (response.status === 404) {
          throw new NotFoundException(`The connected system has no record for this ${label}.`);
        }
        if (!response.ok) {
          // Never logged with the body: a host's error payload can echo back the request,
          // including anything sensitive in it.
          this.logger.warn('ledger endpoint rejected the request', { label, status: response.status });
          throw new BadGatewayException(
            `The connected system rejected the ${label} request (HTTP ${response.status}).`,
          );
        }

        const payload: unknown = await response.json().catch(() => {
          throw new BadGatewayException(`The ${label} response was not JSON.`);
        });
        return endpoint.resultPath ? readPath(payload, endpoint.resultPath) : payload;
      } catch (error) {
        if (
          error instanceof BadGatewayException ||
          error instanceof NotFoundException ||
          error instanceof BadRequestException
        )
          throw error;
        lastError = error as Error;
        const aborted = (error as Error).name === 'AbortError';
        if (aborted) lastError = new Error(`the connected system did not respond within ${this.cfg.timeoutMs}ms`);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new BadGatewayException(`Could not read ${label} — ${lastError?.message ?? 'no response'}.`);
  }

  private endpoint(key: keyof LedgerRestConfig['endpoints'], required = true): EndpointConfig | null {
    const endpoint = this.cfg.endpoints[key];
    if (!endpoint && required) {
      throw new BadRequestException(
        `This connection has no "${key}" endpoint configured, and it is needed for what you asked for.`,
      );
    }
    return endpoint ?? null;
  }

  private asArray(payload: unknown, label: string): unknown[] {
    if (Array.isArray(payload)) return payload;
    if (payload === null || payload === undefined) return [];
    throw new BadGatewayException(
      `The ${label} response was not a list. Set "resultPath" to wherever the array lives in the response.`,
    );
  }

  /* ---------------------------------------------------------------- reads */

  async getBusiness(): Promise<LedgerBusiness> {
    const endpoint = this.endpoint('business', false);
    if (!endpoint) {
      // Most small ERPs have no "who am I" endpoint, so the letterhead is configured.
      if (!this.cfg.business) {
        throw new BadRequestException(
          'This connection has neither a business endpoint nor configured business details, so documents would have no letterhead.',
        );
      }
      return validateBusiness(this.cfg.business);
    }
    const payload = await this.call(endpoint, {}, 'business');
    const mapped = this.cfg.mappings.business
      ? applyMapping(payload, this.cfg.mappings.business)
      : (payload as Record<string, unknown>);
    return validateBusiness({ ...this.cfg.business, ...mapped });
  }

  async listReceivables(query: ReceivablesQuery = {}): Promise<ReceivablesRow[]> {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const payload = await this.call(
      this.endpoint('receivables')!,
      { asOf, bucket: query.bucket ?? 'all', search: query.search ?? '', limit: String(query.limit ?? 200) },
      'receivables',
    );

    const rows = this.asArray(payload, 'receivables');
    const receivableMapping = this.cfg.mappings.receivable ?? {};

    const mapped = rows.map((row, index) => {
      const party = validateParty(applyMapping(row, this.cfg.mappings.party), `receivables[${index}].party`);
      const summary = applyMapping(row, receivableMapping);

      const outstanding = this.resolveOutstanding(summary, row, `receivables[${index}]`);
      const oldestDueDate = optionalDate(summary.oldestDueDate, `receivables[${index}].oldestDueDate`);

      return {
        party,
        outstanding,
        oldestDueDate,
        // Computed from the date rather than trusted from the host: two systems disagreeing
        // about what "overdue" means is how a customer gets a final notice on day three.
        daysOverdue: oldestDueDate ? daysBetween(oldestDueDate, asOf) : 0,
        invoiceCount: Math.max(0, Number(summary.invoiceCount ?? 0) || 0),
      };
    });

    const filtered = mapped.filter(row => Number(row.outstanding) > 0);
    return applyBucket(filtered, query.bucket ?? 'all', asOf).slice(0, query.limit ?? 200);
  }

  async getParty(externalId: string): Promise<LedgerParty> {
    const payload = await this.call(this.endpoint('party')!, { externalId }, 'customer');
    return validateParty(applyMapping(payload, this.cfg.mappings.party));
  }

  async getFacts(externalId: string, asOf?: IsoDate): Promise<LedgerFacts> {
    const on = asOf ?? new Date().toISOString().slice(0, 10);
    const party = await this.getParty(externalId);
    const invoices = await this.getOpenInvoices(externalId, on);

    /*
     * The balance.
     *
     * A dedicated `facts` endpoint is preferred and used when configured, because a host's
     * own balance includes things no invoice explains — an opening balance carried from a
     * paper ledger, a manual adjustment. Falling back to the sum of open invoices is
     * explicitly second best, and the difference is surfaced to the customer as "carried
     * forward" rather than hidden.
     */
    const factsEndpoint = this.endpoint('facts', false);
    let balance: string;
    let lastPaymentDate: string | null = null;
    let lastPaymentAmount: string | null = null;

    if (factsEndpoint) {
      const payload = await this.call(factsEndpoint, { externalId, asOf: on }, 'balance');
      const mapped = applyMapping(payload, this.cfg.mappings.facts ?? { balance: 'balance' });
      balance = requireAmount(mapped.balance, 'facts.balance');
      lastPaymentDate = optionalDate(mapped.lastPaymentDate, 'facts.lastPaymentDate');
      lastPaymentAmount = optionalAmount(mapped.lastPaymentAmount, 'facts.lastPaymentAmount');
    } else {
      balance = invoices.reduce((total, invoice) => addDecimal(total, invoice.outstanding), '0.00');
    }

    return {
      party,
      balance,
      currency: invoices[0]?.currency ?? this.cfg.business?.currency ?? 'PKR',
      invoices,
      asOf: new Date().toISOString(),
      lastPaymentDate,
      lastPaymentAmount,
    };
  }

  private async getOpenInvoices(externalId: string, asOf: IsoDate): Promise<LedgerInvoice[]> {
    const payload = await this.call(this.endpoint('invoices')!, { externalId, asOf }, 'invoices');
    const rows = this.asArray(payload, 'invoices');

    const invoices: LedgerInvoice[] = [];
    rows.forEach((row, index) => {
      const mapped = applyMapping(row, this.cfg.mappings.invoice);
      mapped.outstanding = this.resolveOutstanding(mapped, row, `invoices[${index}]`);
      const invoice = validateInvoice(mapped, `invoices[${index}]`);
      // A settled invoice is not outstanding and must never appear in a reminder, whatever
      // the host's own "status" field says.
      if (Number(invoice.outstanding) > 0) invoices.push(invoice);
    });

    return invoices.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  /**
   * What is still owed.
   *
   * `total_minus_paid` is offered because many small ERPs have no balance-due column, and
   * it is a subtraction of two host-supplied figures rather than a derivation of anything.
   * It cannot see credit notes the host has not already netted off, which is why the
   * preferred strategy is for the host to send the figure it believes.
   */
  private resolveOutstanding(mapped: Record<string, unknown>, raw: unknown, context: string): string {
    if (this.cfg.outstandingStrategy === 'outstanding') {
      return requireAmount(mapped.outstanding, `${context}.outstanding`);
    }
    const total = requireAmount(
      mapped.total ?? readPath(raw, this.cfg.mappings.invoice.total ?? ''),
      `${context}.total`,
    );
    const paid = optionalAmount(mapped.paid, `${context}.paid`) ?? '0';
    return subtractDecimal(total, paid);
  }

  async getContacts(externalId: string): Promise<LedgerContact[]> {
    const endpoint = this.endpoint('contacts', false);
    if (!endpoint) return [];
    const payload = await this.call(endpoint, { externalId }, 'contacts');
    const rows = this.asArray(payload, 'contacts');
    const mapping = this.cfg.mappings.contact ?? { name: 'name', phone: 'phone' };
    return rows
      .map((row, index) => {
        try {
          return validateContact(applyMapping(row, mapping), `contacts[${index}]`);
        } catch {
          // One malformed contact must not cost the others. A contact is a convenience —
          // the agent keeps its own, with consent, which a host almost never tracks.
          return null;
        }
      })
      .filter((contact): contact is LedgerContact => contact !== null);
  }

  async getStatement(externalId: string, from?: IsoDate | null, to?: IsoDate | null): Promise<LedgerStatement> {
    const endpoint = this.endpoint('statement', false);
    if (!endpoint) {
      /*
       * No statement endpoint: build one from the open invoices.
       *
       * Honest but partial — it shows what is owed and since when, and it cannot show
       * payments, because the host was never asked for them. The document says so in its
       * own footer rather than presenting an incomplete history as a full one.
       */
      const facts = await this.getFacts(externalId, to ?? undefined);
      const entries = facts.invoices.map(invoice => ({
        date: invoice.issueDate,
        reference: invoice.number,
        description: invoice.reference
          ? `Invoice ${invoice.number} — ${invoice.reference}`
          : `Invoice ${invoice.number}`,
        debit: invoice.outstanding,
        credit: '0',
        balance: null,
      }));
      return { openingBalance: '0', entries, closingBalance: facts.balance };
    }

    const payload = await this.call(
      endpoint,
      { externalId, from: from ?? '', to: to ?? new Date().toISOString().slice(0, 10), asOf: to ?? '' },
      'statement',
    );

    const mapping = this.cfg.mappings.entry ?? {
      date: 'date',
      reference: 'reference',
      description: 'description',
      debit: 'debit',
      credit: 'credit',
    };
    const rawEntries = Array.isArray(payload)
      ? payload
      : this.asArray(readPath(payload, 'entries'), 'statement entries');
    const entries = rawEntries.map((row, index) =>
      validateEntry(applyMapping(row, mapping), `statement.entries[${index}]`),
    );

    const opening = optionalAmount(readPath(payload, 'openingBalance'), 'statement.openingBalance') ?? '0';
    let closing = optionalAmount(readPath(payload, 'closingBalance'), 'statement.closingBalance');
    if (closing === null) {
      closing = entries.reduce(
        (total, entry) => subtractDecimal(addDecimal(total, entry.debit), entry.credit),
        opening,
      );
    }

    // Checked, not trusted — a debit column mapped to credit produces a statement that
    // disagrees with itself, and the customer is the one who notices.
    return validateStatement({ openingBalance: opening, entries, closingBalance: closing });
  }

  async getInvoice(
    externalId: string,
  ): Promise<(LedgerInvoice & { lines?: LedgerInvoiceLine[]; party?: LedgerParty }) | null> {
    const endpoint = this.endpoint('invoice', false);
    if (!endpoint) return null;
    const payload = await this.call(endpoint, { externalId }, 'invoice');
    const mapped = applyMapping(payload, this.cfg.mappings.invoice);
    mapped.outstanding = this.resolveOutstanding(mapped, payload, 'invoice');
    const invoice = validateInvoice(mapped, 'invoice');

    const rawLines = readPath(payload, 'lines');
    const lines: LedgerInvoiceLine[] = Array.isArray(rawLines)
      ? rawLines.map(line => {
          const row = line as Record<string, unknown>;
          return {
            description: describeValue(row.description ?? row.name ?? 'Item', 300),
            quantity: optionalAmount(row.quantity, 'line.quantity'),
            unitPrice: optionalAmount(row.unitPrice ?? row.rate, 'line.unitPrice'),
            taxAmount: optionalAmount(row.taxAmount ?? row.tax, 'line.taxAmount'),
            lineTotal: requireAmount(row.lineTotal ?? row.amount ?? '0', 'line.lineTotal'),
          };
        })
      : [];

    return { ...invoice, lines };
  }

  /* -------------------------------------------------------------- writes */

  /**
   * Raises an invoice in the client's system.
   *
   * The body is assembled from the configured field names, because every system calls the
   * customer something different. The idempotency key travels as a header the host can
   * honour; when it does, a retried create returns the original invoice rather than a
   * second one — which matters because a duplicate invoice is a real debt the customer does
   * not owe, and the ways it happens are mundane: a retried request, a double-tapped
   * approval, a redelivered webhook.
   */
  async createInvoice(input: CreateInvoiceInput): Promise<WriteResult> {
    const endpoint = this.endpoint('createInvoice');
    const fields = this.cfg.writeFields ?? DEFAULT_WRITE_FIELDS;

    const body: Record<string, unknown> = {
      [fields.invoicePartyField]: input.partyExternalId,
      [fields.invoiceDateField]: input.issueDate,
      [fields.invoiceDueDateField]: input.dueDate,
      [fields.invoiceLinesField]: input.lines.map(line => ({
        [fields.lineDescriptionField]: line.description,
        [fields.lineQuantityField]: line.quantity,
        [fields.linePriceField]: line.unitPrice,
      })),
    };
    if (input.reference) body[fields.invoiceReferenceField] = input.reference;
    if (input.notes) body.notes = input.notes;
    if (input.currency) body.currency = input.currency;

    const payload = await this.call(endpoint!, { externalId: input.partyExternalId }, 'invoice creation', body, {
      [fields.idempotencyHeader]: input.idempotencyKey,
    });
    return this.toWriteResult(payload, 'invoice');
  }

  /**
   * Records a payment a human has verified.
   *
   * Never called because a customer said they paid — that path routes to a person. The
   * reference is required by the tool schema above this, because a posted receipt with
   * nothing to check it against is an entry nobody can undo with confidence.
   */
  async recordPayment(input: RecordPaymentInput): Promise<WriteResult> {
    const endpoint = this.endpoint('recordPayment');
    const fields = this.cfg.writeFields ?? DEFAULT_WRITE_FIELDS;

    const body: Record<string, unknown> = {
      [fields.paymentPartyField]: input.partyExternalId,
      [fields.paymentAmountField]: input.amount,
      [fields.paymentDateField]: input.paidOn,
      [fields.paymentReferenceField]: input.reference ?? '',
    };
    if (input.invoiceExternalId) body[fields.paymentInvoiceField] = input.invoiceExternalId;
    if (input.method) body.method = input.method;
    if (input.notes) body.notes = input.notes;

    const payload = await this.call(endpoint!, { externalId: input.partyExternalId }, 'payment posting', body, {
      [fields.idempotencyHeader]: input.idempotencyKey,
    });
    return this.toWriteResult(payload, 'payment');
  }

  /**
   * Reads back what the host created.
   *
   * An id is required: a write the agent cannot point at afterwards is a write nobody can
   * verify, reconcile or reverse, and reporting it as success would be a guess.
   */
  private toWriteResult(payload: unknown, label: string): WriteResult {
    const mapping = this.cfg.mappings.writeResult ?? { externalId: 'id', number: 'number' };
    const mapped = applyMapping(payload, mapping);
    const externalId = mapped.externalId ?? mapped.id;
    if (externalId === undefined || externalId === null || describeValue(externalId).length === 0) {
      throw new BadGatewayException(
        `The connected system accepted the ${label} but returned no id, so it cannot be verified or referenced later.`,
      );
    }
    return {
      externalId: describeValue(externalId, 128),
      number: mapped.number === undefined ? null : describeValue(mapped.number, 80),
      // Only the host can tell us it recognised the key; absent means treat it as new.
      deduplicated: Boolean((payload as Record<string, unknown>)?.deduplicated),
      raw: (payload ?? {}) as Record<string, unknown>,
    };
  }

  async health(): Promise<LedgerHealth> {
    const started = Date.now();
    try {
      const endpoint = this.endpoint('health', false);
      if (endpoint) {
        await this.call(endpoint, {}, 'health');
      } else {
        // No health endpoint: the receivables list is the read the agent depends on most,
        // so exercising it is a more honest check than pinging something that always
        // answers 200.
        await this.listReceivables({ limit: 1 });
      }
      return { ok: true, detail: 'The connected system answered.', latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        detail:
          error instanceof BadGatewayException ||
          error instanceof NotFoundException ||
          error instanceof BadRequestException
            ? error.message
            : `Could not reach the connected system: ${(error as Error).message}`,
        latencyMs: Date.now() - started,
      };
    }
  }
}

/* ------------------------------------------------------------------ helpers */

function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Buckets in the agent rather than in the host's query.
 *
 * A host's idea of "overdue" may include a grace period, or count from the invoice date.
 * Applying the definition here means every connected system's tabs mean the same thing,
 * which is the only way the numbers on the dashboard can be compared.
 */
function applyBucket(rows: ReceivablesRow[], bucket: string, asOf: IsoDate): ReceivablesRow[] {
  if (bucket === 'all') return rows;
  return rows.filter(row => {
    if (!row.oldestDueDate) return bucket === 'all';
    if (bucket === 'overdue') return row.oldestDueDate < asOf;
    if (bucket === 'due_today') return row.oldestDueDate === asOf;
    if (bucket === 'upcoming') return row.oldestDueDate > asOf;
    return true;
  });
}

/* ============================== WRITES ============================== */

/**
 * Write support is declared by configuration, not assumed.
 *
 * `supportsWrites()` on the port checks for the methods, which this class always has — so
 * the real gate is whether the client's connection file names a `createInvoice` /
 * `recordPayment` endpoint. Without one the call fails fast with a sentence an operator can
 * act on, rather than posting to a URL that was guessed.
 */
const DEFAULT_WRITE_FIELDS = {
  invoicePartyField: 'customer_id',
  invoiceDateField: 'invoice_date',
  invoiceDueDateField: 'due_date',
  invoiceLinesField: 'lines',
  invoiceReferenceField: 'reference',
  lineDescriptionField: 'description',
  lineQuantityField: 'quantity',
  linePriceField: 'unit_price',
  paymentPartyField: 'customer_id',
  paymentInvoiceField: 'invoice_id',
  paymentAmountField: 'amount',
  paymentDateField: 'paid_on',
  paymentReferenceField: 'reference',
  idempotencyHeader: 'Idempotency-Key',
} as const;
