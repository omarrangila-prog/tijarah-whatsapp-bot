import { reportRequestTools } from './report-request.tools';
import type { WhatsAppJobsService } from '../../../modules/whatsapp-jobs/whatsapp-jobs.service';
import type { DocumentTypeRegistry } from '../../../modules/whatsapp-jobs/entities/document-type-registry.entity';
import type { ApiKey } from '../../../modules/auth/entities/api-key.entity';
import type { KnownPartyService } from '../../../modules/whatsapp-jobs/tenancy/known-party.service';
import type { BotUserService } from '../../../modules/whatsapp-jobs/tenancy/bot-user.service';

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

  const build = () => {
    const created: Record<string, unknown>[] = [];
    const jobs = {
      listChatRequestable: () =>
        Promise.resolve([
          report('general_ledger', 'General Ledger'),
          report('customer_ledger', 'Customer Ledger'),
          report('vendor_ledger', 'Vendor Ledger'),
        ]),
      create: (input: Record<string, unknown>) => {
        created.push(input);
        return Promise.resolve({ reference: 'JOB-2001', status: 'PENDING' });
      },
    } as unknown as WhatsAppJobsService;
    const users = {
      resolve: (phone: string) =>
        Promise.resolve(
          phone === UNREGISTERED
            ? null
            : { whatsAppNo: phone, sid: 1006, grp: 'GR', aYear: '2026', displayName: 'Test' },
        ),
      toDocumentParameters: (t: { sid: number; grp: string; aYear: string }) => ({
        companyId: String(t.sid),
        branch: t.grp,
        year: t.aYear,
      }),
    } as unknown as BotUserService;
    // No remembered customers by default: these tests are about codes and the sender fence.
    const parties = { find: jest.fn().mockResolvedValue({ kind: 'none' }) } as unknown as KnownPartyService;
    const tools = reportRequestTools({ jobs: () => jobs, users: () => users, parties: () => parties });
    const byName = (name: string) => tools.find(t => t.name === name)!;
    return {
      list: byName('ListAccountingReports'),
      request: byName('RequestAccountingReport'),
      findCustomer: byName('FindCustomerByName'),
      parties,
      created,
    };
  };

  const run = async (tool: ReturnType<typeof build>['request'], args: Record<string, unknown>) =>
    (await tool.handler(tool.inputSchema.parse(args) as never, {} as ApiKey)) as Record<string, unknown>;

  it('sends the report back to the number that asked', async () => {
    const { request, created } = build();
    const result = await run(request, { senderPhone: '923001234567', documentType: 'general_ledger' });

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
    await run(request, { senderPhone: '923001234567', documentType: 'general_ledger', from: '2026-01-01' });

    expect(created[0].recipientWhatsAppNumber).toBe('923001234567');
    expect(JSON.stringify(created[0])).not.toContain('923009998877');
  });

  it('refuses anything that is not a chat-requestable report', async () => {
    const { request, created } = build();
    const result = await run(request, { senderPhone: '923001234567', documentType: 'sale_invoice' });

    // An invoice belongs to a named customer; reachable from chat it becomes a way to read
    // someone else's document.
    expect(result.queued).toBe(false);
    expect(result.available).toEqual(['general_ledger', 'customer_ledger', 'vendor_ledger']);
    expect(created).toHaveLength(0);
  });

  it('passes the period through when one is given', async () => {
    const { request, created } = build();
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'customer_ledger',
      from: '2026-01-01',
      to: '2026-06-30',
    });

    // Alongside the company, which every document path carries.
    expect(created[0].parameters).toMatchObject({ from: '2026-01-01', to: '2026-06-30', companyId: '1006' });
  });

  it('omits the period entirely when none is given, which the host reads as the full range', async () => {
    const { request, created } = build();
    await run(request, { senderPhone: '923001234567', documentType: 'general_ledger' });
    // The company is always present; the period is what is omitted, and the host reads a
    // missing period as the full range.
    expect(created[0].parameters).toEqual({ companyId: '1006', branch: 'GR', year: '2026' });
  });

  it('lists what can be asked for', async () => {
    const { list } = build();
    const result = (await list.handler(list.inputSchema.parse({}) as never, {} as ApiKey)) as {
      reports: { documentType: string }[];
    };
    expect(result.reports.map(r => r.documentType)).toEqual(['general_ledger', 'customer_ledger', 'vendor_ledger']);
  });

  it("uses the asker's own company, not a default", async () => {
    const { request, created } = build();
    await run(request, { senderPhone: '923001234567', documentType: 'general_ledger' });

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
      from: '2026-01-01',
      to: '2026-01-31',
    });
    await run(request, {
      senderPhone: '923001234567',
      documentType: 'general_ledger',
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

    await run(request, { senderPhone: '923001234567', documentType: 'general_ledger', partyName: 'zahid' });

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
    await run(request, { senderPhone: '923001234567', documentType: 'customer_ledger', partyName: 'zahid' });

    expect(created[0].documentType).toBe('customer_ledger');
  });

  it('refuses a number that is not registered to a company', async () => {
    const { request, created } = build();
    const result = await run(request, { senderPhone: UNREGISTERED, documentType: 'general_ledger' });

    // No fallback company: that fallback is how one client receives another's ledger.
    expect(result.queued).toBe(false);
    expect(String(result.reason)).toMatch(/not registered/i);
    expect(created).toHaveLength(0);
  });

  it('is senderScoped, which is what makes the recipient unforgeable', () => {
    const { request } = build();
    expect(request.senderScoped).toBe(true);
    expect(request.tier).toBe('write');
  });
});
