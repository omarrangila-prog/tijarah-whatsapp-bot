/**
 * Exact decimal arithmetic on strings, without a library.
 *
 * These are the figures a customer is asked to pay and the amounts written into a client's
 * ledger. Binary floating point has no place near either: `0.1 + 0.2` surfacing as
 * 150000.00000000003 in an invoice is not a rounding curiosity, it is a wrong document.
 *
 * Everything is scaled to fixed-point integers and back, so no precision is lost and no
 * dependency is added to a repository that keeps its runtime dependency list short.
 */

const SCALE = 4;

export function toScaled(value: string | number, scale = SCALE): bigint {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  const magnitude = BigInt(`${whole || '0'}${padded}`);
  return negative ? -magnitude : magnitude;
}

export function fromScaled(value: bigint, scale = SCALE): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function addDecimal(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

/** Never returns a negative: an invoice's outstanding cannot be less than nothing. */
export function subtractDecimal(a: string, b: string): string {
  const result = toScaled(a) - toScaled(b);
  return fromScaled(result < 0n ? 0n : result);
}

export function isPositive(value: string): boolean {
  return toScaled(value) > 0n;
}
