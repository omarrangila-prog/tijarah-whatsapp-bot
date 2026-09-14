/**
 * The lifecycle of a document-delivery job.
 *
 * The states are deliberately fine-grained: an operator watching a job that is taking too long
 * needs to know whether it is waiting on the document API or on WhatsApp, because those have
 * different causes and different people to chase. A single "processing" would hide that.
 */
export const JOB_STATUSES = [
  'PENDING',
  'CLAIMED',
  'PROCESSING',
  'FETCHING_DOCUMENT',
  'DOCUMENT_RECEIVED',
  'SENDING_TO_WHATSAPP',
  'SENT',
  'RETRY_SCHEDULED',
  'FAILED',
  'CANCELLED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * States a job never leaves on its own.
 *
 * `SENT` is in here, and that is the single most important line in this file: a sent job is
 * never re-queued by lease recovery, by a retry command, or by anything else automatic. The
 * document has reached a customer's phone and cannot be unsent, so the only safe thing to do
 * with that row is leave it alone.
 */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['SENT', 'FAILED', 'CANCELLED']);

/** States that mean a worker is holding the job right now, and a lease is running. */
export const IN_FLIGHT_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'CLAIMED',
  'PROCESSING',
  'FETCHING_DOCUMENT',
  'DOCUMENT_RECEIVED',
  'SENDING_TO_WHATSAPP',
]);

/**
 * Failures that will never succeed on a retry, however many times it is attempted.
 *
 * Retrying these wastes the attempt budget and, worse, delays the operator seeing a problem
 * only a human can fix. A wrong phone number does not become right in thirty seconds.
 */
export const NON_RETRYABLE_ERROR_CODES = [
  'INVALID_RECIPIENT_NUMBER',
  'DOCUMENT_NOT_FOUND',
  'UNAUTHORIZED_CLIENT',
  'UNSUPPORTED_DOCUMENT_TYPE',
  'INVALID_PARAMETERS',
  'PERMANENTLY_REJECTED',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_TYPE_DISABLED',
] as const;

export type JobErrorCode =
  | (typeof NON_RETRYABLE_ERROR_CODES)[number]
  | 'DOCUMENT_API_TIMEOUT'
  | 'DOCUMENT_API_ERROR'
  | 'INVALID_DOCUMENT_RESPONSE'
  | 'WHATSAPP_DISCONNECTED'
  | 'WHATSAPP_SEND_FAILED'
  | 'LEASE_EXPIRED'
  | 'UNKNOWN';

export function isRetryable(code: JobErrorCode | null | undefined): boolean {
  if (!code) return false;
  return !(NON_RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Exponential backoff with a ceiling: 30s, 2m, 8m, 32m, capped at an hour.
 *
 * Attempt-based rather than fixed, because the failures worth retrying at all are mostly a
 * document API being briefly unwell, and hammering it every five seconds is how a brief
 * outage becomes a longer one.
 */
export function backoffMs(attempt: number): number {
  const base = 30_000 * Math.pow(4, Math.max(0, attempt - 1));
  return Math.min(base, 3_600_000);
}

/**
 * Failures that are the system's fault, not the job's.
 *
 * These say nothing about whether the document can be delivered — only that the machinery
 * was not ready at that moment. Counting them against a job's attempt budget was the single
 * biggest cause of avoidable failure: a WhatsApp session down for eleven minutes exhausted
 * three attempts on every queued job and marked them all permanently FAILED, when every one
 * of them was deliverable the moment the number came back.
 *
 * A job that hits one of these is parked, not charged. It waits on a short fixed interval
 * rather than an exponential one, because the thing it is waiting for is a human plugging
 * something back in, and when they do the queue should move immediately.
 */
export const INFRASTRUCTURE_ERROR_CODES: ReadonlySet<string> = new Set(['WHATSAPP_DISCONNECTED']);

export function isInfrastructureFailure(code: JobErrorCode | null | undefined): boolean {
  return !!code && INFRASTRUCTURE_ERROR_CODES.has(code);
}

/**
 * How long a parked job waits before looking again.
 *
 * Short and fixed. Exponential backoff is right for an API being hammered; it is wrong for
 * waiting on a reconnection, where backing off to half an hour means a queue that sits idle
 * long after the problem is fixed.
 */
export const INFRASTRUCTURE_RETRY_MS = 30_000;
