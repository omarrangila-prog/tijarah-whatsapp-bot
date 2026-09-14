import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { DocumentTypeRegistry } from './entities/document-type-registry.entity';
import { WhatsAppJobsService } from './whatsapp-jobs.service';
import { JobWorkerService } from './job-worker.service';
import { JobKpiService } from './kpi.service';
import { MockDeliveryProvider, normalizeWhatsAppNumber } from './providers/whatsapp-delivery.provider';
import { MockWhatsAppProvider } from '../../integrations/whatsapp/mock.provider';
import { HttpDocumentProvider } from './providers/http-document.provider';
import { looksLikeHtml, looksLikeMimeType } from './providers/document-provider';
import { buildSamplePdf } from './providers/sample-pdf';
import { backoffMs, isRetryable } from './job-status';
import { getJobMetrics, resetJobMetrics } from './job-metrics';
import { resolveAuthProfile, redactHeaders } from './providers/auth-profiles';
import { createServer, type Server } from 'node:http';

const PDF = buildSamplePdf({ title: 'INV-1001', lines: ['Ali Traders'] });

/**
 * A stand-in document API, run for real over HTTP.
 *
 * The provider's job is to survive what a real API does, so the tests point it at an actual
 * socket rather than a stubbed fetch. A mocked HTTP client would agree with whatever the
 * provider believes, which is precisely the thing under test.
 */
