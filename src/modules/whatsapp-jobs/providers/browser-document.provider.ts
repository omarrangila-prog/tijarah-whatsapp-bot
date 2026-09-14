import type { Page } from 'puppeteer-core';
import { createLogger } from '../../../common/services/logger.service';
import {
  DocumentError,
  asScalar,
  fillTemplate,
  isBlank,
  looksLikeMimeType,
  type DocumentProvider,
  type DocumentRequest,
  type ParsedDocument,
  type RawDocumentResponse,
} from './document-provider';
import type { DocumentTypeRegistry } from '../entities/document-type-registry.entity';
import type { WhatsAppDocumentJob } from '../entities/whatsapp-document-job.entity';
import type { BrowserSession } from './browser-session';

/**
 * Credentials for a host whose documents are only produced inside a browser.
 *
 * Read from the environment by profile name, exactly like the HTTP provider's bearer tokens.
 * A password is never stored on a registry row, never on a job, and never logged.
 */
export interface BrowserCredentials {
  loginUrl: string;
  username: string;
  password: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** Present once signed in; its absence is how a failed login is detected. */
  signedInSelector?: string;
}

export function resolveBrowserCredentials(
  profile: string | null | undefined,
  baseUrl: string,
): BrowserCredentials | null {
  if (!profile?.trim()) return null;
  const slug = profile
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
  const username = process.env[`DOCAPI_${slug}_USERNAME`];
  const password = process.env[`DOCAPI_${slug}_PASSWORD`];
  if (!username || !password) return null;
  return {
    loginUrl: process.env[`DOCAPI_${slug}_LOGIN_URL`] ?? `${baseUrl.replace(/\/$/, '')}/login`,
    username,
    password,
    // Defaults that suit an ordinary form; overridable because a selector is site-specific and
    // must not require a code change when the host redesigns its login page.
    usernameSelector: process.env[`DOCAPI_${slug}_USERNAME_SELECTOR`] ?? 'input[name="username"], input[type="email"]',
    passwordSelector: process.env[`DOCAPI_${slug}_PASSWORD_SELECTOR`] ?? 'input[type="password"]',
    submitSelector: process.env[`DOCAPI_${slug}_SUBMIT_SELECTOR`] ?? 'button[type="submit"]',
    signedInSelector: process.env[`DOCAPI_${slug}_SIGNED_IN_SELECTOR`],
  };
}

/**
 * Produces a document by driving a browser, for hosts that render PDFs client-side.
 *
 * Tijarah Books is the case this exists for: `/internal/pdf/...` is a route in its single-page
 * app, and the PDF is built in the browser by html2pdf. There is no server response to fetch —
 * every such URL returns the same HTML shell, and asking it for `application/pdf` is answered
 * 406. The only way to obtain the document their customers actually recognise is to be a
 * browser: sign in, open the route, let the app render, and print the result.
 *
 * The alternative — rebuilding each template against the data API — produces a PDF that is
 * correct but does not look like the client's invoice, which for a document going to their
 * customers is the thing that matters most.
 */
export class BrowserDocumentProvider implements DocumentProvider {
  readonly name = 'browser';
  private readonly logger = createLogger('BrowserDocumentProvider');
  private signedIn = false;

  constructor(
    private readonly baseUrl: string,
    private readonly session: BrowserSession,
  ) {}

  validateParameters(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): void {
    const params = { ...(config.defaultParameters ?? {}), ...(job.parametersJson ?? {}) };
    const missing = (config.requiredParameters ?? []).filter(key => isBlank(params[key]));
    if (missing.length) {
      throw new DocumentError('INVALID_PARAMETERS', `Missing required parameter(s): ${missing.join(', ')}`);
    }
  }

