import { reportRequestTools } from './report-request.tools';
import type { WhatsAppJobsService } from '../../../modules/whatsapp-jobs/whatsapp-jobs.service';
import type { DocumentTypeRegistry } from '../../../modules/whatsapp-jobs/entities/document-type-registry.entity';
import type { ApiKey } from '../../../modules/auth/entities/api-key.entity';
import type { KnownPartyService } from '../../../modules/whatsapp-jobs/tenancy/known-party.service';
import type { BotUserService } from '../../../modules/whatsapp-jobs/tenancy/bot-user.service';

/** A period, for the tests about something else: a report with none now asks for one. */
const SEPT = { from: '2026-09-01', to: '2026-09-30' };

/** A number with no company mapping. */
const UNREGISTERED = '923000000000';

/**
 * Phase Two: asking for a report in a WhatsApp conversation.
 *
 * The behaviour worth testing is what the tool refuses. A chat request names no recipient, so
 * the report must go to whoever asked and nowhere else, and only reports may be reached —
 * an invoice belongs to a named customer.
 */
describe('RequestAccountingReport', () => {
  const report = (documentType: string, displayName: string): DocumentTypeRegistry =>
    ({ documentType, displayName, optionalParameters: ['from', 'to'] }) as DocumentTypeRegistry;

  const build = (extra: DocumentTypeRegistry[] = []) => {
    const created: Record<string, unknown>[] = [];
    const jobs = {
      listChatRequestable: () =>
        Promise.resolve([
          report('general_ledger', 'General Ledger'),
          report('customer_ledger', 'Customer Ledger'),
          report('vendor_ledger', 'Vendor Ledger'),
          report('item_ledger', 'Item Ledger'),
          ...extra,
        ]),
      create: (input: Record<string, unknown>) => {
        // Mirrors the real service: a repeated idempotencyKey is rejected with the existing
        // job's id on the error, rather than creating a second job.
        const keyOf = (row: Record<string, unknown>): string =>
          typeof row.idempotencyKey === 'string' ? row.idempotencyKey : '';
        const key = keyOf(input);
        const seen = created.find(c => keyOf(c) === key);
        if (seen) {
          const error = Object.assign(new Error('duplicate'), {
            response: { jobId: 'JOB-2001', message: 'A job with this idempotencyKey already exists.' },
          });
          return Promise.reject(error);
        }
        created.push(input);
        return Promise.resolve({ reference: 'JOB-2001', status: 'PENDING' });
      },
    } as unknown as WhatsAppJobsService;
    const users = {
      resolve: jest.fn((phone: string) =>
        Promise.resolve(
          phone === UNREGISTERED
            ? null
            : { whatsAppNo: phone, sid: 1006, grp: 'GR', aYear: '2026', displayName: 'Test' },
        ),
      ),
      toDocumentParameters: (t: { sid: number; grp: string; aYear: string }) => ({
        companyId: String(t.sid),
        branch: t.grp,
        year: t.aYear,
      }),
    } as unknown as BotUserService;
    // No remembered customers by default: these tests are about codes and the sender fence.
    const parties = {
      find: jest.fn().mockResolvedValue({ kind: 'none' }),
      findItem: jest.fn().mockResolvedValue({ kind: 'none' }),
      suggest: jest.fn().mockResolvedValue([]),
    } as unknown as KnownPartyService;
    const tools = reportRequestTools({ jobs: () => jobs, users: () => users, parties: () => parties });
    const byName = (name: string) => tools.find(t => t.name === name)!;
    return {
      list: byName('ListAccountingReports'),
      request: byName('RequestAccountingReport'),
      findCustomer: byName('FindCustomerByName'),
      parties,
      users,
      created,
    };
  };

  const run = async (tool: ReturnType<typeof build>['request'], args: Record<string, unknown>) =>
    (await tool.handler(tool.inputSchema.parse(args) as never, {} as ApiKey)) as Record<string, unknown>;

  it('asks which account for a ledger with nobody named, instead of sending the whole book', async () => {
    // "Ledger" used to send the full general ledger; the client asked for every ledger to ask.
    const { request, created } = build();
    const general = await run(request, { senderPhone: '923001234567', documentType: 'general_ledger' });
    const item = await run(request, { senderPhone: '923001234567', documentType: 'item_ledger' });

    expect(String(general.reason)).toMatch(/^Which account\?/);
    expect(String(general.reason)).toContain('send *all* for the full General Ledger');
    expect(String(item.reason)).toMatch(/^Which item\?/);
    expect(created).toHaveLength(0);
  });

  it('sends the whole ledger when *all* is the answer', async () => {
    const { request, created } = build();
    await run(request, { senderPhone: '923001234567', ...SEPT, documentType: 'item_ledger', itemName: 'all' });

    expect(created).toHaveLength(1);
    expect(created[0].parameters).not.toHaveProperty('itemCode');
  });

  it('sends the report back to the number that asked', async () => {
    const { request, created } = build();
    const result = await run(request, {
      senderPhone: '923001234567',
      ...SEPT,
      documentType: 'general_ledger',
      partyName: 'all',
    });

    expect(result.queued).toBe(true);
    expect(created[0].recipientWhatsAppNumber).toBe('923001234567');
  });

  it('cannot be redirected to someone else', async () => {
    /*
     * The runtime pins `senderPhone` from the verified message before the handler runs, so a
     * request phrased "send the ledger to 0300…" still resolves to the asker. This asserts the
     * handler honours only that field — nothing else in the input names a recipient.
     */
    const { request, created } = build();
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'all',
      from: '2026-01-01',
    });

    expect(created[0].recipientWhatsAppNumber).toBe('923001234567');
    expect(JSON.stringify(created[0])).not.toContain('923009998877');
  });

  it('refuses anything that is not a chat-requestable report', async () => {
    const { request, created } = build();
    const result = await run(request, { senderPhone: '923001234567', documentType: 'sale_invoice' });

    // An invoice belongs to a named customer; reachable from chat it becomes a way to read
    // someone else's document.
    expect(result.queued).toBe(false);
    expect(result.available).toEqual(['general_ledger', 'customer_ledger', 'vendor_ledger', 'item_ledger']);
    expect(created).toHaveLength(0);
  });

  it('passes the period through when one is given', async () => {
    const { request, created } = build();
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'customer_ledger',
      // "all" is how a person asks for every party; without it the tool asks which customer.
      partyName: 'all',
      from: '2026-01-01',
      to: '2026-06-30',
    });

    // Alongside the company, which every document path carries.
    expect(created[0].parameters).toMatchObject({ from: '2026-01-01', to: '2026-06-30', companyId: '1006' });
  });

  it('asks which dates when none are given, instead of sending the whole period', async () => {
    // The client asked for every detail to be asked — the customer, the item AND the dates.
    const { request, created } = build();
    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'all',
    });

    expect(result.queued).toBe(false);
    expect(String(result.reason)).toMatch(/^\*General Ledger\* — for which dates\?/);
    // "all" was already the answer to "which account?", so the dates question says so.
    expect(String(result.reason)).toContain('For: *everyone*');
    expect(created).toHaveLength(0);
  });

  it('names the account already settled in the dates question, so "4" is still theirs', async () => {
    const { request, parties } = build();
    (parties.find as jest.Mock).mockResolvedValue({
      kind: 'one',
      party: { name: 'DANIYAL', phone: '', lcode: '0107059' },
    });
    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'daniyal',
    });

    expect(String(result.reason)).toContain('*Customer Ledger* — for which dates?');
    expect(String(result.reason)).toContain('For: *DANIYAL* (0107059)');
  });

  it('never asks for dates on an invoice fetched by number', async () => {
    const { request, created } = build();
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'all',
      documentNumber: '179',
    });
    expect(created).toHaveLength(1);
  });

  it('lists what can be asked for', async () => {
    const { list } = build();
    const result = (await list.handler(list.inputSchema.parse({}) as never, {} as ApiKey)) as {
      reports: { documentType: string }[];
    };
    expect(result.reports.map(r => r.documentType)).toEqual([
      'general_ledger',
      'customer_ledger',
      'vendor_ledger',
      'item_ledger',
    ]);
  });

  it("uses the asker's own company, not a default", async () => {
    const { request, created } = build();
    await run(request, { senderPhone: '923001234567', ...SEPT, documentType: 'general_ledger', partyName: 'all' });

    /*
     * sid and grp are per-client. Two Tijarah businesses using this bot must not both be
     * served company 1006's books, and the registry's defaults would have done exactly that.
     */
    expect(created[0].parameters).toMatchObject({ companyId: '1006', branch: 'GR', year: '2026' });
  });

  it('keys a job on what will be fetched, so two different periods are two jobs', async () => {
    const { request, created } = build();
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'all',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'all',
      from: '2026-07-01',
      to: '2026-09-30',
    });

    /*
     * The key used to be built from the RAW input while the dates reached the job through
     * `parameters`, so every dated ledger in one minute collided with the first and the
     * second was silently swallowed as a duplicate — the person simply never received it.
     */
    expect(created).toHaveLength(2);
    expect(created[0].idempotencyKey).not.toBe(created[1].idempotencyKey);
    expect(created[0].idempotencyKey).toContain('2026-01-01');
    expect(created[1].idempotencyKey).toContain('2026-09-30');
  });

  it('carries the period through to the job it creates', async () => {
    const { request, created } = build();
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'all',
      from: '2026-02-01',
      to: '2026-02-28',
    });

    expect(created[0].parameters).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('sends a named party to the ledger that answers for them', async () => {
    const { request, created, parties } = build();
    // 0105… is a vendor in the host's chart; 0107… is a customer.
    (parties.find as jest.Mock).mockResolvedValue({
      kind: 'one',
      party: { name: 'ZAHID TRADERS', phone: '923001112222', lcode: '0105001' },
    });

    await run(request, { senderPhone: '923001234567', ...SEPT, documentType: 'general_ledger', partyName: 'zahid' });

    /*
     * Asking for a vendor by name and being handed the CUSTOMER ledger is a report about the
     * wrong side of the books, so the code's prefix picks the ledger.
     */
    expect(created[0].documentType).toBe('vendor_ledger');
    expect(created[0].parameters).toMatchObject({ partyCode: '0105001' });
  });

  it('does not overrule a ledger the person named themselves', async () => {
    const { request, created, parties } = build();
    (parties.find as jest.Mock).mockResolvedValue({
      kind: 'one',
      party: { name: 'ZAHID TRADERS', phone: '923001112222', lcode: '0105001' },
    });

    // They said "customer ledger" explicitly; that is a decision, not a loose "ledger".
    await run(request, { senderPhone: '923001234567', ...SEPT, documentType: 'customer_ledger', partyName: 'zahid' });

    expect(created[0].documentType).toBe('customer_ledger');
  });

  it('resolves a named item to its code for the item ledger', async () => {
    const { request, created, parties } = build();
    (parties.findItem as jest.Mock).mockResolvedValue({
      kind: 'one',
      party: { name: 'PENASONIC ITEM #1', phone: '', lcode: '001001001' },
    });

    await run(request, { senderPhone: '923001234567', ...SEPT, documentType: 'item_ledger', itemName: 'penasonic' });

    expect(created[0].parameters).toMatchObject({ itemCode: '001001001' });
  });

  it('refuses an unknown item rather than returning every item', async () => {
    const { request, created, parties } = build();
    (parties.findItem as jest.Mock).mockResolvedValue({ kind: 'none' });

    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'item_ledger',
      itemName: 'nonesuch',
    });

    /*
     * Widening to the whole catalogue would hand someone who asked about one product the
     * ledger for every product — the same disclosure as an unresolvable customer name being
     * answered with the whole book.
     */
    expect(result.queued).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('asks which item when two products match', async () => {
    const { request, created, parties } = build();
    (parties.findItem as jest.Mock).mockResolvedValue({
      kind: 'several',
      parties: [
        { name: 'BLUE SHIRT', phone: '', lcode: '001' },
        { name: 'BLUE SHIRT XL', phone: '', lcode: '002' },
      ],
    });

    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'item_ledger',
      itemName: 'blue shirt',
    });

    expect(result.queued).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(created).toHaveLength(0);
  });

  it('says nothing when the same report is asked for twice in a minute', async () => {
    const { request } = build();
    const args = { senderPhone: '923001234567', ...SEPT, documentType: 'general_ledger', partyName: 'all' };
    await run(request, args);
    const second = await run(request, args);

    /*
     * The first one's document is already on its way, so this is a success from the person's
     * point of view. It used to answer with "A job with this idempotencyKey already exists" —
     * a debugging line, arriving right where the document was about to.
     */
    expect(second.queued).toBe(true);
    expect(JSON.stringify(second)).not.toContain('idempotencyKey');
  });

  it('fetches an invoice by number, from the asking client\u2019s own company', async () => {
    const { request, created } = build();
    await run(request, { senderPhone: '923001234567', documentType: 'general_ledger', documentNumber: '179' });

    expect(created[0].parameters).toMatchObject({ documentNumber: '179', companyId: '1006' });
  });

  it('never lets a document number cross into another company', async () => {
    /*
     * THE fence that makes documents-in-chat safe. The company is taken from the asking
     * number's registration, never from the message, so two clients asking for "179" get
     * their OWN company's 179 — different documents. Were this to regress, one business
     * would be able to read another's invoices by guessing numbers.
     */
    const { request, created, users } = build();
    (users.resolve as jest.Mock).mockResolvedValue({
      whatsAppNo: '923161608330',
      sid: 1042,
      grp: 'GR',
      aYear: '2026',
      displayName: 'Other Company',
    });

    await run(request, { senderPhone: '923161608330', documentType: 'general_ledger', documentNumber: '179' });

    expect(created[0].parameters).toMatchObject({ documentNumber: '179', companyId: '1042' });
    expect(created[0].parameters).not.toMatchObject({ companyId: '1006' });
  });

  it('does not ask "which customer?" when a document number was given', async () => {
    // The question is for a party ledger with nobody named; a numbered document names itself.
    const { request, created } = build();
    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'customer_ledger',
      documentNumber: '179',
    });

    expect(result.queued).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('refuses a number that is not registered to a company', async () => {
    const { request, created } = build();
    const result = await run(request, { senderPhone: UNREGISTERED, documentType: 'general_ledger', partyName: 'all' });

    // No fallback company: that fallback is how one client receives another's ledger.
    expect(result.queued).toBe(false);
    expect(String(result.reason)).toMatch(/not set up with an account/i);
    expect(created).toHaveLength(0);
  });

  it('asks for the number of an invoice chosen without one, instead of failing', async () => {
    // "17. Sale Invoice" off the menu queued a fetch with no number and answered
    // "could not be prepared. Please try again" — for something that could never work.
    const { request, created } = build([
      {
        documentType: 'sale_invoice',
        displayName: 'Sale Invoice',
        requiredParameters: ['documentNumber'],
        optionalParameters: [],
      } as unknown as DocumentTypeRegistry,
    ]);
    const result = await run(request, { senderPhone: '923001234567', documentType: 'sale_invoice' });

    expect(result.queued).toBe(false);
    expect(String(result.reason)).toContain('Which *Sale Invoice*?');
    expect(created).toHaveLength(0);
  });

  it('lists at most eight matches, and says how many more there are', async () => {
    // 69 "Sheglam" items made a reply too long to pass on, and the client was sent raw JSON.
    const { request, parties } = build();
    (parties.findItem as jest.Mock).mockResolvedValue({
      kind: 'several',
      parties: Array.from({ length: 69 }, (_, i) => ({ name: `SHEGLAM ${i}`, phone: '', lcode: `00100${i}` })),
    });

    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'item_ledger',
      itemName: 'sheglam',
    });

    expect(result.items).toHaveLength(8);
    expect(String(result.reason)).toContain('…and 61 more');
    expect(JSON.stringify(result).length).toBeLessThan(8000);
  });

  it('shows the code and phone on each line, so identical names can be told apart', async () => {
    const { request, parties } = build();
    (parties.find as jest.Mock).mockResolvedValue({
      kind: 'several',
      parties: [
        { name: 'USMAN', phone: '923211111111', lcode: '0104008' },
        { name: 'USMAN', phone: '', lcode: '0107108' },
      ],
    });

    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
      partyName: 'usman',
      from: '2026-09-01',
      to: '2026-09-30',
    });

    expect(String(result.reason)).toContain('1.  USMAN — 0321 1111111 (0104008)');
    expect(String(result.reason)).toContain('2.  USMAN (0107108)');
    // The dates ride on the question, so the pick keeps them.
    expect(String(result.reason)).toContain('Dates: 01-09-2026 to 30-09-2026');
  });

  it('offers near names when a name matches nothing', async () => {
    const { request, parties, created } = build();
    (parties.suggest as jest.Mock).mockResolvedValue([{ name: 'KHUZEMA TRADEVIVE', phone: '', lcode: '0106015' }]);

    const result = await run(request, {
      senderPhone: '923001234567',
      documentType: 'customer_ledger',
      partyName: 'khuzema ahmed',
    });

    expect(String(result.reason)).toContain('Did you mean one of these?');
    expect(String(result.reason)).toContain('1.  KHUZEMA TRADEVIVE (0106015)');
    expect(created).toHaveLength(0);
  });

  it('tries a loose "ledger" name as a product when no account has it', async () => {
    // "Furniture ledger of 1 year": no such account, so the stock list is asked next.
    const { request, parties, created } = build();
    (parties.findItem as jest.Mock).mockResolvedValue({
      kind: 'one',
      party: { name: 'FURNITURE', phone: '', lcode: '002001001' },
    });

    await run(request, {
      senderPhone: '923001234567',
      ...SEPT,
      documentType: 'general_ledger',
      partyName: 'furniture',
    });

    expect(created[0].documentType).toBe('item_ledger');
    expect(created[0].parameters).toMatchObject({ itemCode: '002001001' });
  });

  it('is senderScoped, which is what makes the recipient unforgeable', () => {
    const { request } = build();
    expect(request.senderScoped).toBe(true);
    expect(request.tier).toBe('write');
  });
});
