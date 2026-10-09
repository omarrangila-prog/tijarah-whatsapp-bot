import { correctSpelling, damerauLevenshtein } from './spelling';
import { detectIntent } from './mock-reasoning.provider';

/**
 * Misspellings taken from what clients type (and from the live chats), each put right — and the
 * names that must be left exactly as typed.
 */
describe('correctSpelling', () => {
  it.each([
    ['legder bhejo', 'ledger bhejo'],
    ['ledgr bhej do', 'ledger bhej do'],
    ['sale invoce 179', 'sale invoice 179'],
    ['purchse invoice 122', 'purchase invoice 122'],
    ['recivable list', 'receivable list'],
    ['recive voucher 54', 'receive voucher 54'],
    ['payment vochar 12', 'payment voucher 12'],
    ['trial balnce', 'trial balance'],
    ['stock summery', 'stock summary'],
    ['digital invoce 22', 'digital invoice 22'],
    ['income statment', 'income statement'],
  ])('%s → %s', (typed, fixed) => {
    expect(correctSpelling(typed).toLowerCase()).toBe(fixed);
  });

  it.each([
    ['tb bhejo', 'trial balance bhejo'],
    ['nafa nuqsan report', 'profit and loss report'],
    ['profit and los', 'profit and loss'],
    ['kharcha report', 'expense ledger'],
    ['bank book', 'cash book'],
    ['cash bank book', 'cash bank book'],
    ['payable report', 'vendor ledger'],
    ['statment bhejo', 'customer ledger bhejo'],
    ['reciept voucher 54', 'receive voucher 54'],
    ['aaj ki sale bhejo', 'aaj ki sales book bhejo'],
    ['is mahine ki purchase', 'is mahine ki purchase book'],
  ])('%s → %s', (typed, fixed) => {
    expect(correctSpelling(typed).toLowerCase()).toBe(fixed);
  });

  it.each([
    'saleem ka ledger',
    'bilal ka ledger',
    'Sheglam brush',
    'summer collection stock',
    'Khuzema Tradevive',
    'income statement this year',
    'sale invoice 179',
  ])('leaves %s alone', typed => {
    expect(correctSpelling(typed)).toBe(typed);
  });

  it('never touches the words of a message to a customer (after the colon)', () => {
    expect(correctSpelling('send Ali: your statment is attached, ledgr inside')).toBe(
      'send Ali: your statment is attached, ledgr inside',
    );
  });

  it('does not turn a numbered sale into the sales book', () => {
    expect(correctSpelling('aaj sale 179 bhejo')).toBe('aaj sale 179 bhejo');
  });

  it('counts a swapped pair of letters as one mistake', () => {
    expect(damerauLevenshtein('legder', 'ledger')).toBe(1);
    expect(damerauLevenshtein('recievable', 'receivable')).toBe(1);
  });
});

describe('the rule-based reader, with misspellings', () => {
  it.each([
    ['purchse invoice 122', 'purchase_invoice'],
    ['sale invoce 179', 'sale_invoice'],
    ['recive voucher 54', 'receive_voucher'],
    ['payment vochar 12', 'payment_voucher'],
  ])('%s is the %s it means', (typed, documentType) => {
    expect(detectIntent(typed)).toMatchObject({ documentType });
  });

  it('a name typed after "ledger" is still the name', () => {
    expect(JSON.stringify(detectIntent('customer statment ahmed'))).toContain('ahmed');
  });

  it('"mera", "kitna", "only" are never taken for a name', () => {
    const text = JSON.stringify([detectIntent('mera hisab kitna hai'), detectIntent('January 2026 ledger only')]);
    expect(text).not.toMatch(/"(?:mera|kitna|only)/i);
  });
});
