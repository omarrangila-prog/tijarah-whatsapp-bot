import { request } from 'undici';
import {
  DocumentError,
  asScalar,
  fillTemplate,
  isBlank,
  looksLikeHtml,
  looksLikeMimeType,
  type DocumentProvider,
  type DocumentRequest,
  type ParsedDocument,
  type RawDocumentResponse,
} from './document-provider';
import type { DocumentTypeRegistry } from '../entities/document-type-registry.entity';
import type { WhatsAppDocumentJob } from '../entities/whatsapp-document-job.entity';
import { resolveAuthProfile } from './auth-profiles';

/**
 * The one provider every document type uses.
 *
 * Document APIs differ in how they hand back a file — raw bytes, a URL to fetch, base64, or
 * JSON wrapping either — but not in anything else, so those four shapes are configuration
 * (`responseFormat`) rather than four classes. A new document type is a registry row.
 */
export class HttpDocumentProvider implements DocumentProvider {
  readonly name = 'http';

  constructor(private readonly baseUrl: string) {}

  /** The job's parameters over the type's defaults; the job always wins. */
  private merged(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): Record<string, unknown> {
    return { ...(config.defaultParameters ?? {}), ...(job.parametersJson ?? {}) };
  }

  validateParameters(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): void {
    const params = this.merged(job, config);
    const missing = (config.requiredParameters ?? []).filter(key => isBlank(params[key]));
    if (missing.length) {
      throw new DocumentError('INVALID_PARAMETERS', `Missing required parameter(s): ${missing.join(', ')}`);
    }
  }

