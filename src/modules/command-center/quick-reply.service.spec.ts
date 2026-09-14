import { normalizeShortcut } from './quick-reply.service';

describe('normalizeShortcut', () => {
  it('strips the leading slash the composer supplies', () => {
    expect(normalizeShortcut('/price')).toBe('price');
    expect(normalizeShortcut('//price')).toBe('price');
  });

  it('lowercases so /Price and /price cannot both exist', () => {
    expect(normalizeShortcut('Price')).toBe('price');
  });

  it('drops characters that would not survive a round trip through the composer', () => {
    expect(normalizeShortcut('follow up!')).toBe('followup');
    expect(normalizeShortcut('order_status-2')).toBe('order_status-2');
  });

  it('bounds the length', () => {
    expect(normalizeShortcut('a'.repeat(100))).toHaveLength(40);
  });
});