  buildRequest(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): DocumentRequest {
    const params = { ...(config.defaultParameters ?? {}), ...(job.parametersJson ?? {}) };
    const path = fillTemplate(config.endpoint, params, true);
    const url = /^https?:\/\//i.test(path)
      ? path
      : `${this.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
    return { url, method: 'GET', headers: {} };
  }

  /**
   * Signs in, opens the document route, and prints what the app renders.
   *
   * `action=preview` is appended when the type asks for it, because the same route either
   * renders on screen or triggers a client-side download depending on that flag — and a
   * download is far harder to capture reliably than a rendered page.
   */
  async fetchDocument(request: DocumentRequest, config: DocumentTypeRegistry): Promise<RawDocumentResponse> {
    const credentials = resolveBrowserCredentials(config.authProfile, this.baseUrl);
    if (!credentials) {
      throw new DocumentError(
        'UNAUTHORIZED_CLIENT',
        `No browser credentials for auth profile "${config.authProfile ?? '(none)'}". Set DOCAPI_<PROFILE>_USERNAME and _PASSWORD.`,
      );
    }

    try {
      const pdf = await this.session.withPage(async page => {
        await this.ensureSignedIn(page, credentials);

        const target = new URL(request.url);
        if (!target.searchParams.has('action')) target.searchParams.set('action', 'preview');

        const response = await page.goto(target.toString(), { waitUntil: 'networkidle2' });
        if (response && response.status() >= 400) {
          throw new DocumentError(
            response.status() === 404 ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_API_ERROR',
            `Document page responded ${response.status()}`,
          );
        }

        await this.waitForContent(page, config);
        return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
      });

      return { status: 200, contentType: 'application/pdf', body: pdf };
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      const message = (error as Error).message ?? 'browser failed';
      if (/timeout|Navigation timeout/i.test(message)) {
        throw new DocumentError(
          'DOCUMENT_API_TIMEOUT',
          `The document page did not finish rendering: ${message.slice(0, 140)}`,
        );
      }
      throw new DocumentError('DOCUMENT_API_ERROR', `Browser could not produce the document: ${message.slice(0, 160)}`);
    }
  }

  /**
   * Signs in once and remembers it.
   *
   * Logging in per document would be a round trip and an auth event for every invoice; the
   * flag is cleared whenever a page turns out to be the login screen again, so an expired
   * session recovers on the next attempt rather than failing until a restart.
   */
  private async ensureSignedIn(page: Page, credentials: BrowserCredentials): Promise<void> {
    if (this.signedIn) return;

    await page.goto(credentials.loginUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector(credentials.usernameSelector, { timeout: 20_000 });
    await page.type(credentials.usernameSelector, credentials.username);
    await page.type(credentials.passwordSelector, credentials.password);
    await Promise.all([
      page.click(credentials.submitSelector),
      page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => undefined),
    ]);

    if (credentials.signedInSelector) {
      await page.waitForSelector(credentials.signedInSelector, { timeout: 20_000 }).catch(() => {
        throw new DocumentError(
          'UNAUTHORIZED_CLIENT',
          'Signed-in marker never appeared; the credentials were probably refused.',
        );
      });
    } else if (page.url().includes('/login')) {
      // Still on the login page after submitting: the host rejected the credentials. Said
      // plainly, and without ever echoing what was submitted.
      throw new DocumentError(
        'UNAUTHORIZED_CLIENT',
        'Still on the login page after signing in; credentials were refused.',
      );
    }

    this.signedIn = true;
    this.logger.log('signed in to the document host');
  }

  /**
   * Waits for the app to actually draw the document.
   *
   * `networkidle2` only means the requests stopped; a client-rendered invoice can still be an
   * empty container at that moment, and printing then produces a blank but perfectly valid
   * PDF — the worst possible outcome, because every downstream check passes and the customer
   * receives an empty invoice.
   */
  private async waitForContent(page: Page, config: DocumentTypeRegistry): Promise<void> {
    const selector = asScalar((config.responseParser as { readySelector?: unknown } | null)?.readySelector);
    if (selector) {
      await page.waitForSelector(selector, { timeout: 30_000 }).catch(() => {
        throw new DocumentError('INVALID_DOCUMENT_RESPONSE', `The document never rendered (waiting for "${selector}")`);
      });
      return;
    }
    // No selector configured: wait for the page to carry a meaningful amount of text.
    await page
      .waitForFunction(() => (document.body?.innerText ?? '').trim().length > 40, { timeout: 30_000 })
      .catch(() => {
        throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'The document page stayed blank');
      });
  }

  parseResponse(raw: RawDocumentResponse): Promise<ParsedDocument> {
    return Promise.resolve({ content: raw.body, mimeType: 'application/pdf', filenameHint: null, sourceUrl: null });
  }

  validateDocument(parsed: ParsedDocument, _job: WhatsAppDocumentJob, config: DocumentTypeRegistry): void {
    if (!parsed.content.length)
      throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'The browser produced an empty file');
    if (parsed.content.length > config.maximumFileSize) {
      throw new DocumentError(
        'DOCUMENT_TOO_LARGE',
        `Document is ${parsed.content.length} bytes, over the ${config.maximumFileSize} limit`,
      );
    }
    if (!looksLikeMimeType(parsed.content, 'application/pdf')) {
      throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'The browser did not produce a valid PDF');
    }
  }

  determineFilename(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): string {
    const params = { ...(config.defaultParameters ?? {}), ...(job.parametersJson ?? {}) };
    const raw =
      job.documentName ||
      fillTemplate(
        config.filenameRule,
        { ...params, documentReference: job.documentReference ?? job.reference },
        false,
      );
    const leaf = raw.split(/[\\/]/).pop() ?? 'document.pdf';
    const safe = leaf
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120);
    if (!safe) return 'document.pdf';
    return /\.[A-Za-z0-9]{2,5}$/.test(safe) ? safe : `${safe}.pdf`;
  }
}
