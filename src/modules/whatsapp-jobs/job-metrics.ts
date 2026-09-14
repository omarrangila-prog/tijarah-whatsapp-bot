/**
 * Process-lifetime counters for document delivery, rendered by MetricsService.
 *
 * Module-level counters, matching how webhook failures and reconnect attempts are already
 * counted in this codebase: the worker increments, the metrics endpoint reads, and nothing
 * has to be injected across a module boundary to make it work.
 *
 * These are counters, not gauges — they only ever go up, and they reset when the process
 * does. The current queue depth is a database question and is answered by the connection
 * endpoint instead; asking Prometheus to hold it would be a second source of truth for
 * something one `SELECT` already knows.
 */
const claimed = { total: 0 };
const sent = { total: 0 };
const failedByCode = new Map<string, number>();
const retried = { total: 0 };
const duplicatesPrevented = { total: 0 };
/** Milliseconds spent in the document API and in WhatsApp, for an average over the lifetime. */
const documentApiMs = { total: 0, count: 0 };
const whatsappMs = { total: 0, count: 0 };

export function recordJobClaimed(): void {
  claimed.total += 1;
}

export function recordJobSent(apiMs: number | null, sendMs: number | null): void {
  sent.total += 1;
  if (apiMs !== null && apiMs >= 0) {
    documentApiMs.total += apiMs;
    documentApiMs.count += 1;
  }
  if (sendMs !== null && sendMs >= 0) {
    whatsappMs.total += sendMs;
    whatsappMs.count += 1;
  }
}

/** `retryScheduled` distinguishes "will try again" from "given up", which alert on differently. */
export function recordJobFailed(code: string, retryScheduled: boolean): void {
  if (retryScheduled) {
    retried.total += 1;
    return;
  }
  failedByCode.set(code, (failedByCode.get(code) ?? 0) + 1);
}

export function recordDuplicatePrevented(): void {
  duplicatesPrevented.total += 1;
}

export interface JobMetricsSnapshot {
  claimed: number;
  sent: number;
  retried: number;
  duplicatesPrevented: number;
  failedByCode: ReadonlyMap<string, number>;
  averageDocumentApiMs: number | null;
  averageWhatsAppMs: number | null;
}

export function getJobMetrics(): JobMetricsSnapshot {
  return {
    claimed: claimed.total,
    sent: sent.total,
    retried: retried.total,
    duplicatesPrevented: duplicatesPrevented.total,
    failedByCode: new Map(failedByCode),
    averageDocumentApiMs: documentApiMs.count ? Math.round(documentApiMs.total / documentApiMs.count) : null,
    averageWhatsAppMs: whatsappMs.count ? Math.round(whatsappMs.total / whatsappMs.count) : null,
  };
}

/** Test-only: counters are process-lifetime, so a suite asserting on them must start clean. */
export function resetJobMetrics(): void {
  claimed.total = 0;
  sent.total = 0;
  retried.total = 0;
  duplicatesPrevented.total = 0;
  failedByCode.clear();
  documentApiMs.total = documentApiMs.count = 0;
  whatsappMs.total = whatsappMs.count = 0;
}
