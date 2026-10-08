import { detectIntent, parseLineItem, parsePartialLine } from './mock-reasoning.provider';

/**
 * The messages clients sent on 8 October, and what each must now do.
 *
 * Taken verbatim from the live transcript. Each of these was answered with the help list or
 * with "Nothing is waiting on an answer", which tells a person nothing about what was wrong.
 */
describe('messages from the 8 October session', () => {
  describe('a voucher with no kind named', () => {
    it.each(['voucher', 'voucher create karo', 'mujhe daniyal ka voucher do'])('%s asks which kind', text => {
      // There are only two kinds, so asking is one short question rather than a menu.
      expect(detectIntent(text).kind).toBe('which_voucher');
    });

    it('does not interfere once the kind IS named', () => {
      expect(detectIntent('create receive voucher').kind).toBe('create_start');
      expect(detectIntent('receive voucher 54').kind).toBe('need_document_number');
    });
  });

  describe('a numbered line in an invoice', () => {
    it('strips the list numbering people write', () => {
      // "1. 250 cotton fabric at 600" parsed as nothing: the "1." was read as the quantity.
      expect(parseLineItem('1. 250 cotton fabric at 600')).toEqual({
        quantity: '250',
        description: 'cotton fabric',
        rate: '600',
      });
      expect(parseLineItem('2) 10 led bulb at 500')).toEqual({
        quantity: '10',
        description: 'led bulb',
        rate: '500',
      });
    });

    it('still reads a plain line', () => {
      expect(parseLineItem('250 cotton fabric at 600')).toEqual({
        quantity: '250',
        description: 'cotton fabric',
        rate: '600',
      });
    });
  });

  describe('a line with no price', () => {
    it('is recognised so the rate can be asked for', () => {
      expect(parsePartialLine('4pcs led bulb')).toEqual({ quantity: '4', unit: 'pcs', description: 'led bulb' });
      expect(parsePartialLine('led bulb 300pcs')).toEqual({ quantity: '300', unit: 'pcs', description: 'led bulb' });
      expect(parsePartialLine('iphone 5box')).toEqual({ quantity: '5', unit: 'box', description: 'iphone' });
    });

    it('never swallows an answer to another question', () => {
      /*
       * The draft asks for a party and a date before any line, and those answers must not be
       * read as half-finished items — "Usman" would become a product nobody ordered.
       */
      expect(parsePartialLine('Usman')).toBeNull();
      expect(parsePartialLine('today')).toBeNull();
      expect(parsePartialLine('supplier = abdul rafay')).toBeNull();
      // A complete line belongs to parseLineItem, not here.
      expect(parsePartialLine('250 cotton fabric at 600')).toBeNull();
    });
  });
});
