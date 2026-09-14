import { sanitizeCustomFields } from './customer.service';

describe('sanitizeCustomFields', () => {
  it('keeps well-formed keys and stringifies values', () => {
    expect(sanitizeCustomFields({ 'Order Number': 'A-1183', Quantity: 500 })).toEqual({
      'Order Number': 'A-1183',
      Quantity: '500',
    });
  });

  it('drops keys that are not identifier-like', () => {
    // A malformed import must not turn a profile into an unreadable blob.
    expect(sanitizeCustomFields({ '<script>': 'x', 'ok key': 'y' })).toEqual({ 'ok key': 'y' });
  });

  it('drops null and undefined values', () => {
    expect(sanitizeCustomFields({ a: null, b: undefined, c: 'kept' })).toEqual({ c: 'kept' });
  });

  it('bounds the number of keys and the value length', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, 'v']));
    expect(Object.keys(sanitizeCustomFields(many) ?? {})).toHaveLength(30);
    expect(sanitizeCustomFields({ long: 'x'.repeat(2000) })?.long).toHaveLength(500);
  });

  it('returns null for nothing usable', () => {
    expect(sanitizeCustomFields(null)).toBeNull();
    expect(sanitizeCustomFields({})).toBeNull();
    expect(sanitizeCustomFields({ '!!': 'x' })).toBeNull();
  });
});