  buildRequest(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): DocumentRequest {
    const params = this.merged(job, config);
    const path = fillTemplate(config.endpoint, params, true);
    const url = /^https?:\/\//i.test(path)
      ? path
      : `${this.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;

    const headers: Record<string, string> = {
      accept: `${config.expectedMimeType}, application/json;q=0.5`,
      ...(config.requestHeaders ?? {}),
    };
    // The secret is attached here and nowhere else: it never touches the job row or a log line.
    Object.assign(headers, resolveAuthProfile(config.authProfile));

    let body: string | undefined;
    if (config.method !== 'GET' && config.method !== 'HEAD') {
      const mapping = config.requestBodyMapping;
      const payload = mapping
        ? Object.fromEntries(Object.entries(mapping).map(([apiField, jobField]) => [apiField, params[jobField]]))
        : params;
      body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
    }

    return { url, method: config.method || 'GET', headers, body };
  }

  async fetchDocument(req: DocumentRequest, config: DocumentTypeRegistry): Promise<RawDocumentResponse> {
    const timeoutMs = Math.max(1, config.timeoutSeconds) * 1000;
    try {
      const res = await request(req.url, {
        method: req.method as 'GET',
        headers: req.headers,
        body: req.body,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      const buffer = Buffer.from(await res.body.arrayBuffer());
      const contentType = String(res.headers['content-type'] ?? '')
        .split(';')[0]
        .trim();

      if (res.statusCode >= 400) {
        /*
         * A 404 means the document does not exist; asking again will not conjure it. Other
         * 4xx are the request's fault and equally permanent. 5xx is the server having a bad
         * moment, which is exactly what retrying is for.
         */
        const code =
          res.statusCode === 404
            ? 'DOCUMENT_NOT_FOUND'
            : res.statusCode < 500
              ? 'PERMANENTLY_REJECTED'
              : 'DOCUMENT_API_ERROR';
        throw new DocumentError(code, `Document API responded ${res.statusCode}`);
      }
      return { status: res.statusCode, contentType, body: buffer };
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      const message = (error as Error).message ?? 'request failed';
      if (/timeout|aborted|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(message)) {
        throw new DocumentError('DOCUMENT_API_TIMEOUT', `Document API did not answer within ${config.timeoutSeconds}s`);
      }
      throw new DocumentError('DOCUMENT_API_ERROR', `Document API unreachable: ${message.slice(0, 160)}`);
    }
  }

  async parseResponse(raw: RawDocumentResponse, config: DocumentTypeRegistry): Promise<ParsedDocument> {
    switch (config.responseFormat) {
      case 'binary':
        return {
          content: raw.body,
          mimeType: raw.contentType || config.expectedMimeType,
          filenameHint: null,
          sourceUrl: null,
        };

      case 'base64': {
        const text = raw.body.toString('utf8').trim();
        return {
          content: Buffer.from(stripDataUri(text), 'base64'),
          mimeType: config.expectedMimeType,
          filenameHint: null,
          sourceUrl: null,
        };
      }

      case 'url': {
        const url = raw.body.toString('utf8').trim();
        return this.followUrl(url, config);
      }

      case 'json': {
        const parsed = safeJson(raw.body);
        const parser = config.responseParser ?? {};
        const value = parser.documentPath ? asScalar(pick(parsed, parser.documentPath)) : null;
        if (!value) throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'JSON response carried no document');
        const filenameHint = parser.filenamePath ? asScalar(pick(parsed, parser.filenamePath)) : null;
        const mimeType =
          (parser.mimeTypePath ? asScalar(pick(parsed, parser.mimeTypePath)) : null) ?? config.expectedMimeType;

        if (/^https?:\/\//i.test(value)) {
          const followed = await this.followUrl(value, config);
          return { ...followed, filenameHint: filenameHint ?? followed.filenameHint };
        }
        return { content: Buffer.from(stripDataUri(value), 'base64'), mimeType, filenameHint, sourceUrl: null };
      }

      default:
        throw new DocumentError('INVALID_DOCUMENT_RESPONSE', `Unknown responseFormat "${config.responseFormat}"`);
    }
  }

  /**
   * Downloads a document the API pointed at rather than sent.
   *
   * Only http and https, and redirects are NOT followed: a document URL comes from an
   * external system, and chasing wherever it points is how a server ends up fetching
   * `file:///etc/passwd` — or an internal address — on that system's behalf. An API that
   * answers with a redirect gets a plain failure the operator can see and fix.
   */
  private async followUrl(url: string, config: DocumentTypeRegistry): Promise<ParsedDocument> {
    if (!/^https?:\/\//i.test(url)) {
      throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'Document URL must be http or https');
    }
    const timeoutMs = Math.max(1, config.timeoutSeconds) * 1000;
    const res = await request(url, { method: 'GET', headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    if (res.statusCode >= 400) {
      throw new DocumentError('DOCUMENT_API_ERROR', `Document URL responded ${res.statusCode}`);
    }
    const content = Buffer.from(await res.body.arrayBuffer());
    const disposition = String(res.headers['content-disposition'] ?? '');
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    return {
      content,
      mimeType: String(res.headers['content-type'] ?? config.expectedMimeType)
        .split(';')[0]
        .trim(),
      filenameHint: match ? match[1] : null,
      sourceUrl: url,
    };
  }

  validateDocument(parsed: ParsedDocument, job: WhatsAppDocumentJob, config: DocumentTypeRegistry): void {
    if (!parsed.content.length) {
      throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'Document API returned an empty document');
    }
    if (parsed.content.length > config.maximumFileSize) {
      throw new DocumentError(
        'DOCUMENT_TOO_LARGE',
        `Document is ${parsed.content.length} bytes, over the ${config.maximumFileSize} limit`,
      );
    }
    /*
     * The HTML check comes before the MIME check so the error says what actually happened.
     * "Expected a PDF, got an HTML error page" sends someone to the document API; a generic
     * "invalid document" sends them here.
     */
    if (config.expectedMimeType === 'application/pdf' && looksLikeHtml(parsed.content)) {
      throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'Document API returned an HTML page, not a PDF');
    }
    if (!looksLikeMimeType(parsed.content, config.expectedMimeType)) {
      throw new DocumentError('INVALID_DOCUMENT_RESPONSE', `Content is not a valid ${config.expectedMimeType}`);
    }
  }

  determineFilename(job: WhatsAppDocumentJob, config: DocumentTypeRegistry, parsed: ParsedDocument): string {
    const raw =
      job.documentName ||
      parsed.filenameHint ||
      // Merged with the type's defaults, like every other read of the parameters. Without it a
      // rule of "SL-{documentNumber}-{year}.pdf" produced "SL-1-_year_.pdf": the placeholder
      // survived the fill and the sanitiser turned its braces into underscores, so the customer
      // received a file with a broken name.
      fillTemplate(
        config.filenameRule,
        { ...this.merged(job, config), documentReference: job.documentReference ?? job.reference },
        false,
      );

    /*
     * The filename reaches a customer's file system, so it is stripped to a leaf name with no
     * separators: a document called `../../autoexec.bat` is a filename, not a path.
     */
    const leaf = raw.split(/[\\/]/).pop() ?? 'document.pdf';
    const safe = leaf
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120);
    if (!safe) return 'document.pdf';
    return /\.[A-Za-z0-9]{2,5}$/.test(safe) ? safe : `${safe}.pdf`;
  }
}

function stripDataUri(value: string): string {
  return value.replace(/^data:[^;,]+;base64,/i, '');
}

function safeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new DocumentError('INVALID_DOCUMENT_RESPONSE', 'Document API did not return valid JSON');
  }
}

function pick(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}
