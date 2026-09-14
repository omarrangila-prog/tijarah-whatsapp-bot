/**
 * Deterministic avatar identity.
 *
 * The colour is hashed from a stable seed (a chat id, an agent id) rather than from the display
 * name, so a person keeps the same colour when their name changes or is missing — the tint is a
 * recognition aid, and one that shifts under you is worse than none.
 */

const AVATAR_COLORS = [
  '#0ea5e9',
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#0891b2',
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Up to two initials from a display name; the fallback covers an unnamed contact. */
export function initials(name: string | null | undefined, fallback = '?'): string {
  const cleaned = (name ?? '').trim();
  if (!cleaned) return fallback;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
