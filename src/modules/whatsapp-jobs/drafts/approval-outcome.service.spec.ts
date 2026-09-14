import { createServer, type Server } from 'node:http';
import {
  ApprovalOutcomeService,
  deliverableTypeFor,
  findDocumentNumber,
  isHostSubmitted,
  readRequests,
  readApprovalOutcomeConfig,
  type ActiveRequest,
} from './approval-outcome.service';
import type { BotUserService } from '../tenancy/bot-user.service';
import type { WhatsAppJobsService } from '../whatsapp-jobs.service';
import type { DocumentDraft } from './document-draft.entity';
import type { Repository } from 'typeorm';

function startHost(answer: () => unknown): Promise<{ server: Server; base: string; asked: string[] }> {
  const asked: string[] = [];
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      asked.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer()));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${port}`, asked });
    });
  });
}

const TENANT = { sid: 1006, grp: 'GR', aYear: '2026' };

const draft = (over: Partial<DocumentDraft> = {}): DocumentDraft =>
  ({
    id: 'd1',
    reference: 'DRAFT-1011',
    documentType: 'create_sale_invoice',
    displayName: 'Sale Invoice',
    createdByPhone: '923347037531',
    submittedRef: '2',
    status: 'SUBMITTED',
    fields: { partyName: 'Ahmed Traders' },
    lineItems: [],
    ...over,
  }) as DocumentDraft;

const active = (over: Partial<ActiveRequest> = {}): ActiveRequest => ({
  id: 2,
  whatsAppNo: '923347037531',
  sid: 1006,
  grp: 'GR',
  aYear: '2026',
  requestType: 'SALE',
  requestStatus: 'PENDING',
  ...over,
});

describe('reading a decision back from the approval screen', () => {
  let host: { server: Server; base: string; asked: string[] };
  let saved: Partial<DocumentDraft>[];
  let created: Record<string, unknown>[];

  const build = (base: string, tenant: typeof TENANT | null = TENANT): ApprovalOutcomeService => {
    saved = [];
    created = [];
    process.env.APPROVAL_POLL_ENABLED = 'true';
    process.env.DRAFT_SUBMIT_ENDPOINT = `${base}/UpsertRequest`;
    const drafts = {
      find: () => Promise.resolve([draft()]),
      save: (d: Partial<DocumentDraft>) => {
        saved.push(d);
        return Promise.resolve(d);
      },
      update: (_where: unknown, patch: Partial<DocumentDraft>) => {
        saved.push(patch);
        return Promise.resolve({});
      },
    } as unknown as Repository<DocumentDraft>;
    const users = { resolve: () => Promise.resolve(tenant) } as unknown as BotUserService;
    const jobs = {
      create: (dto: Record<string, unknown>) => {
        created.push(dto);
        return Promise.resolve({ reference: 'JOB-1', id: 'j1' });
      },
    } as unknown as WhatsAppJobsService;
    return new ApprovalOutcomeService(drafts, users, jobs);
  };

  afterEach(() => {
    host?.server.close();
    delete process.env.APPROVAL_POLL_ENABLED;
    delete process.env.DRAFT_SUBMIT_ENDPOINT;
  });

  it('asks about the composer’s own number, for their own company', async () => {
    host = await startHost(() => ({ hasActiveRequest: true, data: active() }));
    await build(host.base).follow(draft());

    expect(host.asked[0]).toContain('/GetActiveRequest?');
    expect(host.asked[0]).toContain('sid=1006');
    expect(host.asked[0]).toContain('grp=GR');
    expect(host.asked[0]).toContain('aYear=2026');
    expect(host.asked[0]).toContain('whatsAppNo=923347037531');
  });

  it('does nothing while the request is still pending', async () => {
    host = await startHost(() => ({ hasActiveRequest: true, data: active() }));
    const outcome = await build(host.base).follow(draft());

    expect(outcome).toBe('waiting');
    expect(created).toHaveLength(0);
  });

  it('queues the document for the composer once it is approved', async () => {
    host = await startHost(() => ({
      hasActiveRequest: true,
      data: active({ requestStatus: 'APPROVED', documentNo: 1 }),
    }));
    const outcome = await build(host.base).follow(draft());

    expect(outcome).toBe('accepted');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      documentType: 'sale_invoice',
      documentReference: '1',
      recipientWhatsAppNumber: '923347037531',
      parameters: { companyId: '1006', branch: 'GR', year: '2026', documentNumber: '1' },
    });
    // One delivery per host request, however many times the poll sees it approved.
    expect(created[0].idempotencyKey).toBe('tijarah-approval-2');
    expect(saved.at(-1)?.status).toBe('APPROVED');
  });

  it('refuses to act on a row belonging to someone else', async () => {
    // The host returned another number's request for `whatsAppNo=0`, so the answer is checked.
    host = await startHost(() => ({
      hasActiveRequest: true,
      data: active({ whatsAppNo: '923009988776', requestStatus: 'APPROVED', documentNo: 7 }),
    }));
    const outcome = await build(host.base).follow(draft());

    expect(outcome).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('refuses a row from another company even on the right number', async () => {
    host = await startHost(() => ({
      hasActiveRequest: true,
      data: active({ sid: 1007, requestStatus: 'APPROVED', documentNo: 7 }),
    }));

    expect(await build(host.base).follow(draft())).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('sends nothing when the host does not say which document it became', async () => {
    host = await startHost(() => ({ hasActiveRequest: true, data: active({ requestStatus: 'APPROVED' }) }));
    const outcome = await build(host.base).follow(draft());

    // Fetching `.../{year}/undefined` would return something, and it would be sent as an invoice.
    expect(created).toHaveLength(0);
    expect(outcome).toBeNull();
  });

  it('records a rejection instead of delivering', async () => {
    host = await startHost(() => ({ hasActiveRequest: true, data: active({ requestStatus: 'REJECTED' }) }));
    const outcome = await build(host.base).follow(draft());

    expect(outcome).toBe('refused');
    expect(created).toHaveLength(0);
    expect(saved.at(-1)?.status).toBe('REJECTED');
  });

  it('finds its own request in a list by the host id, not by position', async () => {
    // The host is changing to return every request at once; ours is not necessarily first.
    host = await startHost(() => ({
      hasActiveRequest: true,
      data: [
        active({ id: 5, requestType: 'PURCHASE', requestStatus: 'PENDING' }),
        active({ id: 2, requestStatus: 'APPROVED', documentNo: 1 }),
        active({ id: 3, requestType: 'PARTY', requestStatus: 'REJECTED' }),
      ],
    }));
    const outcome = await build(host.base).follow(draft({ submittedRef: '2' }));

    expect(outcome).toBe('accepted');
    expect(created[0]).toMatchObject({ documentReference: '1', recipientWhatsAppNumber: '923347037531' });
  });

  it('keeps waiting when the list does not contain its request yet', async () => {
    host = await startHost(() => ({
      hasActiveRequest: true,
      data: [active({ id: 5, requestType: 'PURCHASE', requestStatus: 'APPROVED', documentNo: 9 })],
    }));
    const outcome = await build(host.base).follow(draft({ submittedRef: '2' }));

    // Request 5 is somebody else's document; ours is not in the answer.
    expect(outcome).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('treats a failed request as refused', async () => {
    host = await startHost(() => ({ hasActiveRequest: true, data: active({ requestStatus: 'FAILED' }) }));
    const outcome = await build(host.base).follow(draft());

    expect(outcome).toBe('refused');
    expect(saved.at(-1)?.status).toBe('REJECTED');
  });

  it('does not poll for a number that is no longer registered', async () => {
    host = await startHost(() => ({ hasActiveRequest: true, data: active() }));
    expect(await build(host.base, null).follow(draft())).toBeNull();
    expect(host.asked).toHaveLength(0);
  });
});

describe('what an approved request becomes', () => {
  it('maps each creatable document to the type that has a PDF', () => {
    expect(deliverableTypeFor('create_sale_invoice')).toBe('sale_invoice');
    expect(deliverableTypeFor('create_purchase_return')).toBe('purchase_return');
    expect(deliverableTypeFor('create_receive_voucher')).toBe('receive_voucher');
  });

  it('has nothing to send for an account or an item', () => {
    // Approving these creates a row in a chart of accounts, not a document.
    expect(deliverableTypeFor('create_customer_account')).toBeNull();
    expect(deliverableTypeFor('create_item_account')).toBeNull();
    expect(deliverableTypeFor('sale_invoice')).toBeNull();
  });

  it('finds the document number wherever the host puts it', () => {
    expect(findDocumentNumber({ ...active(), documentNo: 12 })).toBe('12');
    expect(findDocumentNumber({ ...active(), voucherNo: 'CV-9' })).toBe('CV-9');
    expect(findDocumentNumber({ ...active(), requestData: { invoiceNo: 44 } })).toBe('44');
  });

  it('does not mistake the NEW placeholder for a document number', () => {
    // "NEW" is how a party or item that does not exist yet is expressed on the way in.
    expect(findDocumentNumber({ ...active(), requestData: { number: 'NEW' } })).toBeNull();
    expect(findDocumentNumber(active())).toBeNull();
  });
});

describe('approval follow-up configuration', () => {
  it('is off unless drafts are actually submitted to a host', () => {
    expect(readApprovalOutcomeConfig({ APPROVAL_POLL_ENABLED: 'true' }).enabled).toBe(false);
    expect(
      readApprovalOutcomeConfig({ APPROVAL_POLL_ENABLED: 'true', DRAFT_SUBMIT_ENDPOINT: 'https://h/x/UpsertRequest' })
        .enabled,
    ).toBe(true);
  });

  it('derives its own URL from the submit endpoint, so both halves reach one host', () => {
    const config = readApprovalOutcomeConfig({
      APPROVAL_POLL_ENABLED: 'true',
      DRAFT_SUBMIT_ENDPOINT: 'https://api.tijarabooks.com/TijarahWhatsappBotRequest/UpsertRequest',
    });
    expect(config.baseUrl).toBe('https://api.tijarabooks.com/TijarahWhatsappBotRequest');
  });
});

describe('which drafts are worth asking the host about', () => {
  it('skips one the mock adapter recorded, because it is on no approval screen', () => {
    expect(isHostSubmitted(draft({ submittedRef: 'mock.approval.DRAFT-1006' }))).toBe(false);
  });

  it('polls one the host acknowledged, and one submitted before refs were recorded', () => {
    expect(isHostSubmitted(draft({ submittedRef: '2' }))).toBe(true);
    expect(isHostSubmitted(draft({ submittedRef: null }))).toBe(true);
  });
});

describe('reading the host’s answer as a list', () => {
  it('reads one row or many the same way', () => {
    expect(readRequests(active({ id: 1 })).map(r => r.id)).toEqual([1]);
    expect(readRequests([active({ id: 1 }), active({ id: 2 })]).map(r => r.id)).toEqual([1, 2]);
  });

  it('drops what is not a request rather than passing it to the matcher', () => {
    expect(readRequests(null)).toEqual([]);
    expect(readRequests('nothing')).toEqual([]);
    expect(readRequests([{ message: 'No active request' }, active({ id: 4 })]).map(r => r.id)).toEqual([4]);
  });
});
