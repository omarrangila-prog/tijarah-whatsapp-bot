import { BrowserDocumentProvider, resolveBrowserCredentials } from './browser-document.provider';
import { DocumentError } from './document-provider';
import type { BrowserSession } from './browser-session';
import type { DocumentTypeRegistry } from '../entities/document-type-registry.entity';
import type { WhatsAppDocumentJob } from '../entities/whatsapp-document-job.entity';
import { buildSamplePdf } from './sample-pdf';

/**
 * The browser provider, without a browser.
 *
 * The BrowserSession seam exists so the parts that carry the logic — signing in, waiting for
 * a client-rendered page, refusing a blank one — are testable. Chromium itself is exercised
 * against a real container; what is covered here is everything that decides whether a document
 * is fit to send.
 */
const PDF = buildSamplePdf({ title: 'SL-1', lines: ['Tijarah Books'] });

type PageStub = {
  goto: jest.Mock;
  pdf: jest.Mock;
  type: jest.Mock;
  click: jest.Mock;
  url: jest.Mock;
  waitForSelector: jest.Mock;
  waitForNavigation: jest.Mock;
  waitForFunction: jest.Mock;
  setDefaultNavigationTimeout: jest.Mock;
  close: jest.Mock;
};

function stubPage(overrides: Partial<PageStub> = {}): PageStub {
  return {
    goto: jest.fn().mockResolvedValue({ status: () => 200 }),
    pdf: jest.fn().mockResolvedValue(PDF),
    type: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('https://my.tijarahbooks.com/dashboard'),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    waitForNavigation: jest.fn().mockResolvedValue(undefined),
    waitForFunction: jest.fn().mockResolvedValue(undefined),
    setDefaultNavigationTimeout: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function sessionFor(page: PageStub): BrowserSession {
  return {
    withPage: <T>(work: (p: never) => Promise<T>) => work(page as never),
    close: () => Promise.resolve(),
  };
}

const CONFIG = {
  documentType: 'sale_invoice',
  endpoint: '/internal/pdf/SL/{companyId}/{branch}/{year}/{documentNumber}?scode=0102003',
  authProfile: 'tijarah',
  requiredParameters: ['documentNumber'],
  defaultParameters: { companyId: '1006', branch: 'GR', year: '2026' },
  maximumFileSize: 10_485_760,
  filenameRule: 'SL-{documentNumber}-{year}.pdf',
  providerKind: 'browser',
  responseParser: null,
} as unknown as DocumentTypeRegistry;

const JOB = { parametersJson: { documentNumber: '7' }, reference: 'JOB-1' } as unknown as WhatsAppDocumentJob;

describe('BrowserDocumentProvider', () => {
  const BASE = 'https://my.tijarahbooks.com';

  beforeEach(() => {
    process.env.DOCAPI_TIJARAH_USERNAME = 'demo-user';
    process.env.DOCAPI_TIJARAH_PASSWORD = 'demo-pass';
  });

  afterEach(() => {
    delete process.env.DOCAPI_TIJARAH_USERNAME;
    delete process.env.DOCAPI_TIJARAH_PASSWORD;
    delete process.env.DOCAPI_TIJARAH_SIGNED_IN_SELECTOR;
  });

  it('builds the URL from the specification, merging the type defaults', () => {
    const provider = new BrowserDocumentProvider(BASE, sessionFor(stubPage()));
    const request = provider.buildRequest(JOB, CONFIG);
    expect(request.url).toBe('https://my.tijarahbooks.com/internal/pdf/SL/1006/GR/2026/7?scode=0102003');
  });

  it('signs in, opens the document with action=preview, and prints it', async () => {
    const page = stubPage();
    const provider = new BrowserDocumentProvider(BASE, sessionFor(page));

    const raw = await provider.fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG);

    expect(raw.contentType).toBe('application/pdf');
    expect(raw.body.subarray(0, 5).toString()).toBe('%PDF-');
    // The login page first, then the document route carrying action=preview — the flag that
    // makes the app render on screen instead of triggering a client-side download.
    const visited = (page.goto.mock.calls as unknown[][]).map(c => String(c[0]));
    expect(visited[0]).toContain('/login');
    expect(visited[1]).toContain('/internal/pdf/SL/1006/GR/2026/7');
    expect(visited[1]).toContain('action=preview');
  });

  it('signs in once across several documents', async () => {
    const page = stubPage();
    const provider = new BrowserDocumentProvider(BASE, sessionFor(page));

    await provider.fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG);
    await provider.fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG);

    // One login, two documents — not an auth event per invoice.
    const logins = (page.goto.mock.calls as unknown[][]).filter(c => String(c[0]).includes('/login'));
    expect(logins).toHaveLength(1);
  });

  it('refuses to print a page that never rendered', async () => {
    /*
     * The failure worth guarding: networkidle only means the requests stopped. A client-rendered
     * invoice can still be an empty container, and printing then yields a blank but perfectly
     * valid PDF — every downstream check passes and the customer receives an empty invoice.
     */
    const page = stubPage({ waitForFunction: jest.fn().mockRejectedValue(new Error('timeout')) });
    const provider = new BrowserDocumentProvider(BASE, sessionFor(page));

    await expect(provider.fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG)).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_RESPONSE',
    });
    expect(page.pdf).not.toHaveBeenCalled();
  });

  it('reports refused credentials as an authorisation failure, not a retryable blip', async () => {
    const page = stubPage({ url: jest.fn().mockReturnValue('https://my.tijarahbooks.com/login') });
    const provider = new BrowserDocumentProvider(BASE, sessionFor(page));

    await expect(provider.fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG)).rejects.toMatchObject({
      code: 'UNAUTHORIZED_CLIENT',
    });
  });

  it('never puts the password in the error it raises', async () => {
    const page = stubPage({ url: jest.fn().mockReturnValue('https://my.tijarahbooks.com/login') });
    const provider = new BrowserDocumentProvider(BASE, sessionFor(page));

    const error = await provider
      .fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG)
      .catch((e: DocumentError) => e);
    expect(String((error as DocumentError).message)).not.toContain('demo-pass');
  });

  it('says plainly when no credentials are configured', async () => {
    delete process.env.DOCAPI_TIJARAH_USERNAME;
    const provider = new BrowserDocumentProvider(BASE, sessionFor(stubPage()));

    await expect(provider.fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG)).rejects.toMatchObject({
      code: 'UNAUTHORIZED_CLIENT',
    });
  });

  it('treats a missing document page as permanent, not worth retrying', async () => {
    const page = stubPage({
      goto: jest
        .fn()
        .mockResolvedValueOnce({ status: () => 200 })
        .mockResolvedValueOnce({ status: () => 404 }),
    });
    const provider = new BrowserDocumentProvider(BASE, sessionFor(page));

    await expect(provider.fetchDocument(provider.buildRequest(JOB, CONFIG), CONFIG)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  });

  it('rejects anything that is not a PDF, whatever the browser returned', () => {
    const provider = new BrowserDocumentProvider(BASE, sessionFor(stubPage()));
    const html = {
      content: Buffer.from('<!doctype html><html>'),
      mimeType: 'application/pdf',
      filenameHint: null,
      sourceUrl: null,
    };

    expect(() => provider.validateDocument(html, JOB, CONFIG)).toThrow(DocumentError);
    expect(() => provider.validateDocument({ ...html, content: Buffer.alloc(0) }, JOB, CONFIG)).toThrow(/empty/i);
  });

  it('names the file from the type rule', () => {
    const provider = new BrowserDocumentProvider(BASE, sessionFor(stubPage()));
    expect(provider.determineFilename(JOB, CONFIG)).toBe('SL-7-2026.pdf');
  });

  it('reads credentials from the environment by profile, never from the registry row', () => {
    const credentials = resolveBrowserCredentials('tijarah', BASE);
    expect(credentials?.username).toBe('demo-user');
    expect(credentials?.loginUrl).toBe('https://my.tijarahbooks.com/login');
    // Nothing on the row itself carries a secret — only the profile's name.
    expect(JSON.stringify(CONFIG)).not.toContain('demo-pass');
    expect(resolveBrowserCredentials(null, BASE)).toBeNull();
  });
});