function startApi(
  handler: (url: string, res: import('node:http').ServerResponse) => void,
): Promise<{ server: Server; base: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => handler(req.url ?? '', res));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe('WhatsApp document delivery — Phase 1', () => {
  let ds: DataSource;
  let service: WhatsAppJobsService;
  let worker: JobWorkerService;
  let transport: MockWhatsAppProvider;
  let api: { server: Server; base: string };
  let apiBehaviour: (url: string, res: import('node:http').ServerResponse) => void;

  const REGISTRY = {
    documentType: 'invoice',
    displayName: 'Sales Invoice',
    endpoint: '/invoices/{invoiceId}/pdf',
    method: 'GET',
    requiredParameters: ['invoiceId'],
    responseFormat: 'binary',
    expectedMimeType: 'application/pdf',
    filenameRule: '{documentReference}.pdf',
    maximumFileSize: 10_485_760,
    enabled: true,
    targetProcessingSeconds: 20,
    targetSuccessRate: 99,
    maximumAttempts: 3,
    timeoutSeconds: 5,
    duplicatesPrevented: 0,
  };

  const validJob = (overrides: Record<string, unknown> = {}) => ({
    source: 'software',
    requestedByUserId: 'USER-001',
    documentType: 'invoice',
    documentName: 'INV-1001.pdf',
    documentReference: 'INV-1001',
    clientId: 'CLIENT-001',
    partyId: 'PARTY-ALI',
    recipientName: 'Ali Accounts',
    recipientWhatsAppNumber: '+923001234567',
    messageText: 'Please find your requested invoice attached.',
    parameters: { invoiceId: 'INV-1001', companyId: 'COMPANY-001' },
    idempotencyKey: `invoice-INV-1001-923001234567-${Math.random()}`,
    ...overrides,
  });

  beforeAll(async () => {
    apiBehaviour = (url, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF);
    };
    api = await startApi((url, res) => apiBehaviour(url, res));
  });

  afterAll(() => {
    api.server.close();
  });

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WhatsAppDocumentJob, DocumentTypeRegistry],
      synchronize: true,
    });
    await ds.initialize();

    const now = new Date();
    await ds
      .getRepository(DocumentTypeRegistry)
      .save({ ...REGISTRY, createdAt: now, updatedAt: now } as DocumentTypeRegistry);

    service = new WhatsAppJobsService(ds.getRepository(WhatsAppDocumentJob), ds.getRepository(DocumentTypeRegistry));
    transport = new MockWhatsAppProvider();
    process.env.DOCUMENT_API_BASE_URL = api.base;
    process.env.JOB_PROCESSING_LEASE_SECONDS = '120';
    worker = new JobWorkerService(
      ds.getRepository(WhatsAppDocumentJob),
      ds.getRepository(DocumentTypeRegistry),
      new MockDeliveryProvider(transport),
    );
    apiBehaviour = (url, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF);
    };
    // The counters live for the life of the process, so a test asserting on them has to start
    // from a known zero rather than from whatever the previous tests left behind.
    resetJobMetrics();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /* ------------------------------------------------------------ creation */

  it('creates a valid job in PENDING', async () => {
    const job = await service.create(validJob());
    expect(job.reference).toMatch(/^JOB-\d+$/);
    expect(job.status).toBe('PENDING');
    // Stored in the one comparison form: digits only, no punctuation.
    expect(job.recipientWhatsAppNumber).toBe('923001234567');
  });

  it('writes a caption when the caller supplies none', async () => {
    /*
     * The gap this closes: a job created through the API or the dashboard button went out as
     * a bare PDF with no word about what it was.
     */
    const job = await service.create(validJob({ messageText: undefined, recipientName: 'Ali Traders' }));

    expect(job.messageText).toBeTruthy();
    expect(job.messageText).toContain('Dear Ali Traders,');
    expect(job.messageText).not.toContain('undefined');
    expect(job.messageText).not.toMatch(/\{|\}/);
  });

  it('leaves a caption the caller wrote exactly as written', async () => {
    const job = await service.create(validJob({ messageText: 'Attached as discussed.' }));
    expect(job.messageText).toBe('Attached as discussed.');
  });

  it('refuses a job whose document type needs a parameter it was not given', async () => {
    await expect(service.create(validJob({ parameters: { companyId: 'C1' } }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an unusable recipient number', async () => {
    await expect(service.create(validJob({ recipientWhatsAppNumber: '12' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an unsupported document type', async () => {
    await expect(service.create(validJob({ documentType: 'hovercraft' }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a disabled document type', async () => {
    await ds.getRepository(DocumentTypeRegistry).update({ documentType: 'invoice' }, { enabled: false });
    await expect(service.create(validJob())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('turns a duplicate idempotency key away and counts it', async () => {
    const key = 'invoice-INV-1001-923001234567';
    const first = await service.create(validJob({ idempotencyKey: key }));
    await expect(service.create(validJob({ idempotencyKey: key }))).rejects.toBeInstanceOf(ConflictException);

    // One job, not two — the whole point of the key.
    expect(await ds.getRepository(WhatsAppDocumentJob).count()).toBe(1);
    const type = await ds.getRepository(DocumentTypeRegistry).findOneOrFail({ where: { documentType: 'invoice' } });
    expect(type.duplicatesPrevented).toBe(1);
    expect(first.reference).toBe('JOB-1001');
  });

  /* -------------------------------------------------------------- worker */

  it('claims a job, fetches the document and sends it end to end', async () => {
    await service.create(validJob());
    const claimed = await worker.claimBatch(10);
    expect(claimed).toHaveLength(1);

    await worker.process(claimed[0]);

    const job = await service.findByReference(claimed[0].reference);
    expect(job.status).toBe('SENT');
    expect(job.whatsappMessageId).toMatch(/^mock\./);
    expect(job.documentMimeType).toBe('application/pdf');
    expect(job.documentSize).toBe(PDF.length);
    expect(job.documentName).toBe('INV-1001.pdf');
    // The document really reached the transport, and as a PDF.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].fileName).toBe('INV-1001.pdf');
    // Every stage recorded, in order.
    expect((job.timeline ?? []).map(t => t.status)).toEqual([
      'PENDING',
      'PROCESSING',
      'FETCHING_DOCUMENT',
      'DOCUMENT_RECEIVED',
      'SENDING_TO_WHATSAPP',
      'SENT',
    ]);
  });

  it('never lets two workers claim the same job', async () => {
    await service.create(validJob());
    const second = new JobWorkerService(
      ds.getRepository(WhatsAppDocumentJob),
      ds.getRepository(DocumentTypeRegistry),
      new MockDeliveryProvider(new MockWhatsAppProvider()),
    );

    const [a, b] = await Promise.all([worker.claimBatch(10), second.claimBatch(10)]);
    // One winner. The loser's conditional UPDATE matched nothing.
    expect(a.length + b.length).toBe(1);
  });

  it('recovers a job whose worker died holding the lease', async () => {
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    // Simulate the crash: the lease is in the past and nobody is coming back for it.
    await ds
      .getRepository(WhatsAppDocumentJob)
      .update(
        { id: claimed.id },
        { status: 'FETCHING_DOCUMENT', processingLeaseExpiresAt: new Date(Date.now() - 60_000) },
      );

    expect(await worker.recoverExpiredLeases()).toBe(1);
    expect((await service.findByReference(claimed.reference)).status).toBe('PENDING');
  });

  it('never recovers, retries or cancels a job that was already sent', async () => {
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);

    // An expired lease on a SENT row must not put the document back in the queue.
    await ds
      .getRepository(WhatsAppDocumentJob)
      .update({ id: claimed.id }, { processingLeaseExpiresAt: new Date(Date.now() - 60_000) });
    expect(await worker.recoverExpiredLeases()).toBe(0);
    expect((await service.findByReference(claimed.reference)).status).toBe('SENT');

    await expect(service.retry(claimed.reference)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.cancel(claimed.reference)).rejects.toBeInstanceOf(ConflictException);
    expect(transport.sent).toHaveLength(1);
  });

  it('schedules a retry for a failure that might pass next time', async () => {
    apiBehaviour = (_url, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('upstream unavailable');
    };
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);

    const job = await service.findByReference(claimed.reference);
    expect(job.status).toBe('RETRY_SCHEDULED');
    expect(job.errorCode).toBe('DOCUMENT_API_ERROR');
    expect(job.nextRetryAt).toBeTruthy();
    expect(transport.sent).toHaveLength(0);
  });

  it('fails permanently, without retrying, when the document does not exist', async () => {
    apiBehaviour = (_url, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such invoice');
    };
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);

    const job = await service.findByReference(claimed.reference);
    expect(job.status).toBe('FAILED');
    expect(job.errorCode).toBe('DOCUMENT_NOT_FOUND');
    expect(job.nextRetryAt).toBeNull();
  });

  it('refuses to send an HTML error page as a PDF', async () => {
    // The failure this guard exists for: 200 OK, content-type says PDF, body is an error page.
    apiBehaviour = (_url, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('<!doctype html><html><body>502 Bad Gateway</body></html>');
    };
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);

    const job = await service.findByReference(claimed.reference);
    expect(job.errorCode).toBe('INVALID_DOCUMENT_RESPONSE');
    expect(job.errorMessage).toMatch(/HTML/i);
    expect(transport.sent).toHaveLength(0);
  });

  it('parks a job while WhatsApp is down, without spending an attempt', async () => {
    /*
     * The scenario this exists for: the number is offline for longer than the backoff
     * schedule. Every queued document used to burn its three attempts waiting and end up
     * FAILED — deliverable documents, marked undeliverable, for a reason that had nothing to
     * do with them.
     */
    let connected = false;
    let fetched = false;
    apiBehaviour = (_url, res) => {
      fetched = true;
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF);
    };
    const flaky = new JobWorkerService(ds.getRepository(WhatsAppDocumentJob), ds.getRepository(DocumentTypeRegistry), {
      id: 'flaky',
      connect: () => Promise.resolve('CONNECTED' as const),
      getQRCode: () => Promise.resolve(null),
      getConnectionStatus: () => Promise.resolve(connected ? ('CONNECTED' as const) : ('DISCONNECTED' as const)),
      validateNumber: () => Promise.resolve({ exists: true, chatId: null }),
      sendText: () => Promise.reject(new Error('offline')),
      sendDocument: (_s, input) => Promise.resolve({ messageId: `mock.${input.filename}`, mock: true }),
      getMessageStatus: () => Promise.resolve(null),
      getConnectedNumber: () => Promise.resolve('923470000000'),
      reconnect: () => Promise.resolve('CONNECTED' as const),
      logout: () => Promise.resolve(),
    });

    const created = await service.create(validJob());
    // Five passes while the number is offline — more than the three-attempt budget.
    for (let i = 0; i < 5; i += 1) {
      await ds.getRepository(WhatsAppDocumentJob).update({ id: created.id }, { status: 'PENDING', nextRetryAt: null });
      const [claimed] = await flaky.claimBatch(1);
      if (claimed) await flaky.process(claimed);
    }

    const parked = await service.findByReference(created.reference);
    expect(parked.status).toBe('RETRY_SCHEDULED');
    expect(parked.errorCode).toBe('WHATSAPP_DISCONNECTED');
    // Not a single attempt consumed, and no document fetched for a send that could not happen.
    expect(parked.attemptCount).toBe(0);
    expect(fetched).toBe(false);

    // The number comes back; the job goes out on its first real attempt.
    connected = true;
    await ds.getRepository(WhatsAppDocumentJob).update({ id: created.id }, { status: 'PENDING', nextRetryAt: null });
    const [resumed] = await flaky.claimBatch(1);
    await flaky.process(resumed);

    const sent = await service.findByReference(created.reference);
    expect(sent.status).toBe('SENT');
    expect(sent.attemptCount).toBe(1);
  });

  it('stops when WhatsApp is not connected, and does not lose the job', async () => {
    const offline = new JobWorkerService(
      ds.getRepository(WhatsAppDocumentJob),
      ds.getRepository(DocumentTypeRegistry),
      {
        id: 'offline',
        connect: () => Promise.resolve('DISCONNECTED' as const),
        getQRCode: () => Promise.resolve(null),
        getConnectionStatus: () => Promise.resolve('DISCONNECTED' as const),
        validateNumber: () => Promise.resolve({ exists: true, chatId: null }),
        sendText: () => Promise.reject(new Error('not connected')),
        sendDocument: () => Promise.reject(new Error('not connected')),
        getMessageStatus: () => Promise.resolve(null),
        getConnectedNumber: () => Promise.resolve(null),
        reconnect: () => Promise.resolve('DISCONNECTED' as const),
        logout: () => Promise.resolve(),
      },
    );
    await service.create(validJob());
    const [claimed] = await offline.claimBatch(1);
    await offline.process(claimed);

    const job = await service.findByReference(claimed.reference);
    expect(job.errorCode).toBe('WHATSAPP_DISCONNECTED');
    // Retryable: the number will very likely be back.
    expect(job.status).toBe('RETRY_SCHEDULED');
  });

  it('refuses a number that is not on WhatsApp before fetching the document', async () => {
    let documentFetched = false;
    apiBehaviour = (_url, res) => {
      documentFetched = true;
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF);
    };
    const strict = new JobWorkerService(ds.getRepository(WhatsAppDocumentJob), ds.getRepository(DocumentTypeRegistry), {
      id: 'strict',
      connect: () => Promise.resolve('CONNECTED' as const),
      getQRCode: () => Promise.resolve(null),
      getConnectionStatus: () => Promise.resolve('CONNECTED' as const),
      validateNumber: () => Promise.resolve({ exists: false, chatId: null }),
      sendText: () => Promise.reject(new Error('should not be reached')),
      sendDocument: () => Promise.reject(new Error('should not be reached')),
      getMessageStatus: () => Promise.resolve(null),
      getConnectedNumber: () => Promise.resolve('923470000000'),
      reconnect: () => Promise.resolve('CONNECTED' as const),
      logout: () => Promise.resolve(),
    });
    await service.create(validJob());
    const [claimed] = await strict.claimBatch(1);
    await strict.process(claimed);

    const job = await service.findByReference(claimed.reference);
    expect(job.errorCode).toBe('INVALID_RECIPIENT_NUMBER');
    // Permanent: a number that is not on WhatsApp will not be on WhatsApp in thirty seconds.
    expect(job.status).toBe('FAILED');
    // And the document was never generated, because the failure was knowable beforehand.
    expect(documentFetched).toBe(false);
  });

  it('cancels a job that has not been sent, and refuses to run it afterwards', async () => {
    const created = await service.create(validJob());
    await service.cancel(created.reference);
    expect(await worker.claimBatch(10)).toHaveLength(0);
  });

  it('works through a batch concurrently, so one slow document does not hold up the rest', async () => {
    let inFlight = 0;
    let peak = 0;
    apiBehaviour = (_url, res) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(PDF);
      }, 120);
    };
    for (let i = 0; i < 5; i += 1) {
      await service.create(validJob({ documentReference: `INV-${i}`, idempotencyKey: `batch-${i}` }));
    }

    const started = Date.now();
    await worker.tick();
    const elapsed = Date.now() - started;

    const sent = await service.list({ status: 'SENT', limit: 20 });
    expect(sent).toHaveLength(5);
    // More than one fetch was genuinely open at once...
    expect(peak).toBeGreaterThan(1);
    // ...and bounded: never the whole batch at once.
    expect(peak).toBeLessThanOrEqual(worker.config.concurrency);
    // Five 120ms fetches one after another would be 600ms+; three lanes should beat that.
    expect(elapsed).toBeLessThan(600);
  }, 20_000);

  it('does not write the document to storage unless retention is switched on', async () => {
    const put = jest.fn<Promise<void>, [string, Buffer]>().mockResolvedValue(undefined);
    const del = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const quiet = new JobWorkerService(
      ds.getRepository(WhatsAppDocumentJob),
      ds.getRepository(DocumentTypeRegistry),
      new MockDeliveryProvider(transport),
      { putFile: put, deleteFile: del } as never,
    );
    await service.create(validJob());
    const [claimed] = await quiet.claimBatch(1);
    await quiet.process(claimed);

    const job = await service.findByReference(claimed.reference);
    expect(job.status).toBe('SENT');
    // Nothing written, so nothing to delete — and no key pointing at a file that never existed.
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(job.documentStorageKey).toBeNull();
  });

  it('counts what happened, for the metrics endpoint', async () => {
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);

    const metrics = getJobMetrics();
    expect(metrics.claimed).toBe(1);
    expect(metrics.sent).toBe(1);
    expect(metrics.averageDocumentApiMs).not.toBeNull();
    expect(metrics.failedByCode.size).toBe(0);
  });

  /* --------------------------------------------- response shapes (§8) */

  it('accepts a document returned as base64', async () => {
    await ds.getRepository(DocumentTypeRegistry).update({ documentType: 'invoice' }, { responseFormat: 'base64' });
    apiBehaviour = (_url, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(PDF.toString('base64'));
    };
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);
    expect((await service.findByReference(claimed.reference)).status).toBe('SENT');
  });

  it('accepts a document returned as JSON carrying base64', async () => {
    await ds
      .getRepository(DocumentTypeRegistry)
      .update(
        { documentType: 'invoice' },
        { responseFormat: 'json', responseParser: { documentPath: 'data.content', filenamePath: 'data.filename' } },
      );
    apiBehaviour = (_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { filename: 'from-api.pdf', content: PDF.toString('base64') } }));
    };
    await service.create(validJob({ documentName: undefined }));
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);
    const job = await service.findByReference(claimed.reference);
    expect(job.status).toBe('SENT');
    expect(job.documentName).toBe('from-api.pdf');
  });

  it('follows a document URL the API points at', async () => {
    await ds.getRepository(DocumentTypeRegistry).update({ documentType: 'invoice' }, { responseFormat: 'url' });
    apiBehaviour = (url, res) => {
      if (url.includes('/file')) {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(PDF);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${api.base}/file`);
    };
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);
    const job = await service.findByReference(claimed.reference);
    expect(job.status).toBe('SENT');
    expect(job.documentUrl).toContain('/file');
  });

  it('times out a document API that never answers', async () => {
    await ds.getRepository(DocumentTypeRegistry).update({ documentType: 'invoice' }, { timeoutSeconds: 1 });
    apiBehaviour = () => {
      /* deliberately never responds */
    };
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);
    const job = await service.findByReference(claimed.reference);
    expect(job.errorCode).toBe('DOCUMENT_API_TIMEOUT');
  }, 15_000);

  /* ------------------------------------------------------------ units */

  it('normalises phone numbers to one comparison form', () => {
    expect(normalizeWhatsAppNumber('+92 300 1234567')).toBe('923001234567');
    expect(normalizeWhatsAppNumber('923001234567')).toBe('923001234567');
    expect(normalizeWhatsAppNumber('123')).toBeNull();
    expect(normalizeWhatsAppNumber(null)).toBeNull();
  });

  it('gives a locally-written number its country code', () => {
    /*
     * How Tijarah Books stores contacts: "03000000000". Stripping the zero alone produced
     * "3000000000" — a number with no country code — and WhatsApp would have delivered the
     * invoice to whatever that resolves to.
     */
    expect(normalizeWhatsAppNumber('03000000000')).toBe('923000000000');
    expect(normalizeWhatsAppNumber('0300 000 0000')).toBe('923000000000');
    // 00 is the international access code, so the country code is already present.
    expect(normalizeWhatsAppNumber('00923001234567')).toBe('923001234567');
    // Already international: untouched.
    expect(normalizeWhatsAppNumber('+441632960000')).toBe('441632960000');

    process.env.WHATSAPP_DEFAULT_COUNTRY_CODE = '44';
    expect(normalizeWhatsAppNumber('07700900000')).toBe('447700900000');
    delete process.env.WHATSAPP_DEFAULT_COUNTRY_CODE;
  });

  it('recognises a real PDF and rejects a page pretending to be one', () => {
    expect(looksLikeMimeType(PDF, 'application/pdf')).toBe(true);
    expect(looksLikeMimeType(Buffer.from('<html>'), 'application/pdf')).toBe(false);
    expect(looksLikeHtml(Buffer.from('<!DOCTYPE html><html>'))).toBe(true);
    expect(looksLikeHtml(PDF)).toBe(false);
  });

  it('knows which failures are worth retrying', () => {
    expect(isRetryable('DOCUMENT_API_TIMEOUT')).toBe(true);
    expect(isRetryable('INVALID_RECIPIENT_NUMBER')).toBe(false);
    expect(isRetryable('DOCUMENT_NOT_FOUND')).toBe(false);
    // Backoff grows and then stops growing, so a stuck job does not drift to never.
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(99)).toBe(3_600_000);
  });

  it('keeps credentials out of anything that gets logged', () => {
    process.env.DOCAPI_ERP_TOKEN = 'super-secret';
    expect(resolveAuthProfile('erp')).toEqual({ authorization: 'Bearer super-secret' });
    // The name survives, the value does not.
    const redacted = redactHeaders({ authorization: 'Bearer super-secret', accept: 'application/pdf' });
    expect(redacted.authorization).toBe('<redacted>');
    expect(redacted.accept).toBe('application/pdf');
    expect(JSON.stringify(redacted)).not.toContain('super-secret');
    delete process.env.DOCAPI_ERP_TOKEN;
  });

  it('fills the filename from the type defaults as well as the job', () => {
    const provider = new HttpDocumentProvider(api.base);
    const config = {
      filenameRule: 'SL-{documentNumber}-{year}.pdf',
      defaultParameters: { year: '2026', companyId: '1006' },
    } as unknown as DocumentTypeRegistry;
    const job = { parametersJson: { documentNumber: '7' }, reference: 'JOB-1' } as unknown as WhatsAppDocumentJob;

    // A placeholder that survives the fill is not left as-is: the sanitiser turns its braces
    // into underscores, and the customer receives "SL-7-_year_.pdf".
    expect(
      provider.determineFilename(job, config, {
        content: PDF,
        mimeType: 'application/pdf',
        filenameHint: null,
        sourceUrl: null,
      }),
    ).toBe('SL-7-2026.pdf');
  });

  it('never lets a filename escape into a path', () => {
    const provider = new HttpDocumentProvider(api.base);
    const config = { filenameRule: '{documentReference}.pdf' } as DocumentTypeRegistry;
    const job = {
      documentName: '../../etc/passwd',
      documentReference: 'INV-1',
      reference: 'JOB-1',
    } as WhatsAppDocumentJob;
    const name = provider.determineFilename(job, config, {
      content: PDF,
      mimeType: 'application/pdf',
      filenameHint: null,
      sourceUrl: null,
    });
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('refuses a document URL that is not http', async () => {
    await ds.getRepository(DocumentTypeRegistry).update({ documentType: 'invoice' }, { responseFormat: 'url' });
    apiBehaviour = (_url, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('file:///etc/passwd');
    };
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);
    expect((await service.findByReference(claimed.reference)).errorCode).toBe('INVALID_DOCUMENT_RESPONSE');
  });

  /* -------------------------------------------------------------- KPIs */

  it('reports KPIs per document type from the rows themselves', async () => {
    await service.create(validJob());
    const [claimed] = await worker.claimBatch(1);
    await worker.process(claimed);

    const kpis = new JobKpiService(ds.getRepository(WhatsAppDocumentJob), ds.getRepository(DocumentTypeRegistry));
    const [invoice] = await kpis.byDocumentType();
    expect(invoice.documentType).toBe('invoice');
    expect(invoice.received).toBe(1);
    expect(invoice.completed).toBe(1);
    expect(invoice.successRatePercent).toBe(100);
    expect(invoice.averageEndToEndMs).not.toBeNull();
    expect(invoice.slaCompliancePercent).toBe(100);
  });
});
