import * as path from 'path';
import { DataSource } from 'typeorm';
import { DocumentTypeRegistry } from './entities/document-type-registry.entity';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { HttpDocumentProvider } from './providers/http-document.provider';
import { WhatsAppJobsService } from './whatsapp-jobs.service';

/** Only the fields the URL builder actually reads; the rest of the row is irrelevant here. */
const jobWith = (parametersJson: Record<string, unknown>): WhatsAppDocumentJob =>
  ({ parametersJson }) as unknown as WhatsAppDocumentJob;

/**
 * The seeded document types, checked against the client's own specification.
 *
 * The table below is transcribed from "Tijarah Bot" Phase One. It is duplicated here on
 * purpose: the migration is what runs, this is what was asked for, and a test that compares
 * them catches the case where someone adjusts an endpoint or a screen code in the migration
 * to make something work and nobody notices it no longer matches what the client specified.
 *
 * Every row is expected DISABLED. The endpoints given are browser routes in the Tijarah Books
 * single-page app — every path, including invented ones, returns the same HTML shell, and a
 * request that asks for `application/pdf` is answered 406 — so none of them can produce a
 * document yet. Enabling one before a real server-side endpoint exists would queue jobs that
 * can only fail.
 */
const PHASE_ONE = [
  { type: 'digital_invoice', name: 'Digital Invoice', code: 'DINV', scode: '0102010' },
  { type: 'sale_invoice', name: 'Sale Invoice', code: 'SL', scode: '0102003' },
  { type: 'purchase_invoice', name: 'Purchase Invoice', code: 'PR', scode: '0102001' },
  { type: 'sale_return', name: 'Sale Return', code: 'SR', scode: '0102004' },
  { type: 'purchase_return', name: 'Purchase Return', code: 'RP', scode: '0102002' },
  { type: 'payment_voucher', name: 'Payment Voucher', code: 'CV', scode: null },
  { type: 'receive_voucher', name: 'Receive Voucher', code: 'DV', scode: null },
  { type: 'general_ledger', name: 'General Ledger', code: 'GL', scode: '0101001' },
  // The specification's "Endpoint 2/3/4" beside the ledger. They replace the GL segment rather
  // than following it — appending after `L` 404s — and each returns its own titled report.
  { type: 'customer_ledger', name: 'Customer Ledger', code: 'CUSTOMER', scode: '0101001' },
  { type: 'vendor_ledger', name: 'Vendor Ledger', code: 'VENDOR', scode: '0101001' },
  { type: 'expense_ledger', name: 'Expense Ledger', code: 'EXPENSE', scode: '0101001' },
] as const;

