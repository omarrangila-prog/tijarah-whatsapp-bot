import { request } from 'undici';
import { createLogger } from '../../../common/services/logger.service';
import { resolveAuthProfile } from '../providers/auth-profiles';
import { BotUserService } from '../tenancy/bot-user.service';
import { buildEnvelope, findRequestSpec, type TijarahItem } from './tijarah-request';
import type { ApprovalSubmissionPort, ApprovalSubmissionResult } from './approval-submission.port';
import type { DocumentDraft } from './document-draft.entity';

/**
 * Submits a draft to Tijarah's approval screen, in Tijarah's own shape.
 *
 * Separate from the generic HTTP adapter because the host does not accept a flattened draft:
 * it wants the `requestType`/`currentStep`/`requestData` envelope, and it wants the company on
 * every request. The company is **not** stored on the draft — it is looked up from the phone
 * that composed it at the moment of submission, so a person moved to a different company in
 * `bot_users` cannot have a stale draft land on the wrong company's approval screen.
 *
 * `requestStatus` is PENDING, fixed inside `buildEnvelope`. Nothing here can make an entry.
 */
export class TijarahApprovalSubmissionAdapter implements ApprovalSubmissionPort {
  readonly name = 'tijarah';
  private readonly logger = createLogger('ApprovalSubmission');

  constructor(
    private readonly endpoint: string,
    private readonly users: BotUserService,
    private readonly authProfile: string | null = null,
    private readonly timeoutSeconds = 30,
  ) {}

  async submitForApproval(draft: DocumentDraft): Promise<ApprovalSubmissionResult> {
    const spec = findRequestSpec(draft.documentType);
    if (!spec) {
      return {
        ok: false,
        approvalRef: null,
        message: `${draft.displayName} is not a type the accounting system accepts.`,
      };
    }

    const tenant = await this.users.resolve(draft.createdByPhone);
    if (!tenant) {
      // Refusing beats guessing: a default company here would post one client's document
      // onto another client's approval screen.
      return {
        ok: false,
        approvalRef: null,
        message: 'This number is no longer registered with a company, so nothing was submitted.',
      };
    }

    const envelope = buildEnvelope(
      spec,
      { whatsAppNo: draft.createdByPhone, sid: tenant.sid, grp: tenant.grp, aYear: tenant.aYear },
      draft.fields ?? {},
      toTijarahItems(draft),
    );

    const timeoutMs = this.timeoutSeconds * 1000;
    try {
      const res = await request(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...resolveAuthProfile(this.authProfile),
        },
        body: JSON.stringify(envelope),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      const text = await res.body.text().catch(() => '');
      const parsed = safeJson(text);

      /*
       * The host answers 200 with `success: false` for a rejection, so the status code alone
       * is not the answer. Treating that as submitted would tell someone their bill is
       * waiting for approval when the host never recorded it.
       */
      if (res.statusCode >= 400 || parsed?.success === false) {
        const detail = hostError(parsed) ?? `HTTP ${res.statusCode}`;
        this.logger.warn(`${draft.reference} refused by the accounting system: ${detail}`);
        return { ok: false, approvalRef: null, message: `The accounting system refused it: ${detail.slice(0, 140)}` };
      }

      const candidate = parsed?.requestId ?? parsed?.id ?? parsed?.approvalId ?? parsed?.reference;
      const approvalRef = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : null;

      this.logger.log(`${draft.reference} submitted for approval${approvalRef ? ` as request ${approvalRef}` : ''}`);
      return {
        ok: true,
        approvalRef,
        message: approvalRef
          ? `Submitted. It is request #${approvalRef} on the approval screen.`
          : 'Submitted. It is waiting on the approval screen.',
      };
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

/** Draft lines carry text; the host wants numbers and a code per line. */
function toTijarahItems(draft: DocumentDraft): TijarahItem[] {
  return (draft.lineItems ?? []).map(line => ({
    name: line.description,
    // `NEW` is how the specification expresses "this item does not exist yet".
    code: 'NEW',
    qty: Number(String(line.quantity).replace(/[,\s]/g, '')) || 0,
    rate: Number(String(line.rate).replace(/[,\s]/g, '')) || 0,
    uom: 'PCS',
  }));
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The host's own words for a refusal.
 *
 * Two shapes: `{success:false, message}` for its own rejections, and ASP.NET's RFC 9110
 * problem document — `{errors:{RequestType:["RequestType must be 'SALE'…"]}}` — for a
 * validation failure. Reading only the first turned *"RequestType must be 'SALE', 'PURCHASE',
 * 'PARTY', or 'ITEM'"* into a bare "HTTP 400", which says nothing to the person who composed
 * the document and nothing to whoever has to fix it.
 */
export function hostError(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null;
  if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();

  const errors = parsed.errors;
  if (errors && typeof errors === 'object') {
    const messages = Object.values(errors as Record<string, unknown>)
      .flatMap((value): unknown[] => (Array.isArray(value) ? (value as unknown[]) : [value]))
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (messages.length) return messages.join(' ');
  }
  return typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
}
