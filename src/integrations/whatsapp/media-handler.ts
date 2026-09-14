import { Injectable } from '@nestjs/common';
import { basename, extname } from 'node:path';
import type { OutboundAttachment } from './agent-message.types';

/**
 * Validation and naming for anything that crosses the channel as a file.
 *
 * Two directions, two different worries.
 *
 * **Outbound**, the worry is leakage. A filename is the one piece of internal state that
 * routinely escapes into a customer's chat, and `/srv/app/storage/tenant-4/statements/…`
 * tells a stranger the deployment layout, the tenancy scheme and roughly what else is on
 * the disk. Every outgoing name is therefore rebuilt from scratch rather than sanitised —
 * sanitising keeps whatever the caller passed and only removes what was thought of.
 *
 * **Inbound**, the worry is that an attachment is untrusted input that a model may end up
 * reading. Size and type are bounded before anything is fetched, and a document's text is
 * fenced like any other untrusted content when it reaches the agent.
 */

/** Types a customer may usefully send and the agent may safely look at. */
const ALLOWED_INBOUND_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'text/plain',
]);

/** Types the agent may send. Deliberately narrower than what it will accept. */
const ALLOWED_OUTBOUND_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const MAX_INBOUND_BYTES = 16 * 1024 * 1024;
const MAX_OUTBOUND_BYTES = 16 * 1024 * 1024;

export interface MediaVerdict {
  ok: boolean;
  reason: string | null;
}

@Injectable()
export class MediaHandler {
  acceptInbound(mimeType: string | null, byteSize: number | null): MediaVerdict {
    if (byteSize !== null && byteSize > MAX_INBOUND_BYTES) {
      return { ok: false, reason: 'That file is too large for me to look at.' };
    }
    if (mimeType && !ALLOWED_INBOUND_MIME.has(mimeType.split(';')[0].trim().toLowerCase())) {
      return { ok: false, reason: 'I can only read images, PDFs, plain text and voice notes.' };
    }
    return { ok: true, reason: null };
  }

  validateOutbound(attachment: OutboundAttachment): MediaVerdict {
    const mime = attachment.mimeType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_OUTBOUND_MIME.has(mime)) {
      return { ok: false, reason: `Refusing to send a ${mime} file over WhatsApp.` };
    }
    // base64 expands by 4/3; comparing the encoded length is close enough to bound it.
    const approximateBytes = /^https?:\/\//i.test(attachment.data) ? 0 : Math.floor((attachment.data.length * 3) / 4);
    if (approximateBytes > MAX_OUTBOUND_BYTES) {
      return { ok: false, reason: 'That document is too large to send over WhatsApp.' };
    }
    if (!/^https?:\/\//i.test(attachment.data) && attachment.data.includes('/')) {
      /*
       * A filesystem path where the payload should be.
       *
       * Caught here rather than trusted, because sending one would either leak the path in
       * an error or, worse, succeed on a host where the engine can read the disk — turning
       * "send Ali his statement" into an arbitrary file read.
       */
      return { ok: false, reason: 'Attachment data must be a URL or base64, never a file path.' };
    }
    return { ok: true, reason: null };
  }

  /**
   * A filename safe to put in front of a customer.
   *
   * Rebuilt, not cleaned: take the extension, take a slug of the label the business chose,
   * and discard everything else the caller supplied. There is no path separator, no
   * traversal sequence and no internal identifier that can survive this, because none of
   * the input does.
   */
  safeFileName(label: string, originalName: string, fallbackExtension = '.pdf'): string {
    const extension = (extname(basename(originalName || '')) || fallbackExtension).toLowerCase().slice(0, 8);
    const slug =
      label
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 48) || 'document';
    return `${slug}${/^\.[a-z0-9]+$/.test(extension) ? extension : fallbackExtension}`;
  }
}
