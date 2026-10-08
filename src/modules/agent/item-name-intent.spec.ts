import { detectIntent } from './mock-reasoning.provider';

/**
 * An item named in an item-ledger request.
 *
 * Answerable only since 8 October 2026, when `GetBotItems` began returning a code AND a name.
 * Before that the item segment of the endpoint was hard-coded to "all", so a person asking
 * for one product received the whole catalogue — the same class of mistake as a named
 * customer being answered with the whole book.
 */
describe('an item named in an item-ledger request', () => {
  const intentFor = (text: string) => {
    const intent = detectIntent(text);
    if (intent.kind !== 'report') throw new Error(`expected a report intent, got ${intent.kind}`);
    return intent;
  };

  it('reads the product out of both word orders', () => {
    // The Roman Urdu order is what a real client used on 7 October.
    expect(intentFor('Vaseline gluta glow ka item ledger bhejo').itemName).toBe('Vaseline gluta glow');
    expect(intentFor('Blue Shirt ka item ledger').itemName).toBe('Blue Shirt');
    expect(intentFor('item ledger of Product A').itemName).toBe('Product A');
  });

  it('keeps a trailing letter or digit, which is part of the product name', () => {
    // Filtering every stop word turned "Product A" into "Product", which matches no item.
    expect(intentFor('item ledger of Product A').itemName).toBe('Product A');
    expect(intentFor('item ledger for Item 2').itemName).toBe('Item 2');
  });

  it('asks for the whole catalogue only when no product was named', () => {
    expect(intentFor('item ledger').itemName).toBeNull();
    expect(intentFor('mujhe item ledger do').itemName).toBeNull();
  });

  it('routes the item ledger to the item, and every other ledger to the party', () => {
    // The name in front of "ka item ledger" is a PRODUCT; in front of "ka ledger" it is a party.
    const item = intentFor('Blue Shirt ka item ledger');
    expect(item.documentType).toBe('item_ledger');
    expect(item.partyName).toBeNull();

    const party = intentFor('Danyal ka ledger bhejo');
    expect(party.itemName).toBeNull();
    expect(party.partyName).toBe('Danyal');
  });
});
