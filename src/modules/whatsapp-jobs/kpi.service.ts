import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { DocumentTypeRegistry } from './entities/document-type-registry.entity';
import { isRetryable } from './job-status';

export interface DocumentTypeKpi {
  documentType: string;
  displayName: string;
  received: number;
  completed: number;
  failed: number;
  successRatePercent: number | null;
  /** Failures caused by the request or the data, which no retry could have fixed. */
  undeliverable: number;
  /**
   * Success over the jobs the system was actually responsible for.
   *
   * `successRatePercent` counts every failure, including a number that is not on WhatsApp and
   * an invoice that does not exist — neither of which the delivery system can do anything
   * about. Chasing 100% on that figure means chasing other people's data entry. This one
   * excludes them, so it answers the question an operator can act on: is the pipeline itself
   * delivering everything it was given a fair chance to deliver?
   */
  systemSuccessRatePercent: number | null;
  averageDocumentApiMs: number | null;
  averageWhatsAppSendMs: number | null;
  averageEndToEndMs: number | null;
  retryCount: number;
  timeoutCount: number;
  duplicatesPrevented: number;
  targetProcessingSeconds: number;
  targetSuccessRate: number;
  slaCompliancePercent: number | null;
}

/**
 * KPIs per document type, computed from the job rows.
 *
 * Nothing is precomputed or cached. At Phase 1 volumes the arithmetic is cheaper than the
 * cache invalidation would be, and a KPI that can drift from the rows it claims to summarise
 * is worse than no KPI — someone would make a decision on it.
 *
 * The three averages are deliberately separate. "Average processing time" merged across the
 * document API and WhatsApp tells an operator that something is slow but not who to ask.
 */
@Injectable()
export class JobKpiService {
  constructor(
    @InjectRepository(WhatsAppDocumentJob, 'data') private readonly jobs: Repository<WhatsAppDocumentJob>,
    @InjectRepository(DocumentTypeRegistry, 'data') private readonly registry: Repository<DocumentTypeRegistry>,
  ) {}

  async byDocumentType(): Promise<DocumentTypeKpi[]> {
    const [types, allJobs] = await Promise.all([this.registry.find(), this.jobs.find()]);

    const known = new Map(types.map(t => [t.documentType, t]));
    // Include types that only appear on jobs, so a row created before a type was renamed or
    // removed still shows up rather than silently vanishing from the totals.
    for (const job of allJobs) {
      if (!known.has(job.documentType)) {
        known.set(job.documentType, {
          documentType: job.documentType,
          displayName: job.documentType,
          targetProcessingSeconds: 20,
          targetSuccessRate: 99,
          duplicatesPrevented: 0,
        } as DocumentTypeRegistry);
      }
    }

    return [...known.values()].map(type => {
      const rows = allJobs.filter(j => j.documentType === type.documentType);
      const sent = rows.filter(j => j.status === 'SENT');
      const failed = rows.filter(j => j.status === 'FAILED');
      const decided = sent.length + failed.length;

      const undeliverable = failed.filter(j => !isRetryable(j.errorCode));
      const systemFailures = failed.length - undeliverable.length;
      const systemDecided = sent.length + systemFailures;

      /*
       * Both legs are measured from the timeline, not from the job's own columns.
       *
       * `startedAt` is preserved across retries, so measuring the document API from it charged
       * the API for everything in between — including the half-minute an operator spent
       * deciding to press Retry. An 18-second "API response time" that is really human
       * think-time is worse than no number: it sends someone to fix a service that is fine.
       */
      const apiTimes = sent
        .map(j => legFromTimeline(j.timeline, 'FETCHING_DOCUMENT', 'DOCUMENT_RECEIVED'))
        .filter((n): n is number => n !== null);
      const sendTimes = sent
        .map(j => legFromTimeline(j.timeline, 'SENDING_TO_WHATSAPP', 'SENT'))
        .filter((n): n is number => n !== null);
      const endToEnd = sent.map(j => span(j.createdAt, j.completedAt)).filter((n): n is number => n !== null);

      const target = type.targetProcessingSeconds * 1000;
      const withinSla = endToEnd.filter(ms => ms <= target).length;

      return {
        documentType: type.documentType,
        displayName: type.displayName,
        received: rows.length,
        completed: sent.length,
        failed: failed.length,
        successRatePercent: decided ? round((sent.length / decided) * 100) : null,
        undeliverable: undeliverable.length,
        systemSuccessRatePercent: systemDecided ? round((sent.length / systemDecided) * 100) : null,
        averageDocumentApiMs: average(apiTimes),
        averageWhatsAppSendMs: average(sendTimes),
        averageEndToEndMs: average(endToEnd),
        // An attempt beyond the first is a retry, so the count is attempts minus one per row.
        retryCount: rows.reduce((sum, j) => sum + Math.max(0, j.attemptCount - 1), 0),
        timeoutCount: rows.filter(j => j.errorCode === 'DOCUMENT_API_TIMEOUT').length,
        duplicatesPrevented: type.duplicatesPrevented ?? 0,
        targetProcessingSeconds: type.targetProcessingSeconds,
        targetSuccessRate: type.targetSuccessRate,
        slaCompliancePercent: endToEnd.length ? round((withinSla / endToEnd.length) * 100) : null,
      };
    });
  }
}

/**
 * The duration of one stage within the attempt that succeeded.
 *
 * Takes the LAST occurrence of each stage, so a job that failed and was retried is measured
 * over the attempt that worked rather than over its whole troubled history. The end-to-end
 * figure still spans creation to completion, retries included — that one is what the customer
 * actually waited, and the SLA is rightly judged on it.
 */
function legFromTimeline(
  timeline: Array<{ at: string; status: string }> | null,
  from: string,
  to: string,
): number | null {
  if (!timeline?.length) return null;
  const reversed = [...timeline].reverse();
  const start = reversed.find(entry => entry.status === from);
  const end = reversed.find(entry => entry.status === to);
  if (!start || !end) return null;
  const ms = new Date(end.at).getTime() - new Date(start.at).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function span(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
