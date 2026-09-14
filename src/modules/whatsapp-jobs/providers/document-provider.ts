import type { DocumentTypeRegistry } from '../entities/document-type-registry.entity';
import type { WhatsAppDocumentJob } from '../entities/whatsapp-document-job.entity';
import type { JobErrorCode } from '../job-status';

/** A document that passed every check in §8 and is safe to send to a customer. */
export interface FetchedDocument {
  content: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  /** Where it came from, when the API answered with a URL rather than bytes. */
  sourceUrl: string | null;
}

/** A refusal carrying the reason, so the worker can decide whether retrying is worth it. */
export class DocumentError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

/**
 * How a document is obtained for one document type.
 *
 * Six steps rather than one `fetch()`, because each is a different kind of failure with a
 * different answer: bad parameters are the caller's fault and never retryable, a timeout is
 * the API's and usually is, and a response that parses but is not a document is the case
 * that matters most — see `validateDocument`.
 */
export interface DocumentProvider {
  readonly name: string;
  validateParameters(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): void;
  buildRequest(job: WhatsAppDocumentJob, config: DocumentTypeRegistry): DocumentRequest;
  fetchDocument(request: DocumentRequest, config: DocumentTypeRegistry): Promise<RawDocumentResponse>;
  parseResponse(raw: RawDocumentResponse, config: DocumentTypeRegistry): Promise<ParsedDocument>;
  validateDocument(parsed: ParsedDocument, job: WhatsAppDocumentJob, config: DocumentTypeRegistry): void;
  determineFilename(job: WhatsAppDocumentJob, config: DocumentTypeRegistry, parsed: ParsedDocument): string;
}

export interface DocumentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RawDocumentResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export interface ParsedDocument {
  content: Buffer;
  mimeType: string;
  filenameHint: string | null;
  sourceUrl: string | null;
}

/**
 * Substitutes `{name}` placeholders from the job's parameters.
 *
 * Values are URL-encoded on the way into a path, so a parameter cannot climb out of the
 * endpoint it was meant to fill: an `invoiceId` of `../../admin` stays a path segment.
 */
export function fillTemplate(template: string, values: Record<string, unknown>, encode: boolean): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = asScalar(values[key]);
    if (value === null) return whole;
    return encode ? encodeURIComponent(value) : value;
  });
}

/**
 * A parameter as text, or null if it is not something that can sensibly BE text.
 *
 * `String()` turns an object into "[object Object]", which is worse than useless here: it
 * would satisfy a presence check and then be pasted into a URL, producing a request that
 * fails somewhere far from the mistake. An object where a scalar was expected is a caller
 * error, and this reports it as absent so the required-parameter check catches it.
 */
export function asScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return null;
}

/** True when a parameter is missing, or present but empty, or not a scalar at all. */
export function isBlank(value: unknown): boolean {
  const text = asScalar(value);
  return text === null || text.trim() === '';
}

/**
 * The bytes that make a PDF a PDF.
 *
 * Checked because the failure this prevents is specific and ugly: an API that is unwell
 * answers 200 with an HTML error page, and without a signature check that page is delivered
 * to a customer as `INV-1001.pdf` — a file that will not open, sent from your company, about
 * their money.
 */
const MAGIC: Record<string, Buffer> = {
  'application/pdf': Buffer.from('%PDF-'),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
};

export function looksLikeMimeType(content: Buffer, mimeType: string): boolean {
  const magic = MAGIC[mimeType];
  if (!magic) return true; // Nothing to check against; other validations still apply.
  return content.subarray(0, magic.length).equals(magic);
}

/** Detects the HTML error page that a 200 response is really carrying. */
export function looksLikeHtml(content: Buffer): boolean {
  const head = content.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}
