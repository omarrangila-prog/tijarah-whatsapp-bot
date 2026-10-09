/**
 * Matching a name a person typed against the names the business uses for its customers.
 *
 * Pure, and separate from the lookup that reads them, because the rules are the subtle part:
 * what counts as a match, and — more importantly — when two customers are close enough that
 * the bot must ask rather than choose. Picking one sends somebody another customer's ledger.
 */

/** One remembered customer, as the directory holds it. */
export interface PartyCandidate {
  name: string;
  phone: string;
  lcode: string | null;
}

export type PartyMatch =
  { kind: 'one'; party: PartyCandidate } | { kind: 'several'; parties: PartyCandidate[] } | { kind: 'none' };

/**
 * Comparison form: lower case, punctuation gone, runs of space collapsed.
 *
 * The business writes "DANYAL BHAI - (KAUSAR INNOVATIONS)" and a person types "danyal bhai",
 * so the brackets, the dash and the case cannot be part of the comparison.
 */
export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The words of a name, for the word-prefix rule below. */
function words(value: string): string[] {
  const n = normaliseName(value);
  return n ? n.split(' ') : [];
}

/**
 * How well a query matches one name: 3 exact, 2 a whole word, 1 a word's start, 0 no match.
 *
 * Ranked rather than boolean so an exact match wins outright over customers who merely
 * contain the same word — "cash customer" should not be ambiguous with "cash customer 2".
 * A bare substring (anywhere, mid-word) deliberately does not match: "ali" would otherwise
 * hit "Khalid Ali Traders" and "Pakistan Formica Limited" alike through "ali" in "Pakistani".
 */
export function scoreName(query: string, candidate: string): number {
  const q = normaliseName(query);
  const c = normaliseName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 3;

  const qw = words(q);
  const cw = words(c);
  // Every word the person typed has to appear, so "danyal kausar" does not match a
  // "Danyal Traders" who has nothing to do with Kausar.
  const all = (test: (queryWord: string, candidateWord: string) => boolean): boolean =>
    qw.every(word => cw.some(candidateWord => test(word, candidateWord)));

  if (all((a, b) => a === b)) return 2;
  if (all((a, b) => b.startsWith(a))) return 1;
  return 0;
}

/**
 * The customer a person meant, or the shortlist to ask about.
 *
 * Only the best tier is considered: an exact match is the answer even when weaker ones exist.
 * Within a tier, several distinct customers is a question, never a guess — except where they
 * are plainly the same customer (one account code, or one phone), which is a spelling
 * difference rather than an ambiguity.
 */
export function matchParty(query: string, candidates: PartyCandidate[]): PartyMatch {
  const scored = candidates
    .map(party => ({ party, score: scoreName(query, party.name) }))
    .filter(entry => entry.score > 0);
  if (scored.length === 0) return { kind: 'none' };

  const best = Math.max(...scored.map(entry => entry.score));
  const top = scored.filter(entry => entry.score === best).map(entry => entry.party);

  const codes = new Set(top.map(party => party.lcode).filter((code): code is string => code !== null));
  /*
   * Only REAL phone numbers count as evidence of one party.
   *
   * The host's chart carries plenty of accounts with no phone at all — "-", "_", "0", blank —
   * and treating those as a shared number made ALI GENERAL STORE and ALI TRADERS look like
   * one customer, so "Ali ka ledger" silently sent the first of them. Two accounts with no
   * phone are two accounts; the question gets asked.
   */
  const phones = new Set(top.map(party => party.phone).filter(phone => phone && /\d/.test(phone)));
  const sameParty = codes.size === 1 && top.every(party => party.lcode !== null);
  // One real number shared by every candidate: the same person, spelled differently. A
  // candidate with no number at all cannot corroborate that, so all of them must carry one.
  const onePhone = phones.size === 1 && top.every(party => party.phone && /\d/.test(party.phone));
  if (top.length === 1 || sameParty || onePhone) {
    // Prefer a row that already carries the account code: it is the one a ledger can be fetched with.
    return { kind: 'one', party: top.find(party => party.lcode !== null) ?? top[0] };
  }
  return { kind: 'several', parties: top };
}

/**
 * Abbreviations people type for whole names. Expanded before comparing, so "mohd ali" can be
 * offered MUHAMMAD ALI. Only unambiguous ones: a lone "m" or "sh" could be many names.
 */
const NAME_ABBREVIATIONS: Record<string, string> = {
  mohd: 'muhammad',
  muhd: 'muhammad',
  mhd: 'muhammad',
  md: 'muhammad',
  abd: 'abdul',
};

/**
 * How a Roman Urdu word sounds, as a comparison key.
 *
 * The same name reaches the bot spelled many ways — DANYAL / daniyal / daniyaal, MUHAMMAD /
 * mohammad / mohammed, REHMAN / rahman, KHUZEMA / khuzaima, CURRIER / courier. They differ in
 * vowels, doubled letters and a few letter pairs, so the key keeps the first sound (any leading
 * vowel counts as one), folds the interchangeable letters (ph/f, q/k, v/w), squeezes doubles and
 * drops the vowels after the first letter.
 */
export function soundKey(word: string): string {
  let w = normaliseName(word).replace(/[^a-z]/g, '');
  w = NAME_ABBREVIATIONS[w] ?? w;
  if (w.length < 3) return w;
  w = w
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/v/g, 'w')
    .replace(/(.)\1+/g, '$1');
  const lead = /^[aeiouy]/.test(w) ? 'a' : w[0];
  return lead + w.slice(1).replace(/[aeiouy]/g, '');
}

/** Levenshtein distance, giving up (returning limit + 1) once it is clearly beyond `limit`. */
export function editDistance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * How closely one typed word matches one word of a name: 3 the same word, 2 the same sound
 * (a Roman Urdu spelling variant), 1 a typo away, 0 different.
 *
 * Used only to SUGGEST names when nothing matched outright — a suggestion is a question the
 * person answers, never a ledger sent on a guess. Short words must match exactly: at three
 * letters, "ali" and "adi" are different people, not a typo.
 */
export function wordSimilarity(typed: string, name: string): number {
  const a = NAME_ABBREVIATIONS[normaliseName(typed)] ?? normaliseName(typed);
  const b = normaliseName(name);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.length < 4 || b.length < 4) return 0;
  if (soundKey(a) === soundKey(b)) return 2;
  const allowed = Math.min(a.length, b.length) >= 7 ? 2 : 1;
  return editDistance(a, b, allowed) <= allowed ? 1 : 0;
}
