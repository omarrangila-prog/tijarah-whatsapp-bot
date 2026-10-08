import { detectIntent } from './mock-reasoning.provider';

/**
 * Asking for an invoice or a voucher by number, in chat.
 *
 * Opened up on 8 October 2026. What makes it safe is NOT anything in this file: the company
 * comes from the asking number's own registration, applied inside RequestAccountingReport,
 * so a number in a message can only ever address that client's own books. What is tested
 * here is that the right document and the right number are read out of what people type.
 */
describe('a document asked for by number', () => {
  const doc = (text: string) => {
    const intent = detectIntent(text);
    if (intent.kind !== 'document') throw new Error(`expected a document intent, got ${intent.kind}`);
    return intent;
  };

  it('reads each of the seven types with its number', () => {
    expect(doc('sale invoice 179')).toMatchObject({ documentType: 'sale_invoice', documentNumber: '179' });
    expect(doc('purchase invoice 12')).toMatchObject({ documentType: 'purchase_invoice', documentNumber: '12' });
    expect(doc('digital invoice 7')).toMatchObject({ documentType: 'digital_invoice', documentNumber: '7' });
    expect(doc('sale return 3')).toMatchObject({ documentType: 'sale_return', documentNumber: '3' });
    expect(doc('purchase return 5')).toMatchObject({ documentType: 'purchase_return', documentNumber: '5' });
    expect(doc('payment voucher 9')).toMatchObject({ documentType: 'payment_voucher', documentNumber: '9' });
    expect(doc('receive voucher 54')).toMatchObject({ documentType: 'receive_voucher', documentNumber: '54' });
  });

  it('reads a bare "invoice 200" as the sale invoice a business means by it', () => {
    expect(doc('invoice 200')).toMatchObject({ documentType: 'sale_invoice', documentNumber: '200' });
  });

  it('asks for the number when none was given', () => {
    expect(detectIntent('send me sales invoice').kind).toBe('need_document_number');
    expect(detectIntent('purchase invoice bhejo').kind).toBe('need_document_number');
  });

  describe('a return document is not the return report', () => {
    it('a numbered return is the document', () => {
      // "sale return 3" is return number 3; the period summary is a different document.
      expect(doc('sale return 3').documentType).toBe('sale_return');
      expect(doc('purchase return 5').documentType).toBe('purchase_return');
    });

    it('the word "report" asks for the summary instead', () => {
      const intent = detectIntent('sale return report');
      expect(intent.kind).toBe('report');
      expect(intent.kind === 'report' && intent.documentType).toBe('sale_return_report');
    });

    it('an unnumbered return is the summary, since a specific one would be numbered', () => {
      const intent = detectIntent('sale return');
      expect(intent.kind).toBe('report');
      expect(intent.kind === 'report' && intent.documentType).toBe('sale_return_report');
    });

    it('a misspelled report still reaches the summary', () => {
      const intent = detectIntent('sale retrn report');
      expect(intent.kind).toBe('report');
      expect(intent.kind === 'report' && intent.documentType).toBe('sale_return_report');
    });
  });
});
