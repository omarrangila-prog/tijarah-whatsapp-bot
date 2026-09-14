import { buildCaption, renderTemplate, formatPeriod, customerReference, DEFAULT_CAPTIONS } from './caption';

/**
 * The note a customer reads above their document.
 *
 * Most of what matters here is what happens when a fact is missing: a contact with no name, a
 * ledger with no period. The template must degrade into something a company would be happy to
 * have sent, not into "Dear ," — which is the sort of detail that makes a business look
 * careless in the one message about someone's money.
 */
describe('document captions', () => {
  beforeEach(() => {
    process.env.WHATSAPP_BUSINESS_NAME = 'Odoovations';
  });
  afterEach(() => {
    delete process.env.WHATSAPP_BUSINESS_NAME;
  });

  it('writes a complete note when every fact is present', () => {
    const caption = buildCaption('sale_invoice', {
      displayName: 'Sale Invoice',
      documentNumber: '103',
      reference: 'SL/1006/GR/2026/103',
      recipientName: 'Ali Traders',
    });

    expect(caption).toContain('*Sale Invoice 103*');
    expect(caption).toContain('Dear Ali Traders,');
    // Shortened for the reader: the company, branch and year are ours, not theirs.
    expect(caption).toContain('_Ref: SL-103_');
    expect(caption).toContain('Odoovations');
  });

  it('drops the greeting entirely when the contact has no name', () => {
    const caption = buildCaption('sale_invoice', { displayName: 'Sale Invoice', documentNumber: '104' });

    // "Dear ," is worse than opening with the sentence.
    expect(caption).not.toMatch(/Dear\s*,/);
    expect(caption).not.toContain('undefined');
    expect(caption).toContain('Your invoice is attached.');
  });

  it('drops the period line when a ledger has no dates', () => {
    const caption = buildCaption('general_ledger', { displayName: 'General Ledger', recipientName: 'Ali Traders' });

    expect(caption).not.toContain('Period:');
    // And leaves no hole where the line used to be.
    expect(caption).not.toMatch(/\n{3,}/);
  });

  it('writes the period the way a person would', () => {
    expect(formatPeriod('2026-01-01', '2026-12-31')).toBe('1 Jan 2026 to 31 Dec 2026');
    expect(formatPeriod('2026-01-01', null)).toBe('1 Jan 2026');
    expect(formatPeriod(null, null)).toBeNull();
    // An unparseable date is shown as given rather than as "Invalid Date".
    expect(formatPeriod('whenever', null)).toBe('whenever');
  });

  it('thanks a customer but not a supplier', () => {
    const customer = buildCaption('sale_invoice', { displayName: 'Sale Invoice', documentNumber: '1' });
    const supplier = buildCaption('purchase_invoice', { displayName: 'Purchase Invoice', documentNumber: '1' });

    /*
     * Thanking a supplier "for your business" on a document you sent THEM reads as a company
     * that does not know who it is writing to.
     */
    expect(customer).toContain('Thank you for your business.');
    expect(supplier).not.toContain('for your business');
  });

  it('confirms the money arrived on a receipt', () => {
    const receipt = buildCaption('receive_voucher', { displayName: 'Receive Voucher', documentNumber: '58' });
    expect(receipt).toContain('payment has been received');
    // "Receive Voucher" is internal vocabulary; a customer calls it a receipt.
    expect(receipt).toContain('*Receipt 58*');
  });

  it('honours a template the business wrote itself', () => {
    const caption = buildCaption(
      'sale_invoice',
      { displayName: 'Sale Invoice', documentNumber: '9', recipientName: 'Ali' },
      '*Invoice {documentNumber}*\n{greeting}\nAttached.',
    );
    expect(caption).toBe('*Invoice 9*\nDear Ali,\nAttached.');
  });

  it('omits the business name when none is configured, rather than inventing one', () => {
    delete process.env.WHATSAPP_BUSINESS_NAME;
    const caption = buildCaption('sale_invoice', { displayName: 'Sale Invoice', documentNumber: '1' });

    expect(caption).not.toContain('undefined');
    expect(caption.trimEnd()).toMatch(/Thank you for your business\.$/);
  });

  it('stays within what WhatsApp will carry', () => {
    const caption = buildCaption('sale_invoice', {
      displayName: 'X'.repeat(400),
      documentNumber: 'Y'.repeat(400),
      reference: 'Z'.repeat(400),
      recipientName: 'W'.repeat(400),
    });
    // A caption WhatsApp truncates would cut mid-sentence in front of a customer.
    expect(caption.length).toBeLessThanOrEqual(1024);
  });

  it('has a default for every document type that is delivered', () => {
    for (const type of [
      'sale_invoice',
      'digital_invoice',
      'purchase_invoice',
      'sale_return',
      'purchase_return',
      'payment_voucher',
      'receive_voucher',
      'general_ledger',
      'customer_ledger',
      'vendor_ledger',
      'expense_ledger',
    ]) {
      expect(DEFAULT_CAPTIONS[type]).toBeDefined();
    }
  });

  it('never shows a customer the shape of our API', () => {
    /*
     * The host identifies a document as SL/1006/GR/2026/103. Printed verbatim that reads as an
     * internal URL and tells the recipient about our systems rather than their invoice.
     */
    expect(customerReference('SL/1006/GR/2026/103')).toBe('SL-103');
    expect(customerReference('DINV/1006/GR/2026/7')).toBe('DINV-7');
    // Already clean: left alone.
    expect(customerReference('INV-1001')).toBe('INV-1001');
    // A link has no business in a caption at all.
    expect(customerReference('https://api.tijarabooks.com/internal/pdf/SL/1')).toBeNull();
    expect(customerReference(null)).toBeNull();
  });

  it('puts no endpoint in the message, however the reference arrives', () => {
    const caption = buildCaption('sale_invoice', {
      displayName: 'Sale Invoice',
      documentNumber: '103',
      reference: 'SL/1006/GR/2026/103',
      recipientName: 'Ali Traders',
    });

    expect(caption).toContain('_Ref: SL-103_');
    expect(caption).not.toContain('/1006/');
    expect(caption).not.toMatch(/https?:\/\//);
    expect(caption).not.toContain('internal');
  });

  it('never leaves an unresolved placeholder in front of a customer', () => {
    const rendered = renderTemplate('*{displayName}*\n{missing}\nEnd.', { displayName: 'Invoice' });
    expect(rendered).not.toContain('{');
    expect(rendered).toBe('*Invoice*\nEnd.');
  });
});
