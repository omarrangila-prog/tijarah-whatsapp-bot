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
  const phones = new Set(top.map(party => party.phone));
  const sameParty = codes.size === 1 && top.every(party => party.lcode !== null);
  if (top.length === 1 || sameParty || phones.size === 1) {
    // Prefer a row that already carries the account code: it is the one a ledger can be fetched with.
    return { kind: 'one', party: top.find(party => party.lcode !== null) ?? top[0] };
  }
  return { kind: 'several', parties: top };
}
