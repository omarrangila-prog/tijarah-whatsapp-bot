import { DataSource } from 'typeorm';
import { createServer, type Server } from 'node:http';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { DocumentTypeRegistry } from './entities/document-type-registry.entity';
import { WhatsAppJobsService } from './whatsapp-jobs.service';
import { TijarahQueueService, TIJARAH_SOURCE } from './tijarah-queue.service';

/**
 * Bringing work in from Tijarah Books, and telling it when the work is done.
 *
 * Run against a real HTTP server rather than a stubbed client: the contract being relied on is
 * the host's, and a mocked fetch would only ever agree with whatever this code believes.
 */
describe('Tijarah host queue', () => {
  let ds: DataSource;
  let service: WhatsAppJobsService;
  let queue: TijarahQueueService;
  let host: Server;
  let pending: unknown[];
  let marked: number[];
  let markStatus: number;

  const row = (over: Record<string, unknown> = {}) => ({
    id: 1,
    sid: 1006,
    grp: 'GR',
    ayear: '2026',
    type: 'SL',
    invoiceId: '103',
    contactName: 'ABC',
    contactNumber: '03000000000',
    fullquery: 'SL/1006/GR/2026/103',
    ...over,
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => {
      host = createServer((req, res) => {
        if (req.url?.includes('GetPendingBotInvoices')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'OK', count: pending.length, data: pending }));
          return;
        }
        if (req.url?.includes('MarkInvoiceProcessed')) {
          let body = '';
          req.on('data', chunk => (body += String(chunk)));
          req.on('end', () => {
            if (markStatus >= 400) {
              res.writeHead(markStatus, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ message: 'Invalid QueueId' }));
              return;
            }
            marked.push(Number((JSON.parse(body) as { ID: number }).ID));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: 'OK' }));
          });
          return;
        }
        res.writeHead(404).end();
      });
      host.listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(() => host.close());

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WhatsAppDocumentJob, DocumentTypeRegistry],
      synchronize: true,
    });
    await ds.initialize();

    const now = new Date();
    for (const [documentType, displayName] of [
      ['sale_invoice', 'Sale Invoice'],
      ['general_ledger', 'General Ledger'],
    ]) {
      await ds.getRepository(DocumentTypeRegistry).save({
        documentType,
        displayName,
        endpoint: '/internal/pdf/SL/{companyId}/{branch}/{year}/{documentNumber}',
        method: 'GET',
        requiredParameters: documentType === 'sale_invoice' ? ['documentNumber'] : [],
        defaultParameters: {},
        responseFormat: 'binary',
        expectedMimeType: 'application/pdf',
        filenameRule: '{documentReference}.pdf',
        enabled: true,
        maximumFileSize: 10_485_760,
        maximumAttempts: 3,
        timeoutSeconds: 30,
        targetProcessingSeconds: 20,
        targetSuccessRate: 99,
        duplicatesPrevented: 0,
        providerKind: 'http',
        createdAt: now,
        updatedAt: now,
      } as DocumentTypeRegistry);
    }

    const port = (host.address() as { port: number }).port;
    process.env.TIJARAH_QUEUE_BASE_URL = `http://127.0.0.1:${port}`;
    service = new WhatsAppJobsService(ds.getRepository(WhatsAppDocumentJob), ds.getRepository(DocumentTypeRegistry));
    queue = new TijarahQueueService(ds.getRepository(WhatsAppDocumentJob), service);
    pending = [];
    marked = [];
    markStatus = 200;
  });

  afterEach(async () => {
    await ds.destroy();
    delete process.env.TIJARAH_QUEUE_BASE_URL;
  });

  it('turns a queued row into a job, with the contact number made dialable', async () => {
    pending = [row()];
    expect(await queue.importPending()).toBe(1);

    const [job] = await service.list({ limit: 5 });
    expect(job.documentType).toBe('sale_invoice');
    // "03000000000" as stored locally becomes a number WhatsApp can actually reach.
    expect(job.recipientWhatsAppNumber).toBe('923000000000');
    expect(job.recipientName).toBe('ABC');
    expect(job.parametersJson).toMatchObject({ documentNumber: '103', companyId: '1006', branch: 'GR', year: '2026' });
    expect(job.sourceSystem).toBe(TIJARAH_SOURCE);
    expect(job.sourceRef).toBe('1');
  });

  it('does not create a second job when the host offers the same row again', async () => {
    pending = [row()];
    await queue.importPending();
    await queue.importPending();

    expect(await ds.getRepository(WhatsAppDocumentJob).count()).toBe(1);
  });

  it('treats two queue rows for the same invoice as two deliveries', async () => {
    /*
     * The host really does this — two rows for SL/1006/GR/2026/103 were waiting the first time
     * this ran. Each is a request to send it again, so keying idempotency on the invoice would
     * silently drop the second.
     */
    pending = [row({ id: 1 }), row({ id: 2 })];
    expect(await queue.importPending()).toBe(2);
    expect(await ds.getRepository(WhatsAppDocumentJob).count()).toBe(2);
  });

  it('skips a row whose document type it does not recognise', async () => {
    pending = [row({ id: 9, type: 'WHAT' })];
    expect(await queue.importPending()).toBe(0);
    // Guessing would mean sending a customer the wrong kind of document.
    expect(await ds.getRepository(WhatsAppDocumentJob).count()).toBe(0);
  });

  it('skips a row whose contact number cannot be dialled', async () => {
    pending = [row({ id: 10, contactNumber: '123' })];
    expect(await queue.importPending()).toBe(0);
  });

  it('acknowledges only what has actually been delivered', async () => {
    pending = [row({ id: 1 }), row({ id: 2 })];
    await queue.importPending();

    const jobs = await service.list({ limit: 5 });
    // One delivered, one still queued.
    await ds.getRepository(WhatsAppDocumentJob).update({ id: jobs[0].id }, { status: 'SENT', sentAt: new Date() });

    expect(await queue.acknowledgeDelivered()).toBe(1);
    expect(marked).toEqual([Number(jobs[0].sourceRef)]);
    // The undelivered one is untouched: marking it would tell the host to stop offering a
    // document nobody has received.
    expect(marked).not.toContain(Number(jobs[1].sourceRef));
  });

  it('acknowledges each delivery exactly once', async () => {
    pending = [row()];
    await queue.importPending();
    const [job] = await service.list({ limit: 5 });
    await ds.getRepository(WhatsAppDocumentJob).update({ id: job.id }, { status: 'SENT', sentAt: new Date() });

    await queue.acknowledgeDelivered();
    await queue.acknowledgeDelivered();

    expect(marked).toEqual([1]);
  });

  it('leaves a delivery unacknowledged when the host refuses, and tries again later', async () => {
    pending = [row()];
    await queue.importPending();
    const [job] = await service.list({ limit: 5 });
    await ds.getRepository(WhatsAppDocumentJob).update({ id: job.id }, { status: 'SENT', sentAt: new Date() });

    markStatus = 400;
    expect(await queue.acknowledgeDelivered()).toBe(0);
    expect((await service.findByReference(job.reference)).sourceAckAt).toBeNull();

    // The document was already delivered, so the retry is an acknowledgement, never a resend.
    markStatus = 200;
    expect(await queue.acknowledgeDelivered()).toBe(1);
    expect(marked).toEqual([1]);
  });

  it('never acknowledges a send that was only recorded', async () => {
    /*
     * Demonstration mode transmits nothing and stamps the id `mock.`. Acknowledging one would
     * tell the host the customer had the document: the row stops being offered and the invoice
     * is lost with nobody aware of it.
     */
    pending = [row()];
    await queue.importPending();
    const [job] = await service.list({ limit: 5 });
    await ds
      .getRepository(WhatsAppDocumentJob)
      .update({ id: job.id }, { status: 'SENT', sentAt: new Date(), whatsappMessageId: 'mock.abc123' });

    expect(await queue.acknowledgeDelivered()).toBe(0);
    expect(marked).toEqual([]);
    // Still unacknowledged, so a genuine send later can still be reported.
    expect((await service.findByReference(job.reference)).sourceAckAt).toBeNull();
  });

  it('acknowledges a genuine WhatsApp delivery', async () => {
    pending = [row()];
    await queue.importPending();
    const [job] = await service.list({ limit: 5 });
    await ds
      .getRepository(WhatsAppDocumentJob)
      .update({ id: job.id }, { status: 'SENT', sentAt: new Date(), whatsappMessageId: '3EB06B90A7D374D76FC0F8' });

    expect(await queue.acknowledgeDelivered()).toBe(1);
    expect(marked).toEqual([1]);
  });

  it('never marks a failed delivery as processed', async () => {
    pending = [row()];
    await queue.importPending();
    const [job] = await service.list({ limit: 5 });
    await ds.getRepository(WhatsAppDocumentJob).update({ id: job.id }, { status: 'FAILED' });

    expect(await queue.acknowledgeDelivered()).toBe(0);
    // Marking here would lose the document: the host stops offering it and nobody received it.
    expect(marked).toEqual([]);
  });

  it('omits the document number for a ledger, which has none', async () => {
    pending = [row({ id: 20, type: 'GL', invoiceId: 'L' })];
    await queue.importPending();
    const [job] = await service.list({ limit: 5 });
    expect(job.documentType).toBe('general_ledger');
    expect(job.parametersJson).not.toHaveProperty('documentNumber');
  });
});
