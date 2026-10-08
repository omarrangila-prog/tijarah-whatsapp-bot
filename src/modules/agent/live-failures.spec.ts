import { detectIntent } from './mock-reasoning.provider';

/**
 * The messages real clients sent on 7 Oct 2026, and what each must now do.
 *
 * Taken verbatim from the live transcript rather than invented, because the gap between what
 * the bot was tested on and what people actually type is the whole problem: every failure
 * below was a message a client sent and got the help list for, or — worse — got the wrong
 * document for. The rule-based path is what answers when no model is configured, so these
 * must hold with no AI at all.
 */
describe('messages real clients sent', () => {
  const kindOf = (text: string) => detectIntent(text).kind;

  describe('worked before, must keep working', () => {
    it.each([
      ['trial balance send', 'trial_balance'],
      ['Trial balance so', 'trial_balance'],
      ['Send me trial balance', 'trial_balance'],
      ['stock summary', 'stock_summary'],
    ])('%s', (text, documentType) => {
      const intent = detectIntent(text);
      expect(intent.kind).toBe('report');
      expect(intent.kind === 'report' && intent.documentType).toBe(documentType);
    });
  });

  describe('a document named in chat', () => {
    it.each([
      ['Send me sales invoice', 'Sale Invoice'],
      ['Daniyal bhai sales invoice', 'Sale Invoice'],
      ['purchase invoice bhejo', 'Purchase Invoice'],
    ])('%s', (text, displayName) => {
      const intent = detectIntent(text);
      expect(intent.kind).toBe('need_document_number');
      expect(intent.kind === 'need_document_number' && intent.displayName).toBe(displayName);
    });

    it('fetches it once the number IS given', () => {
      /*
       * Opened up on 8 October: every registered number is a BUSINESS asking about its own
       * books, and the company comes from that registration rather than the message, so an
       * invoice number can only ever address the asking client's own documents.
       */
      const intent = detectIntent('sale invoice 179');
      expect(intent.kind).toBe('document');
      expect(intent.kind === 'document' && intent.documentNumber).toBe('179');
      expect(intent.kind === 'document' && intent.documentType).toBe('sale_invoice');
    });
  });

  describe('a named party never widens to the whole book', () => {
    it('Anas boltan ka ledger bhejo — the message that sent somebody every account', () => {
      const intent = detectIntent('Anas boltan ka ledger bhejo');
      expect(intent.kind).toBe('report');
      expect(intent.kind === 'report' && intent.partyName).toBe('Anas boltan');
    });
  });

  describe('a named party reaches the ledger that answers for them', () => {
    it('reads the party out of the message so the tool can resolve it', () => {
      // The prefix of the resolved code picks customer_ledger or vendor_ledger; what the
      // intent must carry is the NAME, un-guessed.
      const intent = detectIntent('Zahid ka ledger bhejo');
      expect(intent.kind).toBe('report');
      expect(intent.kind === 'report' && intent.partyName).toBe('Zahid');
      expect(intent.kind === 'report' && intent.documentType).toBe('general_ledger');
    });
  });

  describe('still not understood, and that is correct', () => {
    it.each(['Easy paisa', 'Jazzcash'])('%s falls through to help rather than guessing', text => {
      // Payment-method names mean nothing here; answering with a document would be worse.
      expect(kindOf(text)).toBe('help');
    });
  });
});
