import { request } from 'undici';
import { createLogger } from '../../../common/services/logger.service';
import { resolveAuthProfile } from '../providers/auth-profiles';
import type { DocumentDraft } from './document-draft.entity';

/**
 * The one thing Phase Three is allowed to do to the accounting system.
 *
 * The specification is explicit and repeats it for all twelve types: a document created over
 * WhatsApp must "appear in Approval Screen on Tijarah Books" and must "not make final entry".
 * That constraint is expressed here as the shape of the interface rather than as a rule
 * somebody has to remember — there is exactly one verb, it is named for what it does, and
 * there is no method on this port that posts an entry.
 *
 * An adapter that pointed this at an endpoint which finalises would be a bug of the most
 * serious kind available in this system: money moved on a customer's account from a chat
 * message, with nobody having approved it.
 */
export interface ApprovalSubmissionPort {
  readonly name: string;
  /** Creates a PENDING record awaiting human approval. Never an accounting entry. */
  submitForApproval(draft: DocumentDraft): Promise<ApprovalSubmissionResult>;
}

export interface ApprovalSubmissionResult {
  ok: boolean;
  /** The host's id for the pending record, so the two systems can be reconciled. */
  approvalRef: string | null;
  /** Safe to show the person who composed the draft. */
  message: string;
}

export const APPROVAL_SUBMISSION_PORT = Symbol('APPROVAL_SUBMISSION_PORT');

/** The payload sent to the host: the draft, flattened, with nothing internal attached. */
export function toSubmissionPayload(draft: DocumentDraft): Record<string, unknown> {
  return {
    documentType: draft.documentType.replace(/^create_/, ''),
    displayName: draft.displayName,
    reference: draft.reference,
    createdBy: draft.createdByPhone,
    fields: draft.fields ?? {},
    lineItems: draft.lineItems ?? [],
    /*
     * Stated in the payload as well as implied by the endpoint.
     *
     * If the host ever routes on it, this says plainly what is being asked for; if it ignores
     * it, nothing is lost. Belt and braces on the one property that matters.
     */
    status: 'PENDING_APPROVAL',
    finalise: false,
  };
}

/**
 * Records submissions instead of sending them.
 *
 * The default, and it stays the default until a real approval endpoint exists. Phase Three
 * can be demonstrated end to end against this — a person composes a document in chat, reviews
 * it, submits it, and sees it accepted — without anything reaching the accounting system.
 */
export class MockApprovalSubmissionAdapter implements ApprovalSubmissionPort {
  readonly name = 'mock';
  private readonly logger = createLogger('MockApprovalSubmission');
  /** Everything "submitted", newest last. Assertions and the drafts screen read this. */
  readonly submitted: Array<{ at: string; reference: string; payload: Record<string, unknown> }> = [];

  submitForApproval(draft: DocumentDraft): Promise<ApprovalSubmissionResult> {
    const payload = toSubmissionPayload(draft);
    this.submitted.push({ at: new Date().toISOString(), reference: draft.reference, payload });
    this.logger.log(`recorded ${draft.displayName} ${draft.reference} for approval (nothing was sent)`);
    return Promise.resolve({
      ok: true,
      // Prefixed so a recorded submission can never be mistaken for a real approval id.
      approvalRef: `mock.approval.${draft.reference}`,
      message: 'Recorded for approval. Nothing was sent to the accounting system.',
    });
  }
}

/**
 * Posts a draft to the host's approval endpoint.
 *
 * Used once `DRAFT_SUBMIT_ENDPOINT` is configured. The endpoint must be the one that creates a
 * PENDING record — this adapter has no way to verify that, which is exactly why the setting is
 * separate, deliberate, and documented as the approval endpoint rather than a generic create.
 */
export class HttpApprovalSubmissionAdapter implements ApprovalSubmissionPort {
  readonly name = 'http';
  private readonly logger = createLogger('ApprovalSubmission');

  constructor(
    private readonly endpoint: string,
    private readonly authProfile: string | null,
    private readonly timeoutSeconds = 30,
  ) {}

  async submitForApproval(draft: DocumentDraft): Promise<ApprovalSubmissionResult> {
    const timeoutMs = this.timeoutSeconds * 1000;
    try {
      const res = await request(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...resolveAuthProfile(this.authProfile),
        },
        body: JSON.stringify(toSubmissionPayload(draft)),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const text = await res.body.text().catch(() => '');
      if (res.statusCode >= 400) {
        return { ok: false, approvalRef: null, message: `The accounting system refused it (${res.statusCode}).` };
      }

      let approvalRef: string | null = null;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const candidate = parsed.id ?? parsed.ID ?? parsed.approvalId ?? parsed.reference;
        // Only a scalar is an id. An object here means the host answered with a shape we do
        // not understand, and "[object Object]" recorded as an approval reference is worse
        // than admitting we do not know it.
        approvalRef = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : null;
      } catch {
        // A non-JSON success is still a success; the reference is simply unknown.
      }

      this.logger.log(`${draft.reference} submitted for approval${approvalRef ? ` as ${approvalRef}` : ''}`);
      return { ok: true, approvalRef, message: 'Submitted. It is waiting on the approval screen.' };
    } catch (error) {
      const detail = (error as Error).message ?? 'unreachable';
      return {
        ok: false,
        approvalRef: null,
        message: `Could not reach the accounting system: ${detail.slice(0, 140)}`,
      };
    }
  }
}

export function readSubmissionEndpoint(env: NodeJS.ProcessEnv = process.env): {
  endpoint: string | null;
  authProfile: string | null;
} {
  return {
    endpoint: env.DRAFT_SUBMIT_ENDPOINT?.trim() || null,
    authProfile: env.DRAFT_SUBMIT_AUTH_PROFILE?.trim() || null,
  };
}