describe('Tijarah Books Phase One specification', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [DocumentTypeRegistry, WhatsAppDocumentJob],
      /*
       * Every migration in the directory, not a hand-written list.
       *
       * The list went stale twice — a new migration added a column, this spec did not know
       * about it, and sixteen assertions failed with "no such column" instead of saying
       * anything about the specification they exist to guard. A glob cannot fall behind.
       */
      migrations: [path.join(__dirname, '..', '..', 'database', 'migrations', '*.ts')],
    });
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  const load = (type: string) =>
    ds.getRepository(DocumentTypeRegistry).findOneOrFail({ where: { documentType: type } });

  it('seeds every Phase One document type from the specification', async () => {
    const rows = await ds.getRepository(DocumentTypeRegistry).find();
    const seeded = rows.map(r => r.documentType);
    // Present, not exclusive: Phase Two adds report types to the same table.
    for (const entry of PHASE_ONE) expect(seeded).toContain(entry.type);
  });

  /**
   * Phase Two's report views, from the client's second specification.
   *
   * Two things differ from Phase One and both are easy to get wrong, so both are asserted:
   * the prefix is `/report/pdf/` rather than `/internal/pdf/` (only the ledgers stayed), and
   * the final path segment is a per-report flag the host expects — `Y` for Trial Balance and
   * Stock Summary, `0` for the rest — not a document number.
   */
  const PHASE_TWO = [
    { type: 'trial_balance', code: 'TB', tail: 'Y' },
    { type: 'item_ledger', code: 'IL', tail: '0' },
    { type: 'stock_summary', code: 'SS', tail: 'Y' },
    { type: 'income_statement', code: 'IS', tail: '0' },
    { type: 'balance_sheet', code: 'BS', tail: '0' },
    { type: 'cash_bank_book', code: 'CB', tail: '0' },
    // The four reports behind the host's SP code, each verified to return its own titled PDF.
    { type: 'sales_book_report', code: 'SP', tail: 'SL' },
    { type: 'sale_return_report', code: 'SP', tail: 'SR' },
    { type: 'purchase_book_report', code: 'SP', tail: 'PR' },
    { type: 'purchase_return_report', code: 'SP', tail: 'RP' },
  ] as const;

  it.each(PHASE_TWO)('$type is live on the report endpoint the client specified', async entry => {
    const row = await load(entry.type);

    expect(row.enabled).toBe(true);
    expect(row.chatRequestable).toBe(true);
    expect(row.endpoint).toContain(`/report/pdf/${entry.code}/`);
    // Never the Phase One prefix: a report placed there returns nothing useful.
    expect(row.endpoint).not.toContain('/internal/pdf/');
    expect(row.endpoint).not.toContain('TODO://');
  });

  it.each(PHASE_TWO)('$type builds the exact URL, including its final flag', async entry => {
    const provider = new HttpDocumentProvider('https://api.tijarabooks.com');
    const url = provider.buildRequest(jobWith({ from: '2026-01-01', to: '2026-12-31' }), await load(entry.type)).url;

    expect(url).toBe(
      `https://api.tijarabooks.com/report/pdf/${entry.code}/1006/GR/2026/${entry.tail}` +
        '?from=2026-01-01&to=2026-12-31',
    );
  });

  it('retired the combined sale-and-purchase placeholder in favour of the four real reports', async () => {
    const rows = await ds.getRepository(DocumentTypeRegistry).find();
    // A type nobody can use is a question for whoever reads the registry next.
    expect(rows.map(r => r.documentType)).not.toContain('sale_purchase_report');
  });

  it('refuses a job for a type whose endpoint is still the sentinel, even if enabled', async () => {
    const repo = ds.getRepository(DocumentTypeRegistry);
    const now = new Date();
    await repo.save({
      documentType: 'not_yet_supplied',
      displayName: 'Not Yet Supplied',
      endpoint: 'TODO://endpoint-not-yet-supplied',
      method: 'GET',
      providerKind: 'http',
      responseFormat: 'binary',
      expectedMimeType: 'application/pdf',
      filenameRule: '{documentReference}.pdf',
      enabled: true,
      chatRequestable: false,
      maximumFileSize: 10_485_760,
      maximumAttempts: 3,
      timeoutSeconds: 30,
      targetProcessingSeconds: 20,
      targetSuccessRate: 99,
      duplicatesPrevented: 0,
      createdAt: now,
      updatedAt: now,
    } as DocumentTypeRegistry);

    const service = new WhatsAppJobsService(ds.getRepository(WhatsAppDocumentJob), repo);
    await expect(
      service.create({
        source: 'api',
        documentType: 'not_yet_supplied',
        recipientWhatsAppNumber: '923001234567',
        idempotencyKey: 'sentinel-guard-1',
      }),
    ).rejects.toThrow(/no endpoint configured/i);

    await repo.delete({ documentType: 'not_yet_supplied' });
  });

  it.each(PHASE_ONE)('$type points at the endpoint the client specified', async entry => {
    const row = await load(entry.type);

    expect(row.displayName).toBe(entry.name);
    expect(row.endpoint).toContain(`/internal/pdf/${entry.code}/`);
    if (entry.scode) expect(row.endpoint).toContain(`scode=${entry.scode}`);
    else expect(row.endpoint).not.toContain('scode=');

    // The parts that belong to the integration rather than to a request.
    expect(row.defaultParameters).toMatchObject({ companyId: '1006', branch: 'GR', year: '2026' });
    expect(row.expectedMimeType).toBe('application/pdf');

    /*
     * Fetched over HTTP from api.tijarabooks.com, which serves real PDFs. The dashboard host in
     * the original specification did not — the same paths there are single-page-app routes.
     * No credential: the host serves these openly, so naming an auth profile would send someone
     * hunting for a token that does not exist.
     */
    expect(row.providerKind).toBe('http');
    expect(row.authProfile).toBeNull();

    // Live: every one of these was verified returning a valid PDF from the API host.
    expect(row.enabled).toBe(true);

    /*
     * Every Tijarah type may be asked for in a WhatsApp conversation (8 October 2026).
     *
     * This used to be ledgers only, on the reasoning that an invoice belongs to a named
     * customer and chat access would let anyone on the allowlist read someone else's. That
     * reasoning assumed the allowlist might hold END CUSTOMERS. It holds BUSINESSES: every
     * registered number is a company asking about its own books.
     *
     * What makes it safe is the fence enforced on every request — `companyId` and `branch`
     * come from the asking number's own registration, never from the message — so a client
     * of company 1042 builds `/internal/pdf/SL/1042/...` and cannot address 1006's
     * documents. Verified end to end: two clients asking for "sale invoice 179" received
     * their own companies' invoice 179, which are different documents.
     *
     * The assumption, not the mechanism, is what to re-check: registering an end customer
     * would let them read that client's other invoices by guessing numbers.
     */
    expect(row.chatRequestable).toBe(true);
  });

  it('builds the exact URL the specification shows, for a document', async () => {
    const config = await load('sale_invoice');
    const provider = new HttpDocumentProvider('https://api.tijarabooks.com');
    const job = jobWith({ documentNumber: '1' });

    const request = provider.buildRequest(job, config);
    expect(request.url).toBe('https://api.tijarabooks.com/internal/pdf/SL/1006/GR/2026/1?scode=0102003');
  });

  it('gives each ledger its own document type, replacing the GL segment', async () => {
    const provider = new HttpDocumentProvider('https://api.tijarabooks.com');
    const job = jobWith({ from: '2026-01-01', to: '2026-12-31' });

    for (const [type, code] of [
      ['general_ledger', 'GL'],
      ['customer_ledger', 'CUSTOMER'],
      ['vendor_ledger', 'VENDOR'],
      ['expense_ledger', 'EXPENSE'],
    ] as const) {
      const url = provider.buildRequest(job, await load(type)).url;
      expect(url).toContain(`/internal/pdf/${code}/1006/GR/2026/L?`);
    }
  });

  it('builds the general ledger URL, with the date range the specification shows', async () => {
    const config = await load('general_ledger');
    const provider = new HttpDocumentProvider('https://api.tijarabooks.com');
    const job = jobWith({ from: '2026-01-01', to: '2026-12-31' });

    const request = provider.buildRequest(job, config);
    expect(request.url).toBe(
      'https://api.tijarabooks.com/internal/pdf/GL/1006/GR/2026/L?scode=0101001&from=2026-01-01&to=2026-12-31&lot=ALL',
    );
  });

  it('needs only the document number from a caller', async () => {
    const config = await load('purchase_invoice');
    expect(config.requiredParameters).toEqual(['documentNumber']);
    // Everything else in the path is configuration, so a job payload stays small.
    expect(Object.keys(config.defaultParameters ?? {})).toEqual(
      expect.arrayContaining(['companyId', 'branch', 'year']),
    );
  });
});
