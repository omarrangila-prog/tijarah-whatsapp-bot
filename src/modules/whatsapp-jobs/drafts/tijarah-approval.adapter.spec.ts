import { createServer, type Server } from 'node:http';
import { hostError, TijarahApprovalSubmissionAdapter } from './tijarah-approval.adapter';
import type { BotUserService } from '../tenancy/bot-user.service';
import type { DocumentDraft } from './document-draft.entity';

/**
 * A stand-in for the host, run over a real socket.
 *
 * What is under test is the shape of the request the host receives and what is made of its
 * answer, so the bytes actually cross a connection rather than being handed to a stub that
 * would agree with whatever the adapter believed.
 */
function startHost(
  handler: (body: string, res: import('node:http').ServerResponse) => void,
): Promise<{ server: Server; url: string; received: string[] }> {
  const received: string[] = [];
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += String(chunk)));
      req.on('end', () => {
        received.push(body);
        handler(body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}/TijarahWhatsappBotRequest/UpsertRequest`, received });
    });
  });
}

const draft = (over: Partial<DocumentDraft> = {}): DocumentDraft =>
  ({
    reference: 'DRAFT-1011',
    documentType: 'create_sale_invoice',
    displayName: 'Sale Invoice',
    createdByPhone: '923347037531',
    fields: { date: '2026-09-14', partyName: 'Ahmed Traders' },
    lineItems: [{ description: 'cotton shirts', quantity: '10', rate: '1500' }],
    ...over,
  }) as DocumentDraft;

const users = (tenant: { sid: number; grp: string; aYear: string } | null): BotUserService =>
  ({ resolve: () => Promise.resolve(tenant) }) as unknown as BotUserService;

describe('submitting a draft to Tijarah', () => {
  let host: { server: Server; url: string; received: string[] };

  afterEach(() => host?.server.close());

  it('sends the host its own envelope, with the company from the sender', async () => {
    host = await startHost((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ success: true, action: 'CREATED', requestId: 2, message: 'New bot request initiated.' }),
      );
    });
    const adapter = new TijarahApprovalSubmissionAdapter(host.url, users({ sid: 1006, grp: 'GR', aYear: '2026' }));

    const result = await adapter.submitForApproval(draft());

    expect(result.ok).toBe(true);
    expect(result.approvalRef).toBe('2');
    expect(result.message).toContain('#2');

    const sent = JSON.parse(host.received[0]) as Record<string, unknown>;
    expect(sent).toMatchObject({
      whatsAppNo: '923347037531',
      sid: 1006,
      grp: 'GR',
      aYear: '2026',
      requestType: 'SALE',
      currentStep: 'SALE_DETAILS',
    });
    expect(sent.requestData).toMatchObject({
      type: 'SALE',
      date: '2026-09-14',
      party: { name: 'Ahmed Traders', code: 'NEW' },
      items: [{ name: 'cotton shirts', qty: 10, rate: 1500, uom: 'PCS' }],
    });
  });

  it('is PENDING and never an entry', async () => {
    host = await startHost((_body, res) => res.end(JSON.stringify({ success: true, requestId: 3 })));
    const adapter = new TijarahApprovalSubmissionAdapter(host.url, users({ sid: 1006, grp: 'GR', aYear: '2026' }));

    await adapter.submitForApproval(draft());

    const sent = JSON.parse(host.received[0]) as Record<string, unknown>;
    expect(sent.requestStatus).toBe('PENDING');
    expect(JSON.stringify(sent)).not.toMatch(/POSTED|APPROVED|FINAL/i);
  });

  it('refuses rather than guessing a company when the sender is no longer registered', async () => {
    host = await startHost((_body, res) => res.end('{}'));
    const adapter = new TijarahApprovalSubmissionAdapter(host.url, users(null));

    const result = await adapter.submitForApproval(draft());

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no longer registered/i);
    // Nothing reached a company's approval screen.
    expect(host.received).toHaveLength(0);
  });

  it('treats 200 with success:false as a refusal, not a submission', async () => {
    host = await startHost((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: "Invalid object name 'WhatsAppBotRequest'." }));
    });
    const adapter = new TijarahApprovalSubmissionAdapter(host.url, users({ sid: 1006, grp: 'GR', aYear: '2026' }));

    const result = await adapter.submitForApproval(draft());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid object name');
  });

  it('refuses a document type the host has no request for', async () => {
    host = await startHost((_body, res) => res.end('{}'));
    const adapter = new TijarahApprovalSubmissionAdapter(host.url, users({ sid: 1006, grp: 'GR', aYear: '2026' }));

    const result = await adapter.submitForApproval(draft({ documentType: 'create_something_else' }));

    expect(result.ok).toBe(false);
    expect(host.received).toHaveLength(0);
  });
});

describe('reading the host’s refusal', () => {
  it('uses its own message when it sends one', () => {
    expect(hostError({ success: false, message: "Invalid object name 'WhatsAppBotRequest'." })).toBe(
      "Invalid object name 'WhatsAppBotRequest'.",
    );
  });

  it('reads an ASP.NET validation document, which has no message field at all', () => {
    // This exact answer was arriving as a bare "HTTP 400" and telling nobody anything.
    expect(
      hostError({
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { RequestType: ["RequestType must be 'SALE', 'PURCHASE', 'PARTY', or 'ITEM'."] },
      }),
    ).toContain("must be 'SALE', 'PURCHASE', 'PARTY', or 'ITEM'");
  });

  it('falls back to the title, then to nothing it could invent', () => {
    expect(hostError({ title: 'Bad Request' })).toBe('Bad Request');
    expect(hostError({})).toBeNull();
    expect(hostError(null)).toBeNull();
  });
});
