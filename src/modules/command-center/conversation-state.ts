import { ConversationStatus } from './entities/conversation.entity';

/**
 * The conversation state machine, kept pure so the transitions are readable in one place and
 * testable without a database.
 *
 * OPEN     — needs an agent's attention.
 * WAITING  — an agent has replied; the ball is with the customer.
 * RESOLVED — closed.
 *
 * The two automatic transitions are deliberate and are the only ones the system makes on its own:
 * a customer message always reopens (nobody wants a resolved thread to silently swallow a reply),
 * and an agent reply moves an open thread to WAITING so the "Waiting" filter means something
 * without an operator having to remember to set it. Everything else is an explicit operator action.
 */

/**
 * A customer message arrived. WAITING and RESOLVED both return to OPEN; OPEN stays OPEN — so the
 * answer does not depend on the current status, and the function deliberately takes none.
 */
export function nextStatusOnInbound(): ConversationStatus {
  return ConversationStatus.OPEN;
}

/**
 * An agent (or an automation acting for one) sent a message.
 *
 * OPEN → WAITING. RESOLVED is left alone: replying inside a resolved thread — a follow-up note, a
 * courtesy message — should not silently reopen it, because the agent did not ask to. WAITING
 * stays WAITING.
 */
export function nextStatusOnOutbound(current: ConversationStatus): ConversationStatus {
  return current === ConversationStatus.OPEN ? ConversationStatus.WAITING : current;
}

/** Max characters kept in the inbox snippet. */
export const PREVIEW_MAX_LENGTH = 240;

/**
 * Build the one-line snippet shown in the conversation list.
 *
 * Media messages must NEVER use their body: for a location that body is a multi-kilobyte base64 map
 * thumbnail, and for other media it is either empty or a caption. So non-text types get a label and
 * fall back to their caption only when there is one worth showing.
 */
export function buildPreview(type: string | undefined, body: string | undefined | null): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  const labels: Record<string, string> = {
    image: '📷 Photo',
    video: '🎥 Video',
    audio: '🎵 Audio',
    voice: '🎤 Voice message',
    document: '📄 Document',
    sticker: '🌟 Sticker',
    location: '📍 Location',
    contact: '👤 Contact',
    poll: '📊 Poll',
    call: '📞 Call',
    revoked: '🚫 Message deleted',
  };

  if (type && type !== 'text') {
    // An unrecognised type still describes a real message. Falling through to the body would return
    // an empty preview for it (media types carry no text), and the inbox would then render "No
    // messages yet" over a conversation that just received one — a false statement about the data.
    const label = labels[type] ?? '💬 Message';
    // A caption is genuinely useful context, but only for the kinds that can carry one — a location
    // body is the thumbnail, never a caption.
    const captionable = type === 'image' || type === 'video' || type === 'document';
    const caption = captionable && text ? ` · ${text}` : '';
    return truncate(`${label}${caption}`);
  }
  // A text message with no body says nothing useful; the caller distinguishes this from "no
  // messages at all" by checking lastMessageAt, which is null only in the latter case.
  return truncate(text);
}

function truncate(value: string): string {
  return value.length > PREVIEW_MAX_LENGTH ? `${value.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : value;
}

/**
 * Interpolate `{{variable}}` placeholders in quick-reply and broadcast copy.
 *
 * An UNKNOWN placeholder is left verbatim rather than replaced with an empty string: silently
 * sending "Hi , your order  ships today" to a customer is worse than showing the agent an
 * unresolved `{{order_id}}` they can fix before pressing send. Matching is case-insensitive and
 * tolerates whitespace inside the braces.
 */
export function interpolate(template: string, variables: Record<string, string | null | undefined>): string {
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined && value !== '') lookup.set(key.toLowerCase(), value);
  }
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) => {
    return lookup.get(name.toLowerCase()) ?? match;
  });
}

/** Every placeholder present in a template, lowercased and de-duplicated, in order of appearance. */
export function extractVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const name = match[1].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Normalize a WhatsApp id into the key customer profiles are stored under, so the same person
 * reached through two different sessions resolves to ONE profile.
 *
 * Only the user dialects are collapsed (`@c.us` / `@s.whatsapp.net` → `@c.us`). An `@lid` privacy
 * id is NOT rewritten into `<digits>@c.us`: a LID's digits are not a phone number, and minting one
 * would merge two unrelated people whose identifiers happen to collide. Groups and channels are
 * returned verbatim.
 */
export function normalizeWaId(waId: string): string {
  const trimmed = waId.trim();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) {
    // A bare number — treat it as a phone in the canonical user dialect.
    const digits = trimmed.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : trimmed;
  }
  const user = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (domain === 's.whatsapp.net' || domain === 'c.us') {
    // Drop any device/agent suffix (`12345:6@s.whatsapp.net`) so one person is one key.
    return `${user.split(':')[0]}@c.us`;
  }
  return `${user}@${domain}`;
}

/** The MSISDN digits behind a WhatsApp id, or null when the id is not a phone-based one. */
export function phoneFromWaId(waId: string): string | null {
  const normalized = normalizeWaId(waId);
  if (!normalized.endsWith('@c.us')) return null;
  const digits = normalized.slice(0, -'@c.us'.length).replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

/** Minutes between two instants, or null when either is missing. Never negative. */
export function minutesBetween(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / 60000;
}
